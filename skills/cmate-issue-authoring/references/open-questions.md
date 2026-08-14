# 未決の問いのブロック（起案側）

起案する Issue 本文に置く `open-questions` ブロックの扱いである。

**記法の正本はこの文書ではない。** 正本は cmate-orchestrate の
`references/open-questions-notation.md` であり、この package は**ミラーする側**である。
YAML subset・key の集合・上限・壊れたブロックの扱いは、そこに 1 度だけ書いてある。
**ここで書き直さない。拡張しない。**食い違ったら正本を採る。一致はリポジトリの
conformance テストが機械で固定している（第 7 節）。

ここで決めるのは 3 つだけである ——
**どの open question がブロックになるか / どこへ入るか / 誰が組むか。**

## 1. 何のためのものか

計画の `open_questions` は「著者が人間の代わりに決めなかったこと」の記録である。
それが**本文に載らないまま Issue が登録される**と、planner は止める理由を 1 つも持たない。
worker は本文の他節から推測するか、自分で決める。どちらに転んだかは diff を読むまで
分からない —— [#178](https://github.com/Kewton/commandmate-skills/issues/178) が消しに来た
事象であり、その起案側の残りが本 Issue（#209）である。

planner が立てる他の question はすべて「本文から読み取れなかった」という**不在についての
推論**であり、外れることがある。この記法が運ぶのはその逆で、**決めていないと書いた人
自身の申告**である。planner が計算しても答えは出ない。

## 2. 二重管理にしない

**`open_questions[]` が真であり、ブロックはその射影である。**

| `blocks` に この Issue の `key` が | 本文のブロックに | `open_questions[]` に |
|---|---|---|
| 入っている | 載る | 残る |
| 入っていない | 載らない | 残る |
| `blocks` が空 | 載らない | 残る |

`blocks` は `duplicate_needs_open_question` rule が読む field と同じものである。
**第 2 の「これは未決である」宣言を作らない。** 何かをブロックしない question も
question であり、配列にも要約にも残る —— 何も止めないのが正しい結果だからである。

ブロックの中身は `question` の値を**逐語で**運ぶ。引用符付けも escape も
再改行もしない。末尾の句点を足しも消しもしない。`why_blocking` と `options` は
ブロックに入らない（記法が持つのは自由文の問いだけである）。順序は
`open_questions[]` の順であり、並べ替えも grouping もしない。

## 3. 出す形

対象 Issue の本文の**末尾**に 1 つ置く。

```open-questions
version: 1
questions:
  - PR #1188 の replay ケースで足りるか、rotation 前提の追加ケースが要るか
  - replay 用の fixture を `tests/auth/fixtures/replay.json` に置くか、テスト内に埋めるか
```

**手で書かない。** 同梱の validator に、計画そのものから出させる。

```bash
node scripts/validate-plan.mjs <plan.json> --render-open-questions <issue-key>
```

renderer は計画の `open_questions[]` だけを読む。したがって「本文に写す」step は
**存在しない** —— 写し漏れの経路が無いのは、写す作業が無いからである。
ブロックする question が 1 件も無い key を渡すと**何も出力せず** exit 0 で終わる。
未決が無い Issue はブロックを持たないのが正しい形であり、空のブロックは planner が拒否する。

置き場所は抽出結果を変えない。planner はブロックを本文から取り除いてから散文の抽出器を
走らせる（[issue-body-contract.md](./issue-body-contract.md) 第 2.7 節）。それでも末尾に
揃えるのは、**消す場所を人が探さなくてよい**ようにするためである（第 6 節）。

## 4. 問いが 1 項目になれないとき

正本の subset は、空の問い・YAML 予約文字で始まる問い・完全一致の重複を拒否する。
2 行にまたがる問いはそもそも 1 項目ではない。**ここで直さない。**
著者向けの 1 文を serializer に合わせて書き換えるのは、その文が run の意図と別のことを
言い始める入口である。

`open_questions[].question` の側を**1 文で答えられる形に書き直す**。ブロックはその同じ
text を運ぶ。validator の `open_questions_are_representable` がこれを機械で確かめる。

## 5. 32 件を超えるとき

正本の上限は **32 件**である。**切らない。** 切ったブロックは
「この Issue の未決はこれで全部だ」と名乗ることになり、それは本記法が消しに来た
silent drop そのものである。

超えたなら、それは**ブロックが短すぎるのではなく Issue が大きすぎる**。
[SKILL.md](../SKILL.md) の Step 4 に戻って割る。33 件の未決を持つ Issue は Issue ではなく
設計フェーズである。validator は `open_questions_are_representable` で計画を invalid にし、
findings に件数を書く。renderer も同じ理由で exit 2 で止まり、何も出力しない。

この数値は正本と runner に書かれており、こちらで調整する値ではない。

## 6. ブロックを消すことが「決めた」の記録である

要約の次の行動に書く。読み手が推測できない半分だからである。

- 問いが答えられたら、**`open_questions[]` からその question を外し、本文のブロックを
  同じ編集で消す。** validator が両者の一致を見ているので、片方だけを直した計画は落ちる。
- 本文で答えながらブロックを残すと Issue は止まったままになる。
- ブロックを消しながら問いを答えないと、決定が worker に戻る —— 始まりの状態である。

Phase 2（登録）の前提は変わらない。**open question が 1 件でも未解決なら承認を求めない**
（[register-contract.md](./register-contract.md)）。それでも人間が「未決のまま登録する」と
決めたときに、その未決が Issue に**書かれている**ことをこの記法が保証する。
承認の規律と、規律が破られたときの安全網は別物であり、後者を持たないことに理由は無い。

## 7. validator の rule

| rule | 落とすもの |
|---|---|
| `open_questions_block_is_derived` | 本文のブロックが `open_questions[]` の射影と違う（**無いことも含む**） |
| `open_questions_block_is_canonical` | 読めるが renderer の出力と byte 一致しない |
| `open_questions_block_parses` | planner が読めないブロック（構文違反・2 個以上・未知 version・未知 key・空・重複） |
| `open_questions_are_representable` | 射影がブロックとして書けない（重複・予約文字・改行・32 件超） |

`open_questions_block_is_derived` は**両方向**に効く。宣言した question が本文に無いことも、
宣言していない question が本文に在ることも落とす。片方向だけの検査は、
**写し漏れという実際の失敗を測らない**検査である。

`--checkout` は要らない。この記法は対象リポジトリの状態を一切参照しない
（`acceptance-gates` と違い、突き合わせる相手が計画の中にある）。

## 8. 一致をどう保証しているか

`scripts/validate-plan.mjs` が持つのは planner のブロック読み取りの**逐語の写し**である。
写しである以上、放っておけば必ず乖離する。

> このミラーは、**写した先のコードと同じ commit で変更する**。両者の一致は
> リポジトリの conformance テストが保証する。

`tests/fixtures/cmate-issue-authoring/open-questions-conformance.mjs` が、定数の byte 一致・
関数本体の byte 一致（comment と `planner` prefix を除く）・corpus での挙動一致・strip の
一致に加えて、**この package が出す形が cmate-issue-refinement の生成規則と byte 一致すること**
を確かめている。生産側が 2 つあるのに形が 2 つあってはならない。
install 先の package に conformance テストは含まれない（`files:` に無いものは artifact に
入らない）。
