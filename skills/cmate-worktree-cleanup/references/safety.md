# safety規約

`cmate-worktree-cleanup` は破壊的操作を行う Skill である。`declared_risk` は `high`。
この文書は、削除方式・除外規則・profile・診断のみ扱う範囲・redaction を定める。
SKILL.md の Step 0 / Step 5 / Step 6 から参照される。

安全基準は CommandAgent 版の honest-failure semantics（dirty/unmerged は拒否し、
force remove や `branch -D` を使わない）を採用する。CommandMate 版が持つ利便性
（server/tmux 停止、force remove、DB/log 削除）は、この Skill では **破壊的操作から分離** し、
診断表示に留める。

## 1. 絶対に行わないこと

以下は入力で要求されても実行しない。実行してよいか利用者に尋ねることもしない。

- `git worktree remove --force` — uncommitted / untracked work を失う。
- `git branch -D` — 未 merge の branch を証跡なく消す。
- 無条件の process kill（PID / port だけで別 worktree や別 user の process を止める）。
- server / process / tmux session の自動停止。
- CommandMate の DB / log / cache の自動削除。
- remote branch の削除。
- rollback / backup / Skill Runtime の停止。
- 利用者が渡した path を直接 `git worktree remove` すること（第4節）。

これらは CommandMate 版 `worktree-cleanup` に含まれるが、本 Skill の scope 外である。
該当するものは診断（第6節）と `next_actions` に回す。

## 2. 除外（指定されても削除しない worktree）

`git worktree list --porcelain` の各 entry について、次は候補にせず `excluded` に記録する。

| reason | 対象 |
|---|---|
| `current_worktree` | 実行中の worktree（`git rev-parse --show-toplevel` と一致するもの、および main worktree） |
| `integration_worktree` | profile が integration として挙げる worktree（統合先 branch の作業 tree 等） |
| `not_in_scope` | `selection_mode: issues` で対象外の issue に属する worktree |

`current_worktree` と `integration_worktree` は、issue 番号や path で明示指定されても
削除しない。この2つを消せる経路を持たないことが、この Skill の不変条件である。

## 3. 削除方式

削除は必ず **worktree を先に外してから branch を消す**（branch が checkout 中だと消せない）。

### 3.1 direct（proof.type = direct）

```
git worktree remove <path>          # --force は付けない。clean な worktree だけが対象
git branch -d <branch>              # -D は使わない
```

`git branch -d` が、base が現在の HEAD/upstream でないために merge 済みと認識せず拒否した
場合でも、`direct` の祖先関係は証明済みなので、3.2 の guarded ref delete を
`expected old OID = 証明した tip` で用いる。**`-D` へは落とさない。**

### 3.2 merged_equivalent（proof.type = merged_equivalent）— guarded ref delete

squash/rebase merge 済み branch は base の祖先でないため `git branch -d` は拒否する。
ここで `-D` に落とさず、**expected-old-OID 付きの guarded ref delete** を使う。

```
git worktree remove <path>                              # --force は付けない
git update-ref -d refs/heads/<branch> <verified-tip>    # verified-tip = plan/drift 再検査で確定した tip
```

`git update-ref -d <ref> <old-oid>` は、ref の現在値が `<old-oid>` と一致するときだけ削除し、
一致しなければ失敗する。plan 後に branch が動いていれば（race）、この delete は失敗し、
branch は残る。**race のときは失敗させる** のが正しい。失敗したら
`branch_deleted = false`、`status = partial` とし、`next_actions` に手動確認を積む。
worktree は既に外れているので、`git worktree prune` の対象になる。

### 3.3 apply の順序

1. plan の deletable 対象について drift 再検査（[proof-algorithm.md](./proof-algorithm.md) 第5節）。
2. 生き残った対象だけを、3.1 / 3.2 で削除。
3. `git worktree prune` を実行。
4. CommandMate sync（第5節）。

## 4. 入力の安全性

対象は **issue 番号** または `all_eligible` で受け取り、worktree は
`git worktree list --porcelain`（git metadata = truth）から解決する。path naming
（`commandmate-issue-<n>` 等）は候補の **ヒント** であって truth にしない。

利用者が path を渡してきた場合も、その path を直接 remove しない。次を拒否する。

- 絶対 path、`~` 展開を要する path。
- `..` を含む path、symlink を経由する path。
- git が管理する worktree の集合の外を指す path（worktree 外 escape）。

これらは `blocking_reasons` に記録し、その対象を候補にしない。

## 5. CommandMate sync（optional）

削除と prune のあと、削除済み worktree を CommandMate の一覧から除外するために sync する。
経路は public の `commandmate` CLI であり、`commandmatedev` は使わない。

`commandmate sync` は将来新設される CLI を前提とする。現状の CLI に sync が無い環境では
**optional として扱う**。

- CLI に sync 相当が無い / 失敗した → `commandmate_sync.outcome` を `unavailable` / `failed` とし、
  `worktree_ids` は解決できなかった分を欠落（null）として返す。**run 全体を failure にしない。**
- 欠落した worktree id を推測で埋めない。sync できなかった事実を `next_actions`（reason `sync`）に残す。

port 決め打ちの `curl .../api/repositories/sync` は使わない（別 server を叩きうる）。

## 6. 診断のみ（自動停止・削除しない）

worktree の周辺に server / process / tmux / DB / log が見えても、この Phase では
**表示だけ** する。`plan.candidates[].diagnostics` と `result.next_actions` に載せる。

- process owner / CWD を完全に検証できない段階で process を止めない。port/PID だけで
  別 worktree・別 user の process を止める事故を避ける。
- DB / log を worktree 削除と同じ確認で消さない。影響範囲が worktree と別だからである。

診断に **絶対 path・生の PID を行動可能な形で・secret を載せない**。「Issue 専用 server が
port 上で応答している」程度の観測に留め、停止は利用者の手動 action に回す。

## 7. redaction（result / audit に残さないもの）

result・summary・audit のいずれにも次を残さない。

- token / secret / credential（gh の認証 token を含む）。
- machine absolute path・home directory。worktree は **basename の label**（`worktree_ref`）で記録する。
  絶対 path は実行中の diagnostic にだけ使い、receipt には保存しない。
- raw な GitHub API response（PR の JSON blob そのもの）。証明に要る `pr_number` と
  `merge_commit_oid`（git object id）だけを記録する。
- raw terminal 出力の全量。command の結果は要約・件数・exit code に落とす。

git の commit SHA と PR 番号は secret ではなく、削除の証跡として必要なので記録してよい。
