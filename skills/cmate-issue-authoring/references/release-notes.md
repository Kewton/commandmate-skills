# Release notes

## planner mirror の同期規約

`scripts/validate-plan.mjs` は cmate-orchestrate planner の抽出の**逐語の写し**である。
この関係については、次の 1 文だけを正とする。

> planner mirror は **planner 本体と同じ commit で同時に変更する**。両者の一致は
> リポジトリの conformance テストが保証する。

**参照 planner の version 番号は書かない。** 0.5.0 より前は 3 箇所で別々の番号
（0.7.1 / 0.11.0 / 0.13.0）に割れており、どれも実物と一致していなかった。番号は必ず
腐るので、番号ではなく不変条件を書く。以下の changelog に残る番号は、その version の
package が公開された時点の履歴であって、現在の参照先ではない。

検証は**リポジトリの CI** が行う。install 先の package には conformance テストは
含まれない（`commandmate.skill.yaml` の `files:` に無いものは artifact に入らない）ので、
install 先で走らせるよう案内している箇所は無い。

## Changelog

### 0.9.0 — 対象ファイル節に glob / ディレクトリを書け、閾値は散文でなくゲートで書く（planner Issue #219 / #218）

- **planner の抽出に4つ目の source（`CANDIDATE_PATTERN`）が入ったので、mirror も同時に更新した。**
  冒頭の同期規約どおり、`PATTERN_SEGMENT` / `CANDIDATE_PATTERN` / `SCOPE_PATTERN_RE` の3定数は
  planner 本体と byte 同一であり、`plannerFileCandidates` の分岐も同じである。
