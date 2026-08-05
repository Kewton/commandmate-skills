# result contract v1

`cmate-repository-analysis` の完了条件と、任意で添える result object の定義である。

**完了条件は `summary_markdown`（第4節）と evidence 規律（第6節）である。**
[../schemas/repository-analysis.result.v1.json](../schemas/repository-analysis.result.v1.json)
は 0.2.0 で advisory へ格下げした。schema 適合は完了条件ではない。
なぜそうしたかは第5節に書いた。

`result_schema_version` は 1 である。未知の field を足してよく、受け手はそれを
無視してよい。ただし evidence（§3.10）と `sensitive_locations`（§3.7）の
2つの形だけは閉じたままである。そこへ field を足すことが、
値を持ち出す経路そのものだからである。

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

result JSON を出すかどうかは任意である。出す場合に必須なのは
`result_schema_version` / `skill_id` / `skill_version` / `status` / `scope` /
`summary_markdown` の6つだけで、残りは任意である。この6つは、
どの Skill の何 version が出したかという identity と、格下げにあたって
残すと決めた2つの規律 —— 走査の打ち切りの申告（`scope`）と、
人が読む主成果物（`summary_markdown`）—— にあたる。

任意の field を出すときは、空配列を置くことと省略することの意味が違う。
前者は「探した上で無かった」、後者は「答えていない」である。
該当が無いことを伝えたいなら空配列を置く。

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

**この object は閉じている。** schema を advisory へ緩めた後も、
ここと evidence（§3.10）だけは未知 field を許さない。
「位置と分類だけを渡す」という宣言は、値を書ける field が1つも無いことで
初めて成立するからである。`classification` を自由文にしないのも同じ理由で、
自由文の分類欄は値そのものを書ける場所になる。

### 3.8 `unresolved`

`reason_code` は次のいずれか。

`ambiguous_objective` / `invalid_root` / `unreadable_path` /
`scan_budget_exhausted` / `binary_skipped` / `excluded_by_policy` /
`no_evidence_found` / `out_of_scope`

`detail` には、何が解決していないかを1文で書く。
`unreadable_path` の場合は対象 path を含める。

### 3.9 `completion_check`

`checks` は5件で、id は次の5つがちょうど1回ずつ現れる。
result を返す前に5件すべてを自分で実行し、結果をここに記録する。
各 check が何を確かめるかは、この表が正本である。

| check id | 何を確かめるか |
|---|---|
| `evidence_present` | `findings` / `reuse_candidates` / `risks` の各要素が1件以上の evidence を持つ |
| `evidence_resolvable` | evidence の `path` が今回読んだ file であり、行番号がその file の行数内にある |
| `verification_grounded` | `recommended_verification` の各要素が出典 evidence を持つ |
| `no_secret_values` | `sensitive_locations` が `path` / `line` / `classification` だけで構成されている |
| `scope_declared` | 除外と打ち切りが `scope` と `unresolved` に反映されている |

`passed` は5件すべてが true のときだけ true にする。
false の check には、何が足りなかったかを `detail` に書く。
1件でも false なら status を `success` にしてはならない（第2節）。

**「schema に適合したか」はこの5件に無い。** 0.2.0 より前も無かったが、
SKILL.md 第7節の完了条件が schema 適合を要求していたため、
実質6件目として機能していた。その要求は外した。
5件はいずれも evidence 規律であり、それがこの Skill の完了条件である（第6節）。

result JSON を出さない場合は、この5件の結果を summary の
「未解決と走査範囲」に書く。自己申告そのものを省略してよいわけではない。

### 3.10 `evidence`

```json
{ "path": "src/lib/skills/schema.ts", "line_start": 761, "line_end": 787 }
```

`path` はリポジトリ相対、`/` 区切り、1起点の行番号。
先頭の `/`、`\`、`..` を含む path は書けない。分析対象の外を
指せる result は、それだけで read-only の宣言と矛盾するからである。
`line_end` は `line_start` 以上。**本文の引用 field は存在しない**
（理由は [scan-policy.md](./scan-policy.md) の第4節）。
この object も §3.7 と同じく閉じている。`snippet` や `excerpt` を足せてしまえば、
引用 field が無いという設計はその瞬間に無効になる。

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

## 5. なぜ schema が advisory なのか

0.2.0 でこの schema を closed（`additionalProperties: false`、
「未知 field は契約違反」）から advisory へ格下げした。理由は1つで、
**この result を機械消費する受け手が存在しないから** である。
カタログ内の他の Skill も、CI も、runner も、`repository-analysis` の result を
field 単位で読んでいない。受け手のいない厳格 JSON 適合は、
産出コストだけを払う偶発的複雑さである。

対照として `cmate-acceptance-test` の `acceptance-result.v1` には
`cmate-orchestrate` の uat runner という実在する消費者があり、field 単位で
整合が取れている。厳格な closed schema は「受け手がいる契約」でだけ正当化される。

何を緩め、何を残したか。

| 対象 | 0.2.0 | 判断根拠 |
|---|---|---|
| `additionalProperties: false`（15箇所中13箇所） | 緩めた | 未知 field を落とす受け手がいない |
| evidence と `sensitive_locations` の閉じた形（残り2箇所） | 残した | field を足すことが値を持ち出す経路そのもの |
| top-level `required`（15 → 6） | 緩めた | result JSON 自体が任意の副産物になったため |
| `category` / `reuse_mode` / `severity` / `confidence` | 緩めた | 人が読む分類・程度で、token を突き合わせる者がいない |
| `status` | 残した | `partial` を `success` に見せない規律の中心。採点器が分岐する |
| `unresolved[].reason_code` | 残した | 採点器が token を比較する。「探して無かった」と「探せていない」の区別が消える |
| `scope.excluded[].rule` | 残した | 同上。語彙が開くと除外件数を run 間で比較できない |
| `completion_check.checks[].id` | 残した | 5件がちょうど1回ずつ、が規律そのもの |
| `sensitive_locations[].classification` | 残した | 自由文の分類欄は値そのものを書ける場所になる |

`skill_id` と `result_schema_version` の `const`、`repo_path` の pattern、
`item_id` の pattern も残した。前2つは identity、`repo_path` は
分析対象の外を指せないための制約であり、いずれも分類の緩さとは別の話である。

version 運用:

- この文書が述べる規律が変わった → `result_schema_version` を上げる
- enum への値の追加 → 上げない。受け手は未知の値を無視してよい
- 文言・見出しの調整のみ → Skill の `version` だけを上げる

## 6. 完了条件

schema 適合ではなく、次の4つである。SKILL.md 第7節はこの節を参照している。

1. **summary** — `summary_markdown` が第4節の6見出しをこの順序でちょうど1回ずつ
   持ち、「結論」が `objective` への直接の答えになっている。
2. **evidence の実在** — 主張に付いた evidence の `path` が分析対象の中の実在する
   file を指し、行番号がその file の行数の内側にある。引用は持たない。
3. **secret 非混入** — 値・値の一部・伏字化した値・長さのいずれも、
   summary にも result にも現れない。
4. **走査範囲の申告** — 打ち切り・除外・未解決点が申告されており、
   status がそれと矛盾しない。

1〜4 は機械で確かめられる。配布元リポジトリの
`tests/fixtures/cmate-repository-analysis/check_result.py` がそれを行い、
schema 違反は助言として印字するだけで合否を変えない。
この採点器は `.commandmate/verify.yaml` の `repository-analysis-fixtures` ゲートと
`.github/workflows/validate.yml` から実行される。
