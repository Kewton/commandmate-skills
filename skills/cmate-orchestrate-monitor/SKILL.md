---
name: cmate-orchestrate-monitor
description: 並列で走らせた worker（tmux セッション上の coding CLI）を監督するための監視レシピ。完了判定の一次ソースは CommandMate が記録した実行契約のタスク状態（succeeded / failed / not_started …）であり、capture の正規表現解析は契約なし委任・タスク台帳を持たない CommandMate 向けのフォールバックである。commandmate capture --json の1フレームを状態トークン（NOT_RUNNING / GENERATING / PROMPT / RATE_LIMIT / IDLE）へ分類し、権限プロンプトの自動承認・rate limit からの即時復帰・リトライ枯渇後の再送を最小条件で行い、フォールバック時は生成アンカーと実 commit / uncommitted 数に基づく STARTED ガード付きの完了判定を下す。タスク状態が読めない環境では明示メッセージつきでフォールバックモードへ入る。誤報（未完了を完了と報告する・健全な worker へ入力を注入する・停滞を見逃す）を防ぐことが目的であり、判定ロジックは実 capture 由来の fixture で固定されている。worker の dispatch や PR 作成は行わない。
---

# cmate-orchestrate-monitor（worker 監視の判定コア）

並列 worker を監督するときの **監視レシピ**を、bash 3.2 互換の実行可能スクリプトとして
資産化したものである。判定（生成中判定・prompt 分類・介入条件・完了検証）は
プロンプトから再発明するのではなく、この中核を呼び出して使う。

対象は「`commandmate` が管理する worktree セッション上で coding CLI が走っている」状況である。
worker をどう作るか・どう dispatch するか・成果物をどう merge するかは扱わない
（それらは `cmate-orchestrate` の担当であり、本 Skill はその dispatch 実装とは独立に使える）。

> **なぜ script なのか**: 監視ノウハウは実運用の失敗から学ばれるが、プロンプトの中にあると
> 再現も移転もできず、同種の誤報が繰り返し再発する。判定は script に固定し、
> 実 `capture --json` から採った fixture で回帰を封じてある。
> 各ルールがどの失敗から来ているかは [references/recipe-rationale.md](./references/recipe-rationale.md) にある。

---

## 1. この Skill が答える問い

1. いま worker は **生成中か・入力待ちか・止まっているか**。
2. **介入してよいか**。入力の注入は健全な worker を壊す（生成中・backoff 中への注入は queue され、
   契約外の作業を始めさせる）。
3. **完了したと言ってよいか**。その根拠は何か。
4. 監視が下した判定を、後から **機械的に検証できるか**。

## 2. 構成

```
<skill-dir>/
├── SKILL.md
├── references/
│   ├── monitor-contract.md      # 入出力・フラグ・env・終了コードの契約
│   ├── recipe-rationale.md      # 各ルールがどの実運用失敗から来ているか
│   ├── evidence.md              # 実運用での検証状況と限界
│   └── agent-compatibility.md   # Agent 差異と互換宣言の方針
└── scripts/
    ├── monitor-lib.sh           # 共有ヘルパー（JSON scalar 抽出・ANSI 正規化・アンカー検出）
    ├── classify-state.sh        # capture --json 1 ポーリング → 状態トークン
    ├── verify-completion.sh     # 完了判定（タスク状態が一次・capture がフォールバック）
    ├── verify-scope.sh          # 偽陽性しないスコープ検証
    ├── quality-gate.sh          # exit code を実測する品質ゲート
    ├── monitor.sh               # オペレータ用監視ループ（操作エントリ）
    ├── hooks-task.sh            # 一次ソースのフック（worktree-id → タスク台帳の状態）
    └── hooks-git.sh             # フォールバック用フックの参照実装（worktree-id → 実 checkout）
```