- **これが消しに来た事象**: 契約も CommandMate の scope ゲートも CommandMate #1546 以来
  glob 対応済みだったのに、`## 対象ファイル` に glob を書く方法が無かった。文字クラス
  `[A-Za-z0-9_.-]` は `* ? { } ,` を含まないので素書きの `data/geo/landmarks/*.json` は
  黙って落ち、backtick の中だけが `[^`\s]+` を偶然通っていた。実測（Kewton/BorderFreeKidsMap
  #243）では区ごとの生成物 46 file を手で列挙する羽目になっている。
- **成果物見出しの配下でだけ**受け取る。glob は「誰も列挙していない file 集合に対する権限」なので、
  明示の宣言としてしか読まない（planner #177 がハーネスに引いたのと同じ線）。見出しの外に書いた
  pattern は落ち、planner は `scope_pattern_dropped`（notice）でそれを報告する。
- 書き方は [issue-body-contract.md](./issue-body-contract.md) 第 2.3 節に 1 段落で足した
  （`**` は 0 段も跨ぐ・`/` を含まない glob は拾わない・repository 全体を意味する pattern は拒まれる）。
- **この package の rule は1つも変わっていない。** `planner_ready` が見るのは
  「`suspected_files` が空でないか」であり、pattern はその判定に新しい形の答えを増やしただけである。
- **受入条件の閾値を、散文ではなくゲートで書く手引きを足した**（planner Issue #218）。
  `inspect.mjs --evaluate-gates` は宣言済みゲートを base で先行実行して「着手前から通っている」
  条件を名指すが、**見るのはブロックが宣言した gate だけ**である —— 散文に書いた閾値は誰も
  先行評価しない。[acceptance-gates.md](./acceptance-gates.md) 第 8 節（新設）に、
  現在値を測ってから閾値を書くことと、機械に測らせたい閾値は `gates:` に
  `test $(wc -l < path) -le 860` の形で書くことを置いた。第 4 節の
  「`gates:` を出さない」も**理由を書き直した** —— 消費側が未実装だからではなく、
  **この package が renderer で出せない記法を本文に書かない**という起案側の判断である
  （消費側は 0.31.0 / planner Issue #125 以降これを受理する）。
- **mirror の `checkoutGateIds` も planner と同じ file を読み続けている。** planner 側で
  verify.yaml の reader が `dispatch.mjs` から `lib.mjs` へ移った（#218）のに追随し、
  `gates[]`（command と timeoutSec）を読めるようにした。mirror はこの field を一度も
  使わないが、落とすと**両者が同じ file を読んでいることを conformance テストが測れなくなる**。

### 0.8.0 — 未決の問いを起案本文に埋める（Issue #209）

- **`open-questions` ブロックを起案する本文そのものに埋めるようにした。** 記法の正本は
  cmate-orchestrate の `references/open-questions-notation.md` であり、この package は
  ミラーする側である（`acceptance-gates` と同じ関係）。何をブロックにし、どこへ入れ、
  誰が組むかは [open-questions.md](./open-questions.md) が正本。
- **これが消しに来た事象**: 計画は open question を `open_questions[]` に持つのに、起案した
  本文には載らなかった。載らなければ planner は止める理由を1つも持たず、worker は本文の他節から
  推測するか自分で決める —— **未決のまま登録された Issue が dispatch を素通りする**。先に着地した
  cmate-issue-refinement（0.4.0 / Issue #198）の対象は既存 Issue の refinement だけで、
  起案の経路はこの穴が開いたままだった。
- **配列が真であり、ブロックはその射影である。**「本文に写す」step を作らなかったので、
  写し漏れの経路が無い。ブロックは validator に計画から組ませる
  （`--render-open-questions <issue-key>`）。ブロックする question が1件も無い key を渡すと
  **何も出力せず** exit 0 で終わる —— 未決の無い Issue はブロックを持たないのが正しい形である。
- **二重管理にしない。** ブロックへ入るのは `open_questions[].blocks` がその Issue の `key` を
  名指した question だけで、順序は配列のまま、`question` の値は**逐語**で運ぶ（引用符付けも
  escape も再改行もせず、末尾の句点を足しも消しもしない）。`why_blocking` / `options` は
  ブロックに入らない（記法が持つのは自由文の問いだけである）。
- rule を 4 件足した。`open_questions_block_is_derived` は**両方向**に落とす ——
  宣言した問いが本文に無いことも、宣言していない問いが本文に在ることも invalid である。残りは
  `open_questions_block_is_canonical`（renderer の出力と byte 一致するか）/
  `open_questions_block_parses`（planner が読めるか）/ `open_questions_are_representable`
  （重複・予約文字・改行・32 件超）。`--checkout` は要らない —— 突き合わせる相手が対象リポジトリ
  ではなく**計画の中**にあるためである（`acceptance_gates_*` との違いはここだけである）。
- **32 件を超えたら切らない。** 切ったブロックは「この Issue の未決はこれで全部だ」と名乗ることに
  なり、それは本記法が消しに来た silent drop そのものである。超えたのは**ブロックが短すぎるのでは
  なく Issue が大きすぎる**ので、計画を invalid にして Issue を割らせる（renderer も同じ理由で
  exit 2、何も出力しない）。
- **写しとしての欠けを1つ直した。** `checkBodies` は `acceptance-gates` しか剥がしておらず、
  planner は `open-questions` も剥がしてから散文の抽出器を走らせる。剥がさないミラーは
  ブロック内の `  - 問い` を受入条件と読み、**問いの中の backtick path を「書いてよい file」と
  読んでいた**。実測で確かめてある: 剥がしを外すと `planner_ready` / `body_lists_target_files` の
  新 mutant が2件とも exit 0 で通る（＝**実物の planner が止める本文を validator が ready と
  呼ぶ**）。問いの中にしか現れない path が `suspected_files` に入らないことは、実 planner で
  測っている。
- completion check を 9 件から **10 件**にした（10 番目が「ブロックを手で写していない」の自己申告）。
  正本は [plan-contract.md](./plan-contract.md) 第 8 節。**解けたときの手順も述べる** ——
  `open_questions[]` から question を外し、本文のブロックを同じ編集で消す。**ブロックの削除が
  「決めた」の記録である。** 片方だけ直した計画は `open_questions_block_is_derived` が落とす。
- 計画 artifact の schema に変更は無い。`plan_schema_version` は 1 のままである
  （ブロックは `issues[].body` の中身であり、新しい field を作っていない）。既に出力済みの計画は
  引き続き valid である。**ブロックを持たない計画の挙動は従来どおり**である。
- 一致は #198 が置いたリポジトリ層の conformance テスト
  （`tests/fixtures/cmate-issue-authoring/open-questions-conformance.mjs`）が固定する。定数・関数
  本体の byte 一致・corpus・strip 一致に加え、**生成した形のブロックを実物の planner に食わせる**。
  生産側が2つ（refinement / authoring）になっても**形は1つである**ことを、両者が同じ bytes を
  出すことで測っている。mutant は 48 件から **60 件**にした。リポジトリの CI が走らせる
  （install 先には含まれない）。

### 0.7.0 — 受入ゲート記法の生産側（Issue #124）

- **`acceptance-gates` ブロックを起案側が出せるようにした。** 記法の正本は
  cmate-orchestrate の `references/acceptance-gates-notation.md` であり、この package は
  ミラーする側である。何を出し、何を出さないかは
  [acceptance-gates.md](./acceptance-gates.md) が正本。
- **推測で書けない構造にした。** ブロックは手書きではなく renderer が出す
  （`--render-acceptance-gates <id,id> --checkout <path>`）。renderer は `--checkout` を必須にし、
  `<checkout>/.commandmate/verify.yaml` に実在しない id を渡されると **exit 2 で何も出力しない**。
  推測した id は dispatch が `send` 前に `acceptance_gate_id_unknown` で止めるので、
  親切のつもりの id は run の停止になる。**書ける経路を塞ぐのが唯一の確実な防ぎ方である。**
- validator に rule を 5 件足した（`acceptance_gates_block_parses` /
  `acceptance_gates_no_new_commands` / `acceptance_gates_block_is_canonical` /
  `acceptance_gates_verify_yaml_read` / `acceptance_gates_id_exists`）。
  ブロックを持つ Issue がある計画は `--checkout` 無しでは通らない。**「見ていない」を
  「見て問題なかった」に化けさせない。** `--checkout` を渡したのに `verify.yaml` が
  読めないときは exit 2 であり、計画が invalid（exit 1）とは区別する。
- **planner が本文からブロックを剥がしてから散文を読む**という順序をミラーに反映した。
  これは整形ではなく正しさの問題である: 剥がさないと、受入条件の見出しの下に置いた
  ブロックの `  - validate` が受入条件の箇条書きに見え、散文の受入条件が 1 件も無い Issue を
  「planner ready」と報告してしまう（実物の planner は blocking question を立てる）。
  fixture がこの 1 点を名指しで測っている。
- `verify.yaml` の読み取りは dispatch の `readWorktreeGateIds` の逐語の写しである。
  組み込み解決可能 id は `work-evidence` / `scope` の 2 つだけで、`env-clean` は
  built-in ゲートだが**この集合に入らない**（`require: [env-clean]` は拒否される）。
- **ブロックを持たない計画の挙動は byte 単位で従来どおり**である。`verify.yaml` は
  ブロックを持つ Issue があるときだけ読まれ、`--checkout` はそれ以外では影響しない。
- completion check を 8 件から **9 件**にした（9 番目が上記の規律の自己申告）。
  正本は [plan-contract.md](./plan-contract.md) 第 8 節。
- 計画 artifact の schema に変更は無い。`plan_schema_version` は 1 のままである
  （ブロックは `issues[].body` の中身であり、新しい field を作っていない）。
  既に出力済みの計画は引き続き valid である。
- 一致は `tests/fixtures/cmate-issue-authoring/acceptance-gates-conformance.mjs` が
  機械で固定する（定数の byte 一致・関数本体の byte 一致・corpus・正本の例との byte 一致）。
  リポジトリの CI が走らせる。install 先には含まれない。

### 0.6.0 — planner mirror の `FILE_EXT` に `jsonc` を同期（Issue #56）

- planner 本体（cmate-orchestrate 0.16.0）が `FILE_EXT` に `jsonc` を足したのに合わせ、
  mirror も**同じ commit で** byte 一致させた。`wrangler.jsonc` / `deno.jsonc` は framework が
  決めたファイル名なので「認識される拡張子に改名する」回避が取れず、`suspected_files` から
  外れると実行契約の `scope.allow` からも外れて、worker が指示どおり編集した瞬間に scope ゲートで
  不合格になっていた。repository 直下のファイルは `unrecognized_file_extension` の警告経路にも
  乗らないため、完全な silent drop だった。
- `json5` / `jsonl` は同期していない（planner が足していない）。`*.json5` / `*.jsonl` という
  名前でなければ動かない広く使われたツールが無く、`suspected_files` は worker の `scope.allow`
  そのものなので、報告されていない需要のために許可を広げないという判断である。
- validator の rule・schema・計画 artifact の互換性に変更は無い。`planner_ready` の判定は、
  これまで silent drop していた `.jsonc` path を持つ Issue で **通るようになる**（緩和方向）。

### 0.5.1 — SKILL.md の規則再掲を references / schema へ一本化する（Issue #68）

- SKILL.md を「いつ使うか / 呼び方・入力 / 出力の読み方 / 停止条件と人間の動き」の 4 つに
  絞り、references・schema・manifest にも書かれていた規則の再掲を外した。**references と
  schema の内容は削っていない。** 規則そのもの、validator の rule、schema、計画 artifact と
  receipt の互換性に変更は無い。
- 外した主なもの: 権限と禁止事項の全文（[safety.md](./safety.md) 第 1 節）、Step 3 の重複
  検査手順（[duplicate-guard.md](./duplicate-guard.md)）、Step 4 の `size` / `parallel_safe`
  と `xl` の説明（[plan-contract.md](./plan-contract.md) 第 3・7 節と schema の
  `description`）、Phase 2 の前提 3 件と登録規則の逐語再掲
  （[register-contract.md](./register-contract.md)）。
- completion check の 8 件は **[plan-contract.md](./plan-contract.md) 第 8 節へ移設**した。
  8 件の文言は SKILL.md にしか無く、どこにも正本が無い記述を消さないため、外す前に正本側へ
  移している。各 check が何を要求しているかの参照先も同節の表に置いた。
- frontmatter の `description` は 175 字で 200 字以内のため未変更。

### 0.5.0 — mirror の同期を機械で保証し、ペアの境界を双方向にする（Issue #62 / #65）

- planner mirror の一致を検証する conformance テストを追加した。定数を byte 単位で
  比較するだけでなく、両者のミラー領域を module として読み込んで corpus を流し、
  抽出結果が全 field 一致することを確かめる（定数が同じままコードだけずれる乖離は
  定数比較では捕まらないため）。比較対象は**ミラー領域だけ**であり、planner file 全体の
  digest は取らない。marker が動いて比較できなくなった場合は exit 2 で止まる。
- 参照 planner version の表記を 3 通りから 1 つの不変条件へ統一した（上記）。
- install 先に存在しない test への案内を 5 箇所から削除し、「リポジトリの CI が
  検証する」に改めた。install 先で確かめられるのは validator の exit code だけである。
- `cmate-issue-refinement` との境界を双方向に明記した。**split の勧告までが
  refinement、登録を伴う分割がこちら**である。境界は「GitHub に Issue を作るか否か」
  1 点で引く。refinement の `decomposition.children` をそのまま Feature 入力として
  受け取る受け渡しも SKILL.md に書いた。
- 語彙の対応表を [`plan-contract.md`](./plan-contract.md) 第 7 節と schema の
  `description` に置いた（`size` の帯・`parallel_safe` の 3 値・重複判定の値域）。
  **値域そのものは片方に寄せていない。** どちらの契約も v1 として公開済みで、
  値域の変更は既に出た artifact を遡って invalid にするからである（第 6 節）。
  この package の field の値域は 1 つも変わっていない。
- 本体 CommandMate の `/issue-create` `/issue-split` との関係を SKILL.md に明記した。
- SKILL.md の description を 200 字以内に縮め、`cmate-issue-refinement` と同じ言語・
  同じ構造（何を・いつ・そうでないときは相方へ）で対称に書き直した。

### 0.4.0 — 引用しかしない path を対象外として扱う（Issue #54）

- planner mirror に `CONTEXT_HEADING_RE` を同期した。「根拠」「出典」「参考」「参照」
  「背景」「関連」「References」「Context」等の見出し配下**にしか現れない** path は
  `suspected_files` に入らない（planner 本体と同時変更で、集合は byte 単位で同一）。
- 判定は出現ごとではなく path 単位である。散文で指示したうえで根拠にも引用した path は
  対象のまま残る（引用は指示を取り消さない）。`## 再現手順` `## 現状` `## 調査` は
  対象外の見出しに含めていない — バグ報告が直すべき file を挙げる場所だからである。
