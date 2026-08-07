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

**台帳が入った version（境界の実測、2026-08-05）**:

| 対象 | `src/cli/commands/task.ts` |
|---|---|
| tag `v0.15.0` / `v0.16.0` | **無し** |
| tag `v0.17.0`（2026-07-31 リリース） | **有り** |
| tag `v0.18.0` … `v0.21.1` | 有り |
| homebrew 導入版 0.10.2（実行時確認） | **無し**（`error: unknown command 'task'`） |

したがって **一次ソース経路の最小 version は 0.17.0** である。

> **0.4.0 の本節にあった「2026-07-31 時点の公開版では必ずフォールバックで走る」という断定は
> 誤りとして削除した。** 断定した当日に 0.17.0 が出ており、以後の公開版はすべて台帳を持つ。
> 「今日の公開版は」の形で書かれた事実は次のリリースで嘘になり、しかも**嘘になったことが
> 誰にも見えない**。version 境界（上表）は時間が経っても真だが、
> 「いま目の前の CommandMate がどちらか」は version の照合ではなく実行時 probe で決める:
> 台帳が引けなければ `FALLBACK MODE` 行が出て、引ければ poll 行に `task=` が付く。

## 1c. 介入の宛先（0.3.0 で修正、Issue #1602）

**第 1 節の「介入 21 件（すべてプロンプト自動承認）」は、実際には 1 件も届いていなかった。**
0.2.0 までの既定送信先は `cm-<worktree-id>` で、開発機の `tmux ls` に `cm-` で始まる
セッションは 1 つも存在しない。3 箇所の `tmux send-keys` がすべて `2>/dev/null || true` で
終わり、rate limit 分岐はログを送信の**前**に出し、承認分岐は無条件にカウンタを進めていたため、
**空振りが「成功 21 件」として記録されていた**。CommandMate 側の同名 skill にあった同一の欠陥
（#1601）と行構造まで一致する。

したがって第 1 節の (b)「偽陽性介入 0 件」は**維持される**（そもそも何も送っていない）が、
「介入 21 件」は**プロンプトを 21 回検出した**という意味に読み替える必要がある。
21 件のプロンプトは worker 側の autoYes、または人手で処理されていたと考えられる。

実測（2026-08-01、実 tmux）:

| 実測項目 | 結果 |
|---|---|
| CommandMate が作るセッション名 | `mcbd-<cliToolId>-<worktreeId>[-<instance suffix>]`（`BaseCLITool.getSessionName`） |
| `cm-` で始まるセッション | **0 件** |
| `tmux send-keys -t zzprobe-w1`（`zzprobe-w1` は停止、`zzprobe-w1-2` のみ生存） | 送信成功。**`zzprobe-w1-2` が受信**（前方一致フォールバック） |
| `tmux send-keys -t '=zzprobe-w1:'` | `can't find session`（正しく拒否） |

**この節も実運用実績ではない。** 修正後の経路は fixture / shim テスト
（`monitor.sh types into the session CommandMate actually creates` 他 5 変異）で固定してあるが、
実 worker への配信実績は未計測である。

## 1d. 外部コマンドの終了コード（0.4.0 で修正、CommandMate #1614）

**1c と同じ型が 4 箇所残っていた**: 外部コマンドの結果を確かめずに次を決める。
0.3.0 では `capture` の終了コードだけが見られており、その 8 行下の `classify-state.sh`、
完了判定の `verify-completion.sh`、`hooks-git.sh` の 3 つの `git` 呼び出しは見ていなかった。