`<skill-dir>` は install 先の Skill directory（`.agents/skills/cmate-orchestrate-monitor/`
および `.claude/skills/cmate-orchestrate-monitor/`）である。script は自分の位置から
兄弟 script を解決するので、どちらの root から実行してもよい。

## 3. 前提

| 必要なもの | 用途 | 無いときの動作 |
|---|---|---|
| `bash` 3.2 以上 | script の実行 | 成立しない。`process_execution` を要求する |
| `tmux` | 介入（キー送出・宛先セッションの存在検証） | 分類と完了判定は動くが、介入が届かない（**届かなかったことは stderr に出る**） |
| `commandmate` | `capture <id> --json` | 監視の主シグナルが取れない。成立しない |
| `commandmate task`（task 台帳） | 完了判定の一次ソース（`hooks-task.sh`） | 明示メッセージつきでフォールバックモード（第5節）。**公開版にはまだ含まれない** |
| `git` | フォールバックのフック（`hooks-git.sh`） | フォールバック時に完了判定が発火しない（第8節） |

`monitor.sh` は既定で `npx commandmate@latest` を launcher に使う。`CM` env で上書きできる
（install 済みの `commandmate` を使うなら `CM=commandmate`）。既定のままだと npm registry への
network access が発生する。

**この Skill は worker へ入力を送る。** 送るのは Enter（プロンプト承認）・`a`（rate limit からの再開）・
`--resend-message` の文字列（既定 `continue`）の3種類だけで、いずれも第7節の条件を満たしたときに限る。
作業指示は送らない。

## 4. 使い方

### 4.1 運用の標準形（証拠が残る形）

```bash
CM=commandmate \
MONITOR_HOOKS_BASE=origin/main \
<skill-dir>/scripts/monitor.sh \
  --verbose \
  --hooks <skill-dir>/scripts/hooks-task.sh \
  --hooks <skill-dir>/scripts/hooks-git.sh \
  --interval 20 --idle-threshold 8 \
  <worktree-id>[@<instance-id>] [<worktree-id>[@<instance-id>] ...] 2>&1 | tee monitor.log
```

- **`--hooks` を必ず付ける。** 付けないと完了判定が構造的に発火しない（第8節）。
  `--hooks` は**繰り返し指定でき、左から順に source される**。`hooks-task.sh` が一次ソース
  （タスク状態）、`hooks-git.sh` がフォールバックの作業量カウンタを供給する。
- **`--verbose` を必ず付ける。** 付けないと「何回ポーリングして各状態が何回出たか」が残らず、
  誤報 0 を後から主張できない（第9節）。
- `MONITOR_HOOKS_BASE` は commit を数える base ref。既定は `origin/develop` なので、
  **base branch が違うリポジトリでは必ず指定する**（解決できない場合は起動時に stderr へ警告が出る）。
- **`2>&1` を落とさない。** 届かなかった介入は stderr に出る（第7.1節）。落とすと 0.2.0 以前と
  同じ「空振りが見えない」状態に戻る。
- 既定の worker は tool の primary instance である。`<worktree-id>@<instance-id>`
  （例 `w1@codex-2`）で指定した instance は capture 側と送信先の両方に効く。

複数の worktree-id を渡すと 1 プロセスで同時に監督する。全 worker が COMPLETE になると
`monitor: all N worker(s) complete` を出して exit 0 で終わる。

### 4.2 1回だけ様子を見る

```bash
<skill-dir>/scripts/monitor.sh --max-polls 1 --verbose <worktree-id>
```

`--max-polls N` は N ポーリングで（未完了でも）exit 0 で抜ける停止条件である。
判定ロジックには一切関与しない。

### 4.3 判定コアだけを使う（Agent が自分でループを回す場合）

```bash
commandmate capture <worktree-id> --json > poll.json
<skill-dir>/scripts/classify-state.sh --json poll.json
#   -> NOT_RUNNING | RATE_LIMIT | GENERATING | PROMPT | IDLE

<skill-dir>/scripts/verify-completion.sh \
  --started 1 --state IDLE --idle-streak 8 --idle-threshold 8 \
  --commits 1 --uncommitted 0 --task-status succeeded
#   -> COMPLETE | VERIFY_FAILED | NOT_STARTED | WORKING
```

