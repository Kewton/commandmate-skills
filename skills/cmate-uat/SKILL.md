---
name: cmate-uat
description: Issue の受入条件を実機環境で検証する。環境の起動・隔離の実測・テストケースの実行・証跡の収集・受入判定・環境の停止までを 1 本で行い、判定を acceptance-result.v1 として返す。サーバや DB を立てないと確かめられない受入条件があるとき、複数 Issue をまとめて実機で受け入れたいときに使う。実装や修正は行わない。
---

# cmate-uat

対象 Issue の受入条件を **実機環境を立ててから**検証し、可否を `go` / `conditional_go` /
`no_go` で返す手順である。

出力は **人が読む 1 本の報告書**（`uat-report.md`）と、**Issue ごとの versioned result
document**（`acceptance/issue-<n>.json`）の 2 つであり、どちらか一方だけを返して終了しては
ならない。

判定の中心にある規則は 1 つだけである。

> **検証していないものを pass に丸めない。**
> 未実行・環境依存・flaky・blocked・手動未確認は、pass でも fail でもない固有の
> outcome として記録し、判定に反映する。

**この Skill は実装も修正もしない。** 不合格は記録して止まる（第 6 節）。

## 0. 使う場面 / 使わない場面

使う場面:

- **サーバ・DB・外部プロセスを起動しないと確かめられない受入条件**があるとき。
- 複数 Issue を **1 つの環境**で続けて受け入れたいとき。
- 実機の証跡（command 出力・exit code・スクリーンショット）を残したいとき。
- `cmate-orchestrate` の UAT 意味ゲートへ判定を渡したいとき。この Skill の result document は
  orchestrate の uat runner が読む意味ゲートの**入力**である（第 5.3 節）。

使わない場面:

- **環境を立てなくても検証できる対象**。test command を叩けば確かめられるなら
  [cmate-acceptance-test](../cmate-acceptance-test/) を使う。この Skill の環境段は無駄になる。
- 実装・修正そのもの。**production code を変更しない。**
- 失敗したテストを通すための修正。原因調査と修正は別の手順に渡す（第 6 節）。
- 受入条件が存在しない、または合意されていない Issue の可否判断。第 4 節 Step 1 で停止する。

**`cmate-acceptance-test` との使い分けは 1 つの問いで決まる**: `.commandmate/uat.yaml` があるか。
あればこの Skill、無ければ acceptance-test である（第 3 節）。

## 1. 入力

| 名前 | 必須 | 内容 | 欠けたときの動作 |
|---|---|---|---|
| `issue_refs` | 必須 | 1 つ以上の Issue（番号 / `owner/repo#<n>` / URL）。**複数 Issue が 1 つの環境を共有する** | `status: failure` で停止。何も起動しない |
| `target_ref` | 必須 | 検証対象の checkout（path / branch / commit） | 利用者に問い合わせる。応答が無ければ `failure` で停止 |
| `uat_yaml` | 任意 | 環境宣言の path（既定 `.commandmate/uat.yaml`） | 既定値を使う。無い場合の扱いは第 3 節 |
| `report_dir` | 任意 | 出力先の親（既定は uat.yaml の `report_dir`、無ければ `.commandmate/uat`） | 既定値を使う |
| `run_id` | 任意 | run の識別子（既定は日時＋Issue 番号） | 既定値を使う |

入力に関する強い制約:

1. **`target_ref` は利用者が明示したものだけを使う。** 現在の作業 directory、既存の worktree、
   production の設定を「たぶんこれだろう」で対象にしない。
2. 受入条件が Issue 本文から機械的に抽出できないときは、抽出結果を利用者に提示して確認を取る。
   確認が取れない条件は `not_verifiable` として記録する。
3. **`cmate-orchestrate` から使う場合の出力先。** runner は `--acceptance-dir` 配下の
   `issue-<n>.json` だけを開く。この Skill の `acceptance/` をそのまま `--acceptance-dir` に
   渡せる（第 5.3 節）。

## 2. 権限

宣言している権限の正本は `commandmate.skill.yaml` の `declared_permissions` と
`risk_rationale` である。宣言は強制ではないので、そこに無い操作が必要になった時点で、
実行せずに利用者へ確認する。宣言からは読み取れない線が 4 つある。

- **`uat.yaml` に宣言された command 以外を、環境の起動・停止に使わない。** 推測で
  `npm start` を打たない。
- **停止はポートで絞る。** `env.down` の既定（同梱 `uat-env.sh stop-listen`）は
  **そのポートで LISTEN しているプロセスだけ**を止める。接続しているだけのプロセス
  （UAT 画面を開いたブラウザの network service など）を巻き込まない。
