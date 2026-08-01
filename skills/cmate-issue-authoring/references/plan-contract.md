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
node scripts/validate-plan.mjs <plan.json> [--schema <path>] [--json]
node scripts/validate-plan.mjs <plan.json> --derive-id
```

Node の標準ライブラリのみで動く（外部依存の install 不要）。

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

`planner_ready` は cmate-orchestrate planner の抽出の写しである
（[issue-body-contract.md](./issue-body-contract.md) 第 2 節）。planner が変わったら
写しも変える。

## 6. version 運用

- field の追加・削除・意味の変更、enum への値追加 → `plan_schema_version` を上げる。
- rule の追加・文言の調整のみ → Skill の `version` を上げる。
