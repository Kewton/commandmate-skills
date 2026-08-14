# cmate-orchestrate リリースノート（なぜ今の挙動なのか）

この文書は **経緯の記録**である。契約の正本ではない。

- 何をどう呼ぶか → [SKILL.md](../SKILL.md)
- どう振る舞うと約束しているか → `references/*-contract.md`（正本）
- **なぜその約束になったか** → この文書

各項目は「何が起きたか → だからこう変えた」の形で書く。挙動そのものの定義は正本側にあり、
ここには書かない。ある gate や warning を「もう要らないのでは」と考えたときに、それが実障害
由来なのか設計上の好みなのかを 1 分で判別できることが、この文書の唯一の役目である。

Issue 番号は、`#<数字>` がこのリポジトリ（Kewton/commandmate-skills）、
`CommandMate #<数字>` が上流（Kewton/CommandMate）を指す。

---

## planner（`scripts/orchestrate.mjs`）

### #147 — Issue が書き忘れたテストファイルで、正しく実装した worker が落ちていた

同じ形の障害が**3回目**である。#56 は `wrangler.jsonc` が抽出されず、
CommandMate #1678 B-2（#44）は lockfile が `scope.allow` の外にあり、そして本件は
テストファイルが外にあった。いずれも「**worker がやるべきことをやると落ちる**」であり、
契約の scope は send 時 snapshot なので **worker 側からは直せない**。

実測（Kewton/BorderFreeKidsMap #35）では **scope 外は `session.test.ts` の 1 件だけ**で、
worker 1人分の run（dispatch 約25分＋検証1周）を失った。Issue 本文の `## 対象ファイル` に
2行足して re-plan しただけで、**コードには一切触れずに1ターンで pass した**。

→ 宣言されたソースファイルの**慣習的なテスト path を既定許可に入れ**、
`scope_defaults` に明示する。lockfile（#44）とまったく同じ経路・同じ安全弁である。
JS/TS の3形に加え、`FILE_EXT` が受理する Go（`_test.go`）・Python（`test_*.py`）・
Ruby（`_spec.rb`）・JVM（`FooTest` と `src/main/`→`src/test/` ミラー）も出す ——
JS だけの規則は planner の他の部分と非対称になる。

**#50 の穴は開かない。** 導出は必ず宣言済み path の関数であり、単独 glob を足さないので
**宣言が空なら導出も空**である。「使われなかった許可はコストがゼロ、導出しなければ run 1本が失われる」
という非対称が、規約依存の推測を許容できる理由である。

実装で分かったこと: `dispatch.mjs` は `scope.allow` を**ソートしてから `.slice(0, 200)`** する。
導出が多すぎると**アルファベット順で早い派生 path が宣言ファイルを押し出す**——
この機能が消そうとしている失敗そのものなので、ソースファイル境界で導出を打ち切る。
裁定は [adr-scope-derivation.md](./adr-scope-derivation.md)、正本は
[plan-contract.md](./plan-contract.md)。

### #36 — 別リポジトリで profile を指定し忘れると、中身の違う Issue から plan が出た

別リポジトリの worktree 内で `--profile` を渡し忘れると、planner は既定 profile
（`node-commandmate`）の**対象リポジトリから Issue を読む**。番号だけは合っているので、
**一見きれいな plan** が別リポジトリの Issue から生成された。

→ 既定 profile に解決されたときだけ read-only の `git remote get-url origin` と照合し、
不一致なら warning `profile_repository_mismatch` を積んで `partial` にする。照合できない
（git リポジトリでない・origin が無い・正規化できない）ケースは**不明であって不一致ではない**
ので、スキップする。正本: [profile-contract.md](./profile-contract.md) 第5節。

### #43 — 既知拡張子の外にある backtick path が黙って落ちていた

`FILE_EXT` に無い拡張子（発見時は `geojson`）の backtick path は抽出から外れ、
`suspected_files` に載らないまま「対象 file はこれで全部です」という顔をしていた。

→ 落とした候補を warning `unrecognized_file_extension` に積む。**黙って捨てない。**
拡張子集合そのものは cmate-issue-authoring が byte 単位でミラーしており、
`tests/fixtures/cmate-issue-authoring/run_tests.sh` が両者の `FILE_EXT` 宣言を突き合わせる。

### #46 / CommandMate #1678 B-4 — Issue 本文を直して再 plan すると `run_exists` で弾かれた

既定の `run_id` が Issue 番号だけの hash だったため、「本文を直す → 再 plan」という最も普通の
ループが、毎回 run directory 衝突で止まっていた。

→ 既定 `run_id` の入力 hash に Issue の **title / body / labels** を含める。本文を直せば
自動的に別 run になり、本文まで同一の再実行だけが `run_exists` になる。
正本: [plan-contract.md](./plan-contract.md) 第2節。

### #49 — path の途中から一致して、実在しない path への書き込み権限を配っていた

path 候補の抽出起点が `\b` だったため、path の**途中**からも一致した。
`.claude/skills/cmate-verify/scripts/verify-run.sh` から `scripts/verify-run.sh` と
`claude/skills/…` が、`web/src/lib/filter.ts` から `src/lib/filter.ts` が生まれた。
`suspected_files` はそのまま worker の `scope.allow` になるので、これは
**実在しない path への書き込み権限**そのものだった。

→ 候補は必ず **token 先頭**から取る。加えて、他の候補の **path 境界つき suffix** になっている
候補は落とし、落とした分を warning `shadowed_file_candidate` に出す
（`unrecognized_file_extension` と同型で、黙っては捨てない）。

### #50 — 成果物が Markdown の Issue は、scope が空のまま dispatch されていた

`docs/` prefix と `.md` / `.rst` / `.txt` を一律 `reference_files` に落としていたため、
設計文書・ADR・手順書のように**成果物そのものが Markdown** の Issue は `suspected_files` が
必ず空になった。worker は指示どおり md を書き、scope ゲートに落とされた。

→ 「成果物」「対象ファイル」「変更対象」「Deliverables」等の**見出し配下**に書かれた path は
拡張子を問わず `suspected_files` に入れる。見出しの外に書かれた md は従来どおり reference である。

### #51 — 依存の向きを節見出しだけで決めていたので、逆向きに読んでいた

`## 依存` のような節見出しが行の内容を上書きしていたため、その節に書かれた
`blocks`（書いた側が先）を `depends on`（書いた側が後）と同じ向きに読んでいた。

→ **方向は行ごとに**判定する。節見出しは、方向語を持たない行の既定値を与えるだけで、
行の内容を上書きしない。1行に両方向が同居する場合は黙って選ばず
`ambiguous_dependency_direction` を warning に積む。各 edge の `reason` に
**どの方向語をどの行から読んだか**を残すので、`dependency-plan.md` だけで edge を再導出できる。
正本: [plan-contract.md](./plan-contract.md) 第3.0節。

### #52 — 受入条件ゼロの Issue が `success` として dispatch まで素通りしていた

「何をもって完了か」が本文に無い Issue でも、planner は blocking question を立てるだけで
`status` は `success` のままだった。exit code も 0 なので、自動化された経路では素通りした。

→ question は `warnings`（`no_acceptance_criteria` / `no_suspected_files`）にも積み、
warning が1件でもあれば `status` を `partial` にする。dispatch 側の open question ゲート
（下記）と**対で**効く止め具である。

### CommandMate #1678 B-2 — lockfile が scope.allow の外だと、worker は構造的に不合格だった

対象 file に依存 manifest（`package.json` 等）が含まれる Issue で lockfile が `scope.allow` の
外にあると、worker は `npm install` を実行した時点で scope ゲート不合格が確定した。
worker 側にどうしようもない失敗である。

→ 同 directory の lockfile を**既定許可**として `suspected_files` に加え、planner が加えた分を
issue の `scope_defaults` に明示する（黙って足さない）。

### #56 — `wrangler.jsonc` が抽出されず、worker は指示どおり編集した瞬間に不合格になった

`FILE_EXT` に `jsonc` が無いので `wrangler.jsonc` は `suspected_files` に入らず、
そのまま実行契約の `scope.allow` から外れる。`requireScopeClean: true` が掛かるため、
**worker が Issue に書いてあるとおり編集した瞬間に scope ゲートで不合格**になり、
worker 側では解決できない。#43（geojson）と同型だが逃げ道が2つ少ない:
(a) `wrangler.jsonc` / `deno.jsonc` は framework が決めたファイル名なので改名で回避できない、
(b) repository 直下なのでスラッシュを含まず、`extractUnrecognizedPaths` にも掛からないため
`unrecognized_file_extension` の警告すら出ない**完全な silent drop** だった。

→ `FILE_EXT` に `jsonc` を追加し、cmate-issue-authoring 側のミラーも同 commit で byte 一致させた。
`json5` / `jsonl` は**足していない**: `*.json5` や `*.jsonl` という**名前でなければ動かない**
広く使われたツールが無く、`suspected_files` は worker の `scope.allow` そのものなので、
報告されていない需要のために全 worker の書き込み許可を広げることになるからである。
固定ファイル名を示す Issue が出たときに足す。

### CommandMate #1678 B-3 — コメントに書いた決定が plan に載らなかった

契約の入力は Issue の number / title / body / labels だけで、**コメントは読まれない**
（`gh issue view --json number,title,body,labels`）。「本文は変えず、決定はコメントで追記する」
運用をしていると、コメントに記録した設計判断は plan にも実行契約の `goal` にも載らず、
worker は本文に残る古い方針を実装した。

→ 挙動は変えず（コメントは読まない）、この入力範囲を plan の `notes` に**毎回明記**する。
コメントで決めた内容は dispatch 前に本文へ畳み込む運用にする（cmate-issue-refinement が使える）。

### #161 / #162 — 宣言した対象ファイルが、契約に入らないまま dispatch が成功していた

`dispatch.mjs` の `contractScopeAllow` は、Issue が `## 対象ファイル` に書いた path を
**2 通りの経路で無言のうちに落として**いた。件数上限 200 の `slice`（宣言が 201 件以上なら
アルファベット順で後ろが消える）と、形チェックの per-item drop（絶対パス・`..`・NUL・200 字超・
ドライブレター・バックスラッシュ）である。どちらも warning も limitation も blocking reason も
残さない。

**#147 が消そうとした障害クラスそのもの**で、トリガが「Issue の書き忘れ」ではなく
「**宣言の件数と書式**」であるだけである。worker は Issue が明記したファイルを編集して scope
ゲートで落ち、契約の `scope.allow` は send 時 snapshot なので worker 側に回復手段が無い。
L4（#148）が発火しても detail は「違反 path を対象ファイルに足して re-plan せよ」と言うが、
**その path は既に書かれている**ため、運用者は指示どおり動いても何も変わらない。

落としていた理由は doc comment に書いてあった —— 「parser が拒否するものは送る前に落とす。
send で拒否される契約は、起きなかった dispatch である」。**不正な形については妥当だが、
件数上限には当てはまらない。** CommandMate の契約 parser は 200 件超過を
`at most 200 entries (got 250)` と**件数を名指しして拒否**し、絶対パスや `..` も
**エントリ番号と理由を名指しして拒否**する。つまり切り詰めなければ **send が大きな声で
拒否する**ところを、切り詰めることで**契約は受理され、権限だけが黙って狭まった状態で
dispatch が成功**していた。大きな声の拒否が、静かな誤った成功に化けていた。

実測で doc comment 自体の誤りも 1 件見つかった。**ドライブレター（`C:`）とバックスラッシュを
parser は拒否しない**（`validateScopePattern` の検査は NUL・先頭 `/`・`..` の 3 つだけ）。
記述を実装に合わせて訂正した。

→ `contractScopeReview` が `{allow, dropped}` を返し、`dropped` は理由つき
（`absolute` / `escaping` / `too_long` / `over_bound` 等）で持つ。**理由は装飾ではない** ——
shape 系は path の書き直しで直り、`over_bound` は Issue の分割が要る。直し方が逆になる。
pre-flight で `contract_scope_dropped` を blocking にし、`--out` を作る前に止める。
planner 側でも `plan.warnings` に出すので、dispatch より前、plan のレビュー時点で気づける。

**上限値そのものは変えていない**（CommandMate 側の hard limit である）。変えたのは、
引かれた事実が残るかどうかだけである。

この非対称は [plan-contract.md](./plan-contract.md) 第5.1節にも現れていた。導出側には
「**足した分は必ず可視である**」があるのに、引いた分に同じ規範が無かった。足した 1 件は必ず
名指しされるのに、消えた 50 件は 1 バイトも残らない。対の規範として明文化した。

### #177 — worker が、自分を裁く検証ランナーを書き換えられた

受入条件に

    `bash .claude/skills/cmate-verify/scripts/verify-run.sh --cwd .` が RESULT passed を返す

と書くと、この `.sh` が `suspected_files` に入り、そのまま実行契約の `scope.allow` になっていた。
**worker が自分を裁く検証ランナーを変更できる**状態で、ゲートが 1 つ機能していないのと同じである。

候補抽出に落ち度は無い —— 受入条件の中の path は「成果物」であるのと同じくらい「実行するコマンド」
であり、**形では区別できない**。区別できないなら既定をどちらへ倒すかの裁定になる。これまで倒れて
いたのは「受入条件に path を書かない」という、**著者の注意力に依存する運用ルール**の側だった。

→ `.claude/skills/**` / `.agents/skills/**` / `.commandmate/**` を導出から**既定で除外**する
（deny-by-default）。落とした path は捨てず `reference_files`（読むが `scope.allow` には入れない）へ
出す —— worker は満たすべき runner を**読めるが、書けない**。Issue が `## 対象ファイル` に
**明示宣言**した場合だけ scope に入れ、`harness_path_in_scope` を付けて run を `partial` に落とす。
#50 が消した障害（言われたとおりに書いて scope ゲートで落ちる）を再発させないための唯一の出口で、
通したこと自体を必ず名乗らせる。**除外そのものには warning を付けない** —— 受入条件に verify runner を
書くのは正しい書き方であり、そこに warning を出すとほぼ全ての実 run が `partial` になって、読み手に
**読み飛ばし方を教える**。可視性は構造化された `reference_files` で担保する。

**deny-list は hardcode であって profile 宣言ではない。** 理由を重い順に:

1. profile は**対象リポジトリが供給するデータ**であり、この deny-list は「審判を、裁かれる側から
   守る境界」である。`scope_companions` 型の key で緩められる境界には**静かな二つ目の扉**が在ることに
   なり、穴が Issue 本文から profile へ**移動するだけ**になる。しかも profile 側の扉には warning が
   付かない。
2. この 3 つの root は**ハーネスが決めており、リポジトリが決めていない**。改名できるものではないので
   per-repository に宣言すべき中身が無い。ADR 第5節の「却下: profile 必須にする」は逆向きの結論だが
   理由は同じ形で、あちらの主題（テスト配置）は**リポジトリしか知らない規約**である。
   **知っているのがハーネス側なら hardcode、リポジトリ側なら profile。**
3. 出口は既に在り、**使う場所で監査できる**（成果物見出し＋warning）。

したがって除外集合を広げるのは fixture つきの code 変更になる。**認可境界に対しては、それが適切な
摩擦の量である。** 結果、ハーネス path が scope に入る道は明示宣言 2 つだけ（Issue の成果物見出し／
profile の companion 規則）で、**散文からは入らない**。

CommandMate #1756（core の scope ゲート）とは矛盾しない。あちらは変更を検出して裁く側、本件は
`allow` の導出で、向きは「`allow` に入れない」。**tamper 検出は弱まらず、強くなる** —— これまで
許可されていた編集が、これからは許可されていない編集として現れる。

### #178 — 「まだ決めていない」と本文に書いてあっても、dispatch は止まらなかった

dispatch の open question ゲートが発火するのは planner 自身が立てた question
（`no_acceptance_criteria` / `no_suspected_files` 起点）だけで、Issue 著者が本文に書いた
「まだ決めていない」は `questions: []` のまま dispatch を通過していた。止まらないまま dispatch すると
worker は本文の他節から推測するか自分で決め、どちらに転んだかは diff を読むまで分からない。
**最も強い停止理由が、機械に読まれていなかった。**

実測（2026-08-10、Kewton/BorderFreeKidsMap#63）: 「## 未決の問い」3 件を残したまま plan →
`questions: []` で dispatch は止まらない。3 件を「## 決定事項」へ書き換えて re-plan したら、worker は
コメントに理由まで書いてそのとおり実装した。**本文は最初から答えを持っていなかったのではなく、
答えが無いと書いてあった。**

→ `acceptance-gates` と同型の ```open-questions ブロックを planner が読み、1 件につき 1 件の blocking
question `open_question_declared` を per-issue に立てる。著者の原文を末尾に verbatim で転記する
（dispatch の `excerpt` は末尾を残すので、停止を確かめられる部分が無人 run で落ちない）。
**既存の open question ゲートにそのまま乗る** —— `--allow-questions` 無しには送らず、付ければ通るが
question は plan と report に残る。**新しい停止経路も新しい緩和フラグも足していない**
（`dispatch.mjs` は 1 byte も変えていない）。記法と違反の扱いは
[acceptance-gates-notation.md](./acceptance-gates-notation.md) 第3節・第7節をそのまま継承し、
**「ブロックが無い」と「ブロックが壊れている」は混ぜない**。

question の順序は先頭に置いた。他の question はすべて「本文から X を読み取れなかった」という**不在に
ついての報告**（偽陽性がありうる推論）だが、これは「X をまだ決めていない」という、**決められる唯一の
人間による事実の申告**であり、planner が計算しても答えは出ない。

**見出し検出（`## 未決の問い` / `Open questions`）は併設していない。** 同じ形は拾えるが、採らなかった:

1. **誤検出が無いとは言えない。**「以前は未決だったが決めた」「`## Open questions（すべて解消済み）`」を
   見出し語では区別できない。偽の停止は `--allow-questions` を習慣にさせるが、**このフラグは plan 全体に
   効く**ので、1 件を黙らせるつもりで全部を黙らせることになる。
2. **散文から停止を作らない。** 受入ゲートについて第5節が引いている境界（明示マークされたブロック
   だけを運ぶ）と同じ向きである。
3. **生成と解消が機械化できる。** 見出しには「書く対象」も「消す対象」も無いが、ブロックにはある ——
   refinement が問いを出す → 著者が本文へブロックとして残す → 決めたらブロックを消して re-plan、が
   一本の線になる。**削除が「決めた」の記録**になる。

### #181 — 規則からは決して出てこない集約テストが、毎回手書きだった

