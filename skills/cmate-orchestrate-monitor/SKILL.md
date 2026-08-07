---
name: cmate-orchestrate-monitor
description: 並列 worker（tmux 上の coding CLI）を capture --json のポーリングで監督する。プロンプト待ち・rate limit・リトライ枯渇死など commandmate wait に見えない停滞を検知して回収し、介入と判定の全件をログに残す。契約付き dispatch の一次監督は cmate-orchestrate 側。
---

# cmate-orchestrate-monitor（worker 監視の判定コア）

> **ランチャー表記** — 本文中の `commandmate …` は**読み替え可能**である。グローバル導入をしない
> npx 運用では `npx commandmate@latest …` と読む。同梱スクリプトは環境変数 `CM` で解決し、その
> 既定は `npx commandmate@latest`（`monitor.sh:108`）— install 済みなら `CM=commandmate` を渡す。
> 監視は capture / wait を高頻度で叩くため npx の起動コスト（1 回あたり 0.5〜0.9 秒）が効く。
> `~/.local/bin/commandmate` に `exec npx --yes commandmate@latest "$@"` の薄いラッパを置き
> `CM=commandmate` で回す導入形態を推奨する（README の「CommandMate CLI の導入形態」）。

`commandmate` が管理する worktree セッション上で走る coding CLI を監督するための**監視レシピ**を、
bash 3.2 互換の実行可能スクリプトとして資産化したものである。生成中判定・prompt 分類・介入条件・
完了検証は、プロンプトから再発明するのではなくこの中核を呼び出して使う。

この文書が述べるのは **いつ使うか / 呼び方 / 状態と判定 / フックの配線 / やらないこと** の 5 点
だけである。**フラグ・env・出力行・終了コードの正本は
[references/monitor-contract.md](./references/monitor-contract.md)**、**各ルールがどの実運用失敗から
来ているかは [references/recipe-rationale.md](./references/recipe-rationale.md)**、**何をどこまで
実測したかは [references/evidence.md](./references/evidence.md)** で、この文書と食い違ったら
references を採る。判定を script に固定し、実 `capture --json` から採った fixture で回帰を封じて
あるのは、プロンプトの中にある監視ノウハウが再現も移転もできないからである。

---

## 1. いつ使うか

worker が **生成中か・入力待ちか・止まっているか**を判定し、**介入してよいか**を決め、
**完了したと言ってよいか**とその根拠を、後から機械的に検証できる形で残したいとき。

### cmate-orchestrate との使い分け（決定規則）

同じカタログの [cmate-orchestrate](../cmate-orchestrate/) も並列 worker を監督する。
**機構が別物なので、どちらか一方へ統合しない。** 使い分けは次で決まる。

1. **契約付きで dispatch したなら、一次は cmate-orchestrate の dispatch runner** である。
   ブロッキングな `commandmate wait --on-prompt agent --verify` の **exit code 分岐**
   （0 pass / 10 prompt / 20 ゲート不合格 / 21 作業証跡ゼロ / 99 判定に到達せず / 124 timeout）が
   裁定で、nudge も `send` / `respond` でサーバを経由する。**マージ可否の裁定もそちらである。**
2. **monitor はそのサイドカー**である。機構は `capture --json` の**ポーリング分類**と
   **tmux 直接介入**なので、dispatch runner が wait でブロックしていても独立に観測・介入できる。
3. monitor でなければ回収できないのは次の 5 つで、これが両方を残す理由である:
   rate limit / credits バナーからの `a` 復帰、リトライ枯渇死（`attempt 10/10` 後）の再送、
   製品の prompt 検出（`isPromptWaiting`）に載らないプロンプト（`❯ 1. Submit answers` 形式の
   AskUserQuestion 等）、wait がブロックしている間の可観測性、**契約なし委任・他所から投げた
   worker** の監督。
4. 両方を同時に回してよい。ただし **契約付き worker には `--no-auto-approve` を付ける**。
   プロンプトに答えてよいかを決めるのはサーバの autoYes ポリシーであって監視ループではない（第3節）。

`COMPLETE` は**監視を止めてよい**という判定であって、マージ可否の裁定ではない。

## 2. 呼び方

### 2.1 標準形（証拠が残る形）

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

次の 4 つは省略しない。**省略すると監視が黙って無意味になる**組み合わせである。

