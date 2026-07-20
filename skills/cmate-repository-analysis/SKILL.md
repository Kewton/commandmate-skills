---
name: cmate-repository-analysis
description: リポジトリを read-only で走査し、構造・規約・既存実装・再利用候補・変更risk・推奨verificationを、file/line evidence 付きの検証可能な構造化結果として返す。変更に着手する前の現状把握、影響範囲の見積り、実装方針の裏取りに使う。
---

# cmate-repository-analysis

変更に着手する **前** に、対象リポジトリの現状を read-only で把握し、
後続の判断（実装方針・影響範囲・検証手段）を file/line evidence に結び付けた
構造化結果として返すための手順である。

この Skill は書き込みも command 実行も network access も行わない。
読み取りと報告だけを行う。

## 1. この Skill が答える問い

1. このリポジトリは何でできているか（構成・言語・entry point・build/test 経路）。
2. どの規約に従うべきか（`AGENTS.md` / `CLAUDE.md` / `README` / `CONTRIBUTING` 等）。
3. 目的に関係する既存実装はどこにあるか。再利用できるものは何か。
4. 変更した場合、どこが壊れうるか。
5. 変更後、何を実行して確かめるべきか。
6. どこに secret らしき値があるか（**位置と分類だけ**。値は報告しない）。

## 2. 入力

| 名前 | 必須 | 型 | 既定値 | 説明 |
|---|---|---|---|---|
| `objective` | 必須 | 文字列 | なし | これから行おうとしている変更、または調査したい主題。1文以上 |
| `roots` | 任意 | 文字列配列 | `["."]` | 走査の起点。リポジトリ root からの相対path のみ |
| `focus` | 任意 | 文字列配列 | `[]` | 優先的に探す語（module 名・関数名・機能名） |
| `budget` | 任意 | object | 下記 | 走査上限の上書き。[references/scan-policy.md](./references/scan-policy.md) を参照 |

`objective` が空、または「何をしたいのか」が読み取れない場合は
**推測して走査を始めないこと**。status `failure`、`reason_code` は
`ambiguous_objective` として即座に返す。走査 budget を消費してから
入力不備を報告するのは、利用者にとって最も無駄が大きい失敗の仕方である。

`roots` に絶対path、`..`、リポジトリ外を指す path が含まれる場合は、
その要素を採用せず status `failure`、`reason_code` `invalid_root` を返す。

## 3. 権限と禁止事項

宣言している権限は `filesystem_read` のみである。
以下は **この Skill の手順としては禁止** である。実行してよいかを利用者に尋ねることもしない。

- file の作成・変更・削除、および任意の path への書き込み
- build / test / package manager / linter / migration など、あらゆる command の実行
- network access（HTTP、git fetch、package registry の参照を含む）
- 環境変数・credential store・鍵素材の読み取り
- 対象リポジトリの外にある path の読み取り

必要な情報が「command を実行しないと得られない」場合は、実行せずに
`recommended_verification` へ **利用者が実行する候補として** 記載する。
実行結果を推測で書かない。

`.git/` の内部 object を直接読まないこと。履歴が必要なら、それは
この Skill の scope 外であることを `unresolved` に記録する。

## 4. 手順

### Step 0. 入力を検証する

`objective` と `roots` を第2節の規則で検証する。不備があればここで終了する。

### Step 1. scope を決める

[references/scan-policy.md](./references/scan-policy.md) の除外規則と上限を適用し、
走査対象の file 一覧を作る。除外した理由は分類ごとに数えておく。
上限に達した場合は、その時点の一覧で続行し、`scope.truncated` を true にする。

### Step 2. 構造と規約を把握する

次を、存在するものだけ読む。存在しないことも結果である。

- root の `README`、`AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING`、`docs/`
- manifest 相当（`package.json`、`pyproject.toml`、`go.mod`、`Cargo.toml`、`Gemfile` など）
- CI 定義（`.github/workflows/`、その他 CI 設定）
- test の置き場と命名規則
- lint / format / type check の設定

ここで得た「このリポジトリの流儀」は `repository_profile.conventions` に、
根拠 path 付きで記録する。

### Step 3. 既存実装と再利用候補を特定する

`objective` と `focus` の語、およびそこから導かれる同義語で検索し、
関係する実装を特定する。各候補について次を判断する。

- そのまま使えるか、拡張が必要か、参考にするだけか
- 呼び出し元がどれだけあるか（変更時の波及範囲）

`reuse_candidates` の各要素には、**必ず** file/line evidence を付ける。
evidence を付けられない候補は、候補として書かない。

### Step 4. 変更riskを評価する

