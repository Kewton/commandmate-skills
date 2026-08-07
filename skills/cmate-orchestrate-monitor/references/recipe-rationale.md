# 監視レシピの根拠（どの失敗から学んだか）

各ルールは実運用の失敗に紐づく。カッコ内は公開 Issue（`Kewton/CommandMate`）である。
**ここを読まずにアンカーや判定順を「整理」しないこと。** どれも、もっともらしい単純化が
実機で誤報を生んだ結果として今の形になっている。

---

## 状態検知（`classify-state.sh` / `monitor-lib.sh`）

1. **主シグナルは `commandmate capture <id> --json`**。参照 field は `content` /
   `realtimeSnippet`。`output` / `text` は **存在しない**。

2. **アンカー照合は ANSI 除去後に行う**。実 TUI は矢印と数値の間に色リセットを挟む:
   `(4m 25s · ↓\u001b[39m \u001b[38;5;246m14.9k tokens`（`\u001b` は生 JSON 中の 6 文字）。
   → 生 JSON への `↓ [0-9]` grep は **実機で一度も発火しない**。
   初版は ANSI を除去済みの手書き fixture を持っていたため単体テストだけが緑で、
   実運用では **全 worker が IDLE 誤分類**され `NOT_STARTED` を鳴らし続けた（#1522 / 回帰 3）。
   TUI がマーカーと値の間に挟むノーブレークスペース（`❯` の直後）も同じ理由で正規化する。

3. **アンカーは「いま画面に出ているもの」＝ `realtimeSnippet` に限定する**。
   `content` は *lastCapturedLine 以降の差分*なので、ループの初回ポーリングは **バッファ全体**、
   つまり orchestrator が送ったタスク指示文まで返す。その指示文に識別子 `ml_has_rate_limit` が
   含まれていたため当時の裸の `rate.?limit` が一致し、**健全な生成中 worker 2 件に `a` が撃ち込まれた**
   （#1522 / 回帰 7）。逆向きの事故も同時に防ぐ: 履歴に流れた spinner 行（`↓ 14.9k tokens`）を拾うと
   終了済みセッションを永久に GENERATING と誤判定する。

4. **生成中アンカーは 3 つ**: トークンカウンタ `↓ 14.9k tokens` /
   `Waiting for [0-9]+ background agent` / フッタヒント `esc to interrupt`。
   - `esc to interrupt` は **ターン実行中のみ**表示される（idle 時は `? for shortcuts`）。
     トークン出力前に数分思考する worker を拾うための唯一の手段（回帰 4）。
   - `[0-9]+m [0-9]+s` は **使わない**: 完了後の集計行（`✻ Brewed for 8m 55s`）に誤マッチし、
     終了済みセッションを永久に「生成中」と誤判定する。
   - **`isGenerating` field に依存しない**: これは狭い条件でしか true にならず、生成中でも
     false になりうる。だから text アンカーを一次シグナルにする。

5. **CLI 自身のリトライ中は「生存」＝ GENERATING**。
   `✻ 529 Overloaded · Retrying in 4s · attempt 7/10` の間セッションは生きているので、
   介入は **再開ではなく queue** される（実測: `❯ a` が composer に残り
   `Press up to edit queued messages`。リトライ成功後に配信され、worker が契約外の作業を始めうる）。
   `RATE_LIMIT` 分岐より **前**に評価する（回帰 5）。
   - `attempt 10/10` は枯渇後も画面に残るため、**idle フッタ（`? for shortcuts`）を veto** に使う。
     これが無いと死んだセッションが永久に「生存」と読まれ、再送経路に到達できない。

6. **`RATE_LIMIT` は生成中を否定してから最後に評価し、アンカーはバナー固有の言い回しに限定する**。
   本物の usage limit は **ターンを停止させる**ので、`esc to interrupt` が出ているフレームの
   バナー風文字列は、定義上 worker が読み書きしているコード・散文である。裸の `rate.?limit` は
   削除した: `rate_limit` / `rate-limit` を含むソースや散文に一致して **健全な worker へ入力を
   注入した**（#1522、回帰 7）。