`--task-status` には `commandmate task list <worktree-id> --limit 1` の最新行の状態を渡す
（省略・空文字なら従来どおり capture 由来のヒューリスティクスだけで判定する）。

Agent が自分でループを回す場合も、**分類と完了判定はこの2つに委ねること**。
capture の JSON を自前で grep して状態を判断しない（第6節の理由）。

フラグ・env・終了コードの完全な一覧は
[references/monitor-contract.md](./references/monitor-contract.md) にある。

## 5. 状態と判定

| 状態 | 意味 | ループの扱い |
|---|---|---|
| `NOT_RUNNING` | セッションが無い | idle streak を進める（介入先が無い） |
| `GENERATING` | ターン実行中（CLI 自身の backoff 中を含む） | started を latch、streak を 0 に戻す |
| `PROMPT` | 承認・選択待ち | Enter を送る（サイレント・カウント） |
| `RATE_LIMIT` | usage limit / credits バナー | `a` を送る（待たない） |
| `IDLE` | 上記のいずれでもない | streak を進める |

### 完了判定の一次ソースはタスク状態である

完了判定は次の順に決まる。**順序そのものが仕様である**（CommandMate 側の同名 Skill と同一）。

```
1. ペインが生きているか   GENERATING / PROMPT / PROMPT_LIVE / RATE_LIMIT なら WORKING（無条件）
2. 裁定済みのタスク状態   succeeded / failed / cancelled / not_started なら、それが判定
3. capture 由来の推定     STARTED ガード + idle streak + 実作業カウンタ（フォールバック）
```

1 が 2 より先なのは、**古い裁定で監視を打ち切らせない**ためである。ペインが生成中なのに最新タスクが
`succeeded` なら、その状態は前回の send のものであってこのターンのものではない。

2 で判定するのは**終局状態だけ**である。`pending` / `running` / `waiting_input` / `verifying` は
「状態機械がまだ裁定していない」という意味なので 3 へ落ちる。これは意図的で、
**「CLI は running と記録したが Enter が composer に落ちていない」** を捕まえられるのは
3 の STARTED ガードだけだからである（`running` を短絡的に WORKING にするとこのガードが盲目になる）。

| 判定 | 意味 |
|---|---|
| `COMPLETE` | タスクが `succeeded`（サーバ側で検証ゲート合格済み）、またはフォールバック時に started 済み・idle 閾値到達・**実作業の証拠あり**（commit か uncommitted が 1 以上） |
| `VERIFY_FAILED` | タスクが `failed` / `cancelled`。**終局だがマージ不可**。「worker が止まった」と「成果が良い」を分離するための判定である |
| `NOT_STARTED` | タスクが `not_started`、または作業の痕跡が無い。タスクが送られていない疑い（第8節） |
| `WORKING` | 上記以外。監視を続ける |

> **契約付き委任時の最終裁定は `commandmate wait --verify` の exit code である。**
> `monitor` の `COMPLETE` 判定を **マージ可否の裁定に使わない**。
> `wait --verify` は完了後に全検証ゲートを回し、**ゲート不合格で exit 20 / 検証対象なしで exit 21**
> を返す。monitor が読むタスク状態はその裁定の**写し**であり、監視を止めてよいかを決めるためのものである。
> 監視ログの `COMPLETE` は「裁定が succeeded だった」以上のことを意味しない。

### タスク状態が読めないとき（バージョンゲート）

`hooks-task.sh` を配線したのに台帳を引けなかった場合、monitor は worker ごとに 1 度だけ
次を出してからフォールバックモードで走る。**黙って劣化しない。**