- 対象外の宣言方法を `issue-body-contract.md` の対象ファイル節に追記した。
  file をすべて根拠としてしか書かない Issue は `suspected_files` が空になり、
  planner が「Affected files are unclear」を立てる。

### 0.3.0 — planner mirror の path 抽出を token 先頭に固定（Issue #49）

- planner mirror の抽出 pattern を **token 先頭からしか一致しない**形に変えた。
  `web/src/lib/filter.ts` から `src/lib/filter.ts` を、
  `` `.claude/skills/x/scripts/a.sh` `` から `scripts/a.sh` を切り出していた挙動が
  止まる。抽出結果は `suspected_files` を経て worker の `scope.allow` になるため、
  途中一致は**実在しない path への書き込み権限**を配ることと同義だった。
  planner 本体と同時変更で、pattern は byte 単位で同一。
- 他の候補の path 境界つき suffix になっている候補は捨て、`shadowed_file_candidate`
  として `warnings` に積む（黙って落とさない）。
- 成果物の見出し配下に書かれた path が拡張子を問わず `suspected_files` に入る
  ようになった（Issue #50）。この振り分け規則を
  `issue-body-contract.md` の対象ファイル節に反映した。

### 0.2.0 — planner mirror の拡張子集合を同期（Issue #43 / CommandMate #1678 B-1）

