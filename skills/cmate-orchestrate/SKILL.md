---
name: cmate-orchestrate
description: 複数 Issue を並列実行するための計画を dry-run で立て、承認後にその計画を監督付きで実行する。計画では Issue 品質・依存（explicit/inferred）・file conflict を分析し、cycle や不完全 override を拒否したうえで、file 衝突の無い承認可能な Wave plan・risk・権限・実行 command を決定的な artifact として返す。実行では plan から実行契約 yaml（goal / scope.allow）を決定的に生成して worktree へ配置し、public commandmate で `send --contract`（task id が返る）し、裁定は `wait --verify` の exit code を一次ソースにする（0 合格 / 20 判定して不合格→失敗ゲートを特定し再指示 / 21 作業証跡ゼロ / 10 prompt は自動応答せず human 提示 / 99 判定に到達せず→再指示せず human へ）。契約非対応の CommandMate では明示メッセージつきで profile baseline 再実行のフォールバックに落ちる（黙って劣化しない）。worker が各ターン後に idle 化するため wait の idle を完了とみなさず worktree ブランチの新規 commit を完了判定として継続 nudge で駆動し、Wave barrier と verification gate で監督する。
---

# cmate-orchestrate（計画コア + dispatch・監督 + PR/CI/merge + UAT 修正ループ）

複数の Issue を並列で進めるための、**計画**と、その承認後の**監督付き実行**と、
verification pass 後の**PR 作成・CI 確認・guarded merge** と、納品後の
**UAT（受入テスト）と不合格時の回数上限つき修正ループ** を安全に行うための手順である。
この Skill は4つの deterministic runner を持つ。

- **計画（planner, `scripts/orchestrate.mjs`）** — dry-run で Wave plan を生成する。
  mutation は一切しない。default invocation はこれである。
- **実行（dispatch, `scripts/dispatch.mjs`）** — 承認済み plan を入力に取り、
  public `commandmate` で worker を dispatch し、Wave barrier と verification gate で
  監督する。裁定は CommandMate の**実行契約**（`send --contract` / `wait --verify` の
  exit code）を一次ソースとし、契約非対応の CLI では profile baseline 再実行の
  フォールバックに明示的に落ちる。mutation を伴う。
- **納品（merge, `scripts/merge.mjs`）** — dispatch report で verification pass した
  Issue だけを対象に、明示承認の下で PR 作成（`--create-prs`）または CI 確認付きの
  guarded merge（`--merge-prs`）を、1 invocation で1 phase だけ行う。mutation を伴う。
- **受入（uat, `scripts/uat.mjs`）** — verification pass した Issue に UAT を実行し
  （`--write-uat`）、不合格なら fix worktree 作成 → 修正 → 再検証 → 再merge を
  **回数上限つき**で繰り返す（`--create-uat-fix-worktrees`）。上限到達時は `blocked` で
  停止し成功に丸めない。1 invocation で1 phase だけ、mutation は明示承認の下でのみ行う。
  裁定は **機械ゲート（profile baseline）+ 意味ゲート（受入条件の Go/Conditional Go/No-Go）の
  二層**である。意味ゲートの判定は cmate-acceptance-test がエージェント側の手順として出し、
  uat runner はその result document を検証して**合成するだけ**である（runner 内で LLM 判定はしない）。

Issue 本文の自動編集、回数無制限のループ、crash 後の resume/attempt retry、cross-model review は
この Skill の **スコープ外** である。どの mutating runner も、明示承認・verification pass・
CI pass の gate 無しに mutation を行わない。

計画も実行も納品も、同梱の runner（Node stdlib のみ）が行う。計画は入力の純粋関数で、
同じ入力からは同じ plan が出る（Claude/Codex parity）。base branch・branch 名・
worktree path・baseline は **profile から解決**し、`develop`/`npm`/`cargo` を hardcode しない。

## 前提条件

**CLI**: `commandmate`（`>=0.11.0 <1.0.0`）・`git`・`gh`・`node >=22`。

**別途導入が必要な Skill: `cmate-acceptance-test`。**
第4部（UAT）の裁定は機械ゲート（profile baseline）と**意味ゲート**（Issue の受入条件に対する
Go / Conditional Go / No-Go 判定）の二層で、**意味ゲートの入力は
[cmate-acceptance-test](../cmate-acceptance-test/) が出す result document
（`acceptance-result.v1`）である**。この Skill は `cmate-orchestrate` の install には
**含まれない**ので、意味ゲートを使うなら次で別途導入する。

```bash
commandmate skill install cmate-acceptance-test
```

未導入のままでも orchestrate は動くが、**裁定は機械ゲートだけになる**。`--acceptance-dir` を
渡さなければ uat runner は baseline の結果のみで裁定し、意味ゲートを掛けていないことを
report の `limitations[]`（`acceptance_not_run`）に記録する（黙って劣化しない。第16節）。
`--require-acceptance` を渡すと、result の欠落・schema 不適合・対象 Issue 不一致は
limitation ではなく**不合格**として扱われる。

未導入の環境では、本書中の `../cmate-acceptance-test/...` への相対リンク（第4部・第17節）は
解決しない。リンク切れ自体が「その Skill をまだ入れていない」ことのサインである。

第1部〜第3部（計画・dispatch・PR/merge）は `cmate-acceptance-test` に依存しない。

---

# 第1部 計画コア（dry-run）

## 1. この runner が答える問い

1. 各 Issue は着手できる品質か（objective・受入条件・対象 file・blocking question）。
2. Issue 間の依存はどれか。明示された依存（explicit）と、推論した依存（inferred）は何か。
3. 同時に触ると壊れる Issue の組み合わせ（file conflict）はどれか。
4. 以上を踏まえ、file 衝突の無い Wave plan と merge 順はどうなるか。
5. この plan の risk はどれくらいで、実行には何の権限と command が要るか。

## 2. 入力

| 名前 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `issues` | 必須 | なし | Issue 番号（positional か `--issues a,b,c`）。1件以上 |
| `--profile <id>` | 任意 | `node-commandmate` | 内蔵 profile。`node-commandmate` / `rust-commandagent` |
| `--profile-json <path>` | 任意 | なし | 独自 profile。[references/profile-contract.md](./references/profile-contract.md) |
| `--issue-json <path>` | 任意 | なし | Issue fixture。offline・決定的に回すときに使う |
| `--base <ref>` | 任意 | profile 由来 | base branch の上書き |
| `--repo <owner/name>` | 任意 | profile 由来 | 対象リポジトリの上書き。**profile の `verified` を降格させる**（第4節 Step 1） |
| `--max-parallel <1-3>` | 任意 | `3` | 1 Wave の最大幅 |
| `--depends <a:b>` | 任意 | なし | override: `a` が `b` に依存（繰り返し可） |
| `--no-infer` | 任意 | off | 推論依存を無効化 |
| `--order <a,b,...>` | 任意 | なし | Issue 順序の主張。依存に反すれば拒否 |
| `--run-id <id>` | 任意 | 入力 hash（Issue 内容を含む） | run_id の明示 |
| `--runs-dir <path>` | 任意 | `.commandmate/orchestrate/runs` | run artifact の出力先 |
| `--phase <plan>` | 任意 | `plan` | planner は `plan` のみ。mutating phase は拒否（実行は dispatch runner） |
| `--allow-unverified` | 任意 | off | unverified profile での planning を許可 |

