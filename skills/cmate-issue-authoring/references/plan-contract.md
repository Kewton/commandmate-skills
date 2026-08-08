# 分割計画 v1 の契約

Phase 1 が出す **issue split plan** の定義である。機械検証用の正本は
[../schemas/issue-split-plan.v1.json](../schemas/issue-split-plan.v1.json) であり、
この文書はその読み方と、schema では表現できない規則を述べる。

`plan_schema_version` は 1 である。field の追加・削除・意味の変更、enum への値の追加は
version を上げて行う。**未知の field を足さないこと。** schema は閉じており、
受け手は知らない field を無視せず契約違反として扱う。

## 1. 何を表す artifact か

計画は「**まだ存在しない Issue 群**」の記述である。したがって

- Issue 番号は存在しない。Issue 同士は `key`（`^[a-z0-9]+(?:-[a-z0-9]+)*$`）で参照する。
- `generated_mode` は `dry-run` だけである。承認して登録しても計画は書き換えない。
  登録の記録は receipt（[register-contract.md](./register-contract.md)）に分けて持つ。
- `commands` に mutating な command は 1 件も入らない。入っていれば validator が落とす。

## 2. plan_id

```
plan_id = "split-" + sha256(`${repository}\n${source.digest}\n${key1,key2,...}\n`)[0:12]
```

`source.digest` は分割の入力になった bytes の SHA-256 である。したがって同じ Feature 記述を
同じリポジトリへ同じ割り方で計画すれば `plan_id` は一致し、違う入力なら一致しない。
これが Phase 2 の二重登録ガードの根拠である（label ではなく identity である）。

導出値は `node scripts/validate-plan.mjs <plan.json> --derive-id` で得られる。

## 3. Issue 1 件が持つもの

| field | 規則 |
|---|---|
| `key` | 計画内で一意。Issue 番号の代わり |
| `objective` | 1 文。`body` の最初の非空行と**一致**していること |
| `acceptance_criteria` | 1 件以上。コマンドと判定条件で書く |
| `target_files` | 1 件以上。**非 documentation path を 1 つ以上含むこと** |
| `reference_files` | 読む対象。documentation はここ |
| `depends_on` | 計画内の key のみ。推論しない（推論は planner の領分） |
| `size` | `xs` / `s` / `m` / `l` |
| `parallel_safe` | `yes` / `no` / `unknown`。証拠が無いことは `unknown` |
| `evidence` | 1 件以上。`kind` が `input` か `file`。`file` は repo 相対 path |
| `body` | 実際に投稿する Markdown。依存は `{{issue:<key>}}` placeholder |

## 4. 重複と open question

`duplicate_suspicions` が空であることは「**検索して見つからなかった**」を意味する。
検索できなかった場合は `warnings` に `duplicate_search_skipped` を積む。空欄で未実行を
表現してはならない。

`verdict` が `duplicate` の候補は、`open_questions` のどれかの `blocks` にその
`issue_key` が入っていなければならない（rule `duplicate_needs_open_question`）。
重複の疑いを黙って新規 Issue にしないための、機械で効く歯止めである。

## 5. validator

```bash
node scripts/validate-plan.mjs <plan.json> [--schema <path>] [--checkout <path>] [--json]
node scripts/validate-plan.mjs <plan.json> --derive-id
node scripts/validate-plan.mjs --render-acceptance-gates <id,id> --checkout <path>
```

Node の標準ライブラリのみで動く（外部依存の install 不要）。

`--checkout` は対象リポジトリの checkout root である。`acceptance-gates` ブロックを持つ
Issue が計画に 1 件でもあるとき必須で、`<path>/.commandmate/verify.yaml` を読んで
`require:` の id が実在するかを判定する（[acceptance-gates.md](./acceptance-gates.md)）。
ブロックを持つ Issue が無ければ、この file は読まれない。