```
monitor[<wid>]: task state unavailable (CommandMate without 'commandmate task', server down, or unknown worktree) — FALLBACK MODE: completion is inferred from capture, not adjudicated. Diagnose with: commandmate task list <wid> --limit 1
```

**実測（2026-07-31）: `commandmate task` は未リリースである。** npm 公開版の最新 0.16.0 の tarball に
`dist/cli/commands/task.js` は無く、tag `v0.15.0` / `v0.16.0` にも `src/cli/commands/task.ts` は無い
（develop のみ）。したがって**今日の公開版 CommandMate ではこの経路が常にフォールバックへ入る。**
一次ソースが効くのは task 台帳（#1566）を含む CommandMate だけである。
`hooks-task.sh` を配線しなければこの行は出ない（契約なし委任として従来どおり動く）。

## 6. 判定順（順序自体がガード）

```
NOT_RUNNING → is_retrying(→GENERATING) → PROMPT → GENERATING → RATE_LIMIT → IDLE
```

各分岐は **入力注入か抑止のどちらか**を引き起こす。早すぎる発火は健全なセッションを壊す。
順序に依存する要点だけを挙げる（根拠と実害は
[references/recipe-rationale.md](./references/recipe-rationale.md)）:

1. **アンカーは ANSI 除去後・`realtimeSnippet` 限定で照合する**。生 JSON への grep は実機で発火せず、
   `content`（差分）を見るとスクロールバックの作業指示文に誤マッチする。
2. **CLI 自身のリトライ backoff は GENERATING**（生存している）。`RATE_LIMIT` より前に評価する。
   ただし idle フッタ（`? for shortcuts`）が出ていれば veto する（枯渇後の残骸を生存と読まないため）。
3. **`PROMPT` は `GENERATING` より先**。権限プロンプト表示中もフッタは `esc to interrupt` のままで、
   逆順だとプロンプトが永久に承認されない。
4. **`RATE_LIMIT` は最後**。本物の usage limit はターンを停止させるので、生成中フレームに出ている
   バナー風文字列は worker が読み書きしているコード・散文である。
5. **`isGenerating` フィールドに依存しない**。生成中でも false になりうる。

## 7. 介入（誤報の実害が大きい順）

| 状態 | 介入 | 条件 |
|---|---|---|
| `PROMPT` | Enter | 分類のみ。サイレント＋カウント（`approvals`。**配信成功時のみ**加算） |
| `RATE_LIMIT` | `a` | 分類のみ。待たずに即時 |
| `IDLE` | `--resend-message`（既定 `continue`） | **すべて満たすとき**: idle 閾値到達済み・現在のペインに terminal API error・`--max-resends` 未消化 |

再送分岐は入力を注入するので条件を最小に絞ってある。リトライ **中**（`GENERATING`）と
プロンプトには絶対に触らない。`--max-resends` を使い切ったらオペレータへエスカレーションする
（撃ち続けない）。

### 7.1 送信先の決定と配信の検証（Issue #1602）

**送信先は prefix の連結ではなく、そのポーリングの capture ペイロードから導出する。**
`cliToolId` はサーバがその worktree / instance に対して解決した CLI tool そのものなので、
**分類したペインと入力するペインが同一であることが構造的に保証される**。

```
mcbd-<cliToolId>-<worktree-id>[-<instance suffix>]
```

- 0.2.0 までの既定は `cm-<worktree-id>` で、**この名前のセッションは 1 つも存在しない**。
  3 箇所すべてが `2>/dev/null || true` で終わり、rate limit 分岐はログを送信の**前**に出し、
  承認分岐は無条件にカウンタを進めていたため、**全介入が no-op のまま「成功」と記録**されていた。
- `<worktree-id>@<instance-id>`（例 `w1@codex-2`）で instance を指定できる。指定した instance は
  **capture 側（`--agent` / `--instance`）と送信先の両方**を切り替える。状態と log 行の key も
  `<id>@<instance>` になるので、同じ worktree の 2 ペインを混ぜずに監督できる。
