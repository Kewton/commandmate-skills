# cmate-verify-advisor リリースノート（なぜ今の挙動なのか）

この file は「何が起きたか → だからこう変えた」の**経緯の記録**である。**契約の正本ではない**
—— 何を受理し、何を書き、何を書かないかの正本は [SKILL.md](../SKILL.md) と
[change-classification.md](./change-classification.md)（非対称ルール）/
[layer1-adjustments.md](./layer1-adjustments.md)（調整式）/ [layer2-review.md](./layer2-review.md)
（層 2 の手順）であり、食い違ったらそれらが正しい。

**この file は 0.3.0 から始まる。** 0.2.0 までの経緯を遡って書き起こしてはいない（無かった
ものを後から作ると、書いた人の記憶が実測より強くなる）。それ以前は commit 履歴と
`tests/fixtures/cmate-verify-advisor/README.md` を読むこと。

---

## Changelog

### 0.3.0 — 新しいキーを読め、mutex の待ちを timeout の根拠にせず、flake を「実測」と「推定」に分ける（Issue #223 / #224）

**読めない verify.yaml には、助言のしようが無い**（#223）。上流 CommandMate #1771（gate 単位の
`mutex` と worktree ごとの env 注入）/ #1772（FLAKY を一級の outcome にする）/ #1740
（`options.requireEnvClean`）が着地したあと、この advisor の parser だけが取り残された ——
`mutex:` / `retryOnFail:` / `flakyIsPass:` / `requireEnvClean:` を書いた file は **exit 2** に
なり、助言は 1 件も出なかった。**この package が最も要る repository（並列 worktree で
共有資源を持つ repository）が、ちょうど読めない側に落ちる**という形の欠陥である。

受理集合と値域を `cmate-verify` 0.5.0 と同一にした。両者が同じ集合を受理することは、
リポジトリの parser-parity テスト（Issue #57 / #69）が測っている —— **awk の parser と JS の
parser が同じ file について同じ判定を出す**ことが、この package の前提だからである。

**受理は「書いてよい」を意味しない。** `requireEnvClean` は defaults / `classifyChange` /
`assertNoWeakening` を通し、`mutex` / `retryOnFail` / `flakyIsPass` は**層 1 が書ける変更では
ない**として内部ガードで書き込みを禁じた。`mutex` は「どの資源を共有しているか」という
**リポジトリの事実**の宣言で、履歴の統計から導けるものではない。落とせば静かに並列化し、
`flakyIsPass` を上げれば静かに合格の定義が緩む —— どちらも
[change-classification.md](./change-classification.md) の非対称ルールが層 1 から締め出す種類の
変更である。

**mutex の待ちを timeout 短縮の根拠にしない**（#223、層 1）。`[mutex] … waited=` は duration
系列から**外したまま**集計する（待ちは「遅いゲート」ではない）。そのうえで、**待ちが 1 度でも
観測されたゲートには timeout の短縮を提案しない** —— `mutex` 付きゲートの `timeoutSec` は
**ロック待ちとコマンド実行の 2 つの予算**であり、待ちを除いた数から縮めた値は、混雑を
`GATE <id> SKIP reason=mutex-wait`＝**裁定に到達しないゲート**に変える。削った slack より悪い。
延長の提案は従来どおり出し、**待ちを除外して計算したことは rationale に書く**（畳み込まない ——
読み手が「その数に待ちが入っていない」ことを見られなければ、提案を評価できない）。

**flake を「実測」と「推定」の 2 段にした**（#224、層 2）。従来の `flake-candidate` は run を
またいだ fail→pass から**推定**するもので、`verify history` に commit sha が無い以上
「直った」との区別が付かない —— だから自動隔離をせず人間に返す、という設計だった。#1772 以降は
**同じ木での再実行**という実測が在る: `[flaky]` アンカーと `--json` の `gates[].flaky` である。
新しい `OBSERVATION flake-observed` はこれを**分母つきで**述べ、実測が在るゲートについては
推定（`flake-candidate`）を出さない。**同格に並べないため**であり、
[layer2-review.md](./layer2-review.md) 第 2.0 節に「推定が消えたことを『flake が減った』と
読まないこと」と明記した。**どちらも自動では何も書かない** —— 層 2 は提案のみである、という
非対称ルールは 1 バイトも動いていない。

**互換性。** 出力の形（`OBSERVATION` 行・proposals JSON・exit code）と非対称ルールは従来どおりで、
**新しいキーを書かない verify.yaml に対する挙動は不変**である。増えたのは受理集合と、
`flake-observed` という 1 つの観測種別、そして timeout 提案の rationale の 1 文である。
