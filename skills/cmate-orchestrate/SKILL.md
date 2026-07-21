---
name: cmate-orchestrate
description: 複数 Issue を並列実行するための計画を dry-run で立てる。Issue 品質・依存（explicit/inferred）・file conflict を分析し、cycle や不完全 override を拒否したうえで、file 衝突の無い承認可能な Wave plan と risk・権限・実行 command を、決定的で検証可能な artifact として返す。mutation は一切行わない。
---

# cmate-orchestrate（計画コア）

複数の Issue を並列で進める前に、**何をどの順で、どこまで同時に**やれるかを
安全に見積もるための手順である。この version が実装するのは計画コア、すなわち
**dry-run による Wave plan の生成まで**である。

worker dispatch・PR 作成・merge・UAT 修正ループは後続 Issue
（[#1454-1456](https://github.com/Kewton/CommandMate/issues/1452)）の担当であり、
この Skill は **実装しない**。default invocation は dry-run で、run directory 以外の
いかなる状態も変えない。

計画は同梱の deterministic runner（`scripts/orchestrate.mjs`、Node stdlib のみ）が
行う。同じ入力からは同じ plan が出る（Claude/Codex parity）。

## 1. この Skill が答える問い

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
| `--max-parallel <1-3>` | 任意 | `3` | 1 Wave の最大幅 |
| `--depends <a:b>` | 任意 | なし | override: `a` が `b` に依存（繰り返し可） |
| `--no-infer` | 任意 | off | 推論依存を無効化 |
| `--order <a,b,...>` | 任意 | なし | Issue 順序の主張。依存に反すれば拒否 |
| `--run-id <id>` | 任意 | 入力 hash | run_id の明示 |
| `--runs-dir <path>` | 任意 | `.commandmate/orchestrate/runs` | run artifact の出力先 |
| `--phase <plan>` | 任意 | `plan` | `plan` のみ実装。mutating phase は拒否 |
| `--allow-unverified` | 任意 | off | unverified profile での planning を許可 |

base branch・branch 名・worktree path・baseline は **profile から解決**する。
`develop` や `npm`/`cargo` を入力や手順で hardcode しない。

## 3. 権限と禁止事項

宣言している権限は `filesystem_read` / `filesystem_write` / `process_execution` /
`network_access` である。これは後続 phase まで含めた orchestration 全体が
要求する権限であり、plan にも同じ集合を提示する。

この version の手順として **禁止** するもの:

- worktree の作成、worker への dispatch、`commandmate send` / `wait` / `capture`
- PR の作成、CI のトリガ、merge、UAT 修正ループ
- 対象リポジトリの branch・Issue・PR の変更

`--issue-json` を使わない場合、read-only の `gh issue view` で Issue を取得する。
これは唯一の network access であり、mutation を伴わない。

セキュリティ:

- client 入力（Issue 本文由来）の絶対 path・`..`・drive path は採用しない。
- token・secret・絶対 path は plan/result/artifact へ残さない（redaction）。

## 4. 手順

### Step 0. 入力を検証する

Issue 番号が1件以上あること、`--max-parallel` が 1〜3 であること、
`--phase` が `plan` であることを確認する。mutating phase（`dispatch`/`pr`/`merge`/`uat`）が
指定されたら、実行せず `not_implemented` で終了する。

### Step 1. profile を解決する

`--profile` / `--profile-json` から profile を解決する。unverified profile は、
`--allow-unverified` が無ければ `unverified_profile` で終了する
（[references/profile-contract.md](./references/profile-contract.md) 第3節）。

### Step 2. Issue を取得する

`--issue-json` があればそれを、無ければ `gh issue view` で各 Issue を取得する。
取得できない Issue があれば `load_error` で終了する。

### Step 3. 各 Issue を分析する

Issue ごとに objective・受入条件・suspected/reference files・test 期待・
blocking question を抽出する。抽出時に token・secret・絶対 path を redaction する。
受入条件や対象 file が読み取れない Issue には blocking question を立てる。

### Step 4. 依存を解決する

explicit（本文由来）・inferred（推論）・override（`--depends`）を
[references/plan-contract.md](./references/plan-contract.md) 第3節の規則で統合する。
cycle・不完全 override・順序違反（`--order`）はここで **拒否** する。
集合外を指す explicit 依存は warning に落とし、`status` を `partial` にする。

### Step 5. Wave を組む

依存を満たし、file 衝突を同一 Wave に入れず、各 Wave を `max_parallel` 以下にする
（同 reference 第4節）。merge 順は Wave の平坦化である。

### Step 6. risk・permissions・commands を出す

risk factor を決定的に導き（同 reference 第6節）、要求権限と、plan の根拠になる
read-only command・baseline 検証 command（すべて `executed: false`）を列挙する。

### Step 7. artifact を書く

`<runs-dir>/<run_id>/` に `plan.json`・`result.json`・`manifest.md`・
`issue-analysis.md`・`dependency-plan.md` を書く。run directory が既にあれば
上書きせず `run_exists` で終了する。

### Step 8. completion check を実行する

result を返す前に、5つの check を自己申告する
（[references/plan-contract.md](./references/plan-contract.md) 第8節）。
いずれかが false なら `status` を `success` にしない。

## 5. 出力

runner は result envelope（[schemas/orchestrate-result.v1.json](./schemas/orchestrate-result.v1.json)）を
stdout に、進捗 notice を stderr に出す。`status` は3値。

- `success` — plan を生成し、warning が無い
- `partial` — plan は生成したが warning がある（例: 集合外依存）
- `failure` — plan を生成できない。`errors` に理由を持つ

plan 本体は [schemas/execution-plan.v1.json](./schemas/execution-plan.v1.json) に適合する。

## 6. 失敗時の動作

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

## 7. 完了条件

- [ ] default invocation が dry-run で、run directory 以外を変更していない
- [ ] explicit / inferred 依存が区別され、cycle・不完全 override・順序違反を拒否している
- [ ] file 衝突のある Issue が同一 Wave に無い
- [ ] `max_parallel` が 1〜3 で、run artifact が unique run ID 配下にある
- [ ] 同じ入力から同じ plan が出る（`--run-id` 固定で diff を取って確認できる）
- [ ] `completion_check.passed` が true、または `status` が `partial`/`failure` で理由がある

## 8. 参照

- [references/profile-contract.md](./references/profile-contract.md) — profile の形と unverified の扱い
- [references/plan-contract.md](./references/plan-contract.md) — 依存・Wave・risk・result の契約
- [references/agent-compatibility.md](./references/agent-compatibility.md) — Agent 差異と fallback
- [schemas/execution-plan.v1.json](./schemas/execution-plan.v1.json) — plan の機械検証用 schema
- [schemas/orchestrate-result.v1.json](./schemas/orchestrate-result.v1.json) — result envelope の schema
