---
name: cmate-worktree-cleanup
description: merge 済み・不要になった git worktree を、削除可能性と証跡を dry-run で提示したうえで、clean かつ merge 証跡が十分な対象だけ安全に削除する。worktree の掃除、merge 済み worktree の削除、issue worktree の後片付けを求められたときに使う。
---

# cmate-worktree-cleanup

対象 issue または eligible な worktree を検査し、**削除可能性と証跡 (proof) を dry-run で
preview** したあと、**clean かつ merge 証跡が十分な worktree だけ** を安全に削除する手順である。

この Skill は破壊的操作を行う（`declared_risk: high`）。中心にある規則は1つだけである。

> **証明できないものは消さない。**
> dirty・detached・unmerged・検証不能 (unverifiable) な対象は、削除せず理由付きで残す (zero-delete)。
> `git worktree remove --force`・`git branch -D`・無条件 process kill・DB/log の自動削除は行わない。

出力は **plan / result 文書**（[`schemas/`](./schemas/)）と **human-readable summary** の
2つで、どちらか一方だけを返して終了しない。

## 0. 使う場面 / 使わない場面

使う場面:

- merge 済み・不要になった issue/feature worktree を、証跡付きで安全に片付けたいとき。
- どの worktree が安全に消せて、どれが（なぜ）消せないかを分けて確認したいとき。

使わない場面:

- dirty / unmerged な worktree を無理に消すこと。この Skill は消さずに残す。
- server / process / tmux / DB / log の停止・削除。診断表示に留める（§6）。
- remote branch の削除、rollback、backup、Skill Runtime の停止。

## 1. 入力

| 名前 | 必須 | 内容 | 欠けたときの動作 |
|---|---|---|---|
| `selection` | 必須 | `issues`（issue 番号の配列）または `all_eligible` | `status: failure` を出力して停止 |
| `profile` | 必須 | branch/base/path/baseline を解決する profile（`commandmate` / `commandagent` / 利用者指定） | 未指定なら利用者へ確認。応答が無ければ停止 |
| `mode` | 任意 | `dry_run`（既定） / `apply` | `dry_run` |
| `confirmed_targets` | 任意 | apply 時に利用者が承認した worktree の集合 | 空。apply では確認を取る |

入力に関する強い制約:

1. **worktree は git metadata から解決する。** 対象は issue 番号か `all_eligible` で受け取り、
   `git worktree list --porcelain` から発見する。**利用者が渡した path を直接 remove しない。**
   絶対 path・`..`・symlink・worktree 外 escape は拒否する（[references/safety.md](./references/safety.md) §4）。
2. **branch/base/path/baseline を hardcode しない。** `develop` / `feature/...` / npm / Cargo を
   決め打ちせず、`profile` から解決する。検証済み profile は Node/CommandMate と
   Rust/CommandAgent の2つ。未知 repository は unverified 扱いで、実行前に利用者確認を取ってから使う。
3. Issue 本文や PR の取得は読み取りのみ。`gh pr edit` などで書き換えない。

## 2. 権限

`commandmate.skill.yaml` の `declared_permissions` とその用途:

| 権限 | 用途 | やらないこと |
|---|---|---|
| `filesystem_read` | worktree の status / branch / tree の読み取り | 対象 repository の外の path を読む |
| `filesystem_write` | `git worktree remove`（非 force）と guarded ref delete による worktree/branch 削除 | force remove、`branch -D`、DB/log/cache 削除 |
| `process_execution` | `git` / `gh` / `commandmate` の実行 | 宣言外 command、process kill |
| `network_access` | `git fetch` と `gh` による merge 証跡の取得 | それ以外の外部送信。evidence の外部 upload |

`declared_permissions` は宣言であって強制ではない。この一覧を超える操作が必要になった時点で、
実行せず利用者へ確認する。

## 3. 実行してよい command

`requirements.commands` に宣言した `git` / `gh` / `commandmate` に限る。

- `git` — `worktree list --porcelain`、`status --porcelain`、`branch --show-current`、
  `rev-parse`、`merge-base --is-ancestor`、`fetch <remote> <base> --prune`、`cat-file -e`、
  `diff`、`cherry`、`show`、および削除の `worktree remove`（非 force）/ `branch -d` /
  `update-ref -d <ref> <old-oid>` / `worktree prune`。
