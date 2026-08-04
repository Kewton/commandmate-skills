# Issue 本文の契約

起案する Issue 本文の型である。**好みではない。** cmate-orchestrate の planner が
本文から何を読み取り、どこで blocking question を立てるかを実測して決めたものである。

## 1. 型

```markdown
<objective を 1 文で。本文の最初の非空行にする>

## 対象ファイル

- `src/auth/session-store.ts`
- `src/auth/refresh.ts`

参考: `docs/auth/sessions.md`

## 受入条件

- [ ] `npm test -- src/auth` が exit 0 で終わる
- [ ] 使用済み refresh token での更新要求が 401 を返す

## 依存

- depends on {{issue:session-store-rotation}}（counter が数える事象を先に作る必要がある）

## 根拠

- src/auth/session-store.ts:118 — 現在の実装は token を再発行せず同じ値を返す
```

節の順序は自由だが、**次の 4 つは外せない**。

1. 最初の非空行が objective であること。
2. 受入条件の見出しと、その下の箇条書き。
3. 対象ファイルのうち **1 つ以上が非 documentation path** であること。
4. 依存があるなら `{{issue:<key>}}` の placeholder。

## 2. なぜこの型なのか（実測）

2026-08-01 に `skills/cmate-orchestrate/scripts/orchestrate.mjs` を読み、
fixture を入力して実際に走らせて確認した（対象 package version 0.7.1。runner が
artifact に書く `skill_version` は 0.7.0 で、manifest と drift している）。

planner が立てうる blocking question は **2 つだけ**であり、条件は次である。

| question | 立つ条件 |
|---|---|
| `Acceptance criteria are unclear; add 1-3 concrete completion checks.` | 受入条件の抽出結果が 0 件 |
| `Affected files are unclear; add likely modules or paths.` | suspected file が 0 件 |

### 2.1 objective

`objective` は **本文の最初の非空行**である（先頭の空白・`-`・`#`・`>`・`*` は剥がされる）。
タイトル行ではない。

したがって、本文を `## 目的` のような見出しから始めると objective は「目的」という
語になる。metadata 行（`親: なし` 等）から始めれば、それが objective になる。
**1 文の目的を、最初の非空行に置くこと。**

### 2.2 受入条件

見出し行が `acceptance` / `criteria` / `受入` / `受け入れ` / `完了条件` / `期待結果` /
`受入条件` のいずれかを含むとき、**次の見出しまで**の `- ` / `* ` / `1. ` 箇条書きが
受入条件として抽出される。`- [ ]` の checkbox marker は剥がされる。

見出しが無い箇条書きは拾われない。表も拾われない。

### 2.3 対象ファイル

path は次の 3 通りで拾われる。

- backtick で囲んだ、既知拡張子の path（`` `src/auth/refresh.ts` ``）
- `src/` `tests/` `test/` `scripts/` `docs/` `lib/` `app/` `pkg/` `internal/` `cmd/`
  `.github/` のいずれかで始まる path（backtick 不要）
- ディレクトリを含み既知拡張子で終わる path

拾われた path は 2 つに振り分けられる。

| 行き先 | 条件 |
|---|---|
| `reference_files` | `docs/` で始まる、または `.md` / `.rst` / `.txt` で終わる |
| `suspected_files` | それ以外すべて |

**これが最も踏みやすい罠である。** documentation だけを対象にした Issue は、
path をいくつ並べても `suspected_files` が空になり、planner は必ず
「Affected files are unclear」を立てる。documentation 専用の Issue は、この planner の
前では blocking question ゼロにできない。計画にその Issue を含めるなら、
`warnings` に `docs_only_issue` を積んで人間に判断を返すこと（黙って通さない）。

絶対 path・`..`・drive letter・制御文字を含む候補、および `users` `home` `root` `tmp`
`private` `var` `etc` `proc` で始まる候補は、安全のため捨てられる。

既知拡張子の集合は planner（cmate-orchestrate 0.11.0）の `FILE_EXT` と同一で、
`geojson` / `topojson` / `geojsonl` を含む。集合の外の拡張子を backtick path に
書いた場合（例: `` `data/tiles/demo.mbtiles` ``）、その path は抽出されないが、
planner は plan の `warnings` に `unrecognized_file_extension` を積んで run を
partial に落とす（Issue #43 / CommandMate #1678 B-1: 以前は黙って消え、worker が
scope gate に弾かれて構造的に解決不能だった）。

対象ファイルに依存 manifest（`package.json` / `Cargo.toml` / `go.mod` /
`pyproject.toml` / `Gemfile`）を含めると、planner は同 directory の lockfile
（`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `Cargo.lock` / `go.sum` /
`poetry.lock` / `uv.lock` / `Gemfile.lock`）を既定許可として `suspected_files` に
加え、加えた分を plan の `scope_defaults` に明示する（Issue #44 / CommandMate
#1678 B-2）。lockfile を Issue 本文に書き並べる必要はない。

### 2.4 依存

`depend` / `dependenc` / `prerequisite` / `requires` / `依存` / `前提` を含む見出しの
節、または同じ語を含む行に現れた `#<数字>` が explicit な依存として拾われる。

`{{issue:<key>}}` は Phase 2 が `#<番号>` に置換するので、置換後にこの条件を満たす。
置換前の本文を planner に渡してはならない（番号が無いので依存が失われる）。

### 2.5 検証コマンド

backtick か code fence の中にあり、先頭語が `make` `bash` `sh` `pytest` `go` `node`
`python3` `python` か、対象 profile の baseline command の先頭語であるものが
`test_expectations` として拾われる。

`npm` はこの汎用集合に**入っていない**。`node-commandmate` profile の baseline が
`npm ci` などであるために拾われる。対象リポジトリの profile が違えば拾われない。
拾われなくても blocking question にはならないが、受入条件はコマンドで書くこと。

## 3. 検証

この型を守っているかは、計画 artifact を validator に通せば分かる。
`planner_ready` と `body_states_objective` と `dependency_link_in_body` の 3 rule が
上の条件をそのまま実装している（planner の抽出コードの写しである）。

planner 側の抽出が変われば、この文書と validator の写しも同時に変える。
`tests/fixtures/cmate-issue-authoring/run_tests.sh` は、計画から本文を描画して
**実物の planner に食わせ**、blocking question が 0 件であることを毎回確かめている。
