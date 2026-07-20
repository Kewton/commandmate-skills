# Agent 差異と fallback

この Skill は特定の Agent の tool 名・命令形式に依存しない。
SKILL.md は「何を読み、何を出すか」だけを規定し、
「どの tool でそれを行うか」は各 Agent の裁量に委ねている。

その前提で、実行環境ごとに差が出る点と、差が出たときの振る舞いを定める。

## 1. 必要な能力

この Skill が成立するために Agent 側へ求めるのは次の3つだけである。

| 能力 | 用途 | 無いときの動作 |
|---|---|---|
| directory の再帰列挙 | scope の決定 | status `failure` / `out_of_scope` |
| file の読み取り（行番号が分かること） | evidence の生成 | status `failure` / `out_of_scope` |
| 文字列検索 | 既存実装の特定 | 列挙と読み取りで代替。`partial` になりやすい |

command 実行・network access・書き込みは **要求しない**。
Agent がそれらを持っていても、この Skill の手順では使わない。

## 2. 行番号が取れない場合

evidence の行番号は、この Skill の出力価値の中心である。
Agent の読み取り結果に行番号が付かない場合は、読み取った内容を
自分で行に分割して 1 起点で数える。推定した行番号を書かない。
数えられない場合、その evidence は付けず、当該項目を落とす。

## 3. 検索が使えない場合の fallback

文字列検索が無い、または結果が信用できない場合は、
[scan-policy.md](./scan-policy.md) の「読む順序」に従った列挙と読み取りだけで進める。
この場合、網羅性は下がる。**下がったことを隠さない。**
`unresolved` に `out_of_scope` を1件立て、`detail` に
「検索が使えず列挙と読み取りだけで進めたため、網羅性は保証しない」と書く。

`no_evidence_found` を使わないこと。それは「探した上で無かった」を意味し、
探せていない状態をそう書くと、後続の判断を最も誤らせる。
`scan_budget_exhausted` も使わない。上限に達したわけではないうえ、
それは `scope.truncated` が true であることと対になっている。

## 4. context 長が足りない場合

読んだ内容を保持しきれない場合、file を読み進めながら
finding と evidence を確定させ、本文は保持しない。
evidence は path と行範囲だけなので、本文を捨てても結果は作れる。

途中で保持を諦めた場合は `scope.truncated` を true にする。

## 5. 出力形式

result object は JSON である。
Agent が構造化出力の機構を持つ場合はそれを使う。
持たない場合は、`summary_markdown` に続けて JSON を単一の code block で出す。
JSON を複数の block に分割しない。

`summary_markdown` は result object の field であって、
result object の代わりではない。片方だけを返さないこと。

## 6. 検証済みの組み合わせ

manifest の `compatibility.agents` には、SKILL.md の discovery 経路が
確認できている Agent だけを `native` として宣言している。
実機での品質評価（rubric による採点）を行った Agent と version は、
配布元リポジトリ <https://github.com/Kewton/commandmate-skills> の
`tests/fixtures/cmate-repository-analysis/README.md` に記録する。
この file は package には含まれないので、install 済みの copy には無い。

宣言が `unknown` の Agent で動かないという意味ではない。
確認していない、という意味である。