- `--session-prefix` は **escape hatch**として残してあるが、置換するのは導出された
  `mcbd-<cliToolId>` の**頭だけ**で、instance suffix は維持する。素の連結に戻すと
  `<id>@<instance>` 指定が primary へ黙って向き直り、同型の誤配送になる。
- 送信は **`tmux has-session` で存在を検証してから**行い、`=<name>:`（完全一致指定）を使う。
  素の `-t <name>` は完全一致が無いとき**前方一致へフォールバック**するため、
  `mcbd-claude-w1`（primary 停止中）への送信が `mcbd-claude-w1-2` へ漏れる。
- **失敗は握り潰さず stderr へ報告する**（`… NOT delivered — …`）。ログは送信の**結果**を書き、
  **承認カウンタと再送予算は配信できたときだけ動く**（空振りで予算を消費して
  「budget spent」へエスカレーションしない）。stdout は介入と終局判定の stream なので、
  **届かなかった介入は介入として出力しない**。運用の標準形が `2>&1 | tee` なのはこのためである。

## 8. 完了判定とフック（必ず配線する）

`monitor.sh` は 3 つのフックを呼ぶ。いずれも **既定はスタブ**で、`read_task_status` は空文字、
`count_commits` / `count_uncommitted` は常に 0 を返す。ループ単体を動かすための既定値だが、
`verify-completion.sh` は `commits=0 かつ uncommitted=0` を **「タスクが送られていない」兆候**
として扱う（STARTED ガード）。したがって **フック無しの実行では COMPLETE 分岐に到達しない**。
完走した worker まで `NOT_STARTED` と記録される。

| フック | 供給するもの | 参照実装 |
|---|---|---|
| `read_task_status` | 一次ソース。worktree の最新実行契約の状態 | `hooks-task.sh` |
| `count_commits` / `count_uncommitted` | フォールバックの作業量カウンタ | `hooks-git.sh` |

```bash
# 契約付き委任（一次ソース + フォールバックの両方を配線する標準形）
MONITOR_HOOKS_BASE=origin/main \
  <skill-dir>/scripts/monitor.sh \
    --hooks <skill-dir>/scripts/hooks-task.sh \
    --hooks <skill-dir>/scripts/hooks-git.sh <worktree-id> ...

# 契約なし委任（capture ヒューリスティクスだけで走る。従来と同じ挙動）
MONITOR_HOOKS_BASE=origin/main \
  <skill-dir>/scripts/monitor.sh --hooks <skill-dir>/scripts/hooks-git.sh <worktree-id> ...

# env でも指定できる（`--hooks` を 1 つでも与えると env は捨てられる）
MONITOR_HOOKS=<skill-dir>/scripts/hooks-git.sh <skill-dir>/scripts/monitor.sh <worktree-id> ...
```

- `--hooks` は **繰り返し指定でき、左から順に source** される。指定した file は
  **スタブ定義の後に source** されるので、定義した関数だけが上書きされ、
  一部だけ定義した file でも残りはスタブのまま動く。
- 指定したのに file が無い場合は **exit 2 で即座に失敗**する。黙ってスタブに落ちると
  「全 worker が NOT_STARTED」という、一見もっともらしい嘘の観測になるためである。
- `hooks-task.sh` は `commandmate task list <worktree-id> --limit 1` の**最新行**を読む。
  **前提: 監視中の契約が最新タスクであること**（契約作成 → `send --contract` → 監視、の標準手順なら成立する）。
  前回の委任のタスクが最新のまま監視を始めると、その古い裁定を読む。
  台帳を引けなかった場合は第5節のバージョンゲート行を出してフォールバックする。
- `hooks-git.sh` は worktree-id を `git worktree list --porcelain` から実 checkout へ解決し、
  `git log --oneline <base>..HEAD` と `git status --porcelain` で数える。
  解決規則と env は [references/monitor-contract.md](./references/monitor-contract.md) にある。
