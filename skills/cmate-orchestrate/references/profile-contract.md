# profile 契約

`cmate-orchestrate` は、対象リポジトリごとに変わる値 — base branch、branch 名、
worktree path、baseline 検証 — を **profile** から解決する。planner は
`develop` / `feature/...` / `npm` / `cargo` を一切 hardcode しない（ADR [#1447](https://github.com/Kewton/CommandMate/issues/1447)）。
新しいリポジトリへの対応は profile の追加であって、runner の改修ではない。

## 1. profile の形

```json
{
  "id": "node-commandmate",
  "repository": "Kewton/CommandMate",
  "base": "origin/develop",
  "branch_template": "feature/issue-{number}-{slug}",
  "worktree_template": "../{repo}-issue-{number}-{slug}",
  "baseline": ["npm ci", "npm run build", "npm test"],
  "verified": true
}
```

| field | 必須 | 意味 |
|---|---|---|
| `id` | 必須 | profile の識別子 |
| `repository` | 必須 | `owner/name` 形式の GitHub slug |
| `base` | 必須 | 分岐元。例 `origin/develop`、`origin/main` |
| `branch_template` | 必須 | branch 名の雛形。`{number}` `{slug}` `{repo}` を展開 |
| `worktree_template` | 必須 | worktree path の雛形。同じ placeholder を展開 |
| `baseline` | 必須 | 各 worker が実行する検証 command の配列 |
| `verified` | 任意 | 実機確認済みなら `true`。既定は `false` |

placeholder は次のとおり展開する。

- `{number}` — Issue 番号
- `{slug}` — Issue title を ASCII slug 化したもの（小文字・英数・`-`、最大48字）
- `{repo}` — `repository` の `/` 以降

未知の field を持つ profile は拒否する（`load_error`）。

## 2. 動作確認済み profile

runner に内蔵しているのは、ADR で動作確認された次の2つだけである。
`--profile <id>` で選ぶ。

| id | repository | base | baseline |
|---|---|---|---|
| `node-commandmate` | `Kewton/CommandMate` | `origin/develop` | `npm ci` / `npm run build` / `npm test` |
| `rust-commandagent` | `Kewton/CommandAgent` | `origin/develop` | `cargo fmt --check` / `cargo clippy ...` / `cargo test` |

どちらも `verified: true` である。

## 3. unverified profile

`--profile-json <path>` で渡した独自 profile は、`verified: true` を
明示しない限り **unverified** として扱う。unverified profile は、
`--allow-unverified` を付けない限り planning を拒否する（`unverified_profile`）。
これは「未検証リポジトリは実行前確認の上で利用する」という ADR 決定を、
mutation の無い plan 段階でも一貫させるためである。

`--allow-unverified` を付けて planning した場合、plan の `risk` には
`unverified_profile`（severity high）が必ず載る。

## 4. base / repository の上書き

`--base <ref>` と `--repo <owner/name>` は profile の値を上書きする。
上書きした値は plan の `profile` と `inputs` にそのまま反映され、
run_id の入力にも含まれる（第 [plan-contract.md](./plan-contract.md) 参照）。

## 5. CommandMate worktree 同期

worktree の CommandMate 側 ID は、将来新設される `commandmate sync` が
dispatch 時に解決する。現状 CLI に sync は無いため、plan 段階では各 Issue の
`worktree_id` を `null`（欠落）として返し、失敗にはしない（ADR 決定3、optional 扱い）。
`commandmatedev` は公式経路に使わない。公式経路は public `commandmate` である。