- `gh` — `pr list --state merged --head <branch> --base <base> --json ...`（読み取りのみ）。
- `commandmate` — public CLI の sync のみ（§5）。`commandmatedev` は使わない。

## 4. 手順

### Step 0 — 前提と profile の確認

1. `selection` と `profile` が揃っているかを確認する。欠ければ §7 で停止する。
2. `profile` を解決し、`base`（例 `origin/main`）・`remote`・`baseline`・integration worktree・
   path/branch のヒントを得る。未知 profile は unverified として利用者確認を取る。
3. `git rev-parse --show-toplevel` で現在の worktree を特定する（§5 で必ず除外する）。

### Step 1 — 発見と除外

1. `git worktree list --porcelain` で全 worktree を発見する。path naming は truth にしない。
2. current worktree・integration worktree・対象外 issue を `excluded` に振り分ける
   （[references/safety.md](./references/safety.md) §2）。**この2つは指定されても消さない。**
3. 残りを候補 (`candidates`) とする。

### Step 2 — remote 最新化

`git fetch <remote> <base-branch> --prune` を実行する。失敗しても停止しないが、
**stale な remote を最新と見なさない。** fetch 結果を `fetch` に記録する
（[references/proof-algorithm.md](./references/proof-algorithm.md) §0）。

### Step 3 — 候補ごとの状態検査

各候補に `git -C <path> status --porcelain` / `branch --show-current` / `rev-parse HEAD` を
実行し、`state` を決める。dirty / detached / locked / missing は証明へ進まず `skip`。
clean な候補だけが削除の前提を満たす。

### Step 4 — merge 証跡の判定

clean な候補ごとに proof を求める（詳細は
[references/proof-algorithm.md](./references/proof-algorithm.md)）。

- **direct ancestry**: `git merge-base --is-ancestor <tip> <base>` が exit 0 → `direct`。
- 祖先でない場合のみ **merged-equivalent** を判定する。次の **4条件すべて** が成立したときだけ
  `merged_equivalent`:
  1. exact head/base の merged PR がちょうど1件。
  2. その PR の `headRefOid` が worktree tip と一致（tip drift が無い）。
  3. reachable な merge commit がある（base から到達可能）。
  4. tree equality（branch の正味 tree 変更 = merge commit が持ち込んだ変更）。
- fetch 失敗・GitHub data 不足・PR なし/複数・tip drift・merge commit 到達不能・tree 不一致は
  すべて `unverifiable` = **削除しない**。迷ったら `unverifiable`。

`decision: delete` は `state: clean` かつ `proof.type ∈ {direct, merged_equivalent}` のときだけ。

### Step 5 — plan の提示と確認（apply の前提）

1. plan（[references/result-contract.md](./references/result-contract.md) §1）を dry-run で提示する。
   removed と skipped を混ぜず、target ごとに proof / skip 理由を示す。
2. `mode: apply` に進むには、利用者の **明示確認** が要る。承認された worktree を
   `confirmed_targets` として受け取る。確認できない（非対話含む）場合は `dry_run` に留める。
   **確認なしに削除しない。**

### Step 6 — apply（削除）

`mode: apply` かつ確認済みの対象だけを削除する。

1. **drift 再検査**: 削除の直前に各対象の status / tip / ref を再取得し、plan と照合する。
   tip が動いた・dirty になった・ref が動いた対象は `plan_drift` として skip する
   （[references/proof-algorithm.md](./references/proof-algorithm.md) §5）。
2. 生き残った対象を削除する（[references/safety.md](./references/safety.md) §3）:
   - `direct` → `git worktree remove <path>` + `git branch -d <branch>`。
   - `merged_equivalent` → `git worktree remove <path>` +
     `git update-ref -d refs/heads/<branch> <verified-tip>`（expected-old-OID 付き。race 時は失敗させる）。
   - **`--force` も `-D` も使わない。**
3. `git worktree prune` を実行する。

### Step 7 — sync と診断

