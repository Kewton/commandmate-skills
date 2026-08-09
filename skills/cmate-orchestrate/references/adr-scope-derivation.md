# ADR: scope の導出 — 宣言から認可境界へ（[#145](https://github.com/Kewton/commandmate-skills/issues/145) を含むクラス）

status: **accepted / 段1（L1）・段2（L4）実装済み・段3（#145）と段4（#149）は未着手**（2026-08-09 承認）。裁定 0 と4層の分割、
契約 schema を分けない判断、L3 を question とする判断が承認された。
実装は本 ADR の裁定に従い、実装で形が変わったら**正本を直したうえでこの文書に追記する**。

本 ADR は個別の不具合ではなく、**同型の障害が3回出たクラス**を裁定する。

> 正しく実装した worker が、**Issue が書き忘れたファイルに触れた**というだけで不合格になる。
> scope を決めるのは Issue なので、**worker 側からは直せない。**

この文書は **裁定の記録**であり、契約の正本ではない。実装後の正本は
[plan-contract.md](./plan-contract.md)（`scope_defaults`）・
[dispatch-contract.md](./dispatch-contract.md)（契約の `scope`）・
[profile-contract.md](./profile-contract.md)（`scope_companions`）・
[codes-and-recovery.md](./codes-and-recovery.md)（対処表）にある。
ここに書いた形が実装で変わったなら、**正本を直したうえでこの文書に「なぜ変えたか」を追記する**。

本文中の行番号は **main = `fb660cb`（`cmate-orchestrate` 0.22.0）時点**の実測値である。

---

## 1. 現状（実測）

### 1.1 「推測」がそのまま「権限」になっている

```js
// dispatch.mjs:2219  contractScopeAllow(issue)
const files = Array.isArray(issue.suspected_files) ? issue.suspected_files : [];
// … path として不正なものを落とすだけで、中身は変換しない
```

```js
// dispatch.mjs:2450
lines.push('  requireScopeClean: true');   // 無条件（#50）
```

`suspected_files` は名前のとおり**推測**である —— Issue 本文から `FILE_EXT`
（orchestrate.mjs:574）で path を正規表現抽出した結果にすぎない。それを**1バイトも変換せず**
`scope.allow` へ渡し、`requireScopeClean: true` で厳格に強制している。

**本クラスの障害はすべてこの昇格から出ている。**

### 1.2 同じクラスが3回出た

| # | 症状 | 出所 |
|---|---|---|
| **#56** | `wrangler.jsonc` が抽出されず、指示どおり編集した瞬間に不合格 | `FILE_EXT` に `jsonc` が無い |
| **CommandMate #1678 B-2 / #44** | lockfile が scope 外で、`npm install` した時点で不合格確定 | Issue が manifest しか書かない |
| **#145** | test file が scope 外で、テストを書いた時点で不合格確定 | Issue が実装ファイルしか書かない |

3件とも「**worker がやるべきことをやると落ちる**」であり、3件とも worker 側に回復手段が無い
（契約の scope は send 時に `tasks.contract_json` へ snapshot される）。

### 1.3 過去2回は「planner の出力を正す」ことで解いた

`SCOPE_DEFAULT_COMPANIONS`（orchestrate.mjs:833）のコメントは #145 の主張とほぼ同一の文である。

> a lockfile missing from suspected_files — the worker's future scope.allow —
> **fails the scope gate in a way the worker cannot resolve**. When an issue names a manifest,
> its same-directory lockfiles are therefore **allowed by default**, and reported in the plan's
> `scope_defaults` so a reviewer sees which entries the planner added on the issue's behalf.

- **#56** → 抽出を広げた（`FILE_EXT`）
- **#44** → planner が既定許可として足し、`scope_defaults` に明示した（`scopeDefaultsFor`、
  orchestrate.mjs:841）

**どちらも「人間に Issue を直させる」ではない。** 本 ADR はこの前例を一般化する。

### 1.4 #50 は「導出の禁止」ではない

#145 は `requireScopeClean` を無条件にした #50 のコメントを引き、
「runner が scope を広げてはならない」と結論している。しかし #50 が裁定したのは

