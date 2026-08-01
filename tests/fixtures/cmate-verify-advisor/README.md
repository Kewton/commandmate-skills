# tests/fixtures/cmate-verify-advisor/

`skills/cmate-verify-advisor` の層 1 アナライザ（`scripts/verify-advisor.mjs`）の回帰テスト。
package には含まれない（配布物は `skills/cmate-verify-advisor/` の下だけ）。

```bash
bash tests/fixtures/cmate-verify-advisor/run_tests.sh            # 69 assertions
bash tests/fixtures/cmate-verify-advisor/run_tests.sh --mutants  # 13 mutants, 0 survivors
```

bash・node・git だけで動く。ネットワークは使わない（`commandmate` は shim である）。

## 構成

| path | 役割 |
|---|---|
| `run_tests.sh` | suite 本体。`--mutants` で変異注入ドライバになる |
| `mutate.mjs` | アナライザのガードを 1 つずつ壊した複製を作る |
| `make-cases.mjs` | `cases/*.json` の生成器。`node make-cases.mjs cases` で再生成できる |
| `cases/*.yaml` | 入力になる verify.yaml |
| `cases/*.json` | 入力になる履歴 snapshot（`{history, details}`） |

## cases

| case | 何を表しているか |
|---|---|
| `baseline.yaml` | timeout が実測より桁違いに大きいゲート、timeout 無しのゲート、自分の timeout の理由をコメントに持つゲート |
| `outlier.yaml` | 1 ゲートだけの設定。120 run の履歴を小さく保つため |
| `bad-config.yaml` | `cmate-verify` のサブセット外（`retries:`）。exit 2 になること |
| `steady.json` | 8 run。`unit` が 2 回落ちる。失敗ログには集計行が残っている |
| `truncated.json` | 同じ 8 run。失敗ログが予算 4096 バイトぴったりで、集計行が無い。**注入カナリアを含む** |
| `short-tail.json` | 集計行は無いが予算にも達していない（＝切れていない）反証ケース |
| `capped-with-summary.json` | 予算には達したが集計行は残っている反証ケース |
| `slow.json` | `unit` が 25 分かかるようになった。timeout の**増加**＝弱体化提案が出る |
| `censored.json` | `build` が自分の timeout に殺され、duration を記録していない |
| `sparse.json` / `flake.json` | `--min-samples` 未満。提案 0 件が正常であること |
| `outlier.json` | 120 run。nearest-rank の p99 が最大値より下に来る |
| `empty.json` | 履歴 0 件。exit 3 |
| `layer2-mixed.json` | 層 2 の提案（追加＝強化 / 削除＝弱体化 / ログ縮小＝弱体化）。**どれも適用されない** |

## 何を証明しているか

受入条件が名指しした 3 点と、黙って壊れると気づけない 2 点。

1. **層 1 の決定性** — 同一履歴 → 同一 report・同一 `--json`・同一 diff・同一の書き込み結果。
   履歴の配列順を入れ替えても同じ。提案の提示順も固定
2. **弱体化系は `--apply` でも適用されない** — timeout 増加は提案されるが書かれない。
   層 2 の提案は**強化方向（ゲート追加）でも**書かれない
3. **ログ末尾切れ検出** — 予算いっぱい かつ 集計行なし で増額を提案する。3 つの反証ケースで
   条件がそれぞれ効いていることを確認する
4. **ログ本文が出力に出ない** — `truncated.json` に仕込んだカナリア文字列が、text にも
   `--json` にも現れない（間接プロンプト注入対策）
5. **人間が merge しうる diff も verify.yaml である** — 全提案を適用すると設定が壊れる場合は
   `OBSERVATION proposed-config-invalid` で報告する
6. **書いたものがまだ verify.yaml である** — `--apply` 後のファイルを
   `cmate-verify` の実ランナー（`verify-run.sh`）に読ませ、`invalid config` にならないこと

## 変異注入

`--mutants` は `mutate.mjs` が定義する 13 の変異それぞれについて suite 全体を回し、
**赤が出ること**を要求する。生き残った変異は「誰もテストしていないガード」である。

変異は正確な文字列置換であり、置換対象が見つからなければ**エラーで止まる**。
リファクタで対象が消えたときに、no-op の変異が「まだ守られています」と嘘をつかないため。
