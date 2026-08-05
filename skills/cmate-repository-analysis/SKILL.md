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

この文書が述べるのは「いつ使うか」「どう呼ぶか」「出力をどう読むか」「止まったとき
何をするか」の 4 つだけである。走査の上限・除外規則・secret 分類は
[references/scan-policy.md](./references/scan-policy.md)、result の各 field と status と
completion check の定義は [references/result-contract.md](./references/result-contract.md)
が正本であり、食い違った場合は references を採る。

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
| `budget` | 任意 | object | 下記 | 走査上限の上書き。[references/scan-policy.md](./references/scan-policy.md) §1 を参照 |

`objective` が空、または「何をしたいのか」が読み取れない場合は
**推測して走査を始めないこと**。status `failure`、`reason_code` は
`ambiguous_objective` として即座に返す。走査 budget を消費してから
入力不備を報告するのは、利用者にとって最も無駄が大きい失敗の仕方である。

`roots` に絶対path、`..`、リポジトリ外を指す path が含まれる場合は、
その要素を採用せず status `failure`、`reason_code` `invalid_root` を返す。

## 3. 権限と禁止事項

宣言している権限は `filesystem_read` のみである。file への書き込み、あらゆる command の
実行、network access、環境変数や credential の読み取りは、**この Skill の手順としては
禁止**である（`commandmate.skill.yaml` の `risk_rationale`）。
実行してよいかを利用者に尋ねることもしない。宣言からは読み取れない線が 2 つある。

- 対象リポジトリの外にある path を読まない。
- `.git/` の内部 object を直接読まない。履歴が必要なら、それはこの Skill の
  scope 外であることを `unresolved` に記録する。

command を実行しないと得られない情報は §6 のとおり `recommended_verification` へ回す。

## 4. 手順

Step 2–6 で書き出す主張には、例外なく file/line evidence を付ける。付けられないものは
書かない。field ごとの evidence 要件は
[references/result-contract.md](./references/result-contract.md) 第3節が正本である。

### Step 0. 入力を検証する

`objective` と `roots` を第2節の規則で検証する。不備があればここで終了する。

### Step 1. scope を決める

[references/scan-policy.md](./references/scan-policy.md) の除外規則・上限・読む順序を
適用し、走査対象の file 一覧を作る。除外した理由は分類ごとに数えておく。
上限に達した場合は、その時点の一覧で続行し、`scope.truncated` を true にする。

### Step 2. 構造と規約を把握する

次を、存在するものだけ読む。存在しないことも結果である。

- root の `README`、`AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING`、`docs/`
- manifest 相当（`package.json`、`pyproject.toml`、`go.mod`、`Cargo.toml`、`Gemfile` など）
- CI 定義（`.github/workflows/`、その他 CI 設定）
- test の置き場と命名規則
- lint / format / type check の設定

ここで得た「このリポジトリの流儀」は `repository_profile.conventions` に記録する。

### Step 3. 既存実装と再利用候補を特定する

`objective` と `focus` の語、およびそこから導かれる同義語で検索し、関係する実装を
特定する。各候補について、そのまま使えるか・拡張が必要か・参考にするだけかと、
呼び出し元の数（変更時の波及範囲）を判断する。

### Step 4. 変更riskを評価する

次の観点で、`objective` を実行した場合に壊れうる箇所を挙げる。

- 共有 module・型・schema・DB migration・公開 API の変更
- 認証・認可・入力検証・path 解決・secret 取り扱いに触れる箇所
- test が存在しない、または薄い箇所
- 生成物・lockfile・catalog など「手で書き換えてはいけない」file

### Step 5. 推奨verificationを抽出する

**リポジトリに実在する** 実行手段だけを挙げる。一般論としての
「unit test を書くべき」は verification ではない。それは finding として書く。

### Step 6. secret らしき値の位置を記録する

[references/scan-policy.md](./references/scan-policy.md) §3 に従い、
`sensitive_locations` へ位置と分類だけを記録する。

### Step 7. result を組み立てる

[references/result-contract.md](./references/result-contract.md) と
[schemas/repository-analysis.result.v1.json](./schemas/repository-analysis.result.v1.json)
に従って result object を作る。あわせて `summary_markdown` に
人が読む要約を、同 reference 第4節の見出し構成で書く。

### Step 8. completion check を実行する

result を返す前に、`completion_check` の 5 件を自分で実行して結果を記録する。
5 件の id と、それぞれが何を確かめるかは
[references/result-contract.md](./references/result-contract.md) §3.9 が正本である。
いずれかが false なら status は `success` にならない。

## 5. 出力

result object 1件を返す。契約は
[references/result-contract.md](./references/result-contract.md) にある。
status は `success` / `partial` / `failure` の3値で、どの条件でどれになるか、
`unresolved` を何件書く必要があるかは同 reference 第2節が正本である。

`partial` を `success` に見せかけないこと。この Skill の価値は、
「どこまで確かめたか」が後から検証できることにある。

## 6. 失敗時の動作

`reason_code` の語彙は
[references/result-contract.md](./references/result-contract.md) §3.8 が正本である。
主な状況と、そのときこの手順が取る動作は次のとおり。

| 状況 | 動作 |
|---|---|
| `objective` が空・曖昧 | `failure` / `ambiguous_objective`。走査しない |
| `roots` が不正 | `failure` / `invalid_root`。走査しない |
| root が存在しない・読めない | `failure` / `unreadable_path` |
| 一部の file が読めない | 続行。`partial` / `unreadable_path` に path を記録 |
| budget 上限に到達、binary・vendor を検出 | 除外・打ち切って続行。記録の仕方は [references/scan-policy.md](./references/scan-policy.md) §1–§2 |
| 目的に関係する実装が見つからない | `partial` / `no_evidence_found`。「無かった」と明記する。推測で埋めない |
| command 実行が必要と判断した | 実行しない。`recommended_verification` に回す |

推測を finding として書かないこと。確信が持てないものは
`confidence` を `low` にするか、書かない。

## 7. 完了条件

この Skill の実行が完了なのは、result object が
[references/result-contract.md](./references/result-contract.md) の契約
（status と `unresolved` の規則、field ごとの evidence 要件、`summary_markdown` の
見出し構成）と
[schemas/repository-analysis.result.v1.json](./schemas/repository-analysis.result.v1.json)
に適合し、`completion_check` の 5 件を実行して結果を申告したときだけである。

## 8. 参照

- [references/scan-policy.md](./references/scan-policy.md) — 除外規則、走査上限、secret 分類
- [references/result-contract.md](./references/result-contract.md) — status、result の各 field、completion check、summary の構成
- [references/agent-compatibility.md](./references/agent-compatibility.md) — Agent 差異と fallback
- [schemas/repository-analysis.result.v1.json](./schemas/repository-analysis.result.v1.json) — 機械検証用 schema
