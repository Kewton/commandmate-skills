# tests/fixtures/cmate-verify/

`skills/cmate-verify` のランナー（`scripts/verify-run.sh`）の回帰テスト。
package には含まれない（配布物は `skills/cmate-verify/` の下だけ）。0.4.0 で
`skills/cmate-verify/scripts/tests/` からここへ移した（Issue #69）。移送前後で
**214 assertion / 0 failed** は同一である。Issues #223 / #224 で 314 assertion に増えた。

```bash
bash tests/fixtures/cmate-verify/run-tests.sh   # 314 assertions
```

bash と git だけで動く。ネットワークも Node も使わない（テスト対象のランナー自身が
bash + git + awk しか要求しないので、その suite が依存を増やしてはならない）。
被テストランナーの path は `VERIFY_RUN` で差し替えられる（install 済みのコピーに
同じ suite を当てたいとき用）。

## CI での実行

| 経路 | 定義 |
|---|---|
| `commandmate verify` | `.commandmate/verify.yaml` の `verify-selftest` ゲート |
| GitHub Actions | `.github/workflows/validate.yml` の `runner-suites` job |

## 出力形式

TAP 風（`ok - ...` / `not ok - ...`）＋最終行 `# tests: N passed, M failed`。
exit 0 になるのは M が 0 **かつ** assertion 数が `MIN_ASSERTIONS`（現在 300）以上のとき。
この下限は、ケースが黙って落ちた suite が「0 failed」で緑になるのを防ぐためにある。

## 何を固定しているか

fixture は `fixtures/*.yaml`（47 本。うち 27 本が拒否されるべき設定）。

| 群 | 内容 |
|---|---|
| 基本の 5 ケース | 全 PASS / 1 ゲート FAIL（残りは実行される）/ timeout / work-evidence の `not_started` / 設定ファイル無し |
| 反証ケース | 同じ設定が linked worktree では実行される・`--skip-work-evidence` を付ければ同じ clean repo でも実行される |
| 設定エラー | 19 種（version・gates・id・command・timeout・options・タブ・アンカー・ブロックスカラー・フロースタイル等）をすべて exit 2 で拒否する |
| 診断可能性（Issue #1607） | 出力ゼロで落ちるゲート・`maxLogTailBytes: 0`・exit 126/127 の spawn ヒント |
| `options.requireCommit` | 未 commit のみ → 21 / 同じ変更を commit → 0 / 既定では同じ dirty tree が PASS / 作業ゼロを commit 規則のせいにしない / `--skip-work-evidence` は要求ごと飛ばす |
| 実行契約の除外（#1651 / #1580） | 契約だけの untracked → 21 / 契約だけの setup commit → 21 / 同じツリーに実作業を足すと 0 / 契約を実作業へ rename・その逆向きも作業として数える / 空白を含む契約パスも非契約パスも誤判定しない / 新規ディレクトリはファイル単位で数える |
| `mutex`（#223 / CommandMate #1771） | 2 プロセス同時実行で片方が待つ（`waited=` が duration と**別に**出る）/ ロックは `<root>/<name>.lock` の**ディレクトリ**で `owner` に pid・host・token を持つ / 終了時に解放される / 待たなかったゲートも `waited=0s` を出す / 宣言していないゲートに `waited=` は付かない / 空かないまま timeout → `SKIP reason=mutex-wait` + exit 22（TIMEOUT でも FAIL でもない）/ 他ホストの記録は奪わない / 自ホストの死んだ pid の記録は奪う |
| `retryOnFail` / `flakyIsPass`（#224 / CommandMate #1772） | fail→pass が `FLAKY` になり両ランの exit / duration が出る / `flakyIsPass` 未宣言で RESULT failed・exit 20 / 宣言 true で passed・exit 0（**綴りは両方 `FLAKY`**）/ 2 回とも fail は `FAIL exit=3,3`（`flakyIsPass: true` でも fail）/ 3 回目で緑になるゲートは**それでも FAIL**（コマンドの実行回数を marker で数える）/ TIMEOUT は再実行しない / `mutex` と併用してもロックは試行ごとに解放される |
| env 注入（#223） | `CM_WORKTREE_INDEX` / `CM_WORKTREE_ID` を export した／しないで同じ verify.yaml が期待どおり走る（ランナーは**上書きしない**） |
| `options.requireEnvClean`（#1740） | 受理され（exit 2 にならない）、`GATE env-clean SKIP reason=no-baseline` と理由が出て、判定は変えない |
| `$WORKDIR` の寿命（#228） | 48 ゲート × 12 run を回して、どの run でも作業 directory が**run の途中で消えない**（`No such file or directory` / `no output captured` がゼロ・全ゲートの marker が log tail に残る）ことと、run が本当に終わったときには**消える**ことを両側から固定する |
| harness 自身 | アサーションヘルパの自己検査 |

## 失敗の追跡可能性

ランナーの stdout / stderr は分離したまま（それが契約）だが、`run_verify` は
**exit code ≠ 0 のときだけ** stderr を `out.N` へ追記し、失敗した assert は `out.N` の
path と中身の両方を出す。CI に残るのは suite の標準出力だけで、`err.N` は sandbox の
EXIT trap で消えるため、ここで echo しないものは後から読めない（Issue #1607 の CI 赤は
`not ok - parsing: ...` の 1 行しか残さなかった）。

