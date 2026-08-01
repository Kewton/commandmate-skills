# cmate-verify-advisor 実機 dogfood 証跡（#1594）

- **対象**: 公式 Skill `cmate-verify-advisor` 0.1.0 の層 1 アナライザ（`scripts/verify-advisor.mjs`）
- **対応 Issue**: [Kewton/CommandMate#1594](https://github.com/Kewton/CommandMate/issues/1594)（Epic [#1585](https://github.com/Kewton/CommandMate/issues/1585)）
- **実施日**: 2026-08-02
- **実施者**: claude（`claude-opus-5[1m]`、non-interactive）
- **実施環境**: macOS 25.5.0 / Node v24.1.0 / CommandMate 0.17.0（開発版 CLI）と 0.10.2（homebrew 版）
- **このドキュメントの位置づけ**: 受入条件「実履歴に対して提案レポートを 1 回生成し、根拠引用つき
  diff が出ること」に対する実測記録である。**到達した範囲と未達の範囲を分けて書く。**

> **未達を先に書く。** 層 2（すり抜け検出・flake 疑い）の**実データでの提案生成は行っていない**。
> 実履歴には `passed` した run が後で revert / fix された事例が無く、発明することになるためである
> （「変える理由がない日に変更を発明しない」がこの Skill の規則そのものである）。
> 層 2 の経路自体は fixture で通してある（§5）。
> また `--apply` は**実リポジトリに対して実行していない**。§4 に一覧がある。

---

## 1. 何を実データで通したか

| 層 | 実データか | 内容 |
|---|---|---|
| 履歴収集 | **実データ** | live の `commandmate verify history --json --days 90 --limit 500`（read-only） |
| 詳細収集 | **実データ** | run ごとに `commandmate verify show <id> --json`（read-only）。10 run 分 |
| 対象設定 | **実データ** | このリポジトリの `.commandmate/verify.yaml`（6 ゲート） |
| 層 1 解析 | **実 script** | `verify-advisor.mjs` が exit 0 で 7 件の提案と diff を生成 |
| version ゲート | **実測** | homebrew の `commandmate` 0.10.2 に対して exit 3 で停止することを確認 |
| 層 2 | **fixture** | 実データでの提案は無し（上記）。経路は `cases/layer2-mixed.json` で確認 |
| `--apply` | **fixture のみ** | 実リポジトリの verify.yaml は書き換えていない |

**`commandmate verify <worktree>` は 1 度も実行していない。** 新しい run を作るコマンドであり、
履歴を汚すためである。この dogfood は既存の 30 run を読んだだけである。

## 2. 実行したコマンドと結果

```bash
node skills/cmate-verify-advisor/scripts/verify-advisor.mjs \
  --cli commandmatedev --days 90 --limit 500 \
  --worktree-prefix commandmate-skills- \
  --dump /tmp/live-snapshot.json
# exit 0
```

出力の先頭:

```
# cmate-verify-advisor — layer 1 report

advisor: objective=escape-rate+time-to-detection (the pass rate is not an objective)
advisor: config=.commandmate/verify.yaml
advisor: source=commandmatedev verify history
advisor: runs=10 gates=6 window=2026-07-31T16:56:51.148Z..2026-08-01T17:04:32.039Z

## observations
OBSERVATION multiple-worktrees samples come from 7 worktrees: commandmate-skills-docs-1591-quickstart-vibe-engineering,
commandmate-skills-feature-1588-dispatch-contract-verdict, commandmate-skills-feature-1616-uat-acceptance-integration,
commandmate-skills-feature-1617-cmate-issue-authoring, commandmate-skills-fix-1602-monitor-session-target,
commandmate-skills-fix-1611-cmate-verify-sync, commandmate-skills-fix-1614-monitor-git-exit-codes.
verify history is machine-wide; use --worktree-prefix to scope it
```

### 根拠引用つきの提案（抜粋）

```
PROPOSAL order:gates layer=1 kind=reorder-gates direction=strengthen applicable=yes
  target: gates[]
  change: validate,validate-fixtures,selftest,bash-syntax,monitor-fixtures,verify-selftest
       -> bash-syntax,validate-fixtures,validate,selftest,verify-selftest,monitor-fixtures
  rationale: fail-fast order: gates that have failed run first, cheapest first among equals;
             the set of gates is unchanged
  evidence: gate=bash-syntax       fail-rate 0.0% over 10 run(s), median    46ms
  evidence: gate=validate-fixtures fail-rate 0.0% over 10 run(s), median   135ms
  evidence: gate=validate          fail-rate 0.0% over 10 run(s), median   273ms
  evidence: gate=selftest          fail-rate 0.0% over 10 run(s), median   894ms
  evidence: gate=verify-selftest   fail-rate 0.0% over 10 run(s), median  3175ms
  evidence: gate=monitor-fixtures  fail-rate 0.0% over 10 run(s), median 23508ms

PROPOSAL timeout:monitor-fixtures layer=1 kind=set-timeout direction=strengthen applicable=yes
  target: gates[monitor-fixtures].timeoutSec
  change: 900 -> 44
  rationale: p99 of 10 executed run(s) is 28760ms (slowest 28760ms); p99 x 1.5, floored at the
             slowest run, gives 44s against the declared 900s
  evidence: run=29 at=2026-08-01T16:13:20.745Z gate=monitor-fixtures status=passed exit=0 duration=28760ms
            read the log yourself: commandmate verify show 29
  evidence: run=28 at=2026-08-01T14:20:53.687Z gate=monitor-fixtures status=passed exit=0 duration=25347ms
            read the log yourself: commandmate verify show 28
  ...
```

### 生成された diff

```diff
--- a/.commandmate/verify.yaml
+++ b/.commandmate/verify.yaml
@@ -22,24 +22,24 @@
 version: 1
 gates:
-  - id: validate
-    command: "python3 scripts/validate.py"
-    timeoutSec: 300
+  - id: bash-syntax
+    command: "find skills tests -name '*.sh' -print0 | xargs -0 -n1 bash -n"
+    timeoutSec: 30
   - id: validate-fixtures
     command: "python3 scripts/validate.py --skills-root tests/fixtures/skills"
-    timeoutSec: 300
+    timeoutSec: 30
+  - id: validate
+    command: "python3 scripts/validate.py"
+    timeoutSec: 30
   - id: selftest
     command: "python3 scripts/selftest.py"
-    timeoutSec: 300
-  - id: bash-syntax
-    command: "find skills tests -name '*.sh' -print0 | xargs -0 -n1 bash -n"
-    timeoutSec: 120
-  - id: monitor-fixtures
-    command: "bash tests/fixtures/cmate-orchestrate-monitor/run_tests.sh"
-    timeoutSec: 900
+    timeoutSec: 30
   - id: verify-selftest
     command: "bash skills/cmate-verify/scripts/tests/run-tests.sh"
-    timeoutSec: 600
+    timeoutSec: 30
+  - id: monitor-fixtures
+    command: "bash tests/fixtures/cmate-orchestrate-monitor/run_tests.sh"
+    timeoutSec: 44
 options:
   baseRef: origin/main
   skipInPrimaryCheckout: false

RESULT proposals=7 applicable=7 withheld=0 applied=0
```

`applied=0` である。**既定は propose-only であり、`--apply` を付けていない。**

### この diff を merge しなかった理由

**履歴は 10 run すべてがこの開発機のものである。** 冷えた CI runner は数倍遅いので、
`monitor-fixtures` の 900s → 44s は「この機械で観測された最遅の 1.5 倍」でしかない。
30 秒の下限と実測最大値の下限は入れてあるが（SKILL.md）、**環境の分散は履歴に写っていない**。
これは advisor の欠陥ではなく、advisor が既定で propose-only である理由そのものである。
実際に適用するなら CI 上の履歴が溜まってからにすべきで、それは本 Issue の範囲外である。

### ログ末尾切れは検出されなかった（正常）

実履歴の失敗ゲートは 2 件（run 4 の `work-evidence`、run 5 の `lint`）で、どちらも
ログ末尾に集計行が残っていた（`✖ 3 problems (3 errors, 0 warnings)`）。
したがって `log:maxLogTailBytes` の提案は出ていない。**変える理由が無いので変更を発明しなかった**、
という正常な出力である。切れている場合の挙動は fixture（`cases/truncated.json`）で確認してある。

なお、この repository の `maxLogTailBytes: 8192` に対して `monitor-fixtures` の logTail は
**ちょうど 8192 バイト**で保存されていた（9 run 分）。予算到達の検出そのものは実データでも
成立している。集計行が残っていたため提案に至らなかっただけである。

## 3. version ゲートの実測（両方向）

| CLI | version | 結果 |
|---|---|---|
| `commandmatedev`（開発版） | 0.17.0 | `verify history --json` が成功。上記の解析が通る |
| `commandmate`（homebrew） | 0.10.2 | **exit 3 で停止** |

```
$ node skills/cmate-verify-advisor/scripts/verify-advisor.mjs
verify-advisor: `commandmate verify history` failed (exit 1); detected version: 0.10.2.
  error: unknown option '--json'
  `verify history` shipped in CommandMate 0.17.0. This tool stops here rather than
  analysing a partial or absent history: advice derived from no evidence is worse
  than no advice. Upgrade CommandMate, or pass a saved snapshot with --input.
$ echo $?
3
```

**部分的な解析へのフォールバックは起きない。** 黙って劣化しないことの実測である。

## 4. 未達（意図的に到達していない範囲）

| 範囲 | 状態 | 理由 |
|---|---|---|
| 層 2 のすり抜け検出を実データで実行 | **未達** | 実履歴に「passed → 後で revert / fix」の事例が無い。無いものを提案すると規則違反になる |
| 層 2 の flake 疑いを実データで確認 | **未達** | `--worktree-prefix commandmate-skills-` の範囲に fail→pass ペアが無い |
| 実リポジトリへの `--apply` | **未達** | §2 の理由（履歴が単一マシン由来）。加えて `.commandmate/` は本作業の scope 外である |
| CI runner 上の履歴での検証 | **未達** | この開発機に CI の run が無い |
| Catalog 経由での install 実測 | **未達** | 未 publish（[CommandMate#1592](https://github.com/Kewton/CommandMate/issues/1592) の一括公開に含める判断が要る） |
| Agent 別の discovery 実測 | **未達** | docs/agent-support-matrix.md 3.2 の 9 package 実測に本 package は含まれない |

## 5. fixture 側で通してある経路

実データで到達しなかった範囲は fixture で固定してある
（`tests/fixtures/cmate-verify-advisor/`、69 assertion / 13 変異すべて検出）。

| 経路 | fixture |
|---|---|
| ログ末尾切れの検出と、3 つの反証ケース | `truncated.json` / `steady.json` / `short-tail.json` / `capped-with-summary.json` |
| 弱体化提案が `--apply` でも書かれない | `slow.json`（timeout 増加） |
| 層 2 の提案が強化方向でも書かれない | `layer2-mixed.json`（`add-gate` / `remove-gate` / ログ縮小） |
| ログ本文が出力に出ない | `truncated.json` に仕込んだカナリア文字列 |
| 書いたものがまだ verify.yaml である | `cmate-verify` の実ランナー `verify-run.sh` に読ませて確認 |

## 6. Issue 本文の前提と実測の食い違い

Issue #1594 は「着手時に前提（CLI フラグ・API 形状）を実測で再検証し、食い違えば実測を正とする」
ことを要求している。実測結果は次のとおり。**フラグはすべて本文どおりだった。**

| 前提 | 実測 | 影響 |
|---|---|---|
| `verify history [--worktree] [--days 1..90] [--limit 1..500] [--json]` | **一致** | — |
| `verify show <run-id> [--json]` | **一致** | — |
| 履歴からログを読める | **不一致** | `verify history` の gate は `{gateId, status, exitCode, durationMs}` だけで `logTail` を持たない。ログ予算の判定には run ごとの `verify show` が要る（既定でそうしている。`--no-details` で切れる） |
| 「検証 PASS したコミット」を追える | **不一致** | run にも gate にも commit sha が無い（実測で `sha` / `commit` / `head` / `rev` を含む key はゼロ）。すり抜け検出と flake 確認は `worktreeId` と時刻での**推定**になる。層 1 は flake を「候補」としてしか出さず、その理由を出力に明記する |
| gate の `startedAt` / `finishedAt` から所要時間が出る | **不一致** | 152 gate 中 133 gate で `startedAt === finishedAt`、99 gate で差分が `durationMs` と一致しない。所要時間は `durationMs` だけを使う |
| 履歴はリポジトリ単位 | **不一致** | `verify history` は**マシン全体**を返す。`--worktree-prefix` での絞り込みが実質必須（observation で混入を明示する） |
| run の status は passed / failed | **不足** | `error`（ランナー自身の失敗）と `not_started` も実在する。`error` を「ゲートの失敗」に数えない（observation として別に出す） |

いずれも実測を正として実装に反映してある。
