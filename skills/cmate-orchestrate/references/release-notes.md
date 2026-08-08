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

## merge（`scripts/merge.mjs`）

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

---

## uat（`scripts/uat.mjs`）

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
