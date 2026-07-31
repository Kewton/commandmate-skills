# 検証状況と限界

この Skill が「実運用で通用する」と言える範囲を、測定した事実だけで記録する。
**測っていないものは「未計測」と書く。** 推測で対応と書かない。

---

## 1. 実運用での監視実績

判定コア（`classify-state.sh` / `verify-completion.sh` / `monitor.sh` / `hooks-git.sh`）は、
2026-07-28〜29 の 2 運用で実際に worker を監督した。両運用とも
`--verbose --hooks hooks-git.sh --interval 20 --idle-threshold 8` の構成で、
完了フックは実 git（`git log <base>..HEAD` / `git status --porcelain`）に配線してある。

| | 運用 1 | 運用 2 | 合計 |
|---|---:|---:|---:|
| 監督した worker | 1 | 3（並列） | 4 |
| 総ポーリング数 | 77 | 294 | **371** |
| `GENERATING` | 65 | 253 | 318 |
| `IDLE` | 8 | 24 | 32 |
| `PROMPT` | 4 | 17 | 21 |
| `RATE_LIMIT` | 0 | 0 | 0 |
| `NOT_RUNNING` | 0 | 0 | 0 |
| capture 失敗 | 0 | 0 | 0 |
| 介入（プロンプト自動承認） | 4 | 17 | **21** |
| 介入（rate limit `a` 送信） | 0 | 0 | 0 |
| 介入（再送） | 0 | 0 | 0 |

運用 2 の worker 別内訳:

| worker | `GENERATING` | `IDLE` | `PROMPT` | `approvals` | 完了 poll |
|---|---:|---:|---:|---:|---:|
| A | 79 | 8 | 6 | 6 | 93 |
| B | 66 | 8 | 3 | 3 | 77 |
| C | 108 | 8 | 8 | 8 | 124 |

`approvals` が `PROMPT` ポーリング数と worker 単位で完全一致している。
つまり **介入は PROMPT 分類時にのみ発生し、それ以外では 1 件も入力を注入していない**。

### 完了判定が実際に評価されたことの証拠

全 worker が次の形の poll 行を経て COMPLETE に到達した。

```
poll 77 -> IDLE started=1 streak=8 commits=1 uncommitted=0 verdict=COMPLETE
```

`uncommitted` は運用中に `0→1→2→3→5`（運用 1）、`0→19→20` / `0→14→20→25`（運用 2）と推移し、
commit 時点で `commits=1 uncommitted=0` へ遷移している。スタブ（常に 0）では起こり得ない値であり、
`git log` / `git status` の実測とも一致した。**フックがスタブなら STARTED ガードにより
`NOT_STARTED` が出ていたはずで、COMPLETE が出たこと自体が実カウンタ評価の証拠である。**

### 誤報

| 分類 | 件数 | 根拠 |
|---|---:|---|
| (a) COMPLETE 誤報（未完了を完了と報告） | **0** | COMPLETE 時点の commit が実在し、品質ゲートと CI を通過して merge まで到達した |
| (b) 偽陽性介入（健全な worker への入力注入） | **0** | 介入は PROMPT 分類時のみ。生成中・CLI 自身の backoff 中への注入なし |
| (c) 見逃し（停滞の検知漏れ） | **0** | 停滞・rate limit・リトライ枯渇の発生なし |

**監視レシピ由来の誤報 0 件。** ただし運用 2 では、監視とは別に手動介入が 1 件あった:
dispatch 時のシェル展開の欠陥で、worker へ届いた指示文から file 名が落ちていた。
監視は正しく健全と分類しており誤報ではないが、**監視は「送られた指示の正しさ」を検知できない**
という限界の実例として記録する。

## 1b. タスク状態を一次ソースにする経路（0.2.0 で追加）

**この経路の実運用実績はまだ無い。** 上の 371 ポーリングはすべて capture ヒューリスティクス
（現在のフォールバック経路）で得たもので、0.2.0 の変更後もその経路は無修正のまま green である。

参照手段の選定は 2026-07-31 に実測した。