L1（隣接テスト導出）も L2 の `derive` も出せない伴走が 1 つ残っていた: 複数モジュールをまとめて検証する
**集約テスト**である。`scripts/tests/shared-contract.test.mjs` は**どのソース名とも対応しないことが
定義**なので、規則からは決して出てこない。残った経路は Issue 本文への手書きだけで、書き忘れれば
worker はテストを更新できないまま scope ゲートに当たる（実測: `scripts/**` / `web/src/shared/*.mjs` を
触る Issue は毎回手書き。0.26.0 では L1 が 5 宣言から 18 path を出したが、集約テストは出ない）。

→ **`derive` を緩めず、兄弟 key `scope_companions.require` を足した。**
[adr-scope-derivation.md](./adr-scope-derivation.md) 第15.2節は「定数の伴走 path」を第1版から外した
うえで、**入れるときの形まで裁定していた** ——「実例が出たら `derive` とは別の key（例: `require`）
として足す。そのとき『宣言と無関係』であることを key の名前が明示する」。本変更はその実例が出たので、
**書いてあったとおりに足しただけ**である。`require[].when` は `derive` と同じ語彙で宣言済み path に
一致し、一致が無ければ 1 件も出ない（「宣言が空なら `scope_defaults` も空」は保たれる）。何件一致しても
literal は 1 回だけ出る。**宣言した key しか正規化されない**ので、`derive` だけの profile の plan は
1 byte も変わらない。

**判別しているのは中身の推測ではなく、著者が書いた key である。** 両 key は互いの形を拒否する ——
`derive[].add` は placeholder 1 つ以上を要求し、`require[].add` は placeholder 0 個を要求する。
括弧が残っている誤記（`{Base}` / `{base`）は**両方の key で**トークン化して拒否されるので literal に
化ける経路がそもそも無く、残る「括弧ごと落とした誤記」は `derive` に書いてある限り拒否され、
合法になるのは著者が key を移して**「この path は固定である」と宣言したとき**だけである。
`derive` を緩めていないことは**既存 case 47 が今も緑である**ことで測られている。

literal は宣言済み path から作られない唯一の伴走なので、通さなければ **profile 経由の path traversal**
になる。`require[].add` は load 時に `isSafeRepoPath` を通し、**#177 のハーネス除外は profile 側にも
引いた** —— #177 自身が hardcode の理由として「`scope_companions` 的な key で緩められる境界は、静かな
2 つ目の扉を持つ境界である」と書いており、literal 伴走はまさにその key だからである。判定できる所で
落とし、できない所は出口で落とす: literal は load 時に `load_error`（静的に判定でき、profile は人が
レビューする成果物なのでその場で落とすほうが直せる）、template がハーネスへ展開されたときは導出時に
drop。ただし**宣言済み path 自身がハーネスの中にあるとき**は落とさない —— それは #177 が認めている
唯一の許可であり、L1 も同じ宣言から導出しているので、**L2 だけ落とせば「どの層が出したか」で境界が
変わる**ことになる。

profile-init は `require` を**起案しない**。literal 伴走とソースの関係は**意味の関係**であって配置の
関係ではなく、集約テストには対になる実ファイルが無い。起案すれば規則の両側を発明して `detected` と
名乗ることになり、第15.6節の「対で裏が取れた配置だけを起案する」規律に反する。代わりに TODO
`scope_companions_undetermined` の**文面が `require` を名指しする**ようにした —— それまでの文面は
`derive` では書けない形を勧めており、**助言どおりに書くと `load_error` になる**文面だった。

### #182 — 語彙が似ているだけの Issue が 3 wave に直列化し、宣言した path の方が落ちていた

planner の抽出・推論に、**推測を推測と名乗らずに実行してしまう**箇所が 3 つあった。いずれも
「plan は成立するので、気づかなければそのまま dispatch される」形である。

1. **語彙一致だけの推論 edge が、file 衝突と同格に wave を直列化する。** 実測 2026-08-11
   （Kewton/BorderFreeKidsMap #104/#105/#106）: 相互参照ゼロの 3 Issue が
   `shared: data, page, cmate` の 3 edge で **3 wave に直列化**した。`cmate` は受入条件の散文
   「cmate-verify の全ゲート」から、`data` / `page` は互いの `## 参考` に書いた path 片から来ている。
   実 file 衝突は 1 組だけで、回避策は**推論を丸ごと切る** `--no-infer` しか無かった。
2. **CONTEXT 見出しの except が、issue 番号に効かない。** `## 根拠` は path を引用へ降格させるのに、
   その下の issue 番号は edge になっていた。実測 2026-08-07（#33/#34）: 「旧本文の depends on #31 は
   成立しない」と**否定するために**書いた行が phantom 依存を作る。番号を書き換えれば依存先が追従する
   だけで、消すにはその行ごと ——つまり**「なぜ依存しないのか」の記録ごと**—— 消すしかなかった。
3. **`shadowed_file_candidate` が、短い path（本当に書きたい方）を落とす。** `## 対象ファイル` に
   `data/demo/facilities.json` を挙げ、説明文でビルド生成物
   `web/public/dist/data/demo/facilities.json` に触れたところ、**宣言した方が落ちて、触るなと書いた
   生成物が scope に残った**。しかも warning は停止しないので、そのまま dispatch される。

→ dependency edge に **`basis`**（`declared` / `file_conflict` / `lexical`）を足した。`kind` が
「**誰が言ったか**」なのに対し `basis` は「**何を根拠にその edge が在るか**」で、2 つは別の問いである。

**共有 topic token しか無い組は edge にしない** —— 消費者側 Issue の question
（`unconfirmed_lexical_dependency`）にする。question なので dispatch は `--allow-questions` 無しには
送らず、**承認は run の command line に残る**。**共有 file が在る組は edge のまま**
（`basis: file_conflict`、`reason` に共有 file を明記）。その組はどのみち同一 wave に置けないので、
生産者を先に置く順序付けは待ち時間を増やさない —— **推論が元々やりたかったのはこれである。推論そのものは
消していない。**

(2) には `extractExplicitRefs` に `contextSpans` / `inSpans`（#54 が path に使っているもの**そのもの**）を
適用した。判定は path と同じく出現ごとではなく**番号単位**で、1 度でも CONTEXT の外で述べていれば
edge は残る（**引用は記述を取り消さない**）。

(3) は「長い方が正しい」を捨てた。長さは**どちらが対象かの証拠ではなく、2 つが重なっていることの証拠**
である。どちらも落とさず両方を `suspected_files` に入れ、どちらを意図したかを question
（`ambiguous_file_candidate`）にした。両方残す側に倒すのは **2 つの誤りの安い方**だからである ——
使われない許可は何も起こさないが、足りない許可は worker 1 人分の run を失わせ、契約 scope は send 時
snapshot なので**worker 側からは直せない**。**question は「両方が scope に入った」ときだけ出す**:
長い方が引用・doc path・#177 の deny のいずれかで reference 側へ行くなら著者は既に区別を書いているので
訊かない —— **正しく書いた本文に blocking question を出すのは、`--allow-questions` を習慣にさせる
最短路である。** `shadowed_file_candidate` は廃止した。

`dependencies[].basis` は schema の `required` に**入れていない**。required にすると 0.27.0 以前が書いた
v2 の `plan.json`（`status.mjs` が読む過去 run の artifact）が schema 違反になり、「古い run を
読めなくするのは後退である」という既存の裁定の逆になる。**absent は「区別が存在する前に書かれた」で
あって「根拠が無い」ではない。** 代わりに「planner は必ず出す」「`basis: lexical` の edge は 1 本も
無い」を**全 plan case に対する harness 不変条件**として固定した —— schema が緩い分を test で締める
配置であり、放置ではない。

### #196 — dispatch 側だけが着地した field は、宣言すると plan が通らなかった

#180 で入った `profile.dispatch_defaults` は **dispatch 側だけの着地**だった。planner の
`PROFILE_FIELDS` に無いので、宣言を書いた profile は Issue を読む前に `load_error`（exit 6）で
止まる。この field が runner に届く道は「**手で patch した plan**」しか無く、profile-contract
第10.6節がその状態を自認していた。#180 が消しに来たのは `--auto-yes` / `--wait-timeout` の
付け忘れが「遅い run」ではなく**事故**（phantom edge / 誰も答えない prompt /
`wait_window_exhausted`）になることだが、置き場は人間の記憶と CLAUDE.md のままだった。

→ `PROFILE_FIELDS` に足し、`publicProfile()` で echo する。第10.2節の型規則（未知 key・型違い・
0 以下）は planner 側にも持つが、**code / exit は planner の規約**（`load_error` / exit 6）に揃えた ——
同じ不備が dispatch では「plan ファイルについての事実」（`plan_invalid` / exit 3）、planner では
「profile ファイルについての事実」であり、**主語が違う**。ここだけ exit 3 にすると planner 側の
規約が割れる。検証ロジックは**共有しない** —— dispatch は loader を通っていない手書き plan も
受けるので、自分の検証を planner に降ろせない。

正規化は契約の key 順に組み直す。**profile は field を選ばず丸ごと `run_id` の hash に入る**（#157）
ので、素通しだと profile 内で key を並べ替えただけで `run_id` が割れる。条件付き echo の追加順は
`scope_companions` → `dispatch_defaults` → `integration_baseline`（#195）に固定した ——
**順序が plan のバイト列を決め、全文 golden に効く。**

### #199 — 「明示宣言した」ことの報告で、run 全体が partial に落ちていた

#177 の唯一の出口 —— Issue が `## 対象ファイル` にハーネス path を**明示宣言**する —— を通ると
`harness_path_in_scope` が付き、run 全体が `partial` になっていた。ハーネスを in-repo で保守する
リポジトリでは、検証ゲートを足す・skill 定義を直すのは**例外的な事象ではなく定常作業**である。
実測（2026-08-14、Kewton/BorderFreeKidsMap）では `.commandmate/verify.yaml` /
`.github/workflows/ci.yml` / `scripts/check-verify-parity.mjs` を宣言した Issue が `partial` で
返った。`suspected_files` は正しく、**裁定も正しい**。問題は、この形が毎回 `partial` で返ることが
`partial` の情報量を下げることである —— #177 自身が除外側について同じ力学（「ほぼ全ての実 run が
`partial` になって、読み手に**読み飛ばし方を教える**」）を論拠にしている。

→ 「**名乗る**」と「**`status` を落とす**」を分けた。`plan.warnings[]` に任意 field `severity` を
足し、`status` を落とすのは blocking だけにする（`status` は「blocking な warning が 1 件以上ある
とき `partial`」になった）。誤分類は「静かに `partial` でなくなる」事故を生むので fail-closed に
倒してある: **既定は blocking**（`severity` を持たない entry は従来どおり `partial` にする）、
**notice 集合は `{harness_path_in_scope}` の 1 件だけ**である。他の code を notice へ移すのは
それぞれ独立の判断で、別 Issue になる。**notice が blocking を隠すことはない。**

`severity` は **notice の entry にだけ emit する**。`blocking` を綴らないのは、綴ると notice を
含まないすべての plan のバイト列が動くからで、schema の `required` に入れていないのは
`dependencies[].basis` と同じ理由（過去 run の `plan.json` を schema 違反にしない）である。
**absent は「blocking」であって「未分類」ではない。**

自動化系は壊れない。dispatch を止めるのは `plan.questions` であって `plan.status` ではなく
（`execution-plan.v2` の `questions` の記述が「this array — not plan.status — is what stops a run」と
明言している）、`status` は人間向けの色である。**本件はその色の情報量の話である。**

### #200 — offline fixture の形式を知る唯一の方法が、runner を読むことだった

`--issue-json` は 0.28.0 の package 全体で 3 箇所に名前が出るだけで、**何を書けば読めるのか**は
どこにも無かった。`loadIssuesFromFixture()` を読んで初めて分かる状態で、利用リポジトリでは
実際にそうなった（2026-08-14、Kewton/BorderFreeKidsMap で 0.28.0 の受け取り検証を fixture で
行うために runner のソースを読んでいる）。

これは単なる欠落ではない。0.28.0 は「Issue 本文の書き方が plan を変える」経路を 3 つ増やしており
（#177 の `reference_files` / #178 の ```open-questions / #182 の question 2種）、どれも
**本文を直して re-plan する**のが正しい対処で、`codes-and-recovery.md` の対処表もそう書いている。
offline fixture はそのための最良の道具 —— 実際の Issue を編集せずに本文だけ差し替えて plan を
diff できる —— なので、**推奨している対処法の入り口が塞がっていた。**

→ [plan-contract.md](./plan-contract.md) 第1.1節（`run_id` を述べる第1節の直後）に書いた。
受け付ける 2 形（素の配列 / `{"issues": […]}`）と要素の field、`labels` の 2 形（`gh` の出力を
そのまま貼れるように、`gh` 経路と fixture 経路は同じ正規化を通る）、**`number` を整数として
読めない要素は黙って捨てられる**こと、そして **fixture は plan の入力なので `run_id` に効く**こと
（本文を変えなければ `run_exists` に阻まれる ＝「本当に本文が変わったか」の検査になる）。
正準例は散文ではなく、planner の fixture テストが既に読んでいる実在 fixture を指す ——
**散文の例は形式が変わっても古いまま残るが、テストが読む fixture への参照は腐ると赤くなる。**

**挙動は変えていない。** 非整数 `number` の黙殺は本 package の fail-closed の流儀
（#175 / #177 / #178 が一貫して「読めないものは absent 扱いにしない」側に倒してきた）と緊張が
あるが、**docs に挙動変更を同乗させない**ため、`load_error` へ締めるかどうかは別 Issue である。

---

## dispatch（`scripts/dispatch.mjs`）

### CommandMate #1447 — 公式経路は public `commandmate` である（ADR）

`commandmatedev` は使わない。explicit phase flag 設計（1 invocation で mutating phase を
ちょうど1つ）も同 ADR に由来し、merge / uat runner がこれを踏襲している。

### CommandMate #1468 — `wait` の idle を完了とみなしていた

実 Claude worker は **1メッセージ＝1ターン**で動き、各ターン後に **idle 化**する。
`commandmate wait` の exit 0 は「idle」であって「done」ではない。これを完了と読んでいたため、
1ターンで終わらない作業が「完了」として barrier を通過した。

→ **裁定の ground truth は `wait --verify` の exit code、完了の ground truth は worktree
ブランチの新規 commit** と定め、この2つを別物として扱う。未 commit のまま idle した worker には
継続 nudge を送り、`--max-turns` 到達でなお未 commit なら honest に `failed` とする。
正本: [dispatch-contract.md](./dispatch-contract.md) 第2.2節・第3節。

### CommandMate #1544 / #1545 — 実行契約と契約裁定は CommandMate 0.17.0 で入った

`send --contract` / `wait --verify` / `commandmate verify` はどれも 0.17.0 以降にしかない。
それより古い CLI では契約経路が存在しないため、**同じ `verification.outcome: pass` を、より弱い
判定（profile baseline の再実行）で出す**ことになる。

→ 最初の Wave の前に一度だけ `send --help` / `wait --help` を probe し、どちらの裁定機構で
判定したかを report と summary に**必ず明示する**。`--contract-mode require` は、弱い裁定に
落ちるくらいなら1件も dispatch せず停止する。**黙って劣化しない**ためのバージョンゲートである。
正本: [dispatch-contract.md](./dispatch-contract.md) 第2.7節。

### CommandMate #1620 — pass した task を再検証すると exit 99 になった

`wait --verify` が exit 0 を返した時点で task は `succeeded` に遷移している。そこへ
`commandmate verify` を掛け直すと、再検証は契約に束ならず **exit 99（判定に到達せず）** を返した。
「ゲートは通ったが未 commit」の worker を commit まで駆動する経路が、これで詰まっていた。

→ pass 後は `--verify` を**付けずに** wait する。`verification.gates` は `wait --verify` の
stdout の `GATE <id> PASS|FAIL` 行から転記し、pass 後の `verify` 再実行はしない。
正本: [dispatch-contract.md](./dispatch-contract.md) 第2.5節。

### exit 99 を 20 に畳んでいた（CommandMate 本体の設計に合わせた分離）

exit 20 は「判定して不合格」、exit 99 は「run が error / cancelled で **判定に到達しなかった**」
である。99 を 20 の再指示ループへ流すことは、**誰も判定していないものの修正を worker に求める**
ことに等しい。

→ 99 は verification `not_run`、`verification_not_judged` を blocking に載せて `human_required`
で停止する。`stop_reason` の優先順位で 99 を `worker_failed` / `verification_failed` より**先**に
見るのも同じ理由で、**再 dispatch では解けない**からである。
正本: [dispatch-contract.md](./dispatch-contract.md) 第2.6節・第5節。

### #50（dispatch 側） — 対象 file を誰も名指せなかった Issue が、最も広い権限を得ていた

`requireScopeClean` を `<allow が非空か>` にしていた頃、plan が対象 file を1つも挙げていない
Issue は `allow: []` の契約になり、**そこだけ scope ゲートが無効化されて worker が何でも書けた**。
対象 file を誰も名指せなかった Issue が最も広い権限を得るという反転である。

→ `requireScopeClean` は**常に真**にする（万一 allow が空の契約が作られても、緩む側ではなく
閉じる側に倒れる）。加えて、対象 file が空の Issue はそもそも **dispatch しない**：
`contract_scope_unknown` を limitation に記録し、その wave を advance させない。

### #52（dispatch 側） — open question ゲート

受入条件が読み取れない Issue は「何をもって完了か」が無いまま worker に渡る。

→ Wave に入る前に、plan の Issue が未回答の planner question を持っていないかを見る。1件でも
あれば **1人も dispatch せずに停止する**。これは世界の状態に依存しない判定なので、drift 確認や
契約 probe よりも**先**に行う。blocking reason と summary には code だけでなく **question の
本文**を出す（code だけでは運用者は Issue 本文に何を書けばよいか分からない）。
`--allow-questions` を明示したときだけ続行し、その事実を `open_questions_accepted` として
記録する（黙って引き受けない）。

### #47 / CommandMate #1678 B-5 — report 単体では「何を根拠に pass としたか」が読めなかった

→ `verification.gates`（実行されたゲート id と各 verdict の一覧）を report に加えた。
`dispatch_schema_version` は **1 のまま**である。merge / uat runner は
`worker_state === 'completed'` と `verification.outcome === 'pass'` の2つしか読まず、その enum 値と
意味は変えていないので、**両 runner は無改修で動く**。フォールバック経路（baseline 再実行）は
ゲートを持たないので `[]` とし、実行 command は従来どおり `checks` に載る。

### #83 — note は「verification passed」、構造化 field は `not_run` だった

