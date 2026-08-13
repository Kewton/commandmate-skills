# cmate-orchestrate の評価

`skills/cmate-orchestrate/` の計画コア（dry-run runner）を、決定的な fixture に対して
検証するための一式である。GitHub には一切触れない。

```
cases/<case-id>/issues.json     planner に渡す Issue fixture（オフライン）
cases/<case-id>/case.json       引数と、機械で判定できる期待値
cases/<case-id>/expected-plan.json  （任意）golden な plan。byte 一致で照合
dispatch-cases/<id>/case.json   plan 生成引数・scenario・dispatch 期待値
dispatch-cases/<id>/scenario.json  fake CLI に注入する worker/verify/drift の挙動
dispatch-cases/<id>/contracts/  （契約 case のみ）生成された実行契約の golden。byte 一致で照合
dispatch-cases/issues-multifile.json  複数 file を保有する Issue fixture（契約決定性の case 用）
dispatch-cases/issues-negative-constraints.json  否定的制約（禁止の表・非対象節）を持つ Issue
                                fixture（#176 の転記 case 用）
dispatch-cases/issues-acceptance-gates*.json  受入ゲート case の Issue fixture（ブロック有り / 無し / 未知 id）
resume-cases/<id>/case.json     複数 attempt を1つの run directory に append する case。
                                `--resume`（再 dispatch）と `--reverify`（送らずに再裁定）の両方が
                                ここに入る: attempt の配置規約・append-only 不変条件・台帳・
                                整合性ガードが同じものだからである
resume-cases/<id>/attempt-N.json  attempt ごとに fake CLI へ注入する世界
merge-cases/<id>/case.json      plan/dispatch 生成・merge scenario・merge 期待値（scenario は inline）
uat-cases/<id>/case.json        plan/dispatch 生成・uat scenario・UAT/修正ループ 期待値（scenario は inline）
status-cases/<id>/case.json     status view の期待値（phase 状態・Issue ごとの値・次アクション）
status-cases/<id>/run/          checked-in の run directory。実 runner の出力をそのまま置いた status の入力
profile-init-cases/<id>/repo/   profile-init に読ませる小さな fixture リポジトリ
profile-init-cases/<id>/case.json           provenance source・todo/warning code の期待値
profile-init-cases/<id>/expected-profile.json  golden な draft profile。byte 一致で照合
fake-cli.mjs                    commandmate/git/gh を模した stub（failure injection）
profiles/                       独自 profile の例（unverified）
run_tests.mjs                   fixture test harness（Node stdlib のみ）
rubric.md                       人が見る採点基準
```

`catalog/` にも release `scripts/` にも触れない。ここにある `.mjs` は
release pipeline の一部ではなく、この Skill の評価専用である。

## 実行

```bash
node tests/fixtures/cmate-orchestrate/run_tests.mjs
```

依存が無く、いつ実行しても同じ結果になる。harness は各 case について次を確かめる。

- exit code と `status` が期待どおりであること
- result envelope が `orchestrate-result.v1.json` に適合すること
- 成功時、plan が `execution-plan.v2.json` に適合すること
- Wave・merge 順・依存 kind・classification・risk が期待どおりであること
- どの Wave も `max_parallel` を超えず、file 重複 pair を含まないこと
- **同じ入力から同じ plan が出ること**（2回実行して byte 一致）
- golden がある case では、plan が checked-in の期待値と byte 一致すること
- `warning_codes` を宣言した case では、warnings の code 列がその集合と完全一致すること
  （`plan.warnings` と `result.warnings` の一致も確認する）
- `questions_count` / `questions_include` を宣言した case では、`issues[].questions` の**件数**と
  **含む文字列**が期待どおりであること。dispatch が読むのは `warnings` ではなくこの field であり、
  推論由来の question（`acceptance_requires_tests_but_scope_has_none`, #145）は判定の元になった
  受入条件を**原文で**載せるので、件数と原文の両方を固定する

case.json に `cwd` があると、harness は使い捨ての working directory を作ってそこで planner を
起動する（`{"git": true, "origin": "<url>"}` なら `git init` + `remote add origin`、
`{"git": false}` なら git リポジトリでない素の directory）。既定 profile は cwd の `origin` を
照合するため、cwd は plan の入力の一部である（Issue #36）。決定性の 2 回目も同じ cwd で回す。
`cwd` を持たない case は harness 自身の directory で動き、profile を明示するので照合に入らない。