7. **STARTED ガード**: 生成アンカーを一度も観測していない idle を COMPLETE と誤報しない。
   `commits=0 かつ uncommitted=0` は **完了ではなく未起動の兆候**である
   （`send` がタスクを composer に残し、Enter 未確定で worker が起動しない）。→ 回帰 1。

8. **選択・回答プロンプトの停滞**: `❯ 1. Submit answers` は製品の prompt 検出
   （`isPromptWaiting`）に **非マッチ**。text marker `❯ [0-9]+\.` で PROMPT と判定する。
   **`PROMPT` は `GENERATING` より先に評価する**: 権限プロンプト表示中もフッタは
   `esc to interrupt` のままで `isPromptWaiting` / `isSelectionListActive` は false（実測）。
   逆順だとプロンプトが永久に承認されない。

## 介入・自動復旧（`monitor.sh`）

9. **権限プロンプト自動承認**: worker 停滞の主因は権限プロンプトである。Enter 自動承認を
   **サイレント＋カウンタ化**し、通知を氾濫させない。承認は commit 必須ゲート（＝完了検証）と
   セットで扱う。

9b. **ただし Enter は「分類できたから送る」ものではない**（Issue #59）。Enter は tmux ペインへ
    直接入るので **サーバの承認制御を通らない**。0.4.0 まではこれを無条件に送っていて、
    (a) 契約が `autoYes.mode: off` / `denyPatterns` で保留させたプロンプトを黙って再承認し、
    (b) multiple_choice では「はい」ではなく**デフォルト選択肢の確定**を送っていた
    （CommandMate #1547 / #1684 / #1699 / #1681）。
    条件は **deny 側ではなく allow 側**に置いた: そのフレームの `promptData` が
    「default 選択肢が肯定である二択」を示したときだけ送り、それ以外は保留して報告する。
    deny 側（「multiple_choice なら送らない」）を採らなかったのは実測のためで、
    Claude Code の権限プロンプトも含め **測定した 30 フレーム全部が multiple_choice** だった
    （evidence.md 第1e節）。型で切ると実運用の承認が 100% 止まる。
    保留は **1 プロンプト 1 行**しか出さない。ここを毎ポーリングにすると、
    20 秒間隔のログでは「止まっている」という 1 つの事実が数十行になり、
    9 でサイレントにした理由がそのまま再現する。
    契約付き dispatch を監督するときは、実装ガードに頼らず `--no-auto-approve` を使う
    （保留の記録はセッションの Auto-Yes が有効なときしか作られない。evidence.md 第1e節）。

10. **rate limit は待たず即 `a` 送信**で再開する。ただし **撃つ前に GENERATING を否定する**
    こと（上記 6）。

11. **リトライ枯渇死からは再送で復帰する**（`--resend-message` / `--max-resends`）。
    `attempt 10/10` 失敗後は idle プロンプトに落ち、誰も再送しないので放置される。
    放置より悪いのは、作業途中の uncommitted 変更が残った状態で idle streak が閾値を超え
    **COMPLETE と誤報**されることなので、完了判定より前に再送する。入力を注入する分岐なので
    条件は最小に絞る（#1522）:
    - `IDLE` のみ（＝リトライ中 `GENERATING` とプロンプトには絶対に触らない）
    - idle 閾値に到達済み（一瞬のフレームでは撃たない）
    - terminal API error の検出は **現在のペインのみ**を見る（再開後に画面外へ流れたエラーは対象外）
    - `--max-resends` で打ち切り、以後はオペレータへエスカレーション

12. **完了待機に `wait` を使うなら `--on-prompt human`**。既定は prompt 検出で即返るため、
    監督ループが空回りする。

## 完了検証（`verify-completion.sh` / `verify-scope.sh`）