| 指定 | 省略すると |
|---|---|
| `--hooks`（2 本） | 完了判定が構造的に発火せず、完走した worker まで `NOT_STARTED` になる（第4節） |
| `--verbose` | 何回ポーリングして各状態が何回出たかが残らず、誤報 0 を後から主張できない |
| `2>&1` | **届かなかった介入**（stderr）が落ち、ログには「送った」だけが残る |
| `MONITOR_HOOKS_BASE` | 既定は `origin/develop`。base が違うリポジトリでは commit を数えられない |

- `--verbose` が足すのは 1 ポーリング 1 行のこの形だけで、既定の stdout は 1 バイトも変わらない:
  `monitor[<wid>]: poll <N> -> <STATE> started=… streak=… commits=… uncommitted=… verdict=… [task=…]`。
  key=value は **その判定に実際に渡した入力**である。`task=` は台帳が答えたときだけ付く
  （証拠のふりをした空値を出さないため）。ログからの取り出し方は
  [monitor-contract.md](./references/monitor-contract.md) 第3節。
- `CM` の既定は `npx commandmate@latest` で、npm registry への network access が出る。
- `<worktree-id>@<instance-id>`（例 `w1@codex-2`）は capture 側と送信先の両方に効く。
- 契約付き dispatch を監督するなら `--no-auto-approve` を足す（第1節・第3節）。
- 全 worker が COMPLETE になると `monitor: all N worker(s) complete` を出して exit 0。
  `--max-polls N` は N ポーリングで抜ける停止条件で、判定ロジックには一切関与しない。

### 2.5 監視が生きているかを外から見る（CommandMate #1728）

**「静かなのは健全だから」と「静かなのは監視が死んだから」を区別できること。** 2026-08-06 に、
起動行 1 行だけを出した監視が約 25 分後に exit 144 で沈黙終了し、その間ワーカー 2 本は正常稼働の
まま**無監視**だった。判定ロジックは一切変えずに、次の 3 つを足してある。

| 何が出るか | どこへ | いつ |
|---|---|---|
| `monitor: alive (poll=<n>, complete=<d>/<total>)` | stdout | `--heartbeat N` ポーリングごと（既定 10、`0` で無効） |
| `monitor: ERROR caught SIG<name> (signal <n>) on poll round <r> — monitoring stops here` | stderr | HUP / INT / QUIT / PIPE / TERM 受信時。exit は `128+n` |
| `monitor: WARN caught SIGURG on poll round <r> — ignored, monitoring continues` | stderr | SIGURG 受信時（**致死化しない**。既定動作が無視なので、届いたことだけを見えるようにする） |
| `monitor: ERROR exiting on poll round <r> with <d>/<n> worker(s) complete (rc=<rc>) — the rest are now UNMONITORED` | stderr | 正常終了（全 COMPLETE / `--max-polls` 到達）**以外**の全ての終了 |

最後の 1 行は EXIT trap にぶら下がっているので、**個別に trap していない死に方でも出る**のが要点
である。引数検証で落ちる経路（不正な id・`--hooks` のファイル欠落）は trap 設置より前なので
従来どおり 1 行のまま。144 = 128 + 16 で macOS の signal 16 は SIGURG だが、SIGURG は既定で無視
されるため `monitor.sh` 自身が受けて死んだとは限らない（`cmd | grep …` の `$?` は **grep の終了
コード**である点にも注意）。再現条件は未特定のまま、次に起きたときに原因がログへ残る形にしてある。

既定の stdout（介入・終局判定）は heartbeat を除いて byte 単位で従来どおりである。

### 2.2 判定コアだけを使う（Agent が自分でループを回す場合）

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
（省略・空文字なら capture 由来のヒューリスティクスだけで判定する）。

**分類と完了判定は必ずこの 2 つに委ねること。** capture の JSON を自前で grep して状態を
判断しない（アンカーは ANSI 除去後・現ペイン限定で照合する。recipe-rationale 2・3）。

### 2.3 同梱スクリプト

| script | 役割 |
|---|---|
| `monitor.sh` | オペレータ用監視ループ（操作エントリ） |
| `classify-state.sh` | capture 1 フレーム → 状態トークン |
| `verify-completion.sh` | 完了判定（タスク状態が一次・capture がフォールバック） |
| `hooks-task.sh` / `hooks-git.sh` | 完了フックの参照実装（第4節） |
| `verify-scope.sh` / `quality-gate.sh` | 偽陽性しないスコープ検証 / exit code を実測する品質ゲート。監視ループとは独立に使う |
| `monitor-lib.sh` | 共有ヘルパー（JSON scalar 抽出・ANSI 正規化・アンカー検出）。単体では呼ばない |