harness 自身の健全性も見る（`validator self-test`）: 壊れた plan を schema validator が
実際に落とせることを確認する。何でも通す validator は何も検証していないのと同じである。

## case 一覧

| case | 何を見るための case か |
|---|---|
| `01-independent` | 依存も conflict も無い3件が1 Wave に収まるか |
| `02-explicit-dependency` | 本文の `Depends on #N` を explicit 依存として2 Wave に割るか（golden 照合つき） |
| `03-inferred-dependency` | contract 生産者と消費者を inferred 依存として結ぶか |
| `04-file-conflict` | 同一 file を触る2件を、依存が無くても同一 Wave に置かないか |
| `05-cycle` | 相互依存を cycle として拒否するか |
| `06-override-incomplete` | 集合外を指す override を不完全として拒否するか |
| `07-unverified-profile` | unverified profile を確認なしで拒否するか |
| `08-unverified-allowed` | `--allow-unverified` で plan を出し、risk を high にするか |
| `09-no-infer` | `--no-infer` で推論依存を抑止できるか |
| `10-default-profile-repo-mismatch` | 既定 profile が cwd の origin と食い違うとき warning + `partial` にするか（#36） |
| `11-default-profile-repo-match` | origin が一致するとき従来どおり warning 無しの success か（#36） |
| `12-default-profile-cwd-not-git` | cwd が git リポジトリでないとき照合をスキップして success のままか（#36） |
| `13-repo-override-unverified` | `--repo` が `verified` を降格させ、確認なしでは拒否するか（#36） |
| `14-repo-override-allow-unverified` | `--allow-unverified` 時に降格が plan（verified/risk/warning）に見えるか（#36） |
| `28-acceptance-gates-block` | ```acceptance-gates ブロックが `acceptance_gates` に載るか。ブロック有無の**双子 Issue**で `test_expectations` が byte 一致するか（#114 Phase 0-3: strip しないと本ブロックの終了 fence が後続 ```bash の開始として拾われ、3件が1件に落ちる） |
| `29-acceptance-gates-invalid` | 2個・未知 version・不正 id・空ブロックを `acceptance_gate_block_invalid` として open question にし、**「ブロックが無かった」に丸めない**か |
| `30-acceptance-gates-unsupported` | `gates:`（段階2の新規コマンドゲート）を黙って無視せず `acceptance_gate_block_unsupported` で止めるか |

## dispatch case 一覧

`dispatch-cases/<id>/` は、まず plan を生成し、その plan を `dispatch.mjs` に渡して
`fake-cli.mjs`（`commandmate`/`git`/`gh` を模した stub）に対して監督ループを回す。
`scenario.json` が worker の挙動・verification・drift を注入する。worker は各ターン後に
idle 化し（`wait` は exit 0 を返す）、`commit_on`（既定 1）ターン目に「commit」する
（`git rev-parse HEAD` の SHA が進む）モデルで、runner が **idle を完了と誤認せず新規 commit を
完了判定**にすることを検証できる（#1468）。`confirm_after` は送信直後の `capture` で「まだ動いて
いない」と見せ、送信確定（再送）の経路を試せる。`fake-cli.mjs` は各呼び出しを `CMATE_FAKE_LOG` に
JSONL で記録するので、`respond` が呼ばれていないことや `send`（初回 + nudge）の回数まで検証できる。

**実行契約（#1588）**: `cli_contract: true` の scenario は CommandMate 0.17.0 相当の CLI を模し、
`send --contract` / `wait --verify` / `verify --json` を受け付け、`<sub> --help` にもそれらを載せる。
false（既定）の scenario は逆にそれらを**拒否**し `--help` からも隠すので、runner のバージョンゲートと
フォールバックが実際に効いているかを試せる。契約経路の裁定は `verify_exits`（ターンごとに消費する
exit code の列。`0` / `20` / `21` / `99`）で、`failed_gates` が `commandmate verify --json` の
失敗ゲートになる。