12b. **文字列解析は一次ソースではない**（Epic #1539 設計原則 4、Issue #1589 / CommandMate #1581）。
    capture の正規表現解析が答えられるのは「worker が止まったか」だけで、
    「成果が受入条件を満たしたか」ではない。この 2 つを同じシグナルで表していたことが、
    **半端な作業のまま COMPLETE と報告する**という誤報の構造的な原因だった。
    CommandMate にタスク状態機械（#1548）が入って以降、契約付き委任では
    **サーバが検証ゲートを回した後に書いた裁定**を読める。よって:
    - 一次ソース = タスク状態（`succeeded` / `failed` / `cancelled` / `not_started`）。
    - フォールバック = 従来の capture ヒューリスティクス。**削除しない**。契約なし委任と、
      task 台帳を持たない CommandMate（実測 2026-07-31: **公開版はまだ全部これ**）では
      これが唯一の判定材料であり、13〜15 と STARTED ガードはそのまま生きている。
    - `failed` は `COMPLETE` ではなく `VERIFY_FAILED` にする。同じ「終局」でも
      **マージ可否が逆**なので、オペレータがログを流し読みして取り違えられる名前にしない。

12c. **一次ソースを足しても、順序で守るものが 2 つある**:
    - **ペイン生存 veto をタスク状態より前に置く**。最新タスクが `succeeded` でもペインが
      生成中なら、その裁定は前回 send のものである。順序を入れ替えると、次のターンを
      走らせている worker を「完了」と報告して監視を打ち切る。
    - **非終局状態（`pending` / `running` / `waiting_input` / `verifying`）は短絡させない**。
      フォールバックへ落とすことで STARTED ガードが効き続ける。台帳が `running` でも
      Enter が composer に落ちていない事故は起こりうる（回帰 1 と同じ失敗）。
      `running -> WORKING` と短絡させると、この唯一の検出手段が盲目になる。

12d. **一次ソースが使えないことは、黙って劣化させず宣言する**（バージョンゲート）。
    `hooks-task.sh` を配線したのに台帳を引けなかったら、worker ごとに 1 度
    `FALLBACK MODE` 行を出してから capture ヒューリスティクスで走る。宣言しないと、
    ログには**もっともらしい COMPLETE 行だけ**が並び、それが推定であったことを示すものが
    何も残らない。逆に、そもそもフックを配線していない実行（契約なし委任）では
    何も約束していないので、この行は出さない。
    実測上の注意: `commandmate task --help` は probe にならない（`task` コマンドが無い
    0.10.2 でも root help を出して exit 0）。実サブコマンドの終了コードだけが判別材料である。

13. **merge 成否は state を確認してから Issue を close する**（未マージ Issue の誤クローズ防止）。

14. **スコープ充足は受入ゲートではなく grep 実数で検証する**。NUL 混入 file で grep が
    バイナリ扱いするため `grep -a` を使う。

15. **検証ガード自身の偽陽性に注意**（回帰 2、`verify-scope.sh`）:
    - 禁止パターンが **散文・コメント中**に出現しただけで違反と数える誤報（bare `npx commandmate` が
      「なぜ `@latest` が必要か」を説明する文に一致した実例）。→ コメント行を除外する。
    - `grep -c … || echo 0` は無マッチ時に二行を作り、後続の数値比較を壊す。
      → `grep -c` の出力をそのまま使う。
    - grep 実数で under-delivery を疑ったら **必ず該当行を目視してから**差し戻す。

## スクリプト品質（実装制約）

16. **bash 3.2 互換**（macOS 既定の `/bin/bash` は 3.2.57）: 連想配列 `declare -A` 不可・
    `mapfile` 不可・`${var,,}` 不可。状態は **整数 index の並列配列と temp file** で持つ。

17. **ループ変数に `path` 等の特殊名を使わない**: zsh/bash で `path` は `PATH` に tie され、
    curl / tmux が command not found 化して health check が偽陰性になる。

