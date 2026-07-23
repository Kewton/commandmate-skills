# cmate-orchestrate の評価

`skills/cmate-orchestrate/` の計画コア（dry-run runner）を、決定的な fixture に対して
検証するための一式である。GitHub には一切触れない。

```
cases/<case-id>/issues.json     planner に渡す Issue fixture（オフライン）
cases/<case-id>/case.json       引数と、機械で判定できる期待値
cases/<case-id>/expected-plan.json  （任意）golden な plan。byte 一致で照合
dispatch-cases/<id>/case.json   plan 生成引数・scenario・dispatch 期待値
dispatch-cases/<id>/scenario.json  fake CLI に注入する worker/verify/drift の挙動
merge-cases/<id>/case.json      plan/dispatch 生成・merge scenario・merge 期待値（scenario は inline）
uat-cases/<id>/case.json        plan/dispatch 生成・uat scenario・UAT/修正ループ 期待値（scenario は inline）
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
- 成功時、plan が `execution-plan.v1.json` に適合すること
- Wave・merge 順・依存 kind・classification・risk が期待どおりであること
- どの Wave も `max_parallel` を超えず、file 重複 pair を含まないこと
- **同じ入力から同じ plan が出ること**（2回実行して byte 一致）
- golden がある case では、plan が checked-in の期待値と byte 一致すること

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

## dispatch case 一覧

`dispatch-cases/<id>/` は、まず plan を生成し、その plan を `dispatch.mjs` に渡して
`fake-cli.mjs`（`commandmate`/`git`/`gh` を模した stub）に対して監督ループを回す。
`scenario.json` が worker の挙動・verification・drift を注入する。worker は各ターン後に
idle 化し（`wait` は exit 0 を返す）、`commit_on`（既定 1）ターン目に「commit」する
（`git rev-parse HEAD` の SHA が進む）モデルで、runner が **idle を完了と誤認せず新規 commit を
完了判定**にすることを検証できる（#1468）。`confirm_after` は送信直後の `capture` で「まだ動いて
いない」と見せ、送信確定（再送）の経路を試せる。`fake-cli.mjs` は各呼び出しを `CMATE_FAKE_LOG` に
JSONL で記録するので、`respond` が呼ばれていないことや `send`（初回 + nudge）の回数まで検証できる。

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

## Claude/Codex parity の確認

plan は入力の純粋関数なので、Agent の種類によらず同じ plan が出る。
実機での確認は、対象 Agent に `SKILL.md` を読ませて runner を
`--issue-json cases/<id>/issues.json` で回させ、得た plan.json を
同 case の期待値（`--run-id fixture` を付ければ golden）と diff するだけでよい。

## 実機評価の記録

Agent を実際に動かした評価は、実施のたびに次の表へ追記する。

| 日付 | Agent / version | case | run_tests | rubric 合計 | 備考 |
|---|---|---|---|---|---|
| — | 未実施 | — | — | — | — |

**この version（0.4.0, release candidate）の時点で、実機評価は未実施である。**
実施済みなのは `run_tests.mjs`（9 plan case + 7 dispatch case + 12 merge case + 8 uat case が緑）だけ
である。dispatch の実機確認（2 Issue / 2 並列の dispatch→wait→verification）、PR 作成→CI 確認→merge の
実機確認（2 Issue）、UAT 不合格→fix worktree→修正→再検証→再merge の実機確認は live 環境で別途行う。
`commandmate.skill.yaml` の `compatibility.agents` が `claude` と `codex` を
`native` と宣言しているのは SKILL.md の discovery 経路と runner の決定性についてであり、
品質評価の結果ではない。