## 3. 権限と禁止事項

宣言している権限は `filesystem_read` / `filesystem_write` / `process_execution` /
`network_access` である。これは計画と実行の両 runner を含めた orchestration 全体が
要求する権限であり、plan にも同じ集合を提示する。

planner の手順として **禁止** するもの:

- worktree の作成、worker への dispatch、`commandmate send` / `wait` / `capture`（← 実行は dispatch runner の担当）
- PR の作成、CI のトリガ、merge（← 納品は merge runner の担当。第3部）
- UAT の実行、fix worktree 作成、修正ループ（← 受入は uat runner の担当。第4部）
- 対象リポジトリの branch・Issue・PR の変更

`--issue-json` を使わない場合、read-only の `gh issue view` で Issue を取得する。
これは planner 唯一の network access であり、mutation を伴わない。

**契約の入力は Issue の number / title / body / labels のみである。コメントは読まれない**
（`gh issue view --json number,title,body,labels`。CommandMate #1678 B-3）。
「本文は変えず、決定はコメントで追記する」運用をしていると、コメントに記録した設計判断は
plan にも実行契約の `goal` にも載らず、worker は本文に残る古い方針を実装する。
コメントで決めた内容は、**dispatch 前に Issue 本文へ畳み込んでから** plan を作ること
（本文の精錬には cmate-issue-refinement が使える）。この入力範囲は plan の `notes` にも
毎回明記される。

セキュリティ:

- client 入力（Issue 本文由来）の絶対 path・`..`・drive path は採用しない。
- token・secret・絶対 path は plan/result/artifact へ残さない（redaction）。

## 4. 手順

### Step 0. 入力を検証する

Issue 番号が1件以上あること、`--max-parallel` が 1〜3 であること、
`--phase` が `plan` であることを確認する。planner に mutating phase
（`dispatch`/`pr`/`merge`/`uat`）が指定されたら、実行せず `not_implemented` で終了する
（実行は承認済み plan を dispatch runner に渡して行う。第2部）。

### Step 1. profile を解決する

`--profile` / `--profile-json` から profile を解決する。unverified profile は、
`--allow-unverified` が無ければ `unverified_profile` で終了する
（[references/profile-contract.md](./references/profile-contract.md) 第3節）。

**`--repo` による上書きは `verified` を降格させる。** profile の branch/base/worktree/baseline
は元のリポジトリに対してのみ検証されており、リポジトリを差し替えた時点でその検証は対象を失う。
よって `--repo` を渡すと `verified: false` となり、`--allow-unverified` が無ければ
`unverified_profile` で終了する。`--allow-unverified` を付けた場合は plan の
`profile.verified` が `false`、risk factor に `unverified_profile`（high）、
warnings に `profile_repository_override` が載り、result は `partial` になる。

