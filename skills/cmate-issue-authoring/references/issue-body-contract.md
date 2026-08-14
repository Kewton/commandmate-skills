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

節の順序は自由だが、**次の 5 つは外せない**。

1. 最初の非空行が objective であること。
2. 受入条件の見出しと、その下の箇条書き。
3. 対象ファイルのうち **1 つ以上が非 documentation path** であること。
4. 依存があるなら `{{issue:<key>}}` の placeholder。
5. この Issue を blocking する open question があるなら、末尾に `open-questions` ブロック
   （[open-questions.md](./open-questions.md)）。無いなら置かない。

## 2. なぜこの型なのか（実測）

cmate-orchestrate planner の `orchestrate.mjs` を読み、fixture を入力して実際に
走らせて確認した内容である。

**planner の version 番号はここに書かない。** 番号は必ず腐る（実際に、この package の
3 箇所で別々の番号に割れていた）。代わりに不変条件を書く。

> この文書と `scripts/validate-plan.mjs` の planner mirror は、**planner 本体と同じ
> commit で同時に変更する**。両者の一致はこのリポジトリの conformance テストが
> 保証する。install 先で確かめるものではない。

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

いずれの pattern も **token 先頭**からしか一致しない。`web/src/lib/filter.ts` と書いても
`src/lib/filter.ts` は生まれず、`` `.claude/skills/x/scripts/a.sh` `` は先頭の `.` を含めて
丸ごと拾われる（Issue #49）。

他の候補の **path 境界つき suffix** になっている候補は、**どちらも捨てられない**
（planner Issue #182）。本文に `web/src/lib/filter.ts` と `src/lib/filter.ts` の両方を
書いた場合、両方が `suspected_files` に入り、planner は「どちらを意図したか」を
question（`ambiguous_file_candidate`）にする。question なので dispatch は
`--allow-questions` 無しにはその Issue を送らない。**片方だけを対象にしたいなら、
もう片方を本文から消すこと。** 以前は長い方を残して短い方を捨てていたが、
その推測は「宣言した path を捨てて、ビルド生成物の方を scope に残す」形で外れた ——
どちらが対象かは書いた人にしか分からない。

拾われた path は 2 つに振り分けられる。

| 行き先 | 条件（上から順に判定される） |
|---|---|
| `reference_files` | 「根拠」「出典」「参考」「参照」「背景」「関連」「References」「Context」「Background」等の**見出し配下にしか現れない**（拡張子を問わない） |
| `suspected_files` | 「成果物」「対象ファイル」「変更対象」「Deliverables」等の**見出し配下**にある（拡張子を問わない） |
| `reference_files` | それ以外で、`docs/` で始まる、または `.md` / `.rst` / `.txt` で終わる |
| `suspected_files` | それ以外すべて |

**対象外は「引用しかしない」ことで宣言する（Issue #54）。** バグ報告は再現箇所を
`path:line` で挙げるのが自然だが、その path は以前 `suspected_files` に入り、
「このファイルは変更しない」と本文に書いても worker の `scope.allow`（書き込み権限）に
なっていた。根拠・参考の見出し配下**だけ**に現れる path は対象外として扱われる。

判定は**出現ごと**ではなく path 単位である。散文で「`src/a.ts` を直す」と書いたうえで
根拠にも `src/a.ts:42` を挙げた場合、対象のままになる（引用は指示を取り消さない）。
対象外にしたい path は、根拠・参考の見出しの**外に書かないこと**。
なお `## 再現手順` `## 現状` `## 調査` は**対象外の見出しではない**。バグ報告が
直すべき file を挙げる場所なので、ここに書いた path は対象として扱われる。

**見出しがこの振り分けを決める。** 成果物が Markdown の Issue（設計文書・ADR・手順書）は、
その path を成果物の見出しの下に書けば `suspected_files` に入り、そのまま worker の
`scope.allow` になる（Issue #50。以前は拡張子だけで判定していたため、この種の Issue は
path をいくつ並べても `suspected_files` が空になり、指示どおり md を書いた worker が
scope ゲートに落ちるという構造的な行き止まりだった）。
逆に、参照するだけの文書は成果物の見出しの外に書くこと。見出しの外の
`docs/` / `.md` / `.rst` / `.txt` は従来どおり reference であり、**それしか無い Issue は**
`suspected_files` が空になって planner が「Affected files are unclear」を立てる。
その状態の Issue を計画に含めるなら、`warnings` に `docs_only_issue` を積んで人間に
判断を返すこと（黙って通さない）。