report が自分と矛盾していた。同じ worker について `note` が
「completed after 1 follow-up message(s); verification passed and a new commit was detected」
と述べる一方で、`verification` は `{ran: false, outcome: 'not_run', gates: [], checks: []}` だった。
当該 worktree で `verify-run.sh` を回すと全ゲート PASS なので、**note の方が正しかった**。
報告者のリポジトリでは #28 / #29 / #49 の3件連続で発生した。

原因は2つで、いずれも Issue 本文の推測（「`wait --verify` の stdout から拾えていない」）とは
別であった。実測は次のとおり:

1. **記録が barrier の内側にあった。** `scripts/dispatch.mjs` の verification 転記ループが
   `if (allCompleted)` に包まれていたので、**wave に1人でも** 失敗・timeout・prompt・未 dispatch の
   worker がいると、**同じ wave の他の worker**（exit 0 で pass し commit も出した worker を含む）が
   worker record の初期値のまま出力された。`gates: []` が常に空だったのも同じ経路である
   （verdict 自体は `contractVerdicts` に入っており、gate 行の parse も正しく動いていた）。
2. **note が verification の第2の主張だった。** 監督ループが「verification passed …」という
   文字列を独立に組み立てていたので、1 と組み合わさって自己矛盾が表に出た。

merge / uat の eligible 判定は `worker_state === 'completed' && verification.outcome === 'pass'` の
2つしか見ないため、**検証に通った成果物が report の書き方だけを理由に納品経路から外れ**
（`no_eligible_issues`）、PR 作成・CI ゲート・guarded merge・UAT の二層裁定がすべて迂回された。
不合格になったのではなく、**判定される前に消えていた**。

→ (a) 裁定に到達した worker には wave の成否と無関係に必ず記録する（barrier は「次 Wave を
dispatch してよいか」だけを決める）。(b) `note` の検証文は記録した `verification` から生成する
1箇所に集約し、矛盾を表現できなくした。(c) `completed` なのに裁定が無い経路が残った場合は
completion check `verification_recorded` の失敗と limitation `verification_unrecorded` として
**黙って通さず報告する**。(d) `outcome: pass` で `gates` が空なら、拾えなかったこと自体を
`verification_gates_unrecorded` に記録する（planner の `unrecognized_file_extension` と同型）。
副次的に、exit 21（work-evidence が判定して不合格）は worker が `failed` でも `fail` として
記録されるようになった — `not_run` は「**何も判定しなかった**」のために取ってある。
`dispatch_schema_version` は **1 のまま**（additive: completion check 1件の追加。正本
[dispatch-contract.md](./dispatch-contract.md) 第7節）。

### #90 — worktree を作り忘れた run が、worker のログを読めと言ってきた

worktree を作らずに dispatch すると、`resolveWorktreeId()` が id を解けず worker は
`failed` になった。ところが `blocking_reasons` に出るのは汎用の `worker_failed` で、
SKILL.md 第5節の対処表はそれを「worker が commit まで到達しなかった」へ誘導する。
**実際には worker は1人も起動しておらず**（`task_id: null`）、読むべき prompt も worker ログも
存在しない。Issue を分割しても直らない。真の原因は `waves[].workers[].note` に埋もれていた。
さらに drift check の `worktrees_present` は正しく NG を出していたのに**非 blocking** だったので
run を消費し、`--out` が作られたせいで **worktree を用意してからの再実行が `out_exists` で弾かれた**。

→ `worktrees_present` を blocking にし、専用 code `worktree_unresolved` を未解決 Issue ごとに
出す。blocking pre-flight を `outDir` の作成より**前**へ動かしたので、停止しても `--out` を
消費せず**同じコマンドで再実行できる**。1人も dispatch しなかった run が
`completion_check.passed: true` を自己申告しないようにした。正本:
[dispatch-contract.md](./dispatch-contract.md)。上流の報告は CommandMate #1741。

### #91 — 「`commandmate sync` は存在しない」というコメントが事実誤認を再生産していた

`commandmate sync` は CommandMate v0.21.0 以降に**実在する**（CommandMate #1680）。
にもかかわらず dispatch / planner のコメントは「無い」前提のままで、CommandMate #1741 の
報告本文はそのコメントを根拠に「sync は存在しない」と誤記した。

sync は worktree を**作らない**（server の再スキャンのみ）ので「未作成」は解決しないが、
「**ディスクに実在するのに server 未登録**」（server 起動後に `git worktree add` した等）は
解決できる。`resolveWorktreeId()` は sync を呼んでいなかったため、この場合も落ちていた。

→ コメントと planner note を事実に合わせ、`ls --json` が解けないときに**一度だけ** sync して
読み直す。sync が失敗（旧 CLI 等）しても run は壊さず、#90 の停止にそのまま落ちる。

### #93 — worktree を作る段だけが手作業で、入口が1つになっていなかった

#90 の fail-fast は正しく止まるが、止まった後に人が別 Skill（`cmate-worktree-setup`）を
手で呼んで戻ってくる必要があった。plan → worktree 準備 → dispatch のうち、
**真ん中だけが自動化の外**にあった。

→ `--prepare-worktrees`（**既定 off**）を足し、pre-flight が `worktree_unresolved` だけを理由に
止まるときに `cmate-worktree-setup` provider を1回呼んでから pre-flight をやり直す。
選択肢は「dispatch 内で `git worktree add` 相当を実装する」と「別 Skill を合成する」だったが、
collision 検査・作成直前の base SHA 再確認・baseline は既に `cmate-worktree-setup` にあり、
**二重実装は片方だけが直る未来を作る**ので合成を採った。dispatch は
(a) 誰について作らせるか、(b) result（`worktree-setup.result.v1`）が plan と整合するか、
(c) registry に載ったか、の3つだけを持つ。uat の意味ゲートと同じ形である。

4つの裁定（正本は [adr-worktree-preparation.md](./adr-worktree-preparation.md)）:

- **部分成功では走らせない。** 1つの wave は「この集合を並列に走らせる」約束なので、集合を黙って
  縮めると barrier の意味が run ごとに変わる。停止は新しい形ではなく #90 のままに落とす。
- **作ってしまった worktree は消さない。** provider 自身が baseline 失敗でも保持する
  （`safety.md` 第5節）ものを呼び出し側が消すのは、呼び出し先の裁定の無効化である。破壊は
  `cmate-worktree-cleanup` の責務で、後始末の owner は human。
- **未導入なら停止する**（`worktree_setup_unavailable`）。`acceptance_not_run` と同じ
  「黙って劣化しない」型だが、結果は逆になる: 意味ゲートは無くても機械ゲートで裁定できるのに対し、
  worktree が無ければ **dispatch する対象が存在しない**ので、続行に意味が無い。
- **profile の同一性は branch で照合する。** `branch_template` の placeholder の綴りは2つの Skill で
  標準化されていないため、文字列比較は同じ branch を作る template を不一致と誤判定する。
  照合すべきは規約ではなく生成物である。

`commandmate sync` はこのとき **run 中に2回**走る（#91 の1回目は worktree が存在する前に走って
いるので、新しい worktree について何も言っていない）。2回目は `worktree_sync_rescanned` に記録する。
`dispatch_schema_version` は **1 のまま**で、証跡は `limitations` と
`<out>/worktree-setup/prepared.json` と summary が運ぶ（field を足さない）。

### #98 — 3件中1件が落ちただけで、通った2件にもう一度 worker を走らせていた

Wave 途中の部分失敗は並列開発の常態なのに、そこから進む手が **re-plan して全部やり直す** しか
なかった。verification gate が pass させた成果物にもう一度 worker を走らせるのは、gate が
何のためにあるかを捨てている。uat には回数上限つき修正ループ（attempt を既存 artifact に append
する形）があるのに、dispatch には対応物が無いという非対称でもあった。

→ `--resume <前回の --out>` を足し、前回 run の**最新 attempt の report** を読んで
「`worker_state: completed` **かつ** `verification.outcome: pass`」の Issue を**再 dispatch せず、
その verification 記録だけを転記**する。引き継ぎ条件がこの 2 field ちょうどなのは、merge と uat が
eligible を決めるときに読むのがその2つだけだからである。これより緩くすると、**merge は届けるのに
dispatch は「まだ終わっていない」と言う**状態が作れてしまう。

裁定:

- **Wave barrier は再生ではなく再計算する。** 引き継ぎ分を「完了かつ pass」として barrier に数える
  ので、全員引き継ぎの Wave は 1件も dispatch せずに advance し、**依存元が pass 済みの Issue は
  待たされない**。一方で Wave の index は plan の index のまま保つ（詰めない）: `drift_checks` の
  `wave_index` と `waves[].index` が同じ番号を指し続けるほうが、番号が 1 から詰まって見えることより
  価値が高い。
- **引き継いだ Issue の worktree は解決を要求しない。** branch が merge 済みで worktree が
  片付いていても正常であり、そこで `worktree_unresolved`（#90）を出すのは「触る予定の無いもの」を
  理由に run を拒否することになる。pre-flight が見るのは「この attempt が実際に dispatch する
  最初の Wave」の、引き継がなかった Issue だけである。
- **緩い run にはしない。** exit 0/7/1、Auto-Yes 既定 off、mutating Wave 前の drift 再確認、
  exit 99 の扱い、`--max-turns` — すべて通常 dispatch と同一である。resume は「小さい Issue 集合に
  対する同じ run」であって、別の裁定規則を持つ run ではない。
- **別 plan / 壊れた report では resume させない。** 引き継ぎは「この Issue はもう完了・検証済みだ」
  という主張の転記なので、`run_id` / repository / base の不一致は `resume_plan_mismatch`、
  `dispatch-report.v1` として読めない report は `resume_invalid` で、**何も dispatch せず何も書かずに**
  拒否する。前回 report は自分の artifact であっても、戻ってくるときは**入力**である。
- **artifact は上書きしない。** attempt 1 は `<out>/dispatch-report.json` のまま、attempt N は
  `<out>/resume-attempt-N/dispatch-report.json` に append し、`<out>/attempt-history.jsonl` に
  1 attempt 1行の台帳を残す。ディレクトリ名を `resume-attempt-` にしたのは飾りではない:
  `status.mjs` の走査は sorted 順で「後に見つかった artifact が勝つ」ので、`dispatch-report.json`
  より後にソートされる名前であることが、status の Issue 行が**最新 attempt**を指す条件である。
  merge / uat には最新 attempt の report を渡す（引き継ぎ分もそこに転記済みなので、1本で足りる）。
- **`dispatch_schema_version` は 1 のまま。** `resumed_from` と attempt 番号は新しい top-level field
  ではなく `limitations`（`resume_attempt`）・worker の `note`・`summary_markdown`・台帳に載せた。
  dispatch report は閉じた schema で、読み手（merge / uat / status）は version で固定されている。
  変わっていない 2 field を読むだけの3 runner を、変えていないのに読めなくするほうが高くつく
  （#1588 と同じ裁定。正本: [dispatch-contract.md](./dispatch-contract.md) 第7・8節）。

再実行対象が1件も無い場合は、CLI を**1回も呼ばずに** exit 0 で終わり `resume_no_work` を出す。
「何もしなかった」と「全部やり切った」は同じ exit code になるので、どちらだったかを report が言う。

### CommandMate #1678 B-2 / #1683 — scope ゲート不合格の再指示に、違反 path が載っていなかった

→ exit 20 で scope ゲートが落ちていたら、その logTail から**違反 path を転記**し、
「許可するには Issue の対象ファイルに追加して plan を作り直す。不可避なら停止して報告」という
ガイダンスを再指示に含める。CLI 表示側の対応は CommandMate #1683。

### CommandMate #1547 — 契約の `autoYes` とこの runner の `--auto-yes` は層が違う

この Skill の既定は **Auto-Yes off**（prompt は自動応答せず human へ提示）であり、契約導入後も
変えていない。関係する機構は3層ある。

| 層 | 誰が動くか | 既定 |
|---|---|---|
| `--auto-yes`（本 runner の flag） | runner 自身が exit 10 のとき `commandmate respond <wt> yes` を送る | **off** |
| 契約の `autoYes.mode` | CommandMate **サーバ側**の Auto-Yes poller が自動応答を**抑止**する（enforcement は #1547 で実装済み。ポリシーは抑止しかせず、答えを増やすことはない） | `"off"` |
| `commandmate send --auto-yes` | 送信時にセッションの Auto-Yes を有効化する | **使わない** |

生成する契約が `mode: "off"` を書くのは、**runner の既定とサーバ側ポリシーを一致させる**ため
である。`autoYes` ブロックを書かない（`mode: null`）は「契約は何も述べていない」であって `off`
とは別であり、その場合サーバ側の従来動作がそのまま残る。ここを黙って `null` にすると
「runner は答えないが、サーバは答えるかもしれない」という状態になる。

---

### #94 — 独自リポジトリで使うには profile を手書きするしかなかった

内蔵 profile（`node-commandmate` / `rust-commandagent`）以外では profile JSON を手で書いて
`--allow-unverified` で回す必要があり、これが「導入済みなら誰でも使える」への最大の初期障壁だった
（CommandMate #1741 の再現環境も手書き profile / `verified: false` だった）。

→ `scripts/profile-init.mjs` を足した。`package.json` / `Cargo.toml` / CI workflow 等を read-only で
読み、profile の **draft** を起案する。`verified` は false 固定、判定材料の無い項目は安全側の
雛形と明示 TODO を出す（黙って埋めない）。推定の根拠を provenance として残す。network も
subprocess も clock も使わないので、同じ tree からは byte 単位で同じ draft が出る。
正本: [profile-contract.md](./profile-contract.md)。

### #99 — run の状態が、JSON を読める人にしか分からなかった

plan / dispatch / merge / uat の artifact は run directory に散らばっており、「この run は今どの
phase で、どの Issue が何待ちか」に答えるには複数の JSON を突き合わせる必要があった。
各 phase の `summary_markdown` は phase 単体の要約で、**run 全体の横断ビューが無かった**。

→ `scripts/status.mjs` を足した。**mutation を一切しない read-only の view** で、network も
`commandmate` / `git` / `gh` 呼び出しも無い。**証跡が証明する範囲だけ**を見せる — artifact が
欠けている phase は「未実行」、壊れた JSON は該当 phase だけ「読取不能」とし、
**証跡に無い状態を推測しない**。`blocking_reasons` を SKILL.md 第5節の対処表の語彙に
マップした次アクションのヒントを出す。

### #100 — Issue の受入条件は契約に載っているが、誰も測っていなかった

契約 yaml が運ぶ検証情報は `verify.gates` だけで、それも operator が `--verify-gates` で
名指しした場合に限られる。**Issue 固有の受入条件は機械ゲートに一切変換されず**、意味的な判定は
UAT の `cmate-acceptance-test`（任意 install）まで、しかも **merge の後**まで持ち越されていた。
「動いた」（repo 共通ゲート緑）と「完成した」（受入条件充足）を分けるのは中核のはずが、
その最初の問いが納品後にしか発されない。

調査で分かったのは、散文からコマンドを推測する経路は `extractTestExpectations()` として
**既に実装済みで、裁定に使わないという判断が既に下されている**ことだった。

→ 実装ではなく [adr-issue-acceptance-gates.md](./adr-issue-acceptance-gates.md) を先に書いた。
記法（`acceptance-gates` fenced block、**散文からの推測生成は禁止**）・実行場所・空振り防止の
検証規約・生産側の範囲を裁定してある。実装は ADR のレビュー後。

### #95 — 無人運転を足すと、契約の根幹に例外ができる

「plan → 人間の承認 → dispatch」「runner は次の phase を勝手に始めない」は設計思想の根幹であり、
CI / cron からの無人運転はそこに例外を作る。フラグ追加で済ませると、止まるべき場面で成功に
丸める余地が生まれる。

→ 実装ではなく [adr-unattended-mode.md](./adr-unattended-mode.md) を先に書いた。中心の裁定は
**「`--unattended` は『この invocation に人間は居ない』という入力の宣言であって、mutation の
権限を与えるフラグではない。含意するのは締め付けだけである」**。緩和フラグとの併用は
`invalid_input` で拒否し、`--approve` を含意しない。無人でも止まる停止理由を
[dispatch-contract.md](./dispatch-contract.md) の語彙で網羅列挙してあり、
**「unattended だけの停止」は1つも足していない**。実装は ADR のレビュー後。

### #114 — 受入条件は契約に載っているのに、誰も測っていなかった

契約が運ぶ検証情報は `verify.gates` だけで、それも operator が `--verify-gates` で名指しした
場合に限られた。**Issue 固有の受入条件は機械ゲートに一切変換されず**、意味的な判定は UAT の
`cmate-acceptance-test`（任意 install）まで、しかも **merge の後**まで遅れていた。
「動いた」（repo 共通ゲート緑）と「完成した」（受入条件充足）を分けるのが中核なのに、
その最初の問いが納品後にしか発されない。

→ [adr-issue-acceptance-gates.md](./adr-issue-acceptance-gates.md) 第9節の段1〜6を実装した。
Issue 本文の `acceptance-gates` ブロックを planner が**構文だけ** parse して
`plan.issues[].acceptance_gates` に載せ、dispatch が worktree の verify.yaml と突き合わせて
`send` 前に解決し、和集合規則で `verify.gates` を書き出す。記法の正本は
[acceptance-gates-notation.md](./acceptance-gates-notation.md)。

**散文からの推測生成はしない。** 明示マークされたブロックだけを運ぶ（fail-closed）。
散文からコマンドを推測する経路（`extractTestExpectations()`）は元から在るが、
**裁定に使わないという判断が既に下されている** — 本実装はそれを覆さない。

実装前に第10節の未決事項4点を CommandMate 0.22.0 で実測し、第11節に記録した
（scope の基準点は merge-base ／ verify.yaml の未 commit 変更は work-evidence に計上される ／
fence 抽出の干渉は**実在した** ／ `GATE` 行に由来は出ない）。ADR から形が変わった点は第12節にある。
とくに `gates:`（新規コマンド）は planner が受理して dispatch が実行しないと
**宣言が黙って消えた緑の run** になるので、無視ではなく停止にした。

### #118 — plan の版を上げないと、古い dispatch が受入ゲートを黙って捨てる

#114 は `plan_schema_version` を 1 のままにした。plan を読む runner が ADR の数えた3つではなく
**4つ**（`status.mjs` は ADR 執筆後の #99 で増えた）で、実行契約が2 runner しか許して
いなかったためである。結果、**受入ゲートを載せた plan を 0.18.0 以前の dispatch が読むと
ゲートは黙って無視される**窓が残った。

→ planner は **2** を出し、consumer（dispatch / merge / uat / status）は **1 と 2 の両方を受理**する。
守りたい向きは「古い runner が新しい plan を拒否する」であって逆ではない。とくに `status.mjs` は
**過去 run の artifact を読む view** であり、0.18.0 で作った run を読めなくなるのは
この runner が存在する理由そのものの後退である。schema は
[../schemas/execution-plan.v2.json](../schemas/execution-plan.v2.json) を新設し v1 は残した。
fixture の検査は **plan が申告した版**の schema で行う。

