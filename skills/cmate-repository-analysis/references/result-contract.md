# result contract v1

`cmate-repository-analysis` が返す result object の定義である。
機械検証用の正本は
[../schemas/repository-analysis.result.v1.json](../schemas/repository-analysis.result.v1.json)
であり、この文書はその読み方と、schema では表現できない規則を述べる。

`result_schema_version` は 1 である。field の追加・削除・意味の変更は
version を上げて行う。**未知の field を足さないこと。** 受け手は
schema にない field を無視せず、契約違反として扱う。

## 1. 全体の形

```json
{
  "result_schema_version": 1,
  "skill_id": "cmate-repository-analysis",
  "skill_version": "0.1.0",
  "status": "success",
  "request": { "objective": "...", "roots": ["."], "focus": [] },
  "scope": {
    "files_listed": 412,
    "files_read": 63,
    "bytes_read": 481203,
    "excluded": [{ "rule": "excluded_directory", "count": 118 }],
    "truncated": false
  },
  "repository_profile": {
    "primary_languages": ["typescript"],
    "project_kinds": ["nextjs_app"],
    "entry_points": [{ "statement": "...", "evidence": [] }],
    "conventions": [{ "statement": "...", "evidence": [] }]
  },
  "findings": [],
  "reuse_candidates": [],
  "risks": [],
  "recommended_verification": [],
  "sensitive_locations": [],
  "unresolved": [],
  "completion_check": { "passed": true, "checks": [] },
  "summary_markdown": "## 目的\n..."
}
```

すべての top-level field は必須である。該当が無い場合は空配列を置く。
field を省略することと空配列を置くことは意味が違う。前者は「答えていない」、
後者は「探した上で無かった」である。

## 2. status

| status | 条件 | `unresolved` |
|---|---|---|
| `success` | 5つの completion check がすべて true。`objective` に答えている | 空でもよい |
| `partial` | 報告できる内容はあるが、check の失敗・打ち切り・読めない path・目的に関係する実装が見つからない・網羅性を保証できない、のいずれかがある | 1件以上必須 |
| `failure` | 報告できる分析が無い | 1件以上必須 |

`completion_check.passed` が false のとき、status を `success` にしてはならない。
`failure` のとき `findings` は空でよいが、`request` と `scope` は埋める。
どこまで進んで失敗したかが分からない失敗報告は、再実行の判断材料にならない。

## 3. field 定義

### 3.1 `request`

利用者から受け取った入力を、正規化した形でそのまま返す。
`roots` は既定値を適用した後の値（既定は `["."]`）。
利用者の入力を書き換えた場合は、`unresolved` にその旨を記録する。

`budget` は **返さない**。上限そのものより、実際に何 file を列挙し、
何 file を読み、打ち切ったかの方が受け手にとって意味があり、
それは `scope` が持っているからである。

### 3.2 `scope`

| field | 意味 |
|---|---|
| `files_listed` | 一覧に載った file 数（除外後） |
| `files_read` | 実際に内容を読んだ file 数 |
| `bytes_read` | 読んだ合計 byte 数 |
| `excluded` | 除外規則ごとの件数。`rule` は scan-policy の6語彙のみ |
| `truncated` | 上限に達して打ち切ったか |

`files_read` が 0 の結果は、`failure` 以外ではありえない。

### 3.3 `findings`

観察された事実。1件が1つの主張であること。複数の主張を1件にまとめない。

`id` は `findings` / `reuse_candidates` / `risks` /
`recommended_verification` を **通して一意** にする。list ごとの一意では、
summary や後続の手順が `id` だけで項目を指せない。

- `category` — `structure` / `convention` / `existing_implementation` /
  `test_coverage` / `build_and_ci` / `security_sensitive`
- `confidence` — `high` / `medium` / `low`。
  `high` は「読んだ file の内容から直接言える」場合に限る。
  慣習からの推測は `low` である
- `statement` — 断定形で1文。「〜と思われる」は `confidence` で表す
- `evidence` — 1件以上必須

### 3.4 `reuse_candidates`

`objective` に対して再利用できる既存資産。

- `reuse_mode` — `as_is`（そのまま使える） / `extend`（拡張が要る） /
  `reference`（作り方の参考にする）
- evidence が無い候補は列挙しないこと。「たぶんどこかにある」は候補ではない

### 3.5 `risks`

`objective` を実行した場合に壊れうる箇所。

- `severity` — `low` / `moderate` / `high`。
  影響の大きさと気付きにくさの積で決める。
  test が無く、失敗が実行時まで表面化しない箇所は `severity` を上げる
- `mitigation` — 具体的な回避・緩和手段。空文字にしない

### 3.6 `recommended_verification`

リポジトリに **実在する** 検証手段のみ。

- `command` — そのまま実行できる形。placeholder を含めない
- `purpose` — この command が何を保証するか
- `evidence` — その command が定義されている場所。`package.json` の
  `scripts`、`Makefile`、CI workflow、`CONTRIBUTING` など

この Skill 自身は command を実行しない。ここに載るのは
**利用者が実行する候補** である。実行結果を書かないこと。

### 3.7 `sensitive_locations`

`path` / `line` / `classification` のみ。分類は
[scan-policy.md](./scan-policy.md) の表に従う。
値・値の一部・伏字化した値・長さのいずれも含めない。

### 3.8 `unresolved`

`reason_code` は次のいずれか。

`ambiguous_objective` / `invalid_root` / `unreadable_path` /
`scan_budget_exhausted` / `binary_skipped` / `excluded_by_policy` /
`no_evidence_found` / `out_of_scope`

`detail` には、何が解決していないかを1文で書く。
`unreadable_path` の場合は対象 path を含める。

### 3.9 `completion_check`

`checks` は5件で、id は次の5つがちょうど1回ずつ現れる。

`evidence_present` / `evidence_resolvable` / `verification_grounded` /
`no_secret_values` / `scope_declared`

`passed` は5件すべてが true のときだけ true にする。
false の check には、何が足りなかったかを `detail` に書く。

### 3.10 `evidence`

```json
{ "path": "src/lib/skills/schema.ts", "line_start": 761, "line_end": 787 }
```

`path` はリポジトリ相対、`/` 区切り、1起点の行番号。
先頭の `/`、`\`、`..` を含む path は書けない。分析対象の外を
指せる result は、それだけで read-only の宣言と矛盾するからである。
`line_end` は `line_start` 以上。**本文の引用 field は存在しない**
（理由は [scan-policy.md](./scan-policy.md) の第4節）。

## 4. `summary_markdown`

人が読む要約。次の6つの見出しを、この順序でちょうど1回ずつ含める。

```markdown
## 目的
## 結論
## 主要な発見
## 再利用候補と変更risk
## 推奨verification
## 未解決と走査範囲
```

規則:

- 「結論」は3行以内。`objective` に対する直接の答えを先に書く
- 主張には `path:line` を添える。構造化 field と食い違わせない
- secret の値・内容の推測を書かない
- 走査を打ち切った場合、「未解決と走査範囲」に必ずその事実を書く
- status が `partial` / `failure` のとき、「結論」の先頭でそれを明示する

## 5. version 運用

- field の追加・削除・意味の変更 → `result_schema_version` を上げる
- enum への値の追加 → `result_schema_version` を上げる（受け手は
  未知の enum 値を受け付けない）
- 文言・見出しの調整のみ → Skill の `version` だけを上げる
