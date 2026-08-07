# 受入ゲート記法 v1（`acceptance-gates` ブロック）

**この文書が記法の正本である。** [adr-issue-acceptance-gates.md](./adr-issue-acceptance-gates.md)
は裁定の記録であり、記法そのものはここに固定する。ADR と本書が食い違ったら本書が正しい
（ADR 冒頭の運用規約: 実装で形が変わったら正本を直し、ADR に「なぜ変えたか」を追記する）。

読む側の実装は 2 つあり、**同じ commit で変える**こと。

| 実装 | 役割 |
|---|---|
| `scripts/orchestrate.mjs`（planner） | ブロックを **構文だけ** parse し `plan.issues[].acceptance_gates` に載せる |
| `scripts/dispatch.mjs` | `require` の id を worktree の `.commandmate/verify.yaml` に突き合わせ、契約に反映する |

生産側（`cmate-issue-authoring` / `cmate-issue-refinement`）はこの記法を**ミラーする側**であり、
独自に拡張しない（ADR 第5節。後続 Issue）。

---

## 1. 何のための記法か

Issue は「何をもって完了とするのか」を散文で書く。裁定を下すのは
`commandmate wait --verify` の exit code であり、それが走らせるのは対象リポジトリの
`.commandmate/verify.yaml` のゲートである。**この 2 つは別のものである。**
「repo 共通ゲートが緑」と「この Issue が完成した」は同じ命題ではない。

本記法は、その差のうち**機械で測れる部分だけ**を Issue から裁定へ運ぶ。
測れない部分は運ばない — UAT と人間の確認に残す。

---

## 2. ブロックの形

Issue 本文に、info string が `acceptance-gates` の fenced code block を**ちょうど 1 つ**置く。

````markdown
```acceptance-gates
version: 1
require:
  - verify-selftest
  - orchestrate-fixtures
```
````

- **`require:`** — `.commandmate/verify.yaml` に**実在する** gate id の列挙。
  「この Issue では必ずこのゲートが判定に参加すること」の宣言。
- **`gates:`** — 新規コマンドの宣言。**記法としては予約済みだが、この release は実行しない**
  （第 6 節）。

`require` の id は verify.yaml をそのまま指す。翻訳を挟まないのは、記法から verify.yaml への
変換が「再エンコード」になった瞬間に「Issue が書いた条件」と「実際に走ったコマンド」が
ずれる余地が生まれるからである。コピーであれば、ずれは構造的に存在しない。

---

## 3. 規則

| 規則 | 内容 |
|---|---|
| 個数 | 本文中にちょうど 0 個か 1 個。**2 個以上は syntax error**（マージも先勝ちもしない） |
| `version` | 必須・**先頭 key**・値は `1`。未知の version は syntax error（前方互換に丸めない） |
| 構文 | `.commandmate/verify.yaml` と同じ YAML subset。**best-effort 解釈をしない** |
| インデント | list item は**厳密に 2 スペース**。tab は禁止 |
| コメント | **行頭 `#` の行だけ**。行末の `# ...` は値の一部であり syntax error になる |
| 禁止 | anchor / alias（`&` `*`）・flow collection（`[` `{`）・block scalar（`|` `>`）・複数行文字列・`---` / `...` |
| gate id | `^[a-z0-9][a-z0-9-]{0,31}$`。CommandMate の `GATE_ID_PATTERN` と同一 |
| 個数上限 | `require` と `gates[].id` を合わせて最大 32 件。重複は error |
| 空ブロック | `require` も `gates` も空なら syntax error |
| 期待 exit code | **0 に固定する。宣言しない**（第 4 節） |

`require` の順序は**著者が書いた順のまま** plan に載る。契約は Issue の写しであって
再エンコードではない、という第 2 節の原則の帰結である。

---

## 4. 期待 exit code を宣言しない理由

verify.yaml のゲートは定義上「exit 0 が pass」であり、ランナーは `sh -c "$cmd"` の `$?` を
直接読む。非 0 を期待値にすると、記法から verify.yaml への変換にラッパが要る。
**そのラッパこそが偽ゲートの生まれる場所**である — `cmd; test $? -eq 1` は、binary 不在の
127 も、シグナル死の 137 も、期待外の 1 も、等しく飲み込みうる。