- **#50** = *ゲートの適用条件*（空 scope が最広権限になるのを止めた）
- **#44** = *scope の中身*（宣言から機械的に導ける伴走を足す）

の**別々の論点**であり、**両者は 0.22.0 に同居している**。禁じられているのは「**黙って**広げる」
ことで、#44 は `scope_defaults` という可視フィールドを対にすることでそれを回避している。

### 1.5 収束しない再指示が turn を焼く

再指示文（dispatch.mjs:3177）は既によくできていて、違反 path を転記し

> この変更が受入条件の達成に不可避なら worker 側では解決できません — 停止してその旨を報告してください。

とまで書いている。しかし **dispatch は turn 数しか見ずに再送し続ける**。worker は
「テストを消す＝受入条件を落とす」というジレンマに置かれ、実測（Kewton/BorderFreeKidsMap #35）では

```
note: supervision exceeded its hard iteration bound; verification failed (scope)
```

**1回落ちたのではなく、上限まで回っている。** 失ったのは worker 1人分の run
（dispatch 約25分＋検証1周）である。

---

## 2. 裁定 0 — 認可境界は宣言の閉包である

> **`allow = declared ∪ companions(declared)`**
> `companions` は「**宣言されたファイルを編集すれば機械的に付いてくる変更**」に限る。

`scope.allow` は今、**役割が2つ**あり失敗方向が逆である。

| 役割 | 狭すぎると | 広すぎると |
|---|---|---|
| **意図の宣言**（記述） | — | レビューの手がかりが消える |
| **認可境界**（権限） | **正しく実装した worker が不合格**（第1.2節） | scope ゲートが無意味（#50 が塞いだ穴） |

裁定 0 は、**宣言は Issue のものに保ったまま、認可境界だけを閉包へ広げる**。
広げてよい範囲を宣言の関数に縛ることで、#50 の穴（宣言と無関係な広い許可）は開かない。

### 不変条件（3件。すべての段が守る）

1. **導出元は必ず宣言済みファイルである。** 単独の glob を足さない。
   したがって `|closure| ≤ k × |declared|` であり、**影響範囲は宣言に比例する**。
   宣言が空なら閉包も空 —— #50 の「宣言しない plan が最広権限を得る」は起こらない。
2. **足した分は必ず可視である。** plan の `scope_defaults` に列挙する（#44 が確立した安全弁）。
   **黙って広げない。**
3. **契約は plan の純関数のままである。** 導出の入力は plan の中（profile を含む）だけから採る。
   dispatch-contract.md:212 の「**同一 plan → byte-identical な契約**」を壊さない。

---

## 3. 論点1 — 導出をどこに置くか

### 裁定: 4層に分ける

| 層 | 置き場所 | 何を解くか | 設定 |
|---|---|---|---|
| **L1 普遍の導出** | `orchestrate.mjs` | path から確実に導ける伴走。lockfile（**実装済**）、**テスト伴走**、`.d.ts` 等 | **不要** |
| **L2 repo 規約** | **profile** | L1 が知りようのない規約。独自テスト配置、生成物、repo が要求する docs 更新 | profile に記述 |
| **L3 残余の検出** | `orchestrate.mjs` | L1+L2 でも埋まらない矛盾を **dispatch 前に**止める（#145 の警告） | 不要 |
| **L4 ループ遮断** | `dispatch.mjs` | 収束しない再指示で turn を焼き切るのを止める | 不要 |

**L1 は設定ゼロで効かなければならない。** 本クラスを踏む repo は「profile を丁寧に書いていない
repo」と強く相関する（#145 の被害元 Kewton/BorderFreeKidsMap は `verified: false` の独自 profile
である）。**設定を要求する解は、効かせたい相手に効かない。**

### なぜ dispatch が worktree を観測しないのか

dispatch は worktree を持っているので、`git ls-files '*.test.*'` で repo の実際の規約を
**観測**できる。精度は最も高い。**しかし採らない。**