絶対 path・`..`・drive letter・制御文字を含む候補、および `users` `home` `root` `tmp`
`private` `var` `etc` `proc` で始まる候補は、安全のため捨てられる。

既知拡張子の集合は planner の `FILE_EXT` と byte 単位で同一であり（第 2 節冒頭の
不変条件）、`geojson` / `topojson` / `geojsonl` / `jsonc` を含む。集合の外の拡張子を backtick path に
書いた場合（例: `` `data/tiles/demo.mbtiles` ``）、その path は抽出されないが、
planner は plan の `warnings` に `unrecognized_file_extension` を積んで run を
partial に落とす（Issue #43 / CommandMate #1678 B-1: 以前は黙って消え、worker が
scope gate に弾かれて構造的に解決不能だった）。

ただしこの warning は **スラッシュを含む backtick path にしか出ない**。repository 直下の
ファイル（`` `wrangler.jsonc` `` など）が集合の外にあると、抽出もされず warning も出ない
**完全な silent drop** になる。`jsonc` を集合に入れたのはこのためである（Issue #56。
`wrangler.jsonc` / `deno.jsonc` は framework が決めた名前なので改名では回避できない）。
`json5` / `jsonl` は入っていない。

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

### 2.5 受入ゲートのブロック

本文に `acceptance-gates` ブロックが 1 つあると、planner は**それを本文から取り除いてから**
上の抽出器をすべて走らせる（`analyzeIssue`）。したがって

- ブロックの位置は objective・受入条件・path の抽出結果を変えない。
- **ブロックの中身は受入条件として読まれない。** `  - validate` は箇条書きに見えるが、
  剥がされた後に読まれるので拾われない。受入条件の見出しの下にブロックだけを置き、
  散文の箇条書きを書かない本文は「Acceptance criteria are unclear」で止まる。
- ブロックの中に書いた path も候補にならない（gate id は path ではないので通常は無関係）。

validator の写しも同じ順で動く。ブロックを出す条件と規律は
[acceptance-gates.md](./acceptance-gates.md) が正本である。

### 2.6 未決の問いのブロック

`open-questions` ブロックも**同じ扱い**である。planner は本文から取り除いてから抽出器を
走らせる（`analyzeIssue` は acceptance-gates → open-questions の順に剥がす）。したがって

- ブロックの位置は objective・受入条件・path の抽出結果を変えない。
- **ブロックの中身は受入条件として読まれない。** 問いは `  - ` 始まりで箇条書きに見えるが、
  剥がされた後に読まれるので拾われない。
- **問いの中に書いた path は `suspected_files` に入らない。** 未決の問いに現れる path は
  「変えると決めた file」ではないので、worker の `scope.allow` にならないのが正しい。
  変える対象なら対象ファイルの見出しに書くこと。

読まれるのは 1 件につき 1 件の blocking question（`open_question_declared`）としてであり、
それが本記法の全部である。出す条件と、`open_questions[]` から組む規則は
[open-questions.md](./open-questions.md) が正本である。

### 2.7 検証コマンド

backtick か code fence の中にあり、先頭語が `make` `bash` `sh` `pytest` `go` `node`
`python3` `python` か、対象 profile の baseline command の先頭語であるものが
`test_expectations` として拾われる。

`npm` はこの汎用集合に**入っていない**。`node-commandmate` profile の baseline が
`npm ci` などであるために拾われる。対象リポジトリの profile が違えば拾われない。
拾われなくても blocking question にはならないが、受入条件はコマンドで書くこと。

## 3. 検証

この型を守っているかは、計画 artifact を validator に通せば分かる。
`planner_ready` と `body_states_objective` と `dependency_link_in_body` の 3 rule が
上の条件をそのまま実装している（planner の抽出コードの写しである）。ブロックを持つ
本文については `acceptance_gates_*` の 5 rule（`--checkout` が要る）と
`open_questions_*` の 4 rule（要らない）が加わる。

planner 側の抽出が変われば、この文書と validator の写しも**同じ commit で**変える。
一致はリポジトリの CI が検証する。計画から本文を描画して実物の planner に食わせ
blocking question が 0 件であることと、mirror の定数・挙動が planner と一致することの
両方を、変更のたびに機械で確かめている。**install 先で走らせる test は無い**。
install 済み package で確かめられるのは、この文書の型を守った計画が
`node scripts/validate-plan.mjs <plan.json>` を exit 0 で通ることだけである。
