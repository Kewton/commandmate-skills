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

## 1. 入力

| 名前 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `--plan <path>` | 必須 | なし | 承認済み `plan.json`（plan-core の出力） |
| `--out <dir>` | 任意 | `<plan-dir>/dispatch` | dispatch artifact の出力先。既存なら `out_exists` で拒否 |
| `--cli <path>` | 任意 | `commandmate` | 実行する public CommandMate CLI |
| `--git <path>` | 任意 | `git` | drift 確認に使う git |
| `--gh <path>` | 任意 | `gh` | repo 到達性確認に使う gh |
| `--auto-yes` | 任意 | off | worker prompt を自動応答する。既定 off（prompt で停止し human へ提示） |
| `--expect-branch <name>` | 任意 | なし | plan 承認時の統合 branch。dispatch 時に不一致なら drift |
| `--wait-timeout <sec>` | 任意 | 300 | `commandmate wait` に渡す1回あたり timeout |
| `--max-turns <n>` | 任意 | 8 | 各 worker を駆動する最大ターン数（初回 send + nudge）。未 commit のまま到達で当該 worker を failed とする |
| `--poll-limit <n>` | 任意 | 120 | 互換のため保持（wait は block するので poll しない） |

`commandmatedev` は使わない。公式経路は public `commandmate` である（ADR [#1447](https://github.com/Kewton/CommandMate/issues/1447)）。

## 2. commandmate CLI の呼び出し規約（worktree-id ベース）

実 `commandmate` CLI は **worktree-id ベース**であり、task id・`--json --worktree`・
`--prompt-file` は無く、`verify` サブコマンドも無い（#1467）。dispatch runner は次を呼ぶ。
**worker completion と verification success は別物** であり、別々に判定する。

| subcommand | 引数 | 結果の読み方 | 用途 |
|---|---|---|---|
| `ls` | `--json` | `[{ "id", "name", "branch", … }]` | dispatch 時に worktree-id を解決 |
| `send` | `<worktree-id> <message>` | exit 0 で送信成功（task id は返らない） | generic worker prompt / 継続 nudge を送る |
| `capture` | `<worktree-id> --json` | `{ "isGenerating", "isPromptWaiting", "content", "promptData": { "question" }, … }` | 送信確定の確認・prompt/出力の human 提示用取得 |
| `wait` | `<worktree-id> --timeout <sec>` | **exit code**: 0 **idle（1ターン終了）** / 10 prompt / 124 timeout / その他 failed | worker が idle 化するまで待つ（block） |
| `respond` | `<worktree-id> yes` | exit 0 | prompt への応答（`--auto-yes` 時のみ） |

**重要（#1468）**: 実 Claude worker は **1メッセージ＝1ターン**で動き、各ターン後に入力待ちで
**idle 化**する。`commandmate wait` はその idle で **exit 0** を返すが、これは「タスク完了」ではなく
「1ターン終了」である。したがって dispatch runner は **wait の exit 0 を完了とみなさない**。完了の
ground truth は **worktree ブランチに新規 commit が出たこと**（`git rev-parse HEAD` を worktree 内で
実行し、dispatch 開始時 SHA から進んだか）である（第2.2節）。

verification（検証）は commandmate 呼び出しではない。**profile の `baseline` を worktree 内で再実行**し、
全 command が exit 0 なら pass とする（第2.1節）。completion（commit 検出）と verification（baseline pass）
はさらに別物であり、両方が揃ってはじめて Wave が進む。

規則:

- worker prompt は plan だけから構成する **self-contained な generic prompt** であり、
  repository-local な worker Skill を必須依存にしない（[SKILL.md](../SKILL.md) 第2部）。
  prompt は `<out>/prompts/issue-<n>.md` に artifact として残し、その内容を `send` の `<message>`
  として渡す。
- worktree-id は plan の `worktree_id`（valid なら）→ 無ければ `commandmate ls --json` を Issue の
  `branch` で突き合わせて解決する（`commandmate sync` は存在しない）。worktree path（baseline の
  cwd）は **path escape 検査** を通す（第4節）。
- `wait` は終端まで block するので poll しない。exit code が 10（prompt）のとき stdout に prompt JSON が
  出るが、runner は redaction 済みの `capture` 抜粋のみを report に残す（raw は残さない）。
- 各 subcommand が非0・binary 不在で失敗した場合、その worker は `failed`（send/wait 失敗・worktree
  未解決）または drift（CLI 不在）として扱い、握りつぶさない。

### 2.1 verification（baseline 再実行）

`completed` の worker それぞれについて、plan `profile.baseline` の各 command を **worktree 内で
`execFile`（cwd=worktree path）** 実行する。全 command が exit 0 なら `outcome: pass`、worktree が
無い・いずれかが非0なら `fail`。versioned report は無く、`report_schema_version` は `null`、`checks`
は実行した baseline command の（redaction 済み）ラベルである。worker completion だけでは gate は開かない。

### 2.2 completion（commit 検出）

worker の完了は idle ではなく **worktree ブランチの新規 commit** で判定する。dispatch 開始前に
`git rev-parse HEAD`（cwd=worktree path）で **開始時 SHA** を記録し、各 idle 後に再取得して比較する。
SHA が進んでいれば `completed`（commit 検出）、進んでいなければ「まだ 1ターン終えて idle 化しただけ」で
あり、**継続 nudge** を送って次のターンを待つ。generic worker prompt には「作業完了時に単一 commit せよ」
を明記し、これを完了の合図とする。SHA が取得できない worktree は「未 commit」として扱い、完了とはしない。

## 3. 監督ループと gate

各 Wave について、plan の順に次を行う。

1. **drift 再確認（mutation 前）** — `cli_available`・`repo_access`・`base_resolvable`・
   `branch_matches`（`--expect-branch` 指定時）・`integration_clean`・`worktrees_present`
   を確認する。**blocking** な check（前4つ）が false なら dispatch せず停止する。
   非 blocking（後2つ）は `limitations` に記録して続行する。
   最初の Wave 前の drift は「何も dispatch していない」ので `failure`、
   途中の Wave 前の drift は `partial`。stop_reason は `drift`。
2. **max_parallel 遵守** — Wave の幅は plan で `max_parallel`（1〜3）以下に保証済み。
   万一超える plan は `plan_invalid` で拒否し、runner は上限を超えて dispatch しない。
3. **dispatch と監督ループ（#1468）** — Wave の各 Issue を次の監督ループで駆動する。
   1. 開始時 SHA を記録（第2.2節）し、generic worker prompt を `send` する。
   2. **送信を確定** — `send` は Enter 未確定で送信が確定しない癖があるため、送信直後に
      `capture --json` で worker が動き出したか（`isGenerating`/`isRunning`/`isPromptWaiting`）を
      確認し、動いていなければ **1回だけ再送**して確定を試みる。
   3. `wait` で idle 化を待つ。
      - **exit 10（prompt）** → `capture` で内容を取得して human へ提示し停止する。**自動応答しない**
        （`--auto-yes` 明示時のみ `respond yes` して同ターンを続行）。
      - **exit 124（timeout）** → `timeout`。**その他非0** → `failed`。
      - **exit 0（idle）** → 第2.2節の commit 判定。新規 commit あり → `completed`。無ければ次へ。
   4. commit 未検出なら **継続 nudge**（「続けて実装を完遂し単一 commit してください」）を send（+確定）
      して 3 へ戻る。**ターン数が `--max-turns`（既定 8）に達しても未 commit** なら、当該 worker を
      `failed`（note に「max-turns 到達・未 commit」）とし、握りつぶさない。
4. **Wave barrier** — Wave の **全 worker が `completed`（commit 検出）** でなければ次へ進まない。
5. **verification gate** — `completed` の worker それぞれについて **worktree 内で profile baseline を
   再実行**し、全 command が exit 0 の worker が揃ってはじめて次 Wave を dispatch できる（第2.1節）。
   worker completion だけでは gate は開かない。

`advanced` が true になるのは `all_workers_completed` かつ `all_verifications_passed`
の両方が true のときだけである。停止時の `stop_reason` の優先順位は
`human_required` > `worker_failed` > `timeout` > `verification_failed` である
（`--max-turns` 到達の未 commit は `worker_failed` に含まれる）。

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
| `failure` | 1件も dispatch できない（plan 不正・最初の Wave 前 drift・CLI 不在） | 1 |

失敗時も stdout に `status: failure` の report を出す。実行結果を推測で埋めない。

## 6. completion_check（report）

report は5つの check を自己申告する。

| id | 内容 |
|---|---|
| `plan_approved` | 承認済み plan を読み・検証した |
| `drift_reconfirmed` | mutation 前に drift を再確認した |
| `parallelism_bounded` | どの Wave も max_parallel を超えて dispatch していない |
| `barrier_enforced` | 次 Wave は「全完了 かつ verification pass」でのみ dispatch した |
| `no_auto_prompt_response` | prompt を自動応答していない（`--auto-yes` 未使用） |

`passed` は5件すべて true、かつ status が `failure` でないときだけ true。

## 7. version 運用

- field の追加・削除・意味の変更、enum への値追加 → `dispatch_schema_version` を上げる。
- 文言・見出しの調整のみ → Skill の `version` だけを上げる。
