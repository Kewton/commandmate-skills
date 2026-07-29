---
name: cmate-orchestrate-monitor
description: 並列で走らせた worker（tmux セッション上の coding CLI）を監督するための監視レシピ。commandmate capture --json の1フレームを状態トークン（NOT_RUNNING / GENERATING / PROMPT / RATE_LIMIT / IDLE）へ分類し、権限プロンプトの自動承認・rate limit からの即時復帰・リトライ枯渇後の再送を最小条件で行い、生成アンカーと実 commit / uncommitted 数に基づく STARTED ガード付きの完了判定を下す。誤報（未完了を完了と報告する・健全な worker へ入力を注入する・停滞を見逃す）を防ぐことが目的であり、判定ロジックは実 capture 由来の fixture で固定されている。worker の dispatch や PR 作成は行わない。
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
    ├── verify-completion.sh     # STARTED ガード付き完了判定
    ├── verify-scope.sh          # 偽陽性しないスコープ検証
    ├── quality-gate.sh          # exit code を実測する品質ゲート
    ├── monitor.sh               # オペレータ用監視ループ（操作エントリ）
    └── hooks-git.sh             # 完了フックの参照実装（worktree-id → 実 checkout）
```

`<skill-dir>` は install 先の Skill directory（`.agents/skills/cmate-orchestrate-monitor/`
および `.claude/skills/cmate-orchestrate-monitor/`）である。script は自分の位置から
兄弟 script を解決するので、どちらの root から実行してもよい。

## 3. 前提

| 必要なもの | 用途 | 無いときの動作 |
|---|---|---|
| `bash` 3.2 以上 | script の実行 | 成立しない。`process_execution` を要求する |
| `tmux` | 介入（キー送出） | 分類と完了判定は動くが、介入が届かない |
| `commandmate` | `capture <id> --json` | 監視の主シグナルが取れない。成立しない |
| `git` | 完了フック（`hooks-git.sh`） | 完了判定が発火しない（第8節） |

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
  --hooks <skill-dir>/scripts/hooks-git.sh \
  --interval 20 --idle-threshold 8 \
  <worktree-id> [<worktree-id> ...] 2>&1 | tee monitor.log
```

- **`--hooks` を必ず付ける。** 付けないと完了判定が構造的に発火しない（第8節）。
- **`--verbose` を必ず付ける。** 付けないと「何回ポーリングして各状態が何回出たか」が残らず、
  誤報 0 を後から主張できない（第9節）。
- `MONITOR_HOOKS_BASE` は commit を数える base ref。既定は `origin/develop` なので、
  **base branch が違うリポジトリでは必ず指定する**（解決できない場合は起動時に stderr へ警告が出る）。

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
  --commits 1 --uncommitted 0
#   -> COMPLETE | NOT_STARTED | WORKING
```

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

| 判定 | 意味 |
|---|---|
| `COMPLETE` | started 済み・idle 閾値到達・**実作業の証拠あり**（commit か uncommitted が 1 以上） |
| `NOT_STARTED` | 作業の痕跡が無い。タスクが送られていない疑い（第8節） |
| `WORKING` | 上記以外。監視を続ける |

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
| `PROMPT` | Enter | 分類のみ。サイレント＋カウント（`approvals`） |
| `RATE_LIMIT` | `a` | 分類のみ。待たずに即時 |
| `IDLE` | `--resend-message`（既定 `continue`） | **すべて満たすとき**: idle 閾値到達済み・現在のペインに terminal API error・`--max-resends` 未消化 |

再送分岐は入力を注入するので条件を最小に絞ってある。リトライ **中**（`GENERATING`）と
プロンプトには絶対に触らない。`--max-resends` を使い切ったらオペレータへエスカレーションする
（撃ち続けない）。

## 8. 完了判定と完了フック（必ず配線する）

`monitor.sh` の `count_commits` / `count_uncommitted` は **既定でスタブ（常に 0）** である。
ループ単体を動かすための既定値だが、`verify-completion.sh` は
`commits=0 かつ uncommitted=0` を **「タスクが送られていない」兆候**として扱う（STARTED ガード）。
したがって **フック無しの実行では COMPLETE 分岐に到達しない**。完走した worker まで
`NOT_STARTED` と記録される。

```bash
# 同梱の参照実装をそのまま使う
MONITOR_HOOKS_BASE=origin/main \
  <skill-dir>/scripts/monitor.sh --hooks <skill-dir>/scripts/hooks-git.sh <worktree-id> ...

