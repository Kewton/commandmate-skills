# 作業規律 — 破ると何が起きるか

本 skill における作業規律の**正本**である。[SKILL.md](../SKILL.md) の要約と食い違ったら、
この文書を採る。ただし**実行契約と食い違ったら契約が勝つ**（SKILL.md 第0節の不変条件3）。
規律は契約の中で「どう進めるか」を決めるものであって、契約が禁じたことを許可しない。

8 項目それぞれに、**規律**・**破ると何が起きるか**・**実測根拠**を書く。
「そういうものだから」では規律は守られない。守らせるのは、破ったときに何が起きるかを
実際に見た記録である。ここに並ぶ根拠は、すべて本リポジトリ
（`Kewton/commandmate-skills`）の実運用で取れている。

> **行番号について。** 以下の行番号は **main = `86b6b1a` 時点**の実測値である。
> 行番号は commit に紐づくので、読むときは自分でも確かめること（規律 4 がまさにそれである）。
> 外部リポジトリで本 skill を使う場合、根拠として引かれた file はそのリポジトリには
> 存在しない。**根拠は「なぜこの規律が在るか」を示すものであって、参照先の存在を
> 前提にした手順ではない。**

---

## 1. 追加したゲート・テストは、赤になることを実測してから完了とする

**規律.** 追加・変更したゲートやテストは、緑を見ただけで完了としない。判定対象を変異させ、
**赤になること**を実測する。**二点測定**（適合状態で緑・変異状態で赤の両方を実測）が
完了条件であって、緑だけの報告は証拠にならない。

test-first（テストを先に書く）は、この測定を**最も安く得る方法**である——実装が無い時点では
赤が無料で手に入る。だが唯一の方法ではない。後からテストを書き、**実装を戻して赤を観測する**のも
同じ測定である。本 skill が要求するのは順序ではなく、赤の実測のほうである。

赤の理由も固定する。証拠になる赤は `RESULT failed` / **exit 20** であり、失敗ゲートに
**当の id が名指しで**含まれるものだけである。exit 2（設定エラー）・21（not_started）・
22（skipped）・127（コマンドが起動できていない）の赤は、**判定に到達していない**ので
証拠にならない。変異は**成果物側**に入れる——ゲートやランナーを壊す変異は harness が動くことの
証明であって、そのゲートが当の変更を測っていることの証明ではない。

**破ると.** 何も測っていないゲートが緑を出し、`verification.outcome: pass` が
「何を測ったのか誰にも分からない緑」になる。本リポジトリの `.commandmate/verify.yaml`
（24〜25行）が書いているとおり **「A test nobody runs is not a gate」** であり、その裏返しとして
**何を測っているか誰も知らないゲートは、緑の証拠能力を持たない**。空振りのゲートは
「壊れていない」ではなく「壊れても分からない」を意味する。

**実測根拠.**