### #128 — 方法論を渡す口が無く、ワーカーの流儀が run ごとに変わっていた

`buildContractGoal()` がワーカーへ渡すのは WHAT（目的・受入条件・変更してよいファイル）と制約
だけで、**HOW（調査・計画・実装の作法）を渡す経路が無かった**。CommandMate リポジトリ内では
スラッシュコマンドがその穴を埋めていたが、**スラッシュコマンドはリポジトリスコープ**であり、
外部リポジトリのワーカーには届かない（`Unknown command` で無反応になる。`send` は exit 0 を
返し composer も空なので気づけない）。

→ `--worker-method <skill-id>` を足した。pre-flight で install を実測し、`## Method` 節を
**契約 goal と worker prompt の両方**に置く（片方だけだと `--contract-mode auto` の
フォールバックで方法論が黙って消える）。既定は off で、**指定しない run は 1 bit も変わらない**
（`d45-worker-method-absent-non-regression` が golden contract の byte 一致で固定している）。

install の判定は **`.claude/skills/<id>/` と `.agents/skills/<id>/` の両方**を要求する。
理由は臆病さではなく**測定できないこと**である: dispatch は `send --agent` を一度も渡さず、
`ls --json` の row も id / branch / path しか持たないので、**どの Agent がこのタスクを取るかを
知らない**。片側を許すと、Codex が読む root に無い契約に「この worktree の Skill を読め」と
書くことになり、それは dispatch が測れない主張になる。開発機の `cmate-*` install 45 件は
すべて両置きだった（実測）。

**schema は触っていない。** merge / uat は report から `worker_state` と `verification.outcome` の
2 field しか読まないので、方法論の事実はそのどちらでもない。`limitations[].code`
（`worker_method_declared` / `worker_method_applied`）と `blocking_reasons[]`
（`worker_method_unavailable`）で運ぶ。方法論の正本は別 package
`cmate-worker-development` にある。

### #121 — timeout 起点の resume が、コードでしか保証されていなかった

`wait --verify` が timeout すると裁定が report に凍結され、その後 worker が完走して commit しても
report は更新されず、`merge.mjs` の eligible から外れる（#89 の報告）。0.18.0 の `--resume` は
この回復経路を与えている —— `isCarryable()` は `completed` かつ `verification.outcome === 'pass'`
だけを引き継ぐので、`timeout` は再実行対象になる。

**しかしそれはコードを読めば分かるだけで、fixture では固定されていなかった。** 既存の resume
ケースの起点はすべて `verification.outcome: "fail"` であって `worker_state: "timeout"` ではなく、
**`isCarryable` を将来だれかが緩めても suite は赤にならなかった。**

→ `r06-timeout-resumed` を足した。緩める変異（outcome の検査ごと外して timeout を carryable に
する）を当てると、#102 が「引き継ぎ」に化けて再 dispatch されなくなり、r01 と併せて 25 assertion が
赤になる。**#89 の再発形がそのまま出る。**

### #121 の続き — `--reverify` で、送らずに裁定を更新する

`--resume` は回復経路を与えたが**再 dispatch する**。#89 の状況では作業は既に終わって
commit されているので、必要なのは worker をもう一度走らせることではなく、
**その worktree の現在の状態をもう一度ゲートにかけること**である。現状は worker のターンを
1つ消費し、契約を再送するので worker が余計な差分を加える余地も残っていた。

→ `--reverify` を足した。**`send` を1回も呼ばない**（`r07` / `r08` が attempt 2 の
`sent: []` で固定している）。裁定の取得には既存の `commandmate verify <id> --json` を使い、
**新しい CLI 表面を要求していない**。

### #136 — `--auto-yes` を付けても Claude の許可プロンプトで止まっていた

`dispatch.mjs --auto-yes` を指定しても、ワーカーが `Do you want to make this edit to X?` で止まる。
**worktree のトグルを手で on にしても効かない。** 原因は2つあり、**両方直さないと動かなかった**。

**(1) 契約の `mode: safe` は `yes_no` しか許さない。** CommandMate の `auto-yes-resolver` は
`mode: 'safe'` のとき `promptType === 'yes_no'` 以外を `type-not-allowed` で抑止する。
Claude の許可プロンプトは **`multiple_choice`** なので必ず弾かれる。
**判定しているのは契約のポリシーであって worktree のトグルではない。**
しかもこの runner は `off` か `safe` の2択しか書かず、契約 v1 の既定である
`mode: null`（ポリシー制約なし）を選べなかった —— **`safe` はブロックを書かないより厳しい。**

