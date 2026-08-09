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
| `--out <dir>` | 任意 | `<plan-dir>/dispatch` | dispatch artifact の出力先。既存なら `out_exists` で拒否。**blocking pre-flight（第3節）で停止した場合は作らない**ので、原因を直して同じコマンドを再実行できる。`--resume` とは排他（両方渡すと `invalid_input`） |
| `--resume <dir>` | 任意 | なし | 部分失敗した run の再開。`<dir>` は再開対象の `--out` ディレクトリ。その**最新 attempt の report** を読み、completed かつ verification pass の Issue を再 dispatch せずに記録だけ引き継ぐ（第8節）。artifact は `<dir>/resume-attempt-<n>/` に append し、既存を上書きしない |
| `--reverify <dir>` | 任意 | なし | **`send` を1回も呼ばずに**裁定だけ取り直す（第8.5節）。`<dir>` は対象 run の `--out` ディレクトリ。引き継ぎ規則は `--resume` と同一で、それ以外のうち **worktree に作業証跡（work ブランチの commit / 未 commit の変更）が在るもの**だけを verification gate にかけ直す。artifact の配置と整合性ガードは `--resume` と同一。`--out` / `--resume` とは排他（`invalid_input`） |
| `--cli <launcher>` | 任意 | `$CM` → `commandmate` | 実行する public CommandMate ランチャー（第 2.8 節） |
| `--git <path>` | 任意 | `git` | drift 確認に使う git |
| `--gh <path>` | 任意 | `gh` | repo 到達性確認に使う gh |
| `--auto-yes` | 任意 | off | worker prompt を自動応答する。既定 off（prompt で停止し human へ提示） |
| `--unattended` | 任意 | **off** | **この invocation に人間が居ないことの宣言**（第3.0.3節）。mutation の権限は1つも足さず、**`--approve` を含意しない**。含意するのは締め付けだけ: `--contract-mode require` / pre-flight の scope 検査（all-or-nothing・`--out` 未消費）/ worktree 単位の排他 lock / `--wall-clock-budget` の明示必須 / `unattended_baseline` の記録。緩和フラグ（`--auto-yes` / `--allow-questions` / `--contract-mode off｜auto`）との併用は `invalid_input`（exit 3）で拒否する |
| `--wall-clock-budget <sec>` | 任意（`--unattended` では**必須**）| なし（off） | run 全体の壁時計上限（第3.0.4節）。**残り budget は run が起動する子プロセスすべての timeout でもある**（profile baseline と acceptance コマンドは自前の timeout を持たない）。到達は `partial` / `stop_reason: timeout` であって成功ではない |
| `--prepare-worktrees` | 任意 | **off** | pre-flight で未解決だった worktree を `cmate-worktree-setup` provider に作らせてから dispatch する（第3.0.1節）。既定 off＝従来どおり停止する |
| `--worktree-setup <launcher>` | 任意（`--prepare-worktrees` 指定時は実質必須） | なし | 上記 provider のランチャー（`--cli` と同じ argv 規約・同じ guard。シェルは経由しない）。`--prepare-worktrees` 無しに渡すと `invalid_input` |
| `--worker-method <skill-id>` | 任意 | **なし（off）** | worker が従うべき開発スキルの id（例 `cmate-worker-development`）。指定すると、dispatch 対象 worktree に**その skill が install されていることを実測**してから dispatch し、契約 goal と worker prompt の**両方**に `## Method` 節を1つ足す（第3.0.2節）。**指定しない run は、この flag が存在しなかった頃と byte 一致する。** id は `^[a-z0-9][a-z0-9-]{0,63}$`（path に展開されるので、それ以外は `invalid_input`） |
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
と読ませない。**`--unattended` ではこれが blocking になる**（段階 C。第3.0.3節）——
裁定（exit code）は pass のままだが、根拠を名指しできない pass の上に無人 merge を積まない。

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

`verification.gates[]` には optional field **`origin`**（`repo` / `issue`）が載る。
`issue` はその Issue の ```acceptance-gates ブロックが `require:` で名指しした id、`repo` は
repo 共通ゲート（verify.yaml に在るが `require` されていないものを含む）である。
[#97](https://github.com/Kewton/commandmate-skills/issues/97) の PR 証跡が
「10 個のゲートが緑」ではなく「そのうち何個がこの Issue のために走ったか」を書けるようにするためで、
`dispatch_schema_version` は **1 のまま**である（optional field の追加は additive。第7節）。

**欠落を `repo` と読んではならない。** 欠落は「由来が記録されていない」であり、
`not_run` を pass にも fail にも丸めないのと同じ理由で既定値に丸めない。欠落するのは
この field より古い runner が書いた report と、フォールバック経路（第 2.1.1 (b)）である。
実測: `commandmate wait --verify` の `GATE <id> PASS|FAIL (<detail>)` 行に由来は含まれないので、
`origin` は読み取るものではなく **runner が「自分が契約に運んだ id か」から決める**
（ADR 第 11.4 節）。`--resume` が裁定を引き継ぐときは、記録されていた `origin` だけを転記し、
無いものを補わない。

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

### 2.3.1 収束しない scope 再指示は遮断する（`scope_unsatisfiable`）

scope ゲートの再指示文は違反 path を転記し、「不可避なら worker 側では解決できない」とまで書いて
いる。それでも **ターン数しか見ない監督ループは同じ再指示を送り続ける**ので、worker は
「テストを消す＝受入条件を落とす」ジレンマに置かれ、同じ結論を上限まで繰り返す（実測:
Kewton/BorderFreeKidsMap #35 は `--max-turns` 到達まで回って worker 1人分の run を失った）。

「その変更が不可避か」は一般には判定できないが、**収束しているか**は判定できる。runner は
scope ゲート失敗の**違反 path 集合**（再指示文の組み立てで既に取れているもの。重複除去＋ソートで
順序非依存）を前ターンと比べ、**同一なら再送せずに停止する**。

```
turn N   : scope 違反 = {A, B}  → 再指示
turn N+1 : scope 違反 = {A, B}  → 同一。停止（turn N+2 は送らない）
```

- **違反が1つでも減っていれば従来どおり再指示を続ける。** 遮断するのは「同じ答えの繰り返し」だけで
  ある。scope 以外のゲート（lint 等）の反復では遮断しない —— それは worktree の中で直せるので、
  もう1ターンが本当に効く
- 比較は **連続する2ターン**でのみ行う。あいだに別の結果（exit 0 / 21）が挟まれば比較はリセットする
- 違反 path を読み取れなかったターンは比較対象にしない（「2回とも読めなかった」は「同じ path だ」の
  証拠ではない）
- **`--max-turns` 到達の判定が先**である。上限に達した run は従来どおりの note で終わる
- 停止の表現は**既存の裁定不合格の経路そのまま**である。`stop_reason` に値を足さず、
  `blocking_reasons` に **`scope_unsatisfiable`** を1件積んで名指しする（`stop_reason` は
  commit があれば `verification_failed`、無ければ `worker_failed`）
- **`verification.outcome` は書き換えない。** それは CommandMate の exit code であり（第2.1.1節と
  同じ扱い）、変わるのは run が先へ進むかだけである
- `blocking_reasons[].detail` に**違反 path をそのまま**残す。これは Issue の対象ファイルに足すべき
  規約そのものであり、**運用者が次に何を宣言すればよいかが report から読める**必要がある。
  summary の next action は「worker では直せない。Issue の対象ファイルに足して re-plan する
  （owner: human）」である（`verification 失敗の worktree を診断` の行は出さない —— 同じ plan の
  再 dispatch は同じ所で止まる）

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
- `verify.gates` は `--verify-gates` を指定したときだけ書く。キーの省略は
  「全ゲートを走らせる」であり、緩い側ではなく厳しい側の既定である。
  **Issue が `acceptance_gates.require` を宣言していても、それだけではこのキーは書かれない** —
  詳しくは第 2.9 節。
- Issue が受入ゲートを宣言している場合、`goal` に `## Acceptance gates this issue declared` 節が
  1つ足される。宣言が無い Issue の `goal` は **byte 単位で従来どおり**である。
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