契約が worktree の状態に依存すると、**同じ plan が worktree ごとに違う契約を生む**。
dispatch-contract.md:212 が保証している byte-identical 性（Claude / Codex parity と再現性の根拠）が
失われる。**精度のために再現性を捨てる取引は、この Skill の他のどの裁定とも整合しない。**

### なぜ L2 は profile なのか

「repo を開いて分かったことを書き留める」役目の runner は**既にある** ——
`profile-init.mjs`（#94）である。しかも `flag` / `detected` / `derived` / `default` の provenance と
`evidence[]` を持っており（profile-contract.md 第148〜175行）、`scope_companions` の検出も
**同じ機構にそのまま載る**。

そして **profile は plan の一部**なので、そこに置けば

- **planner は repo を開かない**（orchestrate.mjs:897 が明文化している設計）
- **契約は plan の純関数**（不変条件3）

の両方が保たれる。**repo 知識の唯一正しい入口は profile である。**

### 却下した案

- **Issue 本文に書かせる（#145 の原案の実質）** —— 第1.3節のとおり、同クラスを過去2回は
  planner 側で解いている。3回目だけ人間に差し戻す理由が無い。加えて**恒久的に毎回**
  re-plan 1周のコストが乗り、4件目・5件目（生成物・docs 規約・呼び出し元）ごとに
  同じ検出器を書き足すことになる。**L3 として残すが、第一手にはしない。**
- **`scope.allow` に広い glob（`**/*.test.*` 等）を足す** —— 不変条件1に反する。
  宣言と無関係な許可であり、#50 の穴を別の形で開ける。

---

## 4. 論点2 — 契約 schema で「宣言 scope」と「派生 scope」を分けるか

### 裁定: 分けない。区別は plan 側（`scope_defaults`）だけで持ち、契約へは合流させて渡す

契約 v1 の `scope` は `allow` / `deny` の2キーである。理屈としては

```yaml
scope:
  declared: [...]     # Issue が書いた
  derived:  [...]     # planner が導いた
```

と分けるほうが綺麗で、scope ゲートが「宣言違反だが派生許可内」を報告できるようにもなる。