**Issue 本文（#176）**: dispatch runner は task text を作るとき `gh issue view <n> --json body` を
呼んで本文の否定的制約を原文転記する。plan は本文を運んでいないので、fake `gh` が返す本文は
**その plan を作った issue fixture そのもの**でなければならない（違う本文を返す fake に対して
契約 golden を pin しても、何も pin していない）。harness は plan 生成時に `issue-bodies.json` を
plan の隣へ書き、dispatch 実行時にそれを `scenario.gh.issues` として fake へ渡す —— case ごとの
ノブにすると、書き忘れた case が plan と食い違う本文を配ることになるからである。scenario が自分で
`gh.issues` を宣言すればそちらが勝つ（plan 承認後に本文が動いた世界のモデル）。
`gh.issue_view: "fail"` は読めない世界（未認証 / 網なし / `gh` 未 install）を注入する。

**受入ゲート（#114）**: `verify_exits` は「fake がこう答えろと言われた」でしかないので、
**受入ゲートが何かを測っている証拠にはならない** — 成果物が壊れていようがいまいが 20 を返す。
**時間（#122）**: scenario の `delay_ms`（`{"wait": 900, "send": 300}`。subcommand ごとの
ミリ秒）は、その subcommand を**実時間だけ遅らせる**。実 CLI では `wait` は worker の1ターン、
baseline はリポジトリのテスト一式だが、ローカルの fake ではどちらも 0 秒に潰れるので、
これが無いと wall-clock budget の case は「到達しない budget」を測ることになる。

**排他 lock（#122）**: dispatch runner は `--unattended` のとき worktree ごとの lock を取る。
harness は run ごとに `CMATE_ORCHESTRATE_LOCK_DIR` を work ディレクトリ配下へ向けるので、
case 同士も、開発機の実 run も巻き込まない（`unattendedLockTest` だけが**共有の**根を渡して
2本目の衝突を作る）。

そこで受入ゲートの case だけは `run_declared_gates: true` を使う。この scenario では fake が
本物と同じことをする: worktree の `.commandmate/verify.yaml` を読み、各ゲートの command を
その worktree で `sh -c` で**実際に実行し**、exit status から PASS/FAIL と run の verdict を
導く（契約が `verify.gates` を宣言していればその id だけを走らせる）。worktree の中身は
scenario の `worktree_files`（`{"<相対 path>": "<内容>"}`）が作る。
これで**二点測定の差分が成果物そのものになる**: 緑 run と赤 run は同じ Issue・同じ契約・
同じ verify.yaml で、違うのは worktree に成果物があるかどうかだけである（ADR 第4節 (2)）。契約 case では生成された契約を `contracts/` の golden と byte 比較し、さらに
**同じ plan で 2 回目の dispatch を回して byte 一致**を確かめる（決定性）。1 file しか持たない Issue では
並びを崩す変異を検出できないため、決定性の case は `issues-multifile.json`（1 Issue に 3 file）を使う。