`assert_stdout_contract` は stdout が `GATE ...` / `RESULT ...` の 2 形式だけであることを
確認する（out.N が stderr を運んでも stdout 契約は壊れていない、という反証側）。

## 変異による健全性確認

判定が空振りしていないことを、ランナーへ変異を入れて確認してある。

| 変異 | 赤になるもの |
|---|---|
| `set -m` の除去 | orphan 検出 |
| 失敗時にそこで打ち切る | 継続実行の assert |
| work-evidence の OR を AND にする | 33 件 |
| 全 skip を passed と報告する | skip 判定 |
| プライマリ判定の無効化 | 6 件 |
| `out.N` への stderr 追記を止める | 診断系 7 件だけ |
| 空 log・tail 無効の fallback 除去 | 5 件だけ |
| spawn ヒントの除去 | 2 件だけ |
| ログ末尾を stdout に流す | 3 件（うち 1 件が `assert_stdout_contract`） |
| `requireCommit` の判定分岐の除去 | 5 件 |
| awk が再び `requireCommit` キーを拒否する | 15 件 |
| `requireCommit=true` を無条件に出力する | 1 件 |
| 契約除外: commit 側の pathspec 除去 | 6 件（＋ CommandMate 側 conformance 3 件） |
| 契約除外: 未コミット側の除外除去 | 9 件（＋ CommandMate 側 conformance 2 件） |
| 契約除外: `-uall` 除去 | 10 件 |
| 契約除外: rename の 2 パス目を見ない | 1 件 |
| 契約除外: `-z` をやめて人間向けフォーマットを行単位で読む | 21 件 |
| **#223 / #224（2026-08-20 実測）** ||
| ロックを取らずにゲートを回す | 19 件 |
| `waited` を duration に足す | 1 件（`mutex: waited is reported beside duration, never added to it`） |
| `FLAKY` を `PASS` に丸める | 4 件 |
| `flakyIsPass` 未宣言でも FLAKY を pass と数える | 4 件 |
| 再実行を 1 回でなく 2 回にする | 3 件（うち 1 件はコマンドの実行回数そのもの） |
| mutex 待ちの SKIP で `RESULT passed` を出す | 3 件 |
| `GATE env-clean SKIP` 行を出さない | 1 件 |
| ゲートに `CM_WORKTREE_INDEX` / `CM_WORKTREE_ID` を**上書きで**渡す | 2 件 |
| **#228（2026-08-20 実測。Linux/ARM64 の container・bash 5.2.21 で計測）** ||
| watchdog の停止を `kill -TERM` に戻し **かつ** `cleanup_workdir` の `BASH_SUBSHELL` ガードを外す（= 修正の全戻し） | `workdir-lifetime` の 2〜3 件。48 ゲート × 12 run を 1 単位として **20 回中 20 回**赤（24 ゲート × 6 run では 20 回中 15 回しか赤にならなかったのでこの件数まで上げた）。修正版は同じ計測で 25 回中 0 回赤 |
| 片方だけ戻す（`kill -TERM` に戻すが ガードは残す／ガードを外すが `kill -s KILL` は残す） | **赤にならない**（各 20 回中 0 回）。2 つは冗長に置いてある — `kill -s KILL` が引き金（catch できる signal）を消し、ガードが結果（fork した子による `rm -rf`）を消す。どちらか一方でも欠陥は出ない |

#228 で `mutex: the first run declares a wait of zero rather than nothing` を 2 assertion に割った。`GATE e2e PASS exit=0 duration=3s waited=0s` の literal 一致は、runner が約束していない値まで固定していた —— duration は `date +%s` の秒単位計測なので 3 秒の hold が秒境界をまたぐと 4 と読める（20 回連続実行で macOS・Linux/ARM64 とも 20 回中 1 回赤）。いま固定しているのは **`waited` はちょうど 0**（待たなかったゲートも `waited=` を出す）と **duration は 3 秒以上**（待ち時間を duration に足していない）の 2 つ。`lock_acquire` を通さない変異での実測は分割前 23 件 → 分割後 24 件。

script を変更したら、**まず変異を入れて赤くなることを確かめてから**直すこと。

## CommandMate 本体との一致

`options.requireCommit` と実行契約の除外について、本体実装
（`src/lib/verification/gate-runner.ts`）との一致は CommandMate 側の
[conformance テスト](https://github.com/Kewton/CommandMate/blob/develop/tests/unit/skills/cmate-verify/require-commit-conformance.test.ts)
が同一の git サンドボックスに両実装を当てて固定している。verdict だけでなく
`commits=N uncommitted=N` を**数値として**突き合わせる（両方 > 0 のままズレる差分は
verdict の比較では見えないため）。既知の差分は 2 件とも解消済み — 契約ファイルの除外
（本ランナーが緩い向きだった）と、未追跡ディレクトリの数え方（`-uall` の有無で数字だけが違った）。

**この suite は package に同梱されなくなった。** CommandMate 側に
`tests/unit/skills/cmate-verify/` の薄いラッパが在り、install 済みの package から
この suite を呼んでいた場合、その参照はこのリポジトリの path へ張り替える必要がある
（本リポジトリからは変更できない）。