**`--unattended` は `require` を含意する**（第3.0.3節）。理由は「厳しいほうが良い」ではない ——
フォールバック経路には `success.requireScopeClean` が**存在しない**（契約が無いのだから scope ゲート
という概念自体が無い）ので、**scope.allow を必須にすることは契約経路を必須にすることと同義**であり、
片方だけでは空文になる。`auto` の既定は「契約が無ければ弱い裁定に落ちて続行し、人間が summary 冒頭で
それを読む」という劣化であり、無人ではその読み手が居ない。したがって `--unattended` と
`--contract-mode off｜auto` の併用は黙って上書きせず `invalid_input` で拒否する（`require` を明示的に
書き添えるのは矛盾ではないので受理する）。

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

### 2.9 受入ゲートの解決（Issue が名指ししたゲート）

**記法の正本は [acceptance-gates-notation.md](./acceptance-gates-notation.md)**、裁定の記録は
[adr-issue-acceptance-gates.md](./adr-issue-acceptance-gates.md) である。ここは dispatch 側の規約だけを書く。

planner は `plan.issues[].acceptance_gates.require` を**構文だけ**見て載せる。id が実在するかは
worktree を持つ dispatch にしか判断できない。dispatch は `commandmate ls` で解決した実 path の
`<worktree>/.commandmate/verify.yaml` を読み、**`send` する前に**突き合わせる。

- **解決可能な id** = `work-evidence` + `scope` + verify.yaml が宣言した全 gate id。
  これは CommandMate 自身が契約の `verify.gates` を検証するときの集合と同一である
  （built-in の `env-clean` は**この集合に入らない**）。
- verify.yaml の読み取りは **fail-closed** である。ファイルが無い・読めない・YAML subset で
  読めない場合、`require` を宣言した Issue は dispatch しない。部分的に読めた id 集合で
  「実在しない」と判断すると、理由の違う停止が同じ顔をしてしまう。
  **このファイルは `require` を宣言した Issue のためにしか読まれない**ので、subset で読めない
  verify.yaml を持つリポジトリでも他の挙動は一切変わらない。

#### `verify.gates` の書き出し — 絞り込みを禁ずる

`verify` キーの省略は「全ゲートを走らせる」、明示は「そのゲートだけを走らせる」である。
したがって `require: [adr-present]` を素朴に `verify.gates: [adr-present]` と書き出すと、
lint も test も走らない契約になる。**受入条件を足したつもりで、判定が弱くなる。**

| operator の `--verify-gates` | Issue の `require:` | 契約の `verify` |
|---|---|---|
| 無し | 無し | **キーを書かない**（＝全ゲート） |
| 無し | 有り | **キーを書かない**。全ゲートに `require` の id は必ず含まれる（実在確認済み） |
| 有り | 無し | operator の列挙を、operator の順序のまま |
| 有り | 有り | **和集合**（sort + 重複除去） |

#### 停止する条件（いずれも `send` の前）

| limitation | 条件 | 読み方 |
|---|---|---|
| `acceptance_gate_id_unknown` | `require` の id が worktree の verify.yaml に無い / ファイルを読めない | limitation が**実在する id を列挙する**ので、綴り違いなら diff がそのまま出る |
| `acceptance_gates_not_enforceable` | 実行契約の無い run（`--contract-mode off`、契約非対応 CLI）で `require` が宣言されている | 裁定は profile baseline の再実行になり、gate id を伝える口が無い。ここで dispatch すると **Issue が書いた条件を一度も測っていない緑**ができる |
| `acceptance_gate_block_invalid` | plan の `acceptance_gates` 自体が壊れている（手編集された plan）、または和集合が 32 件を超える | planner は構文の通ったブロックからしかこの field を書かないので、前者は plan が手で編集された証拠である |

いずれも `send --contract` の exit 2 に頼らない。理由は `contract_scope_unknown` と同じで、
走っていない worker を「契約が不正だった」と報告するより、**何が足りないかを名指しして止める**
ほうが解ける。当該 worker は `not_dispatched` のまま残り、wave は advance しない。

### 2.10 `--auto-yes` が動かす2つのもの（#136）

**契約のポリシーと worktree の auto-yes 状態は別物である。`--auto-yes` は両方を動かす。**
片方だけでは prompt は1つも自動応答されない。

| | 何か | どこで設定されるか | `capture --json` に出るか |
|---|---|---|---|
| 契約の `autoYes` | **その task に許す prompt 型の宣言** | 契約 yaml（この runner が書く） | 出ない |
| worktree の auto-yes 状態 | サーバーが poller を回すかどうか | `send --auto-yes`（この runner が渡す） | **出る**（`autoYes.enabled`） |

#### 契約に何を書くか

- `--auto-yes` **無し** → `mode: off`（積極的な禁止）
- `--auto-yes` **有り** → `mode: allow-listed` ＋ `allowPromptTypes: [yes_no, multiple_choice]`

**`mode: safe` は書かない。** CommandMate の resolver は `safe` のとき `yes_no` 以外を
`type-not-allowed` で抑止するが、**Claude の許可プロンプト（`Do you want to make this edit to X?`）は
`multiple_choice`** なので必ず弾かれる。`--auto-yes` を指定した run が Claude で1つも応答しない、
という状態がこれだった。

**autoYes ブロックを書かない案（`mode: null`＝制約なし）も採らない。** この runner が `mode: off` を
書くのは「積極的な禁止」と「省略」が別物だからであり、**許可についても同じ理屈が当てはまる** ——
省略すると run の authorisation が読めなくなる。`denyPatterns` は空のままにする
（CommandMate #1699: pane の scrollback に照合されて過去の承認が以後を恒久抑止した実害がある）。

#### なぜ `send` にも渡すのか

サーバーの Auto-Yes poller は **worktree の auto-yes 状態が有効でなければ起動しない**。
起動しなければ、契約が何を許可していても応答は起きず、**抑止された事実すら記録されない**
（`autoYes.lastSuppression` は poller の中でしか書かれない）。`--duration` は
`--wait-timeout` × `--max-turns` × wave 数から算出する（既定 1h では run の途中で失効しうる）。

> **`enabled: true` だけを見て「効いている」と判断しないこと。** 契約が型を許していなければ、
> トグルが on でも1つも応答されない。判定しているのは契約のポリシーである。

## 3. 監督ループと gate

### 3.0 blocking pre-flight（`--out` を消費する前）