「非 0 で終わること」を要求する受入条件は、`! cmd` あるいは `test "$(cmd)" = ...` として
**exit 0 が正である形に書き直せる**。書き直しは Issue 著者が行い、レビュアーが読む。
ラッパを生成器が黙って足すよりも、条件が読める形になる。

---

## 5. 散文からは何も生成しない（fail-closed）

**明示マークされたブロックに書かれた条件だけを契約へ運ぶ。散文・箇条書き・表からは
何も生成しない。**

`plan.issues[].test_expectations` は Issue 本文の backtick / code fence から
「既知 binary で始まる行」を拾った**助言的**な一覧であり、**裁定には使われない**
（`dispatch.mjs` はこの field を一度も参照しない）。この境界は意図的である。

1. **引用は指示ではない。** バグ報告は「今これが落ちる」コマンドを backtick で書く。
   そこから生成したゲートは、**バグが残っている間だけ緑になる**。
2. **抽出の binary 集合は profile の baseline に依存する。** 同じ Issue 本文が、profile を
   変えるだけで別のコマンド集合を生む。裁定の根拠が Issue の外側の設定に依存してしまう。
3. **planner は決定的でなければならない。** plan は入力の純粋関数であり、Claude と Codex で
   byte 一致することが parity の根拠である（[plan-contract.md](./plan-contract.md) 第1節）。
4. **推測ゲートは誰にも承認されていない。** 明示ブロックは Issue 著者が書きレビュアーが
   読むので、Issue の承認がゲートの承認になる。

**ゲートが無いことは、間違ったゲートが在ることより安全である。**
`.commandmate/verify.yaml` 冒頭の言い方を借りれば「A test nobody runs is not a gate」であり、
その裏返しとして**何を測っているか誰も知らないゲートは、緑の証拠能力を持たない**。

---

## 6. `gates:`（新規コマンド）は予約であって未実装

`gates:` を含むブロックは **planner が `acceptance_gate_block_unsupported` で止める**。
黙って無視しない — 受け取っておいて実行しないのは、この機能が防ごうとしている
「書いたはずの受入条件が消えた run」そのものだからである。

実行するには dispatch が worktree の `.commandmate/verify.yaml` に追記する必要があり、
ADR 第3.5節の前提条件が未解決である。実測（[ADR 第11節](./adr-issue-acceptance-gates.md)）:
**未 commit の `.commandmate/verify.yaml` は work-evidence の `uncommitted` に計上される**
（除外されているのは `.commandmate/tasks/` だけ）。契約を置いただけの worktree が
「作業済み」に見え、exit 21 が意味を失う。

ゲートに落とせない条件は、**ゲート外として明示**し UAT / 人間の確認に残すこと。

---

## 7. 記法違反の扱い

**「ブロックが無い」と「ブロックが壊れている」を絶対に混ぜない。**

| 状態 | 扱い |
|---|---|
| ブロックが 0 個 | **従来挙動**。受入ゲートは載らない。契約は byte 単位で従来どおり |
| ブロックが 1 個・構文 OK | `plan.issues[].acceptance_gates` に載り、契約へ運ばれる |
| ブロックが 2 個以上 / 構文違反 / 未知 version / id 不正 / 空 | planner が open question + warning `acceptance_gate_block_invalid`。**推測で復旧しない** |
| `gates:` を含む | planner が open question + warning `acceptance_gate_block_unsupported`（第 6 節） |
| `require` の id が worktree の verify.yaml に無い | dispatch が `acceptance_gate_id_unknown` で **`send` する前に**当該 Issue を止める |
| 実行契約が無い run で `require` がある | dispatch が `acceptance_gates_not_enforceable` で止める（第 8 節） |

いずれも `plan.issues[].acceptance_gates` は `null` になる。**`null` は「ブロックが無かった」を
意味しない** — 区別は warning が持つ。

構文違反を「ブロックが無かったこと」に丸めると、**書いたはずの受入条件が黙って消えた run**が
緑で終わる。planner の `unrecognized_file_extension`（Issue #43）と同じ結論である: 黙って捨てない。

---

## 8. 契約への反映（dispatch 側）