| exit | 意味 |
|---|---|
| 0 | 計画は valid |
| 1 | 計画が invalid（findings を 1 行 1 件で出力） |
| 2 | run 自体の失敗（usage 誤り、file が読めない、schema が読めない） |

1 と 2 を分けているのは、「計画が悪い」と「検証できていない」を混同させないためである。

### 5.1 schema 層

schema file を読んで解釈する（JS 側で書き直していない）。schema を直せば検証も変わる。
schema が validator の実装していない keyword を使っていたら、黙って読み飛ばさずに
`schema_unsupported` として報告する。

### 5.2 schema にできない層

| rule | 落とすもの |
|---|---|
| `plan_id_is_derived` | `plan_id` が導出値と違う |
| `unique_issue_key` | key の重複 |
| `known_dependency` | 計画内に無い key への依存、自己依存 |
| `acyclic_dependencies` | 依存の閉路（経路を出力する） |
| `dry_run_has_no_mutating_command` | `commands` に mutating: true がある |
| `duplicate_needs_open_question` | `duplicate` 判定を blocking する open question が無い |
| `known_duplicate_target` / `known_question_target` | 計画内に無い key を指している |
| `unique_question_id` | open question の id 重複 |
| `evidence_ref_stays_in_repo` | file evidence が絶対 path や `..` を指す |
| `body_states_objective` | 本文の最初の非空行が `objective` と違う |
| `body_lists_target_files` | `target_files` の path が本文に現れない |
| `dependency_link_in_body` | `depends_on` に対応する placeholder が本文に無い／未知の key を指す |
| `planner_ready` | 本文から受入条件か非 documentation path が読み取れない |
| `acceptance_gates_block_parses` | planner が読めない `acceptance-gates` ブロック |
| `acceptance_gates_no_new_commands` | ブロックが `gates:`（新規コマンド）を宣言している |
| `acceptance_gates_block_is_canonical` | 読めるが renderer の出力と byte 一致しない |
| `acceptance_gates_verify_yaml_read` | ブロックがあるのに `--checkout` 無しで検証した |
| `acceptance_gates_id_exists` | `require:` の id が checkout の `verify.yaml` に無い |

`planner_ready` は cmate-orchestrate planner の抽出の写しである
（[issue-body-contract.md](./issue-body-contract.md) 第 2 節）。planner が変わったら
写しも変える。`acceptance_gates_*` の 5 rule も同じミラーであり、正本と規律は
[acceptance-gates.md](./acceptance-gates.md) にある。

`--checkout` を渡したのに `verify.yaml` が読めない・解釈できないときは exit 2 である。
**「読めなかった」は「ブロックが無かった」ではない。**

## 6. version 運用

- field の追加・削除・意味の変更、enum への値追加 → `plan_schema_version` を上げる。
- rule の追加・文言の調整のみ → Skill の `version` を上げる。

## 7. cmate-issue-refinement との語彙対応

同じ概念を両 package が別々の値域で持っている。**片方に寄せて統一していない**のは、
どちらの schema も v1 として公開済みで、値域の変更は既に出力された artifact を
遡って invalid にするからである（第 6 節のとおり、値域の変更は
`plan_schema_version` を上げる変更であって minor で行えるものではない）。
代わりに**全単射の対応表**を正本として置く。受け渡しはこの表で行い、変換を
その場で発明しない。

| 概念 | この package | cmate-issue-refinement | 対応 |
|---|---|---|---|
| 大きさ | `issues[].size`: `xs` / `s` / `m` / `l` | `decomposition.size`, `decomposition.children[].size`: `xs` / `s` / `m` / `l` / `xl` / `unknown` | 帯の定義は同一。`xl` と `unknown` はこちらに無い（下記） |
| 並列可否 | `issues[].parallel_safe`: `yes` / `no` / `unknown` | `dependencies.parallel_safe`: `true` / `false` / `"unknown"` | `yes` ≡ `true`、`no` ≡ `false`、`unknown` ≡ `"unknown"`。全単射 |
| 重複判定 | `duplicate_suspicions[].verdict`: `duplicate` / `overlapping` / `unrelated` | `related_issues[].relation`: `duplicate` / `overlapping` / `depends_on` / `blocks` / `unrelated` | 同名の 3 値は同義。`depends_on` / `blocks` は重複判定ではなく**依存**なので、こちらでは `issues[].depends_on` の辺になる |