script は自分の位置から兄弟 script を解決するので、install 先の
`.agents/skills/cmate-orchestrate-monitor/` と `.claude/skills/cmate-orchestrate-monitor/` の
どちらの root から実行してもよい。**`scripts/` の中身を個別に別 directory へ copy しない。**

### 2.4 どちらの経路で走っているか

完了判定にはタスク台帳（一次ソース。`commandmate >=0.17.0`）と capture ヒューリスティクス
（フォールバック。`>=0.15.0`）の 2 経路があり、`hold:policy` の検出にはさらに `>=0.21.0` が要る。
manifest の `compatibility.commandmate` は package 全体の下限（`>=0.15.0`）で、新しい経路が
無くても Skill は成立する（フォールバックへ、または「保留すべきものを保留しない」方向へ縮退する）。

**どちらで走っているかを version から推定しない。実行時に判る** — 台帳を引けなければ
`FALLBACK MODE` 行が worker ごとに 1 度出て、引ければ poll 行に `task=` が付く。**黙って劣化しない。**
なぜ引けないのかの切り分けが要るときだけ `commandmate task list <wid> --limit 1` を直接叩けば、
古い版か・サーバ停止か・未知の worktree かがそのまま出る。

> この SKILL.md には**日付つきのバージョン実測（「現時点の公開版は…」の類）を書かない**。
> そう書いた行は次のリリースで嘘になり、しかも嘘になったことが誰にも見えない
> （実際 0.4.0 の本節は「`commandmate task` は未リリース」と断定していた）。
> 測定日つきの記録は [references/evidence.md](./references/evidence.md) にだけ置く。

## 3. 状態と判定

| 状態 | 意味 | ループの扱いと介入 |
|---|---|---|
| `NOT_RUNNING` | セッションが無い | idle streak を進める（介入先が無い） |
| `GENERATING` | ターン実行中（CLI 自身のリトライ backoff 中を含む） | started を latch、streak を 0 に戻す。**注入しない**（queue されて契約外の作業を始めさせる） |
| `PROMPT` | 承認・選択待ち | **承認可と判定できたときだけ** Enter（サイレント・`approvals`）。それ以外は保留して報告（`held`） |
| `RATE_LIMIT` | usage limit / credits バナー | `a` を送る（待たない） |
| `IDLE` | 上記のいずれでもない | streak を進める。**idle 閾値到達・現ペインに terminal API error・`--max-resends` 未消化のすべてを満たすときだけ** `--resend-message`（既定 `continue`） |

分類順は `NOT_RUNNING → is_retrying(→GENERATING) → PROMPT → GENERATING → RATE_LIMIT → IDLE`。
各分岐は入力注入か抑止のどちらかを引き起こすので、**この順序は仕様であって実装詳細ではない**
（根拠は recipe-rationale 2〜6・8、契約は monitor-contract 第1節）。

**この Skill が worker へ送るのは Enter・`a`・再送文字列の 3 種類だけで、作業指示は送らない。**
送信先はそのポーリングの capture ペイロードから導出し、`tmux has-session` の完全一致で存在を
検証してから送る。届かなかった介入は握り潰さず stderr に出し、**`approvals` と再送予算は配信
できたときだけ動く**（monitor-contract 第3節、Issue #1602）。

### 完了判定

| 判定 | 意味 |
|---|---|
| `COMPLETE` | タスクが `succeeded`（サーバ側で検証ゲート合格済み）、またはフォールバック時に started 済み・idle 閾値到達・**実作業の証拠あり**（commit か uncommitted が 1 以上） |
| `VERIFY_FAILED` | タスクが `failed` / `cancelled`。**終局だがマージ不可**。「worker が止まった」と「成果が良い」を分離するための判定である |
| `NOT_STARTED` | タスクが `not_started`、または作業の痕跡が無い。タスクが送られていない疑い（第4節） |
| `WORKING` | 上記以外。監視を続ける |

判定順は **ペイン生存 veto → 裁定済みタスク状態（終局状態だけ）→ STARTED ガード → idle 連続と
作業量**で、**順序そのものが仕様である**（monitor-contract 第2節）。古い裁定で監視を打ち切らせ
ないことと、`running` を短絡させて STARTED ガードを盲目にしないことの 2 つを、この順序が守って
いる（recipe-rationale 12c）。

