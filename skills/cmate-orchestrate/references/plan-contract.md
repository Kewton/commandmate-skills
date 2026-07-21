# plan 契約 v1

`cmate-orchestrate` が dry-run で生成する **execution plan** の定義である。
機械検証用の正本は
[../schemas/execution-plan.v1.json](../schemas/execution-plan.v1.json)（plan 本体）と
[../schemas/orchestrate-result.v1.json](../schemas/orchestrate-result.v1.json)（result envelope）
であり、この文書はその読み方と、schema では表現できない規則を述べる。

`plan_schema_version` は 1 である。field の追加・削除・意味の変更、および enum への
値の追加は version を上げて行う。**未知の field を足さないこと。** 受け手は
schema にない field を無視せず、契約違反として扱う。

## 1. 決定性（Claude/Codex parity）

plan は入力の純粋関数である。同じ入力からは byte 単位で同じ plan が出る。
plan を決める入力は次だけである。

- Issue 集合（`issues`）
- base branch（profile 由来、`--base` で上書き可）
- profile（`id` と `repository`）
- `max_parallel`
- dependency override（`--depends`）と `--no-infer`
- `--order`
- `phase`

run 先の directory（`--runs-dir`）や wall clock は plan に影響しない。
run_id の既定値も上記入力の SHA-256 から導くので、同じ入力なら run_id まで一致する。
これが Claude で回した結果と Codex で回した結果を突き合わせられる根拠である。

## 2. run の隔離

- run artifact は `<runs-dir>/<run_id>/` 配下に書く。
- run_id の既定は入力 hash（`plan-<12hex>`）。`--run-id` で明示上書きできる。
- run directory が既に存在する場合は **上書きせず** `run_exists` で失敗する。

## 3. dependency

edge は「`issue` が `depends_on` に依存する」を表す。`kind` は3種。

| kind | 由来 | 優先度 |
|---|---|---|
| `override` | `--depends <a:b>` で明示指定 | 最高 |
| `explicit` | Issue 本文の記述（`depends on #N` / `依存` 節の `#N` 等） | 中 |
| `inferred` | 推論（下記） | 最低 |

同じ (issue, depends_on) に複数の由来が付く場合、優先度の高い kind を採用する。

### 3.1 inferred の規則

推論は「共有 contract の消費者は、その生産者に依存する」という1規則だけである。

- **生産者 signal**: title/body が schema・contract・interface・protocol・型定義・
  スキーマ・契約 等を含む。
- **消費者 signal**: title/body が implement・integrate・consume・利用・連携・実装 等を含む。
- **接続条件**: 生産者と消費者が **共通の topic token** を1つ以上持つ
  （title/body の4文字以上の英数語、stopword 除く）。

file overlap は依存では **なく** conflict として扱う（同一 Wave に置かない、第5節）。
推論は heuristic であり、`--depends` で上書き、`--no-infer` で無効化できる。

### 3.2 拒否する dependency

次はいずれも plan を生成せず失敗する。

| code | 条件 |
|---|---|
| `cycle_detected` | 解決後の依存 graph に閉路がある |
| `override_incomplete` | `--depends` が malformed、または plan 内に無い Issue を指す |
| `dependency_order_violation` | `--order` が集合の permutation でない、または依存順に反する |

Issue 本文が **集合外**の Issue（例: 既に merge 済みの前提）を指す explicit 依存は、
失敗ではなく `warnings`（`external_dependency`）に落とし、scheduling からは外す。
この場合 result の `status` は `partial` になる。

## 4. Wave

`waves` は Wave の順序付き配列で、各 Wave は Issue 番号の配列である。
Wave 生成の規則は次の3つ。

1. **依存充足** — ある Issue を Wave に入れられるのは、その依存がすべて
   より前の Wave で完了している場合だけ。
2. **conflict 回避** — suspected file が重なる2つの Issue を同一 Wave に置かない。
3. **幅の上限** — 各 Wave の Issue 数は `max_parallel`（1〜3）以下。

`merge_order` は Wave を先頭から平坦化したものである。

## 5. issue の classification

| 値 | 意味 |
|---|---|
| `dependent` | 依存 edge を1つ以上持つ |
| `conflicting` | 依存は無いが、他 Issue と suspected file が重なる |
| `independent` | 依存も conflict も無い |

## 6. risk

`risk.level` は factor の最大 severity である。factor は決定的に導く。

| code | severity | 条件 |
|---|---|---|
| `unverified_profile` | high | profile が unverified |
| `file_conflict` | moderate | file が重なる Issue pair がある |
| `cross_issue_dependency` | moderate | 依存 edge がある |
| `open_questions` | moderate | blocking question を持つ Issue がある |
| `batch_size` | low | Issue 数が `max_parallel` の1 Wave を超える |

## 7. permissions / commands

`permissions` は、後続 phase まで含めた orchestration 全体が要求する権限
（manifest の `declared_permissions` と一致）を、plan 段階で提示するものである。

`commands` は plan の根拠になった read-only command と、worker が回す baseline 検証を
列挙する。すべて `executed: false`（planner は1つも実行しない）。
worktree 作成・dispatch・PR・merge といった mutating command は plan の `commands` に
**含めない**。dispatch と監督ループは、承認済み plan を入力に取る別 runner
（[dispatch-contract.md](./dispatch-contract.md)）の担当であり、PR 作成・merge・UAT 修正ループは
後続 [#1455-1456](https://github.com/Kewton/CommandMate/issues/1452) の担当である。

## 8. completion_check（result）

result envelope は5つの check を自己申告する。

| id | 内容 |
|---|---|
| `dry_run_only` | mutating phase を実行していない |
| `dependencies_validated` | cycle・不完全 override・順序違反が無い |
| `waves_conflict_free` | どの Wave も file 重複 pair を含まない |
| `run_isolated` | run directory が unique で、上書きしていない |
| `deterministic` | plan が入力の純粋関数である |

`passed` は5件すべて true のときだけ true。`status` が `failure` のときは
`passed` は false で、`errors` に理由を持つ。

## 9. version 運用

- field の追加・削除・意味の変更、enum への値追加 → `plan_schema_version`（または
  `result_schema_version`）を上げる。
- 文言・見出しの調整のみ → Skill の `version` だけを上げる。