補足。

- **`xl` を持たない理由。** `xl` は refinement 側で「これ以上見積もらず slice を
  列挙せよ」を意味する帯である。この package が出すのは分割**後**の Issue なので、
  `xl` の Issue を計画に載せることは分割が終わっていないことの表明にしかならない。
  値域が狭いのは欠落ではなく制約である。
- **`unknown` size を持たない理由。** 自分で設計した slice の大きさを「分からない」と
  書ける状況が無い。分からないなら分割線が決まっていないので、open question にする。
- **`parallel_safe` の型が違うこと。** refinement 側は boolean 2 値 + 文字列 1 値の
  混在 enum、こちらは文字列 3 値である。混在型のほうが受け手に型分岐を強いる分だけ
  悪い契約だが、既に公開済みなので直していない。**両者を跨ぐときは必ず上の対応表で
  変換する。** `unknown` の意味は両者で同一（証拠が無いことは `yes` / `true` ではない）。
- **重複判定の値域が違うこと。** refinement の `relation` は「関係」の enum であり、
  そのうち 3 値が重複判定、2 値が依存の向きである。こちらは依存を `depends_on` で
  別に持つので、`verdict` は重複判定だけの値域になる。refinement が `depends_on` /
  `blocks` を返した候補は、`duplicate_suspicions` ではなく `issues[].depends_on` へ
  写すこと。**`verdict` に依存の向きを書かない。**

## 8. completion check（報告前の自己申告）

計画または登録結果を人間に返す前に、次の 9 件を 1 件ずつ pass / fail で申告する。
**fail が 1 件でもあれば、その run は success ではない。** 各 check が何を要求して
いるかを決めているのは「正本」列の文書であり、この表はその index である。

| # | check | 正本 |
|---|---|---|
| 1 | 本文のすべての主張が、入力か実際に読んだ file にトレースされている | [safety.md](./safety.md) 第 4 節 |
| 2 | 既存 Issue と merged PR の両方を検索した（できなかったなら warning に積んだ） | [duplicate-guard.md](./duplicate-guard.md) 第 1・3 節 |
| 3 | `duplicate` 判定はすべて open question で blocking されている | [duplicate-guard.md](./duplicate-guard.md) 第 2 節、本書 第 4 節、rule `duplicate_needs_open_question` |
| 4 | 計画が validator を exit 0 で通った | 本書 第 5 節 |
| 5 | 各 Issue が受入条件を 1 つ以上持ち、非 documentation の対象 file を 1 つ以上持つ | 本書 第 3 節、schema の `acceptance_criteria` / `target_files` |
| 6 | 依存が DAG であり、本文の placeholder と `depends_on` が一致している | rule `acyclic_dependencies` / `dependency_link_in_body`（本書 第 5.2 節） |
| 7 | Phase 1 で GitHub への mutation を 1 件も実行していない | [safety.md](./safety.md) 第 1 節 |
| 8 | 次の行動と、それを取るのが誰かを述べた | Phase 1 は要約の末尾、登録後は [register-contract.md](./register-contract.md) 第 6 節 |
| 9 | 受入ゲートのブロックを出したなら、その id を `verify.yaml` に読んで確かめた。読めていない・測れるか判断できない条件はブロックにせず散文に残した | [acceptance-gates.md](./acceptance-gates.md) 第 3 節、rule `acceptance_gates_id_exists` / `acceptance_gates_verify_yaml_read` |
