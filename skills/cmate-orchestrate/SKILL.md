---
name: cmate-orchestrate
description: 複数の GitHub Issue を並列で進める。dry-run で依存と file 衝突を解いた Wave plan を作り、承認後に監督付きで dispatch し、検証 pass したものだけを PR/merge し、UAT で受入を確認する4段の runner。
---

# cmate-orchestrate（plan → dispatch → merge → uat）

> **ランチャー表記** — 本文中の `commandmate …` は**読み替え可能**である。グローバル導入をしない
> npx 運用では `npx commandmate@latest …` と読む。同梱 runner（dispatch / uat）は `--cli <launcher>`
> または環境変数 `CM` で解決する（既定 `commandmate`、`npx commandmate@latest` のようなスペース
> 区切りの複数トークンも可。シェルは経由しないので、パイプ・リダイレクト・変数展開・引用符は
> 助言つきで拒否する）。ランチャー解決は実行時の話であり、**plan.json には混入しない**。呼び出し
> 頻度が高い経路では npx の起動コスト（1 回あたり 0.5〜0.9 秒）を避けるため、
> `~/.local/bin/commandmate` に `exec npx --yes commandmate@latest "$@"` の薄いラッパを置く導入
> 形態を推奨する（README の「CommandMate CLI の導入形態」）。

複数の Issue を並列で進めるための、**計画**・**監督付き実行**・**PR/CI/merge**・
**UAT と回数上限つき修正ループ** を安全に行う手順である。実務は4つの
**deterministic runner**（Node stdlib のみ）が行う。

runner は決定的なので、この文書が述べるのは「いつ使うか・どう呼ぶか・出力をどう読むか・
止まったら何をするか」の4点だけである。**各 runner が何をどう保証しているかの正本は
`references/*-contract.md`** で、この文書はそこへ一方向に参照する。なぜその挙動なのかは
[references/release-notes.md](./references/release-notes.md)。

| runner | script | 役割 | mutation | 契約の正本 |
|---|---|---|---|---|
| plan | `scripts/orchestrate.mjs` | dry-run で Wave plan を生成する。**default invocation** | なし | [plan-contract.md](./references/plan-contract.md) |
| dispatch | `scripts/dispatch.mjs` | 承認済み plan を worker へ配り、Wave barrier と verification gate で監督する | あり | [dispatch-contract.md](./references/dispatch-contract.md) |
| merge | `scripts/merge.mjs` | 検証 pass した Issue を PR 作成 / guarded merge する | あり（承認時） | [merge-contract.md](./references/merge-contract.md) |
| uat | `scripts/uat.mjs` | 受入テストと、不合格時の回数上限つき修正ループ | あり（承認時） | [uat-contract.md](./references/uat-contract.md) |

`scripts/lib.mjs` は4 runner の共有ヘルパーで、単体では起動しない。

## 1. いつ使うか / 使わないか

**使う**: 着手前に Issue 間の依存と file 衝突を解いておきたいとき。複数 Issue を並列に worker へ
配り、前段が壊れていないことを確認しながら段階的に進めたいとき。納品と受入まで同じ gate の下で
通したいとき。

**使わない（スコープ外）**: Issue 本文の自動編集。回数無制限のループ。crash 後の resume /
attempt retry。cross-model review。どの mutating runner も、明示承認・verification pass・
CI pass の gate 無しに mutation を行わない。

## 2. 前提条件

**CLI**: `commandmate`（`>=0.11.0 <1.0.0`）・`git`・`gh`・`node >=22`。宣言している権限は
`filesystem_read` / `filesystem_write` / `process_execution` / `network_access` で、これは
orchestration 全体が要求する集合である（plan にも同じ集合を提示する）。base branch・branch 名・
worktree path・baseline は **profile から解決**し、`develop`/`npm`/`cargo` を hardcode しない
（[profile-contract.md](./references/profile-contract.md)）。

**別途導入が必要な Skill: `cmate-acceptance-test`**（uat の意味ゲートを使う場合のみ）。

```bash
commandmate skill install cmate-acceptance-test
```

未導入でも orchestrate は動くが、**UAT の裁定は機械ゲートだけになる**。その事実は report の
`limitations[]`（`acceptance_not_run`）に記録される（黙って劣化しない）。未導入の環境では
本書中の `../cmate-acceptance-test/...` への相対リンクが解決しない。**リンク切れ自体が
「まだ入れていない」ことのサイン**である。plan / dispatch / merge はこの Skill に依存しない。