| 実測項目 | 結果 |
|---|---|
| `commandmate task list <wid> --limit 1`（tasks あり） | exit 0。TSV `id \t status \t agent \t gates \t title` を新しい順に出力 |
| 同 `--json` | **裸の JSON 配列**（`{tasks:[…]}` ではない）。key は `id, worktreeId, cliToolId, instanceId, title, goal, contractPath, contract, status, lastVerificationRunId, createdAt, updatedAt, startedAt, finishedAt` |
| 同（tasks 無し） | exit 0、stdout 空、stderr に `No tasks recorded for worktree '<wid>'.` |
| `commandmate task show <task-id> --json` | exit 0。top-level は `task` / `lastVerificationRun` の 2 key |
| `GET /api/worktrees/<wid>/tasks` | 200 `{"tasks":[…]}`。CLI はこの route の薄いクライアント |
| `GET /api/tasks/<task-id>` | 200 `{task, lastVerificationRun}` |
| 実在した `status` 値 | `succeeded` / `failed` / `not_started`（実行契約 3 件、L4 認定 Run A–C） |

**CLI を採った理由**: base URL（`CM_PORT`）と認証トークン（`--token` / `CM_AUTH_TOKEN`）の解決を
CLI が既に持っている。curl では両方を再実装し、トークンをプロセスリストへ晒すことになる。
`task show` ではなく `task list` なのは、監視ループが知っているのが worktree-id だけだからである。

**バージョンゲートが既定になる、という実測**:

| 対象 | `commandmate task` |
|---|---|
| homebrew 導入版 0.10.2 | **無し**（`error: unknown command 'task'`） |
| npm 公開最新 0.16.0（tarball 検査） | **無し**（`dist/cli/commands/task.js` が存在しない） |
| tag `v0.15.0` / `v0.16.0` | **無し**（`src/cli/commands/task.ts` が存在しない） |
| develop（#1566 以降） | 有り |

つまり **2026-07-31 時点の公開版 CommandMate では、この Skill は必ずフォールバックモードで走る。**
「タスク状態が一次ソース」は、task 台帳を含む CommandMate に対してのみ成立する主張である。

## 2. 測定の限界（この Skill について）

- **タスク状態経路は fixture / shim テストのみ**。実 worker を契約付きで委任し、
  `succeeded` / `failed` を実際に読んで監視を終わらせた実績は **未計測**である
  （公開版 CommandMate に `task` コマンドが無いため、リリース後にしか測れない）。
- **worker 側 CLI は Claude Code のみ**。同梱の生成中・idle・プロンプトのアンカーは
  その TUI から実際に採取した capture に基づく。他の coding CLI の TUI 文字列は **未計測**である。
- **rate limit・リトライ枯渇の実地発火は 0 回**。この 2 経路は fixture（実機採取した
  429 / 529 / retry-exhausted フレーム）で固定されているが、上記 2 運用中には発生していない。
- **OS は macOS のみ**。script は bash 3.2 互換で書いてあるが、Linux での運用実績はまだ無い。
- COMPLETE は「作業の痕跡があり生成が止まった」ことであって、受入条件の充足ではない。

## 3. install と discovery の実測（2026-07-26）

skills 未導入の新規 git リポジトリ・専用ポート・専用 DB の隔離環境で実測した。

| 項目 | 値 |
|---|---|
| CommandMate | 0.15.0（npm 公開版と同一） |
| Claude Code | 2.1.220 |
| Codex CLI | 0.145.0 |
| OS / Node | macOS 26.5.2 / Node v24.1.0 |
| 対象 Skill | `cmate-repository-analysis` 0.1.0 |

- install は `.agents/skills/<id>` と `.claude/skills/<id>` の **両方へ byte-identical に配置**された
  （`diff -r` 差分なし・全 file の sha256 一致、receipt の `install_roots` に両 root を記録）。
- **Claude Code 2.1.220**: 発見 **YES**（`.claude/skills` から）、slash palette へ完全一致で露出
  **YES**（`(project)` scope 表示）。機械的証跡。
- **Codex CLI 0.145.0**: 発見 **YES**（`.agents/skills` から。ただし model の自己申告であり機械的証跡ではない）、
  slash command としては **露出しない**。対照実験で `/model` はマッチし、`~/.codex/skills` 配下の
  既存 skill もマッチしないことを確認済みで、**配置先ではなく当該 CLI version の制約**である。
- **Gemini / OpenCode / vibe-local**: **未計測**。

evidence:
<https://github.com/Kewton/CommandMate/issues/1513#issuecomment-5083878264>

### この package 自身について

上記 discovery の実測は `cmate-repository-analysis` 0.1.0（low risk・script 無し）で行った。
install 先 root は package に依存しないため経路は同じだが、
**この package 自体をクリーン環境で install して発見・呼出まで確認するのは release 後にしか
できない**。手順は配布元リポジトリ <https://github.com/Kewton/commandmate-skills> の
`docs/runbooks/verify-install.md` にある。