- 対象 repository と `run_dir` の外に書かない。
- 環境変数は**設定されているか否か**だけを確認し、値を証跡に写さない。

## 3. `.commandmate/uat.yaml`（環境宣言）

**リポジトリ単位の宣言**であり、run ごとでも Issue ごとでもない。`verify.yaml` と同じ
位置づけで、リポジトリに commit する。契約の正本は
[`references/uat-yaml-contract.md`](./references/uat-yaml-contract.md) である。

```yaml
version: 1
env:
  build: "npm run build"
  up: "PORT={port} DB_PATH={run_dir}/uat.db node dist/server.js"
  down: "uat-env.sh stop-listen {port}"
  health: "curl -fsS -m 5 -o /dev/null 127.0.0.1:{port}/api/health"
  port_range: [3010, 3030]
isolation:
  checks:
    - "lsof -p {pid} -Fn | grep -q '{run_dir}/uat.db'"
ui:
  e2e: "npx playwright test"
report_dir: ".commandmate/uat"
```

### 3.1 無いときにどうするか

**人が居る run では起案する。** リポジトリを読んで候補を組み、**どこから拾ったかと、
判断材料が無かった項目**を添えて提示し、**利用者の承認を得てから**書き出す。書き出したら
`up` → `health` → `isolation.checks` → `down` を 1 回通して動くことを確かめる。
起案の根拠の優先順位と provenance の書き方は
[`references/uat-yaml-contract.md`](./references/uat-yaml-contract.md) 第 5 節が正本である。

**人が居ない run では起案も書き出しもしない。** 確認する相手が居ない状態で、推測した
command で未知のプロセスを起動するのは、この Skill が避けるべき操作そのものである。
`status: failure` / `blocking_reasons` に `uat_yaml_missing` を記録し、
報告書の申し送りに「この run では意味ゲートを出せなかった」と書いて終わる。
**環境を立てずにテストケースを回して pass を作ることはしない。**

### 3.2 いつ直すか

製品の動かし方（起動 command・ポートの決め方・DB の場所・health の URL・隔離の確かめ方）を
変える Issue は、**同じ PR で `uat.yaml` も直す**。委任するなら契約の `scope.allow` に
このファイルを入れる。直し忘れは第 4 節 Step 3 で `blocked` として止まる —— 推測で補って
続行しない。

## 4. 手順

### Step 0 — 前提の確認

1. `issue_refs` と `target_ref` が揃っているかを確認する。欠けていれば第 5 節に従って停止する。
2. `target_ref` を解決し、commit SHA と branch 名を記録する。作業 tree が dirty かも記録する。
3. `uat_yaml` を読む。無ければ第 3.1 節。

### Step 1 — 受入条件の抽出

1. 各 Issue の本文から受入条件を列挙する。
2. Issue ごとに `AC-01` から連番で `id` を振る。**抽出順で固定し、実行結果で並べ替えない。**
3. 条件が 0 件の Issue は第 5 節に従って停止する。条件のない Issue を「問題なし」としない。

抽出の規則は [cmate-acceptance-test](../cmate-acceptance-test/) と同じである（対象セクションと
採番を揃えてあるので、同じ Issue を両者で扱っても `id` が食い違わない）。

### Step 2 — テスト計画

各受入条件に、それを確かめるテストケース（`TC-…`）を対応づける。1 つの条件に複数の TC が
付いてよいが、**どの条件にも対応しない TC と、どの TC にも対応しない条件は、両方とも
明示的に列挙する**。後者が残ったまま先へ進んではならない。

観点は 5 つである。正常系 / 異常系（エラー時の出力と終了コード）/ オプションとフラグ /
複数機能の連携 / 既存機能への影響。

計画は `test-plan.md` に書き、**同じファイルの末尾にレビュー記録を畳む**。Issue 網羅性・
実機適合性（モックではなく実機で回せるか）・証跡取得可能性・前提条件の明確さ・異常系の
網羅を自分で点検し、直した内容を記録する。**別ファイルに分けない。**

### Step 3 — 環境（この Step を飛ばして Step 4 へ進んではならない）

1. `uat-env.sh port-find` で `env.port_range` の空きポートを取る。
2. `env.build` があれば実行する。失敗したら `blocked` で停止する。
3. `env.up` を実行する。
4. `uat-env.sh wait-health` で `env.health` が通るまで待つ。通らなければ `blocked` で停止する。
5. **`isolation.checks` を全部実行する。1 つでも失敗したら `blocked` で停止し、
   テストケースを 1 つも実行しない。** 空配列（`[]`）は「隔離不要」の明示宣言であり、
   宣言そのものが無い（キーが欠けている）状態とは区別する（第 3 節）。

