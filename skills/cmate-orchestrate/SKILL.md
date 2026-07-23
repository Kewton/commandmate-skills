---
name: cmate-orchestrate
description: 複数 Issue を並列実行するための計画を dry-run で立て、承認後にその計画を監督付きで実行する。計画では Issue 品質・依存（explicit/inferred）・file conflict を分析し、cycle や不完全 override を拒否したうえで、file 衝突の無い承認可能な Wave plan・risk・権限・実行 command を決定的な artifact として返す。実行では public commandmate（worktree-id ベースの send/wait/capture）で self-contained な generic worker を dispatch し、worker が各ターン後に idle 化するため wait の idle を完了とみなさず worktree ブランチの新規 commit を完了判定として継続 nudge で駆動し、Wave barrier（前 Wave 全 worker が commit で完了）と verification gate（worktree 内で profile baseline を再実行した pass）で監督し、prompt 検出時は自動応答せず human へ提示して停止する。
---

# cmate-orchestrate（計画コア + dispatch・監督 + PR/CI/merge + UAT 修正ループ）

複数の Issue を並列で進めるための、**計画**と、その承認後の**監督付き実行**と、
verification pass 後の**PR 作成・CI 確認・guarded merge** と、納品後の
**UAT（受入テスト）と不合格時の回数上限つき修正ループ** を安全に行うための手順である。
この Skill は4つの deterministic runner を持つ。

- **計画（planner, `scripts/orchestrate.mjs`）** — dry-run で Wave plan を生成する。
  mutation は一切しない。default invocation はこれである。
- **実行（dispatch, `scripts/dispatch.mjs`）** — 承認済み plan を入力に取り、
  public `commandmate` で worker を dispatch し、Wave barrier と verification gate で
  監督する。mutation を伴う。
- **納品（merge, `scripts/merge.mjs`）** — dispatch report で verification pass した
  Issue だけを対象に、明示承認の下で PR 作成（`--create-prs`）または CI 確認付きの
  guarded merge（`--merge-prs`）を、1 invocation で1 phase だけ行う。mutation を伴う。
- **受入（uat, `scripts/uat.mjs`）** — verification pass した Issue に UAT を実行し
  （`--write-uat`）、不合格なら fix worktree 作成 → 修正 → 再検証 → 再merge を
  **回数上限つき**で繰り返す（`--create-uat-fix-worktrees`）。上限到達時は `blocked` で
  停止し成功に丸めない。1 invocation で1 phase だけ、mutation は明示承認の下でのみ行う。

Issue 本文の自動編集、回数無制限のループ、crash 後の resume/attempt retry、cross-model review は
この Skill の **スコープ外** である。どの mutating runner も、明示承認・verification pass・
CI pass の gate 無しに mutation を行わない。

計画も実行も納品も、同梱の runner（Node stdlib のみ）が行う。計画は入力の純粋関数で、
同じ入力からは同じ plan が出る（Claude/Codex parity）。base branch・branch 名・
worktree path・baseline は **profile から解決**し、`develop`/`npm`/`cargo` を hardcode しない。

---

# 第1部 計画コア（dry-run）

## 1. この runner が答える問い

1. 各 Issue は着手できる品質か（objective・受入条件・対象 file・blocking question）。
2. Issue 間の依存はどれか。明示された依存（explicit）と、推論した依存（inferred）は何か。
3. 同時に触ると壊れる Issue の組み合わせ（file conflict）はどれか。
4. 以上を踏まえ、file 衝突の無い Wave plan と merge 順はどうなるか。
5. この plan の risk はどれくらいで、実行には何の権限と command が要るか。

## 2. 入力

