# 監視コアの契約（入出力・フラグ・env・終了コード）

script は互いを SKILL directory 相対で解決する。どこから呼んでも動くが、
**scripts/ の中身を個別に別 directory へ copy しない**こと（`monitor-lib.sh` を見失う）。

---

## 1. `classify-state.sh`

1 ポーリング分の `commandmate capture <id> --json` を 1 つの状態トークンへ落とす。

```
classify-state.sh --json <file>
```

| | |
|---|---|
| stdout | `NOT_RUNNING` / `RATE_LIMIT` / `GENERATING` / `PROMPT` / `IDLE` のいずれか 1 行 |
| exit 0 | 分類できた |
| exit 2 | `--json` が無い / file が無い / 未知の引数 |

参照する payload field は `isRunning` / `isPromptWaiting` / `sessionStatus` /
`realtimeSnippet` のみ。`output` / `text` は存在しない。`isGenerating` は意図的に見ない。

判定順は `NOT_RUNNING → is_retrying(→GENERATING) → PROMPT → GENERATING → RATE_LIMIT → IDLE`。
**この順序は仕様であり、実装詳細ではない**（[recipe-rationale.md](./recipe-rationale.md)）。

## 2. `verify-completion.sh`

タスク状態（一次）と capture 由来の推定（フォールバック）から完了判定を下す。
状態の観測（ループ）とは分離してある。

```
verify-completion.sh --started <0|1> --state <STATE> \
                     --idle-streak <n> --idle-threshold <n> \
                     --commits <n> --uncommitted <n> \
                     [--task-status <status>]
```

| 引数 | 既定 | 意味 |
|---|---|---|
| `--started` | `0` | 生成アンカーを **一度でも**観測したら 1 |
| `--state` | 空 | 直近ポーリングの状態トークン |
| `--idle-streak` | `0` | 連続で IDLE / NOT_RUNNING だった回数 |
| `--idle-threshold` | `5` | 完了判定に必要な idle 連続回数 |
| `--commits` | `0` | base ref からの commit 数 |
| `--uncommitted` | `0` | 未 commit の変更数（untracked 含む） |
| `--task-status` | 空 | worktree の最新実行契約の状態（`read_task_status` の出力）。空・未知の値は「答え無し」 |

判定順（**仕様であり実装詳細ではない**。CommandMate 側の同名 Skill と同一）:

```
1. ペイン生存 veto   state ∈ {GENERATING, PROMPT, PROMPT_LIVE, RATE_LIMIT} -> WORKING
2. 裁定済みタスク    succeeded -> COMPLETE / failed|cancelled -> VERIFY_FAILED / not_started -> NOT_STARTED
3. STARTED ガード    started=0 のとき: 作業ゼロ -> NOT_STARTED / 作業あり -> WORKING
4. idle + 作業量      閾値到達かつ作業あり -> COMPLETE / 閾値到達で作業ゼロ -> NOT_STARTED / それ以外 -> WORKING
```

1 が 2 より先なのは、古い裁定（前回 send の `succeeded`）で監視を打ち切らせないため。
2 が終局状態だけを見るのは、`pending` / `running` / `waiting_input` / `verifying` を 3 へ落として
STARTED ガードを効かせ続けるため（「CLI は running と記録したが Enter が落ちていない」の検出）。

| stdout | 条件 |
|---|---|
| `COMPLETE` | `task-status=succeeded`、または（1・2 を抜けて）`started=1` かつ idle 閾値到達かつ（`commits>0` または `uncommitted>0`） |
| `VERIFY_FAILED` | `task-status` が `failed` / `cancelled`。終局だがマージ不可 |
| `NOT_STARTED` | `task-status=not_started`、または `started=0` かつ `commits=0` かつ `uncommitted=0`、または `started=1` で idle 閾値到達だが作業の痕跡が無い |
| `WORKING` | `state` が `GENERATING` / `PROMPT` / `PROMPT_LIVE` / `RATE_LIMIT`、または idle 閾値未到達、または `started=0` だが作業の痕跡がある |