18. **品質ゲートで exit code を隠さない**（`quality-gate.sh`）: `cmd | grep …` は `$?` を
    grep に渡し、非 0 終了を隠す。テスト runner は「全テスト緑・Unhandled Rejection で exit 1」を
    出しうる。`cmd > log 2>&1; echo $?` で実測する。

19. **`sed` は `LC_ALL=C` で回す**: ペイン capture には途中で切れたマルチバイト文字が混じりうる。
    UTF-8 ロケールの BSD sed はそこで `illegal byte sequence` を吐いて停止する。

## 監視自身の可観測性（CommandMate #1728）

20. **id の突合は「サーバが今どう採番しているか」に合わせる**。worktree-id は
    `deriveWorktreeId()`（CommandMate #1621）＝ **checkout の directory 名**から採番され、
    初回登録時に一度だけ確定する。0.6.1 までの `hooks-git.sh` は**ブランチ名でしか突合して
    いなかった**ので、ディレクトリを Issue 番号で採番するリポジトリでは **1 件も**——
    **メイン worktree すら**——解決できず、両カウンタが恒久 0 になっていた。
    18（git の失敗を見る）とは別経路である: **git は成功し、突合が外れる**。
    最も重い影響は STARTED ガードの不活性化で、「未起動 idle を COMPLETE と誤報しない」という
    ガードが**誰も測っていない数字**で裁定していたことになる。
    → directory 由来（現行）を第 1 候補にし、branch 由来の旧 2 規則は後方互換として残す。
    directory 由来を先に見るのは、**両方が別 checkout に当たったとき、稼働中のサーバが配る
    id のほうを勝たせる**ためである（レコードの出力順に依存させない）。
    directory 名が衝突する 2 checkout は区別できないので、最初の 1 件を数えて `WARN` を出す。

21. **診断行はオペレータの grep を生き延びる形にする**。20 が 25 分間気付かれなかった直接の
    理由がこれである: 従来の診断は `monitor hooks: …` で始まり `ERROR` も `WARN` も含まなかった
    ため、運用で常用する `2>&1 | grep -Ei "STALL|IDLE|…|ERROR|FAIL"` で **1 行残らず消えていた**。
    「この 0 は測定値ではない」と言う唯一の行が、ログの中で最も消えやすい形をしていた。
    → レベル語を付ける。`ERROR` = 両カウンタとも測れていない（STARTED ガードが捏造された証拠を
    読んでいる）／`WARN` = 片方だけ劣化（もう片方は実測値なのでガードには本物の信号が残る）。

22. **監視は黙って死ぬ**。健全な監視も死んだ監視も**どちらも沈黙する**ので、ログだけでは
    区別できない（実際に exit 144・出力は起動行のみ・ワーカー 2 本は無監視で稼働継続、という
    事故が起きた）。→ 3 つを足す: (a) 受信シグナルの明示報告（HUP/INT/QUIT/PIPE/TERM は
    `128+n` で終了、**SIGURG は致死化せず** WARN のみ — 既定動作が無視だから）、
    (b) **正常終端以外の全終了**を EXIT trap から報告（個別に trap していない死に方でも出る）、
    (c) `--heartbeat`（既定 10 ポーリング）で `alive` 行。
    trap はループ直前に張る。引数検証で落ちる経路を従来と byte 一致に保つためである。
    なお 144 = 128+16 は macOS の SIGURG だが、`cmd | grep …` の `$?` は grep の終了コードでも
    あるため、**`monitor.sh` 自身が signal 16 で死んだとは断定していない**。再現条件は未特定で、
    次に起きたときに原因がログへ残るようにしただけである。

---

## 回帰一覧（red → green で固定したパターン）

