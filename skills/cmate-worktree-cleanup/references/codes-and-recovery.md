# codes and recovery

runner（[runner-contract.md](./runner-contract.md)）と plan / result に現れる code のうち、
回復の手順が要るものをまとめる。skip reason の全体は schema と
[proof-algorithm.md](./proof-algorithm.md) 第4節が正本である。

## 1. exit code（scripts/cleanup.mjs）

| code | 意味 | 回復 |
|---|---|---|
| 0 | 成功 | 不要 |
| 1 | 一部の candidate を skip した / result が partial | `skipped` の reason ごとに下の表を見る |
| 2 | 入力不正 / plan を作れない | stderr の usage、または plan の `blocking_reasons` を見て引数を直す（`--base` を渡す等） |

## 2. 条件4 の evidence（CommandMate#3010）

| field / 値 | 意味 | 回復 |
|---|---|---|
| `equivalence_path: patch_equivalent` | `git cherry` に `+` が無く、正味の diff もバイト一致 | 不要（削除してよい） |
| `equivalence_path: net_diff_equal` | `git cherry` に `+` があるが、正味の diff がバイト一致。BEHIND で base を merge してから squash された branch の形 | 不要（削除してよい）。`cherry_unmatched` は evidence であって警告ではない |
| `cherry_unmatched` | `git cherry <base> <tip>` の `+` 行の数 | 単独では何もしない |
| `tree_mismatch` | 正味の diff が squash の diff とバイト一致しない | `git diff $(git merge-base <base> <tip>) <tip>` と `git diff <merge>^ <merge>` を見比べ、base に無い変更が残っていないか人が確かめる。残っていれば PR を出し直す。自動では消さない |

## 3. apply で出る skip

| reason | 意味 | 回復 |
|---|---|---|
| `plan_drift` | plan を見た後に tip・状態・判定が動いた、または削除直前の再検査で動いていた | dry-run からやり直し、新しい plan を確認して apply する |
| `not_in_scope`（detail: not named in --confirm） | deletable だが `--confirm` に無かった | 消すなら `--confirm` に足して apply し直す |
| `command_failed`（detail: git worktree remove refused） | 非 force の remove が拒否された（untracked file 等） | worktree の中身を確かめて片付けてから再実行する。`--force` は使わない |
| `branch_deleted: false` | worktree は外れたが guarded ref delete が失敗（ref が動いた） | `git rev-parse refs/heads/<branch>` を見て、動いた理由を確かめる。`-D` は使わない |
