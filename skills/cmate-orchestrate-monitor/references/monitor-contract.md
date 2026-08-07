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
| `--heartbeat <n>` | `10` | N ポーリングごとに `monitor: alive (…)` を stdout へ出す。`0` で無効（CommandMate #1728） |
| `--verbose` | off | 1 ポーリング 1 行の状態ログを **追加**する（既定出力は不変） |
| `--no-auto-approve` | off | プロンプトへ Enter を一切送らず、全件を保留して報告する。契約付き dispatch を監督するときの既定形（Issue #59） |
| `--hooks <file>` | `$MONITOR_HOOKS` | フックを source する。**繰り返し指定可**（左から順）。1 つでも与えると `MONITOR_HOOKS` は捨てられる |

| env | 既定 | 意味 |
|---|---|---|
| `CM` | `npx commandmate@latest` | commandmate launcher。install 済みなら `commandmate` |
| `MONITOR_HOOKS` | 空 | `--hooks` の既定値（フラグが勝つ） |

| exit | 意味 |
|---|---|
| `0` | 全 worker COMPLETE、または `--max-polls` 到達 |
| `2` | 引数不正（worktree-id 無し・未知のフラグ・不正な id / instance id）、`--hooks` の file が無い |
| `128+n` | シグナル `n` を受けて終了（HUP 129 / INT 130 / QUIT 131 / PIPE 141 / TERM 143）。**SIGURG は含まない**（致死化しない。CommandMate #1728） |

### 生存報告（CommandMate #1728）

**健全な沈黙と、死んだ監視の沈黙を区別するための 3 つ**である。判定ロジックには一切関与しない。

| 行 | ストリーム | 条件 |
|---|---|---|
| `monitor: alive (poll=<n>, complete=<d>/<total>)` | stdout | `--heartbeat` ポーリングごと（既定 10、`0` で無効）。停止条件の**前**に出すので、ログの最後は常に「ループがどこまで進んだか」になる |
| `monitor: ERROR caught SIG<name> (signal <n>) on poll round <r> — monitoring stops here` | stderr | HUP / INT / QUIT / PIPE / TERM。報告後 `128+n` で終了する |
| `monitor: WARN caught SIGURG on poll round <r> — ignored, monitoring continues` | stderr | SIGURG。**致死化しない**（既定動作が無視なので、届いたことだけを可視化する）。番号は出さない — SIGURG は macOS で 16、Linux で 23 |
| `monitor: ERROR exiting on poll round <r> with <d>/<n> worker(s) complete (rc=<rc>) — the rest are now UNMONITORED` | stderr | **正常終端（全 COMPLETE / `--max-polls` 到達）以外の全ての終了**。EXIT trap にぶら下げてあるので、個別に trap していない死に方でも出る |

trap を張るのは**引数検証を通り、ループへ入る直前**である。したがって不正な id・未知のフラグ・
`--hooks` の file 欠落で落ちる経路は 1 行のままで、従来と byte 一致である。

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

### プロンプト承認の判定（Issue #59）

`PROMPT` と分類しても Enter は無条件には送らない。そのポーリングの payload から
`ml_prompt_enter_verdict` が次のどれかを返し、`approve` のときだけ `send_to_pane()` へ進む。

| 戻り値 | 条件 | 使うフィールド |
|---|---|---|
| `approve` | `type` が `yes_no`（default 未指定を含む）、または default 選択肢の label が肯定語で始まる | `promptData.type` / `options[].isDefault` / `options[].label` / `defaultOption` |
| `hold:policy` | サーバが契約の autoYes ポリシーで応答を保留した | `autoYes.lastSuppression` |
| `hold:no-prompt-data` | `promptData` が無い（テキストマーカーだけで PROMPT と分類した） | — |
| `hold:no-default` | `multiple_choice` だが `isDefault` の選択肢が無い | `options[].isDefault` |
| `hold:choice` | default はあるが label が肯定語でない | `options[].label` |
| `hold:type` | 未知の `type` | `promptData.type` |
| `hold:disabled` | `--no-auto-approve` 指定時（判定より前に決まる） | — |

判定順は **`hold:policy` が最初**である。サーバが保留したものは、形が承認可でも承認しない。
肯定語は `y` / `yes` / `allow` / `approve` / `proceed` / `accept` / `ok` を語頭に持つ label
（大小無視、直後は非英数字か行末）。`Yes, and don't ask again for: …` は肯定、
`Yesterday, roll back` は非肯定である。

保留は **prompt 1 件につき 1 行**しか出さない。同一性は `promptData` ブロックの `cksum` で見て、
`PROMPT` 以外の状態を 1 度でも挟むと忘れる（同じ質問が再び出たら再び報告する）。

### 出力行