| 名前 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `issues` | 必須 | なし | Issue 番号（positional か `--issues a,b,c`）。1件以上 |
| `--profile <id>` | 任意 | `node-commandmate` | 内蔵 profile。`node-commandmate` / `rust-commandagent` |
| `--profile-json <path>` | 任意 | なし | 独自 profile。[references/profile-contract.md](./references/profile-contract.md) |
| `--issue-json <path>` | 任意 | なし | Issue fixture。offline・決定的に回すときに使う |
| `--base <ref>` | 任意 | profile 由来 | base branch の上書き |
| `--max-parallel <1-3>` | 任意 | `3` | 1 Wave の最大幅 |
| `--depends <a:b>` | 任意 | なし | override: `a` が `b` に依存（繰り返し可） |
| `--no-infer` | 任意 | off | 推論依存を無効化 |
| `--order <a,b,...>` | 任意 | なし | Issue 順序の主張。依存に反すれば拒否 |
| `--run-id <id>` | 任意 | 入力 hash | run_id の明示 |
| `--runs-dir <path>` | 任意 | `.commandmate/orchestrate/runs` | run artifact の出力先 |
| `--phase <plan>` | 任意 | `plan` | planner は `plan` のみ。mutating phase は拒否（実行は dispatch runner） |
| `--allow-unverified` | 任意 | off | unverified profile での planning を許可 |

## 3. 権限と禁止事項

宣言している権限は `filesystem_read` / `filesystem_write` / `process_execution` /
`network_access` である。これは計画と実行の両 runner を含めた orchestration 全体が
要求する権限であり、plan にも同じ集合を提示する。

planner の手順として **禁止** するもの:

- worktree の作成、worker への dispatch、`commandmate send` / `wait` / `capture`（← 実行は dispatch runner の担当）
- PR の作成、CI のトリガ、merge（← 納品は merge runner の担当。第3部）
- UAT の実行、fix worktree 作成、修正ループ（← 受入は uat runner の担当。第4部）
- 対象リポジトリの branch・Issue・PR の変更

`--issue-json` を使わない場合、read-only の `gh issue view` で Issue を取得する。
これは planner 唯一の network access であり、mutation を伴わない。

セキュリティ:

- client 入力（Issue 本文由来）の絶対 path・`..`・drive path は採用しない。
- token・secret・絶対 path は plan/result/artifact へ残さない（redaction）。

## 4. 手順

### Step 0. 入力を検証する

Issue 番号が1件以上あること、`--max-parallel` が 1〜3 であること、
`--phase` が `plan` であることを確認する。planner に mutating phase
（`dispatch`/`pr`/`merge`/`uat`）が指定されたら、実行せず `not_implemented` で終了する
（実行は承認済み plan を dispatch runner に渡して行う。第2部）。

### Step 1. profile を解決する

`--profile` / `--profile-json` から profile を解決する。unverified profile は、
`--allow-unverified` が無ければ `unverified_profile` で終了する
（[references/profile-contract.md](./references/profile-contract.md) 第3節）。

### Step 2. Issue を取得する

`--issue-json` があればそれを、無ければ `gh issue view` で各 Issue を取得する。
取得できない Issue があれば `load_error` で終了する。

### Step 3. 各 Issue を分析する

Issue ごとに objective・受入条件・suspected/reference files・test 期待・
blocking question を抽出する。抽出時に token・secret・絶対 path を redaction する。
受入条件や対象 file が読み取れない Issue には blocking question を立てる。

### Step 4. 依存を解決する

explicit（本文由来）・inferred（推論）・override（`--depends`）を
[references/plan-contract.md](./references/plan-contract.md) 第3節の規則で統合する。
cycle・不完全 override・順序違反（`--order`）はここで **拒否** する。
集合外を指す explicit 依存は warning に落とし、`status` を `partial` にする。

### Step 5. Wave を組む

依存を満たし、file 衝突を同一 Wave に入れず、各 Wave を `max_parallel` 以下にする
（同 reference 第4節）。merge 順は Wave の平坦化である。

### Step 6. risk・permissions・commands を出す

risk factor を決定的に導き（同 reference 第6節）、要求権限と、plan の根拠になる
read-only command・baseline 検証 command（すべて `executed: false`）を列挙する。

### Step 7. artifact を書く

`<runs-dir>/<run_id>/` に `plan.json`・`result.json`・`manifest.md`・
`issue-analysis.md`・`dependency-plan.md` を書く。run directory が既にあれば
上書きせず `run_exists` で終了する。

### Step 8. completion check を実行する