| case | 何を見るための case か |
|---|---|
| `d01-two-waves-success` | 全 worker 完了（commit 検出）・全 verification pass で2 Wave を通過し success になるか |
| `d02-max-parallel` | `max_parallel` を超えて dispatch しないか（幅 2 の上限を守るか） |
| `d03-worker-failed-barrier` | 前 Wave の worker 失敗時に後続 Wave を dispatch しないか（barrier） |
| `d04-verification-failed-gate` | 完了しても verification 失敗なら success にせず後続を止めるか（gate） |
| `d05-prompt-human-required` | prompt 検出時に自動応答せず human-required で停止し、excerpt を redaction するか |
| `d06-drift-refuses-dispatch` | mutation 前の drift（base 未解決）で1件も dispatch しないか |
| `d07-auto-yes-respond` | `--auto-yes` 明示時のみ `respond` で応答して継続し、auto-yes 使用を記録するか |
| `d08-nudge-until-commit` | idle だが未 commit の worker を継続 nudge で駆動し、3ターン目の commit を完了判定にするか（#1468） |
| `d09-blocked-max-turns` | 永遠に未 commit の worker を `--max-turns` 到達で failed とし、idle を完了と誤認しないか（#1468） |
| `d10-send-confirm` | 送信未確定（Enter 未送信）を `capture` で検出して1回だけ再送し、その後 commit まで駆動するか（#1468） |
| `d11-worktree-path-mismatch` | 登録 path が plan template と違っても branch で解決し、git 操作を同じ worktree に向けるか（#1473） |
| `d12-parallel-supervision` | Wave 内の worker を逐次でなく並行に監督するか（send の crossover で確認、#1474） |
| `d13-contract-verified-pass` | 契約を決定的に生成して配置・`send --contract` し、`wait --verify` の exit 0 を裁定とし task id を記録するか（#1588） |
| `d14-contract-verify-failed` | exit 20 で `commandmate verify --json` から失敗ゲートを特定して再指示し、上限到達でも success に丸めないか |
| `d15-contract-not-started` | exit 21 を pass に丸めず nudge し、上限到達で dispatch 失敗系（failed）とするか |
| `d16-contract-prompt-halts` | 契約経路でも exit 10 を自動応答せず human 提示で停止するか（`--on-prompt agent` を渡していること） |
| `d17-contract-no-verdict` | **exit 99 を 20 の再指示ループへ流さず**、`not_run` として human へ上げるか（本 Issue の中心規則） |
| `d18-contract-fallback-unsupported` | 契約非対応 CLI で明示メッセージつきに baseline 裁定へフォールバックするか（黙って劣化しない） |
| `d19-contract-required-refuses` | `--contract-mode require` がフォールバックを拒否し、1件も dispatch せず failure で止まるか |
| `d20-contract-mode-off` | 契約対応 CLI でも `--contract-mode off` で従来裁定を選べ、その選択を limitation に残すか |
| `d37-acceptance-gate-pass` | 受入ゲートの**適合側（緑）**。`require` した id が実在し、fake CLI が worktree の verify.yaml のゲートを**実際に実行**して通る。契約に `verify:` key は書かれず、由来は `origin: issue` / `repo` に分かれる |
| `d38-acceptance-gate-mutation` | 同じ**変異側（赤）**。d37 と Issue も契約も verify.yaml も同一で、違いは worktree から成果物が消えていることだけ。赤の理由も固定する（exit 20 であり、失敗ゲートに当該 id が名指しで含まれ、その exit は 1） |
| `d39-acceptance-gate-id-unknown` | `require` した id が verify.yaml に無い Issue を **`send` の前に**拒否し、実在する id を列挙して止めるか |
| `d40-acceptance-gate-absent-non-regression` | ブロックを持たない Issue の契約が従来どおりか。d37 と同じ worktree・同じ deliverable で本文からブロックだけ抜いた双子（golden が byte で固定） |
| `d41-acceptance-gate-command-missing` | ゲートのコマンドが起動不能（binary 不在→exit 127）のとき赤になり、report がその事実を名指しするか。**この case を d38 の変異側に流用してはならない**（打ち間違えた偽ゲートは成果物が正しくても 127 で赤くなる） |
| `d42-acceptance-gate-union` | `--verify-gates` と Issue の `require:` の**和集合**（sort + 重複除去）を契約に書くか。素朴な書き出しは lint を止め、operator の列挙をそのまま使うと Issue の要求が落ちる |
| `d43-acceptance-gates-not-enforceable` | 実行契約の無い run（`--contract-mode off`）で受入ゲートを宣言した Issue を dispatch しないか（裁定に運ぶ口が無いので fail-closed） |
| `d49-unattended-two-waves-parity` | **無人運転の二点測定（#122）。** 同じ世界を `--unattended` 有り／無しで2回 dispatch し、`status` / `stop_reason` / `waves[]` / `drift_checks` / `blocking_reasons` / `completion_check` / `redactions` が**一致**し、差分は limitation の `unattended_mode` / `unattended_baseline` **だけ**であることを assert する（「緩めない」の機械的証明。self-report の boolean より強い） |
| `d50-unattended-prompt-halts` | 無人でも prompt（exit 10）で止まり、`respond` を送らず `human_required: true` のままか。**無人だから human_required を false にする、はしない** |
| `d51-unattended-not-judged` | 無人でも exit 99 を pass に丸めず、20 の再指示ループにも流さないか。フラグ無しの run との二点測定つき |
| `d52-unattended-open-questions` | 未回答 question を持つ plan を pre-flight で拒否し、**`--out` を作らない**か（フラグ無しの run は従来どおり `--out` を作って停止する）。`--allow-questions` の案内を出さないことも固定する |
| `d53-unattended-scope-preflight` | scope を宣言できない Issue を含む plan で、**worktree を1つも probe せず・1人も dispatch せず・`--out` も作らずに** all-or-nothing で止まるか。`contract_scope_unknown` が limitation ではなく blocking であること |
| `d54-scope-refused-without-unattended` | **d53 の対（二点測定のフラグ無し側）。** 同じ plan・同じ世界で、`--unattended` 無しなら他 Issue は従来どおり dispatch される（＝ d53 の停止は新しい拒否ではなく**検出時点を早めた**もの）ことを示す |
| `d55-unattended-contract-required` | `--contract-mode` を渡していないのに `require` が含意され、契約非対応 CLI が limitation ではなく blocking になるか（scope 必須化と契約必須化は同義） |
| `d56-unattended-wall-clock-budget` | `--wall-clock-budget` 到達で `partial` / `stop_reason: timeout` になり、**`stop_reason` の enum に新値を足していない**か。`scenario.delay_ms` で `wait` / `send` に実時間を持たせている |
| `d73-constraints-transcribed-verbatim` | **否定的制約の原文転記（#176）。** 否定語を含まない見出しの下に在る「送ってはいけない」表と `## 非対象` 節が、要約されず**全行原文で** goal に載るか。転記が完走したので切り捨ての1行は入らない |
| `d74-constraints-untranscribed` | 転記が上限に収まらなかったとき、**ブロックを途中で切らず**に打ち切り、落とした節を名指しして `本文に他節がある。gh issue view <n> で全文を読め` を入れ、`issue_constraints_untranscribed` を記録するか（#176） |
| `d75-issue-body-unreadable` | `gh issue view` が落ちる世界で dispatch は止まらないが、goal が「読めなかったこと」と `gh issue view <n>` を名指しし、`issue_body_unreadable` を記録するか。**「制約なし」の goal を黙って送らない**（#176） |