exit code は常に 0（判定は stdout で返す）。未知の引数のみ exit 2。

**`COMPLETE` はマージ可否の裁定ではない。** 契約付き委任の最終裁定は
`commandmate wait --verify` の exit code（ゲート不合格 20 / 検証対象なし 21）である。

## 3. `monitor.sh`

操作エントリ。ループ・worker 横断の状態・介入だけを持ち、分類と完了判定は上の 2 つに委ねる。

```
monitor.sh [flags] <worktree-id>[@<instance-id>] [<worktree-id>[@<instance-id>] ...]
```

`@<instance-id>` は tool の primary 以外の instance（`w1@codex-2` 等）。**capture 側
（`--agent <tool> --instance <id>`）と介入の送信先の両方**を切り替え、worker 横断状態と
log 行の key も `<id>@<instance>` になる。`<worktree-id>` は
`[a-zA-Z0-9][a-zA-Z0-9_-]*`、`<instance-id>` は `[a-zA-Z0-9_-]+` を満たさないと exit 2
（tmux target へ補間するため、サーバ側 validator と同じ形を起動前に強制する）。

| flag | 既定 | 意味 |
|---|---|---|
| `--interval <sec>` | `20` | ポーリング間隔 |
| `--idle-threshold <n>` | `8` | 完了判定に必要な idle 連続回数（20s 間隔で 150s 相当） |
| `--session-prefix <s>` | 空（＝導出） | **legacy escape hatch。** 導出された `mcbd-<cliToolId>` の**頭だけ**を `<s>` に置換する（instance suffix は維持） |
| `--resend-message <s>` | `continue` | リトライ枯渇後に送る文字列 |
| `--max-resends <n>` | `2` | 再送の上限。使い切ったらエスカレーション |
| `--max-polls <n>` | `0` | N ポーリングで exit 0。`0` は全 worker COMPLETE まで回る |
| `--verbose` | off | 1 ポーリング 1 行の状態ログを **追加**する（既定出力は不変） |
| `--hooks <file>` | `$MONITOR_HOOKS` | フックを source する。**繰り返し指定可**（左から順）。1 つでも与えると `MONITOR_HOOKS` は捨てられる |

| env | 既定 | 意味 |
|---|---|---|
| `CM` | `npx commandmate@latest` | commandmate launcher。install 済みなら `commandmate` |
| `MONITOR_HOOKS` | 空 | `--hooks` の既定値（フラグが勝つ） |

| exit | 意味 |
|---|---|
| `0` | 全 worker COMPLETE、または `--max-polls` 到達 |
| `2` | 引数不正（worktree-id 無し・未知のフラグ・不正な id / instance id）、`--hooks` の file が無い |

### 送信先セッションの導出（Issue #1602）

そのポーリングの capture ペイロードの `cliToolId` から組み立てる（`BaseCLITool.getSessionName`
と同形）。**分類したペインと入力するペインが同一であること**がこれで保証される。

```
mcbd-<cliToolId>-<worktree-id>[-<instance suffix>]
```

instance suffix は `deriveSessionSuffix` と同じで、`<tool>-` を剥がした残り
（`claude-2` → `2`）。primary（instance 未指定、または instance id が tool id と同一）では
付かない。`--session-prefix <s>` を与えると `mcbd-<cliToolId>` の頭だけが `<s>` に置き換わる。
`cliToolId` が無く `--session-prefix` も無い場合は**名前を捏造せず送信を拒否する**。

送信は `send_to_pane()` に一本化してある。

1. セッション名が導出できたか
2. `tmux has-session -t '=<name>:'` で実在するか（`=…:` は完全一致指定。素の `-t <name>` は
   完全一致が無いとき前方一致へフォールバックし、`mcbd-claude-w1` が `mcbd-claude-w1-2` へ漏れる）
3. `tmux send-keys` 自体が成功したか

