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
| `--unattended` | 任意 | **off** | この invocation に人間は居ない、という**入力の宣言**（5.3節）。**`--create-prs` でのみ受理**する。`--merge-prs` との併用は `invalid_input`（段階 C 未実装） |
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
| create_prs | `gh repo view <repo> --json defaultBranchRef` | `{ "defaultBranchRef": { "name": "…" } }` | Issue 自動クローズの到達性（invocation あたり1回） |
| create_prs | `git diff --name-only -z <base>...<branch>`（cwd = その Issue の worktree） | NUL 終端の変更 file 一覧 | PR 本文の「実変更」（読めなければ本文に「読めなかった」と書く） |
| create_prs | `git diff --numstat -z <base>...<branch>`（cwd = 同上） | `<added>\t<deleted>\t<path>` の NUL 終端レコード | PR 本文の diff 規模 |
| create_prs | `git push --set-upstream origin <branch>` | exit 0 | verification pass branch を push |
| create_prs | `gh pr create --repo R --base B --head <branch> --title T --body-file F` | PR URL を stdout | PR 作成 |
| merge_prs | `gh pr view <branch> --repo R --json number,url,state` | `{ "number", "url", "state" }` | PR 発見 |
| merge_prs | `gh pr checks <number> --repo R --json name,state` | `[{ "name", "state" }]` | CI 確認 |
| merge_prs | `gh pr merge <number> --repo R --<method>` | exit 0 | guarded merge |

規則:

- PR body は objective・受入条件・**検証証拠**（5.2節）・`Resolves #n` からなる self-contained な
  内容とし、`<out>/pr-bodies/issue-<n>.md` に artifact として残す。
- `--base` は profile の base（例 `origin/develop`）から先頭 remote 節を除いた branch 名にする。
- CI の green 判定は、check state を pass（`SUCCESS`/`NEUTRAL`/`SKIPPED`）・pending
  （`PENDING`/`QUEUED`/`IN_PROGRESS`/…）・それ以外（failure 扱い）に分け、
  **1件以上 かつ 全て pass** のときだけ green とする。check が0件なら green にしない。