- **`git` が答えられなかった場合と、worker が本当に何も書いていない場合は別物である**
  （CommandMate #1614）。上記 3 つの `git` 呼び出しはいずれも終了コードを確認する。
  失敗時のカウンタ値は 0 のまま（`commits=0 && uncommitted=0` は完了判定を安全側＝
  COMPLETE を出さない方向にしか倒さない）だが、**黙った 0 ではなく**、原因ごとに
  **worker あたり 1 行**を stderr へ出す（毎ポーリングは出さない。base ref 警告と同じ粒度）。
  worktree path の解決失敗は**両カウンタを同時に 0 へ沈める**ので、id が解決できないケースも
  同じ粒度で報告する。行の一覧は
  [references/monitor-contract.md](./references/monitor-contract.md) にある。
  数え方は `printf '%s' "$out" | grep -c . || true` である: 終了コードを見るために出力を
  変数へ受けると `$()` が末尾改行を落とすため `wc -l` は 1 件を 0 と数え（bash 3.2.57 実測）、
  `|| echo 0` は 0 件で `"0\n0"` になる。

### なぜ CLI で、API ではないのか（実測 2026-07-31）

`commandmate task list <worktree-id> [--limit n] [--json]` と
`GET /api/worktrees/<id>/tasks` は同じ行を返す（CLI はこの route の薄いクライアント）。
shell フックからは **CLI が有利**である: base URL（`CM_PORT`）と認証トークン
（`--token` / `CM_AUTH_TOKEN`）の解決を CLI が既に持っており、curl では両方を再実装したうえに
トークンをプロセスリストへ晒すことになる。
`task show <task-id>` ではなく `task list` を使うのは、監視ループが知っているのが worktree-id
だけだからである（task id は `send --contract` が出力するが、worker ごとに配線し直す必要が出る）。

**arm する前に、フックが実値を返すことを対照実験で確かめること。**

```bash
. <skill-dir>/scripts/hooks-git.sh
count_commits <worktree-id>; count_uncommitted <worktree-id>   # 実測値と一致するか
count_commits no-such-worker                                   # 解決できない id は 0

CM=commandmate . <skill-dir>/scripts/hooks-task.sh
read_task_status <worktree-id>   # 契約中の状態 / 契約なしなら空 / 引けないなら unavailable
```

## 9. 証拠の採取

監視が誤報 0 だったと主張するには、**判定を実際に下したこと**を示す必要がある。
`--verbose` は 1 ポーリング 1 行の固定フォーマットを追加する:

```
monitor[<wid>]: poll <N> -> <STATE> started=<0|1> streak=<n> commits=<n> uncommitted=<n> verdict=<VERDICT> [task=<status>]
```

`<STATE>` は分類結果、`<VERDICT>` は完了判定、間の key=value は **その判定に実際に渡した入力**である。
だから「なぜ COMPLETE にならないのか」を verdict だけでなく根拠つきで読める。

`task=` は **台帳が答えたときだけ末尾に付く**。契約なし委任・フォールバックモードの poll 行は
1 バイトも変わらない（`task=-` のような、証拠のふりをした空値を出さないため）。