## merge case 一覧

`merge-cases/<id>/` は、まず plan を生成し、次にその plan を `dispatch.mjs` に通して
`dispatch-report.json` を作り（plan→dispatch→merge の handoff を実証）、その report を
`merge.mjs` に渡して1つの mutating phase（`--create-prs` か `--merge-prs`）を `fake-cli.mjs`
（`gh`/`git` を模した stub）に対して実行する。case.json に inline した `merge_scenario` が
PR 作成・CI・merge の挙動を注入する。`fake-cli.mjs` は各呼び出しを `CMATE_FAKE_LOG` に記録
するので、`--approve` 無しに `git push`/`gh pr create`/`gh pr merge` が呼ばれていないこと、
CI が green でないときに `gh pr merge` が呼ばれていないことまで検証できる。

| case | 何を見るための case か |
|---|---|
| `m01-create-prs-approved` | 承認ありで verification pass branch を push し PR を作成し success になるか |
| `m02-create-prs-preview` | `--approve` 無しで push/PR 作成をせず preview に留まるか |
| `m03-create-pr-fails` | PR 作成失敗（injection）で partial 停止し、後続を skip するか |
| `m04-merge-prs-approved` | 承認あり・CI green で PR を merge し success になるか |
| `m05-merge-prs-preview` | `--approve` 無しで CI を read-only 確認し merge しないか |
| `m06-merge-ci-fails` | CI failure（injection）で merge を拒否し partial 停止するか |
| `m07-merge-conflict` | CI green でも merge conflict（injection）で partial 停止するか |
| `m08-merge-ci-pending` | CI pending を pass 扱いせず merge を拒否するか |
| `m09-merge-pr-missing` | PR が無い eligible で merge を捏造せず partial 停止するか |
| `m10-preflight-gh-unavailable` | gh 不在の preflight で何も試さず failure になるか |
| `m11-no-eligible` | verification pass が無いとき no-op success（mutation なし）になるか |
| `m12-single-phase-guard` | `--create-prs` と `--merge-prs` の同時指定を invalid_input で拒否するか |
| `m13-base-not-default-branch` | base がデフォルトブランチでないとき `Resolves #n` の無効を limitation と PR body に記録するか（#39） |
| `m14-base-is-default-branch` | base がデフォルトブランチのとき何も記録しないか（#39） |
| `m15-default-branch-unknown` | `gh repo view` 失敗時に照合をスキップするだけで PR 作成を阻害しないか（#39） |
| `m21-pr-body-nonascii-path` | 非ASCII を含む path で、対比が git の**表記**でなく path そのもので行われるか（#174）。fake の `git diff` は本物と同じく出力を munge する（`core.quotePath` 既定 true で非ASCII を8進エスケープ、`"` は設定に関係なくクォート）ので、`-z` を使わない runner は同じ file を2行に割り `Out-of-scope changes: 1` を立てる。宣言 scope が日本語ファイル名の #300 は 0 件・表1行、宣言外の変更を持つ #301 は 1 件を**読める形で**名指し（空振り防止）。#301 の宣言外 path が `"` を含むので、最小修正 `-c core.quotePath=false` へ後退しても赤になる |

