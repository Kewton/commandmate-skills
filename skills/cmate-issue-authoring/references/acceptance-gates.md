# 受入ゲートのブロック（起案側）

Issue 本文に置く `acceptance-gates` ブロックの扱いである。

**記法の正本はこの文書ではない。** 正本は cmate-orchestrate の
`references/acceptance-gates-notation.md` であり、この package は**ミラーする側**である。
記法を独自に拡張しない。食い違ったら正本を採る。一致はリポジトリの conformance テストが
機械で固定している（第 7 節）。

## 1. 何のためのものか

Issue は「何をもって完了とするのか」を散文で書く。裁定を下すのは
`commandmate wait --verify` の exit code であり、それが走らせるのは対象リポジトリの
`.commandmate/verify.yaml` のゲートである。**この 2 つは別のものである。**

ブロックは、その差のうち**機械で測れる部分だけ**を Issue から裁定へ運ぶ。
`require:` に挙げた id は、この Issue の判定に必ず参加する。

ブロックは受入条件の**置き換えではない**。planner は本文の受入条件（`## 受入条件` 見出しと
その箇条書き）を別に読み、無ければ blocking question を立てる。ブロックだけ書いて
散文の受入条件を書かない本文は、validator の `planner_ready` が落とす。

## 2. 出す形

````markdown
```acceptance-gates
version: 1
require:
  - validate
  - orchestrate-fixtures
```
````

**この形以外を出さない。** 手で書かず、同梱の validator に出させる。

```bash
node scripts/validate-plan.mjs --render-acceptance-gates validate,orchestrate-fixtures --checkout <checkout>
```

renderer は `--checkout` を必須にしており、`<checkout>/.commandmate/verify.yaml` に
実在しない id を渡すと exit 2 で止まって何も出力しない。**推測した id が本文に入る経路を
塞ぐのが目的**である（第 3 節）。

置き場所は受入条件の節の直後がよい。planner はブロックを本文から取り除いてから散文の
抽出器を走らせるので、位置は抽出結果を変えない。ただし**ブロックの中身は受入条件として
読まれない** — `  - validate` は箇条書きに見えるが、planner はブロックを剥がしてから読む。

## 3. 絶対の規律 — 推測で書かない

ADR `adr-issue-acceptance-gates.md` 第 2.3 節は「散文からの推測生成は禁止（fail-closed）」を
消費側の裁定として定めている。**起案側も同じ規律に従う。**禁止を消費側だけに置くと、
「planner は推測しないが、Issue を書く Skill が推測して書き込む」という迂回で空文になる。

| 状況 | すること |
|---|---|
| 機械で測れると**確信できる**受入条件がある | ブロックにする |
| 測れるか判断できない | **散文のまま残す。** ブロックに入れない |
| `.commandmate/verify.yaml` を読めない | **ブロックを出さない。** `require:` を 1 件も書かない |
| ゲートに落とせない条件がある | 「ゲート外」と本文に明示し、UAT / 人間の確認へ残す |

`require:` に書けるのは、対象リポジトリの `verify.yaml` が実際に宣言している gate id
（および contract 組み込みの `work-evidence` / `scope`）**だけ**である。読めていない
状況で id を推測して書くと、dispatch が `send` する前にその Issue を
`acceptance_gate_id_unknown` で止める。**親切のつもりが run の停止になる。**

`env-clean` は CommandMate の built-in ゲートだが、契約の `verify.gates` が名指しできる
集合には**入らない**。`require: [env-clean]` は拒否される。

**ゲートが無いことは、間違ったゲートが在ることより安全である。** ブロックを持たない Issue は
この記法が存在しなかったときと byte 単位で同じ扱いを受ける（正本 第 7 節）。出さないことは
後退ではない。

## 4. 出してはならないもの

