# plan 契約 v1

`cmate-orchestrate` が dry-run で生成する **execution plan** の定義である。
機械検証用の正本は
[../schemas/execution-plan.v2.json](../schemas/execution-plan.v2.json)（plan 本体）と
[../schemas/orchestrate-result.v1.json](../schemas/orchestrate-result.v1.json)（result envelope）
であり、この文書はその読み方と、schema では表現できない規則を述べる。

`plan_schema_version` は 1 である。field の追加・削除・意味の変更、および enum への
値の追加は version を上げて行う。**未知の field を足さないこと。** 受け手は
schema にない field を無視せず、契約違反として扱う。

例外が 1 つある: `issues[].acceptance_gates`（第 10 節）は version を据え置いたまま
required field として足された。理由と、それが残す差分は
[adr-issue-acceptance-gates.md](./adr-issue-acceptance-gates.md) 第 12.1 節にある。
**次に plan の field を触るときに `plan_schema_version` を 2 へ上げること**
（plan を読む 4 runner — dispatch / merge / uat / status — の pin を同じ commit で上げる）。


## plan_schema_version

planner が出すのは **2** である（`acceptance_gates` を載せるため。#100 / #114）。

**consumer（dispatch / merge / uat / status）は 1 と 2 の両方を受理する。**
v1 の plan は「受入ゲートを1つも宣言していない plan」として正しく読めるので、
拒否する理由が無い。とくに `status.mjs` は**過去の run の artifact を読む view** であり、
0.18.0 で作った run を読めなくなるのは、この runner が存在する理由そのものの後退である。

守りたい向きは逆で、**古い runner が新しい plan を拒否すること**である。0.18.0 以前の
runner は 1 に固定されているので、`acceptance_gates` を載せた plan を渡すと `plan_invalid`
で止まる。ゲートが黙って無視されることはない。

schema は両方を同梱する（[../schemas/execution-plan.v2.json](../schemas/execution-plan.v2.json) が
planner の出力、[../schemas/execution-plan.v1.json](../schemas/execution-plan.v1.json) は
過去 run の artifact を読むためのもの）。fixture の検査は plan が申告した版の schema で行う。

## 1. 決定性（Claude/Codex parity）

plan は入力の純粋関数である。同じ入力からは byte 単位で同じ plan が出る。
plan を決める入力は次だけである。

- Issue 集合（`issues`）と **Issue 内容（title / body / labels。labels は順序を無視）**
- **解決後の profile 全体**（`--repo` / `--base` 上書きと、それが誘発する verified 降格を
  適用した後の姿。`id` / `repository` / `base` だけでなく `baseline` /
  `branch_template` / `worktree_template` / `verified` / `scope_companions` を含む）
- `max_parallel`
- dependency override（`--depends`）と `--no-infer`
- `--order`
- `phase`

run 先の directory（`--runs-dir`）や wall clock は plan に影響しない。
run_id の既定値も上記入力の SHA-256 から導くので、同じ入力なら run_id まで一致する。
これが Claude で回した結果と Codex で回した結果を突き合わせられる根拠である。
Issue 内容が hash に入っているため（Issue #46 / CommandMate #1678 B-4）、
「blocking question を解消するために Issue 本文を直して plan を取り直す」正規の手順は
**自動的に新しい run_id** になり、`run_exists` に阻まれない。逆に本文まで完全に同一の
再実行は従来どおり同じ run_id に導かれ、上書きは拒否される。

profile は **field を選ばず丸ごと** hash する（Issue #157）。以前は `id` / `repository` /
`base` の3つだけを hash しており、`baseline`（`test_expectations` を決める）、
`branch_template` / `worktree_template`（`branch` / `worktree` を決める）、
`verified`（`unverified_profile` の risk factor を決める）、
`scope_companions`（`suspected_files` / `scope_defaults` を決める）は hash の外にあった。
その結果 **中身の違う plan が同じ既定 run_id を主張しえた**。列挙を直すのではなく列挙をやめた
のは、profile に field が増えるたびに人間が「これは plan に効くか」を判定し直す必要をなくす
ためである —— その判定を誤ったことが #157 の原因そのものだった。
したがって **profile のどの field を編集しても既定 run_id は変わる**。plan に効かない field
を編集した場合も変わるが、それは安全な側の誤差である（新しい id は新しい directory を作る
だけで、古い run を上書きしない）。`--resume` は dispatch directory を指すので影響を受けない。
profile の **key の並び順は差分ではない**。手書き profile の key を並べ替えても run_id は
変わらない。これは hash 側で sort しているからではなく、profile の loader が field を1つずつ
**組み直して**から返すからである（`scope_companions` の各 rule も同様に組み直される）。
hash 側に sort を置くと、どの入力でも挙動の変わらない検査不能な防御になる —— それは本 Issue が
直そうとしている「コードが述べていない主張」と同じ形なので、置いていない。順序の性質は
それを実際に保証している loader の層に対して fixture で固定してある。

ひとつだけ cwd に依存する項目がある。**profile が既定値に解決された場合のみ**、
`warnings` に `profile_repository_mismatch` が載るかどうかが cwd の `origin` に依存する
（[profile-contract.md](./profile-contract.md) 第6節）。plan は「入力 + cwd の origin」の
純粋関数であり、同一 cwd・同一入力なら byte 単位で一致する。`run_id` は cwd に依存しない。

## 1.1 Issue fixture（`--issue-json`）

上の入力のうち **Issue 内容（number / title / body / labels）** を JSON file から与えるのが
`--issue-json <path>` である。渡した場合 `gh issue view` は呼ばれない —— planner 唯一の
network access が消えるので offline で回せる。受け付ける形は次の2つで、どちらでもよい。

```json
[ { "number": 200, "title": "…", "body": "…", "labels": ["docs"] } ]
```