id の実在確認は **planner ではなく dispatch** が行う。planner は対象リポジトリの worktree を
持たない read-only の分析器であり、`verify.yaml` を読まない。dispatch は `commandmate ls` で
解決した実 worktree path を持つので、`<worktree>/.commandmate/verify.yaml` を読んで
突き合わせられる。

**解決可能な id の集合** = `work-evidence` + `scope` + verify.yaml が宣言した全 gate id。
これは CommandMate 自身が契約の `verify.gates` を検証するときの集合と同一である
（`env-clean` は built-in ゲートだが**この集合に入らない**ので、`require: [env-clean]` は拒否される）。

### 8.1 `verify.gates` の書き出し規則 — **絞り込みを禁ずる**

契約の `verify` key の省略は「全ゲートを走らせる」であり、明示は「そのゲートだけを走らせる」
である。したがって `require: [adr-present]` を素朴に `verify.gates: [adr-present]` と書き出すと、
lint も test も走らない契約になる。**受入条件を足したつもりで、判定が弱くなる。**

| operator の `--verify-gates` | Issue の `require:` | 契約の `verify` |
|---|---|---|
| 無し | 無し | **key を書かない**（＝全ゲート） |
| 無し | 有り | **key を書かない**。全ゲートに `require` の id は必ず含まれる（実在確認済み） |
| 有り | 無し | operator の列挙を、operator の順序のまま |
| 有り | 有り | **和集合**（sort + 重複除去） |

和集合が 32 件を超える場合は dispatch しない。片側を落とす縮約は、どちらを落としても
「宣言された要求を黙って捨てる」ことになるので採らない。

### 8.2 goal への転記

`require` が空でないときだけ、契約 `goal` に `## Acceptance gates this issue declared` 節が
足される。ブロックを持たない Issue の goal は **byte 単位で従来どおり**である。

### 8.3 report の `origin`

`verification.gates[]` に optional field `origin`（`repo` / `issue`）が載る。

- `issue` — その Issue の `require:` が名指しした id
- `repo` — repo 共通ゲート（verify.yaml に在るが `require` されていないものを含む）
- **欠落は「由来が記録されていない」であり、`repo` と読んではならない**

実測（[ADR 第11節](./adr-issue-acceptance-gates.md)）: `commandmate wait --verify` が印字する
`GATE <id> PASS|FAIL (<detail>)` 行に**由来は出ない**。したがって `origin` は読み取るものでは
なく、dispatch が「自分が契約に運んだ id か」から**決める**ものである。

---

## 9. 完全な例

`.commandmate/verify.yaml`（対象リポジトリ側）:

```yaml
version: 1
gates:
  - id: validate
    command: "python3 scripts/validate.py"
    timeoutSec: 60
  - id: orchestrate-fixtures
    command: "node tests/fixtures/cmate-orchestrate/run_tests.mjs"
    timeoutSec: 300
```

Issue 本文（抜粋）:

````markdown
## 受入条件

- [ ] planner がブロックを parse する
- [ ] 記法違反は open question になる

```acceptance-gates
version: 1
require:
  - orchestrate-fixtures
```

`orchestrate-fixtures` は既存の 27 case を含むので、非回帰もこのゲートが見る。
````

plan:

```json
"acceptance_gates": { "version": 1, "require": ["orchestrate-fixtures"] }
```

契約: `verify` key は**書かれない**（operator が `--verify-gates` を渡していないため、
全ゲートが走り、その中に `orchestrate-fixtures` は必ず含まれる）。`goal` に受入ゲート節が載る。

report:

```json
"gates": [
  { "id": "work-evidence",        "verdict": "pass", "origin": "repo" },
  { "id": "validate",             "verdict": "pass", "origin": "repo" },
  { "id": "orchestrate-fixtures", "verdict": "pass", "origin": "issue" }
]
```

---

## 10. 変更するときの規約

- 記法を変えるなら、**本書・planner・dispatch・fixture を同じ commit で**変える。
- fixture は ADR 第4節の 6 条を満たすこと。とくに **二点測定**（適合で緑・**成果物側の変異**で赤）と
  **赤の理由の固定**（exit 20 であり、失敗ゲート集合に当該 id が名指しで含まれること）。
  緑だけの fixture は「ゲートが効いている証拠」として採用しない。
- 生産側 2 package にミラーするときは、`FILE_EXT` と同じ形で conformance テストを置くこと。
