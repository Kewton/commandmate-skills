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

この文書が述べるのは「いつ使うか」「どう呼ぶか」「出力をどう読むか」「どこで止まり、
人間が何をするか」の 4 つだけである。規則の正本は §9 の references と schema にあり、
食い違った場合はそちらを採る。

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
| `profile` | 任意 | branch/base/path/baseline を解決する profile（`node` / `rust` / `unverified`） | repository signal から自動検出し、plan で提示して確認を取る |
| `mode` | 任意 | `dry_run`（既定） / `apply` | `dry_run` |
| `confirmed_targets` | 任意 | apply 時に利用者が承認した worktree の集合 | 空。apply では確認を取る |

### 1.1 profile 語彙（`cmate-worktree-setup` と共通）

| profile | 対象 | 検出 signal（root 相対） | 入力として受け付ける別名 |
|---|---|---|---|
| `node` | Node / CommandMate | `package.json` | `commandmate` |
| `rust` | Rust / CommandAgent | `Cargo.toml` | `commandagent` |
| `unverified` | どちらの signal にも一致しない | — | 利用者が付けた任意の profile 名 |

`cmate-worktree-setup` の result の `profile.selected` を、そのまま `profile` として渡せる。
別名で受け取った場合は canonical 名へ写して `profile.name` に記録し、写したことを `limitations` に
残す。利用者が独自の profile 名を与えた場合は `unverified` として扱い、`profile.name` にはその名前を
記録してよい。`profile.verified` を true にできるのは `node` / `rust` だけである。

入力に関する強い制約:

1. **worktree は git metadata から解決する。** 対象は issue 番号か `all_eligible` で受け取り、
   `git worktree list --porcelain` から発見する。**利用者が渡した path を直接 remove しない**
   （拒否する path の種類は [references/safety.md](./references/safety.md) §4）。
2. **branch/base/path/baseline を hardcode しない。** `develop` / `feature/...` / npm / Cargo を
   決め打ちせず、`profile` から解決する。`unverified` は実行前に利用者確認を取ってから使う。
3. Issue 本文や PR の取得は読み取りのみ。`gh pr edit` などで書き換えない。

## 2. 権限

宣言している権限は `filesystem_read` / `filesystem_write` / `process_execution` /
`network_access` で、用途は worktree の状態読み取り・非 force の worktree remove と
guarded ref delete・宣言 command の実行・merge 証跡の取得に限る。**やらないこと**の一覧は
[`references/safety.md`](./references/safety.md) §1 と manifest の `risk_rationale` が正本である。
`declared_permissions` は宣言であって強制ではないので、この範囲を超える操作が必要になった
時点で、実行せず利用者へ確認する。

## 3. 実行してよい command

`requirements.commands` に宣言した `git` / `gh` / `commandmate` に限る。

- `git` — `worktree list --porcelain`、`status --porcelain`、`branch --show-current`、
  `rev-parse`、`merge-base --is-ancestor`、`fetch <remote> <base> --prune`、`cat-file -e`、
  `diff`、`cherry`、`show`、および削除の `worktree remove`（非 force）/ `branch -d` /
  `update-ref -d <ref> <old-oid>` / `worktree prune`。
- `gh` — `pr list --state merged --head <branch> --base <base> --json ...`（読み取りのみ）。
- `commandmate` — public CLI の `sync` と、worktree id 解決のための読み取り `ls --json`（§5）。
  `commandmatedev` は使わない。

## 4. 手順

### Step 0 — 前提と profile の確認

1. `selection` があるかを確認する。欠ければ §7 で停止する。
2. `profile` を解決する。明示指定があれば §1.1 の canonical 名へ写して使う。無ければ repository の
   signal（`package.json` → `node`、`Cargo.toml` → `rust`）で **自動検出** する。どちらの signal にも
   一致しない、または両方あって決めきれない場合は `unverified` とする。
3. 解決した profile から `base`（例 `origin/main`）・`remote`・`baseline`・integration worktree・
   path/branch のヒントを得る。この Skill は破壊的なので、**自動検出した profile も plan に載せて
   利用者へ提示し、確認の対象に含める**（Step 5）。`unverified` は確認が取れなければ候補にしない。
4. `git rev-parse --show-toplevel` で現在の worktree を特定する（Step 1 で必ず除外する）。

### Step 1 — 発見と除外

`git worktree list --porcelain` で全 worktree を発見する。path naming は truth にしない。
current worktree・integration worktree・対象外 issue を `excluded` に振り分け、残りを候補
(`candidates`) とする。除外の reason と、**current / integration は指定されても消さない**という
不変条件は [`references/safety.md`](./references/safety.md) §2 が正本である。

### Step 2 — remote 最新化

`git fetch <remote> <base-branch> --prune` を実行する。失敗しても停止しないが、
**stale な remote を最新と見なさない。** fetch 結果を `fetch` に記録する
（[`references/proof-algorithm.md`](./references/proof-algorithm.md) §0）。

### Step 3 — 候補ごとの状態検査

