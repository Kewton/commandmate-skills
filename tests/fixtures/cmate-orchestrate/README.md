# cmate-orchestrate の評価

`skills/cmate-orchestrate/` の計画コア（dry-run runner）を、決定的な fixture に対して
検証するための一式である。GitHub には一切触れない。

```
cases/<case-id>/issues.json     planner に渡す Issue fixture（オフライン）
cases/<case-id>/case.json       引数と、機械で判定できる期待値
cases/<case-id>/expected-plan.json  （任意）golden な plan。byte 一致で照合
dispatch-cases/<id>/case.json   plan 生成引数・scenario・dispatch 期待値
dispatch-cases/<id>/scenario.json  fake CLI に注入する worker/verify/drift の挙動
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
`scenario.json` が worker 完了・失敗・prompt・verification・drift を注入する。
`fake-cli.mjs` は各呼び出しを `CMATE_FAKE_LOG` に JSONL で記録するので、
`respond` が呼ばれていないことまで検証できる。

| case | 何を見るための case か |
|---|---|
| `d01-two-waves-success` | 全 worker 完了・全 verification pass で2 Wave を通過し success になるか |
| `d02-max-parallel` | `max_parallel` を超えて dispatch しないか（幅 2 の上限を守るか） |
| `d03-worker-failed-barrier` | 前 Wave の worker 失敗時に後続 Wave を dispatch しないか（barrier） |
| `d04-verification-failed-gate` | 完了しても verification 失敗なら success にせず後続を止めるか（gate） |
| `d05-prompt-human-required` | prompt 検出時に自動応答せず human-required で停止し、excerpt を redaction するか |
| `d06-drift-refuses-dispatch` | mutation 前の drift（base 未解決）で1件も dispatch しないか |
| `d07-auto-yes-respond` | `--auto-yes` 明示時のみ `respond` で応答して継続し、auto-yes 使用を記録するか |

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

**この version（0.2.0）の時点で、実機評価は未実施である。**
実施済みなのは `run_tests.mjs`（9 plan case + 7 dispatch case が緑）だけである。
dispatch の実機確認（2 Issue / 2 並列の dispatch→wait→verification）は live 環境で別途行う。
`commandmate.skill.yaml` の `compatibility.agents` が `claude` と `codex` を
`native` と宣言しているのは SKILL.md の discovery 経路と runner の決定性についてであり、
品質評価の結果ではない。
