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
| `--poll-limit <n>` | 任意 | 120 | worker ごとの wait poll 上限。超えたら timeout |

`commandmatedev` は使わない。公式経路は public `commandmate` である（ADR [#1447](https://github.com/Kewton/CommandMate/issues/1447)）。

## 2. commandmate CLI の呼び出し規約

dispatch runner は次の subcommand を呼ぶ。各呼び出しは JSON を1つ stdout に出し、
成功で exit 0 とする。**worker completion と verification success は別物** であり、
別々の呼び出しで判定する。

| subcommand | 引数 | 期待する JSON | 用途 |
|---|---|---|---|
| `send` | `--json --worktree <target> --prompt-file <path>` | `{ "task_id": "…", "state": "running" }` | generic worker prompt を dispatch |
| `wait` | `--json --task <id> --timeout <sec>` | `{ "state": "completed｜failed｜prompt｜running" }` | worker の状態を待つ |
| `capture` | `--json --task <id>` | `{ "prompt": "…", "excerpt": "…" }` | prompt/出力を human 提示用に取得 |
| `respond` | `--json --task <id> --input <text>` | `{ "state": "running" }` | prompt への応答（`--auto-yes` 時のみ） |
| `verify` | `--json --worktree <target> --task <id>` | `{ "report_schema_version": 1, "outcome": "pass｜fail", "checks": [] }` | versioned verification report |

規則:

- worker prompt は plan だけから構成する **self-contained な generic prompt** であり、
  repository-local な worker Skill を必須依存にしない（[SKILL.md](../SKILL.md) 第2部）。
  prompt は `<out>/prompts/issue-<n>.md` に artifact として残す。
- `send` の `--worktree <target>` は plan の `worktree_id`（あれば）→ `worktree`（path）の順で解決する。
  worktree path は **path escape 検査** を通す（第4節）。
- `verify` が返す report の `report_schema_version` が 1 以外、または `outcome` が
  `pass` でない場合は **pass として扱わない**。未知の verification 形は次 Wave を開けない。
- 各 subcommand が非 JSON・非0・binary 不在で失敗した場合、その worker は
  `failed`（dispatch/wait 失敗）または drift（CLI 不在）として扱い、握りつぶさない。

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
3. **dispatch と監督** — Wave の各 Issue を `send` し、`wait` で完了・失敗・prompt・timeout の
   いずれかに達するまで監督する。**prompt を検出したら停止し、`capture` で内容を取得して
   human へ提示する。自動応答しない**（`--auto-yes` 明示時のみ `respond` する）。
4. **Wave barrier** — Wave の **全 worker が `completed`** でなければ次へ進まない。
5. **verification gate** — `completed` の worker それぞれに `verify` を実行し、
   **全て pass の versioned report** が揃ってはじめて次 Wave を dispatch できる。
   worker completion だけでは gate は開かない。

`advanced` が true になるのは `all_workers_completed` かつ `all_verifications_passed`
の両方が true のときだけである。停止時の `stop_reason` の優先順位は
`human_required` > `worker_failed` > `timeout` > `verification_failed` である。

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