**しかしこれは上流（CommandMate）の schema 変更である。**
[#125](https://github.com/Kewton/commandmate-skills/issues/125) が既に上流
[Kewton/CommandMate#1756](https://github.com/Kewton/CommandMate/issues/1756) の裁定待ちで
止まっている。**同じ待ちを2本作るのは、本 ADR が解こうとしている実害の解決を遠ざけるだけである。**

区別は plan の `scope_defaults` に残るので**情報は失われない**。
**本 ADR の全段は CommandMate を1バイトも変えずに実装できる。**

### 見直す条件

上流 #1756 が案B（実行契約がゲート定義そのものを運ぶ）で決着し、契約 schema に手が入る機会が
できたなら、そのときに `scope.derived` を同じ波で入れるかを再検討する。

---

## 5. 論点3 — テスト伴走の導出規則（L1）

### 裁定: in-scope のソースファイルごとに、慣習的なテスト path を導出する

```
<dir>/<base>.test.<ext>      <dir>/<base>.spec.<ext>
<dir>/__tests__/<base>.<ext> <dir>/__tests__/<base>.test.<ext>
<dir>/<base>_test.go                          （Go）
<dir>/test_<base>.py         tests/test_<base>.py   （Python）
<dir>/<base>_spec.rb                          （Ruby）
```

`FILE_EXT` が `go|py|java|kt|rb` を含む（orchestrate.mjs:574）以上、**JS だけの規則は
planner の他の部分と非対称になる**。ハードコードは逸脱ではなく既定路線である ——
`FILE_EXT` / `SYSTEM_ROOTS` / `GENERIC_VERIFY_BINARIES` / `SCOPE_DEFAULT_COMPANIONS` は
すべてこの形で持たれている。

### 「使われなかった許可はコストがゼロ」という非対称

lockfile は manifest 名と directory から**決定的**に導けるが、テスト path は規約に依存する。
導出は当たらないことがある。**それでも成立するのは、`scope.allow` が指示ではなく権限だからである。**

`session.test.ts` / `session.spec.ts` / `__tests__/session.ts` を許可して1つしか使われなくても、
**使われなかった2つは何も起こさない。** 一方、導出しなければ worker 1人分の run が失われる。
しかも導出元は in-scope のソースファイルに限られるので、影響範囲は宣言に比例したままである
（不変条件1）。

### 却下: profile 必須にする

第3節のとおり、**設定を要求すると効かせたい相手に効かない。**
profile による上書き・追加は L2 として後から**足す**（`verifyBinaries` が
`GENERIC_VERIFY_BINARIES` を profile の `baseline` で拡張しているのと同じ形）。
**逆順（先に profile を要求する）は戻せない。**

---

## 6. 論点4 — 収束しない再指示をどう止めるか（L4）

### 裁定: 違反 path 集合が前ターンと同一なら、そのループは収束しない。即停止する

「その変更が不可避か」は一般には判定できない。しかし**収束しているか**は判定できる。

```
turn N   : scope 違反 = {A, B}  → 再指示
turn N+1 : scope 違反 = {A, B}  → 同一。worker は同じ結論に到達している
```

このとき再送を続けても結果は変わらない。**停止して `scope_unsatisfiable` を上げる**
（新しい `stop_reason` 値は足さない。既存の裁定不合格の経路に載せ、`blocking_reasons` の code で
名指しする —— #142 が `preflight_failed` に対して採った形と同じ）。

**worker が違反を1つ減らした（＝収束している）なら従来どおり再指示を続ける。**
遮断するのは「同じ答えを繰り返している」場合だけである。

report には**違反 path をそのまま**残す。これは L2 の profile へ書くべき規約そのものであり、
運用者が次に何を宣言すればよいかが report から読める。

### 追記（実装。[#148](https://github.com/Kewton/commandmate-skills/issues/148) / 段2）

裁定どおりに実装した。**形は変えていない** —— `stop_reason` の enum に値は増えず、
停止は既存の裁定不合格の経路（commit があれば `verification_failed`、無ければ `worker_failed`）に
載り、`verification.outcome` は書き換えていない。正本は
[dispatch-contract.md](./dispatch-contract.md) 第2.3.1節（判定と表現）と
[codes-and-recovery.md](./codes-and-recovery.md) 第4節（対処）である。

裁定が決めていなかった3点は、**いずれも遮断が狭くなる側**に倒した。過剰な遮断は
「収束していた worker を殺す」であり、この段が防ごうとしている損失（run 1本）と同じものを
自分で作ることになる。

1. **`--max-turns` 到達の判定を先に見る。** 上限に達した run は従来どおりの note で終わる
   （第10節「既存の期待値を1つも緩めない」）。
2. **比較は連続する2ターンに限る。** あいだに別の結果（exit 0 / 21）が挟まれば比較をリセットする
   —— 裁定文の「前ターン」の文字どおりの読みであり、より狭い。
3. **違反 path を読み取れなかったターンは比較しない。** 「2回とも読めなかった」は
   「同じ path だ」の証拠ではない（`scopeViolationLines` は format 変更に対して逐語引用へ
   劣化する設計なので、空になりうる）。

fixture は5件（`d61` 遮断・`d62` 収束は従来どおり継続・`d63` scope 以外では遮断しない・
`d64` 別の結果が挟まれば比較はリセットする・`d65` 違反 path を読めないターンは比較しない）。
**遮断は fake CLI の send 回数で測っている** —— status だけで見ると「再送してから止まった」を
見逃すからである。

---

## 7. 論点5 — L3（残余の検出）は question か warning か

### 裁定: question（dispatch を停止させる）

`warnings` だけでは **dispatch は `plan.status` を読まない**ので何も止まらない。
無人運転では warning は誰にも届かず、**最も高くつく場所で見逃しがそのまま残る。**

偽陽性のコストが低いことが決め手である。`--unattended` の open-questions ゲートは
`--out` を作る**前**に走る（dispatch.mjs:1762 の `unattendedPlanReasons`）。

> Both are pure functions of the plan, so evaluating them here costs nothing and buys the
> property #90 established for missing worktrees: **the run stops without consuming `--out`**,
> so the same command can be re-run after the issue bodies are fixed and re-planned.

| | 偽陽性（誤って止める） | 見逃し（通してしまう） |
|---|---|---|
| 失うもの | **ゼロ**（`--out` 未消費・再実行可） | worker 1人分の run |
| 人間の手数 | Issue 本文を直して re-plan | Issue 本文を直して re-plan（**同じ**） |

**偽陽性は、それが防ぐ真陽性より厳密に安い。** 非対称がこれだけ明確なら停止側を採る。

### ただし精度は作り込む

既存の question（`no_suspected_files` / `no_acceptance_criteria`）は `length === 0` という
**構造的**判定であり解釈が入らない。L3 は**推論**である。同じ channel に入れる以上、精度で
差を埋める。

- **採る**: 能動的な作成要求のみ（「unit test がそれを判定する」「テストを追加」
  「〜のテストで固定する」、散文中の `*.test.*` 形の path 言及）
- **除外**: 「テストは不要」「既存の…テストが緑のまま」「手動テストで確認」「テストは変更しない」
- **走査対象は `acceptance_criteria` に限定**する（本文全体に広げない）
- **question 本文にマッチした原文を載せる** —— 「なぜ止まったか」が読めれば偽陽性の確認は
  数秒で済む

除外を作らないと、この検出は自分の存在意義を壊す。「テストは不要」と書いた Issue が
「テストが要るのに scope に無い」で止まるのは、**警告が読み手の信用を失う典型**である。
そうなると運用者は `--allow-questions` を常用し始め、**plan 全体に効く**このフラグは
本物の `no_acceptance_criteria` まで一緒に黙らせる。

**除外分岐は変異注入で赤になることを実測する。** 除外を1つ外して緑のままなら、その分岐は
空振りである。

---

## 8. 裁定 A — 推論は機械を止めてよいが、機械に指示してはならない

`extractTestExpectations`（orchestrate.mjs:872）が advisory なのは、その出力が**契約に入る**
からである（同 897行「the planner never opens the target repository」に続く一連の設計）。

L3 は `acceptance_gates` にも `scope.allow` にも**1バイトも書かない**。出力先は人間だけである。
ただし `questions` は dispatch を停止させるので「機械への影響ゼロ」ではない。正確な線は

> **止めることはするが、何をせよとは言わない。**

L1 / L2 は推論ではなく**規則の適用**（宣言済みファイルの関数）なので、契約に入ってよい。
この非対称が、L1・L2 と L3 を別の層に置く理由である。

---

## 9. 証跡（plan / report に何を残すか）

- **plan**: L1 / L2 が足した path は `scope_defaults` に列挙する（既存フィールドを拡張。
  出所を区別したいなら `scope_defaults` を `{path, origin}` 形へ広げるかを実装時に裁定する）。
  L3 は `warnings` と `questions` の両方に出す（既存 question と同じ運用）。
- **dispatch report**: L4 の遮断は `blocking_reasons` に違反 path を添えて記録する。
- **schema version は上げない。** `scope_defaults` は既存フィールドであり、L3 の code は
  既存の question 機構に載り、L4 は既存の停止経路に載る。上げる必要が出たなら、それは
  実装が本 ADR の裁定から外れた合図である。

## 10. 影響しないと決めたこと

- **`requireScopeClean` を緩めない。** #50 の裁定はそのままである。本 ADR が変えるのは
  `allow` の**中身**であって、ゲートの**適用条件**ではない。
- **CommandMate を変えない**（第4節）。上流の裁定を待つ段を1つも作らない。
- **既定の挙動を壊さない。** L1 の導出は `scope_defaults` を増やすだけで、
  既存の d21（scope 再指示）/ d27〜d30 の期待値を1つも緩めない。緩めなければならないなら、
  それは実装が後方互換を壊した合図である。
- **planner が repo を開くようにしない**（orchestrate.mjs:897）。
- **worker 側の回復手段を作らない。** 契約の scope は send 時 snapshot であり、
  それは tamper-safety の根拠である。ここは触らない。

## 11. 実装順（段）

| 段 | 内容 | 効果 |
|---|---|---|
| **1** | L1 にテスト伴走を追加 | **#145 の事象が人手ゼロで消える** |
| **2** | L4 ループ遮断 | 焼損が run 1本 → 1ターン |
| **3** | L3 残余の検出（#145 の中身） | L1 が外した規約を dispatch 前に返す |
| **4** | L2 `scope_companions` ＋ `profile-init` の検出 | 独自規約 repo が段1と同じ状態になる |

**段1と段2だけで、観測された障害は消える**（片方は発生させず、片方は損失を大幅に減らす）。
段3・4 は残余を潰す仕上げである。**段1は本 ADR の他の段に依存しない**ので、
レビューと並行して着手できる。

## 12. 見直す条件

- **4件目が出たとき** —— 生成物・docs 規約・呼び出し元・snapshot のどれで出たかを見て、
  L1 の規則で足りるのか L2 の宣言が要るのかを、その事例とともに判断する。
  **個別の検出器を足す前に、この ADR に戻ること。**
- **L1 の導出が外れる repo が繰り返し出るとき** —— 段4（L2）の優先度を上げる。
- **上流 #1756 が案B で決着したとき** —— 第4節（契約 schema で宣言/派生を分ける）を再検討する。
- **`scope_defaults` が読めない量になったとき** —— 1 Issue あたりの導出数に上限を設けるか、
  `{path, origin}` へ広げて出所で畳むかを裁定する。

---

## 13. 実装時の追記（段1・[#147](https://github.com/Kewton/commandmate-skills/issues/147)）

段1（L1 テスト伴走）を `orchestrate.mjs` の `testScopeDefaultsFor` として実装した。
正本は [plan-contract.md](./plan-contract.md) 第 5.1 節である。第2節の不変条件3件、
第3節の「L1 は設定ゼロ」、第5節の導出規則は**そのまま実装されている**。
第9節のとおり `scope_defaults` は list のまま（`{path, origin}` へは広げていない）で、
`plan_schema_version` も上げていない。

第5節の表から**変えた点が2つ**あるので、第0節の約束に従って記録する。

### 13.1 java / kt を足した

第5節の表は `go|py|rb` までしか挙げていないが、`FILE_EXT` は `java|kt` も受理する。
表のとおりに実装すると、まさに第5節が「JS だけの規則は非対称である」として却下した形が
JVM に対して残る。そこで

```
<dir>/<Base>Test.<ext>                         （単一 module / Android 形式）
src/test/<lang>/…/<Base>Test.<ext>             （src/main/ を持つ path のみ。Maven / Gradle）
```

を足した。`src/main/` → `src/test/` の対応は Maven と Gradle が両方要求する規約であり、
**Go の `_test.go` と同じく path だけから決まる**ので、L1（規則の適用）の範囲に収まる。
`src/main/` segment を持たない path には mirror を出さない。

### 13.2 導出しない拡張子を明示した

`rs` / `sh` / `c` / `h` / `cpp` / `sql` / `css` / `html` は `FILE_EXT` にあるが**規則を持たない**。
Rust の unit test はソースファイルの中（`#[cfg(test)] mod tests`）にあり、それは既に scope 内
である。integration test（`tests/<name>.rs`）と shell / C 系（`*.bats` / `test_*.sh` /
`*_test.c` / `check_*.c`）は**意図に応じて名前が付く**ので path からは決まらない。
第5節の「使われなかった許可はコストがゼロ」は、当たる見込みのある形にだけ効く議論であり、
どの repo にも無い path を作ることまでは正当化しない。**4件目の見直し条件（第12節）に従い、
実際の Issue が形を示したときに足す。**

### 13.3 上限

第12節が予告した上限は、可読性ではなく**正しさ**の理由で先に必要だった。
`dispatch.mjs` は `scope.allow` を **sort してから** `MAX_SCOPE_PATTERNS`(=200) で切り詰めるので、
上限を超えた list は導出済み path が宣言済み path を押し出す —— 本 ADR が消そうとしている
障害そのものである。したがって導出は、issue の重複除去後の合計が 200 に達する前に
**source file 単位で打ち切る**。fixture の実測はどれも1桁である。