result を返す前に、5つの check を自己申告する
（[references/plan-contract.md](./references/plan-contract.md) 第8節）。
いずれかが false なら `status` を `success` にしない。

## 5. 出力

planner は result envelope（[schemas/orchestrate-result.v1.json](./schemas/orchestrate-result.v1.json)）を
stdout に、進捗 notice を stderr に出す。`status` は3値（`success`/`partial`/`failure`）。
plan 本体は [schemas/execution-plan.v1.json](./schemas/execution-plan.v1.json) に適合する。

## 6. planner の失敗時の動作

| 状況 | code | exit |
|---|---|---|
| Issue 番号が無い / 引数不正 / max-parallel 範囲外 | `invalid_input` | 3 |
| mutating phase 指定 | `not_implemented` | 2 |
| unverified profile（`--allow-unverified` 無し） | `unverified_profile` | 3 |
| Issue / profile / fixture が読めない | `load_error` | 6 |
| 依存 cycle | `cycle_detected` | 5 |
| 不完全 override | `override_incomplete` | 5 |
| 順序違反 | `dependency_order_violation` | 5 |
| run directory が既存 | `run_exists` | 4 |

失敗時も stdout に `status: failure` の result を出す。plan を推測で埋めない。

---

# 第2部 dispatch・監督ループ

承認済み plan を実際に実行する。契約の正本は
[references/dispatch-contract.md](./references/dispatch-contract.md)、report の schema は
[schemas/dispatch-report.v1.json](./schemas/dispatch-report.v1.json) である。

## 7. dispatch runner の入力

```
dispatch.mjs --plan <承認済み plan.json> [options]
```

| 名前 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `--plan <path>` | 必須 | なし | planner が出力した承認済み `plan.json` |
| `--out <dir>` | 任意 | `<plan-dir>/dispatch` | dispatch artifact の出力先。既存なら `out_exists` |
| `--cli <path>` | 任意 | `commandmate` | 実行する public CommandMate CLI |
| `--git <path>` | 任意 | `git` | drift 確認に使う git |
| `--gh <path>` | 任意 | `gh` | repo 到達性確認に使う gh |
| `--auto-yes` | 任意 | **off** | worker prompt を自動応答する。既定 off（prompt で停止し human へ提示） |
| `--expect-branch <name>` | 任意 | なし | plan 承認時の統合 branch。不一致なら drift |
| `--wait-timeout <sec>` | 任意 | `300` | `commandmate wait` の1回あたり timeout |
| `--max-turns <n>` | 任意 | `8` | 各 worker を駆動する最大ターン数（初回 send + nudge）。未 commit で到達なら failed |
| `--poll-limit <n>` | 任意 | `120` | 互換のため保持（wait は block するので poll しない） |