```json
{ "issues": [ { "number": 200, "title": "…", "body": "…", "labels": ["docs"] } ] }
```

配列でも `issues` 配列を持つ object でもない JSON は `load_error`（exit 6）である。
file が読めない場合・JSON として parse できない場合も同じ。

要素の field は `gh issue view --json number,title,body,labels` の出力と同じ4つで、
**`number` 以外は省略できる**（`title` / `body` は `""`、`labels` は `[]` として読む）。
`number` を要求した Issue が fixture に無ければ `fixture does not contain issues: <n>` の
`load_error` になる。

`labels` の要素は**文字列でも `{ "name": "…" }` でもよく、混在してもよい**。前者は手書き
fixture の形、後者は `gh` が返す形である。2形を受けるのは `gh` の出力をそのまま貼れるように
するためで、`gh` 経路と fixture 経路は同じ正規化を通る。文字列でも `name`（文字列）を持つ
object でもない要素は、**その label だけ**捨てられる。

**`number` を整数として読めない要素は、黙って捨てられる**（object でない要素も同じ）。
読み方は `parseInt` 相当なので `200` でも `"200"` でも整数 200 になる。捨てられたことは
warning にならず、観測できるのは「その番号を `--issues` で要求したときに上の `load_error`
が出る」形だけである（要求していない番号なら何も起きない）。同じ `number` が2度現れたときは
**後の要素が勝つ**。なおこの黙殺は 0.28.0 時点の**現状の挙動を仕様として書いたもの**であり、
`load_error` へ締めるかどうかは別 Issue として切る
（[#200](https://github.com/Kewton/commandmate-skills/issues/200) の裁定。docs の変更に
挙動の変更を同乗させない）。

**fixture は plan の入力なので、第1節の run_id にそのまま効く。** 要求した Issue の
title / body を1文字でも変えれば既定 run_id は変わり、別の run directory に出る
（labels は sort してから hash するので、並べ替えでは変わらない）。逆に fixture を編集して
いない再実行は同じ run_id に導かれ `run_exists` で拒否される —— **「本文を直したつもりで
直っていない」を検出する検査**として使える。`--issues` で要求していない要素は plan にも
run_id にも影響しない（hash に入るのは要求した番号の内容だけである）。

これが「**Issue 本文の書き方が plan を変える**」経路（第5.5節の `open-questions` ブロック、
`reference_files`、受入ゲート記法）を試す標準的な方法である。実際の Issue を編集せず、
本文だけを変えた fixture を2つ作って `plan.json` を diff すればよい。

正準例は planner の fixture テストが実際に読んでいる
`tests/fixtures/cmate-orchestrate/cases/02-explicit-dependency/issues.json` である
（`{"issues": […]}` 形・2 Issue・explicit dependency 付き）。散文で書いた例は形式が変わっても
古いまま残るが、テストが読んでいる fixture への参照は、形式が変わればテストが赤くなる。

## 2. run の隔離

- run artifact は `<runs-dir>/<run_id>/` 配下に書く。
- run_id の既定は入力 hash（`plan-<12hex>`、Issue 内容と profile 全体を含む）。
  `--run-id` で明示上書きできる。
- run directory が既に存在する場合は **上書きせず** `run_exists` で失敗する。
  エラーメッセージは回避例（`--run-id <new-id>` / `--runs-dir <dir>`）を明示する。
- `run_exists` は「**同じ id に hash された run が既にある**」までしか述べない。
  「何も変えていない」とは**断定しない**（Issue #157）。既定 profile の
  `profile_repository_mismatch` 判定に使う cwd の `origin` は hash の外にあり、
  同じ id でも plan が違いうるからである。メッセージは既存の `plan.json` を指すので、
  実際に同じ plan かどうかはそれと突き合わせて判断する。

## 3. dependency

edge は「`issue` が `depends_on` に依存する」を表す。`kind` は3種。

| kind | 由来 | 優先度 |
|---|---|---|
| `override` | `--depends <a:b>` で明示指定 | 最高 |
| `explicit` | Issue 本文の記述（`depends on #N` / `依存` 節の `#N` 等） | 中 |
| `inferred` | 推論（下記） | 最低 |

同じ (issue, depends_on) に複数の由来が付く場合、優先度の高い kind を採用する。

edge はもう1つ **`basis`** を持つ（[#182](https://github.com/Kewton/commandmate-skills/issues/182)）。
`kind` が「**誰が**言ったか」なのに対し、`basis` は「**何を根拠に**その edge が在るか」である。
2つは別の問いであり、混ぜると「散文の語が偶然一致した」と「同じ file を書く」が同じ重みで
wave を直列化する —— それが #182 の実測した障害である。

| basis | 意味 | 出る kind |
|---|---|---|
| `declared` | 人間が述べた（本文の記述、または `--depends`） | `explicit` / `override` |
| `file_conflict` | 推論であり、かつ両 Issue が `suspected_files` を1件以上共有する。**共有 file は `reason` に名前が出る** | `inferred` |
| `lexical` | 推論であり、根拠が共有 topic token だけである | —— |

`basis` は**採用された edge のもの**である。同じ (issue, depends_on) を推論と本文の両方が
述べていれば、優先度により `kind: explicit` / `basis: declared` になる ——
人が述べた以上、根拠を推論に遡って名乗る必要が無いからである。

**`lexical` の edge は `dependencies` に載らない。** 載せる代わりに消費者側 Issue の
question（`unconfirmed_lexical_dependency`）にする（第3.1節）。したがって
`dependencies` に実際に現れる値は `declared` と `file_conflict` の2つで、
`lexical` は**語彙として schema に在り、planner が使うが、edge にはならない**値である。
これは #182 の裁定そのものなので、fixture が「`basis: lexical` の edge が1つも無いこと」を
全 case に対して固定している。

`basis` は schema の `required` に**入れていない**。`plan_schema_version` を上げずに足した
field だからで（第9節）、0.27.0 以前が書いた v2 の `plan.json` —— `status.mjs` が読む過去 run の
artifact —— には無い。**無いのは「この区別が生まれる前に書かれた plan」であって
「根拠が無い edge」ではない。** 本 planner は必ず出す。

### 3.0 explicit の方向（Issue #51）

**方向は「行」の性質であり、「節」の性質ではない。** `## 依存` という見出しは
「この節は依存の話である」としか言っておらず、`- blocks #29` がどちら向きかは
言っていない。したがって節見出しは、**方向語を持たない行の既定値**を与えるだけである。

| 行の記述 | 方向 | 結果 |
|---|---|---|
| `depends on` / `blocked by` / `requires` / `needs` / `prerequisite` / `依存` / `前提` | forward | 書いた側が **後**（`issue` = 書いた側） |
| `blocks` / `blocking` / `ブロックする` | reverse | 書いた側が **先**（`depends_on` = 書いた側） |
| 方向語なし、かつ依存節の中 | forward（節の既定） | 書いた側が後 |
| 方向語なし、依存節の外 | — | edge にしない |

`blocked by` は `blocks` に**マッチしない**（語境界で分ける）。1行に forward と
reverse の両方があるときは、どちらかを黙って選ばず forward と読んだうえで
`ambiguous_dependency_direction` を `warnings` に積む（`status` は `partial`）。

同じ相手に両方向を書いた本文は自己矛盾であり、両 edge を残して `cycle_detected`
で落とす（先に書いた行を勝たせて矛盾を隠さない）。

edge の `reason` には、**どの方向語を・どの行から読んだか**を記録する。
`dependency-plan.md` だけで edge を再導出できることが要件である（`kind` と `basis` も
同じ行に出る）。

**CONTEXT 見出し配下の `#N` は edge にならない**（[#182](https://github.com/Kewton/commandmate-skills/issues/182)）。
Issue #54 が path に与えている除外規則（本文側の正本は
[cmate-issue-authoring/references/issue-body-contract.md](../../cmate-issue-authoring/references/issue-body-contract.md)
第2.3節）を、Issue 番号にもそのまま適用する —— `根拠` / `出典` / `参考` / `参照` /
`背景` / `関連` / `References` / `Context` / `Background` / `See also` / `Appendix` の
見出し配下**にしか現れない**番号は、その Issue が**引用している**のであって
依存を述べていない。

これが無かった間、**依存を否定するために書いた行が依存を作っていた**。実測は 2026-08-07 の
#33/#34 で、`## 根拠` に書いた

```
旧本文の depends on #31 は成立しない
```

が phantom 依存 `#34 → #31` になった。番号を書き換えれば依存先が追従するだけで、消すには
**その行ごと消す**しかない —— つまり「なぜ依存しないのか」の記録を消すしかない。

判定は path と同じく**出現ごとではなく番号単位**である。1度でも CONTEXT 見出しの外で
依存として述べていれば edge は残る（引用は記述を取り消さない）。除外しすぎる側の誤りは
こちらの方が高くつく —— 実在する edge を落とすと、順序の要る2 Issue が同じ Wave に入る。
**依存見出し（`## 依存` / `Dependencies` 等）は CONTEXT 見出しに優先する**。
成果物見出しが CONTEXT 見出しに優先するのと同じ向きである。

### 3.1 inferred の規則

推論は「共有 contract の消費者は、その生産者に依存する」という1規則だけである。

- **生産者 signal**: title/body が schema・contract・interface・protocol・型定義・
  スキーマ・契約 等を含む。
- **消費者 signal**: title/body が implement・integrate・consume・利用・連携・実装 等を含む。
- **接続条件**: 生産者と消費者が **共通の topic token** を1つ以上持つ
  （title/body の4文字以上の英数語、stopword 除く）。
- **edge にする条件（#182）**: 上記に加えて、両者が `suspected_files` を1件以上共有する。
  このとき `basis: file_conflict` の edge になり、`reason` に共有 token と**共有 file** が入る。

**共有 token しか無い組は edge にしない。** 代わりに消費者側 Issue に question を1件出す
（`unconfirmed_lexical_dependency`、`warnings` にも同 code で載るので run は `partial`）。
question なので dispatch は `--allow-questions` 無しにはその Issue を送らない ——
「明示承認が要る」の実体はこの既存フラグであり、承認は run の command line に残る。

理由は実測である。2026-08-11、Kewton/BorderFreeKidsMap #104/#105/#106 は**相互参照ゼロ**の
3 Issue でありながら `shared: data, page, cmate` の3 edge で**3 wave に直列化**した。
`cmate` は受入条件の散文「cmate-verify の全ゲート」から、`data` / `page` は互いの
`## 参考` に書いた path 片から来ている。実 file 衝突は1組だけだった。当時の回避策は
`--no-infer` だけで、それは推論を丸ごと切ることでしかない。

**共有 file はこれと質が違う。** 語の選び方ではなく plan の事実であり、その組はどのみち
同一 Wave に置けない（第4節の規則2）。したがって生産者を先に置く順序付けは**待ち時間を
増やさない** —— 推論が元々やりたかったのはこれである。

file overlap 自体は依存では **なく** conflict である（同一 Wave に置かない、第4節・第5節）。
`basis: file_conflict` は「file が重なる」ことを edge の**根拠**として使うだけで、
「file が重なるから依存」ではない —— 生産者/消費者 signal は依然として必要である。

推論は heuristic のままであり、`--depends` で上書き、`--no-infer` で無効化できる。
`--no-infer` は question も含めて推論を止める（「一切推測するな」のスイッチである）。
**`--no-infer` でも file 衝突による Wave 分離は効き、`waves_conflict_free` は passed のままである** ——
あれは edge ではなく Wave 詰めの規則だからで、この性質は #182 でも変えていない。

**却下した案**（#182）:

- *lexical の edge を `dependencies` に載せたうえで「拘束しない」印を付ける。* 載せる先が
  無い。`dependencies` を読む consumer は `status.mjs` の表示だけで、そこでは
  `dep:#N` として**依存と同じ見た目**になる。「載っているが効かない edge」は、
  読み手に対しては載っている edge である。
- *推論そのものを消す。* file を共有する生産者/消費者の順序付けは**待ち時間を増やさない**
  正しい推論であり、消す理由が無い。#182 が測ったのは推論の存在ではなく、
  **根拠の質を区別しないこと**である。
- *`basis` を配列にする（`["file_conflict", "lexical"]`）。* edge に載る値は
  「最も強い根拠」1つで足り、弱い根拠は edge の有無を変えない。#183 が読むのは
  「この edge は順序を強制するのか、排他だけなのか」であり、単値の方が答えやすい。

### 3.2 拒否する dependency

次はいずれも plan を生成せず失敗する。

| code | 条件 |
|---|---|
| `cycle_detected` | 解決後の依存 graph に閉路がある |
| `override_incomplete` | `--depends` が malformed、または plan 内に無い Issue を指す |
| `dependency_order_violation` | `--order` が集合の permutation でない、または依存順に反する |

Issue 本文が **集合外**の Issue（例: 既に merge 済みの前提）を指す explicit 依存は、
失敗ではなく `warnings`（`external_dependency`）に落とし、scheduling からは外す。
この場合 result の `status` は `partial` になる。warning の文面は**読み取った方向を
そのまま述べる**（reverse なら「#A blocks #B, which is not in this plan」）。

## 4. Wave

`waves` は Wave の順序付き配列で、各 Wave は Issue 番号の配列である。
Wave 生成の規則は次の3つ。

1. **依存充足** — ある Issue を Wave に入れられるのは、その依存がすべて
   より前の Wave で完了している場合だけ。
2. **conflict 回避** — suspected file が重なる2つの Issue を同一 Wave に置かない。
3. **幅の上限** — 各 Wave の Issue 数は `max_parallel`（1〜3）以下。

`merge_order` は Wave を先頭から平坦化したものである。

## 5. issue の classification

| 値 | 意味 |
|---|---|
| `dependent` | 依存 edge を1つ以上持つ |
| `conflicting` | 依存は無いが、他 Issue と suspected file が重なる |
| `independent` | 依存も conflict も無い |

## 5.1 scope の既定許可（`issues[].scope_defaults`）

`suspected_files` は dispatch がそのまま契約の `scope.allow` へ写す
（[dispatch-contract.md](./dispatch-contract.md)）。したがってこの list は
**「Issue が書いた意図」と「worker に与える権限」の2役**を兼ねており、狭すぎると
**正しく実装した worker が不合格になる**。しかも契約 scope は send 時 snapshot なので
**worker 側からは直せない**。

そこで planner は、**宣言されたファイルを編集すれば機械的に付いてくるファイル**を
既定で許可し、足した分を `scope_defaults` に列挙する。裁定の記録は
[adr-scope-derivation.md](./adr-scope-derivation.md)（第2節「認可境界は宣言の閉包である」）にある。

導出元は4つある。**列挙の順序もこのとおり**で、同じ path を2つの由来が出したら1件だけ出る。

| 由来 | 規則 | 例 |
|---|---|---|
| lockfile（Issue #44） | 宣言された dependency manifest と**同一 directory** の lockfile | `web/package.json` → `web/package-lock.json` / `web/pnpm-lock.yaml` / `web/yarn.lock` |
| テスト伴走（Issue #147） | 宣言された**ソースファイル**の慣習的なテスト path。形は拡張子で決まる | `src/session.ts` → `src/session.test.ts` / `src/session.spec.ts` / `src/__tests__/session.ts` / `src/__tests__/session.test.ts`<br>`store.go` → `store_test.go`<br>`app/loader.py` → `app/test_loader.py` / `tests/test_loader.py`<br>`lib/parser.rb` → `lib/parser_spec.rb`<br>`src/main/java/…/Loader.java` → `…/LoaderTest.java` / `src/test/java/…/LoaderTest.java` |
| profile の宣言（Issue #149） | profile の `scope_companions.derive` が宣言した repo 固有の規則。宣言済み path に `when` が一致し、`add` がその成分から具体 path を作る | `{"when": "app/{dir}{base}.rb", "add": ["spec/{dir}{base}_spec.rb"]}` のもとで `app/models/user.rb` → `spec/models/user_spec.rb` |
| profile の固定宣言（Issue #181） | profile の `scope_companions.require` が宣言した**リテラル path**。宣言済み path に `when` が一致したとき、`add` の path を**そのまま**足す。何件一致しても1回だけ出る | `{"when": "scripts/{dir}{base}.mjs", "add": ["scripts/tests/shared-contract.test.mjs"]}` のもとで `scripts/build-tiles.mjs` → `scripts/tests/shared-contract.test.mjs` |

後ろ2つが repo ごとに変わる。`derive` と `require` は**同じ list に合流し**、
`derive` を先に、いずれも宣言順に読む（4つ目は3つ目の後に来る）。形と拒否される宣言は
[profile-contract.md](./profile-contract.md) 第9節が正本である。**profile が
`scope_companions` を持たない plan は、この由来が1件も出ないので段1（0.24.0）の出力と
byte 単位で同一になる**（fixture `45-scope-companions-absent` が golden で固定している）。
`scope_companions` を持つ profile の plan は、`plan.profile` にその宣言をそのまま載せる ——
`scope_defaults` の1行がどの宣言から来たのかを、plan 単体で辿れるようにするためである。

守る不変条件は4つで、いずれも実装が破ったら実装が誤りである。1〜3 は**足す側**の規範で、
[adr-scope-derivation.md](./adr-scope-derivation.md) 第2節の3件をそのまま写している。
4 は**引く側**の規範で、[#161](https://github.com/Kewton/commandmate-skills/issues/161) /
[#162](https://github.com/Kewton/commandmate-skills/issues/162) で足した（番号は動かしていない ——
1〜3 は他文書から番号で参照されている）。

1. **導出元は必ず宣言済みファイルである。** 単独の glob（`**/*.test.*` 等）は足さない。
   したがって `suspected_files` が空なら `scope_defaults` も空であり、影響範囲は宣言に比例する。
   profile の `derive` も同じ縛りを受ける ——「宣言済み path の成分を1つも含まない `add`」は
   profile 読み込み時に `load_error` で拒否される（profile-contract.md 第9.3節）。

   **`require` のリテラル path はこの縛りを1段だけ緩める**（Issue #181）。足す path は
   宣言済み path の関数ではない。**それでも宣言に gate されている** —— `when` が一致する
   宣言が1つも無ければ1件も出ないので、「`suspected_files` が空なら `scope_defaults` も空」は
   保たれ、閉包の上限 `(add 総数) × |declared|` も変わらない。緩んだのが
   `derive` ではなく**別 key**なのは、強い言明を書いた場所に残したままにするためである
   （profile-contract.md 第9.2節）。
2. **足した分は必ず可視である。** `scope_defaults` に出さずに `suspected_files` だけ増やさない。
   4つの由来は実装上ひとつの list から出る。
3. **plan は入力の純粋関数のままである。** 導出は決定的で順序も安定しており、planner は
   対象リポジトリを開かない（規約の観測ではなく規則の適用である）。profile 由来の規則も
   plan の中（profile は plan の一部である）だけを入力に取るので、この性質は変わらない。
4. **引いた分も必ず可視である（2 の対）。** 宣言された path が実行契約の `scope.allow` に
   入らないなら、**その事実と、落ちた path と、落ちた理由**がどこかに出る。plan では
   `contract_scope_dropped` warning、dispatch では同名の blocking reason（`--unattended`）
   または limitation として出る。**黙って落とすことは禁じられている。**

   2 と 4 が非対称だった間に何が起きていたかが、この規範の根拠である。足した1件は必ず
   `scope_defaults` に名指しされるのに、消えた50件は1バイトも残らなかった。しかも消え方は
   「plan は 205 件と言い、契約は 200 件しか運ばず、report はどちらも言わない」であり、
   **plan を読んだ人間には「全部入った」と読める。** worker は Issue が明記した file を
   編集して scope ゲートで落ちるが、契約の `scope.allow` は send 時 snapshot なので
   **worker 側に回復手段は無い。** 落とさなければ CommandMate の契約 parser が件数もエントリも
   名指しして exit 2 で拒否するので、**大きな声の拒否を、静かな誤った成功に化けさせていた**
   ことになる。

テスト path の導出は**当たらないことがある** —— テスト配置は repo の規約だからである。
それでも成立するのは、`scope.allow` が指示ではなく**権限**だからで、使われなかった許可は
何も起こさない一方、導出しなければ worker 1人分の run が失われる。ソースでない拡張子
（`.md` / `.json` / `.yaml` / lockfile / `Makefile` 等）は**規則を持たない**ので1件も導出しない。

導出は `MAX_SCOPE_PATTERNS`（200、dispatch 側の契約上限）に収まる位置で source file 単位に
打ち切る。dispatch は `scope.allow` を sort してから切り詰めるので、上限を超えた list は
**宣言済みファイルを導出済みファイルに奪われる**からである。profile 由来の導出は最後に走り、
**すべての由来の合計**に対して同じ上限で打ち切る。

この打ち切りは**導出側にしか無い**（#147 / #149）。**宣言そのものが 200 件を超えたとき**は
導出が1件も足さずに終わるだけで、超過分は dispatch の切り詰めに落ちる —— それを可視にするのが
不変条件4であり、上限そのものは CommandMate 側の契約上限なので planner にも dispatch にも
上げる手段は無い。直し方は Issue の分割である。

`scope_defaults` は既存 field であり、この拡張で `plan_schema_version` は上げない
（意味は「planner が既定で許可した path」のままで、由来が1つ増えただけである）。
`plan.profile` の `scope_companions` も**任意 key の追加**なので上げない
（v2 の consumer は profile の未知 key を拒否しない）。

## 5.2 テスト要求と scope の食い違い（`acceptance_requires_tests_but_scope_has_none`）

第5.1節の導出は**当たらないことがある**。テスト配置は repo の規約なので、慣習と違う置き方を
している repo では1件も当たらない。そのとき残るのは第5.1節が消そうとした障害そのもの ——
**受入条件はテストを要求し、scope にテスト path は無く、worker はどちらかを裏切るしかない**
という分岐の無い状態である。

そこで planner は、次の**両方**が成り立つとき warning と `issues[].questions` を**1件ずつ**出す
（裁定の記録は [adr-scope-derivation.md](./adr-scope-derivation.md) 第7節・第8節・第14節）。

1. `acceptance_criteria` に**テストの作成を能動的に要求する**記述がある
2. `suspected_files` に（**第5.1節の導出結果を含めたうえで**）テストらしき path が1件も無い

`questions` に載るので、dispatch は既存の open question ゲートで**1人も dispatch せずに停止する**
（`no_acceptance_criteria` / `no_suspected_files` と同じ運用 —— Issue 本文を直して re-plan する）。
`warnings` だけでは止まらない: **dispatch は `plan.status` を読まない。**

判定は Issue 本文全体ではなく `acceptance_criteria` **だけ**を走査し、次を分ける。

| | 例 |
|---|---|
| **採る**（能動的な作成要求） | 「unit test がそれを判定する」「テストを追加する」「〜のテストで固定する」「Add a unit test that asserts …」、散文中の `retry.test.ts` / `test_render.c` 形の path 言及 |
| **除外**（4形） | 「テストは不要」「既存のテストが緑のまま」「手動テストで確認」「テストは変更しない」／ "no new test is needed" "existing tests still pass" "verified by manual testing" "leave the tests unchanged" |

除外を持たない検出は自分の存在意義を壊す。「テストは不要」と書いた Issue が「テストが要るのに
scope に無い」で止まるのは**警告が読み手の信用を失う典型**であり、そうなると運用者は
`--allow-questions` を常用し始め、**plan 全体に効く**このフラグが本物の
`no_acceptance_criteria` まで一緒に黙らせる。

**question には判定の元になった受入条件を原文で載せる。** 「なぜ止まったか」がその1行で読めれば、
偽陽性の確認は数秒で済む。

### この検出が書かないもの（裁定 A）

> **推論は機械を止めてよいが、機械に指示してはならない。**

本検出は `acceptance_gates` にも `suspected_files` / `scope_defaults`（= 契約の `scope.allow`）にも
**1バイトも書かない。** 出力先は `warnings` と `questions`、つまり人間だけである。第5.1節の導出が
scope に書いてよいのは、それが**宣言済み path への規則の適用**だからで、こちらは prose から
意図を読む**推論**である。この非対称が両者を別の層に置く理由であり、`plan_schema_version` を
上げない理由でもある（新しい field を1つも作らない）。

## 5.3 agent ハーネスは既定で scope に入れない（`harness_path_in_scope`）

**規範。** 次の3つの接頭辞に一致する path は、`suspected_files` に**入れない**。

```
.claude/skills/**    .agents/skills/**    .commandmate/**
```

worker とその**審判**（verify runner）と「合格の定義」（`.commandmate/verify.yaml`）が、
そこに置かれているからである。`suspected_files` はそのまま実行契約の `scope.allow` になるので、
これらが入った plan は **worker が自分を裁く runner を書き換えられる** plan である。
検証を通すために検証を書き換えられるなら、そのゲートは無いのと同じである。

**なぜ既定なのか。**候補抽出は「拡張子を持つスラッシュ入りトークン」を拾うが、受入条件の中の
path は**成果物であるのと同じくらい「実行するコマンド」である**。形では区別できない。そして

```
- [ ] `bash .claude/skills/cmate-verify/scripts/verify-run.sh --cwd .` が RESULT passed を返す
```

は受入条件の**普通の書き方**である。#177 以前、これを避けていたのは「受入条件に path を書かない」
という**著者の注意力に依存する運用ルール**だけだった。規約は忘れられる。既定を裏返す。

**唯一の出口は明示宣言である。** Issue が `## 対象ファイル`（成果物見出し。語彙は
`orchestrate.mjs` の `DELIVERABLE_HEADING_RE`、本文側の正本は
[cmate-issue-authoring/references/issue-body-contract.md](../../cmate-issue-authoring/references/issue-body-contract.md)
第2.3節）配下に書いた場合だけ scope に入り、`harness_path_in_scope` の
warning が付いて run は `partial` に落ちる。**通したことを黙って通さない。**
自分のハーネスを in-repo で保守しているリポジトリ（このリポジトリがそうである）は、
成果物見出しに書けばよい。#50 が消した障害 ——「言われたとおりに書いて scope ゲートで落ちる」——
をここで再発させないための出口であり、それ以外の目的では使わない。

**落とした path は捨てない。**`reference_files`（「読むが `scope.allow` には入れない」）に出る。
worker は満たすべき runner を読めるが、書けない。第5.1節の不変条件4（「引いた分も必ず可視である」）
はここでも成り立つ。この落とし方に warning を付けないのは意図的である ——
**正しい書き方に対して `partial` を出す warning は、読み手に読み飛ばし方を教える。**

**除外は hardcode である**（profile では宣言できない）。判断の根拠は
[adr-scope-derivation.md](./adr-scope-derivation.md) 第17節にある。

### 5.3.1 Kewton/CommandMate#1756 との整合

CommandMate#1756 は「`.commandmate/verify.yaml` を **scope の変更集合から除外しない**」——
つまり worker がそれを触ったら**検出する** —— のが tamper 検出のための意図的設計である、と決めた。
本節はそれと矛盾しない。**層が違い、向きが同じ**だからである。#1756 は core 側の
**scope ゲート**（変更を検出して裁く側）の話であり、本節は planner 側の **`allow` の導出**
（何を許可として渡すか）の話である。本節の向きは「`allow` に入れない」なので、#1756 の
検出は**弱まらず、強くなる**: 今まで許可されていた編集が、これからは許可されていない編集として
現れる。両者が食い違うのは「planner が渡さない」かつ「core が見逃す」ときだけで、
そういう組み合わせは作っていない。

## 5.4 同じ file の2つの綴り（`ambiguous_file_candidate`）

候補 A が候補 B の **path 境界つき suffix**（`B.endsWith("/" + A)`）であるとき、2つは
同じ file の2つの綴りであり、Issue が対象にしているのは**多くとも一方**である。
planner は **どちらも落とさず**、どちらを意図したかを question にする
（[#182](https://github.com/Kewton/commandmate-skills/issues/182)）。両方が
`suspected_files` に入り、run は `partial` に落ち、dispatch は `--allow-questions` 無しには
その Issue を送らない。

以前は長い方を残して短い方を落とし、warning（`shadowed_file_candidate`）を出していた。
**推測が外れる向きが悪い方だった。** 実測: Issue が `## 対象ファイル` に
`data/demo/facilities.json` を挙げ、説明文でビルド生成物
`web/public/dist/data/demo/facilities.json` に触れたところ、**宣言した方**が scope から落ち、
**触るなと書いてある生成物**が scope に残った。しかも warning は停止しないので、
気づかなければそのまま dispatch される。

「長い方が正しい」は、どちらが対象かの証拠ではない —— **2つが重なっている**ことの証拠である。
どちらが対象かは書いた人にしか分からないので訊く。両方を残す側に倒すのは、2つの誤りの
安い方だからである: 使われない許可は何も起こさないが、足りない許可は worker 1人分の run を
失わせ、契約 scope は send 時 snapshot なので **worker 側からは直せない**（第5.1節の
不変条件と同じ非対称）。

`shadowed_file_candidate` は**廃止**した（本 planner はもう出さない）。判定の位置は
`extractFileCandidates` の中、すなわち cmate-issue-authoring の
`validate-plan.mjs` が写している抽出領域なので、**同じ commit で両方を変えてある** ——
Issue 本文の検査器と planner が同じ path 集合を読むという保証は、この Issue でも壊していない。

**却下した案**（#182）:

- *落とす規則は残したまま warning を question に上げる。* 停止はするが、
  **落ちるのは相変わらず短い方**である。実測の障害は「気づかず dispatch される」だけでなく
  「宣言した path が scope から消える」ことでもあった。
- *成果物見出しの下に在る方を勝たせる。* 推測を別の推測に置き換えているだけで、
  両方が成果物見出しの下に在る本文（`19-shadowed-path-candidate` の逆形）では何も決まらない。
- *どちらも落とさず、黙って両方入れる。* scope が黙って1ディレクトリ広がる。
  第5.1節の不変条件2/4（足した分も引いた分も可視）と同じ理由で採らない。

## 5.5 著者が宣言した未決の問い（`open_question_declared`）

Issue 本文の ```open-questions ブロックの転記である。**記法の正本は
[open-questions-notation.md](./open-questions-notation.md)**（YAML subset と違反の扱いは
[acceptance-gates-notation.md](./acceptance-gates-notation.md) 第3節・第7節を継承する）。

````markdown
```open-questions
version: 1
questions:
  - 座標変換を保存時に行うか、描画時に行うか
```
````

1件につき **1件の blocking question** が `issues[].questions` に載り、同じ code の warning が
`plan.warnings` にも載るので run は `partial` に落ちる。dispatch は既存の open question ゲートで
その Issue を送らない —— **新しい停止経路も新しい緩和フラグも足していない**
（[#178](https://github.com/Kewton/commandmate-skills/issues/178)）。

question の本文は planner の1〜2文のあとに**著者の原文を最後に**置く。最後に置くのは
`acceptance_requires_tests_but_scope_has_none` と同じ理由で、dispatch は blocking question を
末尾を残す `excerpt(…, 200)` で印字するからである（先頭に置くと、停止を確かめられる部分だけが
無人 run で落ちる）。

**この question だけは planner の推論ではない。** 第5.2節・第5.4節や
`no_acceptance_criteria` / `no_suspected_files` は「本文から X を読み取れなかった」という
**不在についての報告**であり、偽陽性がありうる。ここで運ぶのは
「**X をまだ決めていない**」という、決められる唯一の人間による事実の申告である。
planner が計算しても答えは出ない。したがって `_openQuestions` の**先頭**で立てる ——
読み手は、間違いうる findings より先に、間違いようのない findings に会う。

止めなかった場合に何が起きるかは実測されている（2026-08-10、利用リポジトリ
Kewton/BorderFreeKidsMap#63）: 「未決の問い」3件を本文に残したまま plan すると
`questions: []` で dispatch は止まらず、worker は本文の他節から推測するか自分で決める。
**どちらに転んだかは diff を読むまで分からない。** 3件を「決定事項」へ書き換えて re-plan
したら、worker はコメントに理由まで書いてそのとおり実装した。

- ブロックが読めないときは `open_question_block_invalid` の question 1件になり、
  **「ブロックが無かった」には丸めない**（acceptance-gates 記法 第7節をそのまま適用）。
  黙って捨てると、著者が未決と書いたはずのものが消えた run が緑で終わる。
- ブロックは**散文抽出の入力から取り除かれてから** `acceptance_criteria` /
  `suspected_files` / `test_expectations` / topic token が計算される（第10.1節と同じ2つの
  理由。実測: strip しないと後続 ```bash が終了 fence の誤対応で丸ごと飲まれ、
  問いの中に書いた path が `scope.allow` に入る）。
- **ブロックが無い本文の plan は byte 単位で従来どおりである。** fixture
  `61-open-questions-heading-not-read` の golden は**この機能が実装される前の runner が
  生成した**もので、それがこの主張の測定である。

**見出し規約（`## 未決の問い` / `undecided` / `Open questions`）は採らなかった。**
理由は open-questions-notation.md 第5節にある（誤検出・散文から停止を作らない・
生成と解消が機械化できる）。同 fixture が「3つの綴りすべてを持つ本文で question が
1件も立たない」ことを固定している。

## 6. risk

`risk.level` は factor の最大 severity である。factor は決定的に導く。

| code | severity | 条件 |
|---|---|---|
| `unverified_profile` | high | profile が unverified |
| `file_conflict` | moderate | file が重なる Issue pair がある |
| `cross_issue_dependency` | moderate | 依存 edge がある |
| `open_questions` | moderate | blocking question を持つ Issue がある |
| `batch_size` | low | Issue 数が `max_parallel` の1 Wave を超える |

## 7. permissions / commands

`permissions` は、後続 phase まで含めた orchestration 全体が要求する権限
（manifest の `declared_permissions` と一致）を、plan 段階で提示するものである。

`commands` は plan の根拠になった read-only command と、worker が回す baseline 検証を
列挙する。すべて `executed: false`（planner は1つも実行しない）。
worktree 作成・dispatch・PR・merge といった mutating command は plan の `commands` に
**含めない**。dispatch と監督ループは、承認済み plan を入力に取る別 runner
（[dispatch-contract.md](./dispatch-contract.md)）の担当であり、PR 作成・merge・UAT 修正ループは
後続 [#1455-1456](https://github.com/Kewton/CommandMate/issues/1452) の担当である。

## 8. completion_check（result）

result envelope は5つの check を自己申告する。

| id | 内容 |
|---|---|
| `dry_run_only` | mutating phase を実行していない |
| `dependencies_validated` | cycle・不完全 override・順序違反が無い |
| `waves_conflict_free` | どの Wave も file 重複 pair を含まない |
| `run_isolated` | run directory が unique で、上書きしていない |
| `deterministic` | plan が入力の純粋関数である |

`passed` は5件すべて true のときだけ true。`status` が `failure` のときは
`passed` は false で、`errors` に理由を持つ。

## 10. 受入ゲート（`issues[].acceptance_gates`）

Issue 本文の ```acceptance-gates ブロックの転記である。**記法の正本は
[acceptance-gates-notation.md](./acceptance-gates-notation.md)**、裁定の記録は
[adr-issue-acceptance-gates.md](./adr-issue-acceptance-gates.md) にある。

```json
"acceptance_gates": { "version": 1, "require": ["orchestrate-fixtures"] }
```

- **planner が見るのは構文だけである。** plan は対象リポジトリを開かない read-only の
  分析器なので、id が実在するかは判断できない。実在確認は dispatch が worktree の
  `.commandmate/verify.yaml` に対して行う（[dispatch-contract.md](./dispatch-contract.md) 第 2.9 節）。
- `require` は**著者が書いた順のまま**である。契約は Issue の写しであって再エンコードではない。
- **`null` は「ブロックが無かった」を意味しない。** ブロックが 0 個のときも、ブロックが
  壊れていて読めなかったときも `null` になる。区別は warning が持つ:
  `acceptance_gate_block_invalid`（記法違反）/ `acceptance_gate_block_unsupported`（`gates:` は
  段階 2 で未実装）。どちらも open question なので run は `partial` に落ち、dispatch は
  `--allow-questions` 無しではその Issue を送らない。
- 壊れたブロックを「無かったこと」に丸めない理由は `unrecognized_file_extension`（Issue #43）と
  同じである: **黙って捨てると、書いたはずの受入条件が消えた run が緑で終わる。**

### 10.1 散文抽出との関係

ブロックは**散文抽出の入力から取り除かれてから** `acceptance_criteria` /
`suspected_files` / `test_expectations` / topic token が計算される。

理由は 2 つあり、どちらも実測に基づく。

1. `extractTestExpectations()` の fence 正規表現 ``/```[a-zA-Z]*\n([\s\S]*?)```/g`` は、
   `acceptance-gates` を info string としては拾わない（ハイフンが `[a-zA-Z]` の外）が、
   **本ブロックの終了 fence を後続 fence の開始として拾い**、次の ```bash ブロックを
   丸ごと飲み込む。測定値は ADR 第 11.3 節。
2. ブロック内の `  - verify-selftest` は箇条書きの形をしているので、strip しなければ
   `acceptance_criteria` の項目や path 候補として読まれる。位置と明示マークだけが意図を
   決める（Issue #54）を裏返しにした同じ誤りである。

`test_expectations` は依然として**助言的**であり、裁定には使われない。裁定へ運ばれるのは
明示ブロックだけである（[acceptance-gates-notation.md](./acceptance-gates-notation.md) 第 5 節）。

## 9. version 運用

- field の追加・削除・意味の変更、enum への値追加 → `plan_schema_version`（または
  `result_schema_version`）を上げる。
- 文言・見出しの調整のみ → Skill の `version` だけを上げる。

例外は2つあり、どちらも**任意 field として足し、`required` に入れない**形を取っている。
1つ目は `issues[].acceptance_gates`（第10節、[adr-issue-acceptance-gates.md](./adr-issue-acceptance-gates.md)
第12.1節）。2つ目は `dependencies[].basis`（第3節、[#182](https://github.com/Kewton/commandmate-skills/issues/182)）である。

`basis` を 3 に上げなかった理由:

1. plan を読む4 runner（dispatch / merge / uat / status）は `plan_schema_version` を
   `[1, 2]` に pin しており、3 を出せば**その場で全員が `plan_invalid` で止まる**。
   4つの pin を同じ commit で上げるのが規則だが、#182 の宣言 scope は planner だけである
   （dispatch / merge は別 Issue が同時に触っている）。
2. `dependencies` を読むのは `status.mjs` の表示（`kind` だけ）である。**field が1つ増えても
   読み方が変わる consumer が居ない。**
3. `required` にすると、0.27.0 以前が書いた v2 の `plan.json` が schema 違反になる。
   `status.mjs` は**過去 run の artifact を読む view** なので、それは第「plan_schema_version」節が
   「後退である」と述べた向きそのものである。実際 `tests/fixtures/cmate-orchestrate/status-cases/*/run/plan.json`
   は `basis` を持たないまま置いてあり、それが正しい状態である。

代わりに **planner が必ず出すこと**は fixture 側で固定してある（全 plan case に対して
「edge は必ず `basis` を持ち、`lexical` は1件も無い」を検査する）。schema が緩い分を
test で締めるという配置であり、**緩いまま放置ではない。**
