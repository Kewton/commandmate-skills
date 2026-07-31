# cmate-orchestrate-monitor の回帰テスト

`skills/cmate-orchestrate-monitor/scripts/` の判定コアを、**実機採取の
`commandmate capture --json` payload** に対して検証する一式である。
worker にも tmux にも network にも触れない（launcher と tmux は shim に差し替える）。

```
fixtures/*.json      capture --json の生 payload（ANSI エスケープを含む）
fixtures/scope-*.txt verify-scope 用の入力
run_tests.sh         テスト harness（bash + git + POSIX ツールのみ）
```

## 実行

```bash
bash tests/fixtures/cmate-orchestrate-monitor/run_tests.sh
```

依存が無く、いつ実行しても同じ結果になる。**終了コードで判定すること**
（出力を grep して合否を決めない。これはこの Skill 自身が `quality-gate.sh` で
禁じている失敗モードである）。

`.github/workflows/validate.yml` は package の schema・digest・再現性を見るもので、
この harness は含まれない。script を変更したときは手で回す。

## なぜ fixture が生 payload なのか

このレシピの唯一の致命的な失敗モードは **fixture の不忠実さ**である。
初版は ANSI を除去済みの手書き fixture を持っていたため、単体テストは全 green のまま
実運用では 1 度もアンカーが発火せず、全 worker が IDLE と誤分類された
（`Kewton/CommandMate#1522`）。

したがって `run_tests.sh` は fixture 自体も検査する。

- `live-*.json` は JSON エスケープされた ANSI（`\u001b[...m`）を保持していること
- top-level key が 2 space indent であること（`capture --json` の出力形）
- session ID・checkout path が sanitize されていること
- トークンカウンタが **ANSI で分断されたまま**であること
  （＝ naive な `↓ [0-9]` grep では依然としてマッチしないこと）

ANSI を剥がした fixture を持ち込むと、この検査が落ちる。

## fixture 一覧

| fixture | 何を固定するか |
|---|---|
| `not-running.json` | セッション不在 → `NOT_RUNNING` |
| `generating-token-anchor.json` | トークンカウンタ → `GENERATING` |
| `generating-bg-agent.json` | `isGenerating:false` でも background agent 待ちは `GENERATING` |
| `idle-brewed-summary.json` | 完了後の集計行（`Brewed for 8m 55s`）を生成中と読まない |
| `prompt-yes-no.json` | 承認プロンプト → `PROMPT` |
| `prompt-submit-answers.json` | `isPromptWaiting:false` でも `❯ 1. Submit answers` は `PROMPT` |
| `rate-limit.json` | usage limit バナー → `RATE_LIMIT` |
| `live-generating-token.json` | ANSI 分断されたカウンタでも `GENERATING`（回帰 3） |
| `live-generating-pre-token.json` | 初トークン前でも `esc to interrupt` で `GENERATING`（回帰 4） |
| `live-retrying-529.json` | CLI 自身の backoff は `GENERATING`。介入しない（回帰 5） |
| `live-api-error-exhausted.json` | 枯渇後は `IDLE`。再送経路へ到達できる（回帰 6） |
| `live-generating-task-text-scrollback.json` | scrollback の作業指示文に誤マッチしない（回帰 7） |
| `live-generating-rate-limit-source.json` | 生成中フレームのバナー風文字列に反応しない（回帰 7） |
| `live-idle-rate-limit-source.json` | idle ペインの `rate_limit` 識別子は `RATE_LIMIT` ではない（回帰 7） |
| `live-idle.json` | 健全な idle |
| `scope-clean.txt` | 禁止パターンがコメント・散文にあるだけなら `CLEAN`（回帰 2） |
| `scope-violation.txt` | 実 invocation は `VIOLATIONS:1` |

## harness が見るもの

1. **構文** — 同梱 script すべてに `bash -n`。
2. **分類** — 上表の 15 payload に対する `classify-state.sh` の出力。
3. **fixture 忠実性** — 前節の 4 点。
4. **完了判定** — `verify-completion.sh` の STARTED ガード（未起動・作業ゼロ・
   閾値未満・生成中の 6 通り）と、**一次ソースであるタスク状態**（次節）。