## uat case 一覧

`uat-cases/<id>/` は、plan と `dispatch-report.json` を生成した後、その report を `uat.mjs` に渡して
1つの phase（`--write-uat` か `--create-uat-fix-worktrees`）を `fake-cli.mjs` に対して実行する。
`uat_scenario` が UAT の合否（`fix_on` で attempt ごとに変える）、fix worker の挙動（`commit_on` で
completed までのターン数を、`state` で prompt/timeout/failed を注入）、fix worktree 作成の可否、
再merge の conflict を注入する。fix worker も dispatch worker と同じく idle を完了とみなさず **新規 commit**
を完了判定に使う（#1468）。`fake-cli.mjs` は各呼び出しを `CMATE_FAKE_LOG` に記録するので、preview で
worktree 作成・fix dispatch・再merge が呼ばれていないこと、修正ループが上限で停止（回数無制限でない）
していること、attempt 履歴が上書きでなく append されていること、fix worker の `send`（初回 + nudge）
回数まで検証できる。

| case | 何を見るための case か |
|---|---|
| `u01-write-uat-all-pass` | write_uat が read-only で UAT を実行し、全 pass で mutation なし success になるか |
| `u02-write-uat-fail` | write_uat が UAT 不合格を partial（uat_failed）として報告し next action を返すか |
| `u03-fix-pass-after-one` | UAT fail→fix worktree→修正→再検証→再merge→再UAT pass を上限内で success にするか |
| `u04-fix-blocked-max-attempts` | UAT が通らないとき上限回数で停止し blocked（成功に丸めない）で未解決を報告するか |
| `u05-fix-preview` | `--approve` 無しで worktree 作成・fix dispatch・再merge をせず preview に留まるか |
| `u06-fix-worktree-fail` | fix worktree 作成失敗（injection）で fix dispatch 前に partial 停止するか |
| `u07-no-eligible` | verification pass が無いとき UAT を実行せず no-op success になるか |
| `u08-fix-remerge-conflict` | 再検証は pass しても再merge conflict（injection）で partial 停止するか |
| `u09-fix-nudge-until-commit` | idle だが未 commit の fix worker を継続 nudge で駆動し、commit を完了判定にしてから再検証・再merge するか（#1468） |

## status case 一覧

`status-cases/<id>/` だけは fake CLI を使わない。`status.mjs` は run directory の artifact を
読むだけの完全 read-only runner なので、case の入力は **checked-in の run directory**
（`status-cases/<id>/run/`）そのものである。中身は実 runner（plan / dispatch / merge / uat）の
出力を1度生成して置いたもので、`out_dir` だけは生成時の絶対 temp path を run 相対に書き換えて
ある（`status.mjs` は読まないフィールドであり、他人の host path を repo に入れないため）。

checked-in artifact が古い形のまま緑になり続けることを防ぐため、harness は **view を見る前に
各 artifact を同梱 schema（`execution-plan.v2` / `dispatch-report.v1` / `merge-report.v1` /
`uat-report.v1`）で検証する**。意図的に壊した artifact だけが `schema_unvalidatable` で免除される。
さらに全 case で次を無条件に確かめる: artifact が無い phase は Issue 行でも必ず「未実行」、
全 artifact が読めない phase は必ず「読取不能」、その2つは text 表にも必ず現れる、`--json` は
2回実行して byte 一致（決定性）、そして 3 回実行しても run directory が byte 単位で変わらない
（read-only であること）。