| 行 | 出る条件 |
|---|---|
| `monitor: watching N worker(s), interval=…, idle-threshold=…, max-resends=…` | 起動時 |
| `monitor[<lbl>]: intervention target = <session>` | 送信先を初めて解決したとき。**worker ごとに 1 度だけ** |
| `monitor[<lbl>]: capture failed, skipping poll` | capture が非 0。**idle streak を進めない** |
| `monitor[<lbl>]: classify-state failed (exit N), skipping poll` | `classify-state.sh` が非 0、または空を返した。capture 失敗と同じ扱い（**idle streak を進めない**）。空 state を完了判定へ渡さないためのガード（CommandMate #1614） |
| `monitor[<lbl>]: verify-completion failed (exit N), no verdict this poll (state=… started=… streak=… commits=… uncommitted=… task=…)` | `verify-completion.sh` が非 0、または空を返した。判定なしでそのポーリングを捨てる。入力を併記するのは手で再現できるようにするため（CommandMate #1614） |
| `monitor hooks ERROR: [<wid>] …` / `monitor hooks WARN: [<wid>] …` （stderr） | `hooks-git.sh` の `git` 呼び出しが失敗した／worktree-id が checkout へ解決できなかった／ディレクトリ名が衝突していた。**原因ごとに worker 1 回**。カウンタは 0 だが「測れなかった 0」であることを示す（CommandMate #1614）。レベル語は CommandMate #1728 で追加した。`ERROR` = 両カウンタとも測れていない、`WARN` = 片方だけ劣化（もう片方は実測値） |
| `monitor[<lbl>]: rate limit -> sent 'a' to <session>` | RATE_LIMIT 分類時、**かつ配信できたとき** |
| `monitor[<lbl>]: terminal API error at an idle prompt -> resent to <session> (n/N)` | 再送条件成立、**かつ配信できたとき** |
| `monitor[<lbl>]: terminal API error and resend budget spent (N) — operator needed` | 再送上限到達 |
| `monitor[<lbl>]: task state unavailable (…) — FALLBACK MODE: …` | `read_task_status` が `unavailable` を返した。**worker ごとに 1 度だけ** |
| `monitor[<lbl>]: poll <N> -> <STATE> started=… streak=… commits=… uncommitted=… verdict=… [task=…]` | `--verbose` 指定時のみ、1 ポーリング 1 行。`task=` は台帳が答えたときだけ末尾に付く |
| `monitor[<lbl>]: PROMPT held, no Enter sent — <理由>. Answer it in the pane, or with 'commandmate respond <wid>'` | プロンプトを承認しなかったとき。**プロンプト 1 件につき 1 度だけ**（Issue #59） |
| `monitor[<lbl>]: COMPLETE (approvals=<n>[ held=<n>])` | 完了判定。`held=` は **1 件以上保留したときだけ**付く（`task=` と同じ方針） |
| `monitor[<lbl>]: VERIFY_FAILED — contract gates failed; do not merge. …` | タスクが `failed` / `cancelled`。COMPLETE と同じく終局（ループを抜ける） |
| `monitor[<lbl>]: NOT_STARTED — idle with no work; check the composer / Enter` | NOT_STARTED かつ idle 閾値到達 |
| `monitor: alive (poll=<n>, complete=<d>/<total>)` | `--heartbeat` ポーリングごと（既定 10、`0` で無効。前節） |
| `monitor: reached --max-polls (N) after N poll round(s); stopping` | `--max-polls` 到達 |
| `monitor: all N worker(s) complete` | 正常終了 |

プロンプト自動承認は **行を出さない**（通知の氾濫を防ぐため）。件数は COMPLETE 行の
`approvals=` に出る。`--verbose` 時は PROMPT 分類として poll 行に残る。
**保留は行を出す** — 誰かが答えない限り worker は動かないためで、こちらは `held=` に出る。

### ログからの取り出し方

`--verbose` 付きで `2>&1 | tee monitor.log` した監視ログから、判定を実際に下したことを
機械的に取り出す方法である。「誤報 0 だった」は、この形で数えられて初めて主張になる。

