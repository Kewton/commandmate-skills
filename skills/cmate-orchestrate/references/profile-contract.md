# profile 契約

`cmate-orchestrate` は、対象リポジトリごとに変わる値 — base branch、branch 名、
worktree path、baseline 検証 — を **profile** から解決する。planner は
`develop` / `feature/...` / `npm` / `cargo` を一切 hardcode しない（ADR [#1447](https://github.com/Kewton/CommandMate/issues/1447)）。
新しいリポジトリへの対応は profile の追加であって、runner の改修ではない。

自分のリポジトリ用の profile は、`scripts/profile-init.mjs` に **draft を起案させて**
から手で仕上げるのが早い（第7節）。起案は常に `verified: false` であり、
`verified: true` にしてよい条件は第8節に列挙する。

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

**`--repo` は `verified` を降格させる。** `verified: true` は「その profile の
branch/base/worktree/baseline を **そのリポジトリで** 確認した」という主張であり、
リポジトリを差し替えた時点で主張の対象が消える。よって `--repo` が profile の
`repository` と異なる値を指定した場合、planner は `verified` を `false` に落とす。
結果として `--allow-unverified` が無ければ `unverified_profile` で拒否し、
付けた場合は risk factor `unverified_profile`（high）と warning
`profile_repository_override` が載って result は `partial` になる。
`--base` の上書きは `verified` を変えない（同一リポジトリ内の話だからである）。

## 5. 既定 profile と cwd の照合

profile が **既定値**（`node-commandmate`）に解決された場合、つまり `--profile` も
`--profile-json` も指定されなかった場合に限り、planner は read-only の
`git remote get-url origin` を1回実行し、URL を `owner/name` に正規化して
（`git@host:owner/name.git` / `ssh://…` / `https://…` の各形式）profile の対象
リポジトリと大文字小文字を無視して照合する。

- 不一致 → warning `profile_repository_mismatch` を積み、result を `partial` にする。
  planner は停止しない。
- 一致・cwd が git リポジトリでない・`origin` が無い・`owner/name` に正規化できない
  → **照合をスキップ**し、従来どおり `success` とする。probe の失敗を不一致に化けさせない。
- 明示的に profile を指定した場合は照合しない。指定は意図的な選択だからである。

別リポジトリの worktree で profile を指定し忘れると、planner は既定 profile の
リポジトリから Issue を読み、**中身の違う Issue から一見きれいな plan を返す**。
この照合はその事故を warning として可視化するためのものである
（[#36](https://github.com/Kewton/commandmate-skills/issues/36)）。cwd の remote から
profile を **自動解決** することはしない。plan の入力に cwd 状態を持ち込む挙動変更だからである。

**profile の自動解決をしないことと、profile の起案を助けることは別である。**
前者は plan の純粋性の問題で、後者は plan の前に人間が1回だけ行う作業である。
起案は第7節の別 runner が担当し、その出力は plan の入力にはならない（人間が渡す）。

## 6. CommandMate worktree 同期

worktree の CommandMate 側 ID は、将来新設される `commandmate sync` が
dispatch 時に解決する。現状 CLI に sync は無いため、plan 段階では各 Issue の
`worktree_id` を `null`（欠落）として返し、失敗にはしない（ADR 決定3、optional 扱い）。
`commandmatedev` は公式経路に使わない。公式経路は public `commandmate` である。

## 7. profile の起案（`scripts/profile-init.mjs`）

内蔵 profile 以外のリポジトリでは、profile を手書きする必要があった。それが
「CommandMate 既存ユーザーなら誰でも使える」への最大の初期障壁だったので、
リポジトリ自身の宣言から **draft を起案する** runner を同梱する
（[#94](https://github.com/Kewton/commandmate-skills/issues/94)）。
「`verify.yaml` が無ければ CI 定義から起案する」（cmate-verify）と同じ思想である。

```
profile-init.mjs [--repo-root <path>] [--out <path>] [--emit envelope|profile]
                 [--repo <owner/name>] [--id <id>]
```

| flag | 既定 | 効果 |
|---|---|---|
| `--repo-root <path>` | cwd | 調べるリポジトリ |
| `--out <path>` | — | draft profile JSON の書き出し先。**既存なら `out_exists`（exit 4）で上書きしない** |
| `--emit <mode>` | `envelope` | stdout に出すもの。`profile` なら draft JSON そのもの（`> profile.json` 用） |
| `--repo <owner/name>` | 推定 | GitHub slug を宣言する |
| `--id <id>` | 導出 | profile id を宣言する |

```bash
# draft を書き出して確認し、そのまま plan に食わせる
node scripts/profile-init.mjs --repo-root . --out /tmp/my-profile.json
node scripts/orchestrate.mjs 123 --profile-json /tmp/my-profile.json --allow-unverified
```

### 7.1 何を根拠に何を決めるか

読むのは `--repo-root` 配下の file だけである。**network も subprocess も clock も
使わない。** directory 列挙は必ずソートしてから使うので、同じ tree からは
**byte 単位で同じ draft** が出る（Claude/Codex parity）。

| field | 判定材料 | 無かったときの雛形 |
|---|---|---|
| `repository` | `--repo` → git config の `origin` → `package.json` の `repository` → `Cargo.toml` / `pyproject.toml` の repository URL | `OWNER/REPO`（**実在しない形**にしてある） |
| `base` | `.github/workflows/*.yml` の `on.pull_request.branches` → 無ければ `on.push.branches`。複数あるときは `develop` > `main` > `master` > 辞書順先頭 | `origin/main` |
| `branch_template` | CONTRIBUTING / PR template / `docs/*.md` / README が **命名規約として** 述べている prefix（`feature/issue-…` のように placeholder を伴うか、branch 命名を論じている行に限る。ターミナル貼り付けの `feature/greet` のような**実例は採らない**） | `feature/issue-{number}-{slug}` |
| `worktree_template` | 上と同じ文書群の `git worktree add ../…`。**確認できるのは「兄弟 directory である」ことだけで、名前ではない** | `../{repo}-issue-{number}-{slug}` |
| `baseline` | toolchain manifest（`package.json` / `Cargo.toml` / `pyproject.toml` / `go.mod` / `Makefile`）と lockfile。cargo clippy はリポジトリが clippy を使っている証跡があるときだけ入れる | 後述の失敗する placeholder |
| `id` | `<toolchain>-<repository 名>`（内蔵 profile と同じ命名） | `custom-repo` |
| `verified` | — | **常に `false`。この runner が変えることはない** |

toolchain が複数ある場合は `node` > `rust` > `python` > `go` > `make` の固定順で
1つを選び、選ばなかったものを warning `multiple_ecosystems` に載せる。npm 系 lockfile が
複数ある場合も同様に warning `multiple_lockfiles` を載せる。**黙って1つを選ばない。**

### 7.2 provenance と TODO

**profile JSON の中には provenance を入れない。** planner は契約外の field を持つ
profile を `load_error` で拒否するので（第1節）、注釈を書き込んだ profile は
それを使うはずの runner に拒否される。provenance は **stdout の envelope 側**に出る。

envelope の `provenance[]` は field ごとに `source` と `evidence[]`（file・行番号・
その行の**本文**）を持つ。`source` は次のいずれかである。

| source | 意味 |
|---|---|
| `flag` | `--repo` / `--id` で人間が宣言した |
| `detected` | リポジトリ内の記述から読んだ。`evidence[]` がその出所 |
| `derived` | 他の field から機械的に組み立てた（`id`） |
| `default` | **判定材料が無かった**。安全側の雛形であり、必ず対の TODO がある |
| `fixed` | 契約上固定（`verified: false`） |

`source: default` の field には必ず `todos[]` に同じ field の項目が載る。
**「材料が無かったので雛形を置いた」と「読み取った」が出力上見分けられること**が
この runner の要点であり、`gaps_explicit` completion check がそれを自己検査する。
`todos` か `warnings` が1件でもあれば status は `partial` になる（雛形が1つも
無ければ `success`。ただしそれでも `verified` は `false` のままである）。

baseline を1つも推定できなかったときの雛形は、**exit 0 しない command** である。

```
false # TODO: replace with this repository's verification commands
```

baseline は shell を経由せず whitespace 分割で実行されるので、これは `false` の
実行になり必ず失敗する。空配列にしないのは、契約経路で「検証すべき gate が無いから
pass」に化けさせないためである。**埋め忘れた baseline は fail-closed でなければならない。**

### 7.3 起案は profile ではない

profile-init の出力は **draft** であり、envelope はそのことを `draft: true` と
`verified: false` の両方で明示する。plan に渡すには `--allow-unverified` が要り、
plan の risk には `unverified_profile`（high）が載る。これは劣化ではなく設計である
——起案 runner が自分の起案を承認できてしまえば、`verified` flag は意味を失う。

## 8. `verified: true` への昇格

`verified: true` は「この profile の branch/base/worktree/baseline を、**このリポジトリで
実機確認した**」という主張である。書き換えるのは人間であり、runner ではない。
次のすべてを満たしたときにだけ `true` にしてよい。

1. **`repository` が実在し、Issue を読める。** `gh issue view <n> --repo <repository>`
   が成功する。placeholder（`OWNER/REPO`）が残っていない。
2. **`base` が実在する ref である。** `git rev-parse <base>` が成功し、それが実際に
   feature branch の分岐元・PR の向き先である（CI の `pull_request.branches` と一致する）。
3. **`branch_template` が展開後に妥当な branch 名になる。** `{number}` `{slug}` `{repo}`
   を展開した文字列が `[A-Za-z0-9._/-]+` に収まり、`..` を含まず、`/` や `-` で始まらない
   （runner の safe-ref guard と同じ条件）。既存の branch 命名規約と衝突しない。
4. **`worktree_template` が展開後に書ける相対 path になる。** 絶対 path でも
   drive path でもなく、先頭の `../` 以外に `..` を含まない（同 guard）。展開先の親
   directory が実在し書き込み可能で、そこに worktree を作ってよい合意がある。
5. **`baseline` を worktree 内で実際に通した。** clean な worktree で全 command を
   順に実行し、**すべて exit 0**。`false` や `TODO` の残骸が無い。第7節の
   `todos[]` が1件も残っていない。
6. **baseline が「壊れていれば落ちる」ことを確認した。** わざと壊した状態で同じ
   baseline を実行し、**非 0 で落ちる**。素通りする baseline は verification gate に
   ならない（pass の意味が無い gate を verified と呼ばない）。
7. **1件の Issue で plan → dispatch → verification pass まで通した。** `--profile-json`
   に渡した profile で `orchestrate.mjs` が plan を出し、dispatch が worker を配って
   verification が pass する。ここまで通っていない profile は「動くはず」でしかない。

上記を満たしたら `verified: true` を書き足す。**確認した日付・CommandMate の version・
確認した Issue 番号を profile と一緒に記録しておくこと**（profile JSON 自体には
契約外の field を足せないので、profile を置いた場所の README なり commit message なりに書く）。

`--repo` で対象リポジトリを差し替えると `verified` は自動的に降格する（第4節）。
上の主張が「そのリポジトリで」確認したことである以上、リポジトリを替えれば主張の
対象が消えるからである。**確認していない環境へ verified を持ち回さない。**