---

## 3. 呼び出し方と呼び出し順

**plan → （人間の承認）→ dispatch → merge / uat** の順に、別々の invocation で呼ぶ。
1つの runner が次の phase を勝手に始めることはない。

### 3.1 plan（dry-run。既定の入り口）

```
orchestrate.mjs <issue>... [options]
```

| flag | 既定 | 効果 |
|---|---|---|
| `--issues a,b,c` | — | Issue 番号（positional でも可）。1件以上 |
| `--profile <id>` | `node-commandmate` | 内蔵 profile。`node-commandmate` / `rust-commandagent` |
| `--profile-json <path>` | — | 独自 profile |
| `--issue-json <path>` | — | Issue fixture。offline・決定的に回す |
| `--base <ref>` / `--repo <owner/name>` | profile 由来 | 上書き。**`--repo` は profile の `verified` を降格させる** |
| `--max-parallel <1-3>` | `3` | 1 Wave の最大幅 |
| `--depends <a:b>` / `--no-infer` / `--order <a,b>` | — | 依存の override / 推論無効化 / 順序の主張 |
| `--run-id <id>` | 入力 hash（**Issue 内容を含む**） | run_id の明示 |
| `--runs-dir <path>` | `.commandmate/orchestrate/runs` | artifact の出力先 |
| `--allow-unverified` | off | unverified profile での planning を許可 |

`--issue-json` が無ければ read-only の `gh issue view` で Issue を取得する。これが planner
唯一の network access である。**契約の入力は number / title / body / labels だけで、
コメントは読まれない。** コメントで決めた内容は **dispatch 前に Issue 本文へ畳み込んでから**
plan を作ること（本文の精錬には cmate-issue-refinement が使える）。

`<runs-dir>/<run_id>/` に `plan.json`・`result.json`・`manifest.md`・`issue-analysis.md`・
`dependency-plan.md` を書き、run directory が既にあれば上書きせず `run_exists` で終了する。
既定 run_id は Issue 内容を含む hash なので、**本文を直して再 plan すれば自動的に別 run** になる。
plan は「入力 + cwd の origin」の純粋関数で、**同一入力からは同一 plan が出る**（Claude/Codex
parity）。`--run-id` を固定して2つの `--runs-dir` に出し `plan.json` を `diff` すれば確認できる。

### 3.2 dispatch（監督付き実行）

```
dispatch.mjs --plan <承認済み plan.json> [options]
```

| flag | 既定 | 効果 |
|---|---|---|
| `--plan <path>` | **必須** | planner が出した承認済み `plan.json` |
| `--out <dir>` | `<plan-dir>/dispatch` | artifact の出力先。既存なら `out_exists` |
| `--cli` / `--git` / `--gh <path>` | `commandmate`/`git`/`gh` | 実行する CLI |
| `--auto-yes` | **off** | worker prompt を自動応答する。既定は停止して human へ提示 |
| `--allow-questions` | **off** | 未回答 question を持つ Issue を含む plan を dispatch する |
| `--contract-mode <m>` | `auto` | `auto` / `require`（フォールバック拒否）/ `off`（probe せず baseline 裁定） |
| `--verify-gates <ids>` | 省略＝全ゲート | 契約の `verify.gates` に載せる gate id。**存在しない id を発明しない** |
| `--expect-branch <name>` | — | plan 承認時の統合 branch。不一致なら drift |
| `--wait-timeout <sec>` | `300` | `commandmate wait` の1回あたり timeout |
| `--max-turns <n>` | `8` | 各 worker を駆動する最大ターン数。未 commit で到達なら `failed` |

