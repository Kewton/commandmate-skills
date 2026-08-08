---
name: cmate-orchestrate
description: 複数の GitHub Issue を並列で進める。dry-run で依存と file 衝突を解いた Wave plan を作り、承認後に監督付きで dispatch し、検証 pass したものだけを PR/merge し、UAT で受入を確認する4段の runner。run の状態は read-only の status runner が phase × Issue のマトリクスで出す。
---

# cmate-orchestrate（plan → dispatch → merge → uat）

> **ランチャー表記** — 本文中の `commandmate …` は**読み替え可能**である。グローバル導入をしない
> npx 運用では `npx commandmate@latest …` と読む。同梱 runner（dispatch / uat）は `--cli <launcher>`
> または環境変数 `CM` で解決する（既定 `commandmate`、`npx commandmate@latest` のようなスペース
> 区切りの複数トークンも可。シェルは経由しないので、パイプ・リダイレクト・変数展開・引用符は
> 助言つきで拒否する）。ランチャー解決は実行時の話であり、**plan.json には混入しない**。呼び出し
> 頻度が高い経路では npx の起動コスト（1 回あたり 0.5〜0.9 秒）を避けるため、
> `~/.local/bin/commandmate` に `exec npx --yes commandmate@latest "$@"` の薄いラッパを置く導入
> 形態を推奨する（README の「CommandMate CLI の導入形態」）。

複数の Issue を並列で進めるための、**計画**・**監督付き実行**・**PR/CI/merge**・
**UAT と回数上限つき修正ループ** を安全に行う手順である。実務は4つの
**deterministic runner**（Node stdlib のみ）が行う。

runner は決定的なので、この文書が述べるのは「いつ使うか・どう呼ぶか・出力をどう読むか・
止まったら何をするか」の4点だけである。**各 runner が何をどう保証しているかの正本は
`references/*-contract.md`** で、この文書はそこへ一方向に参照する。なぜその挙動なのかは
[references/release-notes.md](./references/release-notes.md)。

| runner | script | 役割 | mutation | 契約の正本 |
|---|---|---|---|---|
| plan | `scripts/orchestrate.mjs` | dry-run で Wave plan を生成する。**default invocation** | なし | [plan-contract.md](./references/plan-contract.md) |
| dispatch | `scripts/dispatch.mjs` | 承認済み plan を worker へ配り、Wave barrier と verification gate で監督する | あり | [dispatch-contract.md](./references/dispatch-contract.md) |
| merge | `scripts/merge.mjs` | 検証 pass した Issue を PR 作成 / guarded merge する | あり（承認時） | [merge-contract.md](./references/merge-contract.md) |
| uat | `scripts/uat.mjs` | 受入テストと、不合格時の回数上限つき修正ループ | あり（承認時） | [uat-contract.md](./references/uat-contract.md) |

これに、**mutation を一切しない read-only の view runner** が付く。phase の一部ではなく、
上の4つが残した artifact を読むだけである。

| runner | script | 役割 | mutation |
|---|---|---|---|
| status | `scripts/status.mjs` | run directory の artifact を突き合わせ、phase × Issue のマトリクスを出す | **なし（read-only）** |

`scripts/lib.mjs` は共有ヘルパーで、単体では起動しない。
`scripts/profile-init.mjs` は phase ではなく、**最初に1回だけ使う準備 runner** である
（内蔵 profile 以外のリポジトリ向けに profile draft を起案する。第3.5節・
[profile-contract.md](./references/profile-contract.md) 第7節）。

## 1. いつ使うか / 使わないか

**使う**: 着手前に Issue 間の依存と file 衝突を解いておきたいとき。複数 Issue を並列に worker へ
配り、前段が壊れていないことを確認しながら段階的に進めたいとき。納品と受入まで同じ gate の下で
通したいとき。**走っている / 走り終えた run が今どこにいるかを知りたいとき**（`status.mjs`。
read-only なので、いつ何回呼んでも run に影響しない）。

**使う（続き）**: **Wave 途中で一部の Issue だけが落ちた run を再開したいとき**
（`dispatch.mjs --resume`。第3.2節。completed かつ verification pass の Issue は再 dispatch せず、
その verification 記録だけを引き継ぐ）。

**使わない（スコープ外）**: Issue 本文の自動編集。回数無制限のループ。cross-model review。
どの mutating runner も、明示承認・verification pass・CI pass の gate 無しに mutation を行わない。
`--resume` も上限つき（`uat` の `--max-attempts` と同じ設計）ではなく**人間が明示的に叩く**もので、
runner が自分で再試行ループを回すことはない。

## 2. 前提条件

**CLI**: `commandmate`（`>=0.11.0 <1.0.0`）・`git`・`gh`・`node >=22`。宣言している権限は
`filesystem_read` / `filesystem_write` / `process_execution` / `network_access` で、これは
orchestration 全体が要求する集合である（plan にも同じ集合を提示する）。base branch・branch 名・
worktree path・baseline は **profile から解決**し、`develop`/`npm`/`cargo` を hardcode しない
（[profile-contract.md](./references/profile-contract.md)）。内蔵 profile
（`node-commandmate` / `rust-commandagent`）以外のリポジトリで使うなら、まず
`scripts/profile-init.mjs` で profile draft を起案する（第3.5節）。

**worktree**: dispatch は worktree を**作らない**。dispatch 対象 Issue の worktree が事前に存在し、
`commandmate ls` で解決できること。無ければ
[cmate-worktree-setup](../cmate-worktree-setup/) で作成する。branch 名を一致させるため、
**cmate-worktree-setup と本 skill には同じ profile（同じ `branch_template`）を渡す**こと
（片方だけ既定 profile で走らせると branch がずれ、`commandmate ls` の branch 一致で解決できない）。
解決できない Issue があると、dispatch は**最初の Wave の前に停止する**: `worktree_unresolved` で
1人も dispatch せず、`--out` も作らない（第5節。worktree を作って同じコマンドを再実行すればよい）。
1つのコマンドで通したいなら `--prepare-worktrees --worktree-setup <launcher>` を渡す（第3.2節）。
**その場合も worktree を作るのは `cmate-worktree-setup` であって dispatch ではない**（合成であって
再実装ではない）。profile は plan のものが provider にそのまま渡り、二重指定は拒否される。
なお `commandmate ls` が解決できなかったとき、dispatch は run 全体で1度だけ
`commandmate sync`（CommandMate 0.21.0+ の server 側 worktree 再スキャン）を試して `ls` を読み直す。
**sync は worktree を作らない**ので「未作成」は解決しないが、「**disk には在るが server 未登録**」
（server 起動後に `git worktree add` した等）はこれで解決する。試行結果は `limitations` に残り、
それでも未解決なら上記の停止になる。

**条件付き依存の Skill**（既定では使わない。使う phase を明示的に選んだときだけ要る）。

| Skill | いつ要るか | 未導入だとどうなるか |
|---|---|---|
| [cmate-acceptance-test](../cmate-acceptance-test/) | uat の**意味ゲート**を使うとき | orchestrate は動くが **UAT の裁定は機械ゲートだけ**になる。report の `limitations[]`（`acceptance_not_run`）に記録される |
| [cmate-worktree-setup](../cmate-worktree-setup/) | dispatch の **`--prepare-worktrees`** を使うとき | **停止する**（`limitations` ではなく `blocking_reasons` の `worktree_setup_unavailable`）。1人も dispatch せず `--out` も作らない |
| [cmate-worker-development](../cmate-worker-development/) | dispatch の **`--worker-method`** を使うとき | **停止する**（`limitations` ではなく `blocking_reasons` の `worker_method_unavailable`）。最初の Wave なら1人も dispatch せず `--out` も作らない |

```bash
commandmate skill install cmate-acceptance-test
commandmate skill install cmate-worktree-setup
commandmate skill install cmate-worker-development
```