- planner mirror の `FILE_EXT` に `geojson` / `topojson` / `geojsonl` を追加した。
  planner 本体と同時変更で、集合は byte 単位で同一。
- planner が、既知拡張子外の backtick path が抽出されなかった場合に plan の
  `warnings` へ `unrecognized_file_extension` を積むようになった（黙って落とさない）。
  この挙動を `issue-body-contract.md` の対象ファイル節に追記した。
- planner が、対象ファイルに依存 manifest（`package.json` 等）を含む Issue に
  同 directory の lockfile を既定許可として加え `scope_defaults` に明示するように
  なった（Issue #44 / CommandMate #1678 B-2）。lockfile を本文に書き並べる必要が
  無いことを `issue-body-contract.md` に追記した。

### 0.1.0 — initial release

- 公式カタログの Issue 工程の**上流**を埋める最初の package である。既存の
  `cmate-issue-refinement` は「既存 Issue の精錬」であり、SKILL.md に
  "not writing it from nothing" と明記されている。Feature 記述から Issue 群を起案する
  層はどの公式 Skill も持っていなかった。
- 2 phase・plan/approve 型。Phase 1 は read-only で分割計画を出し、Phase 2 は
  `--register` と明示承認の下でだけ `gh issue create` を実行する。
- 計画 artifact を versioned schema（`issue-split-plan.v1.json`）で定義し、Node 標準
  ライブラリのみの validator（`scripts/validate-plan.mjs`）を同梱した。schema file を
  読んで解釈するので、schema を直せば検証も変わる。
