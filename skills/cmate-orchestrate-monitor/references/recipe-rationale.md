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

いずれも naive 実装で red → ガード実装で green にした。8 は両方向テスト（対照＋変異注入）で
固定してある: `--verbose` を既定 ON にする / フックをスタブより先に source する /
poll 行の書式を変える / 参照フックの commit 数を 0 固定にする、のいずれの変異でも
テストが赤くなることを確認済みである。9〜12 も同様に変異注入で実測済みで、内訳は
`tests/fixtures/cmate-orchestrate-monitor/README.md` の変異表にある。

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