3つとも**黙って劣化しない**という型は同じだが、結果は違う。意味ゲートは未導入でも機械ゲートで
裁定できるので**続行して記録**する。worktree 準備は、準備できなければ **dispatch する対象が
存在しない**（続行しても全 Issue が「worker を起動できないまま failed」になるだけ）なので**停止**する。
理由は [references/adr-worktree-preparation.md](./references/adr-worktree-preparation.md) 第5節。

方法論も**停止**する側である。`--worker-method` を指定した run は「**方法が揃っていること**」を
前提にした run であり、揃わないまま走らせればその前提が偽のまま wave が進む。停止のコストは
`commandmate skill install <id>` と**同じコマンドの再実行**だけで、`--out` は消費していない。
理由は [references/adr-worker-development-skill.md](./references/adr-worker-development-skill.md) 第3.4節。

**`--worker-method` の判定は「両 root に在ること」である。** CommandMate は Skill を
`.claude/skills/<id>/`（Claude が読む）と `.agents/skills/<id>/`（Codex が読む）の両方へ
byte-identical に配備し、**dispatch はどちらの Agent が worker になるかを知らない**
（`send --agent` を一度も渡さず、`ls --json` の row も agent を持たない）。片側だけの worktree を
「入っている」と読むと、worker が構造的に開けない file を「これを読め」と契約に書くことになる。
片側だけ在る場合はその旨が blocking reason の detail に出る（「無い」と「半分ある」は別の情報である）。

未導入の環境では本書中の `../cmate-acceptance-test/...` / `../cmate-worktree-setup/...` /
`../cmate-worker-development/...` への相対リンクが解決しない。
**リンク切れ自体が「まだ入れていない」ことのサイン**である。
plan / merge はどの Skill にも依存しない。dispatch が `cmate-worktree-setup` /
`cmate-worker-development` に依存するのは、それぞれ `--prepare-worktrees` /
`--worker-method` を指定したときだけである（どちらも既定 off）。

---

## 3. 呼び出し方と呼び出し順

**plan → （人間の承認）→ dispatch → merge / uat** の順に、別々の invocation で呼ぶ。
1つの runner が次の phase を勝手に始めることはない。

**承認つき運転が既定である。** 人間が plan を読んでから dispatch を叩き、mutation を許すのは
`--approve` を書いた invocation だけ、という運転がこの Skill の標準形である。
`--unattended`（第3.2節）はその**代替ではなく、同じ規律を人間の居ない環境で成り立たせるための宣言**で
あって、**外すのは「人間の待ち」だけ・ゲートは1つも外さない**。承認つき運転が守っていたのは
「人間が読む」ことそのものではなく **人間が読むまで壊れた状態が下流へ流れないこと**であり、
無人でそれを維持する方法は承認を機械に代行させることではなく、
**人間に提示して待つ経路を、その場で止まる経路に変換すること**である。
**無人運転の driver は CI の job 定義（または cron script）であって runner ではない。**

### 3.1 plan（dry-run。既定の入り口）

```
orchestrate.mjs <issue>... [options]
```

| flag | 既定 | 効果 |
|---|---|---|
| `--issues a,b,c` | — | Issue 番号（positional でも可）。1件以上 |
| `--profile <id>` | `node-commandmate` | 内蔵 profile。`node-commandmate` / `rust-commandagent` |
| `--profile-json <path>` | — | 独自 profile |
| `--issue-json <path>` | — | Issue fixture。offline・決定的に回す |
| `--base <ref>` / `--repo <owner/name>` | profile 由来 | 上書き。**`--repo` は profile の `verified` を降格させる** |
| `--max-parallel <1-3>` | `3` | 1 Wave の最大幅 |
| `--depends <a:b>` / `--no-infer` / `--order <a,b>` | — | 依存の override / 推論無効化 / 順序の主張 |
| `--run-id <id>` | 入力 hash（**Issue 内容を含む**） | run_id の明示 |
| `--runs-dir <path>` | `.commandmate/orchestrate/runs` | artifact の出力先 |
| `--allow-unverified` | off | unverified profile での planning を許可 |

`--issue-json` が無ければ read-only の `gh issue view` で Issue を取得する。これが planner
唯一の network access である。**契約の入力は number / title / body / labels だけで、
コメントは読まれない。** コメントで決めた内容は **dispatch 前に Issue 本文へ畳み込んでから**
plan を作ること（本文の精錬には cmate-issue-refinement が使える）。

`<runs-dir>/<run_id>/` に `plan.json`・`result.json`・`manifest.md`・`issue-analysis.md`・
`dependency-plan.md` を書き、run directory が既にあれば上書きせず `run_exists` で終了する。
既定 run_id は Issue 内容を含む hash なので、**本文を直して再 plan すれば自動的に別 run** になる。
plan は「入力 + cwd の origin」の純粋関数で、**同一入力からは同一 plan が出る**（Claude/Codex
parity）。`--run-id` を固定して2つの `--runs-dir` に出し `plan.json` を `diff` すれば確認できる。

### 3.2 dispatch（監督付き実行）

```
dispatch.mjs --plan <承認済み plan.json> [options]
```

| flag | 既定 | 効果 |
|---|---|---|
| `--plan <path>` | **必須** | planner が出した承認済み `plan.json` |
| `--out <dir>` | `<plan-dir>/dispatch` | artifact の出力先。既存なら `out_exists`。`--resume` とは排他 |
| `--resume <dir>` | — | 部分失敗した run の再開。`<dir>` は再開対象の `--out`。**pass 済みは再 dispatch せず記録だけ引き継ぐ**（後述） |
| `--cli` / `--git` / `--gh <path>` | `commandmate`/`git`/`gh` | 実行する CLI |
| `--auto-yes` | **off** | worker prompt を自動応答する。既定は停止して human へ提示 |
| `--allow-questions` | **off** | 未回答 question を持つ Issue を含む plan を dispatch する |
| `--unattended` | **off** | **人間が居ないことの宣言。締め付けだけを含意し、権限は1つも足さない**（後述）。`--approve` を含意しない。緩和フラグとの併用は `invalid_input` |
| `--wall-clock-budget <sec>` | **off** | run 全体の壁時計上限。到達で `partial` / `stop_reason: timeout`。`--unattended` では**必須** |
| `--prepare-worktrees` | **off** | pre-flight で未解決だった worktree を `cmate-worktree-setup` に作らせてから続行する。既定 off＝従来どおり停止 |
| `--worktree-setup <launcher>` | — | 上記 provider の呼び出し口（`--cli` と同じ argv 規約）。`--prepare-worktrees` 無しに渡すと `invalid_input` |
| `--worker-method <skill-id>` | **off** | worker が従うべき開発スキル（例 `cmate-worker-development`）を名指しする。**install を実測してから** dispatch し、無ければ停止する。契約 goal と worker prompt の**両方**に `## Method` 節が入る。**渡さない run は 1 bit も変わらない** |
| `--contract-mode <m>` | `auto` | `auto` / `require`（フォールバック拒否）/ `off`（probe せず baseline 裁定） |
| `--verify-gates <ids>` | 省略＝全ゲート | 契約の `verify.gates` に載せる gate id。**存在しない id を発明しない**。run 全体に1つ。Issue 側の `require:` とは**和集合**を取る（絞り込みが Issue の要求を落とすことは許さない） |
| `--expect-branch <name>` | — | plan 承認時の統合 branch。不一致なら drift |
| `--wait-timeout <sec>` | `300` | `commandmate wait` の1回あたり timeout |
| `--max-turns <n>` | `8` | 各 worker を駆動する最大ターン数。未 commit で到達なら `failed` |

