# runner contract（scripts/cleanup.mjs）

`cmate-worktree-cleanup` は、判定と削除を実行する runner を同梱する。
[proof-algorithm.md](./proof-algorithm.md) と [safety.md](./safety.md) をコードにしたもので、
Agent や利用者が点検スクリプトを手で書かなくても、同じ入力から同じ判定が出る。
この文書は runner の呼び方・出力・exit code の正本である。

- `scripts/cleanup.mjs` — CLI。引数を読み、plan か result を stdout に出す。
- `scripts/lib.mjs` — 発見・状態検査・証明・apply の本体と `SKILL_VERSION`。

必要なのは `node`（>=18）・`git`・`gh`（merged_equivalent を試すときだけ）。依存 package は無い。

## 1. 呼び方

```
node scripts/cleanup.mjs --issues 179,181 [--profile node]          # dry-run（既定）
node scripts/cleanup.mjs --all-eligible [--profile node]           # dry-run（既定）
node scripts/cleanup.mjs --issues 179 --apply --confirm feature/179-x [--plan plan.json]
```

| flag | 内容 |
|---|---|
| `--issues <n,...>` / `--all-eligible` | どちらか一方が必須（`selection`） |
| `--profile <id>` | `node` / `rust`（別名 `commandmate` / `commandagent`）/ それ以外は `unverified`。省略時は `package.json` / `Cargo.toml` から自動検出し、plan の `limitations` に書く |
| `--base <ref>` | 例 `origin/main`。省略時は `refs/remotes/<remote>/HEAD`。解決できなければ exit 2 |
| `--remote <name>` | 既定 `origin` |
| `--integration <branch,...>` | integration worktree とみなす branch を足す。base branch 自身は常に integration |
| `--apply` | 削除する。**`--confirm` が無ければ dry-run に留まる**（非対話では確認が取れないため） |
| `--confirm <x,...>` | 承認した対象。branch 名か worktree の basename。current / integration は書いても消さない |
| `--plan <file>` | 利用者が見た plan。その後に tip・状態・判定が動いた対象は `plan_drift` |
| `--gh <cmd>` | `gh` の実体。既定は環境変数 `CMATE_WORKTREE_CLEANUP_GH`、無ければ `gh`。テストはここで差し替える |
| `--sync` | 削除後に `commandmate sync` を実行する。無ければ `commandmate_sync.outcome: skipped` と next action（reason `sync`） |
| `--no-fetch` | fetch しない。merged_equivalent は試さない（`fetch_failed`） |
| `--now <ts>` | `generated_at` / `verified_at` を固定する（再現用） |

`--confirm` / `--plan` を `--apply` なしで渡すのは入力不正（exit 2）。

## 2. 出力

- dry-run（既定、および `--apply` だが `--confirm` が無いとき）: `cleanup-plan.v1` を stdout に出す。
  **何も消さない。** `--apply` で dry-run に留まったときは `limitations` にその旨を書く。
- apply: `cleanup-result.v1` を stdout に出す。`confirmation.granted` は true、`granted_targets` は
  `--confirm` に一致した candidate の basename。

どちらも schema（[../schemas/](../schemas/)）に適合し、絶対 path・home・生の gh 応答を含まない。
worktree は basename（`worktree_ref`）で書く。

## 3. apply の手順

1. plan と同じ判定を、その場でやり直す（証明は常に「今」の状態に対して行う）。
2. `--plan` があれば、confirm された対象ごとに plan と照合する。plan で deletable だったものが今は
   deletable でない、tip が違う、または plan では deletable でなかったものが今は deletable →
   `plan_drift` で skip。
3. deletable でない対象は skip（理由は plan と同じ）。deletable でも `--confirm` に無ければ
   `not_in_scope` で skip。
4. 削除の直前に `status --porcelain` / `rev-parse HEAD` / `rev-parse refs/heads/<branch>` を読み直し、
   plan の tip と違えば `plan_drift`。
5. `git worktree remove <path>`（`--force` なし）。拒否されたら `command_failed` で skip。
6. branch: `direct` は `git branch -d`、拒否されたら `git update-ref -d refs/heads/<branch> <tip>`。
   `merged_equivalent` は最初から `git update-ref -d refs/heads/<branch> <tip>`。失敗したら
   `branch_deleted: false`・`status: partial`・next action。`-D` へは落とさない。
7. `git worktree prune`。`--sync` のときだけ `commandmate sync`（使えなくても failure にしない）。

## 4. exit code

| code | 意味 |
|---|---|
| 0 | 成功。dry-run では全 candidate が deletable、apply では skip した candidate が無い |
| 1 | 一部を skip した（dirty・unverifiable・plan_drift など）、または result が `partial` |
| 2 | 入力が不正、または plan を作れなかった（repository 外・base 解決不能） |

excluded（current / integration / 対象外）は skip の数に入れない。apply で deletable だが
`--confirm` に無かった対象（`not_in_scope`）も、利用者が選んだ結果なので数えない。

## 5. 固定しているもの

- `gh` は `pr list --state merged --head <branch> --base <base-branch> --json ...` だけを呼ぶ（読み取り）。
- diff は `git diff --no-ext-diff --no-textconv --no-color --binary --full-index --no-renames` で出し、
  バイト単位で比べる（[proof-algorithm.md](./proof-algorithm.md) 条件4）。
- `git cherry` の `+` は evidence（`cherry_unmatched`）で、単独では否決しない。この十分条件は
  `lib.mjs` の `NET_DIFF_SUFFICIENT` で、fixture suite がこれを外すと BEHIND の case が落ちることを確かめる。
- server / process / tmux / DB / log は観測も停止もしない（diagnostics は空）。