3 つとも**失敗を stderr へ報告して非 0 を返す**。ログは送信の**結果**を書き、
**`approvals` と再送予算は 2・3 を通過したときだけ動く**。

### 出力行

| 行 | 出る条件 |
|---|---|
| `monitor: watching N worker(s), interval=…, idle-threshold=…, max-resends=…` | 起動時 |
| `monitor[<lbl>]: intervention target = <session>` | 送信先を初めて解決したとき。**worker ごとに 1 度だけ** |
| `monitor[<lbl>]: capture failed, skipping poll` | capture が非 0。**idle streak を進めない** |
| `monitor[<lbl>]: rate limit -> sent 'a' to <session>` | RATE_LIMIT 分類時、**かつ配信できたとき** |
| `monitor[<lbl>]: terminal API error at an idle prompt -> resent to <session> (n/N)` | 再送条件成立、**かつ配信できたとき** |
| `monitor[<lbl>]: terminal API error and resend budget spent (N) — operator needed` | 再送上限到達 |
| `monitor[<lbl>]: task state unavailable (…) — FALLBACK MODE: …` | `read_task_status` が `unavailable` を返した。**worker ごとに 1 度だけ** |
| `monitor[<lbl>]: poll <N> -> <STATE> started=… streak=… commits=… uncommitted=… verdict=… [task=…]` | `--verbose` 指定時のみ、1 ポーリング 1 行。`task=` は台帳が答えたときだけ末尾に付く |
| `monitor[<lbl>]: COMPLETE (approvals=<n>)` | 完了判定 |
| `monitor[<lbl>]: VERIFY_FAILED — contract gates failed; do not merge. …` | タスクが `failed` / `cancelled`。COMPLETE と同じく終局（ループを抜ける） |
| `monitor[<lbl>]: NOT_STARTED — idle with no work; check the composer / Enter` | NOT_STARTED かつ idle 閾値到達 |
| `monitor: reached --max-polls (N) after N poll round(s); stopping` | `--max-polls` 到達 |
| `monitor: all N worker(s) complete` | 正常終了 |

プロンプト自動承認は **行を出さない**（通知の氾濫を防ぐため）。件数は COMPLETE 行の
`approvals=` に出る。`--verbose` 時は PROMPT 分類として poll 行に残る。

worker 横断の状態（streak / started / approvals / resends）は `mktemp -d` した temp
directory 配下の file に持つ。EXIT / INT / TERM で削除される
（bash 3.2 には連想配列が無いため。[recipe-rationale.md](./recipe-rationale.md) 16）。

## 4. フック

`monitor.sh` は 3 つの関数を呼ぶ。いずれも引数は worktree-id 1 つ、stdout に 1 行を返す。

```bash
read_task_status()  { echo <status>; }  # 一次ソース。TaskStatus / 空 / unavailable
count_commits()     { echo <n>; }       # base ref からの commit 数
count_uncommitted() { echo <n>; }       # git status --porcelain 相当の行数
```

既定はすべてスタブ（`read_task_status` は空、カウンタは `0`）。`--hooks <file>` /
`MONITOR_HOOKS` で渡した file が **スタブ定義の後に source** され、定義された関数だけが
上書きされる。`--hooks` は繰り返し指定でき、左から順に source される。

### `hooks-task.sh`（一次ソース）

`commandmate task list <worktree-id> --limit 1` の**最新行**（TSV の第 2 列）を読む。

| 戻り値 | 意味 | monitor 側の扱い |
|---|---|---|
| `pending` / `running` / `waiting_input` / `verifying` / `succeeded` / `failed` / `not_started` / `cancelled` | 台帳が答えた（`TASK_STATUSES`） | そのまま `--task-status` へ渡す |
| 空 | 台帳は答えたが、この worktree に task が無い（契約なし委任） | 静かにフォールバック。追加の行は出ない |
| `unavailable` | 台帳を**引けなかった**（非 0 終了） | バージョンゲート行を 1 度出して空へ降格 |