| 経路 | 0.3.0 の挙動 | 実害 |
|---|---|---|
| `git … \| wc -l`（`log` / `status`） | pipeline 後段の終了コードが採用され、`git` の失敗が `0` として出る | 完走した worker が `NOT_STARTED` |
| `git worktree list` をヒアドキュメント内で実行 | 終了コードが到達不能。空の record 集合が「該当 worktree 無し」と区別できない | **両カウンタが同時に 0 へ沈む** |
| `state=$("$CLASSIFY" …)` | 空 state は `case` を素通りするが、**完了判定へはそのまま渡る** | 空 state は生存信号とみなされずヒューリスティクスへ落ちる → **稼働中の worker が COMPLETE** |
| `verdict=$("$VERIFY" …)` | `case "$verdict"` に default が無い | そのポーリングが無言で素通り（silent skip） |

実測（bash 3.2.57、2026-08-01）:

```
verify-completion.sh --started 1 --state '' --idle-streak 10 --idle-threshold 5 \
  --commits 2 --uncommitted 0 --task-status ''                   -> COMPLETE
verify-completion.sh --started 1 --state GENERATING …（他は同じ） -> WORKING
```

**起票時の「誤 COMPLETE は起きない」という評価は誤りだった。** 最も危険な向きの欠陥は
`state=""` にあり、heuristic COMPLETE の `commits >= 1` 要求は空 state の経路を止めない。

数え方も併せて実測した。**0.3.0 の `wc -l` は過少計数していない**（0 件→0 / 1 件→1 / 2 件→2）。
過少計数は「終了コードを見るために出力を先に変数へ受ける」修正形で初めて起きる
（`$()` が末尾改行を落とすため 1 件→0 / 2 件→1）。そのため 0.4.0 は
`printf '%s' "$out" | grep -c . || true` を採用し、0 件 / 1 件 / 複数件の 3 サイズを回帰で固定した。

**この節も実運用実績ではない。** 4 経路とも fixture / shim テストで固定し、変異注入
（ガードを 1 つずつ外す / 数え方を `wc -l` へ戻す）でそれぞれ赤くなることを確認しているが、
実運用で `git` や判定器が落ちた実績は未計測である。

## 1e. プロンプト自動承認の条件（0.5.0 で追加、Issue #59）

0.4.0 までの `PROMPT` 分岐は、分類しただけで無条件に Enter を送っていた。Enter は tmux ペインへ
直接入るのでサーバの承認制御を通らず、(1) 契約の autoYes ポリシー（`mode: off` / `denyPatterns`、
CommandMate #1547 / #1684 / #1699）を迂回し、(2) multiple_choice では**デフォルト選択肢の確定**に
なる（#1681）。

**Issue #59 の提案（「multiple_choice なら保留」）は実測により採らなかった。**
理由は下表の 1 行目である。

実測（2026-08-05、CommandMate 0.21.2、実 worktree 6 件を 1 秒間隔で probe。
`capture <id> --json` を 840 回叩き、`promptData` が非 null だった 30 フレームを採取した）:

| 実測項目 | 結果 |
|---|---|
| `promptData.type` の分布 | **30/30 が `multiple_choice`**。Claude Code の権限プロンプト（`Do you want to proceed?` / 選択肢は Yes・「今後聞かない」・No）も multiple_choice として記録される。**型で保留すると実運用の承認が 100% 止まる** |
| `promptData.options[].isDefault` | 30/30 のフレームに存在。default は常に**ちょうど 1 つ** |
| その default の label / number | **34/34 が `Yes` / `1`**（3 択 27 件・2 択 7 件） |
| `autoYes.lastSuppression` | 30/30 のフレームに key として存在（値はすべて `null`。窓の間に保留を起こす契約は走っていない） |
| `promptData` が null のフレーム | 大多数。`❯ 1. Submit answers` のような AskUserQuestion 形式は製品の検出器が prompt と扱わないため（`prompt-submit-answers.json`）、**保留側の既定になる** |
| 危険な形の実在 | `capture <id> --prompts --json` の台帳に、選択肢が散文 3 件で **`isDefault` がどれにも付かない** prompt が実在した（`db9f9d48-3a5d-4a58-8d7d-ad64b4b5b59d`、`answeredBy: terminal`）。ここで Enter を送るとカーソル位置が確定する |

