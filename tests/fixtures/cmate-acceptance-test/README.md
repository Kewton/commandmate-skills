# cmate-acceptance-test — evaluation fixture

`skills/cmate-acceptance-test/` の deterministic な評価一式。
Skill package そのものではないので、`scripts/validate.py` の検査対象ではない。

```
cases/<case-id>/
  case.json             入力（Issue、対象、記録済み command 出力、利用者応答）と期待値
  expected-result.json  golden な result document
rubric.md               採点基準（hard requirement と graded criteria）
check_result.py         採点器。schema・rubric 不変条件・期待値を判定する
```

## 実行

```bash
python3 tests/fixtures/cmate-acceptance-test/check_result.py
```

golden をすべて採点する。exit 0 が合格。CI に組み込む前でもそのまま動く
（Python 標準ライブラリのみ。この repository の他の tooling と同じ方針）。

実 Agent の出力を採点する場合:

```bash
python3 tests/fixtures/cmate-acceptance-test/check_result.py \
  --case 03-flaky-retry --result ./acceptance-result.json
```

## なぜ「記録済み出力」なのか

case の `recorded_outputs` は、実際に command を実行した結果ではなく、
**評価のために固定された出力**である。実 command を走らせると、評価結果が
その日の環境・network・test の機嫌に左右され、Skill の良し悪しを測れなくなる。

したがってこの fixture は次を測らない。

- 対象 project の test が実際に通るかどうか
- Agent が command を正しく起動できるかどうか

測るのは、**同じ観測結果を与えたときに、同じ判定と同じ構造の出力が出るか**である。

## 何が検出できて、何ができないか

`check_result.py` の H1〜H11 は result document の内部整合性であり、
辻褄の合った誤り（例えば、実際には未実行なのに pass と書かれた document）は
検出できない。case ごとの期待値（H12）がそれを担う。

逆に、期待値と一致していても graded criteria（rubric.md §2）が低い出力はありうる。
「正しい結論を、読めない形で出す」ことは機械では落とせないため、
実機評価では人が採点する。

## 秘密情報について

`07-redaction` の case は、伏字処理を検証するために「秘密らしく見える文字列」を
含む。これらは実在しない固定の placeholder であり、既知の credential pattern に
一致しない形にしてある。実際の token をここに置かないこと。
