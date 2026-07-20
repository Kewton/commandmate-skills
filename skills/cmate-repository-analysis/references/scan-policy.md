# 走査policy

`cmate-repository-analysis` が「どこまで読むか」「何を読まないか」
「secret をどう扱うか」の規定である。SKILL.md の Step 1 と Step 6 から参照される。

この policy の目的は2つある。大規模リポジトリで走査が終わらなくなるのを防ぐこと。
そして、読まなくてよいものを読んでしまう事故を防ぐことである。

## 1. 走査上限

| 名前 | 既定値 | 超えたときの動作 |
|---|---|---|
| `max_files_listed` | 5000 | 一覧作成を打ち切る |
| `max_files_read` | 120 | それ以上 file を開かない |
| `max_bytes_per_file` | 262144 | 先頭のみ読む。当該 file を部分読みとして記録 |
| `max_total_bytes` | 8388608 | 読み取りを打ち切る |
| `max_depth` | 12 | それより深い directory へ降りない |

いずれかに達したら `scope.truncated` を true にし、`unresolved` へ
`scan_budget_exhausted` を1件記録し、status を `partial` にする。
**黙って打ち切らないこと。** 打ち切りが見えない結果は、
「全部見た上で何も無かった」と区別できず、後続の判断を誤らせる。

利用者が `budget` で上限を上げた場合も、実際に使った量を `scope` に記録する。

### 読む順序

上限がある以上、読む順序が結果の質を決める。次の順で読む。

1. root の規約 file（`README` / `AGENTS.md` / `CLAUDE.md` / `CONTRIBUTING`）
2. manifest と CI 定義
3. `focus` および `objective` の語に一致した file
4. 3 の呼び出し元・呼び出し先
5. 対応する test

## 2. 除外規則

除外は「読まない」であって「存在を無視する」ではない。
除外した分類と件数は `scope.excluded` に記録する。

`rule` に使う名前は次の6つに限る。この語彙の外を使わないこと。
受け手が件数を比較できなくなる。

| rule | 何を除外したか |
|---|---|
| `excluded_directory` | 下表の directory 配下 |
| `binary_file` | text として読めない file |
| `generated_artifact` | lockfile・生成物・minify 済み asset |
| `git_ignored` | `.gitignore` により追跡されていない path |
| `depth_limit` | `max_depth` より深い path |
| `size_limit` | `max_bytes_per_file` を超えて全体を読まなかった file |

### 常に除外する directory

`.git`、`node_modules`、`vendor`、`third_party`、`bower_components`、
`.venv`、`venv`、`__pycache__`、`.mypy_cache`、`.pytest_cache`、`.tox`、
`dist`、`build`、`out`、`target`、`.next`、`.nuxt`、`.svelte-kit`、
`coverage`、`.turbo`、`.cache`、`.gradle`、`Pods`、`DerivedData`

これらの配下は、存在の記録だけを行い中身を読まない。
ただし「そこに何が入っているか」が `objective` の主題である場合に限り、
利用者の入力に従って `roots` として明示的に指定されたものは読んでよい。

### binary として除外する file

次のいずれかに該当する file は読まない。

- 先頭 8192 byte に NUL byte を含む
- 拡張子が画像・音声・動画・書庫・実行形式・font・PDF・sqlite などの binary 形式
- `max_bytes_per_file` を超え、かつ text と判定できない

binary は path と size だけを記録する。内容の推測を書かない。

### 生成物として扱う file

lockfile（`package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`、`poetry.lock`、
`Cargo.lock`、`go.sum` など）、snapshot、生成された型定義、minify 済み asset。

**依存の一覧を得る目的でのみ**参照し、差分・実装の根拠としては引用しない。
これらを変更対象として推奨しないこと。

### git が無視している path

`.gitignore` により追跡されない path は、配布物・成果物である可能性が高い。
`objective` が明示的に要求しない限り読まない。

## 3. secret の扱い

### 3.1 検出したときの動作

secret らしき値を見つけた場合に result へ書いてよいのは次の3つだけである。

- `path` — リポジトリ相対path
- `line` — 行番号
- `classification` — 下表の分類

**値そのもの、値の一部、伏字化した値、文字数、先頭または末尾の数文字、
hash、これらのいずれも書かない。** summary にも書かない。
値を持たずに位置だけを渡せることが、この Skill が read-only である意味である。

### 3.2 分類

| classification | 何を指すか |
|---|---|
| `env_file` | `.env` およびその variant。値の有無を問わず位置を記録 |
| `credential_assignment` | token / secret / password / api key を思わせる名前への literal 代入 |
| `private_key_material` | 秘密鍵 block、証明書 bundle、keystore |
| `cloud_credential` | cloud provider の credential file または profile |
| `service_token_pattern` | 既知の service token 形式に一致する literal |
| `unknown_high_entropy` | 用途は不明だが高 entropy の literal。**最も誤検知しやすい分類である** |

### 3.3 誤検知の扱い

`unknown_high_entropy` は、test fixture・sample data・hash 定数を拾いやすい。
迷ったら分類を上げず、`unknown_high_entropy` のまま記録する。
「secret である」と断定した表現を summary に書かないこと。

### 3.4 記録してよい場所

`sensitive_locations` のみである。finding、risk、evidence の各 path に
secret を含む file を挙げること自体は問題ないが、その場合も引用はしない。

## 4. evidence の粒度

evidence は `path` と行範囲だけを持ち、**本文の引用を持たない**。
引用を許すと、secret を含む行がそのまま result に載る経路が
1つ増えることになる。行範囲は次の規則で決める。

- 定義を指すときは、定義の開始行から終了行まで
- 呼び出しを指すときは、呼び出しのある1行
- file 全体が根拠のときは、`line_start` を 1、`line_end` を最終行にせず
  代表的な行範囲を選ぶ。file 全体を指す evidence は根拠として弱い

行番号は 1 起点である。読んだ時点の内容に対する行番号であり、
その後の編集で変わりうることを前提に、`summary_markdown` では
path を主、行番号を従として書く。