各候補に `git -C <path> status --porcelain` / `branch --show-current` / `rev-parse HEAD` を
実行し、`state` を決める。dirty / detached / locked / missing は証明へ進まず `skip`。
clean な候補だけが削除の前提を満たす（[`references/proof-algorithm.md`](./references/proof-algorithm.md) §1）。

### Step 4 — merge 証跡の判定

clean な候補ごとに proof を求める。型は `direct` / `merged_equivalent` / `unverifiable` の
3つだけで、各型の成立条件（`merged_equivalent` の **4条件すべて** を含む）と
`unverifiable` に落ちる事由は [`references/proof-algorithm.md`](./references/proof-algorithm.md)
が正本である。**1つでも欠けたら `unverifiable` = 削除しない。迷ったら `unverifiable`。**

`decision: delete` は `state: clean` かつ `proof.type ∈ {direct, merged_equivalent}` のときだけ。

### Step 5 — plan の提示と確認（apply の前提）

1. plan（[`references/result-contract.md`](./references/result-contract.md) §1）を dry-run で提示する。
   removed と skipped を混ぜず、target ごとに proof / skip 理由を示す。**使った profile
   （名前・`verified`・`base`・`remote`）も併せて提示する。** 自動検出した場合はその旨を明示する。
2. `mode: apply` に進むには、利用者の **明示確認** が要る。承認された worktree を
   `confirmed_targets` として受け取る。確認できない（非対話含む）場合は `dry_run` に留める。
   **確認なしに削除しない。**

### Step 6 — apply（削除）

`mode: apply` かつ確認済みの対象だけを削除する。

1. **drift 再検査**: 削除の直前に各対象の status / tip / ref を再取得し、plan と照合する。
   tip が動いた・dirty になった・ref が動いた対象は `plan_drift` として skip する
   （[`references/proof-algorithm.md`](./references/proof-algorithm.md) §5）。
2. 生き残った対象を、proof の型ごとの方式で削除する。`direct` と `merged_equivalent` の
   command、guarded ref delete が race で失敗したときの扱い、**`--force` も `-D` も
   使わない**ことは [`references/safety.md`](./references/safety.md) §3 が正本である。
3. `git worktree prune` を実行する。

### Step 7 — sync と診断

1. `commandmate` public CLI で sync する（§5）。使えない/失敗は `unavailable`/`failed` とし、
   worktree id を欠落として返す。**run を failure にしない。**
2. server / process / tmux / DB / log は §6 に従い診断表示のみ。`next_actions` に回す。

### Step 8 — result と summary

`result` 文書（`schemas/cleanup-result.v1.json` 適合、`result_schema_version: 1`）と
`summary_markdown` を出力する。**この Step は途中で失敗した場合も必ず実行する。**
removed / skipped / proof / evidence を残し、token/secret/絶対path/raw GitHub response を含めない。

## 5. CommandMate sync（optional）

削除・prune のあと、削除済み worktree を CommandMate 一覧から外すため public `commandmate` CLI で
sync する。CommandMate `>=0.21` の CLI には `commandmate sync` が **実在する**が、起動中の
server へ接続するため、server 未起動または sync を持たない旧 CLI では使えない。
**その場合も run を失敗にしない**（sync は optional）。`unavailable` / `failed` の記録、
`worktree_ids` を `commandmate ls --json` から削除前に控えること、推測 id を書かないこと、
port 決め打ちの curl sync を使わないことは
[`references/safety.md`](./references/safety.md) §5 が正本である。

## 6. 診断のみ（自動停止・削除しない）

worktree 周辺の server / process / tmux / DB / log は **表示だけ** し、`diagnostics` と
`next_actions` に載せて実行は利用者に委ねる。止めない理由と載せてよい粒度は
[`references/safety.md`](./references/safety.md) §6 が正本である。

## 7. 失敗時の動作

| 状況 | 動作 |
|---|---|
| `selection` が欠ける | 推測で補わない。`status: failure`、`blocking_reasons` に記録 |
| `profile` が未指定 | signal から自動検出し、plan で提示して確認を取る（§4 Step 0） |
| profile が未知・曖昧 | `unverified`。利用者確認が取れなければ候補にしない |
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

result を返す前に `completion_check` の6件を自分で実行して記録する。6件の id と、
それぞれが何を確かめるかは
[`references/result-contract.md`](./references/result-contract.md) §2.6 が正本である。
1つでも偽なら `status` は `success` にならない。

## 9. 参照

- [`references/proof-algorithm.md`](./references/proof-algorithm.md) — direct / merged-equivalent / unverifiable の判定と drift 再検査
- [`references/safety.md`](./references/safety.md) — 禁止操作、除外、削除方式、入力の安全性、sync、診断、redaction
- [`references/result-contract.md`](./references/result-contract.md) — plan / result の各 field、status、completion check、summary の構成
- [`references/agent-compatibility.md`](./references/agent-compatibility.md) — Agent 差異と fallback
- [`schemas/cleanup-plan.v1.json`](./schemas/cleanup-plan.v1.json) — plan 文書 schema
- [`schemas/cleanup-result.v1.json`](./schemas/cleanup-result.v1.json) — result 文書 schema