隔離が要る理由は、この Skill が**本番と同じ形のものを起動する**からである。DB や
データ root の指定が本番に落ちると、UAT が本番を書き換える。「別ポートだから大丈夫」は
成り立たない。

### Step 4 — 実行と証跡

計画の順に TC を実行する。1 件ごとに証跡を作る。証跡の必須項目と書式は
[`references/evidence.md`](./references/evidence.md) が正本である。

**画面を触る TC の扱い。** その TC を自分の道具で実行できるかを **TC ごとに判断する**。

- `ui.e2e` が宣言されていれば、それを test command として実行する。
- 宣言が無く、自分にブラウザを操作する手段があるなら実行し、証跡（スクリーンショット等）を残す。
- どちらも無ければ、その TC の outcome を `manual_pending` にして**申し送りに回す**。
  **人に問い合わせて待たない**（無人 run で止まるため）。**「確かめられなかった」を
  pass にも fail にも丸めない。**

中断した場合も、そこまでの証跡を保存し、未実行の TC を `not_run` として出力する（第 5 節）。

### Step 5 — 判定

TC の結果を受入条件ごとの `outcome` に写し、そこから Issue ごとの `status` と `verdict` を導く。
`status` は「検証しきったか」、`verdict` は「受入してよいか」を表し、**両者は独立する**。

outcome の 7 値、丸めの禁止、`status` と `verdict` の決定表は
[cmate-acceptance-test の `references/verdict-rubric.md`](../cmate-acceptance-test/references/verdict-rubric.md)
が正本である。**決定表にそのまま従い、表にない組み合わせを自分で判断しない。**

### Step 6 — 出力

第 5 節。**この Step は途中で失敗した場合も必ず実行する。**

### Step 7 — 環境の停止

1. `env.down` を実行する（既定は `uat-env.sh stop-listen {port}`）。
2. ポートが解放されたことを確認する。残っていたら報告書に書く。

**`-sTCP:LISTEN` の絞りを外さないこと。** 外すとそのポートに接続しているだけのプロセスまで
返り、止めると無関係な通信が切れる（CommandMate#2473 の実害）。同梱の `uat-env.sh` は
この絞りを持っている。自分で `lsof -ti:<port>` 相当を書かない。

### Step 8 — 報告

`uat-report.md` だけで状態が復元できることを確認する。申し送りがあるなら、それが
報告書の中で**独立した節**として読めることを確認する。

## 5. 出力

```
<report_dir>/<run_id>/
  uat-report.md              # 人が読む 1 本。複数 Issue をまとめる
  test-plan.md               # 計画 ＋ 末尾にレビュー記録
  acceptance/issue-<n>.json  # Issue ごとの acceptance-result.v1
  evidence/                  # command 出力・スクリーンショット
```

### 5.1 `uat-report.md`

節は 3 つで、順序も固定する。

1. **環境** — 対象 commit、使ったポート、`isolation.checks` の実測結果、起動と停止の記録。
2. **Issue ごとの結果** — Issue ごとに verdict と、受入条件 × TC の対応、証跡への参照。
3. **申し送り** — `manual_pending` / `blocked` / `not_run` を**理由付きで**列挙する。
   ここが空であることと、検証しなかった項目が無いことは同義である。空でないなら、
   何が未確認のまま残っているかが読めなければならない。

**HTML は出さない。** 機械が読む面は `acceptance/issue-<n>.json` が担う。

### 5.2 `acceptance/issue-<n>.json`

[cmate-acceptance-test の `schemas/acceptance-result.v1.json`](../cmate-acceptance-test/schemas/acceptance-result.v1.json)
に適合する JSON を Issue ごとに 1 本書く。`result_schema_version` は `1`、
`skill.id` は **`cmate-uat`**、`skill.version` はこの package の version である。

**schema はこの package に複製しない。** 正本は `cmate-acceptance-test` 側の 1 本だけで、
2 つの Skill が共有する（複製すると必ず乖離する）。

`target.issue_ref` には**呼び出し元から渡された入力をそのまま**記録する。正規化も補完も
しない。何も渡されなかった場合は固定文字列 `unspecified` を書く —— branch 名や directory 名
から Issue 番号を復元することはしない。

### 5.3 `cmate-orchestrate` へ渡す

`acceptance/` をそのまま `--acceptance-dir` に渡す。

