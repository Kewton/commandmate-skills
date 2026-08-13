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
| `scope_companions` | 任意 | このリポジトリ固有の**伴走ファイル規約**。第9節。**未指定なら宣言が無いのと同じ**で、planner は組み込みの導出だけを行う |
| `dispatch_defaults` | 任意 | このリポジトリ固有の**運転既定**（`no_infer` / `auto_yes` / `wait_timeout` / `max_turns`）。第10節。**未指定なら宣言が無いのと同じ**で、CLI flag の既定値がそのまま効く |

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
| `scope_companions` | `spec/` `test/` `tests/` の実ファイルと、それが写している `src/` `app/` `lib/` の実ファイルの**対**。両方が実在するときだけ1件起案する（第9.4節） | `{"derive": []}`（空。＝宣言が無いのと同じ挙動） |
| `dispatch_defaults` | **起案しない**（key ごと出さない）。第10.5節に理由を書く | — |

toolchain が複数ある場合は `node` > `rust` > `python` > `go` > `make` の固定順で
1つを選び、選ばなかったものを warning `multiple_ecosystems` に載せる。npm 系 lockfile が
複数ある場合も同様に warning `multiple_lockfiles` を載せる。テスト配置が複数見つかった
場合も同じで、固定順の先頭を起案して残りを warning `multiple_test_layouts` に載せる。
**黙って1つを選ばない。**

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

8. **`scope_companions` が実在の規約を写している。** 宣言した規則が、このリポジトリで
   実際に使われている配置と一致する（第9節）。宣言は worker の `scope.allow` に入るので、
   でたらめな規則は「使われない許可」として無害ではあるが、**verified の主張には含まれる**。

`--repo` で対象リポジトリを差し替えると `verified` は自動的に降格する（第4節）。
上の主張が「そのリポジトリで」確認したことである以上、リポジトリを替えれば主張の
対象が消えるからである。**確認していない環境へ verified を持ち回さない。**

## 9. `scope_companions` — repo 固有の伴走ファイル規約（任意）

裁定の記録は [adr-scope-derivation.md](./adr-scope-derivation.md)（第2節・第3節・第15節）、
plan 側の正本は [plan-contract.md](./plan-contract.md) 第5.1節である。

### 9.1 何を解く field か

`suspected_files` は dispatch がそのまま契約の `scope.allow` へ写す。したがって
**Issue が書き忘れた伴走ファイルに触れた worker は不合格になり、契約 scope は send 時
snapshot なので worker 側からは直せない。** planner は「宣言されたファイルを編集すれば
機械的に付いてくるファイル」を既定で許可してこれを消しているが（plan-contract.md 第5.1節）、
その規則は **path だけから決まる普遍のもの**に限られる。

repo には planner が知りようのない規約がある。

- `app/` を `spec/` が写す独自のテスト配置
- 生成物（`.proto` → `*_pb.ts`、locale 辞書、snapshot）
- 宣言済みファイルから決まる、repo が要求する更新

**planner は対象リポジトリを開かない**（開けば plan が入力の純関数でなくなる）し、
**dispatch が worktree を観測する案は却下されている**（契約が worktree ごとに変わり、
`dispatch-contract.md` の byte-identical 性が壊れる）。repo 知識の正しい入口は profile
だけであり、profile は plan の一部なので、そこに置けば両方の性質が保たれる。

### 9.2 形

```json
"scope_companions": {
  "derive": [
    { "when": "app/{dir}{base}.rb", "add": ["spec/{dir}{base}_spec.rb"] },
    { "when": "src/{dir}{base}.proto", "add": ["src/{dir}{base}_pb.ts"] }
  ]
}
```

1つの規則は、**共通の語彙で書かれた2つの path テンプレートの対**である。
`when` が**宣言済み path** に一致して placeholder を束縛し、`add` がその束縛を
具体的な path として書き戻す。placeholder は2つだけである。

| placeholder | 一致するもの |
|---|---|
| `{dir}` | 0個以上の path segment（各々に末尾 `/` が付く）。repo 直下なら空文字 |
| `{base}` | ちょうど1つの segment。通常はファイルの stem（拡張子はテンプレートに直接書く） |

`{dir}` があることで**ミラーが書ける**。`app/{dir}{base}.rb` → `spec/{dir}{base}_spec.rb` は
`app/models/user.rb` を `spec/models/user_spec.rb` に写す（先頭の `app/` は落ちる）。