- **`gates:`（新規コマンドの宣言）。** 記法としては実装済みで、**消費側（planner / dispatch）は
  受理する**（正本 第 6 節、[#125](https://github.com/Kewton/commandmate-skills/issues/125)）。
  止めるのは**この package 自身の validator** であり（`acceptance_gate_block_unsupported` →
  `acceptance_gates_no_new_commands`）、理由は「自分が renderer で出せない記法を本文に書かない」
  という起案側の判断である（正本 第 6.3 節）。次の形は出さない。

  ```text
  version: 1
  gates:
    - id: new-gate
      command: "npm run new-check"
  ```

  新しいゲートが要るなら、それは対象リポジトリの `verify.yaml` を変更する別の作業である。
  その変更を Issue の受入条件に書き、ゲート化はその Issue が着地してから行う。
- **期待 exit code の宣言。** ゲートは定義上「exit 0 が pass」である。非 0 を期待する
  受入条件は `! cmd` や `test "$(cmd)" = ...` として**exit 0 が正である形に書き直す**
  （正本 第 4 節）。
- **1 本文に 2 個以上のブロック。** マージも先勝ちもせず syntax error になる。
- **行末コメント・tab・2 スペース以外のインデント・引用符・flow collection。**
  値の一部と見なされるか syntax error になる。renderer を使えば起こらない。

## 5. validator の rule

| rule | 落とすもの |
|---|---|
| `acceptance_gates_block_parses` | planner が読めないブロック（構文違反・2 個以上・未知 version・id 不正・空） |
| `acceptance_gates_no_new_commands` | `gates:` を含むブロック |
| `acceptance_gates_block_is_canonical` | 読めるが renderer の出力と byte 一致しない |
| `acceptance_gates_verify_yaml_read` | ブロックがあるのに `--checkout` 無しで検証した（＝ id の実在を誰も見ていない） |
| `acceptance_gates_id_exists` | `require:` の id が `<checkout>/.commandmate/verify.yaml` に無い |

`--checkout` を渡したのに `verify.yaml` が読めない・解釈できない場合は exit 2 である。
**「読めなかった」を「ブロックが無かった」に丸めない。** これは計画が悪いのではなく、
検証できていない状態である。

ブロックを持たない計画の検証は `--checkout` の有無に依らず従来どおりである
（`verify.yaml` は、ブロックを持つ Issue があるときだけ読まれる）。

## 6. 3 つの状態を混ぜない

| 状態 | planner の扱い |
|---|---|
| ブロックが 0 個 | 従来挙動。受入ゲートは載らない。契約は byte 単位で従来どおり |
| ブロックが 1 個・構文 OK | `plan.issues[].acceptance_gates` に載り、実行契約へ運ばれる |
| ブロックが壊れている | open question + warning。**推測で復旧しない** |

`acceptance_gates` が `null` であることは「ブロックが無かった」を意味しない。区別は
warning が持つ。起案側は壊れたブロックを出さないことでこの区別に立ち入らない。

## 7. 一致をどう保証しているか

`scripts/validate-plan.mjs` が持つのは、planner のブロック読み取りと dispatch の
`verify.yaml` 読み取りの**逐語の写し**である。写しである以上、放っておけば必ず乖離する。

> このミラーは、**写した先のコードと同じ commit で変更する**。両者の一致は
> リポジトリの conformance テストが保証する。

`tests/fixtures/cmate-issue-authoring/acceptance-gates-conformance.mjs` が、定数の byte 一致・
関数本体の byte 一致（rename と comment を除く）・corpus での挙動一致に加えて、
**この package が出す形が正本の例と byte 一致すること**を確かめている。install 先の
package に conformance テストは含まれない（`files:` に無いものは artifact に入らない）。

## 8. 閾値を「着手前に落ちる」形で書く（[#218](https://github.com/Kewton/commandmate-skills/issues/218)）

受入条件は「**着手前に落ち、着手後に通る**」ものでなければゲートとして働かない。
`inspect.mjs --evaluate-gates` は dispatch の前にこれを base で実測するが、**見るのは
ブロックが宣言した gate だけ**である（正本 第 5.1 節）。散文に書いた閾値は
——「`wc -l` が 860 以下」「2,000 件で 100ms 未満」—— **誰も先行評価しない。**
第 3 節・第 4 節の fail-closed をこの runner も覆さないからである。

起案側にできることは 2 つある。

1. **閾値を名乗る前に測る。** 実測 [CommandMate#1832](https://github.com/Kewton/CommandMate/issues/1832):
   移せる量を測らずに「860 行以下」と書いた Issue が 993 行で着地した。
   同じ run で「2,000 件で 100ms 未満」は着手前の O(n²) 実装ですら 0.4ms で、
   直しても直らなくても緑だった。**現在値を本文に書き、そこからどれだけ動かすのかを書く。**
   `path:line` と行数の主張は `inspect.mjs --check-references` が実物と突き合わせる
   （[#217](https://github.com/Kewton/commandmate-skills/issues/217)）。
2. **機械に測らせたい閾値は `gates:` の形で書く。** gate は exit 0 だけを pass とするので、
   閾値は `test` で表す —— `test $(wc -l < web/src/lib/repository.ts) -le 860`。
   **この package の renderer は `gates:` を出さない**（第 4 節）ので、この形が要る Issue では
   ブロックを人が書き、レビュアーが読む。出す形は正本 第 6 節が持つ。

出力に時刻・乱数・並び順が混ざるコマンドは、**着手後も通らない**（実測: 出力の sha256 を
受入条件にした Issue が、出力の `判定時刻 : <ISO8601>` のせいで毎回不一致になった）。
`--evaluate-gates` はこれを `nondeterministic` として base で見つけるが、そもそも
そういうコマンドを受入条件にしない方が早い。