**plan の検証と、最初の Wave の drift 再確認と、`--worker-method` の install 実測は、
出力ディレクトリを作る前に行う**
（[#90](https://github.com/Kewton/commandmate-skills/issues/90) /
[#128](https://github.com/Kewton/commandmate-skills/issues/128)）。ここで停止した場合:

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

**`--resume` の場合、pre-flight が見るのは「最初の Wave」ではなく「この attempt が実際に
dispatch する最初の Wave」であり、その Wave のうち引き継がなかった Issue だけである**（第8節）。
引き継いだ Issue の worktree は解決を要求しない: branch が merge 済みで worktree が片付いていても
正常であり、そこで `worktree_unresolved` を出すのは「触る予定の無いもの」を理由に run を拒否する
ことになる。再実行対象が1件も無ければ pre-flight は**まったく走らない**（mutation が無いので
守るべき mutation も無い）。停止したときに `<dir>/resume-attempt-<n>/` を作らないのは同じで、
やはり同じコマンドを再実行できる。

pre-flight の blocking 判定は2種類あり、`stop_reason` が違う。

| 判定 | blocking reason | `stop_reason` |
|---|---|---|
| drift（branch / HEAD / 権限 / worktree 解決） | `drift_<check>` / `worktree_unresolved` | `drift` |
| 条件付き依存の Skill が呼べない（`--prepare-worktrees` / `--worker-method`） | `worktree_setup_unavailable` 等 / `worker_method_unavailable` | `dispatch_error` |
| 無人運転の宣言と plan が食い違う（`--unattended`。第3.0.3節） | `unattended_locked` / `contract_scope_unknown` / `open_questions` | `dispatch_error` |

**`--unattended` の3つは世界を probe する前**（`commandmate ls` の前）に判定する。lock は
mutation の窓そのものを閉じるものなので pre-flight より前に取り、scope と open question は
plan だけで決まるので世界を見る必要がない —— 答えが何も変えられない probe は副作用でしかない、
という上の規律をそのまま適用したものである。

**どちらも `stop_reason` の enum に値を足していない。** 後者は drift ではない
（branch も base も権限も動いていない）が、`dispatch_error` が schema に既に持っている
「dispatch 前の停止」の形にそのまま収まり、対処も同型（**依存を install して同じコマンドを
再実行する**）だからである。

### 3.0.1 worktree 準備段（`--prepare-worktrees`。既定 off）

pre-flight が `worktree_unresolved` で止まるとき、**その理由だけで止まっている場合に限り**、
worktree を用意してから続ける段を挟める（[#93](https://github.com/Kewton/commandmate-skills/issues/93)。
裁定の記録は [adr-worktree-preparation.md](./adr-worktree-preparation.md)）。

**dispatch は worktree を作らない。** collision 検査・作成直前の base SHA 再確認・
proportional baseline は [cmate-worktree-setup](../../cmate-worktree-setup/) の責務であり、
この runner はそれを**合成する**だけである（`git worktree add` 相当をこの runner が呼ぶことは無い）。

手順は次のとおりで、`--prepare-worktrees` が無ければ**1つも実行されない**（provider も呼ばない）。

1. **対象を決める** — pre-flight が未解決とした Issue（＝**最初の Wave** の Issue）だけ。
   2つ目以降の Wave の worktree はこの段の対象外で、従来どおり当該 Wave で止まる。
2. **provider を1回呼ぶ** — `<launcher> --issues <n[,n...]> --profile <plan の profile id> --base <plan の base>`。
   Issue 集合・profile・base は **plan が正本**であり、`--worktree-setup` の argv に
   `--profile` / `--profile-json` / `--base` / `--repo` / `--issues` / `--issue-numbers` が
   含まれていれば `invalid_input` で拒否する（二重指定の禁止）。
3. **result を検証する** — stdout が
   [`worktree-setup.result.v1`](../../cmate-worktree-setup/schemas/worktree-setup.result.v1.json)
   であること。**exit code は文書が読めなかったときだけ見る**（作成済みで baseline が落ちた
   `partial` を「何もしていない」に丸めないため）。
4. **profile の同一性を branch で照合する** — `worktrees[].branch` が plan の当該 Issue の
   `branch` と一致しない場合は `worktree_profile_mismatch` で停止する。**`branch_template` の
   文字列では照合しない**（placeholder の綴りは2つの Skill で標準化されていないため、
   同じ branch を作る template を不一致と誤判定する）。
5. **registry を再スキャンする** — `commandmate sync` を**強制的にもう1度**実行する。
   run 中の1回目の sync は worktree が存在する前に走っているので、その答えは新しい worktree に
   ついて何も言っていない。この2回目は `worktree_sync_rescanned` に記録する。
6. **pre-flight をやり直す** — 判定は同じ check が行う。解決しなかった Issue が残れば、
   第3.0節の停止（`worktree_unresolved`・`--out` 未作成）にそのまま落ちる。

| 状況 | 扱い |
|---|---|
| provider が渡されていない / 起動できない | `blocking_reasons` の `worktree_setup_unavailable` で停止。**`limitations` に落として続行しない**（準備できなければ dispatch 対象が存在しないので、劣化して続行する意味が無い） |
| provider の出力が result contract でない / 1件も作られなかった | `worktree_setup_failed` で停止 |
| branch が plan と一致しない | `worktree_profile_mismatch` で停止（Issue ごとに1件） |
| 一部だけ作れた | **成功分だけを dispatch しない。** 作れた分は `worktree_prepared`、作れなかった分は `worktree_setup_partial` に記録し、未解決 Issue について第3.0節の停止に落ちる |
| 失敗しても、作ってしまった worktree | **削除しない。** 後始末の owner は human で、手段は [cmate-worktree-cleanup](../../cmate-worktree-cleanup/) である |

証跡は `dispatch_schema_version` を上げずに運ぶ（field を足さない。第7節）:
`limitations` の `worktree_setup_ran` / `worktree_prepared`（Issue・branch・base SHA・baseline 合否）/
`worktree_setup_partial` / `worktree_setup_skipped`、`summary_markdown` の「worktree 準備」節、
そして run が進んだ場合のみ `<out>/worktree-setup/prepared.json`（redaction 済みの転記）。

### 3.0.2 ワーカー側方法論の実測（`--worker-method`。既定 off）

`--worker-method <skill-id>` を渡すと、dispatch は **contract を書く前に**、その Wave が
dispatch する各 worktree に当該 Skill が在ることを実測する（[#128](https://github.com/Kewton/commandmate-skills/issues/128)。
裁定の記録は [adr-worker-development-skill.md](./adr-worker-development-skill.md)）。

**判定条件は「両 root に `SKILL.md` が在ること」である。**

```
<worktree>/.claude/skills/<skill-id>/SKILL.md      # Claude が読む
<worktree>/.agents/skills/<skill-id>/SKILL.md      # Codex が読む
```

CommandMate は `skill install` でこの両方へ byte-identical に配備する。両方を要求するのは
慎重さではなく**測定可能性**の問題である: この runner は `send --agent` を一度も渡さず、
worktree を解決する `ls --json` の row も id / branch / path しか持たないので、
**どの Agent がそのタスクを取るかを知らない**。片側だけを「入っている」と読むと、
worker が構造的に開けない file を「これを読め」と契約に書くことになり、それは dispatch が
測れない主張になる（ADR 第3.5節）。片側だけ在る場合はその事実を detail に書く
（「無い」と「半分ある」は operator にとって別の情報である）。

- **probe の対象は `commandmate ls` が返した worktree path 配下**である（リポジトリ root ではない）。
  これは `.commandmate/verify.yaml` を読むのと同じ base であり、Skill の install が
  worktree 単位であることの帰結である。手で両 root に配置した（receipt の付かない）package も
  同じ path に在るので、同じように読める。
- **version は記録しない。** `commandmate.skill.yaml` は block scalar と入れ子リストを使う
  YAML であり、この runner が持つ唯一の YAML reader（`.commandmate/verify.yaml` 用の閉じた
  subset parser）はその先頭 key で拒否する。読めないものを推測で埋めない。
- **all-or-nothing である。** install 済みの worker だけ方法論つきで走らせない
  （方法が worker ごとに違う wave では「全部通った」の意味が run ごとに変わる）。
- 最初の Wave は **`--out` を作る前**の pre-flight で判定するので `--out` を消費しない。
  2つ目以降の Wave は、従来どおり**その Wave の解決時**に同じ code で止まる
  （その時点では `--out` は既に在るので、`status: partial` になる）。

在れば、`## Objective` の**直前**に `## Method` 節を1つ足す。**契約 goal
（`buildContractGoal`）と worker prompt（`buildWorkerPrompt`）の両方に、同じ位置に**足す
——片方だけだと `--contract-mode auto` が契約非対応 CLI に落ちたときに方法論だけが黙って消える
（第2.7節のフォールバック経路）。節が書くのは **どの Skill を読むか・どこに在るか・
方法論と契約が食い違ったら契約が勝つこと・無ければ止まれ** の4つだけで、
**方法論の要約は書かない**（書けば正本が2つになり、方法の更新が本 package の再リリースを要求する）。

| 状況 | 扱い |
|---|---|
| 両 root に在る | `## Method` 節を書いて dispatch。`limitations` に `worker_method_applied`（Issue ごとに1件） |
| 片方にしか無い / どちらにも無い | `blocking_reasons` の `worker_method_unavailable` で**停止**（Issue ごとに1件）。`stop_reason` は `dispatch_error`、status は failure（最初の Wave なら `--out` 未作成） |
| worktree がそもそも解決できない | `worker_method_unavailable` は出さない。`worktree_unresolved` が先で、対処が違う |
| flag を渡していない | **何も起きない。** probe せず、節も書かず、limitation も出さない |

証跡は `dispatch_schema_version` を上げずに運ぶ（field も enum 値も足さない。第7節）:
`limitations` の `worker_method_declared`（**run 全体で1件**。停止した run にも残る）と
`worker_method_applied`（**Issue ごとに1件**）、`blocking_reasons` の
`worker_method_unavailable`、そして `summary_markdown` の「方法論」節。

**dispatch が証明できるのは3つだけである** —— ①方法論つきで走ると宣言した
②その Skill が対象 worktree に在った ③参照が契約に書かれた。
**「worker が実際に方法論に従ったか」は測っていない。**「適用された」と「守られた」は
別の事実であり、report もその区別を明記する。

### 3.0.3 無人運転（`--unattended`。既定 off）

`--unattended` は **「この invocation に人間は居ない」という入力の宣言**である。
mutation の権限を与えるフラグではない（裁定の記録は
[adr-unattended-mode.md](./adr-unattended-mode.md) 第2節「裁定 0」、実測は同 第14節）。
段階 A で受け付けたのは **dispatch runner だけ**だった。段階 B
（[#134](https://github.com/Kewton/commandmate-skills/issues/134)）で **merge runner の
`--create-prs`** が、段階 C（[#142](https://github.com/Kewton/commandmate-skills/issues/142)）で
**merge `--merge-prs` と uat runner** が加わり、**3 runner すべてが受け付ける**
（[merge-contract.md](./merge-contract.md) 第5.3節 / [uat-contract.md](./uat-contract.md) 第5.2節）。
**フラグは runner ごとに独立の宣言であり、
runner 間で伝播しない**（同 ADR 第8節）: この runner が unattended だったかを merge / uat が
読むことはなく、merge / uat が dispatch report から読むのは従来どおり `worker_state` と
`verification.outcome` の2 field だけである。

不変条件は4つで、**どれも「緩めない」側にしか働かない**。

1. **ゲートを1つも無効化せず、blocking を limitation に格下げせず、status を1段も上げない。**
   停止理由・status・exit の写像（第5節）は1文字も変わらない。
2. **緩和フラグとの併用を拒否する。** `--auto-yes` / `--allow-questions` /
   `--contract-mode off｜auto` との併用は `invalid_input`（exit 3）である。**黙って上書きしない**
   —— 自己矛盾した2つの宣言のうち片方が黙って勝つと、report の読み手（無人運転では次の job）は
   どちらが勝ったかを判定できない。
3. **`--approve` を含意しない。** dispatch には外すべき承認フラグがそもそも無く、
   merge / uat を無人で回す CI は `--unattended` と `--approve` の**両方**を書く。
4. **runner は次の phase を始めない。** 無人運転の driver は CI の job 定義（または cron script）で
   あって runner ではない。

含意する締め付けは次の6つである。

| 締め付け | 内容 |
|---|---|
| 契約経路の必須化 | `--contract-mode require` を含意する（第2.7節） |
| 裁定の根拠の要求 | **`verification_gates_unrecorded` を limitation ではなく blocking として扱う**（段階 C。第2.1.1節 / ADR 第6.5節）。契約 pass なのに `GATE <id> PASS|FAIL` 行を1本も読めなかった Issue が1つでもあれば、その wave を最後に **次の wave を dispatch せずに停止**する（`partial` / exit 7 / `stop_reason: dispatch_error`）。**裁定そのものは書き換えない** —— exit code の pass はそのまま `verification.outcome: pass` で残り、barrier の `advanced` も true のままである。変わるのは「その run が先へ進むか」だけである。**`human_required` は false**（GATE 行を出す CommandMate で再実行すれば解ける） |
| pre-flight の scope 検査 | **plan の全 Wave の全 Issue**について、その Issue の実行契約が `scope.allow` を宣言できることを、**`--out` を作る前**に確かめる。1件でも空なら **1人も dispatch せず** `blocking_reasons` に `contract_scope_unknown` を Issue ごとに1件、`stop_reason: dispatch_error` / `status: failure`（exit 1）で停止する。判定は plan の `suspected_files` そのものではなく **契約が受理できるパターンが1つ以上残るか**（絶対 path・`..` 脱出・長すぎる pattern 等は契約の parser が拒否するので落とす）。同じ pre-flight で **未回答の planner question も同時に**報告する（`open_questions`。`--allow-questions` は拒否されるので、この停止を押し通す道は無い）。**この停止も `--out` を消費しない** |
| 排他 lock | 下記 |
| wall-clock budget | `--wall-clock-budget` の明示が必須（第3.0.4節） |
| 取り消しの起点 | dispatch する worktree ごとに、**最初の send の前**の HEAD を `limitations` の `unattended_baseline`（Issue ごとに1件）に **branch 名と短縮 SHA**で記録する。**絶対 path は書かない** —— worktree が既に片付いていると `git reset --hard` は exit 128 で使えず、`git branch -f <branch> <sha>` だけが残るからで、それに要るのは path ではなく branch 名である（[#115](https://github.com/Kewton/commandmate-skills/issues/115) の実測。ADR 第14.4節）。**baseline が担保するのは worktree branch の1段だけ**で、効かない4条件は [../SKILL.md](../SKILL.md) 第5節にある |

宣言そのものは `limitations` の **`unattended_mode`（run 全体で1件）** に載る。停止した run にも
残す（何を前提にした run だったかが report 単体で読めるように）。**`dispatch_schema_version` は
1 のまま、field も enum 値も足していない。**

#### 排他（worktree 単位の lock）

`--out` は mutex にならない。[#115](https://github.com/Kewton/commandmate-skills/issues/115) は、
700 ms ずらして起動した2本の run が**どちらも pre-flight を通り、どちらも
`--prepare-worktrees` の provider を呼び、同じ worktree に交互に `send` する**状態を実測した
（ADR 第14.1節）。`out_exists` が効くのは「先行 run が既に `--out` を作り終えている」場合だけで、
**pre-flight 実行中・`--out` が run ごとに変わる cron・`--resume`** の3経路では成立しない。

したがって **runner が lock を持つ**（ADR 第14.1節の候補 A）。

- **粒度は worktree 単位。** 害は「同じ worktree に2人の supervisor」であって「同じ plan が2回」
  ではない（別の plan が同じ worktree を名指すことは起こりうる）。key は
  `(repository, branch)` から導く —— CommandMate が worktree id を導くのと同じ組で、
  `commandmate ls` を叩く**前**（＝ pre-flight の前）に決まる唯一の識別子である。
- **取るのは pre-flight の前**、対象は**この attempt が dispatch しうる Issue 全部**
  （`--resume` では引き継がない Issue だけ）。**all-or-nothing** で、1つでも取れなければ
  取った分を返して停止する。
- **原子性は `mkdirSync`（`recursive` 無し）の EEXIST に依る。** read してから write する窓
  （TOCTOU）を作らない。所有者情報（host / pid / plan run_id）は lock を取った**あと**に書く。
- **`--out` を lock に流用しない。** [#90](https://github.com/Kewton/commandmate-skills/issues/90) が
  「pre-flight で止まった run は `--out` を消費しない」と決めており、流用はその決定を壊す。
- 置き場所は `$CMATE_ORCHESTRATE_LOCK_DIR`、未設定なら `$TMPDIR/cmate-orchestrate-locks/<key>`。
  **run ごとに違う値を指すと排他は効かない**（job 定義で per-job の一時ディレクトリを指さないこと）。
- 拒否は `blocking_reasons` の **`unattended_locked`**、`stop_reason: dispatch_error` /
  `status: failure`（exit 1）、**`--out` は未作成**。**`human_required` は false** である ——
  人間の判断を要する停止ではなく、先行 run の終了を待てば同じコマンドで解ける停止だからで、
  CI が読むべき signal もそれである。

**stale lock（`kill -9` された run）の回収規則**（4つ。これを決めないと、回収できない lock は
lock が無いより悪い）:

| lock の所有者情報 | 判定 |
|---|---|
| **この host の生きた pid** | 保持中。**拒否する** |
| **この host の死んだ pid** | **stale。回収して取り直す**（`kill -9` は release を走らせないので、この経路が既定の回収路である） |
| **別 host** | **拒否する。** 別の機械の pid の生死をこのプロセスは判定できない |
| **読めない / 壊れている** | 猶予（60 秒）を過ぎていれば回収、過ぎていなければ拒否。`mkdirSync` と所有者情報の書き込みの間はマイクロ秒なので、**新しい**読めない lock は「今まさに起動中の run」である |

回収の取り直しは**1回だけ**試みる（負けたら拒否する。ここでループすると、避けたはずの
TOCTOU を自分で作ることになる）。**拒否は常に安全側の誤りである** —— 代償は再実行1回だが、
生きた lock を誤って回収する代償は「1つの worktree に2人の supervisor」そのものである。

**塞げていない穴を明示する:** lock を取るのは `--unattended` の run だけである。
`--unattended` を渡さない run は**この機能が存在しなかった頃と 1 bit も変わらない**（第7節の
互換規律）ため、**人間がローカルで叩いた素の run と cron の衝突は runner 側では防げない**。
その組み合わせを閉じたい運用は job 定義側（`flock`・GitHub Actions の `concurrency:`）を併せて使う。
サーバ側（CommandMate が live な task を持つ worktree への2本目の `send` を拒否する）は
上流の変更であり、本リポジトリでは決められない。

### 3.0.4 wall-clock budget（`--wall-clock-budget`。既定 off）

**回数は既に有界だが、時計は有界でない。** `--max-turns` は worker 1人あたりのターン数を、
`--max-attempts`（uat）は修正回数を縛るが、[#115](https://github.com/Kewton/commandmate-skills/issues/115)
は**時計の上限が構造的に存在しない経路**を実測した（ADR 第14.2節）: profile baseline と
acceptance コマンドは `execFileSync` に `timeout` を渡さずに実行されるので、
`baseline: ["sleep 6"]` の profile は `--wait-timeout 1 --max-turns 1` でも 12.9 秒かかる。
**`--wait-timeout` はこの時間に一切効かない。**

したがって budget は**2箇所で同じ1つの規則として**効く。

1. **残り budget は、この run が起動する子プロセスすべての timeout である。**
   呼び出し側が自分で `timeout` を決めている子はそのままにする（この規則が縛るのは
   「上限を持たない子」であって、意図して選ばれた上限を伸ばすものではない）。
2. **判定点は Wave の開始前と、各 worker のターン境界（`wait` の前後）**である。
   `wait` の後にも見るのは、budget 自身の timeout で殺された `wait` を
   「worker の失敗」と読み替えないためである（時計を止めたのは runner であって worker ではない）。

到達したときの扱い:

| 項目 | 値 |
|---|---|
| status | **`partial`（exit 7）**。第5節の写像を変えない。「途中停止。成功ではない」がそのまま当てはまる |
| stop_reason | **`timeout`（既存 enum の再利用）。新しい値を足さない** —— 新値は `dispatch_schema_version` を上げる（第7節） |
| 名指し | `blocking_reasons` の **`wall_clock_budget_exhausted`** を1件 |
| 打ち切られた worker | `worker_state: timeout`、note に「budget を使い切った」旨。**mutation の記録は新機構を要さない** —— `unattended_baseline`（開始時 SHA）と `waves[].workers[].state` が「どこまで進んだか」を既に持っている |

`--unattended` で明示を必須にしているのは、**「何分まで機械に走らせてよいか」を誰かが決めた、
という事実**を残すためである。人間が居る運転では既定を黙認した人がその決定者になるが、
無人ではその瞬間が無く、**job 定義を書く時点でしか決められない**（uat の `--max-attempts` を
明示必須にしたのと同じ型。ADR 第5節）。

### 3.1 Wave ループ

各 Wave について、plan の順に次を行う。

0. **（`--resume` のときだけ）引き継ぎと再実行の切り分け** — その Wave の Issue を、前回 report で
   `worker_state: completed` かつ `verification.outcome: pass` だったもの（＝**引き継ぎ**。dispatch
   しない）と、それ以外（＝**再実行対象**）に分ける。引き継ぎ分の worker record はそのまま
   この Wave の `workers` に入り、`dispatched` には載らない。**再実行対象が 0 件の Wave は
   drift 再確認も worktree 解決も行わず、`dispatched: []` で barrier を満たして即座に advance する**
   （mutation が無い Wave に mutation 前の check は要らない）。詳細は第8節。

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
      - **exit 20** → 第2.3節で失敗ゲートを特定し、その内訳を引用して再指示する。ただし
        **scope ゲートの違反 path 集合が前ターンと同一**なら、そのループは収束しないので
        再送せずに停止する（第2.3.1節。`blocking_reasons` に `scope_unsatisfiable`）。
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
| `failure` | 1件も dispatch できない（plan 不正・最初の Wave 前 drift（worktree 未解決を含む）・CLI 不在・`--contract-mode require` で契約非対応・`--prepare-worktrees` の準備段が worktree を用意できなかった・`--unattended` の pre-flight 検査（scope 未宣言 / 未回答 question / 排他 lock）） | 1 |

失敗時も stdout に `status: failure` の report を出す。実行結果を推測で埋めない。
pre-flight（第3.0節）で停止した failure は artifact を書かないので `out_dir` は `null` である
（「何も書いていない」の意。`--out` はまだ空いている）。

`stop_reason` は `blocking_reasons` の code と組で読む。同じ `stop_reason` が複数の停止を含む。

| stop_reason | code | 意味 |
|---|---|---|
| `dispatch_error` | `open_questions` | plan の Issue に未回答の planner question があり、`--allow-questions` も無かった |
| `dispatch_error` | `contract_unsupported` | CLI に実行契約が無く、`--contract-mode require` がフォールバックを拒否した |
| `dispatch_error` | `verification_not_judged` | 検証が exit 99（run が error/cancelled）で、どのゲートも判定に到達しなかった |
| `dispatch_error` | `worktree_setup_unavailable` | `--prepare-worktrees` を指定したが `cmate-worktree-setup` provider を呼べなかった（未指定・未 install・起動不能）。第3.0.1節 |
| `dispatch_error` | `worktree_setup_failed` | provider は動いたが result contract を返さなかった、または1件も作らなかった |
| `dispatch_error` | `worktree_profile_mismatch` | provider が作った branch が plan の branch と違う（profile 不一致）。**未解決 Issue ごとに1件** |
| `dispatch_error` | `resume_plan_mismatch` | `--resume` 先の report が別 plan のもの（`run_id` / repository / base のいずれかが `--plan` と不一致）。第8節 |
| `dispatch_error` | `resume_invalid` | `--resume` 先の report が `dispatch-report.v1` として読めない（JSON 破損・schema version 不一致・必要 field 欠落）。第8節 |
| `dispatch_error` | `not_dispatched` | runner が起動を拒否した（scope 未宣言・unsafe worktree target 等） |
| `dispatch_error` | `wave_not_advanced` | 上のどれでもない理由で Wave が advance しなかった（防御的な既定） |
| `dispatch_error` | `open_questions` / `contract_scope_unknown` | **`--unattended` のとき**、pre-flight で plan 全体を検査して停止した（第3.0.3節）。`--out` は未作成、`human_required: true`（Issue 本文の編集と re-plan でしか解けない）。`--unattended` 無しの run では前者は従来どおり `--out` を作って停止し、後者は **limitation** のまま wave の中で当該 Issue だけを拒否する |
| `dispatch_error` | `unattended_locked` | **`--unattended` のとき**、同じ worktree を別の dispatch run が動かしている（第3.0.3節）。`--out` は未作成、**`human_required: false`**（先行 run の終了を待てば同じコマンドで解ける） |
| `timeout` | `wall_clock_budget_exhausted` | `--wall-clock-budget` に到達して打ち切った（第3.0.4節）。status は `partial`。**`stop_reason` の enum に値を足していない** |
| `drift` | `worktree_unresolved` | 対象 Issue の worktree が解決できない。**未解決 Issue ごとに1件**出る（第3.1節） |
| `drift` | `drift_<check>` | それ以外の blocking drift（`drift_cli_available`・`drift_repo_access`・`drift_base_resolvable`・`drift_branch_matches`） |
| `human_required` | `human_input_required` | worker が prompt を出した（自動応答していない） |
| `worker_failed` | `worker_failed` | worker が起動したが `--max-turns` までに commit しなかった |
| `timeout` | `worker_timeout` | `commandmate wait` が timeout した |
| `verification_failed` | `verification_failed` | completed した worker の裁定が pass でない |
| `verification_failed` / `worker_failed` | `scope_unsatisfiable` | scope ゲートの違反 path が2ターン連続で同一だったため、再指示ループを収束しないと判定して打ち切った（第2.3.1節）。**`stop_reason` の enum に値を足していない**（commit があれば `verification_failed`、無ければ `worker_failed`）。detail に違反 path が入る。対処は Issue の対象ファイルへの追加と re-plan（owner: human） |

## 6. completion_check（report）

report は6つの check を自己申告する（0.15.x 以前は `verification_recorded` を除く5件）。

| id | 内容 |
|---|---|
| `plan_approved` | 承認済み plan を読み・検証した |
| `drift_reconfirmed` | mutation 前に drift を再確認した。`--resume` で再実行対象が 0 件だった run では **mutation 自体が無い**ので、その事実を `detail` に書いたうえで true（守るべき mutation が無いことは、check を飛ばしたことではない） |
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

`--resume`（[#98](https://github.com/Kewton/commandmate-skills/issues/98)）は**schema をまったく
変えずに**入れた。`resumed_from` と attempt 番号は新しい top-level field ではなく、
`limitations` の `resume_attempt` エントリ・worker の `note`・`summary_markdown`・そして
report の外にある attempt 台帳（第8.3節）に載る。理由は #1588 のときと同じで、より強い:
dispatch report は**閉じた schema**（`additionalProperties: false`）であり、その読み手
（merge / uat / status）は version で固定されている。`worker_state` と `verification.outcome` の
2 field は何も変わっていないのに version を上げれば、変わっていない2 field を読むだけの3 runner が
黙って読めなくなる。run 固有の事実は `limitations` / `blocking_reasons` / `note` /
`summary_markdown` に載せる、という既存の裁定をそのまま適用した。

## 8. resume（部分失敗からの再開）と reverify（送らずに裁定だけ取り直す）

第8.1〜8.4節は `--resume` の規約である。`--reverify` は同じ分割・同じ artifact 配置・同じ整合性
ガードを使い、**引き継がなかった Issue に対して何をするか**だけが違う。その差分は第8.5節にある。


`--resume <前回の --out>` は、Wave 途中で一部の Issue だけが落ちた run を、**落ちた分だけ**
やり直す（[#98](https://github.com/Kewton/commandmate-skills/issues/98)）。並列開発では部分失敗が
常態であり、それに対して「plan から作り直す」しか手が無いというのは、verification gate が
通したはずの成果物にもう一度 worker を走らせるということである。gate の意味そのものを捨てている。

### 8.1 引き継ぎ規則

`--resume <dir>` は `<dir>` の**最新 attempt の report**（第8.2節）を読み、plan の各 Issue を
次のどちらかに分類する。

| 分類 | 条件 | この attempt での扱い |
|---|---|---|
| **引き継ぎ** | `worker_state === 'completed'` **かつ** `verification.outcome === 'pass'` | **dispatch しない。** 前回の verification 記録（`ran` / `report_schema_version` / `gates` / `checks`）を新 report に**転記**する。**再判定はしない** |
| **再実行** | それ以外（`failed` / `timeout` / `prompt` / `not_dispatched` / pass でない verdict / そもそも記録が無い） | 通常どおり dispatch する |

同じ Issue の record が複数の Wave にあるときは**最後のものを採る**（merge runner が
再 dispatch された Issue を読むときの規則と同じ）。

引き継ぎ条件が「completed かつ pass」の**2 field ちょうど**なのは偶然ではない: merge と uat が
eligible を決めるときに読むのがこの2つだけだからである。引き継ぎ判定をそれより緩くすると、
**merge が届けるのに dispatch が「まだ終わっていない」と言う**状態が生まれる。

引き継いだ worker record では:

- `worker_state` は `completed`、`verification.outcome` は `pass`（定義上そう）。
- `prompt` は `{ detected: false, excerpt: null }` に落とす。この attempt では prompt は出ていないし、
  prompt を出した worker は `completed` にならないので、引き継ぐべき prompt は存在しない。
- `note` に「attempt N から引き継いだ / この attempt は再 dispatch していない / この verdict は
  転記であって再実行ではない」を追記する。**note が構造化 field と食い違わない**という #83 の
  不変条件はここでも保たれる。
- `gates` / `checks` / `task_id` は read 時に再検証してから転記する。resume にとって前回 report は
  **入力**であり、手で編集されている可能性がある。新 report が schema 不適合になる record を
  書かせない。

### 8.2 Wave barrier の再計算

barrier は**再生**ではなく**再計算**する。引き継ぎ分は「完了かつ pass」として barrier に数える
ので:

- **その Wave の Issue が全部引き継ぎなら、1件も dispatch せずに advance する**
  （`dispatched: []` / `all_workers_completed: true` / `all_verifications_passed: true` /
  `advanced: true`）。drift 再確認も worktree 解決も行わない（mutation が無い）。
- したがって**依存元が pass 済みの Issue は、依存元の Wave を待たずにその attempt の最初の send で
  飛ぶ**。これが Issue 本文でいう「依存先は最初の Wave から dispatch してよい」である。
- **Wave の index は plan の index のまま**保つ（詰めない）。`drift_checks[].wave_index` と
  `waves[].index` が同じ番号を指し続けること、`waves` が「plan 順」という schema の記述どおりで
  あり続けることのほうが、番号が 1 から詰まって見えることより価値が高い。

停止条件・裁定規則は通常 dispatch と**完全に同一**である: exit 0 / 7 / 1、Auto-Yes 既定 off、
mutating Wave 前の drift 再確認、exit 99 の扱い、`--max-turns`。resume は「小さい Issue 集合に
対する同じ run」であって、緩い run ではない。

**再実行対象が 1 件も無い場合**（前回 report の全 Issue が completed かつ pass）は、CLI を
1回も呼ばずに `status: success` / `stop_reason: completed` / exit 0 で終わり、
`limitations` に `resume_no_work` を出す。「何もしなかった」と「全部やり切った」は同じ exit code に
なるので、**どちらだったかを report が明示する**。

### 8.3 artifact の配置（append-only）と、誰がどの report を読むか

既存 artifact は**上書きしない**。attempt 1 は今までと同じ場所のままで、attempt N（N≥2）は
1つ下のディレクトリに**同じファイル名で**書く。

```
<out>/
  dispatch-report.json            attempt 1（従来どおり。以後 1 byte も変わらない）
  dispatch-summary.md             attempt 1
  prompts/ contracts/ worktree-setup/
  attempt-history.jsonl           attempt 台帳（1 attempt 1行、append-only）
  resume-attempt-2/
    dispatch-report.json          attempt 2
    dispatch-summary.md           attempt 2
    prompts/ contracts/ worktree-setup/
  resume-attempt-3/ …
```

attempt 番号は「まだ存在しない `resume-attempt-<n>/`」の最小値として決める。台帳ではなく
**ディレクトリの実在**から決めるのは、台帳が欠けていても壊れていても既存 artifact を
上書きさせないためである。

report 側には `out_dir` にその attempt のディレクトリが入り、`limitations` に
`resume_attempt` が1件出る。ここに `resumed_from`（読んだ report の run 相対 path）と attempt
番号、引き継いだ Issue、再実行した Issue が入る（schema を変えない理由は第7節）。

`attempt-history.jsonl` の各行:

```json
{"attempt":2,"kind":"resume","plan_run_id":"plan",
 "resumed_from":{"attempt":1,"report":"dispatch-report.json"},
 "report":"resume-attempt-2/dispatch-report.json","summary":"resume-attempt-2/dispatch-summary.md",
 "status":"success","stop_reason":"completed","carried_over":[100,101],"dispatched":[102]}
```

path はすべて `<out>` からの相対である（絶対 path を artifact に残さない。第4節）。attempt 1 も
`kind: "initial"` / `resumed_from: null` で 1行書くので、履歴に暗黙の先頭行は無い。台帳の書き込みは
**best effort** である: 台帳は run についての証跡であって run の判断材料ではないので、書けなかった
ことで既に起きた dispatch を失敗にしない。

**誰がどの report を読むか。**

| 読み手 | 読むべき report |
|---|---|
| `merge.mjs --dispatch` / `uat.mjs --dispatch` | **最新 attempt の report**。台帳の最終行の `report`、または `resume-attempt-<最大 n>/dispatch-report.json`（無ければ `dispatch-report.json`） |
| `status.mjs --run` | 指定不要。run 配下を走査して**両方**を証跡として並べ、Issue 行には**後に見つかった artifact の record**を採る。`resume-attempt-<n>/` は `dispatch-report.json` より後に走査されるので、Issue 行は最新 attempt を指す |

**最新 attempt の report 1本で足りる**というのがこの配置の要点である: 引き継いだ Issue の
verification 記録はその report に転記されているので、merge / uat が複数の attempt を突き合わせる
必要は無い。逆に古い attempt を渡すと、そこで落ちていた Issue は eligible にならない（記録どおり）。

`status.mjs` は attempt をまたいで `blocking_reasons` を集めるので、**attempt 1 で落ちた理由は
attempt 2 が直した後も Issue 行の次アクションに残る**。これは run の履歴を後から書き換えないため
であって、未解決を意味しない。現在の状態は同じ行の `worker_state` / `verification` 側に出る。
また `resume_*` の code は `status.mjs` の hint map にまだ無いので、「detail と `summary_markdown` を
読む」に落ちる（[codes-and-recovery.md](./codes-and-recovery.md) 第4節に同じ注記がある。
追随は別 Issue）。

### 8.4 整合性ガード

`--resume` は「この Issue はもう完了・検証済みである」という主張を引き継ぐ操作なので、
**引き継ぎ元が本当にこの plan の run か**を先に確かめる。世界を probe する前・何かを書く前に行う。

| 拒否 | 条件 | exit |
|---|---|---|
| `resume_plan_mismatch` | report の `plan_run_id` / `profile.repository` / `profile.base` のいずれかが `--plan` と不一致 | 3 |
| `resume_invalid` | report が JSON として壊れている / `dispatch_schema_version` が 1 でない / `skill_id` が違う / `waves`・`workers`・`issue`・`worker_state`・`verification.outcome` のいずれかが期待の型でない | 3 |
| `load_error` | `--resume <dir>` が存在しない / `dispatch-report.json` が無い | 6 |

いずれも **1件も dispatch せず、`resume-attempt-<n>/` も作らず、台帳にも書かない**。
detail には「何がどう合わないか」（両方の `run_id`、どの field がどう違うか）を書く。
`plan_run_id` だけでなく repository / base も見るのは、`--run-id` を明示すれば別 plan でも同じ
run_id を名乗れるためで、profile の2 field は plan からそのまま写した値だからである。

`--out` と `--resume` の同時指定は `invalid_input` で拒否する。前者は新しいディレクトリを
要求し、後者は既存のディレクトリに append する。両方受け付けると、どちらの意味で言ったのかを
runner が推測することになり、外すと前回 attempt を上書きするか、誰も見ないところに書くかの
どちらかになる。

### 8.5 reverify（送らずに裁定だけ取り直す）

`--reverify <前回の --out>` は、**`send` を1回も呼ばずに** worktree の現状を verification gate に
かけ直し、report の裁定を更新する（[#121](https://github.com/Kewton/commandmate-skills/issues/121)、
[#89](https://github.com/Kewton/commandmate-skills/issues/89) の残り）。

`wait --verify` が timeout すると、その時点の裁定（`verification.outcome: not_run`）が report に
凍る。worker がその後に完走して commit しても report は更新されないので、**検証に通る成果物が
merge の eligible（`worker_state === 'completed' && verification.outcome === 'pass'`）から外れる**。
`--resume` はここから回復できるが、回復の手段が**再 dispatch** である。この状況で必要なのは
worker をもう一度走らせることではなく、**その worktree の現在の状態をもう一度ゲートにかけること**
であり、再 dispatch は worker のターンを1つ消費し、終わっていると分かっている worker に契約を
再送するので、契約 scope 内とはいえ不要な差分が生まれる余地も残す。

#### 8.5.1 分割規則

分割は第8.1節と**同じ語彙**で行う。同じ関数（`isCarryable` / `carriedWorkerRecord`）を使う。
違うのは「それ以外」に対して何をするかだけである。

| 分類 | 条件 | この attempt での扱い |
|---|---|---|
| **引き継ぎ** | `worker_state === 'completed'` **かつ** `verification.outcome === 'pass'` | `--resume` と同一。転記する。**再判定もしない** |
| **再判定** | 引き継ぎ以外で、**worktree に作業証跡が在る**もの | 送らずに verification gate にかけ直す |
| **転記のみ** | 引き継ぎ以外で、作業証跡が無い / 読めない / prompt 保留 | 前回 record をそのまま転記し、理由を limitation に書く |

#### 8.5.2 「作業が在る」の定義と、それをここで測る理由

**work-evidence ゲートと同じ2つの事実であり、それ以外ではない**:
**work ブランチの commit**、または **worktree の未 commit の変更**。CommandMate の work-evidence
ゲートが数えるのはこの2つで、`wait --verify` の exit 21 はそのゲートがどちらも見つけなかった状態
である。dispatch は `--git` で、`commandmate verify` を呼ぶ**前に**測る。

```
git rev-list --count <profile.base>..HEAD   # worktree 内で実行
git status --porcelain                      # worktree 内で実行
```

前者だけ、あるいは後者だけが読めて「在る」と言っているなら**在る**（肯定側は片方で足りる）。
「無い」と言い切るには**両方が読めて両方が空**でなければならない。片方でも読めなければ
`reverify_evidence_unreadable` であって「無い」ではない。

推測にも委譲にもしないのは、次の3つの理由による。

1. **前回 report には答えが無い。** timeout した worker の record は
   `verification.outcome: not_run` である —— ゲートが走っていないので、測定結果が1つも入っていない。
   「timeout だから多分作業は在る」は Issue が禁じた推測そのものである。
2. **`commandmate verify` に委譲すると、答えが「裁定」として返る。** exit 21 は `fail` であり
   （第2.1節。この意味は変えない）、それを記録することは**誰も作業していない Issue の record を
   格下げする**ことになる。しかもその格下げは、この flag が避けるために存在する「余計な実行」の
   産物である。裁定規則を固定したまま済ませる唯一の方法は、**訊かないこと**である。
3. **契約非対応の経路でも同じ意味でなければならない。** フォールバックの judge は profile baseline
   で、成果物は測るが work-evidence は測らない。契約経路でしか存在しない基準は、`--reverify` の
   意味を2つに割ってしまう。

#### 8.5.3 裁定と完了

**裁定機構は通常経路と同一で、新しい CLI 表面を要求しない。**

| 経路 | judge |
|---|---|
| 契約経路 | `commandmate verify <worktree-id> --json` の **exit code**（0 pass / 20 判定して不合格 / 21 work-evidence ゼロ＝`fail` / 99 判定に到達せず＝`not_run` かつ human 提示）。gate の内訳は同じ run document の `gates[]` から採る（`skipped` は裁定ではないので載せない） |
| 契約非対応 | profile baseline の worktree 内再実行。通常経路のフォールバックと**同じ関数**を呼ぶ |

exit 1 / 2 / 124 は裁定ではなく infrastructure なので、**verdict を1つも記録せず**前回 record を
そのまま残し、`reverify_judge_unavailable` を出す。

git が「作業は在る」と測ったのに judge の work-evidence ゲートが exit 21 を返した場合は、
**judge の裁定を採る**（この runner は judge を覆さない）うえで、食い違い自体を
`reverify_evidence_disagreement` に記録する。

**完了の定義は変えない**（第2.2節）: `completed` に上がるのは **work ブランチに commit が在る**
ときだけである。未 commit の作業しか無い Issue は、ゲートが通っても `completed` にしない ——
納品できないし、この経路は commit を要求できない（要求は send である）。その場合 record は前回の
`worker_state` のまま、verification だけが更新される。

#### 8.5.4 report に出る code

| code | 意味 |
|---|---|
| `reverify_attempt`（limitation） | この attempt が reverify であること・何も送っていないこと・引き継ぎ / 再判定候補。`resume_attempt` とは**別 code** である（`resume_attempt` を grep した読み手が、1件も dispatch していない attempt を拾ってはならない） |
| `reverify_no_work` （limitation） | 再判定対象が1件も無かった（全 Issue が引き継ぎだった） |
| `reverify_no_work_evidence`（limitation） | その Issue の worktree に作業証跡が無いので**判定にかけなかった** |
| `reverify_evidence_unreadable`（limitation） | 作業証跡を読めなかったので判定にかけなかった |
| `reverify_prompt_pending`（limitation） | prompt 保留中なので判定にかけなかった |
| `reverify_evidence_disagreement`（limitation） | git と judge の work-evidence が食い違った |
| `reverify_judge_unavailable`（limitation） | judge を実行できず、verdict を1つも記録しなかった |

`status` / `stop_reason` / exit の写像（第5節）は**1文字も変わらない**。転記のみになった Issue は
前回の `worker_state` を保つので、停止理由も従来の梯子（`worker_timeout` / `worker_failed` /
`not_dispatched` / `human_required` …）がそのまま正しい答えを出す。`dispatch_schema_version` は 1
のままで、`stop_reason` の enum にも値を足していない（#93 / #95 / #103 / #122 と同じ裁定）。

#### 8.5.5 artifact と整合性ガード

第8.3節・第8.4節と**同一**である。attempt N は `<out>/resume-attempt-N/` に append し、既存
artifact を1 byte も書き換えない。ディレクトリ名を `reverify-attempt-` にしないのは、
`status.mjs` の走査順（`dispatch-report.json` より後にソートされる名前が最新 attempt になる）と
`--resume` / `--reverify` を混ぜて実行したときの attempt 番号の連続性が、**1つの命名規約**に
依っているからである。

整合性ガードの code は `--resume` と共有する（`resume_plan_mismatch` / `resume_invalid` /
`load_error`）。同じ入力に対する同じ拒否であり、読み手に2つ目の語彙を覚えさせる理由が無い。
文面だけがどの flag で来たかを名乗る。

台帳の行:

```json
{"attempt":2,"kind":"reverify","plan_run_id":"plan",
 "resumed_from":{"attempt":1,"report":"dispatch-report.json"},
 "report":"resume-attempt-2/dispatch-report.json","summary":"resume-attempt-2/dispatch-summary.md",
 "status":"success","stop_reason":"completed","carried_over":[100,101],
 "dispatched":[],"reverified":[102]}
```

`dispatched` が空なのは正直な値である（1件も送っていない）。`waves[].dispatched` も同じ理由で
空になる。**何を再判定したか**は `reverified`（この kind にだけ在る key）と `reverify_attempt` の
detail と各 worker の `note` に載る。

#### 8.5.6 排他 lock を取る（`--unattended`）

**取る。** 第3.0.3節の lock を、通常の無人 run と同じ条件で取る（引き継ぎ Issue は lock 対象外、
というのも `--resume` と同じ）。

送信しないので worker は起動しない —— それでも取るのは、**`commandmate verify` が worktree の中で
リポジトリのゲートを実行する**からであり、そこで出た裁定が **merge が eligible として読む report**
に書き込まれるからである。別の run の worker が書き換えている最中の木を裁定すると、
**誰も納品していない状態についての合格**を作り、それをそのまま届けることになる。lock の粒度が
最初から「1 worktree に supervisor は1人」なのはこの harm のためであり、「読むだけだが裁定する者」は
その内側にいる。

`--reverify` は `--out` とも `--resume` とも排他である（`invalid_input`）。前2つが排他なのは
出力先が2つになるからで、`--resume` との排他は理由が違う: 引き継がなかった Issue に対する
**正反対の答え**（「worker に送り返す」対「在るものを裁定して送らない」）なので、両方受け付けると
runner が片方を推測することになり、外せば worker のターンを無駄に消費するか、終わっていない作業を
終わっていないまま放置するかのどちらかになる。