1. `commandmate` public CLI で sync する（§5）。無い/失敗は `unavailable`/`failed` とし、
   worktree id を欠落として返す。**run を failure にしない。**
2. server / process / tmux / DB / log は §6 に従い診断表示のみ。`next_actions` に回す。

### Step 8 — result と summary

`result` 文書（`schemas/cleanup-result.v1.json` 適合、`result_schema_version: 1`）と
`summary_markdown` を出力する。**この Step は途中で失敗した場合も必ず実行する。**
removed / skipped / proof / evidence を残し、token/secret/絶対path/raw GitHub response を含めない。

## 5. CommandMate sync（optional）

削除・prune のあと、削除済み worktree を CommandMate 一覧から外すため public `commandmate` CLI で
sync する。sync は将来新設の `commandmate sync` を前提とし、**未提供環境では optional** として扱う。
CLI に sync が無い/失敗した場合は `commandmate_sync.outcome` を `unavailable`/`failed`、
`worktree_ids` を欠落 (null) にして返し、run を失敗にしない。port 決め打ちの curl sync は使わない。

## 6. 診断のみ（自動停止・削除しない）

worktree 周辺の server / process / tmux / DB / log は **表示だけ** する。process owner/CWD を
完全検証できない段階で process を止めない。DB/log を worktree 削除と同じ確認で消さない。
これらは `diagnostics` と `next_actions` に載せ、実行は利用者に委ねる（[references/safety.md](./references/safety.md) §6）。

## 7. 失敗時の動作

| 状況 | 動作 |
|---|---|
| `selection` / `profile` が欠ける | 推測で補わない。`status: failure`、`blocking_reasons` に記録 |
| profile が未知 | unverified。利用者確認が取れなければ候補にしない |
| 利用者 path が絶対/`..`/symlink/worktree外 | 拒否。`blocking_reasons` に記録し候補にしない |
| fetch 失敗 | 停止しない。remote を要する候補を `unverifiable`、`limitations` に記録 |
| gh 不可/未認証 | `merged_equivalent` 候補を `github_data_missing` = `unverifiable`。`direct` は継続 |
| dirty/detached/unmerged/unverifiable | 削除しない。`skipped` に理由付きで残す |
| plan 後 drift | 該当対象を `plan_drift` として skip |
| guarded ref delete が race で失敗 | worktree は外れる。`branch_deleted: false`、`status: partial`、`next_actions` に手動確認 |
| sync 不可 | `unavailable`/`failed`。worktree id 欠落。run は failure にしない |
| 非対話で確認不能 | `dry_run` に留める。削除しない |

いかなる失敗経路でも、**result と summary を出さずに終了しない**。

## 8. 完了条件（completion check）

以下がすべて真のときだけ、この Skill は完了したと報告してよい。1つでも偽なら
`status` は `success` にならない（[references/result-contract.md](./references/result-contract.md) §2.6）。

1. `exclusions_honored` — current / integration worktree を一切消していない。
2. `zero_delete_honored` — dirty / detached / unmerged / unverifiable を一切消していない。
3. `proof_sufficient` — `removed` の各要素が direct または4条件完備の merged_equivalent 証跡を持つ。
4. `guarded_delete_used` — merged_equivalent の削除が expected-old-OID 付き delete で、force/`-D` を使っていない。
5. `drift_rechecked` — apply の各削除前に plan 後 drift を再検査した。
6. `no_sensitive_values` — result / summary に token/secret/絶対path/raw GitHub response が無い。

## 9. 参照

- [`references/proof-algorithm.md`](./references/proof-algorithm.md) — direct / merged-equivalent / unverifiable の判定と drift 再検査
- [`references/safety.md`](./references/safety.md) — 禁止操作、除外、削除方式、guarded ref delete、sync、診断、redaction
- [`references/result-contract.md`](./references/result-contract.md) — plan / result の各 field と summary の構成
- [`references/agent-compatibility.md`](./references/agent-compatibility.md) — Agent 差異と fallback
- [`schemas/cleanup-plan.v1.json`](./schemas/cleanup-plan.v1.json) — plan 文書 schema
- [`schemas/cleanup-result.v1.json`](./schemas/cleanup-result.v1.json) — result 文書 schema