| 知りたいこと | ログからの取り出し方 |
|---|---|
| 総ポーリング数（worker 別） | `grep -cE '^monitor\[<wid>\]: poll ' monitor.log` |
| 状態分類の分布 | `grep -oE 'poll [0-9]+ -> [A-Z_]+' monitor.log \| awk '{print $4}' \| sort \| uniq -c` |
| タスク状態の分布 | `grep -oE 'task=[a-z_]+' monitor.log \| sort \| uniq -c` |
| 判定が一次ソース由来かフォールバック由来か | 終局判定の poll 行に `task=` があるか／`FALLBACK MODE` 行が出ているか |
| 介入の全件（届いたもの） | `grep -E "sent 'a' to\|resent to\|resend budget spent" monitor.log`（プロンプト承認はサイレント。総数は COMPLETE 行の `approvals=` に出る） |
| 届かなかった介入 | `grep 'NOT delivered' monitor.log`（stderr。`2>&1` で取り込んでいること） |
| 送信先として解決されたセッション | `grep 'intervention target = ' monitor.log`（worker ごとに 1 行） |
| 完了判定の根拠 | COMPLETE した poll 行の `started= / streak= / commits= / uncommitted= / task=` |
| capture 失敗 | `grep -c 'capture failed' monitor.log`（poll 行は出ないので別に数える） |
| helper 失敗（CommandMate #1614） | `grep -cE 'classify-state failed\|verify-completion failed' monitor.log`。いずれもそのポーリングを捨てる（poll 行は出ない）。**0 でなければ判定を下せなかったポーリングがある** |
| カウンタが信用できないポーリング | `grep 'monitor hooks: \[' monitor.log`（worker あたり 1 行。出ていれば `commits=` / `uncommitted=` の 0 は「測れなかった」であって「作業ゼロ」ではない） |

`--verbose` は opt-in である。付けない限り既定の stdout は 1 バイトも変わらない
（介入・capture 失敗・helper 失敗・終局判定・起動/停止のみ）。

## 10. やらないこと

- worker の作成・dispatch・作業指示の送信（`cmate-orchestrate` の担当）。
- PR 作成・merge・Issue の close。
- 完了したかどうかの **推測**。証拠（commit / uncommitted）が無ければ `COMPLETE` にしない。
- 未計測の Agent・CLI version を「対応」と宣言すること
  （[references/agent-compatibility.md](./references/agent-compatibility.md)）。

### この監視が検知できないこと

- **送信側の欠陥**。worker に届いた指示文が壊れていても（例: shell 展開で file 名が落ちた）、
  worker は健全に生成し、監視は正しく COMPLETE を出す。指示の正しさは dispatch 側の責任である。
- **成果物の正しさ**。フォールバック時の COMPLETE は「作業の痕跡があり、生成が止まった」であって、
  受入条件の充足ではない。品質ゲートは `quality-gate.sh` で exit code を実測し、
  スコープ充足は `verify-scope.sh` で数える（どちらも監視ループとは独立に使う）。
  契約付き委任なら **`commandmate wait --verify` の exit code が最終裁定**である（第5節）。
- **マージ可否の裁定**。`COMPLETE` は監視を止めてよいという判定であって、マージ許可ではない。

## 11. 実運用での検証状況

判定コアは 2026-07-28〜29 の 2 運用（単独 1 Issue / 3 並列）で
**延べ 371 ポーリング・誤報 0 件・プロンプト検出 21 件**の実績がある。
**この実績はすべて capture ヒューリスティクス（現在のフォールバック経路）によるものである。**
タスク状態を一次ソースとする経路（第5節）の実運用実績は **まだ無い**。

**0.2.0 までの「介入 21 件」は実際には 1 件も届いていなかった**（Issue #1602）。
既定の送信先 `cm-<worktree-id>` は存在しないセッションで、失敗はすべて握り潰されていた。
0.3.0 で宛先を導出に変え、配信を検証するようにしたが（第7.1節）、
**修正後の介入が実 worker へ届いた実績は未計測である**
（[references/evidence.md](./references/evidence.md) 1c）。
運用条件・状態分布・介入内訳・完了判定の根拠・測定の限界は
[references/evidence.md](./references/evidence.md) に記録してある。

## 12. 参照

- [references/monitor-contract.md](./references/monitor-contract.md) — 入出力・フラグ・env・終了コード
- [references/recipe-rationale.md](./references/recipe-rationale.md) — 各ルールの出所と回帰一覧
- [references/evidence.md](./references/evidence.md) — 実運用での検証状況と限界
- [references/agent-compatibility.md](./references/agent-compatibility.md) — Agent 差異と互換宣言の方針
