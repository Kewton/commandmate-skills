# merge proof algorithm

`cmate-worktree-cleanup` が worktree を削除してよいかどうかを決める唯一の根拠は、
**その worktree の branch の作業が base に完全に取り込まれていることの証明** である。
SKILL.md の Step 4 から参照される。

証明の型は3つだけである。

| proof.type | 意味 | 削除方式 |
|---|---|---|
| `direct` | branch tip が base の祖先である | `git worktree remove` + `git branch -d` |
| `merged_equivalent` | 祖先ではないが、squash/rebase merge の4条件がすべて成立した | `git worktree remove` + guarded ref delete |
| `unverifiable` | どちらも証明できなかった | **削除しない** |

`direct` は CommandAgent の既存判定を canonical base として引き継いだものである。
`merged_equivalent` と guarded ref delete は本 Skill で新設した部分であり、
既存の CommandMate / CommandAgent 実装には無い。

## 0. base と remote freshness

すべての証明は profile が解決した `base`（例 `origin/main`、`origin/develop`）に対して測る。
`develop` や `main` を決め打ちしない。base は [safety.md](./safety.md) の profile から来る。

判定の前に base を最新化する。

```
git fetch <remote> <base-branch> --prune
```

この fetch が失敗した場合、remote の状態は不明である。
**stale な remote-tracking branch を最新と見なさない。**
remote を必要とする候補（`merged_equivalent` を試す候補）はすべて
`unverifiable` / `fetch_failed` になる。`direct`（ローカルの祖先関係だけで閉じる）は
fetch 失敗でも判定してよいが、base 側が古い可能性を `limitations` に記録する。

## 1. 候補ごとの検査（削除の前提）

証明に入る前に、その worktree が clean であることを確認する。
次のいずれかに当たる時点で証明へ進まず、`skip` にする。

```
git -C <path> status --porcelain     # 出力があれば dirty  -> skip: dirty
git -C <path> branch --show-current  # 空なら detached      -> skip: detached
git -C <path> rev-parse HEAD         # 取れなければ         -> skip: missing / command_failed
```

`locked`（`git worktree list --porcelain` の `locked` 行）も skip する。
dirty / detached / unmerged / unverifiable はすべて **zero-delete** である。

tip SHA（`git -C <path> rev-parse HEAD`）を控える。以降の全条件は、この tip に対して測る。

## 2. direct ancestry（canonical base）

```
git merge-base --is-ancestor <tip> <base>
```

- exit 0 → base は tip を含んでいる。`proof.type = direct`、`ancestor_verified = true`。
- exit 1 → 祖先ではない。第3節の `merged_equivalent` を試す。
- それ以外の exit → `command_failed` として `unverifiable`。

`direct` が成立したら、それ以上の証明は不要である。base に tip が到達している事実が、
「branch の全 commit が base にある」ことを直接意味する。

## 3. merged-equivalent（squash / rebase、本 Skill の新設判定）

squash や rebase では merge 後に base 側へ **新しい単一 commit**（別 tree・別 SHA）が作られ、
branch tip は base の祖先にならない。このとき単純な `git branch --merged` や
「PR が merged」だけでは、branch tip の advance や stale remote を見落とす。

そこで次の **4条件すべて** が成立したときに限り `merged_equivalent` とする。
1つでも欠けたら `unverifiable` にし、欠けた条件を `unverifiable_reasons` に残す。

### 条件1 — exact head/base の merged PR がちょうど1件

```
gh pr list --state merged --head <branch> --base <base-branch> \
  --json number,headRefName,baseRefName,headRefOid,mergeCommit,mergedAt
```

- `headRefName` が候補 branch、`baseRefName` が profile の base branch に一致する
  merged PR が **ちょうど1件** であること。
- 0件 → `no_merged_pr`。複数 → `multiple_prs`。どちらも `unverifiable`。
- gh がエラー、または必要な field が欠ける → `github_data_missing`。

**PR が merged であること単独では十分な証明にしない。** ここで得るのは
「どの merge commit と head OID を照合すべきか」であって、安全性の結論ではない。