`unavailable` は `TaskStatus` ではないので、この file を知らない旧 `monitor.sh` に配線されても
`verify-completion.sh` の未知値経路（フォールバック）へ落ちるだけで、誤った裁定にはならない。

実測した非 0 終了（2026-07-31）:

| 状況 | exit | stderr |
|---|---:|---|
| CommandMate 0.10.2 / 公開版 0.16.0（`task` コマンド自体が無い） | 1 | `error: unknown option '--limit'` |
| server 停止中 | 1 | `Error: Server is not running.` |
| server が知らない worktree | 99 | `Error: Resource not found.` |

**`commandmate task --help` は probe に使えない**（0.10.2 では root help を出して exit 0 になる）。
実サブコマンドを叩いた終了コードだけが判別材料である。
`$CM task list … | head` のようにパイプすると `$?` が head のものになり、上記の全失敗が
静かに「task 無し」に化ける。`hooks-task.sh` は代入で受けて `$?` を保存している。

| env | 既定 | 意味 |
|---|---|---|
| `CM` | `npx commandmate@latest` | commandmate launcher（`monitor.sh` から source されると継承される） |

**前提**: 監視中の契約が worktree の**最新タスク**であること。標準手順（契約作成 →
`send --contract` → 監視）なら成立する。前回の委任のタスクが最新のまま監視を始めると
その古い裁定を読む（ペインが生きている間だけ、`verify-completion.sh` の veto が守る）。

### `hooks-git.sh`（フォールバック用の参照実装）

| env | 既定 | 意味 |
|---|---|---|
| `MONITOR_HOOKS_BASE` | `origin/develop` | commit を数える base ref |
| `MONITOR_HOOKS_REPO` | `.` | `git worktree list` を引くリポジトリ |
| `MONITOR_WORKTREE_ROOT` | 空 | worktree-id と同名の directory を持つ親。git 探索より先に試す |

worktree-id は `<repo>-<branch>` を slug 化したもの（lowercase、`[a-z0-9-]` 以外を `-`、
連続を畳み、前後の `-` を落とす）。`<repo>` はメイン worktree の directory 名である。
`git worktree list --porcelain` の各レコードから同じ規則で id を組み立てて突き合わせる。

- 解決できない id は **エラーではなく 0** を返す（監視ループを落とさないため）。
- `MONITOR_HOOKS_BASE` が解決できない場合、source 時に stderr へ警告する。
  黙って 0 を返すと、全部 commit 済みの worker が `uncommitted=0` と合わさって
  最後に `NOT_STARTED` と誤報される。

**base ref が違うリポジトリでは `MONITOR_HOOKS_BASE` を必ず指定すること。**
既定値 `origin/develop` は由来（CommandMate）の慣習であって、汎用の既定ではない。

## 5. `verify-scope.sh`

禁止パターンの出現数を、**コメント行を除いて**数える。

```
verify-scope.sh --file <path> [--pattern <ERE>]
```

| | |
|---|---|
| 既定 pattern | `npx commandmate([^@]|$)`（`@latest` 固定を欠いた invocation） |
| stdout | `CLEAN` または `VIOLATIONS:<n>` |
| exit 2 | `--file` が無い / file が無い |

コメント行（`^[[:space:]]*#`）を除外するのは、禁止パターンが **それを説明する散文**に
一致して違反と数えられた実例があるためである。

## 6. `quality-gate.sh`

コマンドの **実 exit code** で PASS / FAIL を判定する。

```
quality-gate.sh [--log <file>] -- <command> [args...]
```

| | |
|---|---|
| stdout | `PASS` または `FAIL:<code>` |
| stderr | `log: <path>`（出力の全文） |
| exit 2 | コマンドが与えられていない |

`cmd | grep …` は `$?` を grep に渡し、非 0 終了を隠す。テスト全緑のまま
Unhandled Rejection で exit 1 になる runner が実在するので、
**出力の grep で合否を決めない**。