| case | 何を見るための case か |
|---|---|
| `s01-plan-only` | plan だけの run で dispatch/merge/uat を「未実行」と出し、次アクションを最初の未実行 phase 1件に絞るか |
| `s02-plan-dispatch` | dispatch の worker_state と verification.outcome を Issue ごとに出し、完走時のみ次 phase のコマンドを示すか |
| `s03-all-phases` | create_prs と merge_prs の2 artifact から PR 番号・URL・CI verdict・merge 状態を畳み、uat verdict まで1表に出すか |
| `s04-dispatch-partial` | partial を success に丸めず、`failed/pass`（完了と裁定の分離）と未 dispatch の「記録なし」を出すか |
| `s05-unreadable-dispatch` | 壊れた dispatch report で当該 phase だけを「読取不能」に落とし、他 phase を通常表示するか |
| `s06-unreadable-plan` | plan.json が読めないとき Issue 集合と run_id を下流 artifact から復元し、plan phase だけを落とすか |
| `s07-blocking-hints` | blocking/limitation の code を §5 対処表にマップし、Issue を名指しした reason だけをその行に出し、未登録 code を推測しないか |
| `s08-uat-blocked` | 上限到達の blocked と Issue ごとの fix attempt 数、未承認 merge の `previewed` を丸めずに出すか |
| `s10-unattended-budget` | wall-clock budget で打ち切った無人 run。**新しい `stop_reason` 値を足していない**ので既存の `timeout` の hint が引かれ、何が起きたかは blocking の `wall_clock_budget_exhausted` が名指しする。run 全体の宣言と Issue ごとの取り消し起点が、それぞれ run 行と Issue 行に分かれるか |
| `s11-unattended-locked` | 排他 lock で拒否された無人 run（何も書いていないので `out_dir: null`・wave 0件）。hint が「先行 run の終了を待って同じコマンドを再実行する」になり、**`human_required` は false** であるか |
## profile-init case 一覧

`profile-init-cases/<id>/repo/` は、`profile-init.mjs` に読ませる**小さな本物のリポジトリ**である
（`package.json` / `Cargo.toml` / workflow / CONTRIBUTING 等を実 file として置く）。harness は
その tree に対して起案を回し、`expected-profile.json` と **byte 一致**するかを見る。
起案 runner は network も subprocess も clock も使わないので、golden は tree の純粋関数である。

各 case について確かめるのは次のとおりである。

- `--emit profile` の stdout と `--out` が書く bytes が、どちらも golden と一致すること
- 2 回実行して **stdout が byte 一致**すること（Claude/Codex parity）
- `verified` が常に `false` で、envelope が `draft: true` を宣言すること
- provenance の `source` が case.json の宣言どおりであること（`detected` / `default` / `flag` / `derived` / `fixed`）
- **`source: default` の field には必ず対の TODO があり、evidence を主張しないこと**
  （「材料が無くて雛形を置いた」が「読み取った」に化けないこと。この feature の要点）
- provenance の evidence が実在する file を指し、**その行番号の行が引用文を実際に含む**こと
- todo code 列・warning code 列が期待と完全一致すること
- `--out` が既存 file を上書きせず `out_exists`（exit 4）で拒否すること
- 起案した profile を `orchestrate.mjs --profile-json` に渡して **plan が通り**、
  そこでも `verified: false` と risk factor `unverified_profile` が保たれること

| case | 何を見るための case か |
|---|---|
| `01-node-npm` | 全部宣言してある node repo で、slug/base/branch/worktree/baseline を全部 evidence つきで読めるか（TODO ゼロ = status success が到達可能か） |
| `02-rust-cargo` | clippy を「証跡があるときだけ」入れるか。CI が2 branch を挙げるとき、選択を `base_ambiguous` として明示するか |
| `03-no-material` | 何も宣言していない repo で例外を投げず、全 field が安全側の雛形 + 明示 TODO になるか。**baseline の placeholder が実際に exit 0 しない**か（fail-closed） |
| `04-python-uv` | `[project.urls]` から slug を、tool table から検査 command を読み、uv 管理下であることを `baseline_env_prefix` として申告するか |
| `05-polyglot` | lockfile 2つ・toolchain 2つの曖昧さを黙って解決せず warning に出すか。branch prefix が `feature` 決め打ちでなく README の `feat/` を読めるか |

引数と失敗系（`profile-init input handling`）も別に見る: 存在しない `--repo-root`（`load_error`）、
未知の `--emit`（`invalid_input`）、slug 形でない `--repo`、token 形でない `--id` が、
それぞれ machine code つきの failure envelope になること。`--repo` / `--id` を渡したときは
推定を上書きし、その事実が provenance に `source: flag` として残ること。

## Claude/Codex parity の確認