**glob は書けない。** `*` `?` `[` `]` は両テンプレートで拒否され、wildcard は placeholder
だけである。したがって `add` が生む path は必ず**宣言済み path の一部を literal に含む**。

### 9.3 拒否される宣言（すべて `load_error` / exit 6）

Issue を読む前、profile を読んだ時点で止まる。

| 宣言 | なぜ拒否するか |
|---|---|
| `add: ["spec/**/*_spec.rb"]` | 単独 glob。宣言と無関係な許可であり、[#50](https://github.com/Kewton/commandmate-skills/issues/50) が塞いだ穴を profile 経由で開ける |
| `add: ["docs/module-reference.md"]` | placeholder を1つも含まない。宣言済み path の関数になっていない |
| `add` が `when` の束縛していない placeholder を使う | 同上 |
| `when` が placeholder を1つも持たない / 同じ placeholder を2回持つ | 前者は固定 path 1件にしか一致せず、後者は意味が定義できない |
| `{ext}` など未知の placeholder、`{base` のような括弧の不整合 | typo が literal に化けると「一致しない規則」が黙って残る |
| `..` を含む / 絶対 path | 対象リポジトリの外を指す |
| `derive` 以外の key、規則の `when` / `add` 以外の key | 未知 field を持つ profile を拒否するのと同じ（第1節）。**新しい runner 向けの profile は古い runner で黙って半分無視されるのではなく、はっきり落ちなければならない** |
| `add: []`、`derive` が配列でない、`scope_companions` が object でない | 形が違う |

`{"derive": []}` は**正当で、かつ何もしない**。未指定と同じ導出になる。

### 9.4 起案（`profile-init.mjs`）と provenance

`profile-init.mjs` は `spec/` → `test/` → `tests/` の順に走査し、その下の実ファイルが
`src/` → `app/` → `lib/` の実ファイルを写しているとき、その対を根拠に規則を1件起案する。
**directory があるだけでは起案しない** —— 2つの実ファイルで裏が取れた対だけを、
`provenance[].evidence[]` にその2つを挙げて `detected` として出す。

裏の取れた配置が複数あるときは走査順の先頭を起案し、残りを warning
`multiple_test_layouts` に載せる。1件も取れなければ `{"derive": []}` を `default` として置き、
対の TODO `scope_companions_undetermined` を必ず添える。**起案は常に1規則である** ——
draft は人間が広げる出発点であり、`verified: false` がそう言っている。

### 9.5 運用上の注意

- **宣言を直して plan を取り直すと `run_exists`（exit 4）になる。** run_id の入力は
  Issue 内容・base・profile の `id` / `repository` などであって、profile の中身全部ではない
  （[plan-contract.md](./plan-contract.md) 第1節）。`baseline` を直したときと同じで、
  `--run-id` か `--runs-dir` を使う。エラー文がその2つを名指しする。
- **当たらない規則は無害である。** `scope.allow` は指示ではなく権限なので、使われなかった
  許可は何も起こさない。一方、宣言しなければ worker 1人分の run が失われる。
- **書きすぎは無害ではない。** dispatch は `scope.allow` を sort してから 200 件に切り詰めるので、
  導出が増えすぎると宣言済みファイルが押し出される。planner は合計が 200 に達する手前で
  宣言済みファイル単位に打ち切るが、規則を増やすほど1 Issue あたりの導出は増える。

## 10. `dispatch_defaults` — repo 固有の運転既定（任意）

runner 側の正本は [dispatch-contract.md](./dispatch-contract.md) 第1.1節である
（[#180](https://github.com/Kewton/commandmate-skills/issues/180)）。

### 10.1 何を解く field か

`--no-infer` / `--auto-yes` / `--wait-timeout` は、その run の事情ではなく**リポジトリの事情**を
書いている flag である。

- `--no-infer` — 散文の語彙が重なるリポジトリでは、依存でないものが依存に見える
- `--auto-yes` — worker が書く前に訊くリポジトリでは、付け忘れた run が prompt で止まる
- `--wait-timeout` — e2e / build を含む baseline は、既定 300 秒では必ず timeout する

これらの置き場は人間の記憶と CLAUDE.md しかなく、**付け忘れは「遅い run」ではなく事故**
（phantom edge、誰も答えない prompt、`wait_window_exhausted`）になっていた。第5節が言うとおり
リポジトリ知識の入口は profile だけであり、運転既定もリポジトリ知識である。

### 10.2 形

```json
"dispatch_defaults": {
  "no_infer": true,
  "auto_yes": true,
  "wait_timeout": 3600,
  "max_turns": 10
}
```

| key | 型 | 対応する flag | 消費するのは |
|---|---|---|---|
| `no_infer` | boolean | `--no-infer` | **planner**（`orchestrate.mjs`） |
| `auto_yes` | boolean | `--auto-yes` / `--no-auto-yes` | dispatch |
| `wait_timeout` | 1 以上の整数（秒） | `--wait-timeout` | dispatch |
| `max_turns` | 1 以上の整数 | `--max-turns` | dispatch |

すべて任意で、**未指定の key は宣言が無いのと同じ**である。未知の key・型違い・0 以下は
`plan_invalid`（exit 3）で dispatch を始めない。読み飛ばす実装だと、新しい runner 向けの profile が
古い runner で**半分だけ効く**ことになるからである（第9.3節と同じ理由）。

### 10.3 解決規則

1. **CLI flag は常に上書きする（explicit wins）。明示された off も上書きする。**
   boolean flag は「渡していない」と「off のつもりで渡した」が同じ argv になるので、
   dispatch は三値（true / false / 未宣言）で読み、false を打つ手段として `--no-auto-yes` を持つ。
   `--auto-yes` と `--no-auto-yes` の同時指定は `invalid_input`。
2. **既存の検証は解決後の値に対して行う。** `--unattended` と auto-yes の排他は、
   flag 由来でも profile 由来でも同じく `invalid_input`（exit 3）である。逃げ道は `--no-auto-yes`。
3. 解決結果は dispatch report の limitation `dispatch_defaults_applied` に1行で残る。
   宣言の無い plan では entry が出ないので、**その run の report は本 field 以前と byte 一致する。**

`no_infer` を dispatch は消費できない（承認済み plan を後から un-infer はできない）。
plan の `inputs.infer` と突き合わせ、食い違ったときだけ limitation
`dispatch_defaults_no_infer_not_applied` を残す。**黙って無視はしない。**

### 10.4 run_id と運転既定

profile は **field を選ばず丸ごと** run_id の hash に入る（[#157](https://github.com/Kewton/commandmate-skills/issues/157)、
[plan-contract.md](./plan-contract.md) 第1節）。したがって `dispatch_defaults` を編集した profile で
plan を取り直すと**別の run_id になり、別の run directory に書かれる**。これは
`baseline` や `scope_companions` を直したときと同じ性質で、`dispatch_defaults` のために
新しく作った仕組みではない —— 列挙を持たない hash の設計がそのまま効く。

運用上の注意も第9.5節と同じである: 宣言を直して同じ plan を取り直そうとすると
`run_exists`（exit 4）になるので、`--run-id` か `--runs-dir` を使う。

### 10.5 起案（`profile-init.mjs`）は `dispatch_defaults` を出さない

起案 runner が読むのは**リポジトリが自分について宣言していること**である（第7.1節）。
base branch は workflow に、baseline は `package.json` に、テスト配置は互いを写す2つの実ファイルに
書いてある。運転既定はそのどれでもない ——「このリポジトリには `--no-infer` が要る」は
**動かしてみた人間が到達した結論**であって、tree の中に書いてある事実ではない。

起案すれば必ず推測になり、推測した `auto_yes: true` は検出した `auto_yes: true` と
出力上見分けがつかない（第7.2節が消しに来た性質そのもの）。`scope_companions` のように
**空の宣言 + TODO** を置くこともしない。あちらの空宣言は「配置を決定できなかった」という
TODO と対になっているから意味があるのに対し、ここには決定すべき材料が最初から無く、
TODO はすべてのリポジトリで永久に立ち続けることになる。

**key ごと出さない。** 出さなければ flag の既定値がそのまま効き、draft の使い勝手は変わらない。
運転して分かった時点で、人間がこの節を見て書き足す。

### 10.6 現時点の制約 — planner 側は未着地

**この version の `orchestrate.mjs` は、契約外の field を持つ profile を `load_error` で拒否する
（第1節）。`dispatch_defaults` を書いた profile はまだ plan 段階を通らない。**
本 field を読む側（dispatch runner・`execution-plan.v2` schema・本節）が先に着地しており、
planner 側は `PROFILE_FIELDS` への追加と `publicProfile()` での echo という別 Issue の変更を待っている
（#180 は `orchestrate.mjs` を触らない範囲で切られている）。着地するまでは、
`plan.profile.dispatch_defaults` を持つ plan を手で用意した場合にだけ本節の解決規則が働く。
第10.4節の run_id の性質は、planner が field を受け取った時点で**追加の実装なしに**得られる。