| 知りたいこと | ログからの取り出し方 |
|---|---|
| 総ポーリング数（worker 別） | `grep -cE '^monitor\[<wid>\]: poll ' monitor.log` |
| 状態分類の分布 | `grep -oE 'poll [0-9]+ -> [A-Z_]+' monitor.log \| awk '{print $4}' \| sort \| uniq -c` |
| タスク状態の分布 | `grep -oE 'task=[a-z_]+' monitor.log \| sort \| uniq -c` |
| 判定が一次ソース由来かフォールバック由来か | 終局判定の poll 行に `task=` があるか／`FALLBACK MODE` 行が出ているか |
| 介入の全件（届いたもの） | `grep -E "sent 'a' to\|resent to\|resend budget spent" monitor.log`（プロンプト承認はサイレント。総数は COMPLETE 行の `approvals=` に出る） |
| 承認しなかったプロンプト | `grep 'PROMPT held' monitor.log`（プロンプト 1 件につき 1 行。理由つき）。総数は COMPLETE 行の `held=` |
| 承認と保留の別 | COMPLETE 行の `approvals=` と `held=`。`held=` は **1 件以上あるときだけ付く**（`task=` と同じ方針。0 件の run は 0.4.0 と byte 一致のままにする） |
| 保留の理由の分布 | `grep -oE 'PROMPT held, no Enter sent — [^.]*' monitor.log \| sort \| uniq -c` |
| 届かなかった介入 | `grep 'NOT delivered' monitor.log`（stderr。`2>&1` で取り込んでいること） |
| 送信先として解決されたセッション | `grep 'intervention target = ' monitor.log`（worker ごとに 1 行） |
| 完了判定の根拠 | COMPLETE した poll 行の `started= / streak= / commits= / uncommitted= / task=` |
| capture 失敗 | `grep -c 'capture failed' monitor.log`（poll 行は出ないので別に数える） |
| helper 失敗（CommandMate #1614） | `grep -cE 'classify-state failed\|verify-completion failed' monitor.log`。いずれもそのポーリングを捨てる（poll 行は出ない）。**0 でなければ判定を下せなかったポーリングがある** |
| カウンタが信用できないポーリング | `grep -E 'monitor hooks (ERROR\|WARN):' monitor.log`（worker あたり 1 行。出ていれば `commits=` / `uncommitted=` の 0 は「測れなかった」であって「作業ゼロ」ではない。`ERROR` は両カウンタ、`WARN` は片方だけ） |
| 監視が最後まで生きていたか | `grep -E 'monitor: (alive\|ERROR\|WARN)' monitor.log`（`alive` が途切れた所が最後に生きていたポーリング。終端に `caught SIG…` / `exiting on poll round` があれば異常終了） |

**ログを `grep` で絞るときは `ERROR|WARN|alive` を必ずパターンに含めること。** レベル語が無かった
0.6.1 以前の `monitor hooks: …` は、運用でよく使う
`monitor.sh … 2>&1 | grep -Ei "STALL|IDLE|…|ERROR|FAIL"` で**1 行残らず消えていた**
（CommandMate #1728）。「この 0 は測定値ではない」と言う唯一の行が、ログの中で最も消えやすい形を
していたことになる。

worker 横断の状態（streak / started / approvals / held / resends）は `mktemp -d` した temp
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
| `MONITOR_WORKTREE_ROOT` | 空 | worktree-id と同名の directory を持つ親。git 探索より先に試す。CommandMate #1728 以降は **escape hatch** であって既定の配線ではない（git 探索がディレクトリ由来 id を自力で解決する）。`git worktree list` に出ない checkout や、path digest で曖昧性を解いた id では依然これが答えである |

slug 化の規則は 3 方式に共通で、`sanitizeIdSegment()` と同じ（lowercase、`[a-z0-9-]` 以外を `-`、
連続を畳み、前後の `-` を落とす）。`git worktree list --porcelain` の各レコードから同じ規則で
id を組み立てて突き合わせる。**突合順は仕様である**（CommandMate #1728）:

| # | 突合対象 | 由来 |
|---|---|---|
| 1 | `slug(basename(<checkout path>))` | **現行**。`deriveWorktreeId()`（CommandMate #1621）。初回登録時に一度だけ確定するので、ブランチを切り替えても id は変わらない。`branch` レコードを持たない detached HEAD にも効く |
| 2 | `slug("<repo>-<branch>")` | 旧 `generateWorktreeId()`。`<repo>` はメイン worktree の directory 名（git が最初に出すレコード） |
| 3 | `slug("<branch>")` | 同上（repo 名なし） |

1 を先に見るのは、稼働中のサーバが配る id が 1 だからである。2 と 3 が別 checkout に当たったとき
でも **1 が勝つ**（レコードの出力順に依存しない）。2・3 は後方互換のために残してある。

- 解決できない id は **エラーではなく 0** を返す（監視ループを落とさないため）。ただし黙らない:
  `monitor hooks ERROR: [<wid>] no checkout resolved …` を worker あたり 1 回出す。
- ディレクトリ名が衝突する 2 つの checkout は、この走査では区別できない（CommandMate 側は mint 時に
  `<base>-<sha256[0:8]>` で解決している）。**最初の 1 件を数えたうえで `WARN` を出す** — 答えない
  と両カウンタが 0 へ沈むためで、別の checkout を数えたいときは `MONITOR_WORKTREE_ROOT` を指定する。
- `MONITOR_HOOKS_BASE` が解決できない場合、source 時に stderr へ警告する
  （`monitor hooks WARN: base ref …`）。黙って 0 を返すと、全部 commit 済みの worker が
  `uncommitted=0` と合わさって最後に `NOT_STARTED` と誤報される。

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