`commandmatedev` は使わない。公式経路は public `commandmate` である（ADR CommandMate
[#1447](https://github.com/Kewton/CommandMate/issues/1447)）。

呼ぶ前に押さえておく **3つの不変条件**（詳細と根拠は
[dispatch-contract.md](./references/dispatch-contract.md)）:

1. **open question ゲートが最初に効く。** 未回答の planner question を持つ Issue が1件でも
   あれば、**1人も dispatch せずに停止する**。直し方は「Issue 本文に回答を書いて re-plan」。
2. **裁定と完了は別物である。** 裁定の ground truth は `wait --verify` の exit code、完了の
   ground truth は **worktree ブランチの新規 commit** である。worker は各ターン後に idle 化する
   ので、`wait` の idle を完了とみなさない。
3. **Wave barrier と verification gate。** 全 worker が `completed` かつ verification pass に
   なるまで次 Wave へ進まない。**worker completion を verification success と同一視しない。**

契約経路では plan だけから **実行契約 yaml** を決定的に生成して worktree に置き、
`commandmate send <worktree-id> --contract <path>` で dispatch する（**同一 plan → byte-identical
な契約**）。契約非対応の CLI では明示メッセージつきで profile baseline 再実行に落ちるか、
`--contract-mode require` なら停止する。**どちらの裁定機構で判定したかは常に report と summary に
明示される**（黙って劣化しない）。

**監視の一次はこの `wait` ループである**（[cmate-orchestrate-monitor](../cmate-orchestrate-monitor/)
との境界）。契約付き dispatch の裁定と nudge はこの runner が行う: ブロッキングな
`wait --on-prompt agent --verify` の **exit code 分岐**（0 / 10 / 20 / 21 / 99 / 124）で判定し、
`send` / `respond` でサーバ経由で促す。**マージ可否の裁定もここである。** monitor は別機構
（`capture --json` のポーリング分類 + tmux 直接介入）の**サイドカー**で、`wait` に見えない事象
——rate limit / credits バナーからの復帰、リトライ枯渇死の再送、製品の prompt 検出に載らない
プロンプト、契約なし委任や他所から投げた worker、`wait` がブロックしている間の可観測性——の
回収に使う。**統合も廃止もしない。** 併用するなら monitor 側に `--no-auto-approve` を付ける
（prompt に答えてよいかを決めるのは契約の autoYes ポリシーであって監視ループではない）。

### 3.3 merge（PR 作成 / guarded merge）

```
merge.mjs --plan <plan.json> --dispatch <dispatch-report.json> (--create-prs | --merge-prs) [options]
```

**1 invocation で mutating phase をちょうど1つ**だけ有効化する。両方指定・どちらも未指定は
`invalid_input` で拒否する。

| flag | 既定 | 効果 |
|---|---|---|
| `--dispatch <path>` | **必須** | eligible の唯一の根拠 |
| `--create-prs` / `--merge-prs` | どちらか1つ | PR 作成 / CI 確認付き guarded merge |
| `--approve` | **off** | 明示承認。無ければ mutation しない preview |
| `--merge-method <m>` | `squash` | `merge` / `squash` / `rebase` |
| `--out <dir>` | `<dispatch-dir>/<phase>` | 出力先。既存なら `out_exists` |
| `--gh` / `--git <path>` | `gh`/`git` | 実行する CLI |

対象は dispatch report で **`completed` かつ verification `pass`** の Issue **だけ**である
（verification gate の継承）。`--approve` 無しに push・PR 作成・merge は一切しない。
merge するのは CI checks が**すべて green** のときだけで、failure は `ci_failed`、
pending・check 0 件は `ci_pending` として **merge を拒否**する。

#### PR 本文は「検証証拠の提出」である

`create_prs` が書く PR 本文（`<out>/pr-bodies/issue-<n>.md`）の Verification 節は、
**定型文ではなくこの Issue の実測値**である。人間が見るのは PR だけなので、証拠が
run ディレクトリの JSON の中にしか無い状態を残さない。

| 載せるもの | 出どころ |
|---|---|
| verdict（`verification.outcome`）と、走っていない場合（`ran: false`）の明示 | dispatch report の当該 worker |
| gate 名・合否・exit code の表 | 同 `verification.gates` / `checks`（`gate <id>: … (exit n)` から exit を拾う） |
| 宣言 scope（`scope.allow` = plan の対象 file）と実変更 file の対比表、**scope 外変更の件数** | plan の `suspected_files` と、worktree で実行した `git diff --name-only <base>...<branch>` |
| diff 規模（file 数・追加/削除行数）1行 | 同 worktree の `git diff --numstat` |

規則:

- **転記であって主張ではない。** 値は全て `redact()` を通す（dispatch report は入力であり、
  redact 済みだと仮定しない）。
- **読めなかったものを pass に丸めない。** worktree が既に片付いていて diff が読めなければ
  「読めなかった」と本文に書き、limitation `change_evidence_unavailable` を記録する。
  `ran: false` の verdict も同様に「検証は走っていない」と明示する。
- **黙って切り詰めない。** gh の本文上限（65536 字）に収めるため gates/checks/path の一覧は
  上限件数で打ち切るが、**打ち切った件数を本文に明記する**。
- 実変更が宣言 scope の外に出ていれば本文でその path を名指しし、limitation
  `branch_changed_outside_declared_scope` を記録する（契約ゲート `requireScopeClean` の
  人間可読版。phase は止めない）。

merge-report.json / merge-summary.md の構造は変わらない。

### 3.4 uat（受入テストと回数上限つき修正ループ）

```
uat.mjs --plan <plan.json> --dispatch <dispatch-report.json> (--write-uat | --create-uat-fix-worktrees) [options]
```

こちらも **1 invocation で phase をちょうど1つ**である。

| flag | 既定 | 効果 |
|---|---|---|
| `--write-uat` / `--create-uat-fix-worktrees` | どちらか1つ | read-only の受入判定 / 修正ループ |
| `--approve` | **off** | fix loop の明示承認。無ければ preview |
| `--max-attempts <1-5>` | `2` | fix 試行の回数上限。ループはこれを超えない |
| `--acceptance-dir <dir>` | — | 意味ゲートの入力（`issue-<n>.json`）を置いた directory |
| `--require-acceptance` | off | result の欠落・不適合・Issue 不一致を limitation ではなく**不合格**にする |
| `--out <dir>` | `<dispatch-dir>/<phase>` | 出力先。既存なら `out_exists` |
| `--cli` / `--git` / `--gh <path>` | `commandmate`/`git`/`gh` | 実行する CLI |

裁定は **機械ゲート（profile baseline）+ 意味ゲート（受入条件の Go / Conditional Go / No-Go）の
二層**である。**意味ゲートの判定を出すのはエージェント側の手順であり、uat runner は result
document を検証して合成するだけである**（runner 内で LLM 判定はしない）。合成規則の全表は
[uat-contract.md](./references/uat-contract.md) 第4.2節。

**意味ゲートを使うときのエージェント手順**（uat runner を呼ぶ前に行う）:

1. eligible 集合を dispatch report から取る（`worker_state: completed` かつ
   `verification.outcome: pass`）。
2. 各 Issue について [cmate-acceptance-test](../cmate-acceptance-test/) を、`issue_ref` = その
   Issue、`target_ref` = その Issue の **worktree**、`result_path` =
   `<acceptance-dir>/issue-<n>.json` で実行する。Issue 本文は read-only で取得する（**書き戻さない**）。
3. 出力が [`acceptance-result.v1`](../cmate-acceptance-test/schemas/acceptance-result.v1.json)
   に適合し、`target.issue_ref` がその Issue を指していることを確認する。
   **別 Issue の result を流用しない。**
4. その directory を `--acceptance-dir` として渡す。必須にするなら `--require-acceptance` も渡す。

生成できない Issue があるときに、他 Issue の result を代用したり判定を推測で書いたりしては
ならない。**生成できなかったこと自体が記録すべき事実**である（runner が `acceptance_not_run`
として記録する）。

---

## 4. 出力の読み方

4 runner とも、機械可読な envelope / report を **stdout** に、進捗 notice を **stderr** に出す。
mutating runner は `<out>/` にも report と summary markdown を書く。

### status

| status | 意味 | exit |
|---|---|---|
| `success` | 全部通った（preview・no-op を含む） | 0 |
| `partial` | 途中停止、または warning つきで完走した | plan は 0 / 他は 7 |
| `blocked` | **uat のみ。** fix 上限到達でなお不合格が残る（成功に丸めない） | 8 |
| `failure` | 何も試せない・1件も dispatch できない | plan は code 依存 / 他は 1 |

**plan の exit code は `partial` でも 0 である。成否は exit code ではなく `status` と
`warnings` で判断すること。** planner は warning が1件でもあれば `success` にしない。

### plan の失敗 code と exit

| 状況 | code | exit |
|---|---|---|
| Issue 番号が無い / 引数不正 / max-parallel 範囲外 | `invalid_input` | 3 |
| mutating phase 指定（実行は dispatch runner の担当） | `not_implemented` | 2 |
| unverified profile（`--allow-unverified` 無し） | `unverified_profile` | 3 |
| Issue / profile / fixture が読めない | `load_error` | 6 |
| 依存 cycle / 不完全 override / 順序違反 | `cycle_detected` / `override_incomplete` / `dependency_order_violation` | 5 |
| run directory が既存 | `run_exists` | 4 |

失敗時も stdout に `status: failure` の result を出す。**plan を推測で埋めない。**

### plan の warning code（1件でも出れば `partial`）

| code | 意味 |
|---|---|
| `profile_repository_mismatch` | 既定 profile の対象リポジトリが cwd の `origin` と一致しない |
| `profile_repository_override` | `--repo` でリポジトリを差し替えたため profile の検証が対象を失った |
| `external_dependency` | この plan に含まれない Issue への依存を宣言している |
| `ambiguous_dependency_direction` | 1行に順方向と逆方向の方向語が同居し、依存の向きを一意に読めない |
| `no_acceptance_criteria` | 受入条件を1件も読み取れない。何をもって完了かが宣言されていない |
| `no_suspected_files` | 対象 file を1件も読み取れない。worker に与える scope が空になる |
| `unrecognized_file_extension` | 既知拡張子外の backtick path が抽出から落ちた |
| `shadowed_file_candidate` | 他候補の path 境界つき suffix だったため候補から落とした |

`no_acceptance_criteria` / `no_suspected_files` は dispatch の open question ゲートと対になる。
**この2つを放置したまま `--allow-questions` で押し通さないこと。**

### limitation code（停止はしていないが、後から効いてくる制約）

| code | runner | 意味 |
|---|---|---|
| `contract_unsupported` | dispatch | CLI が実行契約に非対応で、より弱い baseline 裁定に落ちた |
| `contract_disabled` | dispatch | `--contract-mode off` を明示したため probe していない |
| `contract_scope_unknown` | dispatch | 対象 file が空の Issue を dispatch しなかった（その wave は advance しない） |
| `open_questions_accepted` | dispatch | `--allow-questions` で未回答 question を引き受けた |
| `auto_yes_used` | dispatch | `--auto-yes` で prompt を自動応答した |
| `parallelism_truncated` | dispatch | wave が `max_parallel` より広かったので上限で切った |
| `unsafe_worktree_target` | dispatch | worktree path が path-escape guard に弾かれた |
| `verification_unrecorded` | dispatch | completed した worker に裁定が1つも記録されなかった（runner 側の欠陥。`verification_recorded` completion check も落ちる） |
| `verification_gates_unrecorded` | dispatch | verification は pass だが `GATE` 行を読めず、pass の根拠となった gate を report が名指しできない |
| `drift_<check>` | dispatch | 非 blocking な drift（`integration_clean` / `worktrees_present`）を記録して続行した |
| `issue_autoclose_not_default_branch` | merge | base がデフォルトブランチでないため `Resolves #n` が効かない。**merge 後に手動クローズが要る** |
| `unsafe_branch` | merge | branch 名が safe-ref guard に弾かれた |
| `change_evidence_unavailable` | merge | branch の実変更 file を読めなかった（worktree 不在など）。PR 本文もそう書く。**scope 内に収まっていた証拠ではない** |
| `branch_changed_outside_declared_scope` | merge | 実変更に宣言 scope（`scope.allow`）外の file がある。PR 本文が違反 path を名指しする |
| `acceptance_not_run` | uat | 意味ゲートが verdict を出せず、baseline のみで裁定した |
| `no_eligible_issues` | merge / uat | dispatch report に completed かつ verification pass の Issue が無い |
| `completion_check_failed` | dispatch / merge / uat | completion check のどれかが passed でない |

`conditional_go` の保持（`acceptance_conditional`）と fix 上限到達（`max_attempts_reached`）は
limitation ではなく **stop_reason / blocking reason** である。**停止であって、続行しながらの
注記ではない。**

### completion check

各 runner は report に completion check を自己申告する（plan 5件 / dispatch 6件 / merge 5件 /
uat 6件）。**いずれかが false なら `status` は `success` にならない。** 項目は各正本の
「completion_check」節にある。token・secret・絶対 path・raw terminal は
report/artifact に残さない（redaction）。

---

## 5. 停止したとき、人間が何をするか

**runner が止まったら、それは「押し通す」合図ではなく「読む」合図である。**
`blocking_reasons` の code と `summary_markdown` を読み、次の対応を取る。

| 止まり方 | 何が起きたか | 人間がすること |
|---|---|---|
| plan `status: partial` + `no_acceptance_criteria` / `no_suspected_files` | Issue に受入条件か対象 file が書かれていない | **Issue 本文に書き足して re-plan する。** run_id は本文を含む hash なので自動的に別 run になる |
| plan `cycle_detected` / `override_incomplete` / `dependency_order_violation` | 依存グラフが実行不能 | `dependency-plan.md` の edge `reason`（どの方向語をどの行から読んだか）を見て、Issue 本文か `--depends` を直す |
| plan `run_exists` | 入力が完全に同一の再実行 | 本文を直すか、`--run-id <new-id>` / `--runs-dir <dir>` を渡す |
| plan `profile_repository_mismatch` | cwd の origin と profile の対象リポジトリが違う | `--profile` / `--profile-json` / `--repo` のどれかを渡して意図を明示する |
| dispatch `open_questions` + `human_required` | 未回答の question を持つ Issue がある | blocking reason に**質問の本文**が出ている。Issue 本文に回答を書いて re-plan する |
| dispatch `drift` | plan 承認後に branch / HEAD / 権限が動いた | drift の内容を確認し、必要なら re-plan する。**drift の上に dispatch しない** |
| dispatch exit 10（prompt 検出） | worker が人間の判断を求めている | `capture` の内容が report に出ている。**自分で判断して答える。** runner は自動応答しない |
| dispatch `verification_not_judged`（exit 99） | run が error / cancelled で**誰も判定していない** | **再 dispatch では解けない。** CommandMate 側のログを見る。判定していないものを worker に直させない |
| dispatch `worker_failed`（`--max-turns` 到達で未 commit） | worker が commit まで到達しなかった | prompt / worker ログを読む。指示が過大なら Issue を分割して re-plan する |
| dispatch `contract_unsupported` + `require` | CLI が実行契約に非対応 | CommandMate を 0.17.0 以上に上げるか、弱い裁定を承知のうえで `auto` に落とす |
| merge `ci_failed` / `ci_pending` | CI が green でない | CI を直す。**green 無しに merge しない** |
| merge `pr_missing` / `merge_failed` | PR が無い / conflict | PR の状態を確認し、conflict は手で解消する |
| merge `issue_autoclose_not_default_branch` | base がデフォルトブランチでない | merge 後に **Issue を手動でクローズする** |
| uat `acceptance_conditional` | 受入判定が `conditional_go` | **条件を読んで人間が判断する。** 自動修正の対象ではない |
| uat `blocked` / `max_attempts_reached` | 上限まで直しても不合格 | `unresolved_issues` と `next_actions` を読む。**success に丸めない** |
| uat `acceptance_not_run` | 意味ゲートを掛けずに baseline だけで裁定した | cmate-acceptance-test を入れて result を用意し、必要なら `--require-acceptance` で必須にする |

## 6. 参照

**契約の正本**（この文書と食い違ったら正本が優先する）— 第3節の runner 表からもリンクしている
4つの `*-contract.md` に加えて:

- [references/profile-contract.md](./references/profile-contract.md) — profile の形と unverified の扱い
- [references/agent-compatibility.md](./references/agent-compatibility.md) — Agent 差異と fallback
- [references/release-notes.md](./references/release-notes.md) — なぜその挙動なのか（経緯）

**機械検証用 schema** — `schemas/` に
[execution-plan.v1](./schemas/execution-plan.v1.json)（plan）・
[orchestrate-result.v1](./schemas/orchestrate-result.v1.json)（planner envelope）・
[dispatch-report.v1](./schemas/dispatch-report.v1.json)・
[merge-report.v1](./schemas/merge-report.v1.json)・
[uat-report.v1](./schemas/uat-report.v1.json)。意味ゲートの入力は
[acceptance-result.v1](../cmate-acceptance-test/schemas/acceptance-result.v1.json)（別 package）。
