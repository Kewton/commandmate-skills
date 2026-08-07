# dispatch 契約 v1

`cmate-orchestrate` の dispatch runner（`scripts/dispatch.mjs`）が、承認済み plan を
どう実行し、public `commandmate` CLI とどう話すかの定義である。機械検証用の正本は
[../schemas/dispatch-report.v1.json](../schemas/dispatch-report.v1.json)（dispatch report）
であり、この文書はその読み方と、schema では表現できない規則を述べる。

計画コア（[plan-contract.md](./plan-contract.md)）は **dry-run で plan を作るだけ** で
mutation を一切しない。dispatch runner は、その plan を入力に取り、**mutation を伴う実行**
（worker への dispatch）を監督する。両者は別 runner であり、planner の
`--phase dispatch` は依然として `not_implemented` を返す。実行は承認済み plan を
`dispatch.mjs --plan <path>` に渡して行う。

`dispatch_schema_version` は 1 である。field の追加・削除・意味の変更、および enum への
値の追加は version を上げて行う。**未知の field を足さないこと。**

実行契約への移行（[#1588](https://github.com/Kewton/CommandMate/issues/1588)）でも
`dispatch_schema_version` は **1 のまま**である。裁定の**測り方**を profile baseline の再実行から
CommandMate の exit code へ移しただけで、report 上の表現（field 集合と enum 値）は変えていない。
これは互換のためだけではない: merge runner と uat runner は dispatch report から
`worker_state === 'completed'` と `verification.outcome === 'pass'` の **2 field しか読まない**ので、
この2つの enum 値と意味を変えると両 runner が黙って壊れる。したがって
「判定していない」は新しい値ではなく既存の `not_run` で表し、契約固有の事実
（どちらの裁定機構を使ったか・exit 99 だったか）は `limitations` / `blocking_reasons` /
`note` / `summary_markdown` に載せる。

## 1. 入力

| 名前 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `--plan <path>` | 必須 | なし | 承認済み `plan.json`（plan-core の出力） |
| `--out <dir>` | 任意 | `<plan-dir>/dispatch` | dispatch artifact の出力先。既存なら `out_exists` で拒否。**blocking pre-flight（第3節）で停止した場合は作らない**ので、原因を直して同じコマンドを再実行できる |
| `--cli <launcher>` | 任意 | `$CM` → `commandmate` | 実行する public CommandMate ランチャー（第 2.8 節） |
| `--git <path>` | 任意 | `git` | drift 確認に使う git |
| `--gh <path>` | 任意 | `gh` | repo 到達性確認に使う gh |
| `--auto-yes` | 任意 | off | worker prompt を自動応答する。既定 off（prompt で停止し human へ提示） |
| `--contract-mode <m>` | 任意 | `auto` | `auto` / `require` / `off`。契約非対応 CLI での挙動を決める（第2.7節） |
| `--verify-gates <ids>` | 任意 | なし | 契約の `verify.gates` に載せる gate id（comma 区切り）。既定は省略＝全ゲート |
| `--expect-branch <name>` | 任意 | なし | plan 承認時の統合 branch。dispatch 時に不一致なら drift |
| `--wait-timeout <sec>` | 任意 | 300 | `commandmate wait` に渡す1回あたり timeout |
| `--max-turns <n>` | 任意 | 8 | 各 worker を駆動する最大ターン数（初回 send + nudge / 再指示）。未 commit のまま到達で当該 worker を failed とする |
| `--poll-limit <n>` | 任意 | 120 | 互換のため保持（wait は block するので poll しない） |

`commandmatedev` は使わない。公式経路は public `commandmate` である（ADR [#1447](https://github.com/Kewton/CommandMate/issues/1447)）。

## 2. commandmate CLI の呼び出し規約（worktree-id ベース）

実 `commandmate` CLI は **worktree-id ベース**であり、`--json --worktree`・`--prompt-file`・
`--task` は無い（#1467）。CommandMate **0.17.0** で実行契約（`send --contract`）と検証
（`verify` / `wait --verify`）が入り、`send --contract` は **task id を stdout に返す**
（[#1544](https://github.com/Kewton/CommandMate/issues/1544) /
[#1545](https://github.com/Kewton/CommandMate/issues/1545)）。dispatch runner は次を呼ぶ。
**worker completion と verification success は別物** であり、別々に判定する。

| subcommand | 引数 | 結果の読み方 | 用途 |
|---|---|---|---|
| `ls` | `--json` | `[{ "id", "name", "branch", "path", … }]` | dispatch 時に worktree-id **と実 path** を解決（#1473） |
| `send` | `<worktree-id> --contract <path>` | exit 0 で送信成功。**stdout の最終行が task id**。契約不正は exit 2 で全違反を stderr に出し、**何も送らない** | 実行契約で dispatch する（0.17.0 以降） |
| `send` | `<worktree-id> <message>` | exit 0 で送信成功 | 継続 nudge・再指示・送信確定・フォールバック時の generic worker prompt |
| `capture` | `<worktree-id> --json` | `{ "isGenerating", "isPromptWaiting", "content", "promptData": { "question" }, … }` | 送信確定の確認・prompt/出力の human 提示用取得 |
| `wait` | `<worktree-id> --on-prompt agent --verify --timeout <sec>` | **exit code**: 0 pass / 20 判定して不合格 / 21 作業証跡ゼロ / 10 prompt / 99 **判定に到達せず** / 124 timeout / 1・2 インフラ | 1ターンの終了を待ち、契約ゲートの裁定を受け取る |
| `wait` | `<worktree-id> --on-prompt agent --timeout <sec>` | **exit code**: 0 idle / 10 prompt / 124 timeout / その他 failed | 裁定済み（pass 後）の commit 待ち・フォールバック時の idle 待ち |
| `verify` | `<worktree-id> --json` | 検証 run document（`{ status, gates: [{ gateId, status, exitCode, logTail }] }`） | exit 20 のとき**失敗ゲートを特定**する（裁定そのものではない。第2.3節） |
| `respond` | `<worktree-id> yes` | exit 0 | prompt への応答（`--auto-yes` 時のみ） |
| `send`/`wait` | `--help` | 出力に `--contract` / `--verify` が載るか | 実行冒頭のバージョンゲート（第2.7節） |

**`--on-prompt` は「誰が prompt に答えるか」である。** `agent`（既定）は prompt を**呼び出し元へ
exit 10 で返す**。`human` は「人が UI で答えるまで `wait` が block する」ため **exit 10 を返さない**。
本 runner の方針は「自動応答せず停止して human へ提示」なので、契約経路では `--on-prompt agent` を
**明示的に**渡す。`human` を渡すと prompt 提示は起きず、`--timeout` まで待って timeout として
報告されることになる（方針の反対）。

**重要（#1468）**: 実 Claude worker は **1メッセージ＝1ターン**で動き、各ターン後に入力待ちで
**idle 化**する。したがって dispatch runner は **wait の exit 0 を「タスク完了」とみなさない**。
契約経路の exit 0 は「1ターン終わって、かつ全ゲートが pass した」であり、完了の ground truth は
依然として **worktree ブランチに新規 commit が出たこと**（`git rev-parse HEAD` を worktree 内で
実行し、dispatch 開始時 SHA から進んだか）である（第2.2節）。`work-evidence` ゲートは未 commit の
変更も作業証跡として数えるので、**ゲートが pass しても commit が無い状態はありうる**。その場合は
commit を要求する（下流の PR 作成は commit を必要とする）。

規則:

- 契約は plan だけから**決定的に**生成する（第2.4節）。契約非対応の CLI では、従来どおり
  plan だけから構成する **self-contained な generic prompt** を `send` の `<message>` として渡す。
  どちらのモードでも repository-local な worker Skill を必須依存にせず、worker が読む本文は
  `<out>/prompts/issue-<n>.md` に artifact として残す（[SKILL.md](../SKILL.md) 第2部）。
- worktree-id は plan の `worktree_id`（valid なら）→ 無ければ `commandmate ls --json` を Issue の
  `branch` で突き合わせて解決する（id の一次ソースは `ls`）。`ls` が行を返したのに branch が一致しない
  場合だけ、`commandmate sync`（CommandMate 0.21.0+ に実在する server 側の worktree 再スキャン。
  worktree は**作らない**）を run 全体で **1度だけ** 実行して `ls` を読み直す。sync が失敗しても
  （0.21.0 未満は subcommand 自体が無い）それ自体では run を止めず、従来どおり未解決として扱う
  （未解決なら #90 の `worktree_unresolved` で停止する）。sync の試行と結果は `limitations`
  （`worktree_sync_ran` / `worktree_sync_unavailable`）と worker の `note` に残す。**git 操作（commit 検出・baseline
  検証）の cwd となる worktree path も、この `ls` で解決した行の実 `path` フィールドから取る**（#1473）。
  plan の `worktree_template` 由来 path は `ls` が path を返せない場合の fallback に留める。こうして
  `send`/`wait`/`capture`（id 解決）と git 操作（path 解決）が **同一の worktree を指す**。登録 path が
  template と異なっても、branch が一致すれば worker の commit と成果を正しく検出できる。worktree path
  （baseline の cwd）は **path escape 検査** を通す（第4節）。
- `wait` は終端まで block するので poll しない。exit code が 10（prompt）のとき stdout に prompt JSON が
  出るが、runner は redaction 済みの `capture` 抜粋のみを report に残す（raw は残さない）。
- 各 subcommand が非0・binary 不在で失敗した場合、その worker は `failed`（send/wait 失敗・worktree
  未解決）または drift（CLI 不在）として扱い、握りつぶさない。

### 2.1 verification（裁定）

裁定機構は2つあり、**どちらを使ったかは必ず report に書く**（第2.7節）。

**(a) 契約経路（既定・CommandMate 0.17.0 以降）** — `commandmate wait --verify` の **exit code** が
一次ソースである。runner は判定を再実装しない。

| exit | `verification.outcome` | 扱い |
|---|---|---|
| `0` | `pass` | 全ゲート pass。**この裁定は最終である**（第2.5節） |
| `20` | `fail` | 判定して不合格。失敗ゲートを特定して再指示（第2.3節）。上限到達でも success に丸めない |
| `21` | `fail` | 作業証跡ゼロ。nudge して再度待つ。上限到達なら dispatch 失敗系として worker を `failed` |
| `99` | **`not_run`** | **判定に到達していない**。pass でも fail でもない（第2.6節） |
| `10` / `124` / その他 | `not_run` | prompt / timeout / インフラ。裁定は行われていない |

`checks` には裁定の由来（`commandmate wait --verify → exit N …`）と、exit 20 のときは失敗ゲート
（`gate <id>: <status> (exit N)`）を redaction 済みで載せる。`report_schema_version` は `null`
（CommandMate の検証 run document は schema version を持たない）。

`gates` には、その run の `GATE <id> PASS|FAIL` 行をそのまま転記する（#47 / CommandMate #1678 B-5:
**report 単体で「何が pass の根拠か」が読める**ようにするため）。`outcome: pass` なのに `gates` が
空になった場合は、**拾えなかったこと自体**を limitation `verification_gates_unrecorded` と `checks`
の1行に記録する。planner の `unrecognized_file_extension` と同型で、空のリストを「何も走らなかった」
と読ませない。

### 2.1.1 裁定の記録（Issue #83）

**裁定に到達したら、その worker の `verification` に必ず記録する。** 記録は wave の他の worker の
状態に依存しない。0.15.0 までは転記が「wave の全 worker が completed のとき」の内側にあり、
1人でも失敗・timeout・prompt・未 dispatch があると、**同じ wave の他の worker**（exit 0 で pass し
commit も出した worker を含む）が初期値 `{ran: false, outcome: 'not_run', gates: [], checks: []}` の
まま出力されていた。merge / uat は `worker_state === 'completed' && verification.outcome === 'pass'`
しか読まないので、検証に通った成果物が **report の書き方だけを理由に** 納品経路から外れ
（`no_eligible_issues`）、PR 作成・CI ゲート・guarded merge・UAT の二層裁定が**すべて迂回**された。
barrier（第3節 4・5）は「次 Wave を dispatch してよいか」を決めるものであって、
**事実を書き残すかどうかを決めるものではない**。

同じ理由で、`not_run` は「worker が完了しなかった」ではなく **「何も判定しなかった」** を意味する。
exit 21 は work-evidence ゲートが判定して落とした結果なので、worker が `failed` でも `fail` である。

`note` は `verification` と**同じ1箇所**で組み立てる。0.15.0 までは監督ループが
「verification passed …」という文字列を独立に作っており、上記の記録漏れと組み合わさって
**note は pass、構造化 field は not_run** という自己矛盾した report が出ていた。読み手は
どちらを信じるべきか決められず、merge / uat は field を信じる。現在は `verification` から
文面を生成するので、この矛盾は表現できない。

completed でありながら裁定が1つも記録されなかった場合は、黙って通さず
limitation `verification_unrecorded` と completion check `verification_recorded` の失敗として報告する。
これは verification の失敗でも worker の失敗でもなく、**runner が記録に失敗した**という別の事実である。

**(b) フォールバック経路** — plan `profile.baseline` の各 command を **worktree 内で
`execFile`（cwd=worktree path）** 実行する。全 command が exit 0 なら `outcome: pass`、worktree が
無い・いずれかが非0なら `fail`。`report_schema_version` は `null`、`checks` は実行した baseline
command の（redaction 済み）ラベルである。

いずれの経路でも、**worker completion だけでは gate は開かない**。

### 2.2 completion（commit 検出）

worker の完了は idle ではなく **worktree ブランチの新規 commit** で判定する。dispatch 開始前に
`git rev-parse HEAD`（cwd=worktree path。この path は `ls` 解決の実 `path`＝send/wait/capture が指す
worktree と同一、#1473）で **開始時 SHA** を記録し、各 idle 後に再取得して比較する。
SHA が進んでいれば `completed`（commit 検出）、進んでいなければ「まだ 1ターン終えて idle 化しただけ」で
あり、**継続 nudge** を送って次のターンを待つ。generic worker prompt には「作業完了時に単一 commit せよ」
を明記し、これを完了の合図とする。SHA が取得できない worktree は「未 commit」として扱い、完了とはしない。

### 2.3 失敗ゲートの特定（exit 20 のときだけ）

exit 20 は「ゲートが判定して落ちた」なので、**何が落ちたか**を worker に伝えられる。runner は
`commandmate verify <worktree-id> --json` を呼び、`gates[]` のうち `failed` / `timeout` / `error` の
ものを取り出して、gate id・status・exit code・`logTail` の短い抜粋を再指示メッセージに引用する。
「検証に失敗した」だけを渡すと worker は原因を推測することになる。

注意: この呼び出しは**2回目の run を開始する**ので、その run 自身の裁定は wait のものと食い違いうる。
**裁定は wait の exit code のままとし**、この呼び出しは gate を**名指しする**用途に限る。内訳が
取れなかった場合はその事実を `checks` と再指示メッセージに書く（取れなかったことを隠さない）。

### 2.4 実行契約の生成（決定的）

正準仕様は CommandMate の `docs/design/task-contract.md`（v1）。閉じたキー集合
（`version` / `title` / `goal` / `scope` / `verify` / `autoYes` / `success`）で、未知キーは契約エラー、
`title` は必須、`verify.gates: []` はエラー、`success.requireScopeClean` が既定 true なので
`scope.allow` は実質必須である。

runner は承認済み plan **だけ**から契約を組み立てる。時刻・乱数・環境を読まず、リストは並びを固定
（`scope.allow` はソート＋重複除去）するので、**同一 plan → byte-identical な契約**になる
（planner と同じ Claude/Codex parity 規則）。生成規則は [SKILL.md](../SKILL.md) 第2部 Step D2 の表。

- 契約は worktree の `.commandmate/tasks/cmate-orchestrate-issue-<n>.yaml` に置く。この directory は
  work-evidence の計数と scope 判定から除外されるので、**未 commit のまま置いてよい**（#1580）。
- 同じ内容を `<out>/contracts/issue-<n>.yaml` にも残す。worktree の写しは worker が書き換えうるが、
  run artifact は動かない。
- `verify.gates` は `--verify-gates` を指定したときだけ書く。runner は対象リポジトリの
  `verify.yaml` を知らず、**存在しない gate id は `send --contract` を exit 2 で落とす**。キーの
  省略は「全ゲートを走らせる」であり、緩い側ではなく厳しい側の既定である。
- `success.requireScopeClean` は**常に `true`** である。以前は `<allow が非空か>` で決めており、
  対象 file を1つも挙げていない Issue だけ scope ゲートが丸ごと無効化されていた。scope 判定が
  無い契約は「worktree 内の何を書いても clean」と同義なので、これは過剰拒否の裏返しの
  **無制限**であり、Issue の書き方ひとつで両極が入れ替わっていた（Issue #50）。
- plan が対象 file を1つも挙げていない Issue は、scope を捏造せず、また緩い契約も作らず、
  **dispatch しない**。runner は send も contract 配置も行わず `contract_scope_unknown` を
  limitation に記録し、その worker を `not_dispatched` のまま残す（wave は advance しない）。
  対象 file は plan 側で名指すしかないので、これは worker からは解決不能な欠落である。
- dispatch を拒否された worker がいる wave の停止理由は `not_dispatched` であり、
  `verification_failed` ではない。走っていない worker を「検証に落ちた」と報告すると、
  plan の欠落を worktree の不具合として調査させることになる。

### 2.5 pass は再検証しない

exit 0 の run は契約タスクを `succeeded`（終端）へ遷移させる。その後に同じ worktree で検証 run を
起こすと、run は契約に束ならず「scope を判定していない run」として `error` になり、**exit 99** が
返る（[#1620](https://github.com/Kewton/CommandMate/issues/1620)）。したがって runner は、いったん
pass を得た worker に対して `--verify` を**二度と付けない**。付ければ、自分で「判定に到達しなかった」
状態を作り出すことになる。pass 後に commit を待つ必要があるときは `--verify` 無しの `wait` を使う。

### 2.6 exit 99 は「判定していない」

`99`（`UNEXPECTED_ERROR`）は検証 run が `error` / `cancelled` で終わったこと、すなわち
**どのゲートもこの作業を判定していない**ことを意味する。CommandMate 側のコメントが明言している:
「`error` と `cancelled` は判定に到達しなかったという意味なので `VERIFY_FAILED` ではなく汎用の
`UNEXPECTED_ERROR` を取る — 20 で分岐する呼び出し元は、ゲートが実際に走って判定したと信頼できな
ければならない」。

したがって runner は 99 を:

- **pass に丸めない**（何も判定していない）
- **20 の再指示ループに流さない**（判定していないものの修正を worker に求めることになる。上限まで
  無意味な往復を続け、最後に「修正できなかった」と報告することになる）
- `verification.outcome` を `not_run`、`blocking_reasons` に `verification_not_judged`、
  `human_required` を true として **human へ上げる**。`stop_reason` は `dispatch_error` である

停止時の `stop_reason` 優先順位で 99 を `worker_failed` / `verification_failed` より先に見るのも
同じ理由で、**再 dispatch では解けない**からである。

### 2.7 バージョンゲート（黙って劣化しない）

実行冒頭に一度だけ `commandmate send --help` と `commandmate wait --help` を実行し、`--contract` と
`--verify` が載っているかを確認する（両方揃って初めて契約経路に入る）。probe の目的は分岐そのもの
ではなく **開示** である。黙ってフォールバックすると、`verification.outcome: pass` という同じ 1 行が、
「宣言された全ゲートが通った」から「profile baseline が exit 0 だった」へ意味を変えたまま下流へ流れる。

| `--contract-mode` | 契約が使える | 契約が使えない |
|---|---|---|
| `auto`（既定） | 契約経路 | フォールバック。`limitations` に `contract_unsupported` と理由を記録して続行 |
| `require` | 契約経路 | **停止**。1件も dispatch せず `blocking_reasons` に `contract_unsupported`、`status: failure` |
| `off` | probe せずフォールバック。`limitations` に `contract_disabled` | 同左 |

どのモードでも `summary_markdown` の冒頭に「どちらの裁定機構で判定したか」を書く。

### 2.8 ランチャー解決（Issue #37）

`--cli` が受け取るのは実行ファイル名ではなく**ランチャー**である。解決順は 1つだけ:

```
--cli <launcher>  →  $CM  →  "commandmate"
```

`$CM` は `cmate-orchestrate-monitor` の `monitor.sh` / `hooks-task.sh` が使うのと**同じ変数・
同じ意味**である。グローバル導入を持たない npx 運用では、利用者は `CM` を 1 つ設定すれば
dispatch / uat / monitor / verify-advisor のすべてが同じ launcher を使う。

- **受理する**: 空白区切りの 1 個以上のトークン。先頭が program、残りは固定の先行引数。
  `commandmate` / `/usr/local/bin/commandmate` / `npx commandmate@latest` / `node /path/cli.mjs`。
- **拒否する**（`invalid_input`、exit 3）: 空値、先頭が `-` で始まる値、制御文字、および
  シェル構文（パイプ・`&`・`;`・リダイレクト・小括弧・`$`・バッククォート・バックスラッシュ・
  引用符）。runner は `execFileSync` を使い**シェルを経由しない**ため、
  これらは黙って literal な引数として渡り誤動作する。エラーは拒否理由と、
  `~/.local/bin/commandmate` に `exec npx --yes commandmate@latest "$@"` のラッパを置く回避策を
  名指しする。

**ランチャー解決は実行時の話である。** plan.json は入力の純粋関数であり、`$CM` を変えても
plan の byte 列は変わらない。dispatch report にも解決結果は載せない。

## 3. 監督ループと gate

### 3.0 blocking pre-flight（`--out` を消費する前）

**plan の検証と、最初の Wave の drift 再確認は、出力ディレクトリを作る前に行う**
（[#90](https://github.com/Kewton/commandmate-skills/issues/90)）。ここで停止した場合:

- **`--out` を作らない**（`out_dir` は `null`）。artifact も書かない。failure report は stdout にだけ出す。
- exit は failure の規約どおり 1。
- したがって**原因を直して同じコマンドを再実行できる**。これが目的である: 以前は全チェックより先に
  `mkdirSync` していたため、1件も dispatch していない停止でも `--out` が消費され、
  worktree を用意しての再実行が `out_exists` で弾かれた。利用者に `--out` を発明させない。

pre-flight を通過した後の挙動（`--out` 作成・`out_exists` 検査・artifact 書き出し）は変わらない。
pre-flight が確定した最初の Wave の worktree 解決と drift 結果は**そのまま Wave 1 で再利用**する
（CLI を二度叩かない）。plan だけで決まる拒否（未回答の planner question。`--allow-questions` 未指定）は
世界の状態に依存しないので、その場合 pre-flight は世界を probe しない — 答えが何も変えられない
probe は副作用でしかない。この停止は従来どおり `--out` を作り、artifact も書く。

### 3.1 Wave ループ

各 Wave について、plan の順に次を行う。

1. **drift 再確認（mutation 前）** — `cli_available`・`repo_access`・`base_resolvable`・
   `branch_matches`（`--expect-branch` 指定時）・`integration_clean`・`worktrees_present`
   を確認する。**blocking** な check が false なら dispatch せず停止する。blocking は
   `integration_clean` **以外の全部**であり、非 blocking は `integration_clean` だけである。
   非 blocking の失敗は `limitations` に記録して続行する。`worktrees_present` は、Wave 各 Issue の
   branch が `commandmate ls` で登録 worktree に解決できるか（＝supervisor が使うのと同じ到達性）を優先し、
   解決できないものだけ `git worktree list` の template path 一致で補う（#1473）。登録 path が template と
   異なっても branch が一致すれば present とみなし、silent な false-NG で false-failed を覆い隠さない。
   最初の Wave 前の drift は「何も dispatch していない」ので `failure`（第3.0節の pre-flight で停止する）、
   途中の Wave 前の drift は `partial`。stop_reason は `drift`。

   **`worktrees_present` は blocking である**（#90）。解決できない worktree は `send` の宛先が
   無いということなので、続行しても当該 Issue は worker を1人も起動しないまま `failed` になるだけである。
   blocking reason は**未解決 Issue ごとに1件**、
   `{ "code": "worktree_unresolved", "detail": "#<issue>: no registered worktree matches branch <branch>" }`
   を出す（branch は redaction 済み）。集計値（「N 件が解決しない」）だけでは、どの Issue の worktree を
   作ればよいかが読めない。この経路では `limitations` に `drift_worktrees_present` は記録せず、
   **blocking_reasons 側に一本化する**。対処は `cmate-worktree-setup` での worktree 作成であり、
   Issue の分割でも re-plan でもない。
2. **max_parallel 遵守** — Wave の幅は plan で `max_parallel`（1〜3）以下に保証済み。
   万一超える plan は `plan_invalid` で拒否し、runner は上限を超えて dispatch しない。
3. **dispatch と監督ループ（#1468 / #1474）** — Wave の各 Issue を次の監督ループで駆動する。**Wave 内の
   各 worker はこの監督ループを per-worker で並行に走らせる**（#1474）。`commandmate wait` は idle 化まで
   block するので、逐次に回すと wall-clock が worker 数ぶん積み上がる。実行時の並列度は Wave 幅（＝plan の
   `max_parallel` 以下）に一致させ、各 worker の commit 検出・`--max-turns`・auto-yes の `respond`・prompt
   停止・verification は独立に保つ。barrier（下記 4・5）は全 worker の terminal 化後にまとめて評価する。
   1. 開始時 SHA を記録（第2.2節）し、契約経路なら契約を worktree に置いて
      `send <id> --contract <path>`、フォールバックなら generic worker prompt を `send` する。
   2. **送信を確定** — `send` は Enter 未確定で送信が確定しない癖があるため、送信直後に
      `capture --json` で worker が動き出したか（`isGenerating`/`isRunning`/`isPromptWaiting`）を
      確認し、動いていなければ **1回だけ再送**して確定を試みる。契約経路の再送は
      **plain message** で行う（`--contract` での再送は同じ作業に task 行を2つ作る）。
   3. `wait` で待つ。契約経路は `--on-prompt agent --verify` 付き、フォールバックは従来どおり。
      - **exit 10（prompt）** → `capture` で内容を取得して human へ提示し停止する。**自動応答しない**
        （`--auto-yes` 明示時のみ `respond yes` して同ターンを続行）。
      - **exit 124（timeout）** → `timeout`。**exit 1/2 その他非0** → `failed`。
      - **exit 99** → 第2.6節。再指示せず `human_required` で停止する。
      - **exit 0** → 裁定 pass。第2.2節の commit 判定。新規 commit あり → `completed`。
        commit が無ければ commit を要求し、**以降 `--verify` を付けずに** wait する（第2.5節）。
      - **exit 20** → 第2.3節で失敗ゲートを特定し、その内訳を引用して再指示する。
      - **exit 21** → 作業証跡ゼロ。継続 nudge を送って 3 へ戻る。
      - フォールバックの **exit 0（idle）** → 第2.2節の commit 判定のみ（裁定は 5 で行う）。
   4. **ターン数が `--max-turns`（既定 8）に達しても未 commit** なら、当該 worker を
      `failed`（note に理由）とし、握りつぶさない。20 のまま上限に達し、かつ commit があるときは
      worker は `completed`・verification は `fail` として**別々に**記録する。
4. **Wave barrier** — Wave の **全 worker が `completed`（commit 検出）** でなければ次へ進まない。
5. **verification gate** — `completed` の worker それぞれの裁定を集約する。契約経路では監督ループで
   得た exit code 由来の verdict をそのまま使い、**同じ worktree を弱い judge で測り直さない**。
   フォールバックでは **worktree 内で profile baseline を再実行**する（第2.1節。実行するのは
   `completed` の worker だけ — 失敗した worker には測る成果物が無い）。pass が揃ってはじめて
   次 Wave を dispatch できる。worker completion だけでは gate は開かない。
   **裁定の記録は wave の成否と独立**である（第2.1.1節）: この gate が閉じても、既に得られている
   verdict は report に残る。

`advanced` が true になるのは `all_workers_completed` かつ `all_verifications_passed`
の両方が true のときだけである。停止時の `stop_reason` の優先順位は
`human_required` > **`verification_not_judged`（exit 99。`stop_reason` は `dispatch_error`）** >
**`worktree_unresolved`（`stop_reason` は `drift`）** >
`worker_failed` > `timeout` > `verification_failed` である
（`--max-turns` 到達の未 commit は `worker_failed` に含まれる）。99 を先に見るのは、それが
**再 dispatch では解けない**唯一の停止理由だからである。

`worktree_unresolved` を `worker_failed` より先に見るのは、両者が同じ `worker_state: 'failed'` を
使いながら**正反対の所見**だからである（#90）。`worker_failed` は「worker は動いたが完遂しなかった」
（worker ログを読む・Issue を分割する）であり、`worktree_unresolved` は「送る先が無いので worker を
1人も起動していない」（worktree を作る）である。pre-flight（第3.0節）を通過した後にこれが起きるのは、
`git worktree list` にはあるが CommandMate に登録されていない worktree、または実行中に消えた
worktree の場合である。この停止は既に dispatch した Wave があるので `partial` であり、
`worker_state: 'failed'` と note（`worktree unresolved: …`）は従来どおり記録する。

## 4. security（path escape / redaction）

- worktree target は、絶対 path（先頭 `/`、Windows drive）・backslash・制御文字・
  先頭以外の `..`（1つの先頭 `../` 以外の上位 escape）を **拒否** する。拒否した Issue は
  dispatch せず `limitations`（`unsafe_worktree_target`）に記録する。
- token・secret・絶対 path・raw terminal 全量を report/artifact に残さない。
  worker note・prompt excerpt・verify note は redaction 済みの短い抜粋のみとし、
  除去した値は `redactions` に kind と count だけで記録する（値・長さ・伏字は残さない）。

## 5. status / stop_reason / exit

| status | 条件 | exit |
|---|---|---|
| `success` | 全 Wave dispatch、全 worker completed、全 verification pass、prompt なし | 0 |
| `partial` | 途中停止（worker 失敗・timeout・verification 失敗・prompt・drift） | 7 |
| `failure` | 1件も dispatch できない（plan 不正・最初の Wave 前 drift（worktree 未解決を含む）・CLI 不在・`--contract-mode require` で契約非対応） | 1 |

失敗時も stdout に `status: failure` の report を出す。実行結果を推測で埋めない。
pre-flight（第3.0節）で停止した failure は artifact を書かないので `out_dir` は `null` である
（「何も書いていない」の意。`--out` はまだ空いている）。

`stop_reason` は `blocking_reasons` の code と組で読む。同じ `stop_reason` が複数の停止を含む。

| stop_reason | code | 意味 |
|---|---|---|
| `dispatch_error` | `open_questions` | plan の Issue に未回答の planner question があり、`--allow-questions` も無かった |
| `dispatch_error` | `contract_unsupported` | CLI に実行契約が無く、`--contract-mode require` がフォールバックを拒否した |
| `dispatch_error` | `verification_not_judged` | 検証が exit 99（run が error/cancelled）で、どのゲートも判定に到達しなかった |
| `dispatch_error` | `not_dispatched` | runner が起動を拒否した（scope 未宣言・unsafe worktree target 等） |
| `dispatch_error` | `wave_not_advanced` | 上のどれでもない理由で Wave が advance しなかった（防御的な既定） |
| `drift` | `worktree_unresolved` | 対象 Issue の worktree が解決できない。**未解決 Issue ごとに1件**出る（第3.1節） |
| `drift` | `drift_<check>` | それ以外の blocking drift（`drift_cli_available`・`drift_repo_access`・`drift_base_resolvable`・`drift_branch_matches`） |
| `human_required` | `human_input_required` | worker が prompt を出した（自動応答していない） |
| `worker_failed` | `worker_failed` | worker が起動したが `--max-turns` までに commit しなかった |
| `timeout` | `worker_timeout` | `commandmate wait` が timeout した |
| `verification_failed` | `verification_failed` | completed した worker の裁定が pass でない |

## 6. completion_check（report）

report は6つの check を自己申告する（0.15.x 以前は `verification_recorded` を除く5件）。

| id | 内容 |
|---|---|
| `plan_approved` | 承認済み plan を読み・検証した |
| `drift_reconfirmed` | mutation 前に drift を再確認した |
| `parallelism_bounded` | どの Wave も max_parallel を超えて dispatch していない |
| `barrier_enforced` | 次 Wave は「全完了 かつ verification pass」でのみ dispatch した |
| `no_auto_prompt_response` | prompt を自動応答していない（`--auto-yes` 未使用） |
| `verification_recorded` | `completed` の worker はすべて、自分を判定した verdict を保持している（第2.1.1節） |

`passed` は全件 true、かつ status が `failure` でないときだけ true。

status を条件に入れているのがここでは効く（#90）: 1人も dispatch していない run では
`barrier_enforced` も `verification_recorded` も**空虚に true** になる（守るべき worker がいない）。
worktree 未解決が `failure` で停止するようになったことで、そのとき `passed` は false になる。
「何もしていない」を「全部 OK」と report させない。

## 7. version 運用

判定基準は uat 契約と同じく「**既に世に出た report が、新しい schema でも引き続き適合するか**」である。

- **適合しなくなる変更** → `dispatch_schema_version` を上げる。required field の追加、field の削除、
  既存 field の**意味の変更**、既存 enum 値の削除・改名、範囲の縮小。
- **適合し続ける変更（additive）** → `dispatch_schema_version` は据え置き、Skill の `version` を上げ、
  何を足したかを schema の `description` に書く。optional field の追加、既存 enum への**値の追加**、
  範囲の緩和（`maxItems` を増やす等）。
- 文言・見出しの調整のみ → Skill の `version` だけを上げる。

据え置きを選べること自体が重要である: merge runner と uat runner は dispatch report から
`worker_state === 'completed'` と `verification.outcome === 'pass'` の 2 field しか読まないので、
version を上げると**その2つが変わっていないのに**両 runner が読めなくなる。

0.16.0（[#83](https://github.com/Kewton/commandmate-skills/issues/83)）はこの additive 側で行った:
`completion_check.checks` の enum に `verification_recorded` を追加し `maxItems` を 5 → 6 に緩和
（`minItems` は 5 のまま）、`verification` / `gates` / `outcome` の `description` を実挙動に合わせた。
0.15.x が書いた report は無改変で v1 に適合し続ける。**新しい runner が書く report を旧 runner の
schema で検証すると落ちる**（schema は package と一緒に動く）ため、report の読み手は同梱 schema を使うこと。