| PR | 何を測ったか |
|---|---|
| [#101](https://github.com/Kewton/commandmate-skills/pull/101)（Issue #92） | 隔離 worktree で `scripts/lib.mjs` と `commandmate.skill.yaml` の**両方向**に version 不一致を注入し、いずれも exit 1・`SKILLS_VERSION_CONSTANT_MISMATCH` になることを実測。復元後は exit 0 に戻ることまで表にした |
| [#104](https://github.com/Kewton/commandmate-skills/pull/104)（Issue #90） | 実装を `origin/main` へ戻すと新規ケースが **22 assertion** 落ちることを実測（exit code 1→7、status `failure`→`partial`、stop_reason `drift`→`worker_failed`、outDir 未作成→作成、ほか） |
| [#102](https://github.com/Kewton/commandmate-skills/pull/102)（Issue #100） | 文書のみの変更なので「変異注入は非適用」と**明記したうえで**、ADR の事実主張をコードで裏取りした表を証拠に置いた（規律 4 と第「テストの余地が無い変更」節） |

### テストを先に書くことが成立しない変更

文書のみ・ADR のみの変更では、テストの不在を自己申告で済ませない。
**「何がこの変更を判定しているか」を名指しする。** 規約は3つ。

1. **ゲート外を明示する。** 機械ゲートで担保されない受入条件は、消さずに「ゲート外」として
   列挙し、UAT / 人間の確認へ残す。担保されない条件を黙って落とすことが、すり抜けの正体である
   （`cmate-verify` SKILL.md「受入条件との対応付け」。Issue #47 / CommandMate #1678 B-5 では、
   静的検査だけのゲート集合が PASS を返し、アプリの中心機能が動かない状態が 3 件すり抜けた）。
2. **文書変更の証拠は「主張 → 実測」の対応表である。** 本文が述べた事実主張それぞれについて、
   `file:line` またはコマンド出力を対置する。
3. **「テストの余地が無い」は機械で示せる範囲で示す。** 変更集合が文書・生成物だけであることは
   `git diff --name-only` で示せる。示せるものを自己申告に落とさない。

---

## 2. 既存テストの期待値を、実装を通すために書き換えない

**規律.** 既存の fixture・assertion が落ちたら、**まず自分の実装を疑う**。期待値の緩和は
最後の手段であり、緩めるなら「なぜ後方互換を壊してよいか」を先に言語化して承認を取る
（規律 5 の「止まって訊く」に合流する）。

**破ると.** 後方互換の破壊が**「テストを直した」に化けて消える**。落ちた assertion は
本来「この変更は既存の約束を破った」という報告であり、期待値を書き換えるとその報告そのものが
消える。**壊れたことを誰も知らないまま merge される**——しかも赤が消えているので、
レビューでも CI でも引っかからない。

**実測根拠.** 本リポジトリは既にこれを規律として明文化しており、複数の ADR が同文で繰り返している——
「**既存 fixture の期待値を1つも緩めないこと。緩めなければならないなら、それは実装が
後方互換を壊した合図である**」（`skills/cmate-orchestrate/references/adr-unattended-mode.md` 595行、
同 `adr-worktree-preparation.md` 249行）。同じ文が独立に3度書かれているのは、
**その都度これが問題になったから**である。

---

## 3. 「既存から赤だった」を自己申告しない

**規律.** 着手**前**に、clean な base でベースラインを実測しておく。赤が在るなら、その id と
exit code を着手前に記録する。着手後に「元から赤だった」と言うなら、着手前の実測を添える。

**破ると.** 自分が壊した赤を「元から」と報告し、**ゲートが恒久的に赤のまま放置される**。
一度「元から赤」として受理された赤は、次の run では「前回もそうだった」の根拠になり、
以後誰も直さない。10 ゲートのうち1つが永久に無効化される。

**実測根拠.** 本リポジトリは clean な main で **12 ゲート**が緑である——CommandMate 組み込みの
`work-evidence` と `scope` に、`.commandmate/verify.yaml` が宣言する 10 ゲートを足した数である。
ゲート数はその場で実測できる。

```
$ grep -a -c '  - id:' .commandmate/verify.yaml
10
```

12 緑という事実は、2026-08-07 の PR [#101](https://github.com/Kewton/commandmate-skills/pull/101) /
[#102](https://github.com/Kewton/commandmate-skills/pull/102) /
[#104](https://github.com/Kewton/commandmate-skills/pull/104) の Verification 節が
**独立に3回**実測している。したがってこのリポジトリでは「元から赤」は原則として偽であり、
主張するなら実測を添える必要がある。

> `grep` で件数を数えるときは **`grep -a`** を使う。本リポジトリの fixture には NUL を含む
> file が在り、素の `grep` はそれを binary と判定して**黙って 0 件を返す**。
> 0 件を「無かった」と読むと、規律 4 の裏取りがそのまま偽になる。

---

## 4. Issue 本文の前提・行番号をコードで裏取りする。食い違ったら実測を正とする

**規律.** Issue や設計文書が述べる「どこに何が在る」は、着手時にコードで確かめる。
自分が行番号を書くときは、**どの commit の実測か**を必ず添える。

**破ると.** 人が書いた仮説の上に実装が積まれ、**ずれたまま完成する**。Issue は実装より粗く、
書かれた瞬間から腐り始める。ずれに気づくのは、実装が終わってレビューに出したあとになる。

**実測根拠2件.**

**(1) 行番号は commit に紐づく。** 本 skill の設計 ADR は `buildContractGoal()` を
「1425〜1459行（main = `ced8f78` 時点）」と実測している。Issue #103 本文は同じ関数を
「631〜665行（main = `c261475` 時点）」と書いている。そして main = `86b6b1a` の現在は
**1438行**である。

```
$ grep -an 'function buildContractGoal' skills/cmate-orchestrate/scripts/dispatch.mjs
1438:function buildContractGoal(plan, issue, requiredGates = []) {
```

**同じ関数の同じ定義が、3 つの commit で 3 つの行番号を持っている。** どれも、その commit では
正しい。裏取りせずに書かれた行番号へ飛べば、別の場所を読むことになる。

**(2) Issue が知らない既存経路が在りうる。** Issue #100 のワーカーは、Issue 本文が想定して
いなかった既存の推測抽出経路 `extractTestExpectations()`
（`skills/cmate-orchestrate/scripts/orchestrate.mjs` 872行。`ced8f78` でも `86b6b1a` でも同じ行）を
発見し、「散文から推測しない」という裁定をそこへ接続した
（PR [#102](https://github.com/Kewton/commandmate-skills/pull/102) の裏取り表）。
発見しなければ、**既に下されていた判断を知らないまま重複した機構を作っていた**。
Issue が言及していないことは「無い」ではなく「Issue が知らない」である。

---

## 5. 曖昧・破壊的・ブロックのときは推測で進めず止まる（fail-closed）

**規律.** 判断に必要な情報が無いとき、推測で埋めない。**止まって訊く。** 対象は3つ——
取り消しにくい操作（破壊的）、読み方が2通り以上ある指示（曖昧）、
前提が揃わず進めない状態（ブロック）。

**破ると.** **誰も承認していない決定が成果物に入る。** しかも推測は自信のある文体で書かれるので、
レビューでは「決まったこと」に見える。誤りが発見されるのは、それが下流で効いたときである。

**実測根拠.** この package は同じ結論に少なくとも3度、独立に到達している。

| 何を推測したか | 何が起きるか | 出所 |
|---|---|---|
| ゲート（受入条件から機械ゲートを推測生成する） | **承認した人が読んでいない条件で worker を落とす**（あるいは落とさない） | `adr-issue-acceptance-gates.md` 171行 |
| scope（空の scope を推定して補う） | 推測した scope は誰も承認していない。しかも scope は**書き込み権限**なので、害はゲートより大きい | `adr-unattended-mode.md` 197行（Issue #54） |
| — | 実行契約の Rules 自身が既に `- If a step is destructive, ambiguous, or blocked, STOP and ask. Do not guess.` と書いている | `dispatch.mjs` 1472行 |

結論も同文で3度書かれている——**「ゲートが無いことは、間違ったゲートが在ることより安全である」**
（`adr-issue-acceptance-gates.md` 173行、`acceptance-gates-notation.md` 106行）。
**止まったことは失敗ではない。** 止まらずに推測したことが失敗である。

---

## 6. スコープ外の file を触らない

**規律.** 実行契約の `scope.allow`（単独利用なら、着手前に合意した変更範囲）は**境界の宣言**である。
その外の file を編集しない。広げる必要があると判断したら、**広げるのではなく止まって訊く**（規律 5）。

**破ると.** 2つ起きる。

**(1) 正しい実装が「不合格」として返ってくる。** CommandMate の `scope` ゲートは宣言と実変更を
突き合わせるので、宣言に無い file を1つ触るだけで不合格になる。plan の `suspected_files` が
そのまま `scope.allow` になるため、**Issue 本文が言及しなかった生成物**（lockfile など）を
更新した瞬間に構造的に不合格になる（CommandMate #1678 B-2 がその実例で、
`cmate-orchestrate` は `scope_defaults` でこれに対処した）。実装が正しくても、
不合格の run からは何も下流へ流れない。

**(2) 並列 wave では、双方の変更が壊れる。** 他 Issue の worker と同じ file を編集すると、
どちらの変更も相手の commit で上書きされうる。planner が file 衝突のある Issue を同じ wave に
置かないのは、**まさにこれを避けるためである**——境界を越えた1人が、wave の前提そのものを壊す。

**実測根拠.** merge runner の PR 本文は、宣言 scope と実変更を突き合わせて out-of-scope 件数を
数える（`skills/cmate-orchestrate/scripts/merge.mjs` の `scopeLines()` 527行）。
差分が読めなかった場合でも「**This is not evidence that the branch stayed in scope.**」と
明記する（同 533行）。**scope 逸脱は PR 本文に残る。** 隠せない。

---

## 7. 生成物は再生成コマンドで作る

**規律.** digest・manifest・生成コード・catalog を**手で書かない**。再生成コマンドを回して、
その出力を使う。再生成コマンドが分からないなら、それは規律 5 の「止まって訊く」対象である。

**破ると.** 手書きの値が実体とずれる。ずれが CI で止まればまだよく、
**止まらなければ壊れた配布物が出る。**

**実測根拠.** `scripts/lib.mjs` の `SKILL_VERSION` が **0.13.0 のまま 0.15.0 / 0.16.0 / 0.17.0 が
公開され**、0.17.0 を install した利用者の plan / dispatch report に `skill_version: 0.13.0` が
刻まれていた（`skills/cmate-orchestrate/references/release-notes.md` 581行、
PR [#101](https://github.com/Kewton/commandmate-skills/pull/101) / Issue #92）。
障害報告のバージョン特定を誤らせる形で、**3 release にわたって誰も気づかなかった。**
`scripts/validate.py` の `SKILLS_VERSION_CONSTANT_MISMATCH` 検査は、この事故のあとに入った。

本 package 自身も同じ規律に従う。`references/` に file を足したら、`files:` を手で書かず
再生成する。

```
$ python3 scripts/manifest_files.py skills/cmate-worker-development
```

`scripts/validate.py` は宣言された file 集合を **path / sha256 / size / kind / script / executable**
の6点で突き合わせる。手書きの digest は、そのどれか1つで必ず落ちる。

---

## 8. 完了の定義は「証明できる状態」であって「できたと報告すること」ではない

**規律.** 「完了した」と言えるのは、**判定に到達した緑**と、それを再現できる証拠が在るときだけである。
報告の文面は完了条件ではない。

**破ると.** 「できた」と報告した run が下流で落ちる。この package は
**worker completion と verification success を別々の事実として報告する**設計であり、
両者を混ぜないことが設計の中核である
（`skills/cmate-orchestrate/references/dispatch-contract.md` 56行「worker completion と
verification success は別物であり、別々に判定する」、同 177行「いずれの経路でも、
**worker completion だけでは gate は開かない**」）。混ぜた報告は、この2つの事実のうち
片方だけを伝えて他方を伝えないので、受け手は開かないはずの gate を開いたと誤解する。

**実測根拠.** `cmate-verify` の判定は「作業したか」と「通ったか」を最初から分けている。

| 状態 | RESULT | exit | 読み方 |
|---|---|---|---|
| commit も未 commit 変更も無い | `not_started` | 21 | コマンド系ゲートは**1つも走っていない** |
| コマンド系ゲートの実行が0件 | `skipped` | 22 | **何も検証していない。緑ではない** |
| 1つ以上のゲートが FAIL / TIMEOUT | `failed` | 20 | 判定に到達したうえでの赤 |
| 実行した全ゲートが PASS | `passed` | 0 | 「**宣言したゲートが通った**」以上を意味しない |

**`skipped` を `passed` と読まない**（`cmate-verify` SKILL.md の exit code 表）。
**判定に到達していない緑は、緑ではない。**
`passed` の意味を広げないことも同じ規律の一部である——通ったのは宣言したゲートであって、
宣言しなかった条件ではない（規律 1 の「ゲート外を明示する」に戻る）。

---

## 参照

- [evidence-vocabulary.md](./evidence-vocabulary.md) — F 段（証拠）で使う語彙と節構成
- [../SKILL.md](../SKILL.md) — A〜F の6段と不変条件
- [ADR: ワーカー側の開発スキル](https://github.com/Kewton/commandmate-skills/blob/main/skills/cmate-orchestrate/references/adr-worker-development-skill.md) — 第8節が本文書の裁定の記録
