# plan / result contract v1

`cmate-worktree-cleanup` が返す2つの文書を定義する。機械検証用の正本は
[../schemas/cleanup-plan.v1.json](../schemas/cleanup-plan.v1.json) と
[../schemas/cleanup-result.v1.json](../schemas/cleanup-result.v1.json) であり、
この文書は読み方と、schema では表現できない規則を述べる。

`plan_schema_version` / `result_schema_version` はともに 1 である。field の追加・削除・
意味の変更は version を上げて行う。**未知の field を足さないこと。** 受け手は
schema にない field を無視せず、契約違反として扱う。

## 1. plan（dry-run preview）

plan は必ず dry-run で作る。`mode` は `dry_run` 固定。deletion は含まない。

- `candidates` — `git worktree list --porcelain` から発見し、除外後に残った worktree。
  各要素は `state`（clean/dirty/detached/locked/missing）、`proof`、`decision`、
  `delete_method`、`skip_reason`、`diagnostics` を持つ。
- `excluded` — current / integration / 対象外。`reason` を必ず付ける。指定されても消せない。
- `fetch` — `attempted` / `succeeded` / `remote` / `base`。`succeeded` が false のとき、
  remote を要する候補はすべて `unverifiable` になっていること。
- `decision: delete` は `state: clean` かつ `proof.type ∈ {direct, merged_equivalent}` の
  ときだけ。それ以外は必ず `skip` で、`skip_reason` を埋める。

plan は「何を消し、何を残すか」を **証跡付きで** 見せるためのものである。
removed と skipped を混ぜず、target ごとに理由を示す。

## 2. result（apply 後、または dry-run のまま終わった場合）

`mode` は `dry_run` か `apply`。`apply` は confirmation と drift 再検査を経た後だけ。

### 2.1 status

| status | 条件 |
|---|---|
| `success` | run が完了し、deletable な対象がすべて解決した（消した／安全に残した） |
| `partial` | unverifiable として残した対象がある／apply が中断した／sync が実行できない／guarded delete が race で失敗した |
| `failure` | plan を作れなかった（入力不正、base 解決不能 等） |

`unverifiable` が残っただけで `failure` にはしない。それは「安全に消せなかった」であって、
run の失敗ではない。sync の `unavailable` / `failed` も `failure` にしない（[safety.md](./safety.md) 第5節）。

### 2.2 removed と skipped

- `removed` は消した worktree のみ。dry-run では空。各要素に `proof_type`（`direct` /
  `merged_equivalent`）と `method`（`direct_branch_d` / `guarded_ref_delete`）、
  `evidence`（`base`、`verified_at`、direct なら `ancestor_verified`、
  merged_equivalent なら `pr_number` / `merge_commit_oid` / `expected_old_oid`）を付ける。
- `skipped` は残した worktree のみ。dirty / detached / unmerged / unverifiable / excluded /
  plan_drift はすべてここ。`reason` と `proof_type`（`excluded` を含む）を付ける。
- 同じ worktree が `removed` と `skipped` の両方に現れてはならない。

### 2.3 confirmation

`required` は常に true。`granted` は true / false / null。**null を yes と見なさない。**
非対話 invocation では null のまま `mode` を `dry_run` に留める。`granted_targets` に
利用者が承認した worktree だけを列挙し、apply はその集合の worktree だけを消す。

### 2.4 commandmate_sync

`outcome` は `synced` / `unavailable` / `failed` / `skipped`。`unavailable` / `failed` の
とき `worktree_ids` の該当分を null（欠落）にする。**推測 id を書かない。**

### 2.5 next_actions

この Skill が **あえて行わなかった** 手動 follow-up。`reason` は dirty / detached /
unmerged / unverifiable / server / process / tmux / database / log / sync。
server〜log は診断のみで、ここに action として残すが実行はしない。

### 2.6 completion_check

`checks` は6件で、id は次の6つがちょうど1回ずつ現れる。`passed` は6件すべて true の
ときだけ true。

| id | 内容 |
|---|---|
| `exclusions_honored` | current / integration worktree を一切消していない |
| `zero_delete_honored` | dirty / detached / unmerged / unverifiable を一切消していない |
| `proof_sufficient` | `removed` の各要素が direct または4条件完備の merged_equivalent 証跡を持つ |
| `guarded_delete_used` | merged_equivalent の削除が expected-old-OID 付き delete で、force / `-D` を使っていない |
| `drift_rechecked` | apply の各削除前に plan 後 drift を再検査した（dry-run では「apply していない」で true） |
| `no_sensitive_values` | result・summary に token/secret/絶対path/raw GitHub response が無い |

いずれかが false なら `status` は `success` にならない。

## 3. summary_markdown

人が読む要約。次の見出しを、この順序でちょうど1回ずつ含める。

```markdown
## 判定
## 対象と profile
## 削除したもの
## 残したもの（理由つき）
## 診断と手動next action
## sync と走査範囲
```

規則:

- 「判定」の先頭で `status` と、消した件数・残した件数を1行で示す。
- 「削除したもの」と「残したもの」を混ぜない。残したものには reason を必ず添える。
- 「PR が merged だから安全」と書かない。tip / tree / reachability のどれで
  判定したかを短く示す。
- 絶対 path・secret・raw response を書かない。worktree は `worktree_ref`（basename）で示す。
- dry-run のときは、これが preview であり何も削除していないことを明示する。

## 4. version 運用

- field / enum 値の追加・削除・意味変更 → schema version を上げる。
- 文言・見出しの調整のみ → Skill の `version` だけを上げる。