- branch 名は safe-ref 検査（英数・`._/-` のみ、`..` 無し、先頭 `/`・`-` 不可）を通す。
- `git diff` は **必ず `-z`** で読む（[#174](https://github.com/Kewton/commandmate-skills/issues/174)）。
  既定の改行区切りでは git が path を C クォートして返す（`core.quotePath` が既定 true なので
  非ASCII バイトは8進エスケープ、`"`・`\`・制御文字はその設定に関係なくクォート）ため、
  plan の `scope.allow`（Issue が書いたままの UTF-8）と突き合わせると**同じ file が一致しない**。
  `-c core.quotePath=false` は非ASCII しか解かない。`-z` は munge を止め、区切りも NUL になるので
  改行を含む path が2件に割れることも無い。PR 本文が引用する command 行も `-z` 付きで書く
  （読み手が同じ command を再実行して同じ path を得られるようにするため）。

## 5.1 Issue 自動クローズの到達性（`Resolves #n` の限界）

GitHub が closing keyword で Issue を閉じるのは、その PR が **デフォルトブランチ** に merge
された時だけである。profile の `base` はデフォルトブランチとは限らず（`feature/* → develop →
stg → main` の運用では `origin/develop`）、その場合 PR body の `Resolves #n` は **効かない**
— PR は merge されるのに Issue は open のまま残る（[#39](https://github.com/Kewton/commandmate-skills/issues/39)）。

`create_prs` phase の冒頭で `gh repo view <repo> --json defaultBranchRef` を **1回だけ** 引き、
PR の base（`baseBranchName(plan.profile.base)`）と比較する。

| 比較結果 | 動作 |
|---|---|
| base ≠ デフォルトブランチ | `limitations[]` に `issue_autoclose_not_default_branch` を記録し、各 PR body に注記を1行足す |
| base = デフォルトブランチ | 何も記録しない |
| 取得失敗 / `defaultBranchRef` 欠落 | **照合をスキップ**する。limitation も blocking も足さず、PR 作成フローを阻害しない |

記録に留める。`gh issue close` を runner が勝手に実行することはしない（「勝手に閉じない」
という製品方針より）。**merge 後のクローズは operator の手作業である。**

## 5.2 PR body の Verification 節 = 検証証拠の提出

worker の完了は「実装結果と**検証証拠を提出する**」ことである。検証そのもの（`wait --verify` の
exit code を一次ソースとし、verification pass だけを merge 対象にすること）は dispatch 側で
済んでいるが、**証拠が人間に届くのは PR 本文だけ**である。そこで Verification 節は定型文を
持たず、当該 Issue の実測値だけで構成する（[#97](https://github.com/Kewton/commandmate-skills/issues/97)）。

| 節 | 内容 | 出どころ |
|---|---|---|
| verdict | `verification.outcome`。`ran: false` なら「検証は走っていない」と明示する | dispatch report の当該 worker（同じ Issue が複数 wave にあれば**最後**の記録） |
| Gates 表 | gate 名 / 合否 / exit code（`gate <id>: <status> (exit n)` 形の check 行から拾える場合。無ければ `—`） | `verification.gates` + `verification.checks` |
| Checks 表 | 記録された check 行そのまま / そこに書かれた exit code | `verification.checks` |
| 宣言 scope vs 実変更 | `scope.allow`（plan の `suspected_files`）と実変更 file の対比表、**scope 外変更の件数** | plan + `git diff --name-only -z <base>...<branch>`（当該 worktree で実行） |
| diff 規模 | 変更 file 数・追加/削除行数 の1行 | `git diff --numstat -z`（同上） |

規則:

1. **転記であって主張ではない。** dispatch report は runner が書いた保証の無い**入力**なので、
   転記値は例外なく `redact()` を通す。redact 済みだと仮定しない。
2. **読めなかったものを pass に丸めない。** diff が読めなければ本文にその事実と理由を書き、
   `limitations[]` に `change_evidence_unavailable` を記録する。「変更なし」とも
   「scope 内に収まっていた」とも書かない。`ran: false` も同様に明示する。
3. **黙って切り詰めない。** gh の本文上限（65536 字）に収めるため gates（30）・checks（15）・
   path（50）の一覧は上限件数で打ち切るが、**打ち切った件数を本文に書く**。本文全体が上限を
   超える場合も、切り詰めた旨の marker を末尾に置く。
4. 実変更が `scope.allow` の外に出ていれば違反 path を本文で名指しし、`limitations[]` に
   `branch_changed_outside_declared_scope` を記録する。契約ゲート `requireScopeClean` の
   人間可読版であり、**phase は止めない**（機械ゲートは上流で既に判定済みである）。
5. scope entry は原則ただの repo 相対 path だが、契約は pattern を許すので `*` / `**` を
   解釈して照合する。pattern を literal として扱うと scope 内の変更を違反と誤報する。

merge-report.json / merge-summary.md の**構造は変えない**。本文と report が食い違わないよう、
上の 2 つの limitation だけを既存の `limitations[]` に足す。

## 5.3 無人運転（`--unattended`。両 phase）

[adr-unattended-mode.md](./adr-unattended-mode.md) 第8節の**段階 B**（`--create-prs`。
[#134](https://github.com/Kewton/commandmate-skills/issues/134)）と**段階 C**（`--merge-prs`。
[#142](https://github.com/Kewton/commandmate-skills/issues/142)）である。dispatch の同名フラグ
（[dispatch-contract.md](./dispatch-contract.md) 第3.0.3節）と**同じ宣言**であり、
runner 間で伝播はしない —— この runner は上流の dispatch が unattended だったかを**検査しない**
（同 ADR 第8節「runner 間で unattended を伝播させない」）。

**`--unattended` は「この invocation に人間は居ない」という入力の宣言であって、
mutation の権限を与えるフラグではない。含意するのは締め付けだけである**（ADR 第2節「裁定 0」）。

| 論点 | 規定 |
|---|---|
| `--approve` との関係 | **含意しない。** `--unattended` だけの invocation は preview であり、push も PR 作成も merge もしない。無人で回す CI は**両方**書く。これにより `approved: true` は「この mutation は明示的に承認された」を意味し続ける |
| `--create-prs` が含意する締め付け | **1つだけ: `change_evidence_unavailable` を limitation ではなく blocking として扱う**（5.2節 規則2 / ADR 第6.5節）。**その Issue の PR を作らずに停止**する（`partial` / exit 7 / `stop_reason: pr_create_failed`・target outcome `pr_failed`）。以降の eligible は `skipped` として残す。**PR 本文（`pr-bodies/issue-<n>.md`）も書かない** —— 作らない PR の本文を残さない |
| `--merge-prs` が含意する締め付け | **1つだけ: 全 eligible Issue が「受入ゲートブロックを持つ」かつ「受入条件を持つ」こと**（ADR 第9節 条件2）。1件でも欠ければ **1つも merge せずに停止**する（`failure` / exit 1 / `stop_reason: preflight_failed`）。**除外ではなく停止**であり、**条件を満たす Issue も merge しない** —— 対象集合を黙って縮めない（第3節・ADR 却下案 C と同じ理由）。読むのは plan だけで、`acceptance_gates.require` が空／欠落なら `acceptance_gates_required`、`acceptance_criteria` が空なら planner と同じ code **`no_acceptance_criteria`** を `blocking_reasons[]` に積む（Issue ごとに1件、**最初の1件で打ち切らない**）。**ゲート id が実在するかは問わない** —— それは worktree を持つ dispatch の問い（`acceptance_gate_id_unknown`）であり、ここで再判定すると既に消えているかもしれない worktree について二番目に悪い意見を出すことになる |
| 昇格しないもの | **`branch_changed_outside_declared_scope`。** 契約ゲート `requireScopeClean` が上流で既に判定しており、unattended dispatch は契約経路を必須にしているので、この limitation は「機械ゲートが通ったうえでの人間可読版」であることが保証される（ADR 第6.5節） |
| phase をまたがないこと | 段階 C の受入条件検査は **`--merge-prs` のみ**に効く。`--create-prs` の締め付けリストは段階 B の1件のままである（後から段階 B の意味を変えない）。fixture で両方向に固定してある |
| 拒否する入力 | dispatch の緩和フラグ（`--auto-yes` / `--allow-questions` / `--contract-mode`）はこの runner に存在しないので、未知 option として `invalid_input`（exit 3）になる。**受理して無視しない** |
| 証跡 | `limitations[]` の **`unattended_mode`**（run 全体で1件。preflight で止まった run にも残る）。**phase ごとに含意した締め付けを detail に書き分ける**（`--merge-prs` の report が `--create-prs` の昇格を語らない）。**絶対 path を書かない**（redaction の tally がフラグ無しの run と食い違うため） |
| 変えないもの | `merge_schema_version` は **1 のまま**。`stop_reason` にも target `outcome` にも**値を1つも足していない**。全 gate が通る世界では、フラグ無しの run と**同じ `status` / `stop_reason` / 作られる PR / merge される PR** になり、差分は `unattended_mode` の1件だけである（両 phase について fixture で機械的に固定してある） |

**`gh` 由来の停止は足していない。** [#115](https://github.com/Kewton/commandmate-skills/issues/115)
の実測（ADR 第14.5節）どおり **`gh pr create` / `gh pr merge` は TTY 非依存で完結する** ——
認証切れも確認プロンプトも gh は待たずに非ゼロで落ち、既存の `pr_create_failed` /
`merge_failed` / `preflight_failed` が受ける。足すべきは停止ではなく**入力の衛生**であり、
無人運転では **job 定義側**で次を置くこと。

- `GH_TOKEN`（または `GH_ENTERPRISE_TOKEN`）
- **`GIT_TERMINAL_PROMPT=0`**

**`git push` の資格情報プロンプトだけは別**で、git は stdin ではなく `/dev/tty` を読むため、
**制御端末を持つ起動元**（tmux ペインから起動した cron、人間の shell）では
`stdio: ['ignore', …]` はプロンプトを止めない —— 「止まる」ではなく**無言で待つ**に化ける唯一の
経路である。**runner はこれを検査しない**（別プロセスの環境を runner は保証できない。
第4節の monitor と同じ理由）。

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

`--unattended` はこの写像を1文字も変えない（ADR 第6.1節）。昇格した
`change_evidence_unavailable` も**既存の `pr_create_failed` で受ける**し、段階 C の受入条件検査は
**既存の `preflight_failed` で受ける**（何も試していないので `failure` / exit 1）——
何が起きたかを名指しするのは `blocking_reasons[]` の code
（`acceptance_gates_required` / `no_acceptance_criteria`）であって `stop_reason` ではない
（dispatch の `wall_clock_budget_exhausted` と同じ形）。**新しい値は足さない。**
`preflight[]` の `code` は schema の閉じた enum なので、この検査は**そこには載らない**
（version を上げないための帰結。ADR 第11節）。

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

**無人 merge（`--merge-prs --unattended`）も現時点ではスコープ外**である。
[adr-unattended-mode.md](./adr-unattended-mode.md) 第8節の段階 C であり、`verification_gates_unrecorded`
の昇格と [#100](https://github.com/Kewton/commandmate-skills/issues/100) 段階1 を前提とする。
実装するまでは `invalid_input` で拒否する（5.3節）。

## 10. version 運用

- field の追加・削除・意味の変更、enum への値追加 → `merge_schema_version` を上げる。
- 文言・見出しの調整のみ → Skill の `version` だけを上げる。