| # | 誤報・実害 | 出所 | ガード |
|---|---|---|---|
| 1 | 未起動 idle を COMPLETE と誤報 | #1512 | `verify-completion.sh` の STARTED ガード |
| 2 | 検証ガード自身の偽陽性（散文一致・`\|\| echo 0`） | #1512 | `verify-scope.sh` のコメント除外＋素の `grep -c` |
| 3 | ANSI 除去済み手書き fixture が「製品が出力しない形」を検証し、生成中を全て IDLE 誤分類 | #1522 | ANSI 正規化＋生 capture fixture |
| 4 | トークン出力前の生成中を IDLE 誤分類 | #1522 | 生成中アンカーに `esc to interrupt` |
| 5 | CLI 自身の 5xx backoff を停止と誤認し、介入が queue される | #1522 | リトライ検出（idle フッタ veto つき）を最優先 |
| 6 | リトライ枯渇死が放置される／半端な作業で COMPLETE 誤報 | #1522 | terminal API error 検出 ＋ `monitor.sh` の再送 |
| 7 | `rate.?limit` が散文・ソースに一致し **健全な worker へ `a` を注入** | #1522 | バナー限定アンカー ＋ `RATE_LIMIT` を最後に評価 ＋ 現ペイン限定 |
| 8 | `count_commits` / `count_uncommitted` がスタブ固定で、**COMPLETE 分岐が実運用で一度も発火しない**（完走した worker まで NOT_STARTED と記録される） | #1533 | `--hooks` / `MONITOR_HOOKS` で供給、参照実装 `hooks-git.sh` を同梱 |
| 9 | 検証ゲート不合格（`failed`）の worker を「止まった＝完了」として COMPLETE と報告し、マージ候補に混ぜる | #1589 | 一次ソースをタスク状態へ切替、`failed` / `cancelled` は `VERIFY_FAILED` |
| 10 | 前回 send の `succeeded` が残った worktree で、生成中の worker を完了扱いして監視を打ち切る | #1589 | ペイン生存 veto をタスク状態より **前** に評価 |
| 11 | 台帳が `running` を記録しているが Enter が composer に落ちておらず、短絡すると STARTED ガードが盲目になる | #1589 | 非終局状態はフォールバックへ落とす（短絡しない） |
| 12 | 一次ソースを引けないまま推定で走り、ログ上は健全な COMPLETE に見える | #1589 | `unavailable` センチネル ＋ worker ごと 1 回の `FALLBACK MODE` 宣言 |
| 14 | **分類だけで Enter を送り、サーバの autoYes ポリシーを迂回する／multiple_choice のデフォルト選択肢を意図せず確定する** | #59 | `promptData` から承認可否を判定し、承認できない形は保留＋報告＋`held` 加算。`--no-auto-approve` で全件保留 |
| 15 | **id の突合がブランチ名だけで、現行のディレクトリ由来 id を 1 件も解決できない**（git は成功するので 13 のガードは発火しない。両カウンタが恒久 0 になり、**STARTED ガードが実測値でない数字で裁定する**） | CommandMate #1728 | `mh_worktree_path()` に `slug(basename(<path>))`（＝`deriveWorktreeId`）を第 1 候補として追加。ブランチ由来の旧 2 規則は残す |
| 16 | **警告が運用の grep で全て消える**（`monitor hooks: …` に `ERROR`/`WARN` が無く、`grep -Ei "…\|ERROR\|FAIL"` で不可視。15 が 25 分間気付かれなかった直接の理由） | CommandMate #1728 | 診断行に `ERROR`（両カウンタ死）/ `WARN`（片方）のレベル語を付与 |
| 17 | **監視が黙って死に、死んだことに気付けない**（exit 144・出力は起動行のみ・ワーカーは無監視で稼働継続。健全な沈黙と区別不能） | CommandMate #1728 | 受信シグナルの明示報告 ＋ 正常終端以外の EXIT 報告 ＋ `--heartbeat`（既定 10 ポーリング） |
| 13 | **外部コマンドの終了コードを見ずに次を決める**（`git \| wc -l` が git の失敗を「作業 0」として返し、完走 worker を NOT_STARTED と誤報／`classify-state.sh` が落ちると空 state が完了判定へ渡り、生存ペインとみなされず **稼働中の worker が COMPLETE**／`verify-completion.sh` が落ちると `case` に default が無く **そのポーリングが無言で素通り**） | CommandMate #1614 | `hooks-git.sh` の 3 つの `git` 呼び出しを終了コード判定＋原因ごと worker 1 回の stderr 報告に、`monitor.sh` の `CLASSIFY` / `VERIFY` を `capture`（既存）と同じ扱いに |