`commandmatedev` は使わない。公式経路は public `commandmate` である（ADR
[#1447](https://github.com/Kewton/CommandMate/issues/1447)）。

## 8. dispatch の手順

Wave を plan の順に処理する。各 Wave について:

### Step D0. plan を読み・検証する

`plan_schema_version` が 1 で、`max_parallel` が 1〜3、どの Wave も `max_parallel` 以下で
あることを確認する。反していれば `plan_invalid` で終了する（**上限を超えて dispatch しない**）。

### Step D1. mutation 前に drift を再確認する

`cli_available`・`repo_access`・`base_resolvable`・`branch_matches`（`--expect-branch` 時）を
確認する。**blocking** な check が false なら dispatch せず停止する。`integration_clean`・
`worktrees_present` は非 blocking で `limitations` に記録して続行する。最初の Wave 前の
drift は `failure`、途中の Wave 前は `partial`。stop_reason は `drift`。

### Step D2. self-contained な generic worker を dispatch する

Wave の各 Issue について、plan だけから **generic worker prompt** を構成し
（objective・受入条件・対象 file の境界・branch/worktree・baseline・**「完了時に単一 commit せよ」**・
「blocked なら止まって聞け」）、`<out>/prompts/issue-<n>.md` に残したうえで、worktree-id を解決して
`commandmate send <worktree-id> <message>`（positional。task id は返らない）で dispatch する。
worktree-id は plan の `worktree_id`（あれば）→ なければ `commandmate ls --json` を branch で
突き合わせて解決する（`commandmate sync` は無い）。repository-local な worker Skill を必須依存に
しない。worktree path は path escape 検査を通す。

### Step D3. 監督ループで駆動する（send 確定 / wait / commit 判定 / nudge）（#1468）

実 Claude worker は **1メッセージ＝1ターン**で動き、各ターン後に **idle 化**する。`commandmate wait`
はその idle で **exit 0** を返すが、これは「タスク完了」ではない。したがって各 worker を次の監督ループで
駆動する。**完了の ground truth は worktree ブランチの新規 commit** である。

1. dispatch 開始前に `git rev-parse HEAD`（cwd=worktree）で開始時 SHA を記録する。
2. `send` 直後に `commandmate capture <worktree-id> --json` で worker が動き出したかを確認し、
   未確定（Enter 未送信）なら **1回だけ再送**して送信を確定させる。
3. `commandmate wait <worktree-id> --timeout <sec>` で idle 化を待つ（block）。**prompt（exit 10）は停止し
   `capture` で human 提示、自動応答しない**（`--auto-yes` 時のみ `respond ... yes`）。timeout（124）→
   `timeout`、その他非0 → `failed`。
4. idle（exit 0）になったら HEAD SHA を再取得する。**新規 commit あり → `completed`**。無ければ
   **継続 nudge**（「続けて実装を完遂し単一 commit してください」）を send（+確定）して 3 へ戻る。
5. ターン数が `--max-turns`（既定 8）に達しても未 commit なら、当該 worker を `failed` とし honest に報告する
   （idle を完了と誤認しない）。

### Step D4. Wave barrier

Wave の **全 worker が `completed`（新規 commit を検出）** でなければ次 Wave へ進まない。

### Step D5. verification gate

`completed` の worker それぞれについて、**profile の baseline を worktree 内で再実行**して検証する
（`commandmate verify` は無い）。全 baseline command が exit 0 の worker が揃ってはじめて次 Wave を
dispatch する。**worker completion を verification success と同一視しない。** 未完了 worker は検証せず、
worktree が無い・いずれかの baseline command が非 0 なら pass として扱わない。

## 9. dispatch の出力

dispatch runner は report（[schemas/dispatch-report.v1.json](./schemas/dispatch-report.v1.json)）を
stdout に、`<out>/dispatch-report.json` と `<out>/dispatch-summary.md` を file に書く。

| status | 条件 | exit |
|---|---|---|
| `success` | 全 Wave dispatch・全 worker completed・全 verification pass・prompt なし | 0 |
| `partial` | 途中停止（worker 失敗・timeout・verification 失敗・prompt・drift） | 7 |
| `failure` | 1件も dispatch できない（plan 不正・最初の Wave 前 drift・CLI 不在） | 1 |

`stop_reason` の優先順位は `human_required` > `worker_failed` > `timeout` >
`verification_failed`。report は5つの completion check（`plan_approved`・
`drift_reconfirmed`・`parallelism_bounded`・`barrier_enforced`・`no_auto_prompt_response`）を
自己申告する。token・secret・絶対 path・raw terminal 全量は report に残さない（redaction）。

## 10. 完了条件

計画:

- [ ] default invocation が dry-run で、run directory 以外を変更していない
- [ ] explicit / inferred 依存が区別され、cycle・不完全 override・順序違反を拒否している
- [ ] file 衝突のある Issue が同一 Wave に無く、`max_parallel` が 1〜3
- [ ] 同じ入力から同じ plan が出る（`--run-id` 固定で diff を取って確認できる）

dispatch:

- [ ] `max_parallel` を超えて dispatch していない
- [ ] 前 Wave 未完了・verification 失敗時に後続 Wave を dispatch していない
- [ ] prompt 検出時に自動応答せず human-required として停止している
- [ ] worker completion だけを success 扱いしていない
- [ ] mutation 前に drift を再確認している

---

# 第3部 PR 作成・CI 確認・guarded merge

dispatch report で verification pass した Issue を納品する。契約の正本は
[references/merge-contract.md](./references/merge-contract.md)、report の schema は
[schemas/merge-report.v1.json](./schemas/merge-report.v1.json) である。

## 11. merge runner の入力

```
merge.mjs --plan <承認済み plan.json> --dispatch <dispatch-report.json> (--create-prs | --merge-prs) [options]
```

CommandAgent の explicit phase flag 設計（ADR
[#1447](https://github.com/Kewton/CommandMate/issues/1447)）を踏襲し、**1 invocation で
mutating phase をちょうど1つだけ** 有効化する。`--create-prs` は PR 作成、`--merge-prs` は
CI 確認付きの guarded merge である。両方指定・どちらも未指定は `invalid_input` で拒否する。

| 名前 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `--plan <path>` | 必須 | なし | 承認済み `plan.json` |
| `--dispatch <path>` | 必須 | なし | dispatch runner の `dispatch-report.json`。eligible の唯一の根拠 |
| `--create-prs` / `--merge-prs` | どちらか1つ | なし | 有効化する mutating phase |
| `--approve` | 任意 | **off** | 明示承認。無ければ mutation しない preview |
| `--merge-method <m>` | 任意 | `squash` | merge 方式（`merge`/`squash`/`rebase`） |
| `--out <dir>` | 任意 | `<dispatch-dir>/<phase>` | 出力先。既存なら `out_exists` |
| `--gh <path>` | 任意 | `gh` | PR 作成・CI 確認・merge の GitHub CLI |
| `--git <path>` | 任意 | `git` | branch push と base preflight の git |

## 12. merge の手順

対象は dispatch report で **`completed` かつ verification `pass`** の Issue だけである
（verification gate の継承）。plan の `merge_order` 順に処理する。

### Step M0. eligible を決める

dispatch report から eligible 集合を取る。空なら `no_eligible_issues` を載せて no-op success
とし、mutation しない。**verification が pass していない Issue を PR/merge に変えない。**

### Step M1. preflight（read-only）

`gh --version`・`gh repo view`・`git rev-parse --verify <base>` を確認する。blocking な失敗が
あれば `failure`（`preflight_failed`）で、何も試さず終了する。

### Step M2. 2つの gate を守る

- **承認 gate** — `--approve` が無ければ push・PR 作成・merge を **一切しない** preview とする。
  `mutated` は false のままにする。
- **CI gate（`--merge-prs`）** — PR を merge するのは CI checks が **すべて green** のときだけ。
  failure は `ci_failed`、pending・check 0 件は `ci_pending` として **merge を拒否** する。

### Step M3-a. `--create-prs`

各 eligible の branch を（承認時のみ）`git push` し、self-contained な PR body
（objective・受入条件・baseline・`Resolves #n`）を `<out>/pr-bodies/issue-<n>.md` に残して
`gh pr create` する。push または create が失敗したら `pr_failed` で停止する。

### Step M3-b. `--merge-prs`

各 eligible の PR を `gh pr view` で発見し、`gh pr checks` で CI を確認する。CI green かつ
承認ありのときだけ `gh pr merge --<method>` で merge する。CI が green でない、PR が無い、
merge が conflict のときは停止し、`ci_failed`/`ci_pending`/`pr_missing`/`merge_failed` を記録する。

### Step M4. 記録する

失敗・blocked は途中停止し、`blocking_reasons` と該当 target に記録する。停止後の eligible は
outcome `skipped` として残す。**failure を success に丸めない。** token・secret・絶対 path・
raw terminal は report/artifact に残さない（redaction）。

## 13. merge の出力

merge runner は report（[schemas/merge-report.v1.json](./schemas/merge-report.v1.json)）を
stdout に、`<out>/merge-report.json` と `<out>/merge-summary.md` を file に書く。

| status | 条件 | exit |
|---|---|---|
| `success` | 全 eligible を失敗なく処理（preview を含む） | 0 |
| `partial` | 途中停止（PR 作成失敗・CI failure/pending・PR 不在・merge conflict） | 7 |
| `failure` | 何も試せない（preflight 失敗・plan 不正・invalid input） | 1 |

report は5つの completion check（`single_phase`・`approval_enforced`・`verification_gated`・
`ci_gated`・`failures_not_rounded`）を自己申告する。

merge 完了条件:

- [ ] 1 invocation で mutating phase を1つだけ有効化している
- [ ] `--approve` 無しに push・PR 作成・merge をしていない
- [ ] CI green 無しに merge していない
- [ ] verification pass した Issue だけを対象にしている
- [ ] PR 作成失敗・CI failure・merge conflict を blocked/partial として停止・記録している

---

# 第4部 UAT 実行・回数上限つき修正ループ

dispatch report で verification pass した Issue に受入テスト（UAT）を実行し、不合格なら回数上限つきで
修正する。契約の正本は [references/uat-contract.md](./references/uat-contract.md)、report の schema は
[schemas/uat-report.v1.json](./schemas/uat-report.v1.json) である。

## 14. uat runner の入力

```
uat.mjs --plan <承認済み plan.json> --dispatch <dispatch-report.json> (--write-uat | --create-uat-fix-worktrees) [options]
```

CommandAgent の explicit phase flag 設計（`--write-uat` / `--create-uat-fix-worktrees` 相当、ADR
[#1447](https://github.com/Kewton/CommandMate/issues/1447)）を踏襲し、**1 invocation で phase をちょうど
1つだけ** 有効化する。`--write-uat` は UAT の read-only 実行、`--create-uat-fix-worktrees` は修正ループ
である。両方指定・どちらも未指定は `invalid_input` で拒否する。

| 名前 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `--plan <path>` | 必須 | なし | 承認済み `plan.json` |
| `--dispatch <path>` | 必須 | なし | dispatch runner の `dispatch-report.json`。eligible の唯一の根拠 |
| `--write-uat` / `--create-uat-fix-worktrees` | どちらか1つ | なし | 有効化する phase |
| `--approve` | 任意 | **off** | fix loop の明示承認。無ければ mutation しない preview |
| `--max-attempts <1-5>` | 任意 | `2` | fix 試行の回数上限。ループはこれを超えない |
| `--out <dir>` | 任意 | `<dispatch-dir>/<phase>` | 出力先。既存なら `out_exists` |
| `--cli` / `--git` / `--gh <path>` | 任意 | `commandmate`/`git`/`gh` | UAT・fix dispatch・再検証・再merge・preflight に使う CLI |

## 15. uat の手順

対象は dispatch report で **`completed` かつ verification `pass`** の Issue だけである（verification gate
の継承）。plan の `merge_order` 順に処理する。eligible が空なら `no_eligible_issues` を載せて no-op
success とする。

### Step U0. preflight（read-only）

`commandmate --version`・`gh repo view`・`git rev-parse --verify <base>` を確認する。blocking な失敗が
あれば `failure`（`preflight_failed`）で、何も試さず終了する。

### Step U1-a. `--write-uat`（read-only assessment）

各 eligible の worktree 内で **profile の baseline を実行**して受入を判定する（`commandmate uat` は
無い。全 baseline command が exit 0 なら pass）。全 pass なら `success`、不合格があれば
`partial`（`uat_failed`）とし、不合格 Issue と next action を返す。worktree も fix も再merge もしない。

### Step U1-b. `--create-uat-fix-worktrees`（回数上限つき修正ループ）

`target` を eligible として、各反復（= 1 attempt、`attempts[]` に **append**）で:

1. **assess** — `target` の各 Issue の現行 worktree（初回は dispatch worktree、fix が成立した後はその
   fix worktree）で **baseline を再実行**する（read-only）。全 pass ならループを抜けて `success`。
2. **preview** — `--approve` が無ければ、不合格集合を報告して停止する（`partial`）。mutation しない。
3. **上限判定** — これまでの fix 回数が `--max-attempts` に達していれば、不合格を `unresolved_issues` に
   載せて **`blocked`（`max_attempts_reached`）** で停止する。**成功に丸めない。**
4. **fix**（承認あり・上限未達） — 不合格 Issue ごとに fix worktree を作り（#1448 worktree-result の形、
   base を resolved SHA に再確認、既存 worktree を暗黙上書きしない）、fix worker を **dispatch と同じ監督
   ループ**で駆動する（#1468）。fix worktree の開始時 SHA を記録し、`commandmate send`（直後の `capture`
   で送信確定を確認、未確定なら1回だけ再送）→ `commandmate wait` で idle 化を待つ。**wait の idle は完了
   ではない**。fix branch に新規 commit が出れば `completed`、未 commit なら継続 nudge を送って `wait` へ
   戻る（fix prompt に「完了時に単一 commit」を明記）。prompt・`--max-turns`（既定 8）到達で未 commit なら
   `fix_failed` で停止。完了した fix のみ **fix worktree 内で baseline を再実行して再検証**する。
   再検証 pass した fix branch のみ `git merge` で **再merge** する（再検証不合格は再merge せず、次反復で
   再試行）。worktree 作成失敗・再merge conflict はそれぞれ `worktree_failed`/`remerge_failed` で停止する。
   `target` を不合格集合に更新して次の反復（再UAT）へ進む。

`attempts_used`（fix 回数）は常に `max_attempts` 以下である。既存 run artifact は上書きせず、attempt は
`<out>/attempts/attempt-<n>/` と `<out>/attempts/history.jsonl` に append する。

## 16. uat の出力

uat runner は report（[schemas/uat-report.v1.json](./schemas/uat-report.v1.json)）を stdout に、
`<out>/uat-report.json` と `<out>/uat-summary.md` を file に書く。`status` は4値である。

| status | 条件 | exit |
|---|---|---|
| `success` | 全 eligible が UAT を通過（修正後の pass を含む）／eligible なしの no-op | 0 |
| `partial` | preview・UAT 不合格の assess・fix 途中停止（worktree/fix/remerge 失敗） | 7 |
| `blocked` | fix 上限到達でなお不合格が残る（成功に丸めない） | 8 |
| `failure` | 何も試せない（preflight 失敗・plan/dispatch 不正・invalid input） | 1 |

report は5つの completion check（`single_phase`・`approval_enforced`・`attempts_bounded`・
`blocked_reported`・`verification_gated`）を自己申告し、`next_actions` に次の一手を返す。
token・secret・絶対 path・raw terminal は report/artifact に残さない（redaction）。

uat 完了条件:

- [ ] 1 invocation で phase を1つだけ有効化している
- [ ] `--approve` 無しに worktree 作成・fix dispatch・再merge をしていない
- [ ] fix 回数が `--max-attempts` を超えていない（回数無制限にしていない）
- [ ] 上限到達でなお不合格なら `blocked` で停止し success に丸めていない
- [ ] verification pass した Issue だけを対象にし、再merge した fix はすべて再検証 pass だった
- [ ] 既存 run artifact を上書きせず attempt を append している

## 17. 参照

- [references/profile-contract.md](./references/profile-contract.md) — profile の形と unverified の扱い
- [references/plan-contract.md](./references/plan-contract.md) — 依存・Wave・risk・result の契約
- [references/dispatch-contract.md](./references/dispatch-contract.md) — dispatch・監督ループ・verification gate の契約
- [references/merge-contract.md](./references/merge-contract.md) — PR 作成・CI 確認・guarded merge の契約
- [references/uat-contract.md](./references/uat-contract.md) — UAT 実行・回数上限つき修正ループの契約
- [references/agent-compatibility.md](./references/agent-compatibility.md) — Agent 差異と fallback
- [schemas/execution-plan.v1.json](./schemas/execution-plan.v1.json) — plan の機械検証用 schema
- [schemas/orchestrate-result.v1.json](./schemas/orchestrate-result.v1.json) — planner result envelope の schema
- [schemas/dispatch-report.v1.json](./schemas/dispatch-report.v1.json) — dispatch report の schema
- [schemas/merge-report.v1.json](./schemas/merge-report.v1.json) — merge report の schema
- [schemas/uat-report.v1.json](./schemas/uat-report.v1.json) — UAT report の schema