### 条件2 — headRefOid 一致（tip drift の検出）

条件1の PR の `headRefOid` が、第1節で控えた **worktree の tip SHA と一致** すること。

- 不一致 → merge 後に branch が進んでいる（tip advance）。`head_oid_drift`、`unverifiable`。

merge 済みの PR があっても、その後 branch に commit が積まれていれば、
その差分は base に無い。tip 一致は、その差分が無いことの必要条件である。

### 条件3 — reachable merge commit

条件1の PR の `mergeCommit.oid` が実在し、最新化した base から到達可能であること。

```
git cat-file -e <merge_commit_oid>^{commit}          # 実在するか
git merge-base --is-ancestor <merge_commit_oid> <base>   # base から到達可能か
```

- merge commit が null（例: rebase merge で記録されない、branch が消えている） → `merge_commit_unreachable`。
- 実在しない、または base から到達不能（exit 非0） → `merge_commit_unreachable`。

いずれも `unverifiable`。GitHub の PR state と、手元の base が実際に指すものとを、
ここで突き合わせる。

### 条件4 — tree equality

branch が merge base に対して加える **正味の tree 変更** が、merge commit が base に
持ち込んだ変更と **同一** であること。「PR が merged」でも中身がずれていれば削除しない、
を担保する条件である。

```
mb=$(git merge-base <base> <tip>)
# branch が加える正味の変更（merge-base から tip まで）
git diff --quiet $mb <tip>            # 差分が空でないのが通常。tree ではなく patch を比較する
# merge commit が持ち込んだ変更（第1親との差分）
# 次の2つの diff が同一であることを確認する:
git diff $mb <tip>
git diff <merge_commit_oid>^ <merge_commit_oid>
```

補助として patch 等価も確認する（branch の全 patch が base に取り込まれているか）。

```
git cherry <base> <tip>
```

- `git cherry` の出力に `+` 始まりの行が1つでもある → base に無い patch が残っている。`tree_mismatch`。
- 上記2つの diff が同一でない、または比較できない → `tree_mismatch`。

いずれも `unverifiable`。**tree 一致だけを単独の証明にしない**（条件1〜3と併せて初めて有効）。
逆に、条件1〜3が揃っても tree が食い違えば削除しない。

### 4条件の結論

条件1〜4がすべて true のときだけ `proof.type = merged_equivalent` とし、
`pr_number` / `merge_commit_oid` を記録する。1つでも欠ければ `unverifiable` である。

## 4. unverifiable は常に安全側

次はすべて `unverifiable`（=削除しない）に落とす。迷ったら `unverifiable` にする。

- fetch 失敗（`fetch_failed`）
- GitHub data 不足・取得失敗（`github_data_missing`）
- merged PR が無い / 複数（`no_merged_pr` / `multiple_prs`）
- tip drift（`head_oid_drift`）
- merge commit が到達不能（`merge_commit_unreachable`）
- tree 不一致（`tree_mismatch`）
- 上記判定に使う command 自体の失敗（`command_failed`）

`unverifiable` の worktree は、`git worktree list` に残す。証明できないことは
「壊れている」ではなく「今回は安全に消せない」である。summary で
「PR が merged だから安全」と書かず、tip / tree / reachability のどれで止まったかを短く示す。

## 5. drift 再検査（apply 直前）

plan を作った時刻と apply する時刻の間に、worktree の状態は動きうる。
apply では削除の **直前** に、対象ごとに次を再取得して plan と照合する。

- `git -C <path> status --porcelain`（再び clean か）
- `git -C <path> rev-parse HEAD`（tip が plan と同一か）
- `git rev-parse refs/heads/<branch>`（ref が plan の tip と同一か）

tip が動いた・dirty になった・ref が動いた場合は、その対象を `plan_drift` として skip し、
削除しない。`merged_equivalent` の guarded ref delete は、この tip を expected old OID に
渡すので、ref が動いていれば delete 自体が race として失敗する（[safety.md](./safety.md) 参照）。