**既定 profile はカレントディレクトリの origin と照合する。** `--profile` も `--profile-json`
も指定されず profile が既定値（`node-commandmate`）に解決されたときだけ、read-only の
`git remote get-url origin` を1回実行し、URL を `owner/name` に正規化して（ssh / https
両形式）profile の対象リポジトリと突き合わせる。**不一致なら warnings に
`profile_repository_mismatch` を積み、result を `partial` にする**。別リポジトリの worktree
内で profile を指定し忘れると、planner は既定 profile のリポジトリから Issue を読むため、
**中身の違う Issue から一見きれいな plan が出てしまう**（[#36](https://github.com/Kewton/commandmate-skills/issues/36)）。
これを黙って success にしないための照合である。

- cwd が git リポジトリでない・`origin` が無い・URL が `owner/name` に正規化できない場合は
  **照合をスキップ**する（失敗を不一致として扱わない）。比較は大文字小文字を無視する。
- 明示的に profile を指定した場合は照合しない。指定は意図的な選択だからである。
- plan は「入力 + cwd の origin」の純粋関数であり、同一 cwd・同一入力からは同一 plan が出る
  （Claude/Codex parity は維持される）。`run_id` は cwd に依存しない。
- 警告のみで、planner は止まらない。`--profile` / `--profile-json` / `--repo` のいずれかを
  渡せば、そのリポジトリに対する plan になる。

### Step 2. Issue を取得する

`--issue-json` があればそれを、無ければ `gh issue view` で各 Issue を取得する。
取得できない Issue があれば `load_error` で終了する。
読むのは number / title / body / labels だけで、**コメントは読まない**（第3節）。

### Step 3. 各 Issue を分析する

Issue ごとに objective・受入条件・suspected/reference files・test 期待・
blocking question を抽出する。抽出時に token・secret・絶対 path を redaction する。
受入条件や対象 file が読み取れない Issue には blocking question を立てる。
**question は `warnings` にも積む**（`no_acceptance_criteria` /
`no_suspected_files`）ので、その plan の `status` は必ず `partial` になる。
受入条件ゼロの Issue が `success` として dispatch まで素通りしないための止め具である
（Issue #52。第8節 Step D-1 の dispatch 側ゲートと対になる）。
既知拡張子外の backtick path が抽出から落ちた場合は `warnings` に
`unrecognized_file_extension` を積む（黙って落とさない。Issue #43）。

path 候補は必ず **token 先頭**から取る。`\b` 起点だと path の途中からも一致し、
`.claude/skills/cmate-verify/scripts/verify-run.sh` から `scripts/verify-run.sh` と
`claude/skills/…` が、`web/src/lib/filter.ts` から `src/lib/filter.ts` が生まれた。
`suspected_files` はそのまま worker の `scope.allow` になるので、実在しない部分 path は
そのまま「実在しない path への書き込み権限」だった（Issue #49）。加えて、他の候補の
**path 境界つき suffix** になっている候補（`web/src/lib/filter.ts` に対する
`src/lib/filter.ts`）は落とし、落とした分を `warnings` の `shadowed_file_candidate` に
出す（`unrecognized_file_extension` と同型で、黙っては捨てない）。

`docs/` prefix と `.md` / `.rst` / `.txt` は原則 `reference_files` だが、
**「成果物」「対象ファイル」「変更対象」「Deliverables」等の見出し配下**に書かれた path は
拡張子を問わず `suspected_files` に入れる。成果物が Markdown の Issue（設計文書・ADR・手順書）は
以前 `suspected_files` が必ず空になり、worker は指示どおり md を書いて scope ゲートに
落とされていた（Issue #50）。見出しの外に書かれた md は従来どおり reference のままである。
また、対象 file に依存 manifest（`package.json` / `Cargo.toml` / `go.mod` /
`pyproject.toml` / `Gemfile`）が含まれる Issue には、同 directory の lockfile
（node → `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`、rust → `Cargo.lock` 等）を
**既定許可**として `suspected_files` に加え、planner が加えた分を issue の
`scope_defaults` に明示する（CommandMate #1678 B-2: lockfile が scope.allow の外だと
`npm install` の時点で worker が構造的に scope ゲート不合格になるため）。

### Step 4. 依存を解決する

explicit（本文由来）・inferred（推論）・override（`--depends`）を
[references/plan-contract.md](./references/plan-contract.md) 第3節の規則で統合する。
cycle・不完全 override・順序違反（`--order`）はここで **拒否** する。
集合外を指す explicit 依存は warning に落とし、`status` を `partial` にする。

explicit の**方向は行ごとに**判定する（Issue #51）。`blocks` / `blocking` /
`ブロックする` は「書いた側が先」（逆向き）、`depends on` / `blocked by` /
`requires` / `依存` / `前提` は「書いた側が後」（順方向）である。`## 依存` のような
節見出しは、方向語を持たない行の既定値（順方向）を与えるだけで、行の内容を
上書きしない。1行に両方向がある場合は黙って選ばず `ambiguous_dependency_direction`
を warning に積む。各 edge の `reason` には、**どの方向語をどの行から読んだか**を
残すので、`dependency-plan.md` だけで edge を再導出できる。

### Step 5. Wave を組む

依存を満たし、file 衝突を同一 Wave に入れず、各 Wave を `max_parallel` 以下にする
（同 reference 第4節）。merge 順は Wave の平坦化である。

### Step 6. risk・permissions・commands を出す

risk factor を決定的に導き（同 reference 第6節）、要求権限と、plan の根拠になる
read-only command・baseline 検証 command（すべて `executed: false`）を列挙する。

### Step 7. artifact を書く

`<runs-dir>/<run_id>/` に `plan.json`・`result.json`・`manifest.md`・
`issue-analysis.md`・`dependency-plan.md` を書く。run directory が既にあれば
上書きせず `run_exists` で終了する。既定の run_id は Issue 内容（title/body/labels）を
含む入力 hash なので、**Issue 本文を直して再 plan すれば自動的に別 run になる**
（Issue #46 / CommandMate #1678 B-4）。本文まで同一の再実行だけが `run_exists` になり、
エラーメッセージが回避例（`--run-id <new-id>` / `--runs-dir <dir>`）を示す。

### Step 8. completion check を実行する

result を返す前に、5つの check を自己申告する
（[references/plan-contract.md](./references/plan-contract.md) 第8節）。
いずれかが false なら `status` を `success` にしない。

## 5. 出力

planner は result envelope（[schemas/orchestrate-result.v1.json](./schemas/orchestrate-result.v1.json)）を
stdout に、進捗 notice を stderr に出す。`status` は3値（`success`/`partial`/`failure`）。
plan 本体は [schemas/execution-plan.v1.json](./schemas/execution-plan.v1.json) に適合する。

**warnings が1件でもあれば `status` は `partial` である**（`success` に丸めない）。exit code は
`partial` でも 0 なので、**成否は exit code ではなく `status` と `warnings` で判断する**。

| warning code | 意味 |
|---|---|
| `profile_repository_mismatch` | 既定 profile の対象リポジトリが cwd の `origin` と一致しない（第4節 Step 1） |
| `profile_repository_override` | `--repo` でリポジトリを差し替えたため profile の検証が対象を失った（同上） |
| `external_dependency` | Issue が、この plan に含まれない Issue への依存を宣言している（読み取った方向のまま述べる） |
| `ambiguous_dependency_direction` | 1行に順方向と逆方向の方向語が同居していて、依存の向きを一意に読めない（第4節 Step 4） |
| `no_acceptance_criteria` | Issue から受入条件を1件も読み取れない。何をもって完了かが宣言されていない（第4節 Step 3） |
| `no_suspected_files` | Issue から対象 file を1件も読み取れない。worker に与える scope が空になる（同上） |

## 6. planner の失敗時の動作

| 状況 | code | exit |
|---|---|---|
| Issue 番号が無い / 引数不正 / max-parallel 範囲外 | `invalid_input` | 3 |
| mutating phase 指定 | `not_implemented` | 2 |
| unverified profile（`--allow-unverified` 無し） | `unverified_profile` | 3 |
| Issue / profile / fixture が読めない | `load_error` | 6 |
| 依存 cycle | `cycle_detected` | 5 |
| 不完全 override | `override_incomplete` | 5 |
| 順序違反 | `dependency_order_violation` | 5 |
| run directory が既存 | `run_exists` | 4 |

失敗時も stdout に `status: failure` の result を出す。plan を推測で埋めない。

---

# 第2部 dispatch・監督ループ

承認済み plan を実際に実行する。契約の正本は
[references/dispatch-contract.md](./references/dispatch-contract.md)、report の schema は
[schemas/dispatch-report.v1.json](./schemas/dispatch-report.v1.json) である。

## 7. dispatch runner の入力

```
dispatch.mjs --plan <承認済み plan.json> [options]
```

| 名前 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `--plan <path>` | 必須 | なし | planner が出力した承認済み `plan.json` |
| `--out <dir>` | 任意 | `<plan-dir>/dispatch` | dispatch artifact の出力先。既存なら `out_exists` |
| `--cli <path>` | 任意 | `commandmate` | 実行する public CommandMate CLI |
| `--git <path>` | 任意 | `git` | drift 確認に使う git |
| `--gh <path>` | 任意 | `gh` | repo 到達性確認に使う gh |
| `--auto-yes` | 任意 | **off** | worker prompt を自動応答する。既定 off（prompt で停止し human へ提示） |
| `--allow-questions` | 任意 | **off** | 未回答の open question を持つ Issue を含む plan を dispatch する。既定 off（1件も dispatch せず停止）。第8節 Step D-1 |
| `--contract-mode <m>` | 任意 | `auto` | `auto`（契約が使えれば使い、無ければ明示メッセージつきでフォールバック）/ `require`（フォールバックを拒否して停止）/ `off`（probe せず従来の baseline 裁定）。第8.1節 |
| `--verify-gates <ids>` | 任意 | なし（＝全ゲート） | 契約の `verify.gates` に載せる `verify.yaml` の gate id（comma 区切り）。**存在しない id を発明しない**ため既定は省略＝全ゲート |
| `--expect-branch <name>` | 任意 | なし | plan 承認時の統合 branch。不一致なら drift |
| `--wait-timeout <sec>` | 任意 | `300` | `commandmate wait` の1回あたり timeout |
| `--max-turns <n>` | 任意 | `8` | 各 worker を駆動する最大ターン数（初回 send + nudge / 再指示）。未 commit で到達なら failed |
| `--poll-limit <n>` | 任意 | `120` | 互換のため保持（wait は block するので poll しない） |

`commandmatedev` は使わない。公式経路は public `commandmate` である（ADR
[#1447](https://github.com/Kewton/CommandMate/issues/1447)）。

## 8. dispatch の手順

### Step D-1. open question ゲート（Issue #52）

Wave に入る前に、plan の Issue が未回答の planner question を持っていないかを見る。
1件でもあれば **1人も dispatch せずに停止する**（`status: failure` /
`stop_reason: dispatch_error` / `blocking_reasons` に `open_questions` /
`human_required: true` / exit 1）。受入条件が読み取れない Issue は「何をもって完了か」が
無いまま worker に渡ることになるので、これは実行前に決まる話であり、drift 確認や
契約 probe よりも**先**に判定する（世界の状態に依存しない）。

blocking reason と `summary_markdown` には **question の本文**を出す。code だけでは
運用者は Issue 本文に何を書けばよいか分からない。

`--allow-questions` を明示した場合のみ続行し、その事実を
`limitations` の `open_questions_accepted` として記録する（黙って引き受けない）。
既定の直し方は「Issue 本文に回答を書いて re-plan する」であり、plan の run_id は
Issue 本文を含む hash なので編集すれば自動的に別 run になる（第4節 Step 7）。

Wave を plan の順に処理する。各 Wave について:

### Step D0. plan を読み・検証する

`plan_schema_version` が 1 で、`max_parallel` が 1〜3、どの Wave も `max_parallel` 以下で
あることを確認する。反していれば `plan_invalid` で終了する（**上限を超えて dispatch しない**）。

### Step D1. mutation 前に drift を再確認する

`cli_available`・`repo_access`・`base_resolvable`・`branch_matches`（`--expect-branch` 時）を
確認する。**blocking** な check が false なら dispatch せず停止する。`integration_clean`・
`worktrees_present` は非 blocking で `limitations` に記録して続行する。最初の Wave 前の
drift は `failure`、途中の Wave 前は `partial`。stop_reason は `drift`。

### Step D2. 実行契約を生成して dispatch する

Wave の各 Issue について、plan だけから **実行契約 yaml**（CommandMate の
`docs/design/task-contract.md` v1）を**決定的に**生成し、worktree の
`.commandmate/tasks/cmate-orchestrate-issue-<n>.yaml` に配置して
`commandmate send <worktree-id> --contract <path>` で dispatch する。**返る task id を
`worker.task_id` に記録する**（`send --contract` は task id を stdout に返す）。契約の中身は:

| キー | 生成規則 |
|---|---|
| `version` | 常に `1` |
| `title` | `#<n> <Issue title>`（200 文字上限で切り詰め） |
| `goal` | plan の objective・受入条件・対象 file・rules。CommandMate が前文（許可 path・commit 要求・**verify.yaml から解決した実 command**）を先に付けるので、goal 側で profile baseline を重ねて書かない（judge と違うものを worker に指示しないため） |
| `scope.allow` | Issue の `suspected_files` を**ソート・重複除去**したもの（planner が既定許可した lockfile（plan の `scope_defaults`）も含まれる）。絶対 path・`..`・NUL・長すぎる pattern は落とす |
| `scope.deny` | `[]` |
| `verify.gates` | `--verify-gates` 指定時のみ。既定は**キーごと省略＝全ゲート**（存在しない gate id は `send --contract` を exit 2 で落とすので発明しない） |
| `autoYes.mode` | `--auto-yes` 無しなら `"off"`（積極的な禁止）、有りなら `"safe"`。第9.1節 |
| `success` | `requireWorkEvidence: true` / `requireScopeClean: true`（常に真）/ `autoVerifyOnStop: false` |

**同一 plan → byte-identical な契約**である（時刻・乱数・環境を読まない）。plan が対象 file を1つも
挙げていない Issue は **dispatch しない**。契約を作れば `allow: []` になり、`requireScopeClean` を
`<allow が非空か>` にしていた頃はそこだけ scope ゲートが無効化されて worker が何でも書ける状態に
なっていた（対象 file を誰も名指せなかった Issue が最も広い権限を得るという反転。Issue #50）。
runner は send せず `contract_scope_unknown` を limitation に記録し、その wave を advance させない。
`requireScopeClean` は常に真なので、万一 allow が空の契約が作られても緩む側ではなく閉じる側に倒れる。
契約は `<out>/contracts/issue-<n>.yaml` にも
残す（worktree の写しは worker が書き換えうるため）。worktree-id は plan の `worktree_id`（あれば）→
なければ `commandmate ls --json` を branch で突き合わせて解決する（`commandmate sync` は無い）。
worktree path は path escape 検査を通す。repository-local な worker Skill を必須依存にしない。

フォールバック時（第8.1節）は従来どおり、plan だけから構成した **generic worker prompt** を
`commandmate send <worktree-id> <message>`（positional）で送る。どちらのモードでも worker が読む本文は
`<out>/prompts/issue-<n>.md` に残す。

### Step D3. 監督ループで駆動する（send 確定 / wait --verify / exit code 分岐 / 再指示）

実 Claude worker は **1メッセージ＝1ターン**で動き、各ターン後に **idle 化**する（#1468）。したがって
各 worker を監督ループで駆動する。**裁定の ground truth は `wait --verify` の exit code**、
**完了の ground truth は worktree ブランチの新規 commit** であり、この2つは別物である。

1. dispatch 開始前に `git rev-parse HEAD`（cwd=worktree）で開始時 SHA を記録する。
2. `send --contract` 直後に `commandmate capture <worktree-id> --json` で worker が動き出したかを確認し、
   未確定（Enter 未送信）なら **plain message を1回だけ送って**送信を確定させる
   （`--contract` での再送は task 行を二重に作るのでしない）。
3. `commandmate wait <worktree-id> --on-prompt agent --verify --timeout <sec>` で待つ（block）。
   `--on-prompt` は「**誰が prompt に答えるか**」であり、`agent` は「呼び出し元（この runner）に
   exit 10 で返す」、`human` は「人が UI で答えるまで wait が block し 10 を返さない」である。
   本 runner の方針は「自動応答せず停止して human へ提示」なので **`agent` が正しい**。
4. exit code で分岐する。

| exit | 意味 | 本 runner の扱い |
|---|---|---|
| `0` | 全ゲート pass | 裁定 **pass**。stdout の `GATE <id> PASS|FAIL` 行を `verification.gates` に転記する（第9節）。新規 commit あり → `completed`。commit が無ければ「ゲートは通ったが未 commit」なので commit 要求を送り、以降は `--verify` を**付けずに** wait する（pass で task は `succeeded` に遷移済みで、再検証は契約に束ならず exit 99 になる。#1620） |
| `20` | 判定して不合格 | `commandmate verify <wt> --json` で**失敗ゲートを特定**し、その内訳を引用して**再指示**。scope ゲート不合格なら、その logTail から**違反 path を転記**し「許可するには Issue の対象ファイルに追加して plan を作り直す。不可避なら停止して報告」というガイダンスを再指示に含める（#1678 B-2。CLI 表示側は CommandMate #1683）。`--max-turns` 到達でなお不合格なら、worker は `completed`／verification は `fail` として記録し **success に丸めない** |
| `21` | 作業証跡ゼロ（未着手） | pass ではない。継続 nudge を送って再度 `--verify` で待つ。`--max-turns` 到達でなお 21 なら **dispatch 失敗系**として `failed` |
| `10` | prompt 検出 | `capture` で内容を取得して human へ提示し停止。**自動応答しない**（`--auto-yes` 明示時のみ `respond yes`） |
| `99` | **判定に到達しなかった**（run が error / cancelled） | pass でも 20 でもない。**再指示ループへ流さない**（判定していないものの修正を worker に求めることになる）。verification は `not_run`、`verification_not_judged` を blocking に載せ `human_required` で停止する |
| `124` | timeout | `timeout` |
| `1` / `2` / その他 | インフラ系 | `failed` |

5. ターン数が `--max-turns`（既定 8）に達しても未 commit なら、当該 worker を `failed` とし honest に報告する
   （idle を完了と誤認しない）。

### Step D4. Wave barrier

Wave の **全 worker が `completed`（新規 commit を検出）** でなければ次 Wave へ進まない。

### Step D5. verification gate

`completed` の worker それぞれの裁定を集約する。契約経路では監督ループで得た exit code 由来の verdict を
そのまま使う（**同じ worktree を弱い judge で測り直さない**）。フォールバック経路では
**profile の baseline を worktree 内で再実行**する。どちらでも、pass の worker が揃ってはじめて次 Wave を
dispatch する。**worker completion を verification success と同一視しない。** 未完了 worker は検証せず、
`not_run` のままにする。**検証していないものを pass に丸めない。**

## 8.1 バージョンゲート（契約対応の確認。黙って劣化しない）

実行契約（`send --contract`）と契約裁定（`wait --verify` / `commandmate verify`）は
**CommandMate 0.17.0** で入った（[#1544](https://github.com/Kewton/CommandMate/issues/1544) /
[#1545](https://github.com/Kewton/CommandMate/issues/1545)）。それより古い CLI にはどれも無い。
そこで dispatch runner は**最初の Wave の前に一度だけ** `commandmate send --help` と
`commandmate wait --help` を実行し、`--contract` / `--verify` が載っているかを確認する。

| `--contract-mode` | 契約が使える | 契約が使えない |
|---|---|---|
| `auto`（既定） | 契約経路で dispatch する | **フォールバック**: 従来どおり profile baseline を再実行して裁定し、`contract_unsupported` を limitation に記録して理由を明示する |
| `require` | 契約経路で dispatch する | **停止**: 1件も dispatch せず `contract_unsupported` を blocking に載せ `failure` で終了する（弱い裁定に落ちるくらいなら実行しない） |
| `off` | probe せずフォールバック。`contract_disabled` を limitation に記録 | 同左 |

**どのモードでも、どちらの裁定機構で判定したかを report と summary に明示する。**
フォールバックは「同じ `verification.outcome: pass` を、より弱い判定で出す」ことになるので、
黙って落ちてはならない。

## 9. dispatch の出力

dispatch runner は report（[schemas/dispatch-report.v1.json](./schemas/dispatch-report.v1.json)）を
stdout に、`<out>/dispatch-report.json` と `<out>/dispatch-summary.md` を file に書く。

| status | 条件 | exit |
|---|---|---|
| `success` | 全 Wave dispatch・全 worker completed・全 verification pass・prompt なし | 0 |
| `partial` | 途中停止（worker 失敗・timeout・verification 失敗・prompt・drift） | 7 |
| `failure` | 1件も dispatch できない（plan 不正・最初の Wave 前 drift・CLI 不在） | 1 |

`stop_reason` の優先順位は `human_required` > **`verification_not_judged`（exit 99。`stop_reason` は
`dispatch_error`）** > `worker_failed` > `timeout` > `verification_failed` である。99 を
`worker_failed` や `verification_failed` より先に見るのは、**再 dispatch では解けない**からである
（誰も判定していない）。report は5つの completion check（`plan_approved`・
`drift_reconfirmed`・`parallelism_bounded`・`barrier_enforced`・`no_auto_prompt_response`）を
自己申告する。token・secret・絶対 path・raw terminal 全量は report に残さない（redaction）。

`dispatch_schema_version` は **1 のまま**である。`verification` には `gates`
（実行されたゲート id と各 verdict の一覧。Issue #47 / CommandMate #1678 B-5）が加わり、
**report 単体で「何を根拠に pass としたか」が読める**。gates は `wait --verify` の stdout の
`GATE <id> PASS|FAIL` 行から転記する（pass 後の `commandmate verify` 再実行は #1620 の
exit 99 を作るので行わない。exit 20 時に stdout から読めなければ、確認用 `verify --json` の
失敗ゲートで補う）。フォールバック経路（baseline 再実行）はゲートを持たないので `[]` とし、
実行 command は従来どおり `checks` に載る。merge / uat runner は
`worker_state === 'completed'` と `verification.outcome === 'pass'` の2つしか読まず、その enum 値と
意味は変えていないので、**両 runner は無改修で動く**。

## 9.1 Auto-Yes と契約 `autoYes` ポリシーの関係

この Skill の既定は **Auto-Yes off**（prompt は自動応答せず human へ提示）であり、契約導入後も変えない。
関係する機構は3つあり、**層が違う**。

| 層 | 誰が動くか | この runner での既定 |
|---|---|---|
| `--auto-yes`（本 runner の flag） | runner 自身が exit 10 のとき `commandmate respond <wt> yes` を送る | **off**。prompt は停止して human 提示 |
| 契約の `autoYes.mode` | CommandMate **サーバ側**の Auto-Yes poller が、契約の宣言に従ってプロンプトへの自動応答を**抑止**する（enforcement は #1547 で実装済み。ポリシーは抑止しかせず、答えを増やすことはない） | `--auto-yes` 無し → `"off"`（積極的な禁止）／`--auto-yes` 有り → `"safe"`（`yes_no` のみ） |
| `commandmate send --auto-yes` | 送信時にセッションの Auto-Yes を有効化する | **使わない** |

生成する契約が `mode: "off"` を書くのは、**runner の既定とサーバ側ポリシーを一致させる**ためである。
契約に `autoYes` ブロックを書かない（= `mode: null`）は「契約は何も述べていない」であって `off` とは
別であり、その場合サーバ側の従来動作がそのまま残る。ここを黙って `null` にすると、「runner は答えない
が、サーバは答えるかもしれない」という状態になる。`--auto-yes` を明示したときだけ `"safe"` に緩め、
その事実は `auto_yes: true` と limitation `auto_yes_used` として report に残る。

## 10. 完了条件

計画:

- [ ] default invocation が dry-run で、run directory 以外を変更していない
- [ ] explicit / inferred 依存が区別され、cycle・不完全 override・順序違反を拒否している
- [ ] file 衝突のある Issue が同一 Wave に無く、`max_parallel` が 1〜3
- [ ] 同じ入力から同じ plan が出る（`--run-id` 固定で diff を取って確認できる）

dispatch:

- [ ] `max_parallel` を超えて dispatch していない
- [ ] 前 Wave 未完了・verification 失敗時に後続 Wave を dispatch していない
- [ ] prompt 検出時に自動応答せず human-required として停止している
- [ ] worker completion だけを success 扱いしていない
- [ ] mutation 前に drift を再確認している
- [ ] 同一 plan から byte-identical な契約が生成されている（Claude/Codex parity）
- [ ] 契約対応の有無を実行冒頭で確認し、フォールバック／停止のどちらに入ったかを明示している
- [ ] exit 99（判定に到達せず）を 20（判定して不合格）の再指示ループへ流していない
- [ ] exit 21（作業証跡ゼロ）・99・124 を pass に丸めていない

---

# 第3部 PR 作成・CI 確認・guarded merge

dispatch report で verification pass した Issue を納品する。契約の正本は
[references/merge-contract.md](./references/merge-contract.md)、report の schema は
[schemas/merge-report.v1.json](./schemas/merge-report.v1.json) である。

## 11. merge runner の入力

```
merge.mjs --plan <承認済み plan.json> --dispatch <dispatch-report.json> (--create-prs | --merge-prs) [options]
```

CommandAgent の explicit phase flag 設計（ADR
[#1447](https://github.com/Kewton/CommandMate/issues/1447)）を踏襲し、**1 invocation で
mutating phase をちょうど1つだけ** 有効化する。`--create-prs` は PR 作成、`--merge-prs` は
CI 確認付きの guarded merge である。両方指定・どちらも未指定は `invalid_input` で拒否する。

| 名前 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `--plan <path>` | 必須 | なし | 承認済み `plan.json` |
| `--dispatch <path>` | 必須 | なし | dispatch runner の `dispatch-report.json`。eligible の唯一の根拠 |
| `--create-prs` / `--merge-prs` | どちらか1つ | なし | 有効化する mutating phase |
| `--approve` | 任意 | **off** | 明示承認。無ければ mutation しない preview |
| `--merge-method <m>` | 任意 | `squash` | merge 方式（`merge`/`squash`/`rebase`） |
| `--out <dir>` | 任意 | `<dispatch-dir>/<phase>` | 出力先。既存なら `out_exists` |
| `--gh <path>` | 任意 | `gh` | PR 作成・CI 確認・merge の GitHub CLI |
| `--git <path>` | 任意 | `git` | branch push と base preflight の git |

## 12. merge の手順

対象は dispatch report で **`completed` かつ verification `pass`** の Issue だけである
（verification gate の継承）。plan の `merge_order` 順に処理する。

### Step M0. eligible を決める

dispatch report から eligible 集合を取る。空なら `no_eligible_issues` を載せて no-op success
とし、mutation しない。**verification が pass していない Issue を PR/merge に変えない。**

### Step M1. preflight（read-only）

`gh --version`・`gh repo view`・`git rev-parse --verify <base>` を確認する。blocking な失敗が
あれば `failure`（`preflight_failed`）で、何も試さず終了する。

### Step M2. 2つの gate を守る

- **承認 gate** — `--approve` が無ければ push・PR 作成・merge を **一切しない** preview とする。
  `mutated` は false のままにする。
- **CI gate（`--merge-prs`）** — PR を merge するのは CI checks が **すべて green** のときだけ。
  failure は `ci_failed`、pending・check 0 件は `ci_pending` として **merge を拒否** する。

### Step M3-a. `--create-prs`

各 eligible の branch を（承認時のみ）`git push` し、self-contained な PR body
（objective・受入条件・baseline・`Resolves #n`）を `<out>/pr-bodies/issue-<n>.md` に残して
`gh pr create` する。push または create が失敗したら `pr_failed` で停止する。

**Issue 自動クローズの到達性を1回だけ確認する。** phase の冒頭で read-only の
`gh repo view <repo> --json defaultBranchRef` を **invocation あたり1回**引き、PR の base
（`plan.profile.base` から remote 接頭辞を落としたもの）がデフォルトブランチかどうかを見る。
GitHub が `Resolves #n` で Issue を自動クローズするのは**デフォルトブランチへの merge 時だけ**
なので、`feature/* → develop → stg → main`（デフォルトは `main`）のような多段運用で `develop`
宛に PR を出すと、PR を merge しても **Issue は open のまま**残る
（[#39](https://github.com/Kewton/commandmate-skills/issues/39)）。

- base ≠ デフォルトブランチ → report の `limitations[]` に
  `issue_autoclose_not_default_branch` を記録し、各 PR body にも同趣旨の注記を1行足す。
  **merge 後に手動でクローズする必要がある。**
- base = デフォルトブランチ → 何も記録しない。
- `gh repo view` が失敗した / `defaultBranchRef` が返らない → **照合をスキップするだけ**で、
  PR 作成フローは阻害しない（不明を不一致として扱わない）。
- 記録に留める。`gh issue close` を勝手に実行することはしない。

### Step M3-b. `--merge-prs`

各 eligible の PR を `gh pr view` で発見し、`gh pr checks` で CI を確認する。CI green かつ
承認ありのときだけ `gh pr merge --<method>` で merge する。CI が green でない、PR が無い、
merge が conflict のときは停止し、`ci_failed`/`ci_pending`/`pr_missing`/`merge_failed` を記録する。

### Step M4. 記録する

失敗・blocked は途中停止し、`blocking_reasons` と該当 target に記録する。停止後の eligible は
outcome `skipped` として残す。**failure を success に丸めない。** token・secret・絶対 path・
raw terminal は report/artifact に残さない（redaction）。

## 13. merge の出力

merge runner は report（[schemas/merge-report.v1.json](./schemas/merge-report.v1.json)）を
stdout に、`<out>/merge-report.json` と `<out>/merge-summary.md` を file に書く。

| status | 条件 | exit |
|---|---|---|
| `success` | 全 eligible を失敗なく処理（preview を含む） | 0 |
| `partial` | 途中停止（PR 作成失敗・CI failure/pending・PR 不在・merge conflict） | 7 |
| `failure` | 何も試せない（preflight 失敗・plan 不正・invalid input） | 1 |

report は5つの completion check（`single_phase`・`approval_enforced`・`verification_gated`・
`ci_gated`・`failures_not_rounded`）を自己申告する。

`limitations[]` は「停止はしていないが、後から効いてくる制約」を記録する。

| limitation code | 意味 |
|---|---|
| `issue_autoclose_not_default_branch` | base がデフォルトブランチでないため `Resolves #n` が効かない。merge 後に手動クローズが要る（Step M3-a） |
| `no_eligible_issues` | dispatch report に completed かつ verification pass の Issue が無い |
| `unsafe_branch` | branch 名が safe-ref guard に弾かれた |
| `completion_check_failed` | completion check のどれかが passed でない |

merge 完了条件:

- [ ] 1 invocation で mutating phase を1つだけ有効化している
- [ ] `--approve` 無しに push・PR 作成・merge をしていない
- [ ] CI green 無しに merge していない
- [ ] verification pass した Issue だけを対象にしている
- [ ] PR 作成失敗・CI failure・merge conflict を blocked/partial として停止・記録している

---

# 第4部 UAT 実行・回数上限つき修正ループ

dispatch report で verification pass した Issue に受入テスト（UAT）を実行し、不合格なら回数上限つきで
修正する。契約の正本は [references/uat-contract.md](./references/uat-contract.md)、report の schema は
[schemas/uat-report.v1.json](./schemas/uat-report.v1.json) である。

裁定は **機械ゲート（profile baseline の再実行）と意味ゲート（Issue の受入条件に対する判定）の二層**で
ある。意味ゲートの入力は [cmate-acceptance-test](../cmate-acceptance-test/) の result document
（[`acceptance-result.v1`](../cmate-acceptance-test/schemas/acceptance-result.v1.json)）であり、その
**生成はエージェント側の手順**（第15節 Step U0-b）、**合成は uat runner の決定的処理**である。
「baseline は green だが受入条件は未達」を `success` に丸めないことがこの二層化の目的である。

## 14. uat runner の入力

```
uat.mjs --plan <承認済み plan.json> --dispatch <dispatch-report.json> (--write-uat | --create-uat-fix-worktrees) [options]
```

CommandAgent の explicit phase flag 設計（`--write-uat` / `--create-uat-fix-worktrees` 相当、ADR
[#1447](https://github.com/Kewton/CommandMate/issues/1447)）を踏襲し、**1 invocation で phase をちょうど
1つだけ** 有効化する。`--write-uat` は UAT の read-only 実行、`--create-uat-fix-worktrees` は修正ループ
である。両方指定・どちらも未指定は `invalid_input` で拒否する。

| 名前 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `--plan <path>` | 必須 | なし | 承認済み `plan.json` |
| `--dispatch <path>` | 必須 | なし | dispatch runner の `dispatch-report.json`。eligible の唯一の根拠 |
| `--write-uat` / `--create-uat-fix-worktrees` | どちらか1つ | なし | 有効化する phase |
| `--approve` | 任意 | **off** | fix loop の明示承認。無ければ mutation しない preview |
| `--max-attempts <1-5>` | 任意 | `2` | fix 試行の回数上限。ループはこれを超えない |
| `--acceptance-dir <dir>` | 任意 | なし | 意味ゲートの入力。`issue-<n>.json`（`acceptance-result.v1`）を置いた directory。無ければ機械ゲートのみで裁定する |
| `--require-acceptance` | 任意 | off | result 欠落・schema 不適合・対象 Issue 不一致を limitation ではなく **不合格** として扱う。`--acceptance-dir` が必須 |
| `--out <dir>` | 任意 | `<dispatch-dir>/<phase>` | 出力先。既存なら `out_exists` |
| `--cli` / `--git` / `--gh <path>` | 任意 | `commandmate`/`git`/`gh` | UAT・fix dispatch・再検証・再merge・preflight に使う CLI |

## 15. uat の手順

対象は dispatch report で **`completed` かつ verification `pass`** の Issue だけである（verification gate
の継承）。plan の `merge_order` 順に処理する。eligible が空なら `no_eligible_issues` を載せて no-op
success とする。

裁定は **二層**である（[#1616](https://github.com/Kewton/CommandMate/issues/1616)）。

| 層 | 何を見るか | 誰が出すか |
|---|---|---|
| **機械ゲート** | profile の baseline（lint/test/build 等）が worktree 内で全部 exit 0 か | uat runner（決定的） |
| **意味ゲート** | Issue の**受入条件**が満たされているか（Go / Conditional Go / No-Go） | **エージェント**が cmate-acceptance-test を実行して出す |

**判定の生成はエージェント側の手順（Step U0-b）であり、uat runner の中で LLM 判定はしない。** runner は
result document を読み・schema 検証し・対象 Issue を照合して**合成するだけ**である。

### Step U0-a. preflight（read-only）

`commandmate --version`・`gh repo view`・`git rev-parse --verify <base>` を確認する。blocking な失敗が
あれば `failure`（`preflight_failed`）で、何も試さず終了する。

### Step U0-b. 受入判定を生成する（エージェントの手順・意味ゲート）

dispatch 完了後・UAT 裁定前に、**eligible な Issue ごとに** [cmate-acceptance-test](../cmate-acceptance-test/)
を実行し、その result document を `<out>/acceptance/issue-<n>.json` に置く。

1. eligible 集合を dispatch report から取る（`worker_state: completed` かつ `verification.outcome: pass`）。
2. 各 Issue について cmate-acceptance-test を、`issue_ref` = その Issue、`target_ref` = その Issue の
   **worktree**（plan の `worktree`）、`result_path` = `<acceptance-dir>/issue-<n>.json` で実行する。
   Issue 本文は read-only で取得する（**書き戻さない**）。
3. 出力が [`acceptance-result.v1`](../cmate-acceptance-test/schemas/acceptance-result.v1.json) に適合し、
   `target.issue_ref` がその Issue を指していることを確認する。**別 Issue の result を流用しない。**
4. その directory を `--acceptance-dir` として uat runner に渡す。受入判定を必須にするなら
   `--require-acceptance` も渡す。

生成できない Issue があるときに、他 Issue の result を代用したり、判定を推測で書いたりしてはならない。
**生成できなかったこと自体が記録すべき事実**である（runner が `acceptance_not_run` として記録する）。

### Step U1-a. `--write-uat`（read-only assessment）

各 eligible の worktree 内で **profile の baseline を実行**して機械ゲートを判定し（`commandmate uat` は
無い。全 baseline command が exit 0 なら pass）、`--acceptance-dir` があれば意味ゲートと合成する。
合成規則は次のとおりで、**検証していないものを pass に丸めない**。

| 機械ゲート | 意味ゲート | 合成 verdict | 扱い |
|---|---|---|---|
| pass | `go` | `pass` | 合格 |
| pass | `conditional_go` | `conditional` | **pass に丸めない**。条件を report に記録し `partial`（`acceptance_conditional`）で human に提示する。fix loop は自動修正しない |
| pass | `no_go` | `fail` | 不合格。findings を fix worker prompt に引用する |
| fail | 任意 | `fail` | 不合格（機械ゲートで既に落ちている） |
| pass | result 無し / schema 不適合 / 対象 Issue 不一致 | `pass` | 従来どおり baseline のみで裁定し、`limitations` に `acceptance_not_run` を記録する（**黙って劣化しない**）。`--require-acceptance` 時は `fail` |
| pass | `--acceptance-dir` 未指定 | `pass` | 意味ゲート無し。従来挙動（回帰なし）。report にその旨を記録する |

全 pass なら `success`、不合格があれば `partial`（`uat_failed`）、`conditional` が残れば
`partial`（`acceptance_conditional`）とし、該当 Issue と next action を返す。worktree も fix も
再merge もしない。per-issue の baseline・acceptance・合成 verdict は uat-report に記録する。

### Step U1-b. `--create-uat-fix-worktrees`（回数上限つき修正ループ）

`target` を eligible として、各反復（= 1 attempt、`attempts[]` に **append**）で:

1. **assess** — `target` の各 Issue の現行 worktree（初回は dispatch worktree、fix が成立した後はその
   fix worktree）で **baseline を再実行**し、意味ゲートと合成する（read-only）。合成 verdict が
   `conditional` の Issue は **`target` から外す**（human 判断であって自動修正の対象ではない）。
   `fail` が無くなればループを抜ける。`conditional` が残っていれば `success` にはせず
   `partial`（`acceptance_conditional`）とする。
2. **preview** — `--approve` が無ければ、不合格集合を報告して停止する（`partial`）。mutation しない。
3. **上限判定** — これまでの fix 回数が `--max-attempts` に達していれば、不合格を `unresolved_issues` に
   載せて **`blocked`（`max_attempts_reached`）** で停止する。**成功に丸めない。**
4. **fix**（承認あり・上限未達） — 不合格 Issue ごとに fix worktree を作り（#1448 worktree-result の形、
   base を resolved SHA に再確認、既存 worktree を暗黙上書きしない）、fix worker を **dispatch と同じ監督
   ループ**で駆動する（#1468）。fix worktree の開始時 SHA を記録し、`commandmate send`（直後の `capture`
   で送信確定を確認、未確定なら1回だけ再送）→ `commandmate wait` で idle 化を待つ。**wait の idle は完了
   ではない**。fix branch に新規 commit が出れば `completed`、未 commit なら継続 nudge を送って `wait` へ
   戻る（fix prompt に「完了時に単一 commit」を明記）。prompt・`--max-turns`（既定 8）到達で未 commit なら
   `fix_failed` で停止。fix worker prompt には、意味ゲートが `no_go` を出していればその **verdict と
   findings（fail した受入条件・blocking reason）を引用**する（「UAT に失敗した」だけを渡さない）。
   完了した fix のみ **fix worktree 内で baseline を再実行して再検証**する。
   再検証 pass した fix branch のみ `git merge` で **再merge** する（再検証不合格は再merge せず、次反復で
   再試行）。worktree 作成失敗・再merge conflict はそれぞれ `worktree_failed`/`remerge_failed` で停止する。
   `target` を不合格集合に更新して次の反復（再UAT）へ進む。

`attempts_used`（fix 回数）は常に `max_attempts` 以下である。既存 run artifact は上書きせず、attempt は
`<out>/attempts/attempt-<n>/` と `<out>/attempts/history.jsonl` に append する。

## 16. uat の出力

uat runner は report（[schemas/uat-report.v1.json](./schemas/uat-report.v1.json)）を stdout に、
`<out>/uat-report.json` と `<out>/uat-summary.md` を file に書く。`status` は4値である。

| status | 条件 | exit |
|---|---|---|
| `success` | 全 eligible が合成裁定を通過（修正後の pass を含む）／eligible なしの no-op | 0 |
| `partial` | preview・不合格の assess・`conditional_go` の保持・fix 途中停止（worktree/fix/remerge 失敗） | 7 |
| `blocked` | fix 上限到達でなお不合格が残る（成功に丸めない） | 8 |
| `failure` | 何も試せない（preflight 失敗・plan/dispatch 不正・invalid input） | 1 |

report は6つの completion check（`single_phase`・`approval_enforced`・`attempts_bounded`・
`blocked_reported`・`verification_gated`・`acceptance_not_rounded`）を自己申告し、`next_actions` に
次の一手を返す。token・secret・絶対 path・raw terminal は report/artifact に残さない（redaction）。
acceptance result の directory path も report に残さない（file 名のみ記録する）。

uat 完了条件:

- [ ] 1 invocation で phase を1つだけ有効化している
- [ ] `--approve` 無しに worktree 作成・fix dispatch・再merge をしていない
- [ ] fix 回数が `--max-attempts` を超えていない（回数無制限にしていない）
- [ ] 上限到達でなお不合格なら `blocked` で停止し success に丸めていない
- [ ] verification pass した Issue だけを対象にし、再merge した fix はすべて再検証 pass だった
- [ ] 既存 run artifact を上書きせず attempt を append している
- [ ] `conditional_go` を pass に丸めず、`no_go` を不合格として扱っている
- [ ] 受入判定が得られなかった Issue を、黙って baseline のみの pass にしていない（`acceptance_not_run`）

## 17. 参照

- [references/profile-contract.md](./references/profile-contract.md) — profile の形と unverified の扱い
- [references/plan-contract.md](./references/plan-contract.md) — 依存・Wave・risk・result の契約
- [references/dispatch-contract.md](./references/dispatch-contract.md) — dispatch・監督ループ・verification gate の契約
- [references/merge-contract.md](./references/merge-contract.md) — PR 作成・CI 確認・guarded merge の契約
- [references/uat-contract.md](./references/uat-contract.md) — UAT 実行・二層裁定・回数上限つき修正ループの契約
- [../cmate-acceptance-test/schemas/acceptance-result.v1.json](../cmate-acceptance-test/schemas/acceptance-result.v1.json) — 意味ゲートの入力（受入判定 result document）の schema
- [references/agent-compatibility.md](./references/agent-compatibility.md) — Agent 差異と fallback
- [schemas/execution-plan.v1.json](./schemas/execution-plan.v1.json) — plan の機械検証用 schema
- [schemas/orchestrate-result.v1.json](./schemas/orchestrate-result.v1.json) — planner result envelope の schema
- [schemas/dispatch-report.v1.json](./schemas/dispatch-report.v1.json) — dispatch report の schema
- [schemas/merge-report.v1.json](./schemas/merge-report.v1.json) — merge report の schema
- [schemas/uat-report.v1.json](./schemas/uat-report.v1.json) — UAT report の schema