> **契約付き委任の最終裁定は `commandmate wait --verify` の exit code である**（第1節）。
> monitor が読むタスク状態はその裁定の**写し**であり、監視ログの `COMPLETE` は
> 「裁定が succeeded だった」以上のことを意味しない。

### プロンプトへの Enter（保留一覧と `--no-auto-approve`）

Enter は tmux ペインへ直接送るので **CommandMate サーバの承認制御を一切通らない**。したがって
`PROMPT` と分類しただけでは送らない。そのポーリングの `promptData` が**「デフォルト選択肢が肯定で
ある二択」であることを示したときだけ**送り、示さないものは**保留（hold）**する: キーを送らず、
理由つきで 1 度だけ報告し、`held` を加算する（判定の全条件は monitor-contract 第3節
`ml_prompt_enter_verdict`、実測は evidence 第1e節）。

| hold 理由 | 何が起きているか | オペレータの手 |
|---|---|---|
| `hold:policy` | 契約の autoYes ポリシーがサーバ側で応答を保留した（`autoYes.lastSuppression`） | 契約の意図どおり。人が答えるか、契約を直して再委任する |
| `hold:no-default` | どの選択肢も default ではない。Enter はカーソル位置を確定する | ペインで選ぶ／`commandmate respond` で答える |
| `hold:choice` | default はあるが、その label が承認ではなく「選択」である | 同上 |
| `hold:no-prompt-data` | フレームに `promptData` が無い（テキストマーカーだけで `PROMPT` と分類した） | ペインを見る。製品側の検出器が読めていない形である |
| `hold:type` | 未計測のプロンプト型 | ペインを見る。判定条件の更新が要る |
| `hold:disabled` | `--no-auto-approve` が指定されている | 意図どおり |

**「multiple_choice なら一律保留」にはしていない。** 実測では Claude Code の権限プロンプトも含め
`promptData.type` は測定した全フレームで `multiple_choice` であり、一律保留は実運用のプロンプト
承認を 100% 止める。危険なのは型ではなく「デフォルトが承認かどうか」である。

**契約付き dispatch を監督するときは `--no-auto-approve` を付ける。** `hold:policy` は**保険で
あって保証ではない** — サーバがポリシー保留を記録するのはセッションの Auto-Yes が有効なときだけで、
`lastSuppression` の鮮度も見ていない（evidence 第1e節「実装していない保護」）。

## 4. フックを配線する（配線しないと完了判定が発火しない）

`monitor.sh` は 3 つのフックを呼ぶ。いずれも **既定はスタブ**で、`read_task_status` は空文字、
`count_commits` / `count_uncommitted` は常に 0 を返す。`verify-completion.sh` は
`commits=0 かつ uncommitted=0` を **「タスクが送られていない」兆候**として扱う（STARTED ガード）。
したがって **フック無しの実行では COMPLETE 分岐に到達せず、完走した worker まで `NOT_STARTED` と
記録される**（recipe-rationale 回帰 8）。指定した hooks file が存在しない場合は、黙ってスタブに
落ちずに **exit 2 で即座に失敗する**。

| フック | 供給するもの | 参照実装 |
|---|---|---|
| `read_task_status` | 一次ソース。worktree の**最新**実行契約の状態 | `hooks-task.sh` |
| `count_commits` / `count_uncommitted` | フォールバックの作業量カウンタ | `hooks-git.sh` |

- 契約付き委任なら 2 本とも配線する（第2.1節の標準形）。契約なし委任は `hooks-git.sh` だけでよく、
  従来と同じ挙動になる。
- `hooks-task.sh` の前提は **監視中の契約がその worktree の最新タスクであること**である
  （契約作成 → `send --contract` → 監視、の標準手順なら成立する）。前回の委任のタスクが最新の
  まま監視を始めると、その古い裁定を読む。
- **`git` が答えられなかった場合と、worker が本当に何も書いていない場合は別物である**
  （CommandMate #1614）。前者は原因ごとに **worker あたり 1 行**を stderr へ出す
  （`monitor hooks ERROR: [<wid>] …` / `monitor hooks WARN: [<wid>] …`）。この行が出ていたら
  `commits=` / `uncommitted=` の 0 は「測れなかった」であって「作業ゼロ」ではない。
  `ERROR` = その worker については**何も測れていない**（両カウンタが答えの代わりに 0）、
  `WARN` = 片方のカウンタだけが劣化し、もう片方は実測値。