したがって条件は**型ではなくデフォルトの意味**に置いた: 「default 選択肢の label が肯定語で
始まる二択」だけを承認し、それ以外（ポリシー保留・default 無し・肯定でない default・
promptData 無し・未知の型）は保留する。

`promptData` の型定義は `src/types/models.ts`（`YesNoPromptData` / `MultipleChoicePromptData` /
`MultipleChoiceOption`）、`lastSuppression` の形は
`src/lib/polling/auto-yes-suppression-state.ts` と、それを publish する
`buildCurrentOutput` の unit test で固定されている。

**この節も実運用実績ではない。** 承認側 1 本と保留側 4 本を fixture で固定し、
変異注入（無条件 Enter へ戻す / ポリシー判定を後ろへ移す / multiple_choice を一律保留にする /
保留報告を毎ポーリングにする / `held=` を常時出す / `--no-auto-approve` を無視する）で
それぞれ赤くなることを確認しているが、**実運用で保留が発火した実績は未計測である**。

### 実装していない保護

- **セッションの Auto-Yes が off のときのポリシー保留**。`lastSuppression` を記録するのは
  Auto-Yes ポーラーであり、ポーラーはセッションの Auto-Yes が有効なときしか走らない
  （`src/lib/auto-yes-poller.ts`）。「契約は autoYes off、セッションの Auto-Yes も off」の
  組み合わせでは保留が記録されないので、monitor からは見えない。
  **契約付き dispatch では `--no-auto-approve` を使うこと**が、この穴に対する唯一の保護である。
- **`lastSuppression` の鮮度判定**。この record はセッションごとの「最後の保留」で、解決後も残る
  （製品側も「`isPromptWaiting` と併せて読め」と書いている）。monitor は `at` と現在時刻を
  比較していないので、**同一セッションの後続プロンプトも保留側へ倒しうる**。
  安全側だが、止まる方向の誤りである。
- **`isAskUserQuestion`**。`MultipleChoicePromptData` に実在する（#807）が、上の 30 フレームには
  **1 件も現れなかった**。観測していないフィールドを条件に入れていない。
  危険な picker は `isDefault` の不在で捕まる（上表最終行）。

## 1f. worktree-id の突合と監視の生存（0.7.0 で修正、CommandMate #1728）

**0.6.1 までの `hooks-git.sh` は、現行の採番規則で作られた id を 1 件も解決できなかった。**
突合はブランチ名だけ（`<repo>-<branch>` / `<branch>`）で、CommandMate が id を採番する規則は
`deriveWorktreeId()`（#1621）＝ **checkout の directory 名**である。CommandMate 側で実測した
修正前の解決結果（ディレクトリを Issue 番号で採番しているリポジトリ）:

```
commandmate-issue-1721 -> ''
commandmate-issue-1728 -> ''
mycodebranchdesk       -> ''      # メイン worktree
```

3 件とも空、すなわち**メイン worktree すら解決できていない**。修正後は 3 件とも解決し、
`commits=1 uncommitted=8` を返した。

同じ実測を、この配布元リポジトリの実 checkout でも取った（2026-08-07、`git worktree list` に
**16 件**。ディレクトリは `commandmate-skills-issue-<n>` 形、ブランチは `fix/…` / `docs/…` /
`linear/…` 形で、**16 件すべてで directory 名 ≠ branch 名**）。

| resolver | 非ゼロのカウントを返した worktree |
|---|---:|
| 修正前（ブランチ突合のみ） | **0 / 16**（メイン worktree を含め全件 `commits=0 uncommitted=0` ＋ 解決失敗の報告） |
| 修正後（directory 由来を第 1 候補に追加） | **16 / 16**（例: 監視対象の 1 件が `commits=0 uncommitted=9`、実 `git status` と一致） |

**この 0/16 が、修正前のカウンタが何を測っていたかの答えである**: 何も測っていない。

