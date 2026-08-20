# cmate-verify リリースノート（なぜ今の挙動なのか）

この file は「何が起きたか → だからこう変えた」の**経緯の記録**である。**契約の正本ではない**
—— 何を受理し、何をどう判定するかの正本は [SKILL.md](../SKILL.md) であり、食い違ったら
SKILL.md が正しい。

**この file は 0.5.0 から始まる。** 0.4.2 までの経緯を遡って書き起こしてはいない（無かった
ものを後から作ると、書いた人の記憶が実測より強くなる）。それ以前は commit 履歴と
`tests/fixtures/cmate-verify/README.md` を読むこと。

---

## Changelog

### 0.5.0 — 上流と同じ設定を受理し、run の途中で自分の作業 directory を消さなくなった（Issue #223 / #224 / #228）

**「`commandmate verify` では動くのに、このランナーでは exit 2」が起きていた**（#223 / #224）。
上流 CommandMate #1771（gate 単位の `mutex` と worktree ごとの env 注入）と #1772（FLAKY を
一級の outcome にする）が develop に着地したあと、このランナーの受理集合だけが取り残された。
`mutex:` / `retryOnFail:` / `flakyIsPass:` を書いた `.commandmate/verify.yaml` は製品 CLI では
動き、standalone では**設定エラーで拒否**される —— 同じ file から同じ判定を出すことがこの
package の存在理由なので、これは機能欠落ではなく**契約違反**である。`options.requireEnvClean`
（上流 #1740）も同じドリフトで、#223 / #224 とは別に既に発生していた。

移植は Issue 本文の「推奨」ではなく**上流の実物**（`verify-config.ts` / `machine-lock.ts` /
`gate-runner.ts` / `worktree-index.ts` / `verify-runner.ts` と `verification-config.md` 第9〜10節）
を読んで合わせた。受理集合は `gates[]` = `id` / `command` / `timeoutSec` / `mutex` /
`retryOnFail` / `flakyIsPass`、`options` = `baseRef` / `skipInPrimaryCheckout` /
`maxLogTailBytes` / `requireCommit` / `requireEnvClean` で、値域も同じである
（`retryOnFail` は 0 か 1 —— **上限そのものが機能の中身**である。`mutex` は
`^[A-Za-z0-9_.-]+$` の 64 文字以内。`retryOnFail: 1` を伴わない `flakyIsPass: true` は
設定エラー）。予約 id に `env-clean` を足した。

**`mutex` は受理するだけでなく実装した。** 受理して無視するのは、拒否より悪い ——
「排他したつもりで並列に走る」は、ポートや DB を共有するゲートを**静かに壊す**。実装は
`mkdir` ベース（`~/.commandmate/locks/<name>.lock`、`owner` に pid / host / token、250ms
ポーリング、上限はそのゲートの `timeoutSec`、**token が一致したときだけ解放**、
**他ホストの pid では stale 判定しない**）。待ちは `waited=<n>s` として **duration とは別の
field** に出す —— 足すと「遅いゲート」と「混んでいたゲート」が同じ数字になる。ロックが空か
ないまま上限に達したら `GATE <id> SKIP reason=mutex-wait waited=<n>s` で、**TIMEOUT でも FAIL
でもない**（何も測っていない）。run は `RESULT skipped` / exit 22 —— 上流は「判定不能」を
exit 99 で表すが standalone の語彙に 99 は無く、22 が既に「ここでは何も検証していない。これは
緑ではない」を意味する。実際に落ちたゲートが在れば 20 が勝つ（**在る裁定は無い裁定より強い**）。

**FLAKY は「たまたま通った」を隠さないための語である**（#224）。`retryOnFail` の再実行は
**1 回だけ**、対象は `FAIL` のみ（TIMEOUT と mutex-SKIP は対象外）、2 回目が裁定に到達しなければ
1 回目の FAIL がそのまま立つ。GATE 行は `FLAKY|FAIL exit=<c1>,<c2> duration=<n>s,<n>s` で、
**`FLAKY` の綴りは `flakyIsPass` で変わらない** —— 変わるのは RESULT と exit code だけである。
「pass にするかどうか」は読み手の設定であって、**観測した事実の側を書き換えてよい理由にはならない**。
機械可読アンカー `[flaky] runs=2 outcome=… verdict=…` は **`outcome=fail`（2 回とも落ちた）でも
書く** —— flakiness の**分母**になるためである。