5. **ガードの偽陽性** — `verify-scope.sh`、`quality-gate.sh`（緑に見える出力＋非 0 終了）。
6. **ループ** — `monitor.sh` を fake launcher と fake tmux で回す。
   - 既定 stdout が **byte 一致で不変**であること（`--verbose` は追加しかしない）
   - `--verbose` が 1 ポーリング 1 行を出し、状態分布が機械集計できること
   - **スタブのままでは COMPLETE に到達しないこと**（対照）と、
     `--hooks` / `MONITOR_HOOKS` を与えると到達すること（回帰 8）
   - hooks file が無いときに黙ってスタブへ落ちず exit 2 で失敗すること
   - 介入が起きる条件と起きない条件（backoff 中・健全なペインには 1 度も送らない）
7. **参照フック** — 実 git worktree を作り、`hooks-git.sh` が commit 数と
   未 commit 数を実測どおり返すこと、解決できない id で 0 を返すこと、
   base ref が解決できないときに警告すること、そしてループを COMPLETE まで駆動すること。

## タスク状態を一次ソースにする経路（Issue #1589）

受入条件の 6 ケース（task 状態 5 パターン ＋ task 不在フォールバック）は
`verify-completion task state as the primary source` セクションに `1/6`〜`6/6` の名前で並ぶ。

終局状態（`succeeded` / `failed` / `not_started`）のケースは、**ヒューリスティクス単独なら
別の判定になる入力**を与えてある。そうしないと「フォールバックがたまたま同じ答えを出した」
だけで green になり、一次ソースが効いていることを何も示さない。

非終局状態（`running` / `verifying`）は **短絡させずフォールバックへ落とす**のが仕様なので、
両側（閾値未満 → `WORKING` ／ 閾値到達 → ヒューリスティクスの答え）を固定してある。
`running -> WORKING` の短絡を入れると STARTED ガードが盲目になるため、その短絡で赤くなる
テストを別に置いてある。

台帳の読み出し（`hooks-task.sh`）は CLI を shim に差し替えて検証する。
実測した出力形（TSV の第 2 列が status、新しい順）と、3 通りの答え
（status / 空＝契約なし / `unavailable`＝引けない）を固定する。

ループ側は fake launcher の `task` サブコマンドを `LOOP_TASK_OUT`（stdout の file）と
`LOOP_TASK_EXIT`（終了コード）で制御する。`capture` の fixture 列とは独立に答えるので、
`hooks-task.sh` を配線してもポーリング順序は変わらない。

## 変異による健全性確認

この harness は「通ること」ではなく「壊れたら赤くなること」で価値が決まる。
次の変異でそれぞれ赤くなることを確認してある（`#1589` 分は 2026-07-31 実測、
それぞれ **suite exit 1**）。

| 変異 | 落ちるテスト |
|---|---|
| `ml_has_rate_limit` に裸の `rate.?limit` を戻す | `live-idle-rate-limit-source.json -> IDLE` |
| `hooks-git.sh` の `count_commits` を 0 固定にする | 参照フックの実測値、および COMPLETE 到達の end-to-end |
| `succeeded -> COMPLETE` の分岐を削る | `1/6` ＋ ループ 3 件（計 4） |
| `failed` を COMPLETE 扱いにする | `2/6` ＋ ループ 3 件（計 4） |
| `not_started -> NOT_STARTED` の分岐を削る | `3/6`（1 件） |
| `running`/`verifying` を `WORKING` へ短絡させる | `4/6` 2 件 ＋ `5/6`（計 3） |
| タスク状態をペイン生存 veto より **前** に評価する | 古い裁定の veto 3 件 |
| STARTED ガードを無効化する | `6/6 the STARTED guard still holds`（1 件） |
| `hooks-task.sh` を `\| head` にして exit code を失わせる | `unavailable` 3 件 ＋ バージョンゲート 4 件（計 7） |
| `unavailable` を空文字へ潰す | 同上（計 7） |
| `FALLBACK MODE` の宣言行を消す | バージョンゲート 4 件 |
| `monitor.sh` が `--task-status` を渡すのをやめる | ループ 6 件 |
| ループの `VERIFY_FAILED` 分岐を消す | `failed` の終局化 2 件 |

script を変更したら、**まず変異を入れて赤くなることを確かめてから**直すこと。