**(2) `send` に `--auto-yes` が渡っていなかった。** サーバーの Auto-Yes poller は worktree の
auto-yes 状態が有効でなければ起動しない（`auto-yes not enabled`）。契約に何を書いても、
poller が回らなければ抑止の記録すら残らない（[#115](https://github.com/Kewton/commandmate-skills/issues/115) の第14.6節と同じ構造）。

→ `--auto-yes` のとき契約は **`mode: allow-listed` ＋ `allowPromptTypes: [yes_no, multiple_choice]`**
を書き、`send` にも `--auto-yes --duration <算出値>` を渡す。duration は
`--wait-timeout × --max-turns × wave 数`から出す（推測しない）。
**autoYes ブロックを書かない案は却下した** —— この runner が `mode: off` を書くのは
「積極的な禁止」と「省略」が別物だからで、**許可についても同じ理屈が当てはまる**。
`denyPatterns` は空のまま（CommandMate #1699 の scrollback 汚染を避ける）。

### #142 — 無人運転の段階 C: 根拠を名指しできない pass の上に無人 merge を積まない

契約経路の `wait --verify` が exit 0 を返したのに `GATE <id> PASS|FAIL` 行を1本も出さない CLI が在る
（#83）。その場合 `gates` は空になり、**pass の根拠を report が名指しできない**。人間が読む運転では
limitation として続行してよい —— 読み手が run を開いて確かめられるからである。**無人運転では、その
名指しできない pass が段階 C の `--merge-prs` が動く唯一の根拠になる。**

→ `--unattended` では `verification_gates_unrecorded` を **blocking** として扱い、**次の wave を
dispatch せずに停止する**（`dispatch_error` / exit 7）。**裁定そのものは書き換えない** ——
exit code の pass はそのまま `verification.outcome: pass` で残り、wave barrier の `advanced` も
true のままである（barrier が測っているのは completion と verification であって、report が何を
示せるかではない）。変わるのは run が先へ進むかだけである。`human_required` は **false**（`GATE` 行を
出す CommandMate で再実行すれば解ける）。フラグ無しでは従来どおり limitation で続行する
（同じ世界を2回 dispatch して突き合わせる fixture で二点測定）。

---

### #145 — 段1 が知らない規約の repo では、まだ run が丸ごと失われていた

#147（段1）が消したのは「**planner が知っている規約の repo**」の分だけである。
L1 が出さない配置（独自の spec ツリー等）の repo では、受入条件が unit test を要求していて
`## 対象ファイル` にテストが無い Issue が、**今も dispatch すれば必ず scope ゲートで落ちる**。
worker は直せず（契約の scope は send 時 snapshot）、planner も直せない（repo を開かない）。

→ planner が **dispatch の前に人間へ返す**: warning 1件 ＋ open question 1件
（`acceptance_requires_tests_but_scope_has_none`）。`plan.status` は誰も読まないが、
**question は dispatch の pre-flight が拒否する** —— しかも `--out` を作る前なので、
**偽陽性のコストは、真陽性が払わせるはずだった re-plan と同じ**である。

**段1 との二重発火は構造で防いでいる。** 検出は `suspected` を **`scopeDefaults` を push した後に**
読むので、L1 が導出でテスト path を足した Issue は自動的に沈黙する。`isTestPath` は L1 と同一の
述語なので、「criterion がテスト path を名指した」と「scope が持っている」が食い違うこともない。

**精度がこの機能の本体である。** 既存の2つの question は `length === 0` の構造的判定で間違えようが
ないが、これは推論であり、しかもそれを通す `--allow-questions` は **plan 全体に効く** ——
1件の偽陽性が運用者にそのフラグを習慣づけ、本物の `no_acceptance_criteria` まで一緒に黙らせる。
走査は `acceptance_criteria` に限定し、「テストの名詞 ＋ 能動的な要求」か「テスト形 path の名指し」
だけを採り、**4つの否定形**（不要 / 既存が緑のまま / 手動 / 変更しない）が criterion 単位で veto する。
除外は**先に評価して勝たせる** ——「上限を追加する、unit test は不要」は名詞と `追加` の両方を持つので、
除外が無ければ必ず誤爆する。**4つは融合した1本の正規表現にせず独立した4文**にしてある。
1つずつ外して赤になることを変異注入で実測できる形にするためである（実測: 4本とも赤）。

裁定 A（[adr-scope-derivation.md](./adr-scope-derivation.md) 第8節）:
**推論は機械を止めてよいが、機械に指示してはならない。** この検出は `acceptance_gates` にも
`scope.allow` にも1バイトも書かない。

### #157 — `run_id` が profile の3 field しか hash せず、中身の違う plan が同じ id を持てた

`run_id` は「plan を決める入力の hash」として文書化されているのに、profile からは
**`base` / `id` / `repository` の3つしか hash していなかった**。plan を決める profile field は
他に5つある —— `baseline`（`verifyBinaries` 経由で `test_expectations`）・`branch_template` /
`worktree_template`（`issues[].branch` / `.worktree`）・`verified`（`unverified_profile` warning と
high severity の risk）・`scope_companions`（`suspected_files` / `scope_defaults`。#149）。
**`baseline` は #149 より前から外にあった**ので、新しい退行ではなく元からの誤りである。

→ **解決後の profile を丸ごと hash に入れる。** 5つを列挙し直す案を採らなかったのは、
**列挙こそが失敗した当のものだから**である —— 列挙は profile に field が増えるたび人間が
見直さねばならず、忘れても誰も検出しない。コストは受容している: profile のどの field を
編集しても新しい既定 id になる。それは安全な方向であり（**共有された古い id のほうが、
違う2つの plan を1つの run に見せかける**）、`--resume` は dispatch ディレクトリを名指すので影響しない。

**`run_exists` のメッセージも直した。** 従来は
`so this means nothing changed since that run` と**断定**していたが、profile を編集しただけの
re-plan ではこれは偽である。しかも **profile 全体を入れてもなお断定はできない** ——
既定 profile の cwd 突合が読む cwd は hash に入っておらず、片方の plan にだけ
`profile_repository_mismatch` を入れうるからである。断定をやめ、
**その directory の `plan.json` を読んで確かめてもらう**形にした。

実装では key 順の正規化パスを**一度書いてから削除**している。`normalizeProfile` が profile を
field ごとに組み立て直すので、**このローダーが受け付けるどの入力でも両版を区別できない** ——
観測できない防御は、この Issue が扱っている「コードを超えた主張」と同じ形をしている。
性質自体は、それを実際に提供している層に対する fixture で固定してある。

### #149 — planner が聞いたことのない規約は、誰にも宣言できなかった

L1（#147）が導出できるのは**慣習的な**テスト path だけである。`spec/` が `app/` を鏡写しにする木、
`.proto` の隣の `*_pb.ts`、ソースから再生成される locale 表 —— **planner が知らない規約**は
導出しようがない。planner は repo を開かず、dispatch も worktree を観測してはならない
（契約の byte-identical 性が壊れる。[adr-scope-derivation.md](./adr-scope-derivation.md) 第3節で却下済み）。
L3（#145）が警告して人間に返すところまでは行くが、**宣言する先が無かった。**

→ **repo 知識が入ってよい唯一の場所は profile であり、profile は plan の一部である。**
`scope_companions.derive[]` に `when` / `add` の path テンプレート対を書けるようにした。

```json
{ "when": "app/{dir}{base}.rb", "add": ["spec/{dir}{base}_spec.rb"] }
```

placeholder は `{dir}`（0個以上の segment・末尾 `/` 込み）と `{base}`（ちょうど1 segment）の2つだけ。
**ミラーが表現できるのは `{dir}` のおかげ**である。

**ADR 第2節の不変条件3件が、後付けの検査ではなく形の構造的性質になっている。**
**glob 構文が存在しない**（`*` `?` `[` は両テンプレートで拒否）ので、唯一のワイルドカードは
placeholder であり、**捕捉されるのは宣言された path の literal な部分文字列**である。
`add` は `when` が束縛した placeholder を最低1つ持たねばならないので、
**宣言に含まれない path を許可する規則は書けない** —— `**/*.test.*` も裸の
`docs/module-reference.md` も load 時に拒否される。profile 経由で #50 の穴が開くことはない。

**実運用の観測がまだ無いので、形は「今の必要」ではなく「後から広げられること」を優先した。**
`{ext}` を入れなかったのもそのためで、後から足しても互換な広がり方になる（ADR 第15.2節）。
未宣言の profile は **段1 までの挙動へ degrade** する —— その後方互換は assert ではなく**実測**で、
`cases/45-scope-companions-absent/expected-plan.json` は**実装コードを1行も書く前に 0.24.0 の
runner で生成**して check-in してある（`44` との差は profile だけ）。

**既知の限界**: `scope_companions` は `run_id` の入力集合に入っていない。宣言を編集して re-plan すると
`run_exists`（exit 4）に当たる。ただしこれは `baseline` / `branch_template` / `worktree_template` /
`verified` も同様で、**profile 全体をまとめて裁定すべき別件**である（ADR 第15.7節に revisit 条件つきで記録）。

### #148 — 直せない scope 違反に、上限まで再指示を送り続けていた

Kewton/BorderFreeKidsMap #35 の note は `supervision exceeded its hard iteration bound` である。
**1回落ちたのではなく turn 上限まで回っていた。** 再指示文そのものは正しく、違反 path を転記して
「worker 側では解決できません — 停止して報告してください」とまで言っている。
**しかし dispatch は turn 数しか見ずに再送し続ける。** worker は
「テストを消す＝受入条件を落とす」というジレンマに置かれ、同じ結論を繰り返す。

→ 「その変更が不可避か」は判定できないが、「**このループが収束しているか**」は判定できる。
違反 path 集合が前ターンと同一なら再送しても結果は変わらないので、そこで停止する。
`blocking_reasons[].code = scope_unsatisfiable` が**違反 path を逐語で**運ぶ ——
それが「次に何を Issue の対象ファイルへ足せばよいか」の唯一の情報源である。

**止めるのは repeat であって retry ではない。** worker が違反を1つでも減らせば従来どおり
再指示が続く。決めていなかった3点はすべて**遮断が狭くなる側**に倒した:
`--max-turns` 到達を先に見る / 比較は連続2ターンに限る / 違反 path を読めなかったターンは
比較しない（「2回とも読めなかった」は「同じ path だ」の証拠ではない）。

`stop_reason` の enum に値は増えず、`verification.outcome` も書き換えない ——
検証は本当に失敗しており、それは CommandMate の exit code である。変わるのは run が先へ進むかだけ。
`summary_markdown` では「worktree を診断して再 dispatch」の行を**併記ではなく置換**する。
ここではその助言が積極的に誤りだからである（同じ plan を再投入すれば同じ所で止まる）。

### #160 / #170 — `GATE` 行は stderr に出ていたのに、runner は stdout しか読んでいなかった

`commandmate wait --verify` は `GATE <id> PASS|FAIL` 行を **stderr** に出す
（stdout は prompt JSON 契約のために予約されている。CommandMate 側の意図的な設計である）。
ところが `runCliAsync` は成功枝で `stderr: ''` を返して捨てており、`gatesFromWaitOutput` は
stdout しか走査していなかった。**契約経路で pass した検証の `verification.gates` は
原理的に常に空**になる。

#47 が入れた「report 単体で pass の根拠が読める」性質は、契約経路の pass では**一度も
成立していなかった**。そして #142 が `verification_gates_unrecorded` を `--unattended` で
blocking に昇格させたため、**無人運転の段階 C は全ゲート pass でも wave 1 の直後に必ず
停止していた。** ADR 第6.5節の意図（根拠を名指しできない pass の上に無人 merge を積まない）は
正しいが、その前提である「GATE 行を読む」経路が機能していなかった。

fail 経路（exit 20 / 21）は catch 枝で stderr を捕捉しており、かつ `describeFailingGates`
（`verify --json` の stdout JSON）という別経路の代替があったため、症状が表面化していなかった。

**なぜテストが捕まえなかったか。** テストダブルが実 CLI と逆の stream を使っていた。
`tests/fixtures/cmate-orchestrate/fake-cli.mjs` は GATE 行を **stdout** に書いており、
コメントは "Like the real CLI (verify-runner's reportGates)" と実機準拠を謳いながら、
**何を印字するかだけを写し、どこへ印字するかを写していなかった**。その結果、
`verification_gates` が埋まることを assert していた既存の緑ケース群は、**実機では成立しない
stdout 経路**を検証していた。fake を stderr に寄せたうえで実装だけを戻すと、新設ケースに加えて
**既存の 5 ケースも `verification.gates []` で落ちる** —— 修正前まで幻の経路に対して緑だった
ことの実測である。

**#83 は原因を取り違えていた。** 当時これは「契約経路の `wait --verify` が exit 0 を返したのに
`GATE` 行を 1 本も出さない CLI が在る」と、**CLI の出力欠落**として記述された。実測では CLI は
出力しており、**読み手が別の stream を見ている**というのが実際の姿だった。誤診は fixture
（`d26` の description）と復旧手順（SKILL.md / codes-and-recovery.md）に焼き込まれ、以後この
症状を観測しても「既知の CLI 差異」に見える自己強化構造になっていた。

→ `runCliAsync` の成功枝で stderr を保持し、`waitStreams()` が両 stream を連結して
`gatesFromWaitOutput` の呼び出し 3 箇所すべてに渡す（`GATE_LINE_RE` は行頭一致なので混在しても
誤検出しない）。fake-cli の GATE 行を `writeGateLine()` で stderr に寄せ、実機と一致させた。
同期版 `runCli` の `stderr: ''` は `execFileSync` の API 上の制約なので**そのまま**である
（そこから GATE 行を読む箇所は無い）。

**#170 はその後始末である。** 復旧手順は SKILL.md と codes-and-recovery.md では訂正されたが、
**運用者が実際に読む唯一の場所** —— dispatch サマリの next 行 —— に旧文言が残っていた。
「`GATE` 行を出す CommandMate で再実行する」は二重に誤っている: CommandMate は元から出力して
おり、直すべきは **runner の版**である。ADR 第17.3節も同じ誤診を**論拠として**使っていた
（`human_required` を false に保つ理由）。結論は維持し、理由を差し替えたうえで
`contract_unsupported` との違いを書き分けた —— あちらは CommandMate を上げれば runner は
そのままで解けるが、こちらは runner 自身の更新が要る。

再発防止として、**実際に描画された next 行**と codes-and-recovery.md / SKILL.md / ADR 第17.3節が
「まず runner の版」「stderr」「#160」で一致し、反証済みの文言が summary に戻らないことを
1 本のテストで固定した。recovery 表と next 行の一般的な対応（表に在る code は next 行にも在る）は
**採らなかった** —— 表の `dispatch` 行 21 本のうち 5 本は reason code ではなく stop_reason か
summary を描画しない経路を指しており、例外表が要る。3 つ目の同期先を作ることになり、
二重管理の治療にならない。

### #164 — 表示の都合が、run を止めるかどうかを決めていた

`scopeViolationLines` は scope ゲートの logTail を先頭 20 行で打ち切っていたが、その打ち切りが
**dedup / sort より前**に掛かっていた。L4 ループ判定（#148）が比べていたのは「違反集合」ではなく
「**logTail 先頭 20 行の集合**」であり、違反が 21 件以上あると**窓の外だけが異なる 2 ターン
（＝ worker は前進している）が「同一の答え」と読まれ、前進中の worker が
`scope_unsatisfiable` で止まる**。逆向きもあり得た —— 窓の中の 1 件を直すと後ろの行が繰り上がり、
停滞している 2 ターンが「異なる」と読まれて turn を浪費する。切ったこと自体はどこにも残らない。

前提は現実的である。CommandMate の logTail は既定 8192 bytes
（`DEFAULT_MAX_LOG_TAIL_BYTES`）なので 21 行以上は普通に載り、違反が数十件になるのは worker が
formatter や `lint --fix` を repo 横断で走らせた事故のとき —— **まさに scope ゲートが捕まえたい
状況**である。

→ **判定と表示を分ける。** `scopeViolationLines` は全行を返し、`MAX_SCOPE_VIOLATION_LINES` は
表示上限として残す。比較は文字列一致なので全行を持つコストはほぼ無い。新設した
`scopeViolationDisplay` が `{shown, dropped, total}` を返し、再指示文と
`blocking_reasons[].detail` の両方がこれを使う。worker record の note には「メッセージが何行中
何行を伝えたか」を残す —— 20 path を並べた report が「違反が 20 件だった run」と読まれないため。

**ガードは弱めていない。** 本当に同じ違反集合を 2 ターン連続で返した worker は従来どおり
打ち切られることを、相方の fixture で二点測定している。

### #165 / #171 — 切り捨てが無言だった箇所と、切り捨ての注記が切り捨てられうる経路

`MAX_REPORTED_GATES`（50）と `MAX_SETUP_REASONS`（5）の切り詰めが何も残していなかった。
`merge.mjs` は同じ問題を `capped()` / `droppedNote()` で解いており、PR 本文の表はすべて
「_Not listed here: N further ..._」を明記する。同じ規則を dispatch にも適用した。
**上限値そのものは report サイズ抑制として妥当なので変えていない。**

**#171 はその副作用である。** #165 以降、gate を上限で切った事実は `checks` の**末尾**に 1 行
足される —— つまり `checks` は伸びる。ところが `carriedWorkerRecord` / `transcribedVerification`
が過去 report を再転記するとき同じ上限で無言に切り直すため、**末尾から落ちるのはまさにその
注記**だった。50 件ちょうどの `checks` を持つ carried record が「全部載っている」と読める状態に
戻る。新設した `transcribeCapped` が注記のぶんの枠を先に確保し、**この転記で何を切ったか**を
名乗る（上流で既に切られている可能性があるため「HERE」であることが分かる文言にした）。

### #176 — 禁止事項は goal に載らず、worker からは「存在しない」ように見えた

契約 `goal` は Issue 本文の要約であり、plan の抽出は**肯定形**（やること・受入条件・対象 file）に
偏っている。禁止事項を読む口が無いので、落ちた制約は worker から見ると「許可されていない」ではなく
**「存在しない」**ように見える。

実測（2026-08-09、Kewton/BorderFreeKidsMap #35）: 「送ってよい / 送ってはいけない」表の禁止 3 件の
うち転記されたのは 2 件で、worker は残る 1 件（施設の個別 ID と結び付いた閲覧履歴）を payload に載せて
commit した。**全ゲート green のまま受入条件違反**で、発見は人間のレビューだった。scope は path を、
`verify.gates` は exit code を締めるが、**禁止事項はそのどちらでもない。**

→ 否定的制約を含む節・表・箇条書きを要約対象から外し、**原文転記**する。配置は `## Objective` の直後
（worker は上から読み、goal の切り詰めは末尾から効く）。本文は dispatch 時に
`gh issue view <n> --json body` で **read-only** に Issue ごと 1 回読む —— plan は肯定形の抽出結果しか
運んでいないので**plan からは復元できない**。読めなければ停止せず、goal がそう名乗る。

**転記は切らない。** 上限に収まらないブロックはそこで打ち切り、後ろの短い節も載せない（載せると
transcript が本文の prefix でなくなり、**中抜けした要約と区別できない**）。落とした節を goal に名指しし、
「本文に他節がある。`gh issue view <n>` で全文を読め」の 1 行を必ず入れる。**禁止の表を半分載せた goal は、
落とした半分を許可したのと同じである。** 切り捨ては named code（`issue_constraints_transcribed` /
`issue_constraints_untranscribed` / `issue_body_unreadable`）で機械可読にした —— goal の 1 行は
**それが制約する当の worker が書き換えられる file の中に在る**が、report は run artifact なので動かない
（`contract_scope_dropped` と同じ設計）。`--unattended` で blocking へ昇格させることは検討して却下した:
`gh` 認証の無い CI が 1 人も dispatch できなくなり、しかも re-plan では直らない。

**見出し語集合は hardcode であって profile 宣言ではない。** 根拠 3 点:

1. 宣言し忘れたリポジトリの goal から禁止事項が**黙って消える** —— 本件そのものを設定で再現することに
   なる。**宣言しなければ効かない既定は、既定ではない。**
2. 「どの禁止を転記するか」を絞れる knob は、設定の見た目をした**権限の拡大**である。
   [dispatch-contract.md](./dispatch-contract.md) 第2.9節は `--verify-gates` に同じ形を既に禁じている。
3. `scope_companions` が profile 宣言なのは**テスト file の配置がリポジトリごとに本当に違うから**で
   あって、禁止表現の語彙はリポジトリの道具立てではなく **Issue を書く言語**の性質である。

見出し語集合は**床であって天井ではない**: 見出しに関わらず表・箇条書きを拾う規則が取りこぼしを覆う。

**Issue に関わらず**、header へ `Issue body: gh issue view <n>`、`## Rules` の先頭へ「契約が言及して
いない禁止事項は許可ではない」を入れた —— 見出し語を取りこぼした Issue でも、**本文を読めという指示
だけは届く**。フォールバック worker prompt にも同じ文面を入れてある。片方だけが運ぶと禁止事項が
「古い CLI の run だけ落ちる」ことになり、ADR §1.2 が `## Method` で退けた非対称になる。

同じ規則を **cmate-worker-development（0.2.0）** にも書いた: **契約が言及していない禁止事項は、契約が
許可したのではなく書いていないだけであり、Issue 本文が正本**。狭める方向（禁止）は本文も効き、
広げる方向（権限・対象 file）は契約が正本、という非対称である。A 段（読取）は「契約 file を読み、
**そのうえで** goal が Issue 番号を参照しているなら本文全文を読み取り専用で取得する」を必須手順にした
—— 従来の文面は契約だけで止まりうるものだった。取得できなかったら証拠に書く（**読まなかったことと
読めなかったことは別の事実**である）。

### #179 — `wait` の timeout が、worker の死と区別できなかった

`--wait-timeout` は `commandmate wait` の**1 回あたりの上限**であって、worker の**1 ターンの上限では
ない**。ターンが窓より長ければ runner は timeout を報告するが worker は走り続け、完走して commit まで
載せることがある（実測: Kewton/BorderFreeKidsMap #62、1 ターン約 40 分に対して `--wait-timeout 1800`）。
report からは「worker が死んだ」と区別できないので、ここで再 dispatch すると**完成済みの作業の上に
別 worker を重ねる**。見分けは人間が `capture --json` を手で叩いて行っていた。

→ wait が exit 124 を返した時点で `capture <worktree-id> --json` を**1 回だけ**叩き、その答えを当該
worker の `worker_liveness` へ転記して、同じ code の blocking reason を Issue ごとに 1 件出す。
契約経路とフォールバック経路の**両方**で行う —— どちらに乗るかは CLI の版が決めることで、operator が
選んだことではない。

**既存の `timeout` の意味は変えず、その隣に足した。** `worker_state` も `stop_reason` も `timeout` の
まま、blocking `worker_timeout` もそのまま出て、新しい 3 code（`wait_window_exhausted` /
`worker_stalled` / `worker_liveness_unreadable`）は**その隣に**並ぶ。理由は 2 つ:

1. `worker_timeout` は「**なぜ run が止まったか**」の答えで、その答えは変わっていない。新 code が
   答えるのは「**その timeout はどちらだったか**」という別の問いである。片方を他方で置き換えると、
   既存の read（`status.mjs` の hint 表・resume の停止梯子・fixture）が**答えを 1 つ失う**。
2. `stop_reason` は schema versioned な閉じた enum で、新値は `dispatch_schema_version` を上げる
   （第7節 / ADR 第11節）。`wall_clock_budget_exhausted` が `timeout` を再利用したのと同じ判断で、
   **上げずに済むならそうする**。`worker_liveness` は**任意 field** なので、この field を持たない既存
   report は引き続き schema に適合する。

生死の 3 code は**停止理由ではなく所見**なので、同じ wave の prompt / exit 99 が `stop_reason` を
取った run でも記録される（**測った事実は、どの停止理由が勝ったかで消えない**）。`capture` が失敗した /
出力が JSON でない / boolean が 1 つも読めない、はいずれも `worker_liveness_unreadable` として
**測れなかったこと自体**を記録する —— merge の `change_evidence_unavailable` と同型の規則で、
「見られなかった」を「何も無かった」に丸めない。読めない field は `false` ではなく `null` を記録し、
`worker_liveness` の**不在**も「稼働していなかった」ではない。

`--wait-while-generating` は実装していない。「生成中は待ち続ける」は **wait の時間意味そのものを変える
機能**で、延長の判断根拠（polling 間隔・生成中の定義・延長回数）は本件が入れた 1 回の測定とは別に実測して
決めるべきものである。本件の 1 回の測定と `--reverify` で、実測ケースの回収経路は閉じる。

### #180 — リポジトリの事情を書いた flag の置き場が、人間の記憶しか無かった

`--no-infer` / `--auto-yes` / `--wait-timeout` は run の事情ではなく**リポジトリの事情**を書いている
flag なのに、置き場が人間の記憶と CLAUDE.md しか無かった。付け忘れは**遅い run ではなく事故**になる
（phantom edge / 誰も答えない prompt / `wait_window_exhausted`）。planner が `develop` / `npm` を
hardcode しないのと同じ理由で、**その知識の入口は profile だけであるべき**である。

→ 任意 field `profile.dispatch_defaults`（`no_infer` / `auto_yes` / `wait_timeout` / `max_turns`）を
足し、dispatch runner が plan の profile から読んで引数解決に混ぜる。**宣言の無い plan では entry も
出力も 1 byte も変わらない。**

`Boolean(values['auto-yes'])` は「**渡していない**」と「**off のつもりで渡した**」が同じ false になるので、
これを**三値**で読み直した。`inputs.stated` の `null` が「誰も何も言っていない」であり、boolean の
false を打つ手段として `--no-auto-yes` を新設した（`parseArgs` は boolean option への
`--auto-yes=false` を先に落とすので、negation flag 以外に「この run だけ断る」を表現する方法が無い）。
`stated` が非 null のときだけ flag を採り、それ以外で profile の宣言を採る。**どちらを採ったかは
limitation `dispatch_defaults_applied` に 1 行で残す。**

**排他は argv ではなく解決後の値に対して行う。** `--unattended` と auto-yes の排他は profile 由来の値でも
同じく `invalid_input`（exit 3）になる。**argv だけを見る検査は、profile が回り込める検査**であり、
人が居ない run で唯一残る停止点（exit 10）を profile が構造的に消せてしまう。判定は plan を読んだ直後・
lock / pre-flight / `--out` の前に置いたので、拒否した run は `--out` を作らず CLI を 1 回も呼ばない。

`no_infer` は planner の flag で、**承認済み plan を dispatch が un-infer することはできない**。profile は
runner ごとに分けず 1 つの宣言にしたいので key は受け取り、plan の `inputs.infer` と突き合わせて
**食い違いだけ**を `dispatch_defaults_no_infer_not_applied` に記録する（合致している側は何も出さない。
黙って無視しない）。

profile-init は `dispatch_defaults` を**起案しない**。起案 runner が読むのは「リポジトリが**自分について
宣言していること**」であり、base branch は workflow に、baseline は package.json に、テスト配置は互いを
写す 2 つの実ファイルに書いてある。**運転既定はそのどれでもない** ——「このリポジトリには `--no-infer` が
要る」は**動かした人間が到達した結論**であって tree の中の事実ではない。起案すれば必ず推測になり、
推測した `auto_yes: true` は**検出した値と出力上見分けがつかない**（profile-contract §7.2 が消しに来た
性質そのもの）。`scope_companions` 式の「空宣言 + TODO」も置かない —— あちらの空宣言は「配置を決定
できなかった」TODO と対で意味を持つが、ここは**決定すべき材料が最初から無く**、TODO はどのリポジトリでも
永久に消えない。よって key ごと出さない（出さなければ flag の既定がそのまま効く）。

### #183 — wall-clock が「各 wave の最遅 worker の合計」だった

wave 方式の wall-clock は「各 wave の最遅 worker の合計」になる。worker の 1 ターンは実測で数分〜約 40 分と
ばらつくので（Kewton/BorderFreeKidsMap #62 は e2e/build 込みで約 40 分）、依存の無い Issue が
**「同じ wave に居合わせただけ」の最遅 worker を待つ**時間が支配的になる。

→ `--schedule dag` を足し、その Issue 自身の依存が `completed` かつ `verification.outcome: pass` に
なった時点で `--max-parallel` の空き枠へ投入する。律速が「wave の深さ × 最遅」から**最長経路**へ変わる。
**既定は `wave` のまま**で、`--schedule` を渡さない run の report は #183 以前と byte 一致する。

ready 判定は **#182 の実効 edge** に対して行う（`basis: lexical` を除いた集合）。語彙一致だけの推論は
planner が edge にしないので正しい plan には入っていないが、**手編集や古い runner の plan が #182 の効果を
打ち消すのを防ぐ**ため runner 側でも落とし、落としたら `schedule_dag_lexical_edge_ignored` で名乗る。
`basis` を持たない edge は落とさない（「区別ができる前に書かれた」であって「根拠が無い」ではない）。
file 衝突は依存ではないが、wave packing が担っていた「同じ file を宣言する 2 件を同時に走らせない」は
scheduler 自身が守る。`plan.waves` は参考情報になる（`merge_order` はこれの平坦化であり続ける）。

**barrier が兼ねていた安全装置は 3 つあり、それぞれ別の答えを出した。**

1. **失敗の伝播** — fail した Issue の**下流だけ**を止め（`blocked_by_upstream_failure`）、独立系列は
   走り続ける。`--unattended` では従来どおり全停止に倒し、依存は満たしていたのに投入しなかった Issue は
   `schedule_halted_unattended` として**別 code**で名乗る（対処が違う: 前者は「上流を直して
   `--resume`」、後者は「**この Issue には何も問題が無い**」）。
2. **合流検証のタイミング** — **run の末尾に 1 回。dispatch は merge を 1 回も呼ばない。**
   (a) #175 の受け渡しは「operator が wave 境界で手を止めて merge を回す」運用でしか成立しておらず、
   dag には**その停止点が構造的に無い**。(b) dispatch から merge を呼ぶと 1 invocation = 1 mutating
   phase が壊れ、承認境界（`--approve` / PR 作成 / base の fetch）が dispatch の flag 1 つに畳まれる。
   (c)「N 件ごと」は境界の意味が run ごとに変わる（wave 境界には「そこまでの依存が閉じている」が
   あったが、任意の N には無い）。**dag が失うのは「合流後の赤を早く見つけること」であって「合流後を
   見ること」ではない** —— 依存を宣言している下流は上流の pass を待つので、壊れた前段の上には積まない。
   report / summary / limitation `schedule_dag` が `merge --merge-prs --integration-verify` を 1 回
   回す指示を必ず書く。
3. **同時実行数の増加** — barrier は実効並列度を wave 幅に抑える副作用も持っていたので、dag では同じ
   `--max-parallel` でも走る worker が増える。前提の Kewton/CommandMate#1771（ゲートのリソース直列化 /
   worktree ごとの env 注入）は**現時点で OPEN のまま**であり、ゲートが何を bind するかを runner は
   知らないので直せない。よって**直さずに宣言する**: 「検証ゲートが資源（ポート等）を共有する
   リポジトリでは偽赤が増えうる。#1771 が着地するまでは `--max-parallel` を保守的に設定すること」を
   SKILL.md・契約・`dag` の run の limitation の**すべて**に書いた。
   **`--max-parallel` の既定を dag だけ下げるのは不採用にした** —— `max_parallel` は plan に載って
   **承認された値**であり、dispatch が黙って下げるのは「承認した plan と違う run」を作ることになる
   （無言の劣化を禁じている第2.7節と同じ規律）。下げるべきだと判断した operator は plan を作り直せばよい。

`--reverify` との併用は `invalid_input` で拒否する。reverify は 1 件も send しないので短縮する wall-clock が
無く、しかも ready 条件（依存が green）は**reverify が直しに来た状態そのものを拒否する**。
`--schedule` を #180 の `dispatch_defaults` に足していないのは、これが**リポジトリの性質ではなく、その
run で wall-clock と barrier のどちらを優先するかという運用判断**だからである（加えて #1771 が OPEN の間、
「このリポジトリでは常に dag」という宣言は偽赤を常態化させる）。

実装では、DAG のために per-issue の準備・監督・裁定記録を wave ループから括り出し、**両モードが同じ
関数を通る**ようにした（2 つ目の実装は片方でしか直らない）。DAG では worker の終了順が投入順と一致
しないので、**report に載るものは完了の中から書かない**: scope / liveness の blocking reason も裁定の
記録も、run の最後に **plan 順**で 1 回だけ回す（完了時点で走らせるのは、下流の ready 判定に必要な
fallback 検証だけである）。

### #197 — 構文として正しく、何にも一致しない規則は、誰も検出できなかった

profile-contract 第9.3節は、括弧の誤記（`{Base}` / `{base`）を `load_error` で拒否する理由として
「typo が literal に化けると**一致しない規則が黙って残る**」と書いている。その懸念は正しいが、
**構文として正しく、何にも一致しない規則**は同じ結果になり、こちらは検出されない ——
`scripts/{base}.mjs` と `scripts/{dir}{base}.mjs` はどちらも合法で、
`scripts/adapters/human-review.mjs` に届くのは後者だけである。`require[].add` のリテラルが
**実在しないファイル**でも load は通る。

気づけるのは plan を回して `scope_defaults` を目視したときだけで、そのためには Issue か fixture が
要る。実測（2026-08-14、Kewton/BorderFreeKidsMap）では #181 の `require` へ集約テストの宣言を
移して規則が 6 本になり、**6 本すべてが効いているかを確かめるのに 5 Issue 分の fixture を手書き
した**。書き間違えた 1 本は plan を成立させたまま導出を 1 件減らすだけなので、実際に分かるのは
worker が scope ゲートで落ちたときになる —— 契約 scope は send 時 snapshot なので、
**worker 側からは直せない位置**である。

→ `profile-init.mjs` に read-only の `--check <profile.json>` を足した。起案（draft の生成）とは
逆向きの、**既にある宣言を tree に突き合わせる**モードで、規則ごとに 1 行、`when` が repo tree の
実ファイル何件に一致するか、`derive[].add` / `require[].add` が指す path のうち何件が実在するかを
出す。守っているのは 3 つである。

- **read-only。** tree と profile を読むだけで、profile も plan も書かない。`--out` / `--emit` /
  `--repo` / `--id` との併用は `invalid_input` で拒否する —— **起案しない mode であることを、
  flag の無視ではなく拒否で言う。**
- **裁定しない。** 0 件一致は誤りではない（これから作る file を見越した宣言はありうる）ので、
  `companion_when_unmatched` / `companion_add_missing` は warning であって error ではない。
  status は `partial` になるが exit は 0 で、起案 mode と同じ規約に従う。
- **planner は対象リポジトリを開かない**（第9.1節）は不変である。これは planner ではなく、
  **人間が profile をレビューするときに使う別 runner** である。

**マッチングの意味論を 2 箇所に持たない。** `--check` が独自の解釈を持てば「`--check` は通るが
planner は一致しない」という、本件が消しに来た事象の**変種を自分で作る**ことになる。規則評価
（`{dir}` / `{base}` の展開と一致判定）と宣言の正規化を `lib.mjs` へ抽出し、planner と `--check` が
**同じ関数**を呼ぶ。#177 の境界（`HARNESS_PATH_PREFIXES` / `isHarnessPath`）も、profile を読む
両者で共有する。**抽出が純粋であることは golden で示した** —— 全文 golden 9 本を含む全 plan case の
plan が **1 byte も変わらない。**

例外は 1 つだけで、意図的である。`require[].add` の literal が repo の外を指していないかの拒否は
planner の path 語彙（`SYSTEM_ROOTS`。cmate-issue-authoring が byte 単位で mirror しているので
`orchestrate.mjs` に宣言が残る必要がある）に属するので、planner が predicate を loader へ渡す形に
した。`--check` は同じリテラルを「実在しない path」として warning に出し、planner は profile を
読んだ時点で `load_error` にする —— **許可を与えるのは planner だけなので、拒否も planner が持つ。**
fixture がこの分岐を両側から固定している。

## merge（`scripts/merge.mjs`）

### #142 — 無人運転の段階 C（`merge --merge-prs`）

段階 A / B が到達する最遠点は PR であり、**PR は人間が読む場所である**。「lint と test が通った」を
「Issue が完成した」と読み替えた成果物が PR として立つことは、害ではなく本来の姿だった
（レビュアーが読み、必要なら close する）。**段階 C は違う。そこで読み替えが起きると、誰も読まないまま
base branch に入る。**

→ `--merge-prs --unattended` を受理する。段階 B の `invalid_input` は**消したのではなく、それが名指し
していた段に置き換えた**。**含意する締め付けは1つだけである: 全 eligible Issue が「受入ゲートブロック
（```acceptance-gates）を持つ」かつ「受入条件を持つ」こと**（ADR 第9節 条件2）。1件でも欠ければ
**1つも merge せずに停止**する（`preflight_failed` / exit 1）—— **除外ではなく停止**であり、
**条件を満たす Issue も merge しない**。除外にすると「満たす方だけ merge して success」を返すので、
対象集合が黙って縮んだことに誰も気づけない。読むのは plan だけで、**ゲート id が実在するかは問わない**
（それは worktree を持つ dispatch の問いであり、merge 段では既に消えているかもしれない worktree に
ついて二番目に悪い意見を出すことになる）。

`--create-prs` の締め付けリストは**段階 B の1件のままである**（後から段階 B の意味を変えない）。
`merge_schema_version` は 1 のまま、`stop_reason` の enum にも値を足していない。

### #134 — 無人運転の段階 B（`merge --create-prs`）

`--unattended` を `merge.mjs` が受理する。**含意する締め付けは1つだけである:
`change_evidence_unavailable` を limitation ではなく blocking として扱う。** PR 本文に実変更を
載せられなかったという事実は、人間が読む運転なら読み手が branch を開いて補える劣化だが、
無人では**証拠の無い PR が黙って作られる**ことになるので、その Issue の PR を作らずに停止する。
フラグ無しでは従来どおり limitation で続行する（fixture で二点測定）。

**`--approve` を含意しない**（無人で PR を作る CI は両方書く）。**`--merge-prs` との併用は
`invalid_input` で拒否する**（段階 C 未実装。受理して無視すると CI は自分が守られていると誤解する）。
`gh` 由来の停止はコードに足していない —— 実測（#115 第14.5節）どおり
`GH_TOKEN` と `GIT_TERMINAL_PROMPT=0` は job 定義側の話である。


### #97 — PR 本文が「検証した」と言うだけで、何を通ったのかは JSON の中だった

merge runner は `--dispatch` で dispatch-report.json を必須入力として読んでいたのに、
eligible 判定にしか使っていなかった。PR 本文の Verification 節は定型文と profile baseline の
コマンド一覧だけで、**gate 別の合否も exit code も転記されない**。レビュアーは run artifact を
掘るか、diff を自力で照合するしかなかった。契約が宣言した `scope.allow` に対して
**実際に何を変更したのか**も PR には現れなかった。

→ Verification 節を実測証拠に置き換えた。gate 名・合否・exit code の表、宣言 scope と実変更
ファイルの対比（契約ゲート `requireScopeClean` の人間可読版）、diff 規模。`verification.ran` が
false ならその事実を明示する（定型文で pass を匂わせない）。転記値は既存の `redact()` を通し、
gh の本文上限に備えて checks は打ち切り、**打ち切った事実を本文に書く**。

### #39 — 多段ブランチ運用で、PR を merge しても Issue が open のまま残った

GitHub が `Resolves #n` で Issue を自動クローズするのは**デフォルトブランチへの merge 時だけ**
である。`feature/* → develop → stg → main`（デフォルトは `main`）のような運用で `develop` 宛に
PR を出すと、merge しても Issue は open のまま残った。

→ phase 冒頭で read-only の `gh repo view --json defaultBranchRef` を **invocation あたり1回**
引き、PR の base がデフォルトブランチかどうかを見る。違えば limitation
`issue_autoclose_not_default_branch` を記録し、各 PR body にも同趣旨の注記を1行足す。
`gh repo view` が失敗した場合は**照合をスキップするだけ**で、PR 作成フローは阻害しない
（不明を不一致として扱わない）。記録に留め、`gh issue close` を勝手に実行することはしない。
正本: [merge-contract.md](./merge-contract.md) 第5.1節。

### #174 — 非ASCII path が、PR 本文で「宣言外の変更」に化けていた

`changeEvidence()` が `git diff --name-only <range>` の出力を、plan の `scope.allow`（Issue が書いた
ままの UTF-8）と文字列比較していた。**git は path をそのまま出さない** —— `core.quotePath` が既定
true なので非ASCII バイトを 8 進エスケープし、全体をダブルクォートで囲む。結果、同一 file が別表記で
2 行に並び、scope 内の変更が PR 本文で `Out-of-scope changes: 1` / `Declared: no` になる。

裁定（CommandMate の scope ゲート）はこの経路を通らないので **pass のまま正しく、壊れていたのは人間が
読む本文だけ**である。ただし出るのが `branch_changed_outside_declared_scope` という**正常系の名前の
limitation** なので、「worker がスコープを踏み越えた」と読まれる。

→ 2 案のうち **`-z`（NUL 区切り）** を採った。`-c core.quotePath=false` は**非ASCII しか解かない** ——
`"`・`\`・制御文字を含む path は quotePath に関係なく C クォートされるので残る。`-z` は munge 自体を
止め、区切りも NUL になるので `split('\n')` が持っていた**別の穴（改行を含む path）**も同時に塞ぐ。
実測で `-z` が使えない事象は無かったため fallback は採用していない。`--numstat` も揃えた（現状は
件数集計にしか使っていないので出力は正しいが、**将来 path 列を読んだときに同じ欠陥が再発する**）。

PR 本文と reference が引用する command 行にも `-z` を入れた。この節の目的は「run ディレクトリの JSON の
中にしか無い証拠を残さない」ことなので、読み手が同じ command を再実行して**表の path と同じもの**を
得られる必要がある —— `-z` 無しの command を書くと、再実行結果はエスケープ表記になり、**本件と同じ
食い違いを読み手側に作る**。

fixture 側の穴も同時に塞いだ。それまでの fake CLI は scenario の path を**そのまま echo していた**ので、
**この不具合は fixture からは見えなかった**。本物と同じ munge 挙動（quotePath 既定 true、`"`/`\`/
制御文字は設定に関係なくクォート、`-z` なら munge 無しの NUL 終端、`git -c k=v` の解釈）を持たせてある。

### #175 — file が重ならない意味的衝突は、合流後を誰も検証していなかった

wave の衝突検出は `suspected_files` の重なりしか見ず、guarded merge が確認する CI は**兄弟 PR が入る前の
base** で走っている。したがって「片方がデータを直し、もう片方がそのデータの性質に依存する検査を書く」類の
**意味的衝突**は file が重ならないので「衝突なし」として同一 wave に入り、**合流後の状態は誰も検証して
いない**。実測（2026-08-12、Kewton/BorderFreeKidsMap #105 × #106）では develop に入った直後から
`npm run test:unit` が赤で、発覚は develop → stg の promotion PR の CI だった。

→ `--merge-prs` に **opt-in の `--integration-verify`（既定 OFF）** を足した。merge を 1 件でも行った
あと、merge ループの後に**1 回だけ** `git fetch` → `FETCH_HEAD` の使い捨て detached checkout →
profile の baseline を実行 → 畳む、を行う。

- **何を実行するかは profile からしか取らない**（`develop` / `npm` は hardcode しない。planner と
  同じ設計原則で、規約の出どころは profile だけである）。
- **materialise するのは `FETCH_HEAD`** である。ローカルの `develop` も fetch 前の `origin/develop` も
  「**各 PR の CI が既に green だと主張した状態**」であり、合流後を測るには remote が今持っている tip で
  なければならない。
- **使い捨ての detached checkout** で測り、invocation の作業ツリーには触れない。branch も持たず
  CommandMate にも登録しないので、`cmate-worktree-setup` に委ねている worker 用 worktree の準備段では
  ない。畳めなければ**裁定は変えずに** `integration_verify_tree_left` に残す。
- preview / eligible 無しでは merge が無いので `outcome: not_run` + `integration_verify_not_run`。
  **「測っていない」を green に丸めない。**

**profile に baseline の宣言が無いときは error であって skip ではない**（1 件も merge せずに
`preflight_failed` / exit 1 / `integration_verify_unavailable`）。根拠は 3 つ:

1. skip にすると、**opt-in した検証が走らないまま「merge phase 完了」と報告される**。誰も合流後を
   見ていないのに緑に見える —— **#175 が消しに来た事象そのもの**である。
2. 同じ読みが既にこの package の 2 箇所にある。dispatch の fallback 検証は baseline が空なら
   `outcome: fail`（「検証すべき gate が無いから pass」に化けさせない）、profile-init が埋められない
   baseline に置く雛形は **exit 0 しない command** である（profile-contract 第7.2節）。
   **埋め忘れた baseline は fail-closed でなければならない。**
3. **merge の前**に拒否するので世界は動いていない。profile に `baseline` を書いて同じコマンドを
   再実行すればよく、**取り消すものが何も無い**。

`merge_schema_version` は 1 のまま、`stop_reason` / target `outcome` / `preflight[].code` にも値を
足していない。上げると `status.mjs`（`SUPPORTED_MERGE_SCHEMA_VERSION = 1` を pin）が**フラグを使って
いない run の report まで読めなくなる**。赤は既存の **`merge_failed`** が受ける —— `ci_failed` /
`ci_pending` はこの report では「その PR の CI が green でないので **merge しなかった**」を意味しており、
合流後の赤は **merge が成功した後**の話なので、そこへ流すと report の中で最も安全に関わる事実
（**何が既に base に入ったか**）が逆に読める。名指しは `blocking_reasons[]` の code が行う。
`--create-prs` との併用は `invalid_input`（exit 3）で拒否する —— **merge しない phase には合流後が無い**。
受理して無視しない（段階 B の `--merge-prs --unattended` 拒否と同じ規律）。

これで wave barrier の意味が「前 wave の全 worker 完了 + verification pass」から**「統合ブランチも
green」**まで広がった。dispatch が読むのは `integration_verify.outcome` で、進んでよいのは
**`status: success` かつ `"pass"`** のときだけ —— `"not_run"` は「測っていない」であって green ではなく、
**field ごと無いのは「フラグを使っていない run」**である（第5.4節）。

**merge queue 方式（base 更新 → CI 再走 → merge の直列化）は実装していない。** Issue 本文が「まずは
合流後検証の 1 段で十分」と判断している。#183（`--schedule dag`）から見たこの検証の位置づけは
dispatch 節の #183 に書いた。

### #195 — `--integration-verify` が、目的の違う検証集合を流用していた

#175 の `--integration-verify` が実行するのは profile の `baseline` だが、`baseline`（各 worker が
worktree で回す **proportional な健全性確認**）と「**合流後の統合ブランチが green か**」は
目的の違う検証集合である。同じ key を共有している限り、どちらか一方は必ず間違う ——
`baseline` を重くすれば worker の fallback 検証が毎回 build / e2e を回し、軽いままにすれば
opt-in した統合検証が「**測っていないのに green**」になる。

しかも #175 の fail-closed は**これを検出できない**。埋め忘れ（未宣言）は `preflight_failed` /
exit 1 で落ちるが、**目的の違う `baseline` が宣言されている状態**は `outcome: "pass"` を返して
`status: success` になる。実測（Kewton/BorderFreeKidsMap）では、このリポジトリの `baseline` は
`npm ci` / `lint` / `typecheck` の 3 本で **`unit` を持たない**（重い検証は最後の verify に任せる、
という運用文書の判断である）。したがって **#175 を起票させた当の #105 × #106 が、
`--integration-verify` を付けたまますり抜ける** —— この機能が消しに来た当の事象である。

→ 任意 field `integration_baseline` を足し、解決を `integration_baseline` ?? `baseline` にした。
**`??` が働くのは key が未宣言のときだけ**で、宣言しない profile の run は #175 と同一の集合を測る。
`"integration_baseline": []` は「**統合検証の定義は無い**」という宣言なので `baseline` へは落とさず、
`--integration-verify` 下では `preflight_failed` / exit 1 / `integration_verify_unavailable` にする
（1 件も merge しない）—— 目的の違う集合へ黙って落ちるのは、**本件の論旨そのものに反する**。
配列でない値を持つ手書き plan も同じ fail-closed 側へ倒す。

**採った側を `integration_verify.source` に記録する。** どちらを測ったのかが report 単体で読めないと、
この分離は「**静かな 2 つ目の baseline**」になる —— 違う集合を測った 2 つの report が同じに読める。
何も実行しなかった run でも記録し、2 つある拒否の next action もこれで分岐する。空宣言の author に
「`baseline` を宣言しろ」と案内するのは、**意図した宣言を取り消せという意味になる**からである。

planner 側（`PROFILE_FIELDS` と `publicProfile()` の echo）を同梱したのは、#180 が踏んだ
「**読む側だけ先に着地する**」非対称（#196）を繰り返さないためである。`merge.mjs` だけ直しても、
`integration_baseline` を書いた profile は plan 段階を通らない。echo では**宣言された `[]` を `[]` の
まま出す** —— merge の解決は key の存在で分岐するので、落とすと未宣言と区別が付かなくなる。

`profile-init` は `integration_baseline` を**起案しない**（#180 / #181 と同じ規律）。何を統合検証に
すべきかは、**リポジトリが自分について宣言している事実ではなく、運転して分かる結論**である。

「宣言したが読まれていない」緑は**変異で反証した**。`baseline` は合流後 green・`integration_baseline`
は赤という profile（`m28`）は、宣言を無視する実装 ——すなわち #175 の挙動—— なら緑になる。逆向き
（`m29`: フォールバックが赤・宣言が緑）の `pass` は、宣言を読んだ実装にしか出せない。

`merge_schema_version` は 1 のまま据え置いた。足したのは `--integration-verify` を渡した run にしか
現れない object の内側の 1 field で、上げると `status.mjs`（`SUPPORTED_MERGE_SCHEMA_VERSION = 1` を
pin。#175 と同じくこの Issue の宣言 scope の外）が**フラグを使っていない run の report まで読めなく
なる**。判断は [merge-contract.md](./merge-contract.md) 第10節に #175 の先例と並べて書いた。

---

## uat（`scripts/uat.mjs`）

### #142 — 無人運転の段階 C（`uat`）と、再merge が入る先の検査

`uat.mjs` の再merge は `git merge --no-ff --no-edit <fix-branch>` で **cwd 指定を持たない**ので、fix は
**invocation cwd の現在の branch** に入る。[#115](https://github.com/Kewton/commandmate-skills/issues/115)
が使い捨てリポジトリで実測した（ADR 第14.3節）: **CI が base branch を checkout した状態で回すと
UAT の fix が誰のレビューも経ずにそこへ入り**（push 済みなら不可逆）、**detached HEAD では merge exit 0 で
「merged」と報告しながらどの branch にも残らない**（既存の停止語彙では捕まらない静かな false success）。
人間が居る運転では cwd を選んだのが人間なので前提は満たされていたが、**無人運転ではこれは前提ではなく
検査すべき条件になる**。

→ `--unattended` を受理し、`--create-uat-fix-worktrees` では **fix worktree を1つも作る前に**
`git symbolic-ref -q HEAD` を撃つ。出力が空（detached）なら `unattended_cwd_detached`、
`--expect-branch` と違えば `unattended_cwd_branch_mismatch` で停止する（`preflight_failed` / exit 1）。
**worktree を1つも作らず、fix worker を1人も送らず、再merge を1度もしない。** 比較対象の branch は
plan のどこにも無いので（`profile.base` は **base** であり、fix を base に入れることこそこの検査が
防ぐ事故である）、dispatch の drift check と同名の **`--expect-branch` を足した**。

`--unattended` は **`--require-acceptance` と `--max-attempts` の明示も要求する**。意味ゲート無しの
無人 UAT は「dispatch が既に通した baseline をもう一度走らせた」でしかなく、**受入を確認したとは
言えない**。その帰結として `acceptance_not_run` は**昇格ではなく「起こらない」**（劣化は不合格になる）——
専用のコードは1行も書いていない。`uat_schema_version` は 1 のまま、`stop_reason` の enum にも
値を足していない。

### CommandMate #1616 — baseline が green でも受入条件は未達、という穴

機械ゲート（profile baseline）だけで裁定していたため、「lint も test も通るが、Issue の受入条件は
満たしていない」成果物が `success` に丸められた。

→ 裁定を **機械ゲート + 意味ゲート**の二層にする。意味ゲートの入力は cmate-acceptance-test の
result document（`acceptance-result.v1`）であり、**判定の生成はエージェント側の手順、合成は
uat runner の決定的処理**である（runner 内で LLM 判定はしない）。`conditional_go` は human 判断
であって自動修正の対象ではないので pass にも fix 対象にもせず `partial` で提示する。
result が無い・schema 不適合・対象 Issue 不一致は limitation `acceptance_not_run` として記録し、
**黙って劣化しない**。`--require-acceptance` はそれを不合格に格上げする。
正本: [uat-contract.md](./uat-contract.md) 第4節。

### CommandMate #1448 — fix worktree は worktree-result の形に合わせる

fix worktree の作成は base を resolved SHA に再確認し、既存 worktree を暗黙上書きしない。

### CommandMate #1468（uat 側） — fix worker も監督ループで駆動する

fix worker も dispatch worker と同じく毎ターン idle 化する。**wait の idle は完了ではない。**
fix branch に新規 commit が出れば `completed`、未 commit なら継続 nudge を送って `wait` へ戻り、
`--max-turns` 到達で未 commit なら `fix_failed` で停止する。

### 上限到達を成功に丸めない

fix 回数は `--max-attempts` を超えない。上限到達でなお不合格が残るなら **`blocked`
（`max_attempts_reached`）** で停止し、未解決 Issue と next action を返す。回数無制限のループは
スコープ外である。

### #163 — 「人が閉じるべき残件」が 8 件で黙って切れていた

`acceptanceFindings` / `acceptanceConditions` は集めた項目を `MAX_ACCEPTANCE_ITEMS`（8）で
切っていたが、切ったことをどこにも書かなかった。9 件目以降の fail や未解決基準が uat-report から
読めなくなり、**リストは全量であるかのように見える**。8 件ちょうどのとき、それが「全部で 8 件」
なのか「8 件で切れた」のか区別できない。

さらに items の組み立て順（criteria → next_actions → limitations）により、**criteria が 8 枠を
食い尽くすと next_actions と limitations は 1 件も載らない**。acceptance 側が明示した次アクションが
report から丸ごと消える。`conditions` は「人が閉じるべき残件」の一覧なので、誤読の代償が大きい。

→ 新設した `fitAcceptanceItems(groups, max)` が 2 つの規則で枠を配る。いずれも `merge.mjs` の
`capped()` / `droppedNote()` から持ってきた考え方である。**(1) 切ったら必ず名乗る** ——
落とした件数と種別ごとの内訳を末尾の注記に書く。注記は上限の外に足すのではなく **1 枠を消費する**
ので、schema の `maxItems` 境界は変わらない。**(2) 発言のある種別は最低 1 枠を確保する** ——
長い fail の列が予算を食い尽くして後ろの種別が丸ごと消えることを防ぐ。

上限値 8 そのものは report サイズ抑制として妥当なので変えていない。合否裁定（`outcome`）にも
触れていない —— 変えたのは読み取りだけである。

---

## 設計（ADR のみ。実装は後続）

### #103 — 「ワーカーが Issue を受け取ってから何をするか」を持つ Skill が無かった

11 スキルは上流（Issue 起案・精錬・調査）・準備・実行制御・検証・後始末を覆うが、
**開発の方法だけが空白**だった。`buildContractGoal()` が渡すのは WHAT（Objective / 受入条件 /
変更してよいファイル）と制約で、**HOW（調査・計画・実装の作法）を渡していない**。
CommandMate リポジトリ内では `/pm-auto-issue2dev` が埋めているが、
**スラッシュコマンドはリポジトリスコープ**なので外部リポジトリでは `Unknown command` になる。

→ [adr-worker-development-skill.md](./adr-worker-development-skill.md) を書いた。中心の裁定は
**「このスキルが足すのは方法であって権限ではない。契約と食い違ったら契約が勝つ」**。
呼び出し口は契約 `goal` の `## Method` 節で skill を名指しする形とし、
**`buildWorkerPrompt`（契約非対応 CLI のフォールバック経路）にも同じ節を置く**
—— 片方だけだと `--contract-mode auto` の落ち先で方法論が黙って消える。
runner に方法論の要約を埋め込む案は、正本が2つになる・方法の更新に本 package の再リリースが
要る・委譲先の install を検査できない、の3点で却下した。実装は別 Issue。

### #115 — unattended の未決事項を測ったら、前提が2つ逆だった

[adr-unattended-mode.md](./adr-unattended-mode.md) 第13節の6点を実測し、第14節に記録した。
**4点で ADR の記述を訂正した。**

- **`gh` は対話に落ちない。** TTY が無いことを自分で判定して待たずに落ちる。無人運転を実際に
  止めるのは **`git push` の資格情報プロンプト**である。第6.3節に足すべき停止は無く、
  必要なのは job 定義側の環境変数だった。
- **契約の `autoYes: mode: off` は monitor を止めない。** サーバ側では確かに効くが、
  その事実が `capture --json` に出るのは Auto-Yes poller が回っているときだけで、poller は
  `autoYesState.enabled` が false なら起動しない。unattended は auto-yes を切るので
  poller が回らず、monitor は抑止を知らないまま Enter を送る。**`--no-auto-approve` は要件のまま**。
- **cron の再入は排他が要る**（同じ worktree に2つの supervisor が交互に `send` する状態を再現）。
- **uat の再merge は detached HEAD で「merged」と報告してどこにも残らない**（段階Cに pre-flight 検査）。

第14.7節に**測らなかったこと**を明記してある。

### #122 — 無人運転の停止は在ったが、二重起動と時計の穴が開いたままだった

[#115](https://github.com/Kewton/commandmate-skills/issues/115) の実測（ADR 第14節）が2つの穴を
確定させた。**`out_exists` は mutex ではない** —— pre-flight 実行中・`--out` が run ごとに変わる cron・
`--resume` の3経路では成立せず、700 ms ずらして起動した2本の run が同じ worktree に交互に `send` した。
そして **時計の上限が構造的に存在しない経路が在る** —— profile baseline と acceptance コマンドは
`timeout` 無しで実行されるので、`--wait-timeout` はその時間に一切効かない。

→ 段階 A（dispatch のみ）を実装した。`--unattended` は**締め付けだけ**を含意する:
`--contract-mode require`、pre-flight での全 Issue scope 検査（`--out` 未消費・all-or-nothing）、
**worktree 単位の排他 lock**（`mkdirSync` の EEXIST に依る。`kill -9` された run の lock は
死んだ pid を見て回収する）、**`--wall-clock-budget` の明示必須**（残り budget は子プロセスすべての
timeout でもあるので、timeout を持たない baseline も打ち切れる）、`unattended_baseline` の記録。
緩和フラグとの併用は `invalid_input`。**`stop_reason` の enum にも field にも1つも足していない**
（打ち切りは既存の `timeout` を再利用し、事実は `limitations` / `blocking_reasons` の自由文字列で運ぶ）。
`--unattended` を渡さない run が 1 bit も変わらないことは、**同じ世界を2回 dispatch して
report を突き合わせる fixture**で機械的に固定してある。実装で形が変わった点は
[adr-unattended-mode.md](./adr-unattended-mode.md) 第15節にある。

### #121 — 回復経路は在ったが、「終わっている worker をもう一度走らせる」しか無かった

[#89](https://github.com/Kewton/commandmate-skills/issues/89) の中心的な被害（検証に通った成果物が
納品経路から外れる）は `--resume`（#98）で塞がった。残っていたのは**手段**である。`wait --verify` が
timeout すると裁定が `not_run` のまま report に凍り、worker がその後に完走して commit しても report は
更新されない。この状態で古いのは**裁定だけ**で、**作業は既に終わって worktree に在る**。それでも
`--resume` は再 dispatch する —— worker のターンを1つ消費し、終わっていると分かっている worker に
契約を再送するので、不要な差分が生まれる余地も残った。

→ `--reverify <前回の --out>` を足した。`send` を1回も呼ばず、worktree の現状を verification gate に
かけ直して report を更新する。裁定は契約経路なら `commandmate verify <worktree-id> --json` の
exit code、契約非対応なら profile baseline の再実行 —— **どちらも既に在る CLI 表面**で、新しいものは
1つも要求していない。

裁定:

- **「作業が在る」を推測しない。** 対象を選ぶ基準は work-evidence ゲートと**同じ2つの事実**
  （work ブランチの commit / worktree の未 commit の変更）で、`git rev-list --count <base>..HEAD` と
  `git status --porcelain` で**判定の前に**測る。前回 report の `worker_state` からは読み取れない ——
  timeout した record は `verification.outcome: not_run` であって、測定結果を1つも持っていない。
  「timeout だから多分作業は在る」は、Issue が名指しで禁じた推測である。
- **測定を `commandmate verify` に委譲しない。** 委譲すると答えが**裁定**として返る: exit 21 は
  `fail` なので（この意味は変えない）、誰も作業していない Issue の record を**格下げ**することになる。
  しかもその格下げは、この flag が避けるために存在する「余計な実行」の産物である。裁定規則を
  1つも変えずに済ませる唯一の方法が「訊かないこと」だった。フォールバック経路の judge（profile
  baseline）が work-evidence を測らないことも、基準を judge の外に置くべき理由になった。
- **完了の定義は変えない。** `completed` に上がるのは work ブランチに commit が在るときだけである。
  未 commit の作業しか無い Issue は納品できず、この経路は commit を要求できない（要求は send である）。
- **無人運転の排他 lock は取る。** 送らないので worker は起動しない —— それでも取るのは、
  `commandmate verify` が **worktree の中でリポジトリのゲートを実行する**からであり、その裁定が
  **merge が eligible として読む report** に書き込まれるからである。別の run の worker が書き換えて
  いる最中の木を裁定すると、誰も納品していない状態についての合格を作って、そのまま届けてしまう。
  lock の粒度が「1 worktree に supervisor は1人」なのはこの harm のためで、「読むだけだが裁定する者」
  はその内側にいる。
- **`--resume` との併用は拒否する。** 両者は引き継がなかった Issue に対する**正反対の答え**である。
  両方受け付けると runner が片方を推測することになり、外せば worker のターンを無駄にするか、
  終わっていない作業を放置するかのどちらかになる。
- **artifact の作法・整合性ガードは `--resume` と同一で、code も共有する。** ディレクトリ名を
  `reverify-attempt-` にしなかったのは、`status.mjs` の走査順と、両者を混ぜたときの attempt 番号の
  連続性が1つの命名規約に依っているからである。`dispatch_schema_version` は 1 のまま、
  `stop_reason` の enum にも値を足していない（#93 / #95 / #103 / #122 と同じ裁定）。

fixture は `sent: []`（1件も送っていない）と `verify` の呼び先（引き継ぎ分には飛ばない・作業証跡が
無い Issue にも飛ばない）を両方固定する。正本: [dispatch-contract.md](./dispatch-contract.md) 第8.5節。

---

## パッケージ

### 0.29.0 — リポジトリの事情を profile が全部宣言でき、宣言が効いているか確かめられる（#195 / #196 / #197 / #199 / #200）

**目的の違う 2 つの検証集合が、1 つの key を共有していた**（#195）。`--integration-verify`（#175）が
回すのは profile の `baseline` だが、`baseline` は各 worker が worktree で回す proportional な
健全性確認であり、統合検証は「**合流後の統合ブランチが green か**」である。#175 の fail-closed は
埋め忘れ（未宣言）しか捕まえられず、**目的の違う `baseline` が宣言されている状態**は
`outcome: "pass"` を返す。実測（Kewton/BorderFreeKidsMap）ではこのリポジトリの `baseline` に
`unit` が無いため、**#175 を起票させた当の #105 × #106 が `--integration-verify` を付けたまま
すり抜ける** —— この機能が消しに来た当の事象である。任意 field `integration_baseline` で分離し、
採った側を `integration_verify.source` に記録する。

残る 4 件は 3 つの塊になる。

**1. profile が、リポジトリの事情を全部宣言できる（#196 と #195 の planner 側）。** #180 で入った
`dispatch_defaults` は **dispatch 側だけの着地**で、宣言を書いた profile は plan 段階を
`load_error`（exit 6）で通らなかった —— この field が runner に届く道は「手で patch した plan」
しか無く、`--auto-yes` / `--wait-timeout` の置き場は人間の記憶と CLAUDE.md のままだった。planner 側
（`PROFILE_FIELDS` と `publicProfile()` の echo）を着地させ、#195 の `integration_baseline` は
**両側同時**に入れた ——「**読む側だけ先に着地する**」非対称を繰り返さない。

**2. 宣言が効いているかを、plan を回す前に確かめられる（#197）。** 構文として正しく、
**何にも一致しない** `scope_companions` 規則は誰も検出できなかった（`scripts/{base}.mjs` と
`scripts/{dir}{base}.mjs` はどちらも合法で、`scripts/adapters/human-review.mjs` に届くのは後者
だけである）。read-only の `profile-init --check` が規則ごとに一致件数を出す。**裁定はしない** ——
0 件一致は warning であって error ではない。マッチングの意味論を 2 箇所に持たないため、規則評価を
`lib.mjs` へ抽出し、planner と `--check` が同じ関数を呼ぶ。

**3. 「名乗る」と「止める」を分け、入口を文書化した（#199 / #200）。** #177 の唯一の出口
（ハーネス path の明示宣言）を通ると run 全体が `partial` に落ちており、ハーネスを in-repo で
保守するリポジトリでは**検証ゲートを足すのが定常作業**なので `partial` が常態になっていた ——
#177 自身が除外側について同じ力学（読み手に読み飛ばし方を教える）を論拠にしている。
`plan.warnings[]` に `severity` を足し、`status` を落とすのは blocking だけにした。そして
`--issue-json` の fixture 形式は **runner を読まないと分からない**状態だった —— 0.28.0 が増やした
3 経路（#177 / #178 / #182）の正しい対処が「本文を直して re-plan」である以上、これは
**推奨した対処法の入り口が塞がっている**状態であり、plan-contract 第1.1節に書いた（#200）。

**破壊的変更は無い。** `plan_schema_version` / `dispatch_schema_version` / `merge_schema_version` は
すべて据え置きで、`stop_reason` / `worker_state` / `completion_check[].id` の enum にも値を 1 つも
足していない。plan 側に足した field（`warnings[].severity` / `profile.dispatch_defaults` /
`profile.integration_baseline`）は**すべて schema 上 optional** で、0.28.0 以前が書いた plan は今も
valid であり、`status.mjs` は過去 run を読み続けられる。required にしたのは
`integration_verify.source` の 1 つだけだが、**この object は `--integration-verify` を渡した run に
しか存在しない** —— 判断は [merge-contract.md](./merge-contract.md) 第10節に #175 の先例と並べて
書いてある。

**宣言しない profile の plan / report は 1 byte も変わらない。** 条件付き echo の追加順は
`scope_companions` → `dispatch_defaults` → `integration_baseline` に固定してあり（**順序が plan の
バイト列を決める**）、`severity` は **notice の entry にだけ** emit する（`blocking` を綴ると notice を
含まないすべての plan が動く）。#197 の `lib.mjs` 抽出が純粋であることは、**全文 golden 9 本を含む
全 plan case の plan が 1 byte も変わらない**ことで示した。`m22`（merge）と `d87`（dispatch）は
0.28.0 と同じく、**その機能が入る前の runner が書いた** golden を byte 比較する非回帰の測定として
残っている。

**止まり方が 2 つ変わる。** ハーネス path を**明示宣言した** plan は `partial` ではなく `success` に
なる（#199。`harness_path_in_scope` は `plan.warnings` に残り続け、`codes-and-recovery.md` の対処表にも
載り続けるので、「名乗る」は失われていない）。逆に `"integration_baseline": []` を宣言して
`--integration-verify` を渡すと、`baseline` の有無に関わらず `preflight_failed` / exit 1 で
**1 件も merge せずに止まる**（#195）—— 空配列は「統合検証の定義は無い」という宣言であり、目的の違う
集合へ黙って落ちるのは本件の論旨そのものに反する。あわせて、`dispatch_defaults` /
`integration_baseline` を書いた profile が **`load_error` で拒否されなくなる**のもこの release からで
ある。

同時に **cmate-issue-refinement が 0.4.0** に上がる（#198）。0.28.0 の #178 で入った ```open-questions
記法には**読む側しか無かった** —— refinement が blocking な open question をそのまま貼れるブロックと
して出すようになり、「問いを出す → 本文へ残す → **決めたら消して re-plan**」の線が両端で繋がる。
生成規則はリポジトリ層の conformance テストが**実物の planner に食わせて**固定しており、
refinement 側に散文のミラーは置いていない（記法の正本は
[open-questions-notation.md](./open-questions-notation.md) のままである）。

### 0.28.0 — 推測を推測と名乗らせ、wall-clock を最長経路へ（#174 / #175 / #176 / #177 / #178 / #179 / #180 / #181 / #182 / #183）

**worker が、自分を裁く検証ランナーを書き換えられた**（#177）。受入条件に書いた
`.claude/skills/cmate-verify/scripts/verify-run.sh` がそのまま `scope.allow` に入っていた ——
受入条件の中の path は「成果物」であるのと同じくらい「実行するコマンド」であり、**形では区別できない**。
ハーネス root を deny-by-default にし、落とした path は `reference_files`（読めるが書けない）へ出す。
**ゲートが 1 つ機能していなかった**ので、この 10 件の中で唯一、認可境界に開いていた穴を塞ぐ修正である。

残る 9 件は 3 つの塊になる。

**1. 推測を、推測と名乗らせる（planner）。** 語彙が似ているだけの 3 Issue が 3 wave に直列化し、
「依存しない」と**否定するために**書いた行が phantom 依存を作り、宣言した path が「長い方が正しい」で
落とされて**触るなと書いた生成物の方が scope に残っていた**（#182）。edge に `basis` を足し、語彙だけの
推論と shadow は **question** にした（推論そのものは消していない —— file を共有する組の順序付けは残る）。
著者が本文に書いた「**まだ決めていない**」も、```open-questions ブロックとして初めて機械に読まれる
（#178。実測では 3 件の未決を残したまま dispatch が通り、worker が自分で決めていた）。規則からは決して
出てこない**集約テスト**は `scope_companions.require` で宣言できるようになった（#181。ADR 第15.2節が
`derive` を緩めず兄弟 key にすることを既に裁定していた）。

**2. 契約と report が、測った事実を落とさない（dispatch）。** 禁止事項は goal に載る口が無く、worker
からは「許可されていない」ではなく**「存在しない」**ように見えていた（#176。実測: 禁止 3 件のうち
2 件しか転記されず、**全ゲート green のまま受入条件違反**。発見は人間のレビュー）。原文転記にし、
切ったら名乗る。`wait` の timeout は **worker の死と区別できず**、再 dispatch が完成済みの作業の上に
別 worker を重ねていた（#179）—— exit 124 の時点で生死を 1 回測って report へ転記する。
リポジトリの事情を書いた flag の置き場は、人間の記憶から profile になった（#180）。

**3. 合流後を見る / 待たない（merge・dispatch）。** file が重ならない**意味的衝突**は、合流後の状態を
誰も検証していなかった（#175。実測: develop に入った直後から赤で、発覚は次段 promotion PR の CI）——
opt-in の `--integration-verify` で **wave barrier が「統合ブランチも green」まで広がる**。非ASCII path が
PR 本文で「宣言外の変更」に化けていたのも直した（#174。裁定は正しく、壊れていたのは人間が読む本文だけ
だが、出る名前が正常系だったので誤読される）。そして wave の wall-clock「各 wave の最遅 worker の合計」を、
opt-in の `--schedule dag` で**最長経路**にした（#183。barrier が兼ねていた 3 つの安全装置には
それぞれ別の答えを出してある）。

**破壊的変更は無い。** `plan_schema_version` / `dispatch_schema_version` / `merge_schema_version` は
すべて据え置きで、`stop_reason` / `worker_state` / `completion_check[].id` の enum にも値を 1 つも
足していない。足した field（`dependencies[].basis` / `worker_liveness` / `integration_verify` /
`schedule` / `profile.dispatch_defaults`）は**すべて schema 上 optional** である —— したがって
0.27.0 以前が書いた plan / report は今も valid で、`status.mjs` は過去 run を読み続けられる。

**新 flag を使わない run の report は、`skill_version` の 1 行を除いて 0.27.0 と byte 一致する。**
`m22`（merge）と `d87`（dispatch）が、**その機能が入る前の runner が書いた** golden をそのまま置いて
byte 比較しており、「opt-in が opt-in である」ことはこの 2 件が測っている。`integration_verify` は
`--integration-verify` を渡した run に、`schedule` は `--schedule dag` の run に、`worker_liveness` は
wait が timeout した worker に、`dispatch_defaults` は profile が宣言した run にしか現れない。

**plan は変わりうる。** `dependencies[].basis` は planner が**必ず出す**ので、edge を持つ plan は 1 行
増える（`required` に入れていないので、`basis` を持たない過去の plan は valid のままである）。そして
本文が #177 / #178 / #182 の拾う形を持っていれば `suspected_files` / `reference_files` / `questions` は
当然変わる —— **それがこのリリースである。** その形を持たない本文の plan は 1 byte も動かない
（`31` / `45` / `61` の全文 golden が、本リリースで `skill_version` の 1 行しか差分を持たないことで
測られている）。

**新たに止まりうるのは 3 つ**である。`--allow-questions` 無しの run で `open_question_declared`（#178）/
`ambiguous_file_candidate`・`unconfirmed_lexical_dependency`（#182）が立った場合と、
`harness_path_in_scope` で `partial` に落ちる場合（#177）—— いずれも 0.27.0 までなら**推測が推測のまま
dispatch されていた**ケースであり、止まる方が正しい。`--schedule dag` は opt-in だが、採ると同じ
`--max-parallel` でも実効並列度が上がる。Kewton/CommandMate#1771（ゲートのリソース直列化）が OPEN の
うちは、**検証ゲートが資源を共有するリポジトリで偽赤が増えうる** —— 直せないので宣言してある。

同梱の **cmate-worker-development も 0.2.0** に上がる（#176）。契約が言及していない禁止事項は許可では
なく **Issue 本文が正本**であること、狭める方向（禁止）は本文も効き広げる方向（権限・対象 file）は
契約が正本であること、そして A 段で本文全文を読み取り専用で取得することを必須手順にした。

### 0.27.0 — 無言で消える情報を潰した（#160 / #161 / #162 / #163 / #164 / #165 / #170 / #171）

**契約経路の pass が、根拠を名指しできるようになった。** `wait --verify` の `GATE` 行は
**stderr** に出るのに runner は stdout しか読んでおらず、`verification.gates` は契約経路の pass で
**常に空**だった（#160）。#142 が `verification_gates_unrecorded` を `--unattended` で blocking に
昇格させていたため、**無人運転の段階 C は全ゲート pass でも必ず停止していた** —— 0.26.0 まで、
段階 C は実物の CommandMate で 1 度も成功していない。**0.27.0 で初めて成立する。**

残る 7 件は同じ形の欠陥である: **宣言された、または測定された情報が、どこにも記録されずに
消えていた。**

- **宣言した対象ファイルが契約から消える**（#161 / #162）。件数上限 200 の切り詰めと形チェックの
  per-item drop。worker は Issue が明記したファイルを編集して scope ゲートで落ち、
  send 時 snapshot なので**回復手段が無い**。pre-flight で `contract_scope_dropped` を blocking に
  した。
- **表示の都合が run を止めるかどうかを決めていた**（#164）。scope 違反の 20 行打ち切りが L4 の
  比較集合を汚し、前進中の worker を `scope_unsatisfiable` で止めうる。判定は全行、表示は上限、
  切ったら名乗る、に分けた。
- **「人が閉じるべき残件」が 8 件で黙って切れていた**（#163）。種別ごとに 1 枠を確保し、
  切った件数と内訳を注記する。
- **gate リスト・setup 失敗理由・再転記の切り捨てが無言だった**（#165 / #171）。特に #171 は
  **切り捨ての注記そのものが切り捨てられる**経路である。
- **誤った復旧手順が run 出力に残っていた**（#170）。#83 は本症状を「GATE 行を出さない CLI が
  在る」と誤診しており、その復旧手順（「GATE 行を出す CommandMate で再実行する」）が
  dispatch サマリの next 行と ADR 第17.3節に残っていた。**この原因では何度再実行しても解決しない。**

**上限値は 1 つも変えていない。** 変えたのは、引かれた事実が残るかどうかだけである。
[plan-contract.md](./plan-contract.md) 第5.1節の「足した分は必ず可視である」に対して、
**「引いた分も必ず可視である」**を対の規範として明文化した。

破壊的変更は無い。report の schema も enum も増えていない。`--unattended` を使っている run では
`contract_scope_dropped` で**新たに止まりうる** —— ただしそれは 0.26.0 までなら黙って権限が
狭まったまま dispatch されていたケースであり、止まる方が正しい。

### 0.26.0 — `run_id` が plan を一意に指すようになった（#157）

`run_id` の入力集合に **解決後の profile が丸ごと**入った。
`baseline` / `branch_template` / `worktree_template` / `verified` / `scope_companions` を
編集すれば、既定 `run_id` は変わる。`run_exists` のメッセージも、
**runner が主張できないことを主張しない**形に直した。

`run_id` が plan を一意に指さない性質は #149 の実装中に見つかり、
`adr-scope-derivation.md` 第15.7節に「profile 全体としてまとめて裁定すること」と
記録されていた。本リリースはその裁定である。

### 0.25.0 — scope 導出の4層が揃った（#149）

段4（L2・profile の `scope_companions`）が入り、
[adr-scope-derivation.md](./adr-scope-derivation.md) の **L1 / L2 / L3 / L4 が揃った**。

| 層 | 何をするか | 版 |
|---|---|---|
| L1 | 宣言されたソースから慣習的なテスト path を導出（設定不要） | 0.23.0（#147） |
| L2 | **repo 固有の規約を profile に宣言**（本リリース） | 0.25.0（#149） |
| L3 | 埋まらない残余を dispatch 前に question で止める | 0.24.0（#145） |
| L4 | 収束しない scope 再指示の遮断 | 0.23.0（#148） |

`suspected_files`（推測）を `scope.allow`（認可境界）へ無変換で昇格していた根本原因は、
**`allow = declared ∪ companions(declared)`** という裁定 0 で閉じた。
**4段すべてが CommandMate を1バイトも変えずに実装されている。**

### 0.24.0 — scope 導出の段3（#145）

段1（#147）が届かない残余 —— **planner が知らないテスト配置の repo** —— を、
**dispatch の前に人間へ返す**ようになった。`acceptance_requires_tests_but_scope_has_none` は
warning と open question の両方に載り、dispatch の pre-flight が `--out` を作る前に停止する。

これで [adr-scope-derivation.md](./adr-scope-derivation.md) の4層のうち **L1 / L3 / L4 が揃った**。
残るは L2（#149・profile の `scope_companions`）である。**CommandMate は引き続き1バイトも変わっていない。**

### 0.23.0 — scope は「推測」から「宣言の閉包」へ（#147 / #148）

**同型の障害が3回出たので、クラスとして裁定した**（[adr-scope-derivation.md](./adr-scope-derivation.md)）。
根本原因は `suspected_files`（推測）を `scope.allow`（認可境界）へ**無変換で昇格**していたことである。

裁定 0 は `allow = declared ∪ companions(declared)` ——
**宣言は Issue のものに保ったまま、認可境界だけを閉包へ広げる。**
段1（#147・planner がテスト伴走を導出）と段2（#148・収束しない再指示の遮断）が入った。
段3（#145・残余の検出）と段4（#149・profile の repo 規約宣言）は後続である。

**CommandMate は1バイトも変わっていない** —— 契約 schema を分けない裁定（ADR 第4節）により、
全段が skill 側で完結する。

### 0.22.0 — 無人運転の段階 C（#142）

`--unattended` が dispatch / merge 両 phase / uat の**すべてに到達**した。
段階 A（#122）→ B（#134）→ C（#142）の3段が揃い、宣言の意味が invocation のどこでも同一になった。
中心は uat の cwd pre-flight である —— 再merge の `git merge --no-ff` は cwd 引数を持たないので、
fix は invocation cwd の branch に入る。**fix worktree を1つも作る前に**それを拒否する。

### 0.21.0 — パレット復帰・無人運転の段階 B・`--auto-yes` の実効化（#134 / #135 / #136）

**0.20.0 はパレットに出なかった。** `SKILL.md` が 71,383 bytes となり CommandMate の
64KB 上限を超えて、ローダーが黙って読み飛ばしていた（#135）。0.14.0 の方針へ戻して
`references/` へ移送し、`validate.py` に**リリース前に止まるサイズガード**を足した。

無人運転は段階 B（`merge --create-prs`）まで来た（#134）。`--auto-yes` は
**指定しても効いていなかった**ものが実際に効くようになった（#136）。

### #135 — SKILL.md が 64KB を超え、スラッシュコマンドパレットから消えた

**インストールは正常なのに、`/cmate-orchestrate` が補完に出なくなった。** CommandMate の
skills API は 0.20.0 を「インストール済み」と認識し、ディスク上にも `.claude/skills/` と
`.agents/skills/` の両方に実体があり、エージェントは `SKILL.md` を直接読むので手で打てば動く。
**落としていたのはパレットのローダーだけ**である —— `parseSkillFile()` は読む前に `stat` し、
`MAX_SKILL_FILE_SIZE_BYTES`（65536）を超えると `logger.warn` を1行書いて `return null` する。
利用者から見ると**理由もなく消える**。

版ごとの `SKILL.md`: 0.16.0=23,213 → 0.17.0=24,155 → 0.18.0=48,178 → 0.19.0=50,632 →
**0.20.0=71,383**。#128（`--worker-method`）・#122（unattended 段階A）・#121（`--reverify`）を
すべて SKILL.md へ書き足した結果で、**0.20.0 で初めて上限を越えた**。インストール済み12件のうち
次に大きいのは 22,825 bytes（`cmate-task-contract`）で、この package だけが突出していた。

対処は**方針へ戻すこと**である。0.14.0（下記）は SKILL.md を「いつ使うか / 呼び出し方と順序 /
出力の読み方 / 停止時に人間が何をするか」の4点に絞り、機構の詳細を正本への一方向参照に変えた。
0.20.0 はそこから外れて肥大した。**移送先を2つ新設し、内容は1文字も削らずに移した**:

- [runner-operations.md](./runner-operations.md) — ランチャー表記・worktree の前提・条件付き依存の
  Skill・dispatch の各 flag（`--prepare-worktrees` / `--worker-method` / `acceptance-gates` /
  `--resume` / `--reverify` / `--contract-mode` / `--unattended` / monitor 境界）・PR 本文・
  profile-init の3点・status の表示規則
- [codes-and-recovery.md](./codes-and-recovery.md) — plan の失敗 code / warning code /
  limitation code の全一覧と、**停止したときの対処表の正本**、無人 run の取り消し手順

SKILL.md は 71,383 → 約 37,000 bytes になり、4点だけを述べて上の2つへ一方向に参照する。
`references` と `schemas` の内容は削っていない（0.14.0 と同じ約束である）。

**再発は `scripts/validate.py` が止める。** 全 package の `SKILL.md` に **60,000 bytes** の上限を
置き、超えたら hard fail する（`SKILLS_SKILL_MD_TOO_LARGE`。エラーは「`references/` へ移送せよ」と
次の行動を名指しする）。閾値を上流の 65536 の生値にしないのは、`MAX_SKILL_FILE_SIZE_BYTES` が
上流の実装詳細だからで、**触れる前に止める**のが安全である。置き場所は #92（`SKILL_VERSION` の
一致）と同じ —— `.commandmate/verify.yaml` の宣言ゲートかつ CI の両ジョブで走るので、
**公開前に必ず通る**。今回は公開してから発覚した。validate.py で落ちていれば公開前に止まった。

なお `acceptance-gates` ブロックを説明する行が ` ```acceptance-gates ` で始まっていたため、
そこから merge 節の直前までが**コードブロックとして描画されていた**。移送のついでに直してある。

### 0.20.0 — 方法を渡す口・無人運転・送らない再裁定（#121 / #122 / #128）

ワーカーへ **HOW（開発の方法）を渡す口**が入った（#128）。方法論の正本は別 package
`cmate-worker-development` にあり、dispatch は `--worker-method` でそれを名指しするだけである。

無人運転は段階A が入った（#122）。**`--unattended` が含意するのは締め付けだけ**で、
どのゲートも無効化せず `--approve` も含意しない。#115 の実測が ADR を4点訂正しており、
その訂正どおりに実装してある —— **`gh` にコードの停止は足していない**（前提が逆だった。
必要なのは `GIT_TERMINAL_PROMPT=0` という job 定義側の環境変数である）。

`--reverify` で **送らずに裁定を更新できる**ようになり、#89 が報告した「timeout で凍結された
裁定のせいで検証済み成果物が納品経路から外れる」は、回復経路つきで閉じた（#121）。

### 0.19.0 — 受入条件の機械ゲート化と、無人運転の前提の訂正（#103 / #114 / #115 / #118）

Issue の受入条件を契約へ運ぶ経路が入った（#114）。plan は v2 になり、古い dispatch が
新しい plan を拒否するようになった（#118）—— ゲートが黙って捨てられる窓を、
**新 planner を持つ版が世に出る前に**塞いである。

無人運転（#115）とワーカー側の開発スキル（#103）は ADR まで。#115 の実測は ADR の記述を
4点訂正しており、実装 Issue は**訂正後の第14節を正本として書くこと**。

### 0.18.0 — 一気通貫化の第一陣（#90 / #91 / #92 / #93 / #94 / #95 / #97 / #98 / #99 / #100）

worktree の継ぎ目（#90 / #91 / #93）、profile の調達（#94）、証拠の提出（#97）、監督の可視化
（#99）、部分失敗からの再開（#98）、版の一致（#92）を入れ、無人運転（#95）と受入条件の機械
ゲート化（#100）は ADR まで進めた。runner は 4 phase ＋ read-only view（`status.mjs`）＋
準備 runner（`profile-init.mjs`）の構成になった。

`scripts/lib.mjs` の `SKILL_VERSION` が 0.13.0 のまま 0.15.0 / 0.16.0 / 0.17.0 が公開され、
report の `skill_version` が install した版と食い違っていた（#92）。`scripts/validate.py` に
manifest との一致チェックを足したので、以後の bump 漏れは CI が止める。

### 0.14.0 — SKILL.md の再構成と `scripts/lib.mjs` の追加

SKILL.md がスクリプト内部のアルゴリズムを逐条解説し、`references/*.md` が正本として同じ内容を
再述し、`schemas/*.json` がまた符号化する三重記述になっていた。SKILL.md を「いつ使うか /
呼び出し方と順序 / 出力の読み方 / 停止時に人間が何をするか」の4点に絞り、機構の詳細は正本への
一方向参照に変え、経緯（この文書）を切り出した。**references と schemas の内容は削っていない。**

あわせて、4 runner に重複していたヘルパーのうち **byte 単位で同一だったものだけ** を
`scripts/lib.mjs` に集約した。同名でも実装が違うもの（`parseCli` / `renderSummary` / `excerpt` /
`bullets` / `runCli` / `validatePlan` / `positiveInt` / `preflight` / `eligibleIssues` / `halt`）は
統合していない。理由は `scripts/lib.mjs` の冒頭に、差分の内容ごと記録してある。