```bash
uat.mjs --plan <plan.json> --dispatch <dispatch-report.json> --write-uat \
  --acceptance-dir <report_dir>/<run_id>/acceptance/ --require-acceptance
```

runner は `skill.id` が `cmate-acceptance-test` か `cmate-uat` の document を受け付ける
（cmate-orchestrate 0.33.0 以降）。**それより前の runner では `invalid` として弾かれる。**
runner 側が `target.issue_ref` から Issue 番号を解決できないと `mismatched` になり、
`--require-acceptance` ではその Issue が不合格になる。これは意図した安全側の挙動である。

## 6. 修正しない

**不合格を見つけても直さない。** production code を変更せず、次を行って終わる。

1. `no_go` の Issue について、どの受入条件がどう落ちたかを `findings` に残す。
2. 再現手順（実行した command と観測した出力）を証跡に残す。
3. 報告書の申し送りに、修正の担当が人か別手順かを書く。

修正は `cmate-orchestrate` の fix loop（`uat.mjs --create-uat-fix-worktrees`）か、
利用者が指定する別の手順に渡す。**検証する側が直すと、修正の回数上限と branch 規律を
素通りする。**

## 7. 失敗時の動作

| 状況 | 動作 |
|---|---|
| 入力が欠けている | 推測で補わない。`status: failure` / `verdict: no_go`、`blocking_reasons` に不足入力 |
| `uat.yaml` が無い（人が居る） | 起案して承認を得る（第 3.1 節） |
| `uat.yaml` が無い（無人） | **起案しない。** `failure` / `uat_yaml_missing`。環境を立てない |
| `env.build` / `env.up` が失敗 | `blocked`。TC を 1 つも実行しない |
| `health` が通らない | `blocked`。TC を 1 つも実行しない |
| **`isolation.checks` が 1 つでも失敗** | **`blocked`。TC を 1 つも実行しない**（第 4 節 Step 3） |
| Issue を取得できない | 再試行は 1 回まで。失敗したら `failure` |
| 受入条件が 0 件 | `failure`（Step 1-3） |
| TC の command が異常終了 | それ自体は failure ではない。exit code を証跡に残し、条件を `fail` か `blocked` に分類する（環境要因なら `blocked`） |
| 画面 TC を実行する手段が無い | `manual_pending`。申し送りへ。**人を待たない** |
| 途中で中断された | そこまでの証跡を保存し、未実行を `not_run` として `partial` を出力 |
| `env.down` が失敗 | 報告書に残す。**ポートを広く kill して回収しない** |
| 出力を書けない | 報告書の内容を標準出力へ出し、書けなかったことを明示する |

いかなる失敗経路でも、**報告書と result document を出さずに終了しない。**

## 8. 完了条件

完了したと報告してよいのは、次のすべてが真のときだけである。

1. `uat-report.md` の 3 節が揃っており、申し送りに `manual_pending` / `blocked` / `not_run`
   が理由付きで載っている。
2. Issue ごとの `acceptance/issue-<n>.json` が `acceptance-result.v1` に適合し、
   `skill.id` が `cmate-uat` である。
3. `status` と `verdict` が決定表と矛盾せず、実行した TC と実行しなかった TC が分かれている。
4. `isolation.checks` の実測結果が報告書に残っている。
5. 環境が停止し、ポートの解放を確認した（できなかったなら、そう書いてある）。
6. **production code を変更していない。**

## 9. Agent 差異

能力差と fallback（command が実行できない、ブラウザが無い、対話できない）は
[`references/agent-compatibility.md`](./references/agent-compatibility.md) を参照する。
version ごとの変更点は [`references/changelog.md`](./references/changelog.md) にある。

## 10. 参照

- [`references/uat-yaml-contract.md`](./references/uat-yaml-contract.md) — `uat.yaml` の契約と起案
- [`references/environment-profiles.md`](./references/environment-profiles.md) — 実在リポジトリでの記入例
- [`references/evidence.md`](./references/evidence.md) — 証跡の必須項目と redaction
- [`references/agent-compatibility.md`](./references/agent-compatibility.md) — Agent 差異と fallback
- [`references/onboarding.md`](./references/onboarding.md) — リポジトリをこの運用に載せる手順
- [`references/changelog.md`](./references/changelog.md) — version 履歴
- [`scripts/uat-env.sh`](./scripts/uat-env.sh) — ポート検出 / health 待ち / LISTEN 限定停止
- [cmate-acceptance-test](../cmate-acceptance-test/) — 決定表と result schema の正本