いずれも naive 実装で red → ガード実装で green にした。8 は両方向テスト（対照＋変異注入）で
固定してある: `--verbose` を既定 ON にする / フックをスタブより先に source する /
poll 行の書式を変える / 参照フックの commit 数を 0 固定にする、のいずれの変異でも
テストが赤くなることを確認済みである。9〜12 も同様に変異注入で実測済みで、内訳は
`tests/fixtures/cmate-orchestrate-monitor/README.md` の変異表にある。
13 は 7 変異で実測した（`classify` ガード削除で実際に
`poll 4 -> <空> … verdict=COMPLETE` が出ること、`git` 失敗と真の作業ゼロが別テストで赤くなること、
数え方を `wc -l` へ戻すと 1 件以上の計数が崩れることを含む）。
14 は 6 変異で実測した（無条件 Enter へ戻す / ポリシー判定を形の判定より後ろへ移す /
multiple_choice を一律保留にする / 保留報告を毎ポーリングにする / `held=` を常時出す /
`--no-auto-approve` を無視する）。
15〜17 は 8 変異で実測した（`hooks-git.sh`: basename 突合を削除 → **14 件 red** ／
突合順を branch 優先へ反転 → 2 件 red ／ レベル語を `monitor hooks:` へ戻す → 6 件 red ／
ディレクトリ名衝突の WARN を削除 → 3 件 red。`monitor.sh`: シグナル trap を全戻し → 9 件 red ／
heartbeat を毎ポーリング発火に → 6 件 red（うち 2 件は **既定 stdout を byte 単位で固定した
回帰 8 のテスト**で、既定 heartbeat が運用ストリームを汚していないことの対照でもある）／
EXIT 報告を正常終端でも出す → 3 件 red ／ SIGURG を致死 trap に → 4 件 red）。
**「監視が死んだ」を検知するテストは、監視が死んでも緑になりうる**ため、SIGURG のケースだけは
「SIGURG では死なず、後続の SIGTERM で死ぬ」ことを **exit code**（143 であって 144 でない）で
固定してある。同じ理由で、シグナル待ちには締切と PID 指定の SIGKILL を置いてある
（trap を全戻しした `monitor.sh` は**シグナルを受けても走り続ける**ので、締切が無ければ
テストは赤くならず**ハングする**）。

回帰 fixture と test runner は配布元リポジトリ
<https://github.com/Kewton/commandmate-skills> の
`tests/fixtures/cmate-orchestrate-monitor/` にある（package には含まれない）。

## fixture の作り方（実機採取）

fixture は **使い捨てセッションで capture** する。実 worker session は composer 残テキストで
汚染され流用できない。

```bash
commandmate capture <throwaway-id> --json > <name>.json
```

**手で書かないこと。ANSI を剥がさないこと。** これがこのレシピ唯一の致命的な失敗モードで、
初版は実際にこれを踏んだ（単体テスト全 green のまま、実運用では 1 度もアンカーが発火しなかった）。

- ステータス行・フッタ行・composer 行の ANSI エスケープと NBSP は **そのまま残す**。
  1 つ剥がすと fixture は「製品が出力しない形」になり、テストの意味が消える。
- 実 capture には作業指示文・絶対 path・セッション ID が載る。コミット前に無関係な本文だけを
  短いダミーへ置換する（ANSI を壊さないよう、値の文字列単位で差し替える）。
- 派生 fixture（実フレームの一部を差し替えて作った異常系）は、**何を差し替えたか**を書き残す。