- 目標関数を「起案した Issue が cmate-orchestrate の planner に blocking question を
  立てられない品質であること」と定義し、**その条件を planner の実測から導いて**
  本文の契約（`issue-body-contract.md`）と validator の `planner_ready` rule に落とした。
- 重複ガードを手順に組み込んだ。既存 Issue と着地済み PR の両方を検索し、`duplicate`
  判定は open question で blocking しなければ計画が validator を通らない。
- Phase 2 は依存順に登録し、`{{issue:<key>}}` placeholder を `#<番号>` へ置換し、
  途中失敗を `skipped` として報告し、同じ `plan_id` の receipt があれば再登録を拒否する。

このテキストは、Catalog の `changelog` になる annotated tag message の元である。

## 期待する効果

- 「Feature はあるが Issue が無い」状態から、着手できる Issue 群までを 1 手順で渡せる。
- 起案された Issue がそのまま `cmate-orchestrate` の planner に入り、blocking question
  ゼロで Wave plan になる（本文の型がその条件を満たしているため）。
- 事実誤認を含む Issue が量産されない。裏取りできない主張は本文に入らず、open question
  として人間に返る。
- 既存 Issue や着地済み PR と重複した Issue が、作られる前に止まる。
- 承認前に GitHub が変更されない。計画は検証可能な artifact として残り、後から
  「何を根拠にこう割ったか」を辿れる。

## 制約

- **documentation 専用の Issue は、この planner の前では blocking question ゼロに
  できない。** planner は `docs/` 配下と `.md` / `.rst` / `.txt` を reference に分類し、
  suspected file には入れないためである（`issue-body-contract.md` 第 2.3 節）。計画に
  含めるなら `warnings` に `docs_only_issue` を積んで人間に判断を返す。
- `planner_ready` rule は planner の抽出の**写し**である。planner の抽出が変われば、
  この package も同時に変える必要がある（冒頭の同期規約）。写しである以上、
  install 済みの package 単体では正しさを確認できない。確認はリポジトリの CI が行う。
- 実機 dogfood のうち、**GitHub への実登録は未実施**である。計画 → 本文描画 →
  実物の planner まではリポジトリの CI が毎回機械的に検証しているが、
  `gh issue create` を実リポジトリへ流した記録は無い。
- Phase 2 は既存 Issue の本文を編集しない。依存される側への相互リンクは comment 1 件で
  行う。

## 再読込

Claude / Codex とも、更新の反映には**新しい session の開始**が要る。実効 version は
install 済み `commandmate.skill.yaml` の `version` で確認する。