plan は入力の純粋関数なので、Agent の種類によらず同じ plan が出る。
実機での確認は、対象 Agent に `SKILL.md` を読ませて runner を
`--issue-json cases/<id>/issues.json` で回させ、得た plan.json を
同 case の期待値（`--run-id fixture` を付ければ golden）と diff するだけでよい。

## その他の suite（case ディレクトリを持たないもの）

| suite | 何を見るための suite か |
|---|---|
| contract parity | runner が叩く `commandmate` の subcommand と flag が `commandmate-cli-contract.json` の範囲内か（実 CLI が在れば実物とも突き合わせる） |
| launcher resolution | `--cli` の多トークン展開・`$CM` へのフォールバック・起動不能な launcher の拒否（#37） |
| worktree-setup input | `--worktree-setup` の二重指定・shell 構文を、世界に触れる前に `invalid_input` で拒否するか（#93） |
| **unattended input**（#122） | `--unattended` と緩和フラグ（`--auto-yes` / `--allow-questions` / `--contract-mode off｜auto`）の併用、および `--wall-clock-budget` 欠落を **exit 3・CLI 呼び出し 0 回**で拒否するか。**`--contract-mode require` を明示した併用は受理される**（この対照が無いと「`--unattended` を常に拒否する実装」でも緑になる）。段階 B の外（`uat.mjs --unattended`）が拒否されることも固定する |
| **unattended exclusivity**（#122） | worktree lock の4規則 —— 生きた所有者は拒否（`--out` も作らず CLI も叩かない）／`kill -9` された所有者（死んだ pid）の lock は回収／別 host の lock は回収せず拒否／完走した run は自分の lock を返す。**`--unattended` を渡さない run は lock をまったく見ない**ことも同じ suite で固定する |
| **unattended merge**（#134。段階 B） | `merge.mjs --create-prs --unattended` の5項目。①**twin の二点測定**: 同じ世界を `--unattended` 有り／無しで2回 `--create-prs --approve` し、`status` / `stop_reason` / `targets` / **実際に作られた PR**（fake の invocation log から読む）／ `blocking_reasons` / `completion_check` / `redactions` が**一致**し、差分は limitation `unattended_mode` の1件**だけ**であること。この世界は scope 外変更を1件持たせてあるので、**昇格しないと裁定した `branch_changed_outside_declared_scope` が両方で limitation のまま**であることも同時に固定する ②**`--unattended` だけでは PR を作らない**（`--approve` を含意しない）③`change_evidence_unavailable` の**二点測定**: フラグ無しは limitation で続行して PR を2つ作り、`--unattended` は blocking になり **PR も push も0回**で `partial` / `pr_create_failed` に落ち、作らない PR の本文も書かない ④`--merge-prs --unattended` は **exit 3**（段階 C 未実装）⑤緩和フラグとの併用も **exit 3・CLI 呼び出し 0 回**。merge-case ではなく suite なのは、①③が**2つの run の比較**であり、独立した case 同士では report を突き合わせられないためである |

## 実機評価の記録

Agent を実際に動かした評価は、実施のたびに次の表へ追記する。

| 日付 | Agent / version | case | run_tests | rubric 合計 | 備考 |
|---|---|---|---|---|---|
| — | 未実施 | — | — | — | — |

**この version（0.10.0）の時点で、実機評価は未実施である。**
実施済みなのは `run_tests.mjs`（14 plan case + 20 dispatch case + 15 merge case + 17 uat case が緑）だけ
である。dispatch の実機確認（2 Issue / 2 並列の dispatch→`send --contract`→`wait --verify`）、PR 作成→
CI 確認→merge の実機確認（2 Issue）、UAT 不合格→fix worktree→修正→再検証→再merge の実機確認は live
環境で別途行う。契約 yaml が CommandMate の実パーサ（`src/lib/tasks/contract-parser.ts`）を通ることは
0.9.0 の実装時に手元で確認済みだが（scope あり/なし・`verify.gates` あり/なし・`autoYes` off/safe の
4 形）、この harness は Node stdlib のみなので YAML パースは行わず、閉じたキー集合・必須キー・
`verify.gates: []` の不在という構造条件のみを検査する。
`commandmate.skill.yaml` の `compatibility.agents` が `claude` と `codex` を
`native` と宣言しているのは SKILL.md の discovery 経路と runner の決定性についてであり、
品質評価の結果ではない。
