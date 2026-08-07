# 証拠の語彙 — 新語彙を作らない

F 段（証拠）の出力で使う語彙と節構成の**正本**である。
[SKILL.md](../SKILL.md) の要約と食い違ったら、この文書を採る。

**新語彙を作らない。** ここに並ぶ語はすべて、`cmate-orchestrate` が **PR 本文で既に確立した
節構成**（Issue #97）と、**受入ゲートの由来語彙**（Issue #100）の**ミラー**である。
定義の正本はそちら側——`skills/cmate-orchestrate/scripts/merge.mjs` と
`skills/cmate-orchestrate/schemas/dispatch-report.v1.json` ——に在り、
**本 skill はそれを適用する側であって、定義する側ではない。**

## なぜミラーなのか

本 skill は PR を作らない（[SKILL.md](../SKILL.md) 第4節）。では F 段の証拠は何のために在るのか。
2つある。

1. **単独利用では、人間がそれを読んで PR を書く。**
2. **オーケストレーション配下では、merge runner が自分の測定で PR 本文を作る**
   （`merge.mjs` の `buildPrBody()` 602行。main = `86b6b1a` 時点の実測）。
   ワーカーの証拠は、その PR 本文と**突き合わせる**ためのレビュー材料になる。

2 が語彙をミラーにする理由である。**語彙が違えば突き合わせられない。**
「gates」と「チェック項目」、「out-of-scope」と「範囲外」を別々に名付けた瞬間、
レビュアーは2つの文書のどの行とどの行が同じことを言っているのかを、毎回自分で推測する。

## 語彙表

| 何を書くか | 語彙の出所（実装） |
|---|---|
| Verdict（`pass` / `fail` / `not_run`）と、**判定が走らなかった**という事実 | dispatch report の `verification.outcome` / `verification.ran`。**`ran: false` を pass に匂わせない**（`merge.mjs` 382〜387行は「Treat this branch as unverified.」と書く） |
| **Gates 表** — `Gate` / `Verdict` / `Exit` の3列 | `verificationLines()`（`merge.mjs` 391〜405行） |
| **Checks 表** — 記録どおりの行と exit code | 同 407〜425行。「as recorded」がそのまま列名である |
| 宣言 scope と実変更の対比、**out-of-scope 件数**、diff 規模 | `scopeLines()`（`merge.mjs` 527行〜） |
| gate の**由来**（`repo` / `issue`） | `verification.gates[].origin`（`dispatch-report.v1.json` 238行〜）。**欠落を `repo` と読まない**。欠落は「由来が記録されていない」という第3のバケットである |
| 受入条件とゲートの対応、担保されない条件の**「ゲート外」明示** | `cmate-verify` SKILL.md「受入条件との対応付け」（Issue #47 / CommandMate #1678 B-5） |
| **読めなかった**という事実 | `merge.mjs` 530〜541行の文体。「読めなかった」を「scope 内だった」と読ませない |
| 打ち切り（表が全件を載せていないこと） | `capped()` / `droppedNote()` が確立した形。**何件落としたかを書く** |

行番号は **main = `86b6b1a` 時点**の実測値である。ずれていたら実測を正とする
（[work-discipline.md](./work-discipline.md) 規律 4）。

## 規律

- **証拠は転記であって主張ではない。** 「検証した」「テストが通った」と書くのではなく、
  **何がどの exit code で終わったか**を写す。転記なら読み手が再現できる。主張は再現できない。
- **打ち切ったら打ち切ったと書く。** 表に載せる件数に上限を設けたなら、
  「上位 N 件」ではなく「**残り M 件は載せていない**」と書く。
  黙った打ち切りは「これで全部」と読まれる。
- **緑の意味を広げない。** `RESULT passed` は「**宣言したゲートが通った**」以上を意味しない。
  宣言しなかった条件について、緑は何も言っていない。
