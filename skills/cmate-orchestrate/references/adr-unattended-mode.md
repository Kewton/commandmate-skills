# ADR: 全自動モード（unattended）の契約改版（[#95](https://github.com/Kewton/commandmate-skills/issues/95)）

status: **proposed**（人間のレビュー待ち。この文書が承認されるまで実装に入らない）

ロードマップ Phase 4（エピック [#96](https://github.com/Kewton/commandmate-skills/issues/96)）である。
ビジョンは「承認つき運転（plan → **人間の承認** → dispatch）を**既定として維持したまま**、
明示 opt-in の全自動モード（CI / cron 起動等の無人運転）も選べるようにする」と定めている。
本 ADR は、その opt-in が**何を変え、何を絶対に変えないか**の 7 論点を裁定する。

この文書は **裁定の記録**であり、契約の正本ではない。実装後の正本は
[dispatch-contract.md](./dispatch-contract.md)（第1節の入力・第3節の停止・第5節の status/exit）・
[merge-contract.md](./merge-contract.md)（第4節の2 gate）・[uat-contract.md](./uat-contract.md)
（第5節の修正ループ）と [../SKILL.md](../SKILL.md)（第3節の設計思想・第5節の対処表）にある。
ここに書いた形が実装で変わったなら、**正本を直したうえでこの文書に「なぜ変えたか」を追記する**
（[release-notes.md](./release-notes.md) と同じ運用）。

本文中の行番号は **main = `3105722` 時点**の実測値である。

---

## 1. 現状（実測）

### 1.1 「人間の承認」は 1 つではなく 2 つの別物である

[SKILL.md](../SKILL.md) 第3節は「**plan →（人間の承認）→ dispatch → merge / uat** の順に、
別々の invocation で呼ぶ。1つの runner が次の phase を勝手に始めることはない」と述べる。
この文の中に、実装形態の異なる承認が 2 つ入っている。

| 承認 | どこに実装されているか | 破り方 |
|---|---|---|
| plan → dispatch の承認 | **どこにも無い。** 人間が plan を読んでから `dispatch.mjs` を叩く、という**運用**でのみ表現される | `orchestrate.mjs` の直後に `dispatch.mjs` を書いた shell script を1本置けば、今日でも承認は消える |
| merge / uat の承認 | **フラグとして在る。** `--approve` が無ければ mutation しない preview（`merge.mjs` 839 / 945行、`uat.mjs` 708 / 1113行）。`approval_enforced` completion check が `mutated ⟹ approved` を自己申告する | `--approve` を渡す |

**この非対称が本 ADR の出発点である。** dispatch には外すべき承認フラグが存在しない。
したがって「dispatch を無人化する」は、機能の追加ではありえない。

### 1.2 無人で困る停止点は、既にひととおり在る

dispatch runner は既に、人間の介在を前提とした停止をいくつも持っている。

- **prompt 検出（exit 10）** — `capture` で内容を取り、**自動応答せず**停止する
  （[dispatch-contract.md](./dispatch-contract.md) 第3.1節）。`human_required` が true になる。
- **裁定不能（exit 99）** — 「どのゲートもこの作業を判定していない」。pass に丸めず、
  再指示ループにも流さず、`human_required` で上げる（同 第2.6節）。
- **`open_questions`** — 未回答の planner question を持つ Issue が1件でもあれば
  **1人も dispatch せずに停止**する（`dispatch.mjs` 2047〜2056行）。
- **`worktree_unresolved`**（[#90](https://github.com/Kewton/commandmate-skills/issues/90)）・
  **`worktree_setup_*`**（[#93](https://github.com/Kewton/commandmate-skills/issues/93)）・
  **`drift_<check>`** — いずれも pre-flight の blocking である。

merge / uat 側も同様に、CI pass・conflict・上限到達で止まる（第6節に全列挙する）。
**無人運転のために新しく作らなければならない停止は、実のところ多くない。**

### 1.3 Auto-Yes は既定 off で、契約にもそう書かれる

`--auto-yes` の既定は off（`dispatch.mjs` 366行）。指定時のみ exit 10 で `respond yes` を送る
（同 1672行・1808行）。生成する実行契約にも `autoYes: mode: off`（指定時は `safe`）を書き出す
（同 1158〜1159行）。コメントが理由を記録している —
「契約は runner 自身と同じ Auto-Yes 姿勢を宣言するので、サーバ側の方針と監督ループが食い違えない。
`off` は能動的な禁止であり、ブロックの省略（何も言わない）とは違う」。

ただし **2 つは同じものではない。** 契約の `safe` は製品側の分類つき方針であり、
runner の `respond yes` は **prompt の種類を見ない無条件の yes** である。

### 1.4 空 scope の拒否は、契約経路の**内側にしかない**

Issue [#50](https://github.com/Kewton/commandmate-skills/issues/50) の裁定により、
plan が対象 file を1つも挙げていない Issue は dispatch されず、`contract_scope_unknown` を
limitation に記録して `not_dispatched` のまま残る。

**この判定は `if (contractMode)` の内側にある**（`dispatch.mjs` 2190〜2206行）。すなわち:

1. **フォールバック経路（`--contract-mode off`、または契約非対応 CLI での `auto`）では、
   空 scope の Issue も dispatch される。** そこには `success.requireScopeClean` が無い
   ——契約が無いのだから scope ゲートという概念自体が無い。
2. 契約経路でも、この判定は **wave の worker ループの中**にある。同じ wave の他の worker は
   **その前に既に `send` 済み**である。つまり「scope 未宣言で止まった」run は、
   **止まった時点で他 Issue の mutation が始まっている**。

`--contract-mode auto`（既定）は、契約非対応 CLI を見つけると `contract_unsupported` を
limitation に記録して**続行**する（同 第2.7節）。人間が居れば summary の冒頭でそれを読む。

### 1.5 上限は既にすべて有界である

| 上限 | 値 | 到達時 |
|---|---|---|
| dispatch `--max-turns` | 既定 8 | 未 commit なら当該 worker を `failed` |
| uat `--max-attempts` | 既定 2・**ceiling 5**（`uat.mjs` 114〜115行、`positiveInt` で範囲外は拒否） | `blocked`（exit 8）で停止。`max_attempts_reached`。**成功に丸めない** |
| wave 幅 | plan の `max_parallel`（1〜3） | 超える plan は `plan_invalid` |

**回数の無限ループは構造的に存在しない。** 一方で **時計の上限は無い**
（wall-clock は `--wait-timeout` × ターン数で暗黙に決まるだけ）。

### 1.6 したがって、欠けているのはフラグではなく宣言である

今日でも CI から `--approve` を渡せば merge / uat は無人で動く。#95 が足すべきものは
「動くこと」ではなく「**無人であると runner が知っていること**」である。知らないために、
人間が居る前提の劣化——黙って弱い裁定機構に落ちる（1.4）・prompt を提示して待つ（1.2）・
証拠が読めなくても続ける（第6.3節）・意味ゲート無しのまま pass にする（第6.4節）——が、
誰も読まない run でそのまま起きる。

---

## 2. 裁定 0 — unattended が外すのは「人間の待ち」であって、ゲートではない

**`--unattended` は「この invocation に人間は居ない」という入力の宣言である。**
mutation の権限を与えるフラグではない。次の 4 つを不変条件とする。

1. **緩めない。** unattended はどのゲートも無効化せず、どの blocking も limitation に格下げせず、
   どの status も1段上げない。**含意するのは締め付けだけである。**
2. **緩和フラグとの併用を拒否する。** `--auto-yes` / `--allow-questions` /
   `--contract-mode off|auto` との併用は `invalid_input`（exit 3）で拒否する（第3・4節）。
   **黙って上書きしない** ——指定した値が効かない状態を作らない
   （#93 が `--worktree-setup` の二重指定を拒否したのと同じ型）。
3. **mutation の許可は `--approve` のままである。** `--unattended` は `--approve` を含意しない。
   merge / uat を無人で動かす CI は**両方**を書く。こうすれば report の `approved: true` は
   従来どおり「この mutation は明示的に承認された」を意味し続け、schema の description を
   変えずに済む。**「無人だから安全側に倒したい」つもりで `--unattended` を付けた operator に、
   mutation 権限が付いてくることは無い。**
4. **runner は次の phase を始めない。** 無人運転の driver は **CI の job 定義（または cron
   script）**であって runner ではない。[SKILL.md](../SKILL.md) 第3節の
   「1つの runner が次の phase を勝手に始めることはない」は unattended でも**そのまま維持する**。

不変条件 4 が重要である。これを崩すと「plan → dispatch → merge → uat を1コマンドで回す
新しい runner」が要り、それは4 runner が別々に持っている停止・artifact・再実行性
（`out_exists` / `run_exists` / `--out` 未消費）を1つに畳む変更になる。#95 が求めているのは
運転モードであって、5つ目の runner ではない。

### 2.1 この裁定で #95 の「契約の根幹に例外を作る」に答えたことになるか

なる。**例外を作らない、が本 ADR の答えである。** 承認つき運転が守っていたものは
「人間が読む」ことそのものではなく、**人間が読むまで壊れた状態が下流へ流れないこと**である。
無人でその保証を維持する方法は、承認を機械に代行させることではなく、
**人間に提示して待つ経路を、その場で止まる経路に変換すること**である。

---

## 3. 論点1 — `scope.allow` の必須化

### 裁定

**unattended では、次の 2 つを両方行う。片方だけでは意味を持たない。**

1. **pre-flight で全 Issue の scope 非空を検査し、all-or-nothing で停止する。**
   plan の全 Wave の全 Issue について `suspected_files` が空でないことを、
   **`--out` を作る前**（[dispatch-contract.md](./dispatch-contract.md) 第3.0節）に確かめる。
   1件でも空なら **1人も dispatch せず** exit 1 で止まる。
2. **契約経路を必須にする。`--unattended` は `--contract-mode require` を含意する。**

### 理由

(1) は「拒否を足す」のではなく「**拒否する時点を早める**」変更である。現行の拒否は wave の
worker ループの中にあり、同じ wave の他の worker は既に `send` 済みである（第1.4節）。
人間が居る運転ではこれで足りる——止まった report を人間が読み、走ってしまった worker を
自分で始末できる。無人ではその読み手が居ないので、**mutation を1つも始めていない状態で
止まる**ことに意味がある。#90 が `--out` を消費せずに止まることを選んだのと同じ理由であり、
#93 が部分成功を all-or-nothing にしたのと同じ理由である。

(2) が無いと (1) は空文になる。フォールバック経路には `requireScopeClean` が存在せず
（第1.4節）、**scope.allow を必須にするとは、契約経路を必須にすることと同義**だからである。
`--contract-mode auto` の既定は「契約が無ければ弱い裁定に落ちて続行する」であり、
人間が summary 冒頭でそれを読むことを前提にした劣化である。無人では読み手が居ない。

### code と停止形

停止は `blocking_reasons` に **`contract_scope_unknown` を Issue ごとに1件**
（#90 が `worktree_unresolved` で採った形）、`stop_reason` は `dispatch_error`、
status は `failure`（exit 1）である。**新しい code を作らない。** 対処が現行と同一
（「Issue 本文に対象 file を書いて re-plan する」）だからである。#90 が専用 code を新設したのは
対処が正反対だった（worker を調べる vs worktree を作る）からであって、検出時点が早まっただけの
ここには当てはまらない。

この経路で止まったときは **`limitations` に `contract_scope_unknown` を二重に書かない**
（`worktree_unresolved` が `drift_worktrees_present` を limitations に残さないのと同じ、
blocking_reasons への一本化）。

### plan の warning 一般では止めない

plan の `no_suspected_files` warning と dispatch の `contract_scope_unknown` は同じ事実の
両側である。unattended はこの事実を pre-flight で拒否するが、**plan の warning が1件でもあれば
拒否する、にはしない。** `profile_repository_override` のように operator が意図して作る warning が
あり、一律 blocking にすると unattended は「plan を完全に綺麗にできない限り使えないモード」になる。
`no_acceptance_criteria` だけは別枠で、第9節（#100 依存）で段階 C の前提として扱う。

### 検討した案と却下理由

| 案 | 内容 | 裁定 |
|---|---|---|
| A | 現行のまま（wave 内で1人ずつ拒否） | **却下。** 無人では、止まった時点で他 Issue の worker が走っている状態を誰も始末しない |
| B | scope が空なら unattended が scope を推定して補う | **却下。** 推測した scope は誰も承認していない。#100 第2.3節「ゲートが無いことは、間違ったゲートが在ることより安全である」の scope 版であり、しかも scope は**書き込み権限**なので害はゲートより大きい（Issue #54） |
| C | scope が空の Issue だけ除外して残りを dispatch する | **却下。** wave の barrier は「この集合を並列に走らせる」約束の上に立つ（#93 論点2）。無人で集合を黙って縮めると、「全部通った」の意味が run ごとに変わる |
| D | pre-flight で all-or-nothing に止め、契約経路を必須にする | **採用** |

---

## 4. 論点2 — Auto-Yes の扱い

### 裁定

**既定 off を維持する。`--unattended` は `--auto-yes` を含意しない。
そして `--unattended --auto-yes` の併用を `invalid_input`（exit 3）で拒否する。**

契約に書き出す `autoYes` も **`mode: off` のまま**である。

### 理由

**#95 の要件4（human_required 相当は無人でも必ず停止する）と `--auto-yes` は、
同じ run の中で両立しない。** `--auto-yes` は exit 10 を `respond yes` で消費して同ターンを
続行する（`dispatch.mjs` 1672行）。すると prompt 停止という human_required 経路が
**構造的に到達不能**になる。「無人でも prompt では止まる」と宣言した run が、
「prompt には全部 yes と答える」と宣言することはできない。

「限定的な auto-yes（安全な prompt だけ答える）」を作らないのも同じ理由である。
runner の `respond yes` は prompt の種類を見ない（第1.3節）。分類を runner 側に実装すれば、
**それは製品側の autoYes ポリシーの二重実装**になり、契約が `off` と宣言している方針を
呼び出し元が上書きする形になる。契約の `safe` モードは製品側の分類であって、
runner の無条件 yes とは別物である——この区別を消さない。

拒否を「limitation に記録して続行」にしないのは、limitation が停止しないからである。
自己矛盾した2つの宣言のうち片方を黙って勝たせる実装は、どちらが勝ったかを report の
読み手（＝無人運転では次の job）が判定できない。

### 併せて閉じる: `--allow-questions`

`--unattended --allow-questions` も同じ理由で `invalid_input` とする。
`--allow-questions` は「未回答の question を**引き受けて**進む」宣言であり、
引き受ける主体が居ないときに立てられる旗ではない。

### 塞げない穴を明示する: monitor という側面経路

[cmate-orchestrate-monitor](../../cmate-orchestrate-monitor/) は既定で prompt に Enter を送る
（`--no-auto-approve` は off が既定。同 [monitor-contract.md](../../cmate-orchestrate-monitor/references/monitor-contract.md) 第3節）。
同じ worktree に monitor を当てながら unattended dispatch を走らせると、
**dispatch が止まるはずの prompt に monitor が答えうる**。

これは dispatch runner が機械的に強制できない（別プロセス・別 Skill・別 install）。
したがって:

- **契約の `autoYes: mode: off` がサーバ側の最後の砦である。** 第1.3節のコメントが書いている
  「サーバ側の方針と監督ループが食い違えない」という性質が、ここで効く。
- **unattended 運転で monitor を併用するなら `--no-auto-approve` は必須**である旨を、
  実装フェーズで [SKILL.md](../SKILL.md) 第3.2節の monitor 境界の記述に足す。
  現在の記述（「併用するなら monitor 側に `--no-auto-approve` を付ける」）を、
  unattended では推奨ではなく要件に格上げする。
- **runner はこれを検出しない。** 検出できないものを検出したふりをしない
  （プロセス一覧を覗く実装は、環境依存で false negative を出しながら「確認した」と report する）。

---

## 5. 論点3 — 修正ループの上限（uat `--max-attempts`）

### 裁定

**上限機構も既定値も ceiling も変えない。** 変えるのは 1 点だけ:
**unattended で `fix_uat` を回すときは `--max-attempts` の明示を必須にする**
（未指定は `invalid_input`）。

| 項目 | unattended での扱い |
|---|---|
| ceiling（5） | **据え置き。** 無人だから緩める、は逆である。読み手が居ないほうが暴走の被害半径は大きい |
| 既定（2） | **据え置き。ただし unattended では既定に落ちない**（明示必須） |
| 上限到達 | `blocked`（exit 8）・`max_attempts_reached`。**無人でも成功に丸めない**（第6節） |
| dispatch `--max-turns`（8） | 据え置き。明示も要求しない（worker 1人あたりのターン数であり、mutation の反復回数ではない） |
| 新しい上限 | **作らない**（下記） |

### 理由

回数の上限は既にすべて有界であり（第1.5節）、無限ループは構造的に存在しない。
無人化が壊すのはその有界性ではなく、**「何回まで機械に直させてよいか」を誰かが決めた、という
事実**である。人間が居る運転では、`--approve` を打つ人が既定 2 を黙認したことがその決定になる。
無人ではその瞬間が無いので、**job 定義を書く時点でしか決められない**。明示必須はそのための、
最も安い装置である。

**時計の上限（wall-clock budget）を本 ADR では作らない。** 作るなら「打ち切ったときの status を
何にするか」「打ち切りの途中で mutation がどこまで進んだか」を全 runner で定義する必要があり、
それは回数上限とは別の契約である。cron 二重起動と併せて第13節の未決事項に置く。

---

## 6. 論点4 — 無人でも必ず停止するもの（網羅列挙）

### 6.1 規律

**unattended は、停止理由・status・exit code の写像を1つも変えない。**

| status | exit | unattended での意味 |
|---|---|---|
| `success` | 0 | 全部通った。**CI が成功と読んでよい唯一の値** |
| `partial` | 7 | 途中停止。**成功ではない** |
| `blocked` | 8 | uat の上限到達。**正当な停止であって成功ではない** |
| `failure` | 1 | 何も試せなかった |
| `invalid_input` | 3 | 呼び出しが矛盾している（第2節の不変条件 2） |

**`human_required` の意味も変えない。無人でも true にする。** この field が意味するのは
「人間が今そこに居る」ではなく「**人間の介入なしには解けない**」である
（schema の description が既にそう書いている: "None of the three is resolvable by
re-dispatching"）。CI はこれを「再実行しても無駄である」の signal として読む。
無人だからといって false にすれば、CI は再実行し続ける。

### 6.2 dispatch — 無人でも止まる停止（[dispatch-contract.md](./dispatch-contract.md) 第5節の語彙）

| stop_reason | code | なぜ無人でも止まるか |
|---|---|---|
| `human_required` | `human_input_required` | **prompt 検出（exit 10）。** 自動応答しない（第4節） |
| `dispatch_error` | `verification_not_judged` | **exit 99。** 何も判定していない。再 dispatch で解けない |
| `dispatch_error` | `open_questions` | 未回答 question。Issue 本文の編集でしか解けない。`--allow-questions` は unattended では拒否される（第4節） |
| `dispatch_error` | `contract_unsupported` | unattended は `--contract-mode require` を含意する（第3節）ので、契約非対応 CLI は**必ず**停止になる |
| `dispatch_error` | `contract_scope_unknown` | scope 未宣言。**pre-flight で全 Issue 分**（第3節） |
| `dispatch_error` | `not_dispatched` | runner が起動を拒否した（unsafe worktree target 等） |
| `dispatch_error` | `worktree_setup_unavailable` / `worktree_setup_failed` / `worktree_profile_mismatch` | #93 の準備段の失敗。準備できなければ dispatch 対象が存在しない |
| `dispatch_error` | `wave_not_advanced` | 上のどれでもない理由で wave が advance しなかった（防御的な既定） |
| `drift` | `worktree_unresolved` | 送る先が無い（#90）。**未解決 Issue ごとに1件** |
| `drift` | `drift_cli_available` / `drift_repo_access` / `drift_base_resolvable` / `drift_branch_matches` | plan 承認後に世界が動いた。**drift の上に dispatch しない** |
| `worker_failed` | `worker_failed` | `--max-turns` 到達で未 commit |
| `timeout` | `worker_timeout` | `wait` の timeout |
| `verification_failed` | `verification_failed` | completed した worker の裁定が pass でない |

**この表に「unattended だけの停止」は1つも無い。** 第3節が足したのは検出時点であって、
停止理由ではない。

### 6.3 merge — 無人でも止まる停止（[merge-contract.md](./merge-contract.md) 第6節の語彙）

| stop_reason | なぜ無人でも止まるか |
|---|---|
| `ci_failed` / `ci_pending` | **CI green 無しに merge しない。** check 0 件も green にしない |
| `merge_failed` | **merge conflict。** 無人で解消しない（解消は人間の判断である） |
| `pr_missing` / `pr_closed` / `pr_create_failed` | 納品対象の PR が想定した状態に無い |
| `preflight_failed` / `runner_error` | gh / git / repo 到達性 |

### 6.4 uat — 無人でも止まる停止（[uat-contract.md](./uat-contract.md) 第7節の語彙）

| stop_reason | なぜ無人でも止まるか |
|---|---|
| `acceptance_conditional` | **`conditional_go` は human 判断であって自動修正の対象ではない**（同 第4.2節）。無人でも条件を自動で閉じない |
| `max_attempts_reached` | 上限到達（`blocked` / exit 8）。**成功に丸めない** |
| `remerge_failed` | 再merge の conflict |
| `uat_failed` / `worktree_failed` / `fix_failed` | 判定不合格・fix worktree 不成立・fix worker の失敗（fix loop も prompt に自動応答しない） |

### 6.5 段階 C でだけ blocking に昇格するもの

無人 merge（第8節の段階 C）は「証拠が読めなかった」を許容できない。人間が居る運転では
report を読む人が補える欠落が、無人では**そのまま merge の根拠**になるからである。

| 現行 | 段階 C での扱い | 理由 |
|---|---|---|
| `verification_gates_unrecorded`（limitation・dispatch） | **blocking** | pass の根拠となった gate を report が名指しできない。#100 第2.3節「何を測っているか誰も知らないゲートは、緑の証拠能力を持たない」 |
| `change_evidence_unavailable`（limitation・merge） | **blocking** | 宣言 scope と実変更を対比できない。「読めなかった」を「scope 内だった」と読ませない（同 第5.2節 規則2） |
| `acceptance_not_run`（limitation・uat） | **起こさない** | 段階 C の uat 無人化は `--require-acceptance` を含意する（第8節）。意味ゲート無しの無人 UAT は baseline 再実行にすぎず、「受入を確認した」という主張ができない |

段階 A / B ではいずれも limitation のままである。昇格は**無人で不可逆な操作をするとき**にだけ
正当化される。

**`branch_changed_outside_declared_scope`（merge）は昇格しない。** 契約ゲート
`requireScopeClean` が上流で既に判定しており、unattended は契約経路を必須にしている（第3節）ので、
この limitation は「機械ゲートが通ったうえでの人間可読版」であることが保証される。
第3節の裁定がここで効いている。

### 6.6 #100 の予約席

[adr-issue-acceptance-gates.md](./adr-issue-acceptance-gates.md) 第8.1節が本 ADR へ引き渡した
fail-closed 停止を、実装されしだい第6.2節の表に加える。いずれも**再 dispatch では解けない**ので
exit 99 と同じ扱い（`human_required` = true）である。

| code | 意味 |
|---|---|
| `acceptance_gate_block_invalid` | 受入ゲートの記法違反（書いたはずの条件が黙って消えた run を緑にしない） |
| `acceptance_gate_id_unknown` | 宣言したゲートが verify.yaml に存在しない |
| `acceptance_gates_tampered` | judge が書き換えられた（#100 段階 2） |

---

## 7. 論点5 — 失敗時の被害半径と取り消し手順

### 7.1 何が mutate されるか

| 段 | mutation | 可逆性 | 取り消し |
|---|---|---|---|
| dispatch 準備段（`--prepare-worktrees`） | ローカル worktree / branch の作成 | 可逆 | `cmate-worktree-cleanup`。**runner は消さない**（#93 論点3） |
| dispatch | worktree の `.commandmate/tasks/*.yaml` に契約を置く | 可逆 | 放置してよい（work-evidence と scope の計数から除外される。#1580） |
| dispatch | **worker が worktree の branch に commit する** | ローカル可逆 | `git reset --hard <開始時 SHA>`（7.2） |
| merge `--create-prs` | `git push --set-upstream origin <branch>`（`merge.mjs` 695行）→ **remote に branch が出る**。`gh pr create`（同 702行）→ **PR が立つ** | 可逆だが**外部に出る** | `gh pr close <n>` → `git push --delete origin <branch>`。**PR は close であって削除ではない**（履歴・通知は残る） |
| merge `--merge-prs` | `gh pr merge`（同 743行）→ **base branch が進む** | **実質不可逆** | revert PR を立てる（squash なら `git revert <sha>`、merge commit なら `-m 1`）。**force push で消さない** |
| uat `fix_uat` | fix worktree / fix branch の作成、fix worker の commit | ローカル可逆 | `cmate-worktree-cleanup` |
| uat `fix_uat` | `git merge --no-ff --no-edit <fix-branch>`（`uat.mjs` 922行）。**cwd 指定が無い**ので、**invocation cwd の現在の branch** へ merge される | ローカル可逆 | `git reset --hard <merge 前の SHA>` |

**副作用は git だけではない。** push は対象リポジトリの CI を起動する（実行時間・課金・通知）。
PR 作成は reviewer に通知を出す。**取り消せるのはリポジトリの状態であって、送られた通知ではない。**

### 7.2 取り消しを実行可能にする（`unattended_baseline`）

`git reset --hard <開始時 SHA>` と書けても、**その SHA が report に無い。** dispatch は
worktree の HEAD を dispatch 前に読んでいるが（`dispatch.mjs` 1405〜1411行 `worktreeHeadSha`）、
これはメモリ上の比較にしか使われておらず、report には残らない。

**裁定: unattended の run は、dispatch 開始時の各 worktree HEAD を短縮 SHA で
`limitations` に記録する（`unattended_baseline`。Issue ごとに1件）。**

- `dispatch_schema_version` は **1 のまま**、**field を足さない**。#93 が `worktree_prepared` で
  base SHA を limitations に載せたのと同じ経路である（同 第7節）。
- **branch 名と短縮 SHA で書く。絶対 path は書かない**（redaction が絶対 path を残さない。
  同 第4節）。取り消し手順が絶対 path を要求する形だと、report からは実行できない。
- 併せて run 全体で1件の `unattended_mode` を記録する（段階・含意した締め付け・
  拒否した緩和フラグ）。**何を宣言して走ったかが report 単体で読める**ようにするためであり、
  #47 / CommandMate #1678 B-5 の「report 単体で根拠が読める」と同じ規律である。

### 7.3 段階ごとの被害半径

| 段階 | 無人で到達する最遠点 | 外部に出るか | 不可逆か |
|---|---|---|---|
| A | worktree branch の commit | **出ない** | いいえ |
| B | remote branch + PR | 出る | いいえ（close + delete で戻る） |
| C | base branch の merge / 再merge | 出る | **はい** |

この表が第8節の段階分けの根拠である。**不可逆点は段階 C にしか無く、段階 C だけが #100 を
前提とする。**

---

## 8. 論点6 — 貫通範囲（段階導入）

### 裁定

**`--unattended` は runner ごとに独立のフラグとし、受け付ける runner を段階的に広げる。**
未実装の段に渡された `--unattended` は **`invalid_input` で拒否する**（黙って無視しない）。

| 段階 | 受け付ける runner | 追加で含意するもの | 前提 |
|---|---|---|---|
| **A** | `dispatch.mjs` | `--contract-mode require`、pre-flight の scope 検査、`unattended_baseline` の記録 | 無し。**本 Issue の実装範囲** |
| **B** | + `merge.mjs --create-prs` | `change_evidence_unavailable` の blocking 昇格 | A |
| **C** | + `merge.mjs --merge-prs`、`uat.mjs --create-uat-fix-worktrees` | `verification_gates_unrecorded` の blocking 昇格、uat は `--require-acceptance` と `--max-attempts` の明示 | B ＋ **#100 段階1**（第9節） |

### 段階 A で dispatch の `--unattended` は何を足すのか

**権限は1つも足さない。締め付けだけを足す。** dispatch には外すべき承認フラグが無いのだから
（第1.1節）、これが唯一ありうる形である。具体的には第3節の 2 つ（pre-flight の scope 検査・
契約経路の必須化）と、緩和フラグの拒否（第4節）と、`unattended_baseline` の記録（第7.2節）である。

「それなら段階 A は unattended ではなく strict モードではないか」という問いには、そのとおりだと
答える。**dispatch における無人化とは strict 化のことである**、が本 ADR の裁定であり、
第1.6節の観察の帰結である。名前を `--strict` にしない理由は 2 つある: (a) 段階 B / C で
同じフラグが merge / uat に渡り、そこでは「人間が読む前提の劣化を止める」という同じ意味を持つ。
(b) `--unattended` は**なぜ厳しくするのか**を宣言する——strict は程度を、unattended は理由を言う。

### 未実装の段を黙って無視しない

段階 A の実装に対して `merge.mjs --create-prs --approve --unattended` を渡すと
`invalid_input` で落ちる。**受理して無視すると、CI は自分が守られていると誤解する。**
`--prepare-worktrees` 無しの `--worktree-setup` を `invalid_input` で拒否するのと同じ型である。

### runner 間で unattended を伝播させない

merge / uat は「上流の dispatch が unattended だったか」を検査**しない**。

- 各 runner の `--unattended` は独立の宣言である。伝播させると、部分再実行
  （[#98](https://github.com/Kewton/commandmate-skills/issues/98) の `--resume`）や、
  「dispatch は人間が見ていたが merge は夜間に回す」という正当な運用が組めなくなる。
- merge / uat が dispatch report から読むのは、従来どおり `worker_state` と
  `verification.outcome` の **2 field だけ**である（[dispatch-contract.md](./dispatch-contract.md)
  第7節）。ここに 3 つ目を足すと、version 据え置きの根拠そのものが崩れる。

---

## 9. 論点7 — [#100](https://github.com/Kewton/commandmate-skills/issues/100)（受入条件の機械ゲート化）との関係

### 裁定

**段階 A / B は #100 を前提としない。段階 C は #100 の段階1（`require:`）の実装を
明示的な依存とする。**

[adr-issue-acceptance-gates.md](./adr-issue-acceptance-gates.md) 第8.1節の主張をそのまま引き取る:

> 無人運転の安全性は、機械ゲートの充実度にそのまま比例する。〔…〕本 ADR が実装されていない
> 状態の unattended は、「lint と test が通った」を「Issue が完成した」と読み替えて
> merge まで進む機構である。

この主張は**不可逆な操作にだけ効く**。段階 A / B が到達する最遠点は PR であり（第7.3節）、
PR は人間が読む場所である——#97 が PR 本文に検証証拠を載せたのは、まさにそのためである。
**「lint と test が通った」を「Issue が完成した」と読み替えた成果物が PR として立つことは、
害ではなく本来の姿である**（レビュアーが読み、必要なら close する）。段階 C は違う。
そこで読み替えが起きると、誰も読まないまま base branch に入る。

### 段階 C が #100 に要求すること

1. **`require:` が契約に載る経路が実装されていること**（#100 段階1・同 第3.3〜3.4節）。
2. **対象 Issue が受入ゲートブロックを持つことを、段階 C の unattended が要求できること。**
   #100 第8.1節は「要求可能性だけを保証する」と書いている。**本 ADR はそれを要求する側に倒す**:
   段階 C では、ブロックを持たない Issue（および plan の `no_acceptance_criteria` に該当する
   Issue）を **無人 merge の対象にしない**。除外ではなく停止とし、対象集合を黙って縮めない
   （第3節・却下案 C と同じ理由）。
3. **#100 の fail-closed 停止が第6.6節の表に入っていること。**

段階 C の着手条件はこの 3 つであり、実装フェーズの表（第12節）でもそう書く。
**#100 が承認されないまま段階 C を出さない。**

---

## 10. 却下した案

| 案 | 却下理由 |
|---|---|
| **A. `--unattended` を `--approve` の別名にする** | report の `approved` が「人間が承認した」を意味しなくなる。merge / uat の schema description を書き換えることになり、既に世に出た report の読み方が変わる（[merge-contract.md](./merge-contract.md) 第10節の version 規律に反する）。加えて第2節の不変条件 3 のとおり、締め付けのつもりのフラグに mutation 権限が付いてくる |
| **B. plan → dispatch → merge → uat を通す 5 つ目の runner を作る** | [SKILL.md](../SKILL.md) 第3節の「1つの runner が次の phase を勝手に始めることはない」を壊す。4 runner が別々に持つ停止・artifact・再実行性（`out_exists` / `run_exists` / `--out` 未消費）を1つに畳む変更であり、#95 が求めているのは運転モードであって新しい runner ではない。無人運転の driver は CI の job 定義である |
| **C. unattended では prompt に自動応答する** | 第4節。#95 の要件4 と両立しない。prompt 停止が構造的に到達不能になる |
| **D. unattended では「安全な prompt」だけ自動応答する** | 製品側 autoYes ポリシーの二重実装になり、契約が `off` と宣言した方針を呼び出し元が上書きする形になる。runner の `respond yes` は prompt の種類を見ない（第1.3節） |
| **E. unattended では `--max-attempts` の ceiling を上げる** | 第5節。読み手が居ないほうが暴走の被害半径は大きい。緩める方向の変更は第2節の不変条件 1 に反する |
| **F. 停止したら unattended は自動で re-dispatch する（自己回復）** | 第6.2節の停止のうち大半は**再 dispatch では解けない**（exit 99・`open_questions`・`contract_scope_unknown`・`worktree_unresolved`）。解ける停止と解けない停止を runner が区別して再実行する機構は、`--resume`（#98）が扱う問題であり、運転モードの問題ではない |
| **G. unattended は blocking を limitation に落として最後まで走り切り、まとめて報告する** | 「無人でも成功に丸めない」の正反対である。壊れた状態を下流へ流さないことが、承認つき運転が守っていた唯一のものである（第2.1節） |
| **H. `--unattended` を環境変数（`CI=true` の検出等）で暗黙に有効化する** | 明示 opt-in でなくなる。#95 要件2 に反する。加えて、同じコマンドが環境によって別の契約で走ることになり、plan の決定性と同じ理由で受け入れられない |
| **I. dispatch report に `unattended` boolean field を足す** | additive ではあるが（[dispatch-contract.md](./dispatch-contract.md) 第7節）、#93 が `worktree_setup_*` で確立した「事実は `limitations` の code で運ぶ」経路が既にある。merge / uat が dispatch report から読む field を 2 つに保つ根拠（同 第7節）を、運転モードのために崩さない |

---

## 11. 後方互換性

**`--unattended` を渡さない run は、1 bit も変わらない。** これは努力目標ではなく、
実装フェーズで fixture 化する要件である（第12節 段5）。

- **dispatch**: 既定の `--contract-mode auto` はフォールバックに落ちて続行する。空 scope の Issue は
  従来どおり wave の中で1人ずつ拒否される（`contract_scope_unknown` は **limitation** のまま）。
  `--auto-yes` / `--allow-questions` は従来どおり受理される。
- **merge / uat**: `--approve` の意味も、`approved` field の意味も、既定値も変わらない。
  `--max-attempts` の既定 2 は据え置き（明示必須になるのは unattended のときだけ）。
- **schema**: `dispatch_schema_version` / `merge_schema_version` / `uat_schema_version` は
  **すべて 1 のまま**。field を足さず、enum に値を足さない。unattended の事実は
  `limitations[].code`（自由文字列。`$defs/entry` は `code` / `detail` の 2 key）で運ぶ。
  **`stop_reason` の enum に値を足さない**——第6節が示したとおり、unattended 固有の停止理由は
  1 つも無いからである。
- **Skill の `version`**: 契約文書（[dispatch-contract.md](./dispatch-contract.md) と
  [SKILL.md](../SKILL.md)）が変わるので **minor bump 以上**（#95 要件3）。schema が据え置きでも、
  入力フラグの追加は挙動の変更である。

既存 fixture の期待値を1つも緩めないこと。**緩めなければならないなら、それは実装が後方互換を
壊した合図である**（#93 第8節と同じ規律）。

---

## 12. 実装フェーズの段取り

この ADR が承認されてから、次の順で実装する。**段 1〜6 が段階 A（本 Issue の実装範囲）である。**

| # | 内容 | 出荷単位 |
|---|---|---|
| 0 | 本 ADR のレビューと承認 | （この PR） |
| 1 | [dispatch-contract.md](./dispatch-contract.md) の改版 — 第1節に `--unattended`、第3.0節に pre-flight の scope 検査、第5節の対処に unattended 行、第2.7節に「unattended は `require` を含意する」 | docs のみ |
| 2 | [SKILL.md](../SKILL.md) 第3節の設計思想節の改版 — 承認つき運転が既定であること、unattended が**緩めない**こと、driver は CI の job であること、第3.2節の flag 表と monitor 境界（`--no-auto-approve` の要件化） | docs のみ |
| 3 | dispatch: `--unattended` の受理、緩和フラグとの併用拒否（`invalid_input`）、`--contract-mode require` の含意 | minor bump |
| 4 | dispatch: pre-flight の scope 検査（all-or-nothing・`--out` 未消費）、`unattended_mode` / `unattended_baseline` の記録 | 3 と同一リリース |
| 5 | fixtures（第12.1節） | 3〜4 と同一リリース |
| 6 | `status.mjs` の hint map に unattended の停止を追加 | 同上（追随できなければ「detail を読む」に落ちる。#93 と同じ扱い） |
| 7 | **段階 B（別 Issue）**: `merge.mjs --create-prs --unattended`、`change_evidence_unavailable` の昇格 | 別リリース |
| 8 | **段階 C（別 Issue）**: `merge.mjs --merge-prs` と `uat.mjs --create-uat-fix-worktrees`。**#100 段階1 の実装後**（第9節の 3 条件） | 別リリース |

### 12.1 fixture に要求すること

#95 の受入条件（完走系と停止系の両方）を、次の形で満たす。

1. **非回帰（最重要）** — `--unattended` を渡さない既存 fixture の期待値を **1つも変えない**。
2. **完走系** — 全 gate pass の世界で `--unattended` を渡し、**フラグ無しの run と同じ
   `status` / `stop_reason` / `waves[]` になる**こと。差分は `limitations` の
   `unattended_mode` / `unattended_baseline` **だけ**であることを assert する。
   これが「緩めない」の機械的証明であり、self-report の boolean より強い
   （runner が自分で「緩めていない」と主張する check は、緩めた実装でも true を書ける）。
3. **停止系** — 少なくとも次の 4 つ。いずれも `status` が `success` **でない**ことと、
   停止 code が名指しされることを assert する。
   - prompt 検出（exit 10）→ `human_required` / `human_input_required`、`human_required: true`
   - 裁定不能（exit 99）→ `verification_not_judged`、`human_required: true`
   - `open_questions` → 1人も dispatch していないこと
   - verification 不合格（exit 20 が上限まで残る）→ `verification_failed`
4. **unattended 固有の停止** — scope 未宣言の Issue を含む plan で、**`--out` が作られず
   （`out_dir: null`）、1人も dispatch されない**こと。フラグ無しの同じ plan では
   従来どおり他 Issue が dispatch されることを、同じ fixture 対で示す（**二点測定**。
   #100 第4節 (1) と同じ規律）。
5. **併用拒否** — `--unattended --auto-yes` / `--unattended --allow-questions` /
   `--unattended --contract-mode off` が **exit 3** で落ち、**何も mutate しない**こと。
6. **契約経路の必須化** — 契約非対応 CLI の fixture で、`--unattended` が
   `contract_unsupported` の **blocking**（`auto` の limitation ではない）になること。

---

## 13. 未決事項（実装前に実測で確定すること）

推測で実装しない。いずれも fixture か実機で確かめてから進む。

1. **cron の二重起動（再入）。** 前の run がまだ走っているときに次の cron が発火したらどうなるか。
   `--out` の `out_exists` は事実上の mutex になるが、**pre-flight で停止した run は `--out` を
   作らない**（#90）ので、その経路では mutex にならない。同じ worktree に 2 つの supervisor が
   `send` する状態を作れるかを実測し、作れるなら排他の owner（runner か job 定義か）を決める。
   **本 ADR は排他機構を裁定していない。**
2. **wall-clock budget が要るか。** 回数は有界だが時計は有界でない（第5節）。
   `--wait-timeout` × `--max-turns` × wave 数の実測から、無人運転で許容できる最大滞留時間を
   出す。要るなら、打ち切り時の status（`partial` か新値か）と、打ち切り時点の mutation の
   記録方法を先に決めること。**新しい `stop_reason` 値は schema version を上げる**（第11節）。
3. **uat の再merge 先。** `git merge --no-ff` は cwd 指定を持たない（`uat.mjs` 922行）ので、
   **invocation cwd の現在の branch** に merge される。CI が main を checkout した状態で
   段階 C を回すと何が起きるかを実測し、必要なら段階 C の前提として
   「integration branch に居ること」を pre-flight で検査する。
4. **`unattended_baseline` の SHA は取り消しに十分か。** worker が複数 commit を積んだ場合・
   worktree が既に片付いていた場合に `git reset --hard` が意図どおり効くかを実機で確かめる。
   効かない条件があるなら、それを取り消し手順の但し書きとして
   [SKILL.md](../SKILL.md) 第5節に書く。
5. **段階 B / C の PR / merge を無人で回したときの `gh` の対話性。** `gh pr create` /
   `gh pr merge` が TTY 非依存で完結するか（認証切れ・確認プロンプト）を CI 環境で実測する。
   対話に落ちる経路があれば、それは第6.3節に足すべき停止である。
6. **monitor 併用の実測。** `--no-auto-approve` 無しの monitor が unattended dispatch の
   prompt を実際に消費できるか（契約の `autoYes: mode: off` がサーバ側で止めるか）を
   実機で確かめる。止まるなら第4節の「塞げない穴」は穴ではなく、要件ではなく推奨に留められる。