#### worktree-id の突合順（CommandMate #1728）

`hooks-git.sh` は worktree-id を `git worktree list --porcelain` から実 checkout へ解決する。
突合は次の順で行い、**1 が最優先**である。

| # | 突合対象 | 由来 |
|---|---|---|
| 1 | `slug(basename(<checkout path>))` | **現行**。`deriveWorktreeId()`（CommandMate #1621）＝ ディレクトリ名。初回登録時に一度だけ確定するので、ブランチを切り替えても id は変わらない |
| 2 | `slug("<repo>-<branch>")` | 旧 `generateWorktreeId()`。`<repo>` はメイン worktree のディレクトリ名 |
| 3 | `slug("<branch>")` | 同上（repo 名なし） |

**1 が欠けていたのが CommandMate #1728 の本体である。** 2・3 しか無い状態では、ディレクトリを
ブランチ名ではなく Issue 番号で採番するリポジトリ（`commandmate-issue-1728` / `fix/1728-…`）では
**1 件も**——**メイン worktree すら**——解決できず、すでにコミット済みの worker まで
`commits=0 uncommitted=0` と報告されていた。#1614 が塞いだのは「git が失敗する」経路で、これは
**git は成功して突合が外れる**別経路である。`verify-completion.sh` は `commits=0 && uncommitted=0`
を「タスクが composer から出ていない」の署名として読むので、STARTED ガードは**誰も測っていない
数字**で裁定していたことになる。

1 を先に見るのは、稼働中のサーバが配る id が 1 だからである（2 と 3 が別 checkout に当たったときは
1 が勝つ）。1 は `branch` レコードを持たない detached HEAD にも効く。ディレクトリ名が衝突している
2 つの checkout は区別できないので、最初の 1 件を数えたうえで `WARN` を出す（別の checkout を
数えたいときは `MONITOR_WORKTREE_ROOT` を指定する）。

**arm する前に、フックが実値を返すことを対照実験で確かめること。**

```bash
. <skill-dir>/scripts/hooks-git.sh
count_commits <worktree-id>; count_uncommitted <worktree-id>   # 実測値と一致するか
count_commits no-such-worker                                   # 解決できない id は 0

CM=commandmate . <skill-dir>/scripts/hooks-task.sh
read_task_status <worktree-id>   # 契約中の状態 / 契約なしなら空 / 引けないなら unavailable
```

## 5. やらないこと

- worker の作成・dispatch・作業指示の送信（`cmate-orchestrate` の担当。第1節）。
- PR 作成・merge・Issue の close。
- 完了したかどうかの **推測**。証拠（commit / uncommitted）が無ければ `COMPLETE` にしない。
- **プロンプトの中身の判断**。「この操作を承認してよいか」は決めない。決めるのは
  「Enter が承認を意味する形かどうか」だけで、意味しないものは保留して人へ返す（第3節）。
- 未計測の Agent・CLI version を「対応」と宣言すること
  （[references/agent-compatibility.md](./references/agent-compatibility.md)）。

**この監視が検知できないこと**: **送信側の欠陥**（worker に届いた指示文が壊れていても worker は
健全に生成し、監視は正しく COMPLETE を出す）／**成果物の正しさ**（フォールバックの COMPLETE は
「作業の痕跡があり、生成が止まった」であって受入条件の充足ではない）／**マージ可否の裁定**。

実運用実績は延べ 371 ポーリング・誤報 0 件だが、**それはすべて capture ヒューリスティクス
（フォールバック経路）のものである**。タスク状態経路・修正後の介入経路・プロンプト保留は
fixture と変異注入で固定してあるだけで、実運用実績はまだ無い。運用条件・状態分布・介入内訳・
測定の限界は [references/evidence.md](./references/evidence.md) に記録してある。

## 6. 参照

- [references/monitor-contract.md](./references/monitor-contract.md) — 入出力・フラグ・env・出力行・終了コード
- [references/recipe-rationale.md](./references/recipe-rationale.md) — 各ルールの出所と回帰一覧
- [references/evidence.md](./references/evidence.md) — 実運用での検証状況と限界
- [references/agent-compatibility.md](./references/agent-compatibility.md) — Agent 差異と互換宣言の方針
- [cmate-orchestrate](../cmate-orchestrate/) — 契約付き dispatch の一次監督（第1節の決定規則）
