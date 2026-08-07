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

## merge（`scripts/merge.mjs`）

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

## パッケージ

### 0.14.0 — SKILL.md の再構成と `scripts/lib.mjs` の追加

SKILL.md がスクリプト内部のアルゴリズムを逐条解説し、`references/*.md` が正本として同じ内容を
再述し、`schemas/*.json` がまた符号化する三重記述になっていた。SKILL.md を「いつ使うか /
呼び出し方と順序 / 出力の読み方 / 停止時に人間が何をするか」の4点に絞り、機構の詳細は正本への
一方向参照に変え、経緯（この文書）を切り出した。**references と schemas の内容は削っていない。**

あわせて、4 runner に重複していたヘルパーのうち **byte 単位で同一だったものだけ** を
`scripts/lib.mjs` に集約した。同名でも実装が違うもの（`parseCli` / `renderSummary` / `excerpt` /
`bullets` / `runCli` / `validatePlan` / `positiveInt` / `preflight` / `eligibleIssues` / `halt`）は
統合していない。理由は `scripts/lib.mjs` の冒頭に、差分の内容ごと記録してある。