`commandmatedev` は使わない。公式経路は public `commandmate` である（ADR CommandMate
[#1447](https://github.com/Kewton/CommandMate/issues/1447)）。

呼ぶ前に押さえておく **3つの不変条件**（詳細と根拠は
[dispatch-contract.md](./references/dispatch-contract.md)）:

1. **open question ゲートが最初に効く。** 未回答の planner question を持つ Issue が1件でも
   あれば、**1人も dispatch せずに停止する**。直し方は「Issue 本文に回答を書いて re-plan」。
2. **裁定と完了は別物である。** 裁定の ground truth は `wait --verify` の exit code、完了の
   ground truth は **worktree ブランチの新規 commit** である。worker は各ターン後に idle 化する
   ので、`wait` の idle を完了とみなさない。
3. **Wave barrier と verification gate。** 全 worker が `completed` かつ verification pass に
   なるまで次 Wave へ進まない。**worker completion を verification success と同一視しない。**

**worktree 準備段（`--prepare-worktrees`。既定 off）** — pre-flight が `worktree_unresolved` だけを
理由に止まるとき、`--worktree-setup <launcher>` で渡した
[cmate-worktree-setup](../cmate-worktree-setup/) provider を **plan と同じ profile / base で1回だけ**
呼び、`commandmate sync` で registry を再スキャンしてから pre-flight をやり直す。

- **dispatch は `git worktree add` を実行しない。** 作成・collision 検査・base SHA 再確認・
  baseline は provider の責務で、この runner は結果（`worktree-setup.result.v1`）を検証するだけである。
- **一部しか作れなければ、作れた分だけを dispatch しない。** 未解決 Issue について従来どおり停止する。
- **失敗しても、作ってしまった worktree を消さない。** 後始末は human と
  [cmate-worktree-cleanup](../cmate-worktree-cleanup/) の担当である。
- **未導入・呼び出し不能なら停止する**（`worktree_setup_unavailable`）。黙って既定の fail-fast に
  戻ることもしない。対象は**最初の Wave の Issue だけ**で、2つ目以降の Wave の worktree が無い場合は
  従来どおりその Wave で止まる。

規則の正本は [dispatch-contract.md](./references/dispatch-contract.md) 第3.0.1節、
裁定の記録は [adr-worktree-preparation.md](./references/adr-worktree-preparation.md)。

**ワーカー側の方法論（`--worker-method`。既定 off）** — 契約が worker へ渡すのは、これまで
**WHAT（目的・受入条件・境界）と制約だけ**で、**HOW を渡す口が無かった**。
`--worker-method <skill-id>` はその口である。渡すと、task text の `## Objective` の直前に
`## Method` 節が1つ入り、**どの Skill を読むか・どこに在るか・無ければ止まれ**の3つだけを書く。

- **足すのは「方法」であって「権限」ではない。** ゲートを緩めず、`scope.allow` を広げず、
  push / PR の権限を与えない。**方法論と契約が食い違ったら契約が勝つ**と節自身が明記する。
- **install を実測してから dispatch する。** 対象 worktree の
  `.claude/skills/<id>/SKILL.md` と `.agents/skills/<id>/SKILL.md` の**両方**を読み、
  在ることを確かめる。無ければ `worker_method_unavailable` で**停止**する（第2節）。
  最初の Wave なら `--out` を作る前なので、**install して同じコマンドを再実行**すればよい。
- **all-or-nothing である。** install 済みの worker だけ方法論つきで走らせ、残りを素通りさせない。
  方法が worker ごとに違う wave では「全部通った」の意味が run ごとに変わる。
- **契約 goal と worker prompt の両方に入る。** 片方だけだと `--contract-mode auto` が
  契約非対応 CLI にぶつかったときに方法論だけが黙って消える。
- **方法論の要約は runner に持たせない。** 節が書くのは skill 名と path だけなので、
  方法が変わっても `cmate-orchestrate` を再リリースしなくてよい。
- **既定では何も起きない。** 指定しない run は、この機能が存在しなかった頃と **byte 一致**する
  （Skill が install 済みの worktree であっても、勝手に on にはならない）。
- 証跡は `dispatch_schema_version` を上げずに `limitations[]` で運ぶ:
  `worker_method_declared`（run 全体で1件）と `worker_method_applied`（Issue ごとに1件）。
- **「適用された」と「守られた」は別の事実である。** dispatch が測れるのは
  ①宣言した ②skill が worktree に在った ③契約に書いた の3つだけで、
  **worker が実際に方法論に従ったかは測っていない**。遵守の証拠は worker の成果物側にあり、
  機械で測りたいなら Issue の `acceptance-gates` が正しい場所である。

規約の正本は [dispatch-contract.md](./references/dispatch-contract.md) 第1節・第3.0節、
裁定の記録と実測は
[adr-worker-development-skill.md](./references/adr-worker-development-skill.md)。

**Issue が名指しした受入ゲート（`acceptance-gates` ブロック）** — Issue 本文に置かれた
```acceptance-gates ブロックの `require:` は、その Issue の裁定に**必ず参加しなければならない**
gate id の宣言である。ここまで `verify.gates` は operator の run 単位フラグでしか動かせず、
Issue ごとに違うゲート集合を要求する方法が無かった。

- **明示ブロックだけを運ぶ。散文からは何も生成しない。** `test_expectations`（Issue 本文の
  backtick から拾ったコマンド）は従来どおり**助言的**で、裁定には使われない。引用は指示ではなく、
  抽出結果は profile にも依存するので、裁定の根拠にできない。
- **planner は構文しか見ない。** id が実在するかは dispatch が worktree の
  `.commandmate/verify.yaml` に突き合わせ、**`send` する前に**拒否する
  （`acceptance_gate_id_unknown`）。`send --contract` の exit 2 には落とさない。
- **`require:` だけでは `verify.gates` を書かない。** 書くと「そのゲートだけ走らせる」になり、
  lint も test も走らなくなる — 受入条件を足したつもりで判定が弱くなる。キーを省略したまま
  全ゲートを走らせるほうが厳しい。
- **壊れたブロックは「無かったこと」にしない**（`acceptance_gate_block_invalid`）。
  `gates:`（新規コマンドの宣言）は記法としては予約済みだが**この release は実行しない**ので、
  黙って無視せず停止する（`acceptance_gate_block_unsupported`）。
- report の `verification.gates[].origin` に由来（`repo` / `issue`）が残る。**欠落は
  「記録されていない」であり `repo` ではない。**

記法の正本は [acceptance-gates-notation.md](./references/acceptance-gates-notation.md)、
dispatch 側の規約は [dispatch-contract.md](./references/dispatch-contract.md) 第2.9節、
裁定の記録と実測は [adr-issue-acceptance-gates.md](./references/adr-issue-acceptance-gates.md)。

**部分失敗からの再開（`--resume <前回の --out>`）** — 並列開発では Wave 途中の1 Issue だけが
落ちるのが常態である。`--resume` は前回 run の**最新 report** を読み、次のように分ける。

- **引き継ぐ**: `worker_state: completed` **かつ** `verification.outcome: pass` の Issue。
  **再 dispatch しない。** その verification 記録（`ran` / `gates` / `checks`）を新 report に
  **転記する**（ここで再判定はしない）。merge / uat はこの2 field しか読まないので、
  引き継いだ Issue はそのまま eligible のままである。
- **再実行する**: それ以外（`failed` / `timeout` / `prompt` / `not_dispatched` / pass でない
  verdict / 記録が無い）。
- **Wave barrier は再計算する。** 全員引き継ぎの Wave は 1件も dispatch せず即座に advance する
  ので、**依存元が pass 済みの Issue は待たされない**。引き継ぎ Issue の worktree は解決を要求
  されない（merge 済みで消えていてよい）。
- **停止条件・裁定規則は通常 dispatch と完全に同一である。** exit 0/7/1、Auto-Yes 既定 off、
  mutating wave 前の drift 再確認、verification gate — どれも緩めない。
- **artifact は上書きしない。** attempt 1 は `<out>/dispatch-report.json` のまま、attempt N は
  `<out>/resume-attempt-N/dispatch-report.json` に append される。`<out>/attempt-history.jsonl`
  に attempt 1行ずつの台帳が残る。**merge / uat / status には最新 attempt の report を渡す**
  （引き継ぎ分も再実行分も、その1本に揃っている）。
- **別 plan の report では resume させない。** `run_id` / repository / base が `--plan` と
  一致しなければ `resume_plan_mismatch`、report が `dispatch-report.v1` として読めなければ
  `resume_invalid` で、どちらも**何も dispatch せず・何も書かずに**拒否する。
- 再実行対象が1件も無ければ、`resume_no_work` を明示して **CLI を1回も叩かずに** exit 0 で終わる。

規則の正本は [dispatch-contract.md](./references/dispatch-contract.md) 第8節。

契約経路では plan だけから **実行契約 yaml** を決定的に生成して worktree に置き、
`commandmate send <worktree-id> --contract <path>` で dispatch する（**同一 plan → byte-identical
な契約**）。契約非対応の CLI では明示メッセージつきで profile baseline 再実行に落ちるか、
`--contract-mode require` なら停止する。**どちらの裁定機構で判定したかは常に report と summary に
明示される**（黙って劣化しない）。

**無人運転（`--unattended`。既定 off）** — CI / cron から人間の居ない環境で dispatch を回すための
**入力の宣言**である。**mutation の権限を与えるフラグではない。**

- **含意するのは締め付けだけである。** ゲートを1つも無効化せず、blocking を limitation に格下げせず、
  status を1段も上げない。停止理由・status・exit の写像（第4節）は1文字も変わらない。
  全 gate が pass する世界では、**フラグ無しの run と同じ `status` / `stop_reason` / `waves[]` になり、
  差分は下の2つの limitation だけ**である（fixture で機械的に固定してある）。
- **`--approve` を含意しない。** merge / uat を無人で回す CI は**両方**書く。
  「無人だから安全側に倒したい」つもりで付けたフラグに mutation 権限が付いてくることは無い。
- **緩和フラグとの併用は `invalid_input`（exit 3）で拒否する。** `--auto-yes`（prompt 停止が
  構造的に到達不能になる）・`--allow-questions`（引き受ける主体が居ないときに立てられる旗ではない）・
  `--contract-mode off｜auto`。**黙って上書きしない** —— どちらの宣言が勝ったかを、report の読み手
  （無人運転では次の job）が判定できなくなる。
- 含意する締め付けは5つ: **①`--contract-mode require`**（フォールバック経路には scope ゲートが
  存在しないので、scope 必須化と契約必須化は同義である）／**②pre-flight で plan 全 Issue の scope 宣言を
  all-or-nothing 検査**（1件でも欠ければ **1人も dispatch せず・`--out` も作らずに**停止。未回答 question も
  同じ pre-flight で報告する）／**③worktree 単位の排他 lock**（2本目の run を拒否する。`--out` は
  mutex にならない）／**④`--wall-clock-budget` の明示必須**（回数は有界でも時計は有界でない）／
  **⑤`unattended_baseline` の記録**（各 worktree の開始時 HEAD を branch 名と短縮 SHA で残す）。
- **runner は次の phase を始めない。** 無人運転の driver は **CI の job 定義（cron script）**であって
  runner ではない。plan → dispatch → merge → uat を1コマンドで回す5つ目の runner は作らない。
- **job 定義側で置くべき環境変数が2つある。** `GH_TOKEN`（または `GH_ENTERPRISE_TOKEN`）と
  **`GIT_TERMINAL_PROMPT=0`**。実測（[#115](https://github.com/Kewton/commandmate-skills/issues/115)）に
  よれば `gh` は TTY が無いことを自分で判定して待たずに落ちるので停止を足す必要は無いが、
  **`git push` の資格情報プロンプトだけは別**で、制御端末を持つ起動元（tmux ペインから起動した cron 等）
  では「止まる」ではなく**無言で待つ**に化ける。runner はこれを検査しない（別プロセスの環境を
  runner は保証できない）。
- 証跡は `dispatch_schema_version` を上げずに `limitations[]` で運ぶ: `unattended_mode`（run 全体で1件。
  停止した run にも残る）と `unattended_baseline`（Issue ごとに1件）。

規約の正本は [dispatch-contract.md](./references/dispatch-contract.md) 第3.0.3節・第3.0.4節、
裁定の記録と実測は [adr-unattended-mode.md](./references/adr-unattended-mode.md)（特に第2節の裁定 0、
実測の第14節、実装差分の第15節）。**段階 A は dispatch のみ**で、merge / uat に `--unattended` を
渡すと `invalid_input` で落ちる（受理して無視すると、CI は自分が守られていると誤解する）。

**監視の一次はこの `wait` ループである**（[cmate-orchestrate-monitor](../cmate-orchestrate-monitor/)
との境界）。契約付き dispatch の裁定と nudge はこの runner が行う: ブロッキングな
`wait --on-prompt agent --verify` の **exit code 分岐**（0 / 10 / 20 / 21 / 99 / 124）で判定し、
`send` / `respond` でサーバ経由で促す。**マージ可否の裁定もここである。** monitor は別機構
（`capture --json` のポーリング分類 + tmux 直接介入）の**サイドカー**で、`wait` に見えない事象
——rate limit / credits バナーからの復帰、リトライ枯渇死の再送、製品の prompt 検出に載らない
プロンプト、契約なし委任や他所から投げた worker、`wait` がブロックしている間の可観測性——の
回収に使う。**統合も廃止もしない。** 併用するなら monitor 側に `--no-auto-approve` を付ける
（prompt に答えてよいかを決めるのは契約の autoYes ポリシーであって監視ループではない）。

**`--unattended` と monitor を併用するなら、monitor 側の `--no-auto-approve` は推奨ではなく要件である。**
[#115](https://github.com/Kewton/commandmate-skills/issues/115) が実測した理由による: 契約の
`autoYes: mode: off` は**サーバ自身の**自動応答を確かに止めるが、monitor の Enter は `tmux send-keys` で
ペインへ直接届くのでその方針の外側にある。しかも monitor がその方針を読んで手を止められるのは
`capture --json` に `autoYes.lastSuppression` が在るときだけで、それが書かれるのは**サーバ側 Auto-Yes が
有効なとき** —— すなわち **unattended が禁じているまさにその状態のとき**だけである。
unattended dispatch が実際に作る payload（`autoYes.enabled: false`）に対する monitor の判定は
**`approve`**（＝ `rm -rf` の確認プロンプトにも Enter を送る）になることが実測されている。
**「サーバ側が最後の砦になる」という緩和はできない。** dispatch runner はこれを検出しない
（別プロセス・別 Skill・別 install であり、検出できないものを検出したふりをしない）。

### 3.3 merge（PR 作成 / guarded merge）

```
merge.mjs --plan <plan.json> --dispatch <dispatch-report.json> (--create-prs | --merge-prs) [options]
```

**1 invocation で mutating phase をちょうど1つ**だけ有効化する。両方指定・どちらも未指定は
`invalid_input` で拒否する。

| flag | 既定 | 効果 |
|---|---|---|
| `--dispatch <path>` | **必須** | eligible の唯一の根拠 |
| `--create-prs` / `--merge-prs` | どちらか1つ | PR 作成 / CI 確認付き guarded merge |
| `--approve` | **off** | 明示承認。無ければ mutation しない preview |
| `--merge-method <m>` | `squash` | `merge` / `squash` / `rebase` |
| `--out <dir>` | `<dispatch-dir>/<phase>` | 出力先。既存なら `out_exists` |
| `--gh` / `--git <path>` | `gh`/`git` | 実行する CLI |

対象は dispatch report で **`completed` かつ verification `pass`** の Issue **だけ**である
（verification gate の継承）。`--approve` 無しに push・PR 作成・merge は一切しない。
merge するのは CI checks が**すべて green** のときだけで、failure は `ci_failed`、
pending・check 0 件は `ci_pending` として **merge を拒否**する。

#### PR 本文は「検証証拠の提出」である

`create_prs` が書く PR 本文（`<out>/pr-bodies/issue-<n>.md`）の Verification 節は、
**定型文ではなくこの Issue の実測値**である。人間が見るのは PR だけなので、証拠が
run ディレクトリの JSON の中にしか無い状態を残さない。

| 載せるもの | 出どころ |
|---|---|
| verdict（`verification.outcome`）と、走っていない場合（`ran: false`）の明示 | dispatch report の当該 worker |
| gate 名・合否・exit code の表 | 同 `verification.gates` / `checks`（`gate <id>: … (exit n)` から exit を拾う） |
| 宣言 scope（`scope.allow` = plan の対象 file）と実変更 file の対比表、**scope 外変更の件数** | plan の `suspected_files` と、worktree で実行した `git diff --name-only <base>...<branch>` |
| diff 規模（file 数・追加/削除行数）1行 | 同 worktree の `git diff --numstat` |

規則:

- **転記であって主張ではない。** 値は全て `redact()` を通す（dispatch report は入力であり、
  redact 済みだと仮定しない）。
- **読めなかったものを pass に丸めない。** worktree が既に片付いていて diff が読めなければ
  「読めなかった」と本文に書き、limitation `change_evidence_unavailable` を記録する。
  `ran: false` の verdict も同様に「検証は走っていない」と明示する。
- **黙って切り詰めない。** gh の本文上限（65536 字）に収めるため gates/checks/path の一覧は
  上限件数で打ち切るが、**打ち切った件数を本文に明記する**。
- 実変更が宣言 scope の外に出ていれば本文でその path を名指しし、limitation
  `branch_changed_outside_declared_scope` を記録する（契約ゲート `requireScopeClean` の
  人間可読版。phase は止めない）。

merge-report.json / merge-summary.md の構造は変わらない。

### 3.4 uat（受入テストと回数上限つき修正ループ）

```
uat.mjs --plan <plan.json> --dispatch <dispatch-report.json> (--write-uat | --create-uat-fix-worktrees) [options]
```

こちらも **1 invocation で phase をちょうど1つ**である。

| flag | 既定 | 効果 |
|---|---|---|
| `--write-uat` / `--create-uat-fix-worktrees` | どちらか1つ | read-only の受入判定 / 修正ループ |
| `--approve` | **off** | fix loop の明示承認。無ければ preview |
| `--max-attempts <1-5>` | `2` | fix 試行の回数上限。ループはこれを超えない |
| `--acceptance-dir <dir>` | — | 意味ゲートの入力（`issue-<n>.json`）を置いた directory |
| `--require-acceptance` | off | result の欠落・不適合・Issue 不一致を limitation ではなく**不合格**にする |
| `--out <dir>` | `<dispatch-dir>/<phase>` | 出力先。既存なら `out_exists` |
| `--cli` / `--git` / `--gh <path>` | `commandmate`/`git`/`gh` | 実行する CLI |

裁定は **機械ゲート（profile baseline）+ 意味ゲート（受入条件の Go / Conditional Go / No-Go）の
二層**である。**意味ゲートの判定を出すのはエージェント側の手順であり、uat runner は result
document を検証して合成するだけである**（runner 内で LLM 判定はしない）。合成規則の全表は
[uat-contract.md](./references/uat-contract.md) 第4.2節。

**意味ゲートを使うときのエージェント手順**（uat runner を呼ぶ前に行う）:

1. eligible 集合を dispatch report から取る（`worker_state: completed` かつ
   `verification.outcome: pass`）。
2. 各 Issue について [cmate-acceptance-test](../cmate-acceptance-test/) を、`issue_ref` = その
   Issue、`target_ref` = その Issue の **worktree**、`result_path` =
   `<acceptance-dir>/issue-<n>.json` で実行する。Issue 本文は read-only で取得する（**書き戻さない**）。
3. 出力が [`acceptance-result.v1`](../cmate-acceptance-test/schemas/acceptance-result.v1.json)
   に適合し、`target.issue_ref` がその Issue を指していることを確認する。
   **別 Issue の result を流用しない。**
4. その directory を `--acceptance-dir` として渡す。必須にするなら `--require-acceptance` も渡す。

生成できない Issue があるときに、他 Issue の result を代用したり判定を推測で書いたりしては
ならない。**生成できなかったこと自体が記録すべき事実**である（runner が `acceptance_not_run`
として記録する）。

### 3.5 profile-init（profile draft の起案。plan の前に1回だけ）

```
profile-init.mjs [--repo-root <path>] [--out <path>] [--emit envelope|profile] [--repo <owner/name>] [--id <id>]
```

内蔵 profile 以外のリポジトリで使うときの **最初の一歩**である。対象リポジトリの
`package.json` / `Cargo.toml` / `pyproject.toml` / `go.mod` / `Makefile` /
`.github/workflows/*.yml` / CONTRIBUTING 等 / git config を読み、profile JSON の
**draft** を起案する。read-only で、**network も subprocess も clock も使わない**ので、
同じ tree からは byte 単位で同じ draft が出る。

| flag | 既定 | 効果 |
|---|---|---|
| `--repo-root <path>` | cwd | 調べるリポジトリ |
| `--out <path>` | — | draft profile JSON の書き出し先。**既存なら `out_exists`（exit 4）** |
| `--emit <mode>` | `envelope` | stdout に出すもの。`profile` なら draft JSON そのもの |
| `--repo <owner/name>` / `--id <id>` | 推定 / 導出 | 推定させずに宣言する |

```bash
node scripts/profile-init.mjs --repo-root . --out .commandmate/profile.json
# draft を読んで TODO を埋めてから
node scripts/orchestrate.mjs 123 --profile-json .commandmate/profile.json --allow-unverified
```

押さえるべき点は3つである（正本は
[profile-contract.md](./references/profile-contract.md) 第7節）。

1. **出力は draft であって profile ではない。** `verified` は常に `false` で、この runner が
   それを変えることはない。plan に渡すには `--allow-unverified` が要り、risk に
   `unverified_profile` が載る。**何を確認したら `verified: true` にしてよいかは
   [profile-contract.md](./references/profile-contract.md) 第8節の7項目**である。
2. **「読み取った」と「材料が無かった」が出力上で区別される。** stdout の envelope は
   field ごとに `provenance[]`（`source` と、file・行番号・行本文の `evidence[]`）を持ち、
   材料が無かった field は安全側の雛形 + `todos[]` の明示項目になる。**黙って埋めない。**
   provenance を profile JSON 側に入れないのは、planner が契約外の field を `load_error` で
   拒否するからである（注釈入り profile は使えない）。
3. **推定できなかった baseline は fail-closed の placeholder になる。** 空配列にすると
   「検証すべき gate が無いから pass」に化けうるので、必ず落ちる command を置く。
   **埋めずに dispatch すれば止まる**、が正しい壊れ方である。

### 3.6 status（run の横断ビュー。read-only）

```
status.mjs --run <run-dir> [--json]
```

| flag | 既定 | 効果 |
|---|---|---|
| `--run <path>` | **必須** | run directory（`plan.json` のある directory）。`plan.json` 自身の path でも可 |
| `--json` | off | 人間可読のテキスト表の代わりに構造化 view を出す |

**どの phase でも、いつでも呼べる。** plan → dispatch → merge / uat が残す artifact は
`plan.json` / `dispatch/dispatch-report.json` / `<phase>/merge-report.json` /
`<phase>/uat-report.json` に分かれており、各 `summary_markdown` は**単一 phase の要約**である。
「この run は今どの phase で、どの Issue が何待ちか」に答えるには複数の JSON を突き合わせる
必要があった。それをやるのがこの runner で、**それ以外は何もしない。**

**完全 read-only である。** run directory 配下の file を読むだけで、`commandmate` / `git` / `gh`
を一度も呼ばず、network も使わない。生きた状態を取りに行かないのは制約ではなく**契約**である
（証跡が証明していない状態を表示しないため）。何も書かないので、走っている run に向けても安全である。

出す内容は Issue ごとに:

- **plan**: Wave 番号・依存（`kind` つき）・branch・未回答 question 数
- **dispatch**: `worker_state` / `verification.outcome` / 判定した gate / task id
- **merge**: PR 番号・URL・CI verdict・merge 状態（`create_prs` と `merge_prs` の両 artifact を畳む）
- **uat**: verdict（と `outcome`）・fix attempt 数・意味ゲートの state
- **次にやること**: 各 report の `stop_reason` / `blocking_reasons` / `limitations` / plan の
  `warnings` の code を**第5節の対処表の語彙にマップした1行**（例: `worker_failed` →
  「prompt / worker ログを読む。指示が過大なら Issue を分割して re-plan する」）。
  detail が Issue を名指ししている reason（runner は `#<n> …` と書く）はその Issue 行に、
  名指ししないものは run 全体の欄に出る

**証跡に無い状態は推測しない。** artifact が無い phase は **`未実行`**（`dispatch/` が無ければ
「plan 承認待ち or dispatch 未実行」）、artifact が JSON として読めない、または schema version が
未対応なら **`読取不能`** として**その phase だけ**落ち、他 phase は表示される。report は読めたが
その Issue の記録が無い場合は **`記録なし`**（例: verification pass していないので merge の
`eligible_issues` に入っていない）。`partial` / `blocked` / `failure` はそのまま見せ、success に
丸めない。表示値は他 runner と同じ redaction を通る。

**exit code は「view を出せたか」だけを表す。** run が blocked でも読取不能があっても **0** で、
非 0 は入力エラー（`invalid_input` 3 / `load_error` 6 — `--run` が run directory でない）に限る。
**run の状態は exit code ではなく view の中で読むこと。** plan runner と同じ約束である。

`--json` は決定的で（同一入力 → byte 一致）、`run` / `latest_phase_with_evidence` /
`phases.<phase>.state` / `issues[].{plan,dispatch,merge,uat}.state` /
`issues[].next_actions[]` / `next_actions[]` / `unreadable[]` / `redactions[]` を持つ。
`state` の語彙は `ok` / `not_run` / `unreadable` / `no_record`（phase 単位ではさらに
`partial_read`）である。

---

## 4. 出力の読み方

4 runner とも、機械可読な envelope / report を **stdout** に、進捗 notice を **stderr** に出す。
mutating runner は `<out>/` にも report と summary markdown を書く。準備 runner の
profile-init も同じ規約で、status は `success`（全 field に根拠がある）/ `partial`
（雛形か warning がある）/ `failure`、exit は成功時 0、`invalid_input` 3 /
`out_exists` 4 / `load_error` 6 である（`--emit profile` のときだけ stdout は
draft JSON そのものになる。失敗時は常に envelope が出る）。

**まず run 全体を見るなら `status.mjs --run <run-dir>`**（第3.6節）。以下の status / code /
limitation は個々の report の語彙で、status runner はそれらを phase × Issue のマトリクスに
並べ、code を第5節の対処表へマップして見せる。

### status

| status | 意味 | exit |
|---|---|---|
| `success` | 全部通った（preview・no-op を含む） | 0 |
| `partial` | 途中停止、または warning つきで完走した | plan は 0 / 他は 7 |
| `blocked` | **uat のみ。** fix 上限到達でなお不合格が残る（成功に丸めない） | 8 |
| `failure` | 何も試せない・1件も dispatch できない | plan は code 依存 / 他は 1 |

**plan の exit code は `partial` でも 0 である。成否は exit code ではなく `status` と
`warnings` で判断すること。** planner は warning が1件でもあれば `success` にしない。

### plan の失敗 code と exit

| 状況 | code | exit |
|---|---|---|
| Issue 番号が無い / 引数不正 / max-parallel 範囲外 | `invalid_input` | 3 |
| mutating phase 指定（実行は dispatch runner の担当） | `not_implemented` | 2 |
| unverified profile（`--allow-unverified` 無し） | `unverified_profile` | 3 |
| Issue / profile / fixture が読めない | `load_error` | 6 |
| 依存 cycle / 不完全 override / 順序違反 | `cycle_detected` / `override_incomplete` / `dependency_order_violation` | 5 |
| run directory が既存 | `run_exists` | 4 |

失敗時も stdout に `status: failure` の result を出す。**plan を推測で埋めない。**

### plan の warning code（1件でも出れば `partial`）

| code | 意味 |
|---|---|
| `profile_repository_mismatch` | 既定 profile の対象リポジトリが cwd の `origin` と一致しない |
| `profile_repository_override` | `--repo` でリポジトリを差し替えたため profile の検証が対象を失った |
| `external_dependency` | この plan に含まれない Issue への依存を宣言している |
| `ambiguous_dependency_direction` | 1行に順方向と逆方向の方向語が同居し、依存の向きを一意に読めない |
| `no_acceptance_criteria` | 受入条件を1件も読み取れない。何をもって完了かが宣言されていない |
| `no_suspected_files` | 対象 file を1件も読み取れない。worker に与える scope が空になる |
| `unrecognized_file_extension` | 既知拡張子外の backtick path が抽出から落ちた |
| `shadowed_file_candidate` | 他候補の path 境界つき suffix だったため候補から落とした |

`no_acceptance_criteria` / `no_suspected_files` は dispatch の open question ゲートと対になる。
**この2つを放置したまま `--allow-questions` で押し通さないこと。**

### limitation code（停止はしていないが、後から効いてくる制約）

| code | runner | 意味 |
|---|---|---|
| `contract_unsupported` | dispatch | CLI が実行契約に非対応で、より弱い baseline 裁定に落ちた |
| `contract_disabled` | dispatch | `--contract-mode off` を明示したため probe していない |
| `contract_scope_unknown` | dispatch | 対象 file が空の Issue を dispatch しなかった（その wave は advance しない） |
| `open_questions_accepted` | dispatch | `--allow-questions` で未回答 question を引き受けた |
| `auto_yes_used` | dispatch | `--auto-yes` で prompt を自動応答した |
| `parallelism_truncated` | dispatch | wave が `max_parallel` より広かったので上限で切った |
| `unsafe_worktree_target` | dispatch | worktree path が path-escape guard に弾かれた |
| `worktree_sync_ran` | dispatch | `ls` で解決できず `commandmate sync` を1度実行して `ls` を読み直した（解決した branch / なお未解決の branch を detail に列挙） |
| `worktree_sync_unavailable` | dispatch | `commandmate sync` が失敗した（0.21.0 未満には subcommand が無い）。**この失敗自体では停止しない**が、server 未登録の worktree は登録し直せていない |
| `worktree_setup_ran` | dispatch | `--prepare-worktrees` で `cmate-worktree-setup` provider を1回呼んだ（対象 Issue・status・phase を detail に記録） |
| `worktree_prepared` | dispatch | provider が worktree を作成/再利用した。**Issue ごとに1件**（branch・base SHA・baseline 合否を detail に記録） |
| `worktree_setup_partial` | dispatch | 要求したうち一部しか作られなかった。作れた分は**消さずに保持**し、未解決 Issue については停止する |
| `worktree_setup_skipped` | dispatch | `--prepare-worktrees` を指定したが、pre-flight が別の drift で先に止まったため provider を呼んでいない |
| `worktree_sync_rescanned` | dispatch | 準備段のため `commandmate sync` を2回実行した（解決時の1回＋作成後の強制1回） |
| `worker_method_declared` | dispatch | `--worker-method <id>` 付きの run である。**run 全体で1件。** 停止した run にも残る（何を前提にした run だったかが読めるように） |
| `worker_method_applied` | dispatch | その Issue の worktree に skill が在り、task text に `## Method` 節を書いた。**Issue ごとに1件。** 「適用された」であって「守られた」ではない |
| `unattended_mode` | dispatch | `--unattended` 付きの run である。**run 全体で1件。** 停止した run にも残る。含意した締め付け（contract require / pre-flight の scope 検査 / wall-clock budget / worktree lock）と拒否する緩和フラグを detail に記録する |
| `unattended_baseline` | dispatch | その Issue の worktree が dispatch 開始時どこに居たか（**branch 名と短縮 SHA**。絶対 path は書かない）。**Issue ごとに1件。** 取り消しの起点であり、**担保するのは worktree branch の1段だけ**である（第5節） |
| `verification_unrecorded` | dispatch | completed した worker に裁定が1つも記録されなかった（runner 側の欠陥。`verification_recorded` completion check も落ちる） |
| `verification_gates_unrecorded` | dispatch | verification は pass だが `GATE` 行を読めず、pass の根拠となった gate を report が名指しできない |
| `drift_<check>` | dispatch | 非 blocking な drift（`integration_clean` / `worktrees_present`）を記録して続行した |
| `issue_autoclose_not_default_branch` | merge | base がデフォルトブランチでないため `Resolves #n` が効かない。**merge 後に手動クローズが要る** |
| `unsafe_branch` | merge | branch 名が safe-ref guard に弾かれた |
| `change_evidence_unavailable` | merge | branch の実変更 file を読めなかった（worktree 不在など）。PR 本文もそう書く。**scope 内に収まっていた証拠ではない** |
| `branch_changed_outside_declared_scope` | merge | 実変更に宣言 scope（`scope.allow`）外の file がある。PR 本文が違反 path を名指しする |
| `acceptance_not_run` | uat | 意味ゲートが verdict を出せず、baseline のみで裁定した |
| `no_eligible_issues` | merge / uat | dispatch report に completed かつ verification pass の Issue が無い |
| `completion_check_failed` | dispatch / merge / uat | completion check のどれかが passed でない |

`conditional_go` の保持（`acceptance_conditional`）と fix 上限到達（`max_attempts_reached`）は
limitation ではなく **stop_reason / blocking reason** である。**停止であって、続行しながらの
注記ではない。**

### completion check

各 runner は report に completion check を自己申告する（plan 5件 / dispatch 6件 / merge 5件 /
uat 6件）。**いずれかが false なら `status` は `success` にならない。** 項目は各正本の
「completion_check」節にある。token・secret・絶対 path・raw terminal は
report/artifact に残さない（redaction）。

---

## 5. 停止したとき、人間が何をするか

**runner が止まったら、それは「押し通す」合図ではなく「読む」合図である。**
`blocking_reasons` の code と `summary_markdown` を読み、次の対応を取る。

`status.mjs --run <run-dir>`（第3.6節）は**この表を機械的に引いた結果**を、どの Issue の話かを
添えて出す。JSON を自分で突き合わせる前に、まずこれを読めばよい。表がこの節の正本であり、
status runner はそれを引くだけなので、**ここに無い code は status runner も推測しない**
（「detail と `summary_markdown` を読む」に落ちる）。

| 止まり方 | 何が起きたか | 人間がすること |
|---|---|---|
| plan `status: partial` + `no_acceptance_criteria` / `no_suspected_files` | Issue に受入条件か対象 file が書かれていない | **Issue 本文に書き足して re-plan する。** run_id は本文を含む hash なので自動的に別 run になる |
| plan `cycle_detected` / `override_incomplete` / `dependency_order_violation` | 依存グラフが実行不能 | `dependency-plan.md` の edge `reason`（どの方向語をどの行から読んだか）を見て、Issue 本文か `--depends` を直す |
| plan `run_exists` | 入力が完全に同一の再実行 | 本文を直すか、`--run-id <new-id>` / `--runs-dir <dir>` を渡す |
| plan `profile_repository_mismatch` | cwd の origin と profile の対象リポジトリが違う | `--profile` / `--profile-json` / `--repo` のどれかを渡して意図を明示する |
| dispatch `open_questions` + `human_required` | 未回答の question を持つ Issue がある | blocking reason に**質問の本文**が出ている。Issue 本文に回答を書いて re-plan する |
| dispatch `drift` | plan 承認後に branch / HEAD / 権限が動いた | drift の内容を確認し、必要なら re-plan する。**drift の上に dispatch しない** |
| dispatch `worktree_unresolved`（`stop_reason: drift`） | 対象 Issue の worktree が `commandmate ls` で解決できない（runner は `commandmate sync` を1度試したうえでの結論。`limitations` の `worktree_sync_ran` / `worktree_sync_unavailable` を見る）。**worker は1人も起動していない**（`task_id: null`・worker ログ無し） | **`cmate-worktree-setup` で worktree を作成し、同じコマンドで再実行する**（最初の Wave 前で止まった場合、`--out` は消費されていない）。plan と同じ profile（同じ `branch_template`）を使う。**Issue の分割や re-plan は不要** |
| dispatch `worktree_setup_unavailable`（`stop_reason: dispatch_error`） | `--prepare-worktrees` を指定したのに `cmate-worktree-setup` を呼べなかった（未 install / `--worktree-setup` 未指定 / launcher が起動不能） | **`cmate-worktree-setup` を install し、`--worktree-setup <launcher>` でその呼び出し口を渡して再実行する。** 準備段を使わないなら `--prepare-worktrees` を外し、従来どおり worktree を用意してから dispatch する |
| dispatch `worktree_setup_failed`（同上） | provider は動いたが result contract を返さなかった、または1件も作らなかった | provider の出力（blocking reason）を読んで原因を直し、同じコマンドで再実行する。**作成済みの worktree は削除していない**ので、再実行の対象は残りの Issue だけになる |
| dispatch `worktree_profile_mismatch`（同上） | provider が作った branch が plan の branch と違う（**profile の不一致**） | plan と `cmate-worktree-setup` に**同じ profile（同じ `branch_template`）**を渡す。既に作られた branch を使いたいなら、その branch を作る profile で plan を作り直す |
| dispatch `worker_method_unavailable`（`stop_reason: dispatch_error`） | `--worker-method <id>` を指定したのに、その Skill が対象 worktree に無い（`.claude/skills/<id>/SKILL.md` と `.agents/skills/<id>/SKILL.md` の**両方**が要る。detail が「無い」のか「片側だけ在る」のかを名指しする）。**worker は1人も起動していない** | **`commandmate skill install <skill-id>` で対象 worktree に入れ、同じコマンドをそのまま再実行する**（最初の Wave 前で止まった場合、`--out` は消費されていない）。方法論なしで走らせてよいと判断したなら `--worker-method` を外す。**Issue の分割や re-plan は不要** |
| dispatch exit 10（prompt 検出） | worker が人間の判断を求めている | `capture` の内容が report に出ている。**自分で判断して答える。** runner は自動応答しない |
| dispatch `verification_not_judged`（exit 99） | run が error / cancelled で**誰も判定していない** | **再 dispatch では解けない。** CommandMate 側のログを見る。判定していないものを worker に直させない |
| dispatch `worker_failed`（`--max-turns` 到達で未 commit） | worker が起動したが commit まで到達しなかった（worktree 未解決はこの code に落ちない。上の行） | prompt / worker ログを読む。指示が過大なら Issue を分割して re-plan する |
| dispatch `verification_failed` / `worker_failed` / `timeout` で **一部の Issue だけ**落ちた | pass 済みの Issue と落ちた Issue が同じ run に混ざっている | 落ちた分を直したうえで **`dispatch.mjs --plan <plan.json> --resume <その run の dispatch ディレクトリ>`**。pass 済みは再 dispatch されず記録だけ引き継がれる（第3.2節）。**re-plan は不要** |
| dispatch `resume_plan_mismatch`（`stop_reason: dispatch_error`） | `--resume` 先の report が**別 plan**のものだった（`run_id` / repository / base 不一致） | その plan 自身の dispatch ディレクトリを `--resume` に渡す。新規に走らせるなら `--out` で始める。**何も dispatch していないので、直して同じコマンドを再実行してよい** |
| dispatch `resume_invalid`（同上） | `--resume` 先の report が `dispatch-report.v1` として読めない（schema version 違い / JSON 破損） | detail が「何がどう合わないか」を名指ししている。報告どおりの report を指すか、`--out` で新規 run にする。**壊れた report を半分だけ信じて引き継がない** |
| dispatch `resume_no_work`（`status: success`） | 再実行対象が1件も無い（全 Issue が completed かつ pass） | 停止ではない。その attempt の report をそのまま merge / uat に渡す |
| dispatch `contract_unsupported` + `require` | CLI が実行契約に非対応 | CommandMate を 0.17.0 以上に上げるか、弱い裁定を承知のうえで `auto` に落とす。**`--unattended` の run では `auto` は選べない**（`require` を含意する。落とすなら `--unattended` を外して人間が読む運転に戻す） |
| dispatch `contract_scope_unknown`（`stop_reason: dispatch_error`。**`--unattended` のとき**） | 対象 file を1件も宣言していない Issue が plan に在る。**1人も dispatch していない**（`--out` も未作成） | **Issue 本文に対象ファイルを書いて re-plan する。** フラグ無しの run では同じ Issue が wave の中で1人ずつ拒否される（そのときは他 Issue の worker が既に走っている）。無人ではその始末をする読み手が居ないので、pre-flight で全 Issue を検査している |
| dispatch `unattended_locked`（同上） | 同じ worktree を**別の dispatch run が動かしている**（`--out` も未作成・`human_required: false`） | **先行 run の終了を待って、同じコマンドをそのまま再実行する。** lock が残り続けるなら所有 run の pid が生きているかを確認する（`kill -9` された run の lock は次の run が自動で回収する）。lock は `$CMATE_ORCHESTRATE_LOCK_DIR`（既定 `$TMPDIR/cmate-orchestrate-locks/`）に置かれる |
| dispatch `wall_clock_budget_exhausted`（`stop_reason: timeout` / `partial`） | `--wall-clock-budget` に到達して打ち切った。**成功ではない** | 何に時間を使ったかを確認する（**profile baseline と acceptance コマンドは自前の timeout を持たない**ので、まずそこを疑う）。原因を潰すか budget を実測に合わせてから **`--resume` で再開する**。**打ち切りを success に丸めない** |
| merge `ci_failed` / `ci_pending` | CI が green でない | CI を直す。**green 無しに merge しない** |
| merge `pr_missing` / `merge_failed` | PR が無い / conflict | PR の状態を確認し、conflict は手で解消する |
| merge `issue_autoclose_not_default_branch` | base がデフォルトブランチでない | merge 後に **Issue を手動でクローズする** |
| uat `acceptance_conditional` | 受入判定が `conditional_go` | **条件を読んで人間が判断する。** 自動修正の対象ではない |
| uat `blocked` / `max_attempts_reached` | 上限まで直しても不合格 | `unresolved_issues` と `next_actions` を読む。**success に丸めない** |
| uat `acceptance_not_run` | 意味ゲートを掛けずに baseline だけで裁定した | cmate-acceptance-test を入れて result を用意し、必要なら `--require-acceptance` で必須にする |

### 無人 run を取り消す（`unattended_baseline` の読み方）

`--unattended` の run は、dispatch した worktree ごとに開始時の HEAD を
`limitations` の `unattended_baseline` に **branch 名と短縮 SHA** で残す。取り消しはそれを起点に、
**上流から順に**行う。

1. `git reset --hard <sha>`（worktree が残っている場合）。
2. worktree が既に片付いていれば **`git branch -f <branch> <sha>`**。
   `git reset` は exit 128 で使えない。**baseline を branch 名で書いてあるのはこのためで、
   絶対 path では手が届かない。**

**この起点が担保するのは worktree branch の1段だけである。** 次の4つでは足りない
（[#115](https://github.com/Kewton/commandmate-skills/issues/115) の実測）:

1. **untracked file は `git reset --hard` で戻らない**（`.commandmate/tasks/*.yaml` を含む）。
   完全に戻すには `git clean -fdx` が要るが、それは worker の成果物も消す ——
   **無人で機械にやらせる操作ではない。**
2. **既に merge / push されていたら戻らない。** 下流から先に取り消す（PR を close し、
   remote branch を消し、必要なら revert PR を立てる）。**force push で歴史を消さない。**
3. **worktree が片付いていると `git reset` は使えない**（上の 2）。
4. **branch も消えて `git gc --prune=now` が走ると object ごと消える。** baseline が base branch から
   到達可能なら生き残るので、危ないのは **baseline が base から到達できないとき** ——
   `--prepare-worktrees` が既存 worktree を再利用した場合や、前の run の commit の上に
   baseline が乗っている場合である。

**取り消せるのはリポジトリの状態であって、送られた通知ではない。** push は対象リポジトリの CI を
起動し（実行時間・課金・通知）、PR 作成は reviewer に通知を出す。

`worktree_setup_unavailable` / `worktree_setup_failed` / `worktree_profile_mismatch` と
`resume_attempt` / `resume_no_work` / `resume_invalid` / `resume_plan_mismatch` は、
この表には在るが **status runner の hint map にはまだ無い**（`status.mjs` は別 Issue で追随する）。
それまで `status.mjs --run` はこれらを「detail と `summary_markdown` を読む」に落として表示する。
**推測で別の対処を出さない**のが status runner の約束なので、これは劣化ではなく既定の振る舞いである。
dispatch report の `summary_markdown` には上表と同じ next action が出ている。

## 6. 参照

**契約の正本**（この文書と食い違ったら正本が優先する）— 第3節の runner 表からもリンクしている
4つの `*-contract.md` に加えて:

- [references/acceptance-gates-notation.md](./references/acceptance-gates-notation.md) — Issue 本文の `acceptance-gates` ブロックの記法（**記法の正本**）
- [references/profile-contract.md](./references/profile-contract.md) — profile の形と unverified の扱い
- [references/agent-compatibility.md](./references/agent-compatibility.md) — Agent 差異と fallback
- [references/release-notes.md](./references/release-notes.md) — なぜその挙動なのか（経緯）

**ADR（裁定の記録。契約の正本ではない）**:

- [references/adr-issue-acceptance-gates.md](./references/adr-issue-acceptance-gates.md) — Issue 受入条件の機械ゲート化
- [references/adr-worktree-preparation.md](./references/adr-worktree-preparation.md) — worktree 準備段の合成（`--prepare-worktrees`）
- [references/adr-worker-development-skill.md](./references/adr-worker-development-skill.md) — ワーカー側方法論の呼び出し口（`--worker-method`）

**機械検証用 schema** — `schemas/` に
[execution-plan.v2](./schemas/execution-plan.v2.json)（plan）・
[orchestrate-result.v1](./schemas/orchestrate-result.v1.json)（planner envelope）・
[dispatch-report.v1](./schemas/dispatch-report.v1.json)・
[merge-report.v1](./schemas/merge-report.v1.json)・
[uat-report.v1](./schemas/uat-report.v1.json)。意味ゲートの入力は
[acceptance-result.v1](../cmate-acceptance-test/schemas/acceptance-result.v1.json)（別 package）。
status runner の `--json` は artifact ではなく view なので（何も書かない）`schemas/` に対応する
file を持たない。field は第3.6節が正本である。
