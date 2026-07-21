# merge 契約 v1

`cmate-orchestrate` の merge runner（`scripts/merge.mjs`）が、dispatch 済みの plan に対して
**PR 作成・CI 確認・guarded merge** の mutating phase をどう実行し、`gh` / `git` CLI とどう
話すかの定義である。機械検証用の正本は
[../schemas/merge-report.v1.json](../schemas/merge-report.v1.json)（merge report）であり、
この文書はその読み方と、schema では表現できない規則を述べる。

計画コア（[plan-contract.md](./plan-contract.md)）は dry-run で plan を作り、dispatch runner
（[dispatch-contract.md](./dispatch-contract.md)）は worker を監督して verification gate まで進める。
merge runner は、その **dispatch report で「worker 完了かつ verification pass」だった Issue** だけを
対象に、PR を作り、CI を確認し、条件を満たしたときだけ merge する。3つは別 runner であり、
planner の `--phase merge`/`--phase pr` は依然として `not_implemented` を返す。

`merge_schema_version` は 1 である。field の追加・削除・意味の変更、および enum への値の追加は
version を上げて行う。**未知の field を足さないこと。**

## 1. explicit phase flag（1 invocation = 1 mutating phase）

CommandAgent の explicit phase flag 設計（ADR [#1447](https://github.com/Kewton/CommandMate/issues/1447)）を踏襲し、
**1 回の invocation で有効化できる mutating phase はちょうど1つ** である。

| flag | phase | 内容 |
|---|---|---|
| `--create-prs` | `create_prs` | verification pass した branch を push し、PR を作成する |
| `--merge-prs` | `merge_prs` | 各 PR の CI を確認し、green のときだけ merge する（guarded） |

両方指定・どちらも未指定は `invalid_input` で拒否する（既定で片方を選ばない）。

## 2. 入力

```
merge.mjs --plan <plan.json> --dispatch <dispatch-report.json> (--create-prs | --merge-prs) [options]
```

| 名前 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `--plan <path>` | 必須 | なし | 承認済み `plan.json`（plan-core の出力） |
| `--dispatch <path>` | 必須 | なし | dispatch runner の `dispatch-report.json`。eligible 集合の唯一の根拠 |
| `--create-prs` / `--merge-prs` | どちらか1つ必須 | なし | 有効化する mutating phase |
| `--approve` | 任意 | **off** | 明示承認。無ければ mutation しない preview |
| `--merge-method <m>` | 任意 | `squash` | `merge_prs` の merge 方式（`merge`/`squash`/`rebase`） |
| `--out <dir>` | 任意 | `<dispatch-dir>/<phase>` | 出力先。既存なら `out_exists` で拒否 |
| `--gh <path>` | 任意 | `gh` | PR 作成・CI 確認・merge に使う GitHub CLI |
| `--git <path>` | 任意 | `git` | branch push と base preflight に使う git |

`commandmatedev` は使わない。公式経路は public `gh`/`git` である。

## 3. eligible 集合（verification gate の継承）

merge runner が対象にするのは、dispatch report の `waves[].workers[]` のうち
**`worker_state` が `completed` かつ `verification.outcome` が `pass`** の Issue だけである。
worker 完了だけでは対象にしない。verification が pass していない Issue を PR や merge に
変えることは無い。対象は plan の `merge_order` 順に処理し、依存順を守る。

eligible が空の場合は `no_eligible_issues`（limitation）を載せて no-op success とし、mutation
はしない。

## 4. 2つの gate（承認 と CI pass）

**PR 作成・merge は、次の gate をすべて満たすときだけ実行する。丸めない。**

1. **明示承認（approval gate）** — `--approve` が無ければ、その phase は **preview** であり、
   push・PR 作成・merge を **一切しない**。`create_prs` の preview は「何を作るか」を、
   `merge_prs` の preview は read-only の `pr view` / `pr checks` で「CI が green なら merge する」
   ことを報告するに留め、`mutated` は false のままにする。
2. **CI pass（CI gate, `merge_prs` のみ）** — PR を merge するのは、その PR の versioned CI
   checks が **すべて green** のときだけである。1つでも failure なら `ci_failed`、pending や
   check が1つも無いなら `ci_pending` として **merge を拒否** する。未知の check state は
   green と見なさない。

`mutated` が true になるのは、`git push` / `gh pr create` / `gh pr merge` を実際に呼んだときだけ
であり、`--approve` 無しでは常に false である。

## 5. gh / git 呼び出し規約

merge runner は次を呼ぶ。各呼び出しは失敗で非0を返し、握りつぶさない。

| phase | 呼び出し | 期待する出力 | 用途 |
|---|---|---|---|
| preflight | `gh --version` | exit 0 | gh 到達性 |
| preflight | `gh repo view <repo> --json nameWithOwner` | `{ "nameWithOwner": "…" }` | repo アクセス |
| preflight | `git rev-parse --verify <base>` | exit 0 | base 解決 |
| create_prs | `git push --set-upstream origin <branch>` | exit 0 | verification pass branch を push |
| create_prs | `gh pr create --repo R --base B --head <branch> --title T --body-file F` | PR URL を stdout | PR 作成 |
| merge_prs | `gh pr view <branch> --repo R --json number,url,state` | `{ "number", "url", "state" }` | PR 発見 |
| merge_prs | `gh pr checks <number> --repo R --json name,state` | `[{ "name", "state" }]` | CI 確認 |
| merge_prs | `gh pr merge <number> --repo R --<method>` | exit 0 | guarded merge |

規則:

- PR body は plan だけから構成する self-contained な内容（objective・受入条件・baseline・
  `Resolves #n`）とし、`<out>/pr-bodies/issue-<n>.md` に artifact として残す。
- `--base` は profile の base（例 `origin/develop`）から先頭 remote 節を除いた branch 名にする。
- CI の green 判定は、check state を pass（`SUCCESS`/`NEUTRAL`/`SKIPPED`）・pending
  （`PENDING`/`QUEUED`/`IN_PROGRESS`/…）・それ以外（failure 扱い）に分け、
  **1件以上 かつ 全て pass** のときだけ green とする。check が0件なら green にしない。
- branch 名は safe-ref 検査（英数・`._/-` のみ、`..` 無し、先頭 `/`・`-` 不可）を通す。

## 6. 停止と status / stop_reason / exit

failure・blocked は途中で **停止** し、`blocking_reasons` と該当 target に記録する。停止後の
eligible は outcome `skipped` として残し、対象集合を隠さない。

| status | 条件 | exit |
|---|---|---|
| `success` | 全 eligible を失敗なく処理（preview を含む） | 0 |
| `partial` | 途中停止（PR 作成失敗・CI failure/pending・PR 不在・merge conflict） | 7 |
| `failure` | 何も試せない（preflight 失敗・plan 不正・invalid input） | 1 |

`stop_reason` は `completed` / `preflight_failed` / `pr_create_failed` / `pr_missing` /
`pr_closed` / `ci_failed` / `ci_pending` / `merge_failed` / `runner_error`。
最初の blocking 条件を採る。**failure を `completed` として報告しない。**

## 7. security（redaction）

token・secret・絶対 path・raw terminal 全量を report/artifact に残さない。PR title・body・
CI check 名・失敗 note・URL は redaction 済みの短い抜粋のみとし、除去した値は `redactions` に
kind と count だけで記録する（値・長さ・伏字は残さない）。

## 8. completion_check（report）

report は5つの check を自己申告する。

| id | 内容 |
|---|---|
| `single_phase` | mutating phase をちょうど1つだけ有効化した |
| `approval_enforced` | `--approve` 無しに mutation していない（`mutated ⟹ approved`） |
| `verification_gated` | 対象がすべて verification pass 済み Issue である |
| `ci_gated` | merge した PR はすべて CI green だった（CI 無しに merge していない） |
| `failures_not_rounded` | 失敗があるとき status を `success` にしていない |

`passed` は5件すべて true、かつ status が `failure` でないときだけ true。

## 9. スコープ外

UAT 修正ループ（[#1456](https://github.com/Kewton/CommandMate/issues/1456)）、Issue 本文の自動編集、
明示承認・CI pass 無しの無条件 merge は **この runner では行わない**。

## 10. version 運用

- field の追加・削除・意味の変更、enum への値追加 → `merge_schema_version` を上げる。
- 文言・見出しの調整のみ → Skill の `version` だけを上げる。