次の観点で、`objective` を実行した場合に壊れうる箇所を挙げる。

- 共有 module・型・schema・DB migration・公開 API の変更
- 認証・認可・入力検証・path 解決・secret 取り扱いに触れる箇所
- test が存在しない、または薄い箇所
- 生成物・lockfile・catalog など「手で書き換えてはいけない」file

各 risk に `severity` と mitigation を付ける。severity は
「起きたときの影響 × 気付きにくさ」で決める。evidence は必須である。

### Step 5. 推奨verificationを抽出する

**リポジトリに実在する** 実行手段だけを挙げる。
`package.json` の `scripts`、`Makefile` の target、CI workflow の step、
`CONTRIBUTING` に書かれた手順などが出典になる。
出典 path/line を evidence として付ける。

一般論としての「unit test を書くべき」は verification ではない。
それは finding として書く。

### Step 6. secret らしき値の位置を記録する

[references/scan-policy.md](./references/scan-policy.md) の分類に従い、
`sensitive_locations` へ `path` / `line` / `classification` だけを記録する。

**値、値の一部、伏字化した値、長さ、先頭数文字のいずれも記録しない。**
result にも summary にも出さない。`.env.example` のような
「値が入っていないことが期待される file」も、位置は記録する。

### Step 7. result を組み立てる

[references/result-contract.md](./references/result-contract.md) と
[schemas/repository-analysis.result.v1.json](./schemas/repository-analysis.result.v1.json)
に従って result object を作る。あわせて `summary_markdown` に
人が読む要約を、同 reference の見出し構成で書く。

### Step 8. completion check を実行する

result を返す前に、5つの check を自分で実行し、結果を `completion_check` に記録する。

| check id | 内容 |
|---|---|
| `evidence_present` | finding / reuse_candidate / risk の各要素が1件以上の evidence を持つ |
| `evidence_resolvable` | evidence の path が今回読んだ file であり、行番号が file の行数内にある |
| `verification_grounded` | recommended_verification の各要素が出典 evidence を持つ |
| `no_secret_values` | sensitive_locations が位置と分類だけで構成されている |
| `scope_declared` | 除外・打ち切りが scope と unresolved に反映されている |

いずれかが false なら status は `success` にならない。

## 5. 出力

result object 1件を返す。契約は
[references/result-contract.md](./references/result-contract.md) にある。
status は次の3値である。

- `success` — 5つの check がすべて通り、`objective` に答えられている
- `partial` — 報告できる内容はあるが、check の失敗、budget 打ち切り、
  読めない path のいずれかがある。`unresolved` に理由を必ず1件以上書く
- `failure` — 報告できる分析がない。`unresolved` に理由を必ず1件以上書く

`partial` を `success` に見せかけないこと。この Skill の価値は、
「どこまで確かめたか」が後から検証できることにある。

## 6. 失敗時の動作

| 状況 | 動作 |
|---|---|
| `objective` が空・曖昧 | `failure` / `ambiguous_objective`。走査しない |
| `roots` が不正 | `failure` / `invalid_root`。走査しない |
| root が存在しない・読めない | `failure` / `unreadable_path` |
| 一部の file が読めない | 続行。`partial` / `unreadable_path` に path を記録 |
| budget 上限に到達 | 続行。`scope.truncated` を true、`partial` / `scan_budget_exhausted` |
| binary・vendor を検出 | 除外して続行。分類ごとの件数を scope に記録 |
| 目的に関係する実装が見つからない | `partial` / `no_evidence_found`。「無かった」と明記する。推測で埋めない |
| command 実行が必要と判断した | 実行しない。`recommended_verification` に回す |

推測を finding として書かないこと。確信が持てないものは
`confidence` を `low` にするか、書かない。

## 7. 完了条件

次がすべて満たされたときにのみ、この Skill の実行は完了である。

- [ ] result object が result contract に適合している
- [ ] `completion_check.passed` が true、または status が `partial` / `failure` で理由が記録されている
- [ ] すべての判断が file/line evidence に結び付いている
- [ ] secret の値が result・summary のどこにも含まれていない
- [ ] `recommended_verification` がリポジトリに実在する手段だけで構成されている
- [ ] `summary_markdown` が既定の見出し構成を満たしている

## 8. 参照

- [references/scan-policy.md](./references/scan-policy.md) — 除外規則、走査上限、secret 分類
- [references/result-contract.md](./references/result-contract.md) — result の各 field と summary の構成
- [references/agent-compatibility.md](./references/agent-compatibility.md) — Agent 差異と fallback
- [schemas/repository-analysis.result.v1.json](./schemas/repository-analysis.result.v1.json) — 機械検証用 schema
