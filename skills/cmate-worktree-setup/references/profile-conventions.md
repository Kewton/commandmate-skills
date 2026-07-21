# profile 規約（Node / Rust）と CommandMate sync

`cmate-worktree-setup` が branch・directory・base・baseline を **repository profile から解決** する
ための規定である。SKILL.md の Step 2・Step 3・Step 6 から参照される。

core に `develop`、`feature/{N}-worktree`、`feature/issue-{N}-{slug}`、npm、Cargo を hardcode しない。
すべて profile から解決し、resolved commit SHA と実際に使った値を result に記録する。

## 1. 動作確認済み profile

品質を確認できているのは次の2つだけである。`profile.verified` を true にできるのはこの2つに限る。

| profile | 対象 | 代表 signal（root 相対） |
|---|---|---|
| `node` | Node / CommandMate | `package.json` |
| `rust` | Rust / CommandAgent | `Cargo.toml` |

`profile.detection_evidence` には、判定に使った file を repository 相対 path で記録する。
signal は「存在」で見る。中身の推測で profile を決めない。両方が存在する monorepo では、
Issue の対象 path に近い方を選び、選んだ理由を `limitations` に残す。

## 2. profile から解決する値

各 field は profile が定めるが、**具体値は repository の実体から確定** する。
下表の「解決元」は、hardcode ではなく「どこから読むか」である。

| field | 解決元 |
|---|---|
| `integration_branch` | repository の current/integration branch（`git` から） |
| `base_ref` | `base` 入力があればそれ。無ければ profile 既定の integration branch |
| `base_sha` | `base_ref` を `git rev-parse` で **commit SHA に確定** |
| `branch_template` | profile の branch 命名規約。Issue番号（と profile が要求すれば slug）から生成 |
| `directory_template` | profile の worktree 配置規約。repository 相対で解決 |
| `baseline_command` | profile の proportional baseline（第4節） |

`base_sha` を確定できない（unborn / detached / 未知 ref）場合は、その base では作成せず、
`blocking_reasons` または `limitations` に記録する。symbolic ref だけを base として記録しない。

### branch と directory

- branch 名は profile 規約から Issue番号で生成する。片方の profile の固定名を他方へ流用しない。
- directory は **repository 相対の安全な path** として解決する（絶対path・`..`・symlink を含まない）。
  解決した実 path が許可された worktree 作成先の外へ出る場合は作成せず、
  [safety.md](./safety.md) の規則で拒否する。
- 生成した branch / directory が既存と一致する場合は collision であり、Step 4 の規則に従う。

## 3. unverified profile

`node` / `rust` のどちらにも一致しない repository は `unverified` として扱う。

- `unverified` では `profile.verified` は必ず false。
- **実行前に** profile / base / path / baseline 規約を利用者へ提示し、確認を得てから進む。
  確認が得られなければ status `failure`（`profile_unconfirmed`）で止まり、作成しない。
- 確認を得た場合でも、動作確認済みでない旨を `limitations` に記録する。

未知 stack を「たぶん Node だろう」と丸めないこと。確認を挟むのが unverified の意味である。

## 4. proportional baseline

profile 別に、変更前の worktree が健全であることを確かめる **最小限で比例した** baseline を実行する。

- `node` — profile が定義する軽量な健全性確認（例: 依存解決の確認や lint/type check のうち、
  repository に実在し、network や広域 build を伴わないもの）。実在する script を出典に選ぶ。
- `rust` — profile が定義する軽量な健全性確認（例: `cargo check` 相当の、実在する確認手段）。

原則:

- repository に **実在する** 手段だけを baseline にする。一般論の「test を書くべき」は baseline ではない。
- 重い full build や network を伴う install を baseline に含めない。proportional であること。
- `baseline_command` は placeholder を含まない、そのまま実行できる形にする。
- 失敗しても worktree を保持する（[result-contract.md](./result-contract.md) 参照）。

## 5. CommandMate worktree sync（optional）

CommandMate の worktree sync は **将来新設の `commandmate sync` CLI を前提** とする。
現状 CLI に sync は無いため、この Skill では sync を **optional** として扱う。

- sync 経路が存在しない環境では、`commandmate_sync.available=false`、`worktree_id=null` として記録し、
  worktree 作成の成否には影響させない。**未提供を失敗にしない。**
- 利用可能なら実行し、返った worktree ID を `commandmate_sync.worktree_id` に記録する。
- 公式経路は public `commandmate` を使う。`commandmatedev` は repository 開発用 adapter に限定し、
  公式経路には使わない。
- 経路・認証の詳細は Harness Pack ADR（#1447）に従う。token や絶対path を result に残さない。

## 6. この Skill が profile から解決しないもの（scope 外）

- CommandMate server の起動停止
- GitHub Project status 更新、PR 作成、Issue への write
- 既存 worktree の強制削除・reset、cleanup、並列 dispatch
- 任意の絶対 target path への作成

これらは profile の値であっても実行しない。scope 外である旨を `limitations` に記録する。