| 経路 | 0.6.1 の挙動 | 実害 |
|---|---|---|
| id の突合 | ブランチ由来の 2 規則のみ。**git は成功し、突合だけが外れる** | 両カウンタが恒久 0。第1d節の「両カウンタが同時に沈む」と同じ結果に、**#1614 のガードが 1 つも発火しない経路**で到達する |
| 診断行 | `monitor hooks: …`（レベル語なし） | 運用の `2>&1 \| grep -Ei "STALL\|IDLE\|…\|ERROR\|FAIL"` で**全行が消える**。上の欠陥が 25 分間気付かれなかった直接の理由 |
| 異常終了 | 何も出さない | exit 144・出力は起動行のみ・ワーカー 2 本は無監視で稼働継続。**健全な沈黙と区別不能** |

最も重い影響は **STARTED ガードの不活性化**である。`verify-completion.sh` は
`commits=0 && uncommitted=0` を「タスクが composer から出ていない」の署名として読むので、
恒久 0 のもとでは「未起動 idle を COMPLETE と誤報しない」というガードが、**誰も測っていない
数字**で裁定していたことになる。第1節の実運用実績（371 ポーリング・誤報 0）は
`myrepo` / `feature/x` 形の worktree で採ったもので、そこでは旧規則が当たっていた。

**exit 144 の原因は未特定である。** 144 = 128 + 16 で macOS の signal 16 は SIGURG だが、
SIGURG は既定で無視されるうえ、`cmd | grep …` のパイプラインの `$?` は **grep の終了コード**でも
ありうる。したがって `monitor.sh` 自身が signal 16 で死んだとは断定していない。今回入れたのは
**次に起きたときに原因がログへ残る形**であって、原因の修正ではない。

**この節も実運用実績ではない。** 突合 3 方式・レベル語・生存報告は、**directory 名 ≠ branch 名**の
git リポジトリを実際に作る fixture（メイン worktree・detached HEAD・ディレクトリ名衝突を含む）と、
シグナルを PID 指定で送る shim テストで固定し、8 変異でそれぞれ赤くなることを確認している
（内訳は `tests/fixtures/cmate-orchestrate-monitor/README.md`）。**実運用で `alive` が途切れた
監視を回収した実績は未計測である。**

既存 fixture がこの穴を構造的に検知できなかったことも記録しておく: `myrepo` / `myrepo-x` /
`feature/x` / id `myrepo-feature-x` は**旧規則そのもの**で組まれており、ブランチ突合だけでも
全件緑になる。テストが緑であることは、テストが穴を見ていることを意味しない。

## 2. 測定の限界（この Skill について）

- **修正後の介入経路は fixture / shim テストのみ**。実 worker のペインへ Enter / `a` /
  再送が実際に届いた実績は **未計測**である（第 1b・1c 節）。
- **タスク状態経路は fixture / shim テストのみ**。実 worker を契約付きで委任し、
  `succeeded` / `failed` を実際に読んで監視を終わらせた実績は **未計測**である
  （0.17.0 以降の CommandMate では経路自体は存在する。第1b節）。
- **プロンプト保留経路も fixture / shim テストのみ**（第1e節）。承認条件は実 capture 30 件の
  実測に基づくが、実運用で `hold:` が出た実績は **未計測**である。
  `hold:policy` に至っては、**保留を実際に起こす契約（`mode: off` / `denyPatterns`）を
  走らせた測定が無い**（fixture の `lastSuppression` は製品の unit test が固定している形を
  実 capture フレームへ移植したもので、生採取ではない）。
- **id の突合（3 方式）と生存報告も fixture / shim テストのみ**（第1f節）。実 CommandMate が
  採番した id を実サーバ越しに解決した実績、および実運用で `alive` の途切れから死んだ監視を
  回収した実績は **未計測**である。**exit 144 の再現条件も未特定のまま**である。
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