# env でも指定できる（両方あればフラグが勝つ）
MONITOR_HOOKS=<skill-dir>/scripts/hooks-git.sh <skill-dir>/scripts/monitor.sh <worktree-id> ...
```

- 指定した file は **スタブ定義の後に source** される。定義した関数だけが上書きされ、
  片方だけ定義した file でももう片方はスタブのまま動く。
- 指定したのに file が無い場合は **exit 2 で即座に失敗**する。黙ってスタブに落ちると
  「全 worker が NOT_STARTED」という、一見もっともらしい嘘の観測になるためである。
- `hooks-git.sh` は worktree-id を `git worktree list --porcelain` から実 checkout へ解決し、
  `git log --oneline <base>..HEAD` と `git status --porcelain` で数える。
  解決規則と env は [references/monitor-contract.md](./references/monitor-contract.md) にある。

**arm する前に、フックが実値を返すことを対照実験で確かめること。**

```bash
. <skill-dir>/scripts/hooks-git.sh
count_commits <worktree-id>; count_uncommitted <worktree-id>   # 実測値と一致するか
count_commits no-such-worker                                   # 解決できない id は 0
```

## 9. 証拠の採取

監視が誤報 0 だったと主張するには、**判定を実際に下したこと**を示す必要がある。
`--verbose` は 1 ポーリング 1 行の固定フォーマットを追加する:

```
monitor[<wid>]: poll <N> -> <STATE> started=<0|1> streak=<n> commits=<n> uncommitted=<n> verdict=<VERDICT>
```

`<STATE>` は分類結果、`<VERDICT>` は完了判定、間の key=value は **その判定に実際に渡した入力**である。
だから「なぜ COMPLETE にならないのか」を verdict だけでなく根拠つきで読める。

| 知りたいこと | ログからの取り出し方 |
|---|---|
| 総ポーリング数（worker 別） | `grep -cE '^monitor\[<wid>\]: poll ' monitor.log` |
| 状態分類の分布 | `grep -oE 'poll [0-9]+ -> [A-Z_]+' monitor.log \| awk '{print $4}' \| sort \| uniq -c` |
| 介入の全件 | `grep -E "sending 'a'\|resending\|resend budget spent" monitor.log`（プロンプト承認はサイレント。総数は COMPLETE 行の `approvals=` に出る） |
| 完了判定の根拠 | COMPLETE した poll 行の `started= / streak= / commits= / uncommitted=` |
| capture 失敗 | `grep -c 'capture failed' monitor.log`（poll 行は出ないので別に数える） |

`--verbose` は opt-in である。付けない限り既定の stdout は 1 バイトも変わらない
（介入・capture 失敗・終局判定・起動/停止のみ）。

## 10. やらないこと

- worker の作成・dispatch・作業指示の送信（`cmate-orchestrate` の担当）。
- PR 作成・merge・Issue の close。
- 完了したかどうかの **推測**。証拠（commit / uncommitted）が無ければ `COMPLETE` にしない。
- 未計測の Agent・CLI version を「対応」と宣言すること
  （[references/agent-compatibility.md](./references/agent-compatibility.md)）。

### この監視が検知できないこと

- **送信側の欠陥**。worker に届いた指示文が壊れていても（例: shell 展開で file 名が落ちた）、
  worker は健全に生成し、監視は正しく COMPLETE を出す。指示の正しさは dispatch 側の責任である。
- **成果物の正しさ**。COMPLETE は「作業の痕跡があり、生成が止まった」であって、
  受入条件の充足ではない。品質ゲートは `quality-gate.sh` で exit code を実測し、
  スコープ充足は `verify-scope.sh` で数える（どちらも監視ループとは独立に使う）。

## 11. 実運用での検証状況

判定コアは 2026-07-28〜29 の 2 運用（単独 1 Issue / 3 並列）で
**延べ 371 ポーリング・誤報 0 件・介入 21 件（すべてプロンプト自動承認）**の実績がある。
運用条件・状態分布・介入内訳・完了判定の根拠・測定の限界は
[references/evidence.md](./references/evidence.md) に記録してある。

## 12. 参照

- [references/monitor-contract.md](./references/monitor-contract.md) — 入出力・フラグ・env・終了コード
- [references/recipe-rationale.md](./references/recipe-rationale.md) — 各ルールの出所と回帰一覧
- [references/evidence.md](./references/evidence.md) — 実運用での検証状況と限界
- [references/agent-compatibility.md](./references/agent-compatibility.md) — Agent 差異と互換宣言の方針
