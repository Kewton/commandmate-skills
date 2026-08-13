# 出力 code の一覧と、停止からの復帰

この文書は [SKILL.md](../SKILL.md) 第4節・第5節から**そのまま移送した**一覧である。
**削っていない。** 移送の理由は [runner-operations.md](./runner-operations.md) の冒頭と同じ
（[#135](https://github.com/Kewton/commandmate-skills/issues/135)）。

SKILL.md 側には「読み方」（status と exit の写像、まず `status.mjs` を読むこと、そして
**止まったら押し通さず読む**という規律）が残っている。ここに在るのは、そこから引く
**全一覧**である —— plan の失敗 code、plan の warning code、limitation code、そして
**停止したときの対処表の正本**と、無人 run の取り消し手順。

`status.mjs --run <run-dir>` は第4節の対処表を機械的に引いて表示する。表がその正本であり、
status runner はそれを引くだけなので、**ここに無い code は status runner も推測しない。**

| SKILL.md での位置 | ここでの節 |
|---|---|
| 第4節 plan の失敗 code と exit | 第1節 |
| 第4節 plan の warning code | 第2節 |
| 第4節 limitation code | 第3節 |
| 第5節 停止したとき、人間が何をするか（対処表） | 第4節 |
| 第5節 無人 run を取り消す | 第5節 |

---


## 1. plan の失敗 code と exit

| 状況 | code | exit |
|---|---|---|
| Issue 番号が無い / 引数不正 / max-parallel 範囲外 | `invalid_input` | 3 |
| mutating phase 指定（実行は dispatch runner の担当） | `not_implemented` | 2 |
| unverified profile（`--allow-unverified` 無し） | `unverified_profile` | 3 |
| Issue / profile / fixture が読めない | `load_error` | 6 |
| 依存 cycle / 不完全 override / 順序違反 | `cycle_detected` / `override_incomplete` / `dependency_order_violation` | 5 |
| run directory が既存 | `run_exists` | 4 |

失敗時も stdout に `status: failure` の result を出す。**plan を推測で埋めない。**


## 2. plan の warning code（1件でも出れば `partial`）

| code | 意味 |
|---|---|
| `profile_repository_mismatch` | 既定 profile の対象リポジトリが cwd の `origin` と一致しない |
| `profile_repository_override` | `--repo` でリポジトリを差し替えたため profile の検証が対象を失った |
| `external_dependency` | この plan に含まれない Issue への依存を宣言している |
| `ambiguous_dependency_direction` | 1行に順方向と逆方向の方向語が同居し、依存の向きを一意に読めない |
| `no_acceptance_criteria` | 受入条件を1件も読み取れない。何をもって完了かが宣言されていない |
| `no_suspected_files` | 対象 file を1件も読み取れない。worker に与える scope が空になる |
| `unrecognized_file_extension` | 既知拡張子外の backtick path が抽出から落ちた |
| `ambiguous_file_candidate` | 同じ file の2つの綴り（一方が他方の path 境界つき suffix）が本文に在り、どちらを意図したか決められない。**どちらも落とさず**両方 scope に入れたうえで訊いている |
| `unconfirmed_lexical_dependency` | 生産者/消費者の推論が**共有 topic token だけ**を根拠にしていたので、依存 edge にしなかった。順序が要るなら人間が述べる |
| `harness_path_in_scope` | agent ハーネスの path（`.claude/skills/` / `.agents/skills/` / `.commandmate/`）を、Issue が**成果物見出しで明示的に宣言した**ので scope に入れた。既定は「入れない」である |
| `open_question_declared` | Issue 本文の ```open-questions ブロックが「これはまだ決めていない」と宣言している。**planner の推論ではなく、著者自身の申告**である。1件につき1件 |
| `open_question_block_invalid` | ```open-questions ブロックが読めない（2個以上・未知 version・未知 key・空・重複・subset 違反）。**「ブロックが無かった」に丸めない** |
| `acceptance_requires_tests_but_scope_has_none` | 受入条件がテストの**作成**を能動的に要求しているのに、対象 file（**段1 の導出結果を含めて**）にテストらしき path が1件も無い |
| `contract_scope_dropped` | 宣言された対象 file の一部が、dispatch の実行契約の `scope.allow` に**入らない**（件数上限 200 超過、または契約が扱えない形の path）。detail に**落ちた件数・落ちた path（先頭3件）・落ちた理由**が入る |

`open_question_declared` / `open_question_block_invalid` /
`no_acceptance_criteria` / `no_suspected_files` / `acceptance_requires_tests_but_scope_has_none` /
`ambiguous_file_candidate` / `unconfirmed_lexical_dependency`
は dispatch の open question ゲートと対になる。**これらを放置したまま `--allow-questions` で
押し通さないこと。** このフラグは plan 全体に効くので、1件を黙らせるつもりで全部を黙らせる。

先頭2つは [#178](https://github.com/Kewton/commandmate-skills/issues/178) で足した。
**この2つだけは planner の推論ではない。** 他はすべて「本文から X を読み取れなかった」という
不在についての報告であり偽陽性がありうるが、`open_question_declared` が運ぶのは
「**X をまだ決めていない**」という、決められる唯一の人間による事実の申告である。
planner が計算しても答えは出ないので、`questions` の**先頭**に立つ。

- `open_question_declared`: Issue 本文に ```open-questions ブロックが在り、その問いを
  そのまま転記している。**その問いを決めて、答えを本文へ畳み込み、ブロックを消して
  re-plan する。** 止めなかった場合の実測（2026-08-10、Kewton/BorderFreeKidsMap#63）は
  「worker が本文の他節から推測するか自分で決め、**どちらに転んだかは diff を読むまで
  分からない**」である。記法は
  [open-questions-notation.md](./open-questions-notation.md)。
- `open_question_block_invalid`: ブロックの構文を直すか、ブロックごと消して re-plan する。
  `acceptance_gate_block_invalid` と同じ fail-closed（同記法 第4節）であり、
  **「ブロックが無かった」に丸めない** —— 丸めると、著者が未決と書いたはずのものが
  黙って消えた run が緑で終わる。

後ろ2つは [#182](https://github.com/Kewton/commandmate-skills/issues/182) で足した。どちらも
**planner が推測をやめて訊く**ようにした結果であり、以前は前者が warning だけ
（`shadowed_file_candidate` —— 本 planner はもう出さない）、後者が黙って作られる
依存 edge だった。どちらの場合も、気づかない人間に対しては**推測がそのまま dispatch されていた**。

- `ambiguous_file_candidate`: 本文に `data/demo/facilities.json` と
  `web/public/dist/data/demo/facilities.json` の両方が在るような状態である。**どちらを対象から
  消すかを決めて本文を直し、re-plan する。** 両方が対象なら `--allow-questions` でよい ——
  両方とも scope に入っている。
- `unconfirmed_lexical_dependency`: 「語彙は共有しているが file は共有していない」2 Issue が
  在るという報告である。**順序が要るなら Issue 本文に `depends on #N` と書くか
  `--depends <consumer>:<producer>` を渡して re-plan する。** 要らない（＝独立である）と
  読んだなら `--allow-questions` で進めてよい。3 Issue が語彙一致だけで3 wave に直列化していた
  のが元の障害なので、**この question の正しい答えは多くの場合「独立である」**である。

`acceptance_requires_tests_but_scope_has_none` は前2つと違って**推論**である
（[adr-scope-derivation.md](./adr-scope-derivation.md) 第7節・第8節、第14節）。判定の元になった
**受入条件が原文で detail に入っている**ので、偽陽性かどうかはその1行を読めば決まる。
「テストは不要」「既存のテストが緑のまま」「手動テストで確認」「テストは変更しない」と
書いた受入条件は**検出から除外される**ので、これらで止まったら実装側の欠陥である。

`contract_scope_dropped` は**推論ではなく予告**である ——「dispatch の実行契約はこの path を
運べない」という、その場で確定している事実を、dispatch より前に言っている。dispatch 側にも
**同名の code** が在り（第3節・第4節）、`--unattended` では blocking reason、人間が居る run では
limitation になる。同じ欠陥に同じ名前を付けてあるので、plan の warning と dispatch の停止は
**同じ1件の findings を2つの時点で読んでいる**と分かる。詳細と規範は
[plan-contract.md](./plan-contract.md) 第5.1節の不変条件4（「引いた分も必ず可視である」）にある。

`harness_path_in_scope` は他の warning と**向きが逆**である。他は「入らなかった」の報告だが、
これは「**入れた**」の報告である —— `.claude/skills/` / `.agents/skills/` / `.commandmate/` は
worker とその審判（verify runner）と「合格の定義」（`.commandmate/verify.yaml`）そのものなので、
planner は**既定でこれらを `scope.allow` に入れない**。受入条件に
`` `bash .claude/skills/cmate-verify/scripts/verify-run.sh --cwd .` が RESULT passed を返す `` と
書くのは受入条件の**普通の書き方**であり、それが審判への書き込み権限になってはならない。
既定で落とした path は捨てずに `reference_files`（「読むが scope.allow には入れない」）に出る
ので、warning は付かない —— **正しい書き方に対して partial を出さない**。この code が出るのは
Issue が `## 対象ファイル`（成果物見出し）に書いた場合だけで、そのときは人間が明示的に宣言して
いるので通す。**通したこと自体を残すのがこの warning である。**詳細と #1756 との整合は
[plan-contract.md](./plan-contract.md) 第5.3節と
[adr-scope-derivation.md](./adr-scope-derivation.md) 第17節にある。


## 3. limitation code（停止はしていないが、後から効いてくる制約）

| code | runner | 意味 |
|---|---|---|
| `contract_unsupported` | dispatch | CLI が実行契約に非対応で、より弱い baseline 裁定に落ちた |
| `contract_disabled` | dispatch | `--contract-mode off` を明示したため probe していない |
| `contract_scope_unknown` | dispatch | 対象 file が空の Issue を dispatch しなかった（その wave は advance しない） |
| `contract_scope_dropped` | dispatch | 宣言された対象 file の一部が実行契約の `scope.allow` に入らないまま dispatch した。**Issue ごとに1件。** worker の権限は Issue の宣言より**狭い**。detail に落ちた件数・落ちた path・落ちた理由が入る。**`--unattended` では limitation ではなく blocking reason になり、`--out` を作る前に停止する** |
| `open_questions_accepted` | dispatch | `--allow-questions` で未回答 question を引き受けた |
| `auto_yes_used` | dispatch | `--auto-yes` で prompt を自動応答した |
| `parallelism_truncated` | dispatch | wave が `max_parallel` より広かったので上限で切った |
| `unsafe_worktree_target` | dispatch | worktree path が path-escape guard に弾かれた |
| `worktree_sync_ran` | dispatch | `ls` で解決できず `commandmate sync` を1度実行して `ls` を読み直した（解決した branch / なお未解決の branch を detail に列挙） |
| `worktree_sync_unavailable` | dispatch | `commandmate sync` が失敗した（0.21.0 未満には subcommand が無い）。**この失敗自体では停止しない**が、server 未登録の worktree は登録し直せていない |
| `worktree_setup_ran` | dispatch | `--prepare-worktrees` で `cmate-worktree-setup` provider を1回呼んだ（対象 Issue・status・phase を detail に記録） |
| `worktree_prepared` | dispatch | provider が worktree を作成/再利用した。**Issue ごとに1件**（branch・base SHA・baseline 合否を detail に記録） |
| `worktree_setup_partial` | dispatch | 要求したうち一部しか作られなかった。作れた分は**消さずに保持**し、未解決 Issue については停止する |
| `worktree_setup_skipped` | dispatch | `--prepare-worktrees` を指定したが、pre-flight が別の drift で先に止まったため provider を呼んでいない |
| `worktree_sync_rescanned` | dispatch | 準備段のため `commandmate sync` を2回実行した（解決時の1回＋作成後の強制1回） |
| `issue_constraints_transcribed` | dispatch | Issue 本文の否定的制約を task text へ**原文転記した**（[#176](https://github.com/Kewton/commandmate-skills/issues/176)、[dispatch-contract.md](./dispatch-contract.md) 第2.4.1節）。**Issue ごとに1件**（転記した節を detail に名指しする）。**転記したことは、守られたことではない** |
| `issue_constraints_untranscribed` | dispatch | 否定的制約を見つけたが、上限（1200 文字 / 8 ブロック）に収まらず**一部を運べなかった**。**Issue ごとに1件。** ブロックを途中で切ることはしないので、落ちたのは節単位である。goal には落とした節の名前と `gh issue view <n>` の1行が入っている |
| `issue_body_unreadable` | dispatch | `gh issue view` が Issue 本文を読めなかった（未 install / 未認証 / 網なし）。**Issue ごとに1件。** 停止はしない（scope と verify は plan 由来なので運べる）が、**否定的制約は1件も運べていない**。goal はその旨と `gh issue view <n>` を名指ししている |
| `worker_method_declared` | dispatch | `--worker-method <id>` 付きの run である。**run 全体で1件。** 停止した run にも残る（何を前提にした run だったかが読めるように） |
| `worker_method_applied` | dispatch | その Issue の worktree に skill が在り、task text に `## Method` 節を書いた。**Issue ごとに1件。** 「適用された」であって「守られた」ではない |
| `unattended_mode` | dispatch / merge / uat | `--unattended` 付きの run である。**run 全体で1件。** 停止した run にも残る。**その runner・その phase が含意した締め付け**を detail に記録する（dispatch: contract require / pre-flight の scope 検査 / wall-clock budget / worktree lock / 裁定根拠の要求。merge `--create-prs`: 変更証拠の要求。merge `--merge-prs`: 受入ゲートブロックと受入条件の要求。uat: 意味ゲートと上限の明示＋再merge 先の pre-flight） |
| `unattended_baseline` | dispatch | その Issue の worktree が dispatch 開始時どこに居たか（**branch 名と短縮 SHA**。絶対 path は書かない）。**Issue ごとに1件。** 取り消しの起点であり、**担保するのは worktree branch の1段だけ**である（本書第5節） |
| `verification_unrecorded` | dispatch | completed した worker に裁定が1つも記録されなかった（runner 側の欠陥。`verification_recorded` completion check も落ちる） |
| `verification_gates_unrecorded` | dispatch | verification は pass だが `GATE` 行を読めず、pass の根拠となった gate を report が名指しできない |
| `drift_<check>` | dispatch | 非 blocking な drift（`integration_clean` / `worktrees_present`）を記録して続行した |
| `issue_autoclose_not_default_branch` | merge | base がデフォルトブランチでないため `Resolves #n` が効かない。**merge 後に手動クローズが要る** |
| `unsafe_branch` | merge | branch 名が safe-ref guard に弾かれた |
| `change_evidence_unavailable` | merge | branch の実変更 file を読めなかった（worktree 不在など）。PR 本文もそう書く。**scope 内に収まっていた証拠ではない** |
| `branch_changed_outside_declared_scope` | merge | 実変更に宣言 scope（`scope.allow`）外の file がある。PR 本文が違反 path を名指しする |
| `integration_verify_not_run` | merge | `--integration-verify` を渡したが、この invocation は1件も merge していない（preview / eligible 無し / 最初の merge の前に停止）ので合流後を測っていない。**「測っていない」であって「green」ではない**（`integration_verify.outcome` は `not_run`） |
| `integration_verify_tree_left` | merge | 統合検証に使った**使い捨ての detached checkout**（`<out>/integration-tree`）を畳めなかった。裁定は baseline の結果のまま。`git worktree remove --force` で消す |
| `acceptance_not_run` | uat | 意味ゲートが verdict を出せず、baseline のみで裁定した |
| `no_eligible_issues` | merge / uat | dispatch report に completed かつ verification pass の Issue が無い |
| `completion_check_failed` | dispatch / merge / uat | completion check のどれかが passed でない |

`conditional_go` の保持（`acceptance_conditional`）と fix 上限到達（`max_attempts_reached`）は
limitation ではなく **stop_reason / blocking reason** である。**停止であって、続行しながらの
注記ではない。**

`issue_constraints_untranscribed` / `issue_body_unreadable` は**止まらないが、放置してよい種類では
ない**。どちらも「否定的制約が worker へ全部届いていない」と言っており、scope ゲートも verification
ゲートも**それを測らない**（[dispatch-contract.md](./dispatch-contract.md) 第2.4.1節）。人間がすること:
`issue_constraints_untranscribed` なら detail と goal が落とした節を名指ししているので、その節を
worker へ渡すべきなら **Issue を分割するか本文の制約節を短くして re-plan する**；
`issue_body_unreadable` なら `gh auth status` を確かめて（未 install / 未認証 / 網なし）から
**同じコマンドで再実行する** —— 本文が読めれば転記が入る。どちらの場合も、その run の pass は
**「本文の禁止事項を守った」ことを意味しない**。なお、この3つの code は現時点で status runner の
hint 表に**入っていない**（`status.mjs` は #176 の宣言 scope の外だった。
`acceptance_requires_tests_but_scope_has_none` と同じ事情で、第4節の注記を見よ）。したがって
`status.mjs` は detail を読ませる既定に落ちる。


## 4. 停止したとき、人間が何をするか（対処表の正本）

**runner が止まったら、それは「押し通す」合図ではなく「読む」合図である。**
`blocking_reasons` の code と `summary_markdown` を読み、次の対応を取る。

`status.mjs --run <run-dir>`（[SKILL.md](../SKILL.md) 第3.6節）は**この表を機械的に引いた結果**を、どの Issue の話かを
添えて出す。JSON を自分で突き合わせる前に、まずこれを読めばよい。表がこの節の正本であり、
status runner はそれを引くだけなので、**ここに無い code は status runner も推測しない**
（「detail と `summary_markdown` を読む」に落ちる）。

> `acceptance_requires_tests_but_scope_has_none` は現時点で status runner の hint 表に
> **入っていない**（`status.mjs` は本表を追加した変更の宣言 scope の外だった）。したがって
> `status.mjs` はこの plan warning について detail を読ませる既定に落ちる。**運転で人間が
> 出会う停止は dispatch 側の `open_questions`** であり、そちらは hint を持っていて
> 質問の本文（＝受入条件の原文）をそのまま出す。

| 止まり方 | 何が起きたか | 人間がすること |
|---|---|---|
| plan `status: partial` + `no_acceptance_criteria` / `no_suspected_files` | Issue に受入条件か対象 file が書かれていない | **Issue 本文に書き足して re-plan する。** run_id は本文を含む hash なので自動的に別 run になる |
| plan `status: partial` + `open_question_declared`（dispatch 側では `open_questions` として止まる） | Issue 本文の ```open-questions ブロックが「これはまだ決めていない」と宣言している。**推測ではなく著者の申告**であり、planner が計算しても答えは出ない。止めなければ worker は本文の他節から推測するか自分で決め、**どちらに転んだかは diff を読むまで分からない**（実測 2026-08-10、Kewton/BorderFreeKidsMap#63） | **その問いを決めて、答えを Issue 本文へ畳み込み、`open-questions` ブロックを消して re-plan する。** ブロックの削除が「決めた」の記録である。question に著者の原文が入っているので、判断は本文を開かずに始められる。**`--allow-questions` は「決めていないことを worker に決めさせる」という判断である** —— そう決めたのなら通してよいが、それが run の command line に残る |
| plan `status: partial` + `open_question_block_invalid`（同上） | ```open-questions ブロックを読めなかった（2個以上・未知 version・未知 key・空・重複・subset 違反）。**「ブロックが無かった」には丸めていない** | **ブロックの構文を直すか、ブロックごと消して re-plan する。** warning detail が壊れ方を名指ししている。記法は [open-questions-notation.md](./open-questions-notation.md)（YAML subset は acceptance-gates 記法 第3節と同じ: 2スペース・tab 禁止・行頭 `#` のみコメント） |
| plan `status: partial` + `acceptance_requires_tests_but_scope_has_none`（dispatch 側では `open_questions` として止まる） | 受入条件はテストの作成を要求しているのに、宣言された file からテスト path が1件も導出できていない。**そのまま dispatch すれば worker は正しくテストを書いて scope ゲートで落ち、契約 scope は send 時 snapshot なので worker 側に回復手段は無い** | **Issue 本文の対象 file にテスト path を書いて re-plan する。** テストが本当に不要なら受入条件にそう書く（否定形は検出から除外される）。判定の元になった受入条件が warning detail と question に原文で入っているので、偽陽性の確認はその1行で済む。**`--allow-questions` で押し通すのは、そのまま worker 1人分の run を捨てることである** |
| plan `status: partial` + `ambiguous_file_candidate`（dispatch 側では `open_questions` として止まる） | 同じ file の2つの綴りが本文に在る（一方が他方の path 境界つき suffix）。**どちらも scope に入れてある** —— 以前は長い方を残して短い方を落としており、実測では「宣言した path が落ちて、触るなと書いたビルド生成物が scope に残る」向きに外れた | **どちらが対象かを決めて、もう片方を本文から消して re-plan する。** 両方とも対象なら `--allow-questions` で進めてよい（両方入っている）。question の本文が2つの path を名指ししているので、判断は本文を開かずに済む |
| plan `status: partial` + `unconfirmed_lexical_dependency`（同上） | 生産者/消費者の推論が当たったが、根拠が**共有 topic token だけ**で共有 file が無かったので edge にしていない。**その2 Issue は同じ wave に入る** | **順序が要るなら述べる**（Issue 本文に `depends on #N`、または `--depends <consumer>:<producer>`）。要らないなら `--allow-questions` で進めてよい。散文の語が一致しただけで3 Issue が3 wave に直列化していたのが元の障害なので、**「独立である」が正しい答えであることが多い**。**edge が欲しいのに `--no-infer` を足さない** —— それは推論を丸ごと切るだけで、この question の答えにはならない |
| plan `status: partial` + `harness_path_in_scope` | Issue が `## 対象ファイル`（成果物見出し）に agent ハーネスの path（`.claude/skills/` / `.agents/skills/` / `.commandmate/`）を書いたので、**worker がそれを書き換えられる状態で dispatch される**。既定では入らない path が、明示宣言によって入っている | **その Issue の成果物が本当にハーネスなのかを読んで決める。** そうなら（このリポジトリ自身の Issue のように）そのまま進めてよい —— warning は宣言の記録であって停止ではない。そうでない（ただ「その runner を実行して通ること」を言いたいだけの）なら、**成果物見出しから path を消して散文か参考見出し（`根拠` / `参考`）へ移し、re-plan する**。移しても worker はその path を読める（`reference_files` に出る）。**審判を書き換えられる worker を「たぶん大丈夫」で送らない** |
| plan `cycle_detected` / `override_incomplete` / `dependency_order_violation` | 依存グラフが実行不能 | `dependency-plan.md` の edge `reason`（どの方向語をどの行から読んだか）を見て、Issue 本文か `--depends` を直す |
| plan `run_exists` | **同じ既定 run_id に hash された run が既にある**（Issue 集合・Issue 内容・**profile 全体**・CLI option がすべて同じ、が典型）。「何も変えていない」とまでは断定できない —— 既定 profile の cwd `origin` 判定は hash の外にある（Issue #157） | エラーが指す既存の `plan.json` と突き合わせて、意図した plan かを確かめる。違うなら Issue 本文か profile を直す（**profile はどの field を編集しても別 run_id になる**）。同じでよいなら `--run-id <new-id>` / `--runs-dir <dir>` を渡す |
| plan `profile_repository_mismatch` | cwd の origin と profile の対象リポジトリが違う | `--profile` / `--profile-json` / `--repo` のどれかを渡して意図を明示する |
| dispatch `open_questions` + `human_required` | 未回答の question を持つ Issue がある | blocking reason に**質問の本文**が出ている。Issue 本文に回答を書いて re-plan する |
| dispatch `drift` | plan 承認後に branch / HEAD / 権限が動いた | drift の内容を確認し、必要なら re-plan する。**drift の上に dispatch しない** |
| dispatch `worktree_unresolved`（`stop_reason: drift`） | 対象 Issue の worktree が `commandmate ls` で解決できない（runner は `commandmate sync` を1度試したうえでの結論。`limitations` の `worktree_sync_ran` / `worktree_sync_unavailable` を見る）。**worker は1人も起動していない**（`task_id: null`・worker ログ無し） | **`cmate-worktree-setup` で worktree を作成し、同じコマンドで再実行する**（最初の Wave 前で止まった場合、`--out` は消費されていない）。plan と同じ profile（同じ `branch_template`）を使う。**Issue の分割や re-plan は不要** |
| dispatch `worktree_setup_unavailable`（`stop_reason: dispatch_error`） | `--prepare-worktrees` を指定したのに `cmate-worktree-setup` を呼べなかった（未 install / `--worktree-setup` 未指定 / launcher が起動不能） | **`cmate-worktree-setup` を install し、`--worktree-setup <launcher>` でその呼び出し口を渡して再実行する。** 準備段を使わないなら `--prepare-worktrees` を外し、従来どおり worktree を用意してから dispatch する |
| dispatch `worktree_setup_failed`（同上） | provider は動いたが result contract を返さなかった、または1件も作らなかった | provider の出力（blocking reason）を読んで原因を直し、同じコマンドで再実行する。**作成済みの worktree は削除していない**ので、再実行の対象は残りの Issue だけになる |
| dispatch `worktree_profile_mismatch`（同上） | provider が作った branch が plan の branch と違う（**profile の不一致**） | plan と `cmate-worktree-setup` に**同じ profile（同じ `branch_template`）**を渡す。既に作られた branch を使いたいなら、その branch を作る profile で plan を作り直す |
| dispatch `worker_method_unavailable`（`stop_reason: dispatch_error`） | `--worker-method <id>` を指定したのに、その Skill が対象 worktree に無い（`.claude/skills/<id>/SKILL.md` と `.agents/skills/<id>/SKILL.md` の**両方**が要る。detail が「無い」のか「片側だけ在る」のかを名指しする）。**worker は1人も起動していない** | **`commandmate skill install <skill-id>` で対象 worktree に入れ、同じコマンドをそのまま再実行する**（最初の Wave 前で止まった場合、`--out` は消費されていない）。方法論なしで走らせてよいと判断したなら `--worker-method` を外す。**Issue の分割や re-plan は不要** |
| dispatch exit 10（prompt 検出） | worker が人間の判断を求めている | `capture` の内容が report に出ている。**自分で判断して答える。** runner は自動応答しない |
| dispatch `verification_not_judged`（exit 99） | run が error / cancelled で**誰も判定していない** | **再 dispatch では解けない。** CommandMate 側のログを見る。判定していないものを worker に直させない |
| dispatch `worker_failed`（`--max-turns` 到達で未 commit） | worker が起動したが commit まで到達しなかった（worktree 未解決はこの code に落ちない。上の行） | prompt / worker ログを読む。指示が過大なら Issue を分割して re-plan する |
| dispatch `scope_unsatisfiable`（`stop_reason` は `verification_failed` か `worker_failed`。`partial`） | scope ゲートの**違反 path が2ターン連続で同一**だった。worker は同じ結論に到達しており、再送しても答えは変わらないので `--max-turns` を待たずに打ち切った（[dispatch-contract.md](./dispatch-contract.md) 第2.3.1節）。契約の `scope.allow` は **send 時 snapshot** なので、**worker 側には回復手段が無い** | **detail に違反 path がそのまま入っている。それを Issue の対象ファイルに足して re-plan する**（owner: human）。repo の規約（テスト配置・生成物・lockfile 等）なら profile 側に宣言する。**違反が 20 行を超えると detail は 20 行で切られ、`(+N more line(s) not listed here …)` が残りの件数を名乗る**（判定はいつでも全行で行っている。#164）—— 全件は `commandmate verify <worktree-id>` で読む。**同じ plan のまま `--resume` しても同じ所で止まる。** 裁定（`verification.outcome`）は fail のままで、これは書き換えていない —— 変わったのは run が先へ進まないことだけである |
| dispatch `verification_failed` / `worker_failed` / `timeout` で **一部の Issue だけ**落ちた | pass 済みの Issue と落ちた Issue が同じ run に混ざっている | 落ちた分を直したうえで **`dispatch.mjs --plan <plan.json> --resume <その run の dispatch ディレクトリ>`**。pass 済みは再 dispatch されず記録だけ引き継がれる（[SKILL.md](../SKILL.md) 第3.2節）。**re-plan は不要** |
| dispatch `resume_plan_mismatch`（`stop_reason: dispatch_error`） | `--resume` 先の report が**別 plan**のものだった（`run_id` / repository / base 不一致） | その plan 自身の dispatch ディレクトリを `--resume` に渡す。新規に走らせるなら `--out` で始める。**何も dispatch していないので、直して同じコマンドを再実行してよい** |
| dispatch `resume_invalid`（同上） | `--resume` 先の report が `dispatch-report.v1` として読めない（schema version 違い / JSON 破損） | detail が「何がどう合わないか」を名指ししている。報告どおりの report を指すか、`--out` で新規 run にする。**壊れた report を半分だけ信じて引き継がない** |
| dispatch `resume_no_work`（`status: success`） | 再実行対象が1件も無い（全 Issue が completed かつ pass） | 停止ではない。その attempt の report をそのまま merge / uat に渡す |
| dispatch `contract_unsupported` + `require` | CLI が実行契約に非対応 | CommandMate を 0.17.0 以上に上げるか、弱い裁定を承知のうえで `auto` に落とす。**`--unattended` の run では `auto` は選べない**（`require` を含意する。落とすなら `--unattended` を外して人間が読む運転に戻す） |
| dispatch `contract_scope_unknown`（`stop_reason: dispatch_error`。**`--unattended` のとき**） | 対象 file を1件も宣言していない Issue が plan に在る。**1人も dispatch していない**（`--out` も未作成） | **Issue 本文に対象ファイルを書いて re-plan する。** フラグ無しの run では同じ Issue が wave の中で1人ずつ拒否される（そのときは他 Issue の worker が既に走っている）。無人ではその始末をする読み手が居ないので、pre-flight で全 Issue を検査している |
| dispatch `contract_scope_dropped`（`stop_reason: dispatch_error`。**`--unattended` のとき**。フラグ無しでは limitation で続行） | 対象 file を**宣言しているのに、その一部が実行契約に入らない** Issue が plan に在る。`contract_scope_unknown`（scope が空）とは別で、**scope は在るが宣言より狭い**。無人では **1人も dispatch していない**（`--out` も未作成） | **detail が落ちた path と理由を名指ししている。理由で直し方が変わる。** `over_bound`（件数上限 200 超過）なら **Issue を分割する** —— 200 は CommandMate 側の契約上限なので runner の flag では上げられない。それ以外（`too_long` / `absolute` / `drive_letter` / `backslash` / `parent_escape` / `nul_byte`）は**その path 1件の形の問題**なので、200 字以内の repository-relative な path に書き直す。どちらも直して re-plan する。フラグ無しの run では Issue は**狭い権限のまま dispatch される**ので、**その run の pass は「宣言どおりの scope で通った」ことを意味しない** |
| dispatch `unattended_locked`（同上） | 同じ worktree を**別の dispatch run が動かしている**（`--out` も未作成・`human_required: false`） | **先行 run の終了を待って、同じコマンドをそのまま再実行する。** lock が残り続けるなら所有 run の pid が生きているかを確認する（`kill -9` された run の lock は次の run が自動で回収する）。lock は `$CMATE_ORCHESTRATE_LOCK_DIR`（既定 `$TMPDIR/cmate-orchestrate-locks/`）に置かれる |
| dispatch `wall_clock_budget_exhausted`（`stop_reason: timeout` / `partial`） | `--wall-clock-budget` に到達して打ち切った。**成功ではない** | 何に時間を使ったかを確認する（**profile baseline と acceptance コマンドは自前の timeout を持たない**ので、まずそこを疑う）。原因を潰すか budget を実測に合わせてから **`--resume` で再開する**。**打ち切りを success に丸めない** |
| merge `ci_failed` / `ci_pending` | CI が green でない | CI を直す。**green 無しに merge しない** |
| merge `pr_missing` / `merge_failed` | PR が無い / conflict | PR の状態を確認し、conflict は手で解消する |
| merge `issue_autoclose_not_default_branch` | base がデフォルトブランチでない | merge 後に **Issue を手動でクローズする** |
| merge `integration_verify_failed`（**`--integration-verify`**。`stop_reason: merge_failed` / `partial`） | **合流後の統合ブランチで profile baseline が赤い。** 各 PR の CI は green だったが、それらは**兄弟 PR が入る前の base** で走ったものである（[#175](https://github.com/Kewton/commandmate-skills/issues/175) の実測）。merge 自体は成功しており、赤いのは**合流の結果**である | **既に merge 済みなので、この phase の再実行では戻らない。** 統合ブランチを green にする（前進修正、または revert）まで **次の wave を dispatch しない**（`integration_verify.outcome` が `fail` の間は barrier が満たされていない）。この code は **file 重なりに出ない意味的衝突**の徴候なので、同じ wave の Issue が**同じデータ・同じ前提を別方向へ動かしていないか**を読む（owner: human）。**「PR 個別の CI は緑だったのだから大丈夫」で押し通さない** |
| merge `integration_verify_unavailable`（同上） | 統合検証を実行できなかった。2通りある: **(a) profile が `baseline` を宣言していない**（`stop_reason: preflight_failed` / `failure`。**1件も merge していない**）／**(b) merge 後の probe が失敗した**（`git fetch` / `rev-parse` / 検証用 checkout。`stop_reason: merge_failed` / `partial`。**merge は済んでいる**） | (a) **profile に `baseline` を書いて同じコマンドを再実行する。** 世界は動いていないので取り消すものは無い（統合検証をしない運転に戻すなら `--integration-verify` を外す）。(b) **merge は済んでいるのに結果を測れていない。** remote 到達性 / base の解決 / worktree 作成の失敗要因を直し、**統合ブランチで profile baseline を手で1回通してから**次の wave へ進む（owner: operator） |
| uat `acceptance_conditional` | 受入判定が `conditional_go` | **条件を読んで人間が判断する。** 自動修正の対象ではない |
| uat `blocked` / `max_attempts_reached` | 上限まで直しても不合格 | `unresolved_issues` と `next_actions` を読む。**success に丸めない** |
| uat `acceptance_not_run` | 意味ゲートを掛けずに baseline だけで裁定した | cmate-acceptance-test を入れて result を用意し、必要なら `--require-acceptance` で必須にする |
| dispatch `verification_gates_unrecorded`（**`--unattended` では blocking**。`stop_reason: dispatch_error` / `partial`） | 契約 pass なのに `GATE <id> PASS\|FAIL` 行を1本も読めず、**pass の根拠を report が名指しできない**。裁定（exit code）は pass のままで、次の wave を dispatch せずに停止した | **まず runner の版を疑う。** `GATE <id> PASS\|FAIL` 行は **stderr に出る**（実測: CommandMate 0.22.2 の verify-runner `reportGates`）のに、0.26.0 までの dispatch は **stdout しか読んでいなかった** —— 契約経路で pass した run の `gates` は常に空になり、**再実行しても必ず同じ所で止まる**（[#160](https://github.com/Kewton/commandmate-skills/issues/160) で両方の stream を読むよう修正）。修正版でも空なら、その run が本当に `GATE` 行を出していないということなので、`commandmate wait <worktree-id> --verify` を手で回して stderr を確かめる。人間が読む運転に戻すなら `--unattended` を外せば従来どおり limitation として続行する。**根拠の無い pass の上に無人 merge を積まない** |
| merge `change_evidence_unavailable`（**`--unattended --create-prs` では blocking**。`stop_reason: pr_create_failed` / `partial`） | branch の実変更を読めず、宣言 scope と対比できない。PR は**開いていない**（本文も書いていない） | 対象 Issue の worktree を復旧して `git diff <base>...<branch>` が答える状態にしてから再実行する。**「読めなかった」を「scope 内だった」と読ませない** |
| merge `acceptance_gates_required` / `no_acceptance_criteria`（**`--unattended --merge-prs`**。`stop_reason: preflight_failed` / `failure`） | 無人 merge の対象 Issue に**受入ゲートブロック（```acceptance-gates）／受入条件が無い**。**1つも merge していない**（条件を満たす Issue も含めて） | **Issue 本文に書いて re-plan する。** 該当 Issue だけを除外して回す道は用意していない（対象集合を黙って縮めないため）。人間が読む運転に戻すなら `--unattended` を外す |
| uat `unattended_cwd_detached` / `unattended_cwd_branch_mismatch`（**`--unattended --create-uat-fix-worktrees`**。`stop_reason: preflight_failed` / `failure`） | 再merge（`git merge --no-ff`）は **invocation cwd の branch** に入るのに、cwd が detached HEAD だった／`--expect-branch` と違う branch だった。**fix worktree を1つも作らず、fix worker を1人も送らず、再merge を1度もしていない** | **invocation cwd を `--expect-branch` の integration branch に checkout してから**再実行する。detached のままだと「merged」と報告されながら成果がどの branch にも残らず、base branch のままだと review を経ずに入る（[#115](https://github.com/Kewton/commandmate-skills/issues/115) の実測） |


## 5. 無人 run を取り消す（`unattended_baseline` の読み方）

`--unattended` の run は、dispatch した worktree ごとに開始時の HEAD を
`limitations` の `unattended_baseline` に **branch 名と短縮 SHA** で残す。取り消しはそれを起点に、
**上流から順に**行う。

1. `git reset --hard <sha>`（worktree が残っている場合）。
2. worktree が既に片付いていれば **`git branch -f <branch> <sha>`**。
   `git reset` は exit 128 で使えない。**baseline を branch 名で書いてあるのはこのためで、
   絶対 path では手が届かない。**

**この起点が担保するのは worktree branch の1段だけである。** 次の4つでは足りない
（[#115](https://github.com/Kewton/commandmate-skills/issues/115) の実測）:

1. **untracked file は `git reset --hard` で戻らない**（`.commandmate/tasks/*.yaml` を含む）。
   完全に戻すには `git clean -fdx` が要るが、それは worker の成果物も消す ——
   **無人で機械にやらせる操作ではない。**
2. **既に merge / push されていたら戻らない。** 下流から先に取り消す（PR を close し、
   remote branch を消し、必要なら revert PR を立てる）。**force push で歴史を消さない。**
3. **worktree が片付いていると `git reset` は使えない**（上の 2）。
4. **branch も消えて `git gc --prune=now` が走ると object ごと消える。** baseline が base branch から
   到達可能なら生き残るので、危ないのは **baseline が base から到達できないとき** ——
   `--prepare-worktrees` が既存 worktree を再利用した場合や、前の run の commit の上に
   baseline が乗っている場合である。

**取り消せるのはリポジトリの状態であって、送られた通知ではない。** push は対象リポジトリの CI を
起動し（実行時間・課金・通知）、PR 作成は reviewer に通知を出す。

`worktree_setup_unavailable` / `worktree_setup_failed` / `worktree_profile_mismatch` と
`resume_attempt` / `resume_no_work` / `resume_invalid` / `resume_plan_mismatch`、
そして `scope_unsatisfiable` / `contract_scope_dropped` / `harness_path_in_scope` /
`ambiguous_file_candidate` / `unconfirmed_lexical_dependency` /
`open_question_declared` / `open_question_block_invalid` /
`integration_verify_failed` / `integration_verify_unavailable` は、
この表には在るが **status runner の hint map にはまだ無い**（`status.mjs` は別 Issue で追随する。
`contract_scope_dropped` については `status.mjs` が #161 / #162 の宣言 scope の外だった。
`harness_path_in_scope` も同じく [#177](https://github.com/Kewton/commandmate-skills/issues/177)
の宣言 scope の外であり、`ambiguous_file_candidate` / `unconfirmed_lexical_dependency` は
[#182](https://github.com/Kewton/commandmate-skills/issues/182) の、`integration_verify_*` は
[#175](https://github.com/Kewton/commandmate-skills/issues/175) の宣言 scope の外である。
`open_question_declared` / `open_question_block_invalid` も同じく
[#178](https://github.com/Kewton/commandmate-skills/issues/178) の宣言 scope
（planner の `orchestrate.mjs` だけ）の外である —— **運転で人間が出会う停止は
dispatch 側の `open_questions`** であり、そちらは hint を持っていて question の本文
（＝著者が書いた問いの原文）をそのまま出すので、実害は status runner の1行だけである。
#182 は `status.mjs` に在る `shadowed_file_candidate` の hint —— 「候補から落ちた」と述べる
1行 —— を**古くしている**: planner はもう落とさないし、その code も出さない。文面としては
「Issue 本文で path を完全形で書き直す」が今も対処として正しいので、実害は
「落ちた」の一語だけである。
なお #175 の停止は `stop_reason` としては既存の `merge_failed` / `preflight_failed` に載るので、
status runner はそちらの hint（conflict の解消 / gh・base の復旧）を引く —— **その1行では
足りない停止**なので、`blocking_reasons` の code と `summary_markdown` の「統合検証」節を読むこと）。
それまで `status.mjs --run` はこれらを「detail と `summary_markdown` を読む」に落として表示する。
**推測で別の対処を出さない**のが status runner の約束なので、これは劣化ではなく既定の振る舞いである。
dispatch report の `summary_markdown` には上表と同じ next action が出ている。