**`CM_WORKTREE_INDEX` / `CM_WORKTREE_ID` は読むが、払い出さない・上書きしない。** 上流の番号は
worktree ID に紐づいて永続化されている。standalone が別の根拠で振った番号は**同じ worktree に
別の番号**を与えることになり、製品 run が既に握っているポートにゲートを載せる —— **無いより
悪い**。SKILL.md には `${CM_WORKTREE_INDEX:-0}` の書き方を記した。

**`options.requireEnvClean` は受理して報告するが、判定しない。** 組み込み `env-clean` は
タスク作成時に撮ったマシンのスナップショットと比較するゲートで、shell から起動した run は
どのタスクにも紐付いていない —— **ベースラインが存在しない**。`GATE env-clean SKIP
reason=no-baseline` を出して理由を stderr に書き、判定は変えない。有効にした repository の run を
全て緑でなくすのは、**読めない設定（exit 2）を別の読めない設定（決して緑にならない）に
置き換えるだけ**である。

**run の途中で `$WORKDIR` が消えていた**（#228）。ARM64 の self-hosted runner で回帰 suite が
確率的に赤くなり、署名は常に `verify-run.sh: line 734: /tmp/cmate-verify.XXXXXX/gate-<id>.log:
No such file or directory` だった。**Issue 本文の仮説（timeout watchdog の group kill が再利用
された PID / PGID を撃つ）は実測で否定された** —— 53 ゲート中 47 件で `ps -o pgid=` は空を返して
おり、グループ形の kill は長いゲートでしか選ばれず、赤くなった経路は全て素の pid 側だった。

真因は bash の性質である。**fork した subshell では signal handler は reset されるが trap 文字列は
残る。** signal 0（EXIT）は reset の対象外なので、`( ... ) &` の子が fork から自分の signal
disposition を戻すまでの窓で catch 可能な signal を受けると、親から受け継いだ EXIT trap ——
すなわち `rm -rf "$WORKDIR"` —— が**まだ走っている run の作業 directory に対して**実行される。
窓は実測できた: fork 直後に TERM を撃つと 18000 回中 9203 回（51%）trap が発火し、その全件で
subshell の body は 1 命令も走っていなかった（0.05 秒待ってから撃つと 1200 回中 0 回）。速い
ゲートほど `wait` が即座に返り、watchdog を止める `kill -TERM` がほぼ fork 直後に届く ——
これが「毎 run どこかが確率的に赤くなり、落ちるケースが run ごとに変わる」の正体である。

**引き金と結果の両方を塞いだ**（片方ずつでも塞がることを実測してから、冗長に置いた）。
watchdog の停止を `kill -s KILL` にして**死ぬプロセスの中で shell の code が一切走らない**ように
し（実測 18000 回中 TERM 560 件 / KILL 0 件）、EXIT trap を `cleanup_workdir` 関数にして
`BASH_SUBSHELL` が 0 でなければ何もしないようにした（観測された子側の発火 443 件はすべて
`BASH_SUBSHELL=1`。この変数は bash 3.0 から在るので macOS の bash 3.2 でも効く）。
`rga_target` のグループ形は**残した** —— timeout 時に子孫ごと殺す唯一の手段であり、実測の
裏付け無しに外す理由が無い。回帰 case（48 ゲート × 12 run）は、直しを戻すと 20 回中 20 回赤く
なる。Linux/ARM64 と macOS の両方で **20 回連続緑**を確認している。

**互換性。** verify.yaml の形式は v1 のまま（新しいキーは全て任意で、書かなければ挙動は従来
どおり）。stdout の 1 ゲート 1 行という形も、exit code の意味も変えていない —— **`FLAKY` という
label と `waited=` / `[flaky]` という field が増えただけ**である。読む側（`cmate-orchestrate`
0.32.0 / `cmate-verify-advisor` 0.3.0）は同じ release で追随した。