- **どちらの機構で測ったかを必ず書く。** 裁定機構は2つ在りうる——実行契約経路の
  `commandmate wait --verify` と、`cmate-verify` の `verify-run.sh` である。
  どちらで測ったかを書かない証拠は、exit code の意味が確定しない。
- **測っていないものを測ったふりをしない。** 「作法に従った」は、本 skill の出力からは
  証明できない事実である（次節）。

## 「適用されたこと」と「守られたこと」は別の事実である

証拠として書けるのは、**この方法論を読んで作業したという申告**と、
**実際に走ったコマンドとその exit code** である。
「作法どおりに考えたか」は、どこからも測れない。測れないものを測ったふりをしない。

これは `cmate-verify` SKILL.md の
「**PASS は「宣言したゲートが通った」以上のことを意味しない**」と同じ規律である。
機械で測りたい部分が在るなら、正しい場所は**受入ゲート**（Issue #100 の `require:` / `gates:`）
であって、証拠文書の文面ではない。

## schema を作らない（今は）

主成果物は**人が読む markdown** とする。機械可読 JSON の schema は**定義しない**。

理由は「消費側が先である」——**今この文書を機械で読む consumer が存在しない。**
dispatch runner はワーカーの出力 file を読まないし、merge runner は自分で測る
（`buildPrBody()` は plan と dispatch report から作る）。
**消費者の居ない schema は、守られているかを誰も測らない。**

これは `cmate-repository-analysis` が取った形と同じである（同 SKILL.md 冒頭:
「主成果物は人が読む `summary_markdown` であり、構造化した result JSON は任意の副産物である」）。
ワーカーの証拠を機械で読みたい消費者が現れた時点で、**そのときに**形式を決める。

## 節構成

次の骨格を埋める。**節を削らない。** 該当が無い節は「該当なし」とその理由を書く——
空の節と、無いことを確かめた節は、別の事実である。

```markdown
# Issue #<n> — 実装と検証の証拠

## Summary
（何を変えたか。1〜3 文。実装の意図ではなく、変わった事実を書く）

## Verification
（**どの機構で測ったか**を最初の1行に書く:
 実行契約経路の `commandmate wait --verify` / `cmate-verify` の `verify-run.sh` /
 契約や profile baseline のコマンドを直接実行）

- Verdict: **pass | fail | not_run**

**Gates**

| Gate | Verdict | Exit |
| --- | --- | --- |
| … | … | … |

**Checks**

| # | Check (as recorded) | Exit |
| --- | --- | --- |
| 1 | … | … |

## 二点測定（緑が空振りでないことの証明）

| 変異 | 結果 |
| --- | --- |
| 無変異（baseline） | exit 0 |
| <成果物側に入れた変異> | **exit 20** — 失敗ゲート: `<id>` |
| 復元後 | exit 0 |

（文書のみの変更で変異注入が非適用なら、**非適用と明記**し、
 代わりに「主張 → 実測」の対応表を置く。省略しない）

## 宣言 scope と実変更

- Out-of-scope changes: **0**（または件数と path）
- Diff size: N file(s) changed, +A / -D line(s)

| Path | Declared (`scope.allow`) | Changed |
| --- | --- | --- |
| … | yes / **no** | yes / no |

## 受入条件との対応

| 受入条件 | 担保するゲート | 備考 |
| --- | --- | --- |
| … | `<gate id>` | — |
| … | **ゲート外** | UAT / 人間の確認へ残す理由 |

## 読めなかったこと・委譲できなかったこと

（読めなかった file、実行できなかったコマンド、install されていなかった委譲先と、
 その結果どの段が劣化したか。**該当なしなら「該当なし」と書く**）
```

## 参照

- [work-discipline.md](./work-discipline.md) — 8 項目の作業規律と、破ったときに何が起きるか
- [../SKILL.md](../SKILL.md) — A〜F の6段と不変条件
- [ADR: ワーカー側の開発スキル](https://github.com/Kewton/commandmate-skills/blob/main/skills/cmate-orchestrate/references/adr-worker-development-skill.md) — 第7節が本文書の裁定の記録
