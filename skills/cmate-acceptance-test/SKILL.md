---
name: cmate-acceptance-test
description: Issue の受入条件を自動検証と手動確認に分け、証跡付きで検証して Go / Conditional Go / No-Go を判定する。受入テスト、受入条件の検証、マージ可否・リリース可否の判断を求められたときに使う。
---

# cmate-acceptance-test

対象 Issue の受入条件が満たされているかを証跡 (evidence) に基づいて検証し、
可否を `go` / `conditional_go` / `no_go` で返す手順である。

この Skill の出力は、**versioned result document**（`schemas/acceptance-result.v1.json`）と
**human-readable summary** の 2 つであり、どちらか一方だけを返して終了してはならない。

判定の中心にある規則は 1 つだけである。

> **検証していないものを pass に丸めない。**
> 未実行・環境依存・flaky・blocked・手動未確認は、pass でも fail でもない固有の
> outcome として記録し、判定に反映する。

## 0. 使う場面 / 使わない場面

使う場面:

- Issue の受入条件を満たしたかどうかを、証跡付きで確認したいとき。
- 実装が終わったあと、マージ・リリースの可否を第三者が再現できる形で残したいとき。
- 何が検証済みで、何が未検証のまま残っているかを分けて報告したいとき。

使わない場面:

- 実装や修正そのもの。この Skill は検証のみを行い、production code を変更しない。
- 失敗した test を通すための修正。原因調査と修正は別の手順に渡す。
- 受入条件が存在しない、または合意されていない Issue の可否判断。§4 Step 1 で停止する。

## 1. 入力

| 名前 | 必須 | 内容 | 欠けたときの動作 |
|---|---|---|---|
| `issue_ref` | 必須 | Issue 番号または Issue URL | `status: failure` / `verdict: no_go` を出力して停止 |
| `target_ref` | 必須 | 検証対象の worktree path、branch、commit | 利用者に問い合わせる。応答が得られなければ `failure` で停止 |
| `test_commands` | 任意 | 実行してよい command と引数の一覧 | 自動検証を行わず、全 criterion を `manual` または `not_run` として扱う |
| `criteria_override` | 任意 | Issue 本文の代わりに使う受入条件 | Issue 本文から抽出する |
| `evidence_dir` | 任意 | evidence の保存先（既定 `./acceptance-evidence/`） | 既定値を使う |
| `result_path` | 任意 | result document の出力先（既定 `./acceptance-result.json`） | 既定値を使う |

入力に関する強い制約:

1. **`target_ref` は利用者が明示したものだけを使う。** 現在の作業 directory、既存の
   worktree、production の設定を「たぶんこれだろう」で対象にしない。
2. Issue 本文の取得は読み取りのみ。`gh issue edit` などで Issue を書き換えない。
3. 受入条件が Issue 本文から機械的に抽出できないときは、抽出結果を利用者に提示して
   確認を取る。確認が取れない条件は `classification: not_verifiable` として記録する。

## 2. 権限

この Skill が宣言する権限（`commandmate.skill.yaml` の `declared_permissions`）と、その用途:

| 権限 | 用途 | やらないこと |
|---|---|---|
| `filesystem_read` | 対象 repository の source、test、設定の読み取り | 対象 repository の外の path を読まない |
| `filesystem_write` | `evidence_dir` と `result_path` への書き込み、および §4 Step 3 で確認を得た test file の作成 | 既存 file の暗黙上書き。既存 file がある場合は必ず確認する |
| `process_execution` | §3 の command 実行 | 宣言外 command の実行 |
| `network_access` | Issue 本文の取得のみ | それ以外の外部送信。evidence を外部へ upload しない |
| `environment_read` | 必要な環境変数が**設定されているか否か**の確認 | 値の読み出し、値の evidence への記録 |

`declared_permissions` は宣言であって強制ではない。この一覧を超える操作が必要になった
時点で、実行せずに利用者へ確認する。

## 3. 実行してよい command

Skill 自身が実行してよいのは、manifest の `requirements.commands` に宣言された
read-only な用途に限る。

- `gh` — `gh issue view <ref> --json number,title,body,labels,state` のみ。
- `git` — `git status`、`git diff`、`git log`、`git rev-parse`、`git show` のみ。

対象 project の test command（`npm test`、`pytest` など）は **入力として与えられたもの**
だけを実行する。与えられていない command を推測して実行しない。実行前に、その command を
利用者へ提示して確認を取り、確認の結果を result document の `confirmations` に記録する。

次のいずれかに当たる command は、確認を取る前に **cleanup plan を提示する**（§4 Step 3）:

- destructive（data 削除、schema 変更、branch や tag の削除、force push）
- external write（外部 API への書き込み、mail や message の送信、deploy）
- 対象 repository の外への書き込み

確認が得られなかった command は実行せず、対応する criterion を `not_run` にする。
`not_run` を pass に丸めない。

## 4. 手順

### Step 0 — 前提の確認

1. `issue_ref` と `target_ref` が揃っているかを確認する。欠けていれば §5 に従って停止する。
2. `target_ref` を解決し、commit SHA と branch 名を記録する（`git rev-parse HEAD`、
   `git rev-parse --abbrev-ref HEAD`）。この 2 つは result document の `target` に入る。
3. 作業 tree に未 commit の変更があるかを `git status --porcelain` で確認し、
   `target.dirty` に記録する。dirty な tree での検証結果は再現できないので、
   dirty のまま進める場合は summary にその旨を明示する。

### Step 1 — 受入条件の抽出

1. Issue 本文を取得し、受入条件（checkbox、「受入条件」節、`Acceptance Criteria`）を
   列挙する。
2. 各条件に安定した `id` を振る（`AC-01` から連番。抽出順で固定し、実行結果で並べ替えない）。
3. 条件が 0 件のときは、`status: failure` / `verdict: no_go` を出力し、
   `blocking_reasons` に「受入条件が定義されていない」と記録して停止する。
   条件のない Issue を「問題なし」と報告してはならない。

### Step 2 — 分類と risk tier

各条件について次を決める。詳細は [`references/test-plan.md`](./references/test-plan.md) に従う。

- `classification`: `automated`（command で判定できる） /
  `manual`（人間の観察が必要） / `not_verifiable`（この環境では判定できない）
- `risk_tier`: `safe` / `confirm_required` / `blocked`
- 検証に使う `check`（command、test、diff、manual observation のいずれか）

分類の根拠を 1 行で `notes` に残す。分類が曖昧なものを `automated` に寄せない。

### Step 3 — test plan の提示と確認

1. 分類結果を test plan として利用者に提示する。plan には、実行する command、
   対象、期待結果、risk tier、想定所要時間を含める。
2. `confirm_required` の項目には **cleanup plan を必ず添える**。何を作り、何を戻し、
   戻せなかったときに何が残るかを書く。cleanup plan を書けない操作は実行しない。
3. 利用者の応答を `confirmations` に記録する（`granted: true` / `false`、理由、
   cleanup plan）。確認なしに `confirm_required` の項目を実行しない。
4. 対話できない実行形態（非対話 batch）では、`confirm_required` の項目をすべて
   `not_run` にして先へ進む。「対話できないから承認されたとみなす」ことはしない。

### Step 4 — 実行と evidence 収集

確認済みの check を、plan の順に実行する。1 件ごとに evidence を作る。
evidence の必須項目と redaction 規則は
[`references/evidence.md`](./references/evidence.md) に従う。

- command evidence: command 文字列、exit code、stdout/stderr の要約、実行時刻
- test evidence: test 名、pass/fail 件数、失敗した test の識別子
- diff evidence: commit SHA、変更 file の一覧（内容ではなく path と行数）
- manual observation evidence: 観察者、手順、観察した事実、判定

flaky の扱い: 同一 command を再実行して結果が変わった場合、**成功した回を採用しない**。
`outcome: flaky` とし、試行回数と各回の結果を evidence に残す。

中断した場合も、そこまでの evidence を保存し、未実行の check を `not_run` として
result document を出力する（§5）。

### Step 5 — 判定

各 criterion の `outcome` を次のいずれかにする。

`pass` / `fail` / `flaky` / `blocked` / `not_run` / `manual_pending` / `not_verifiable`

`outcome` から `status` と `verdict` への写像は
[`references/verdict-rubric.md`](./references/verdict-rubric.md) の決定表に**そのまま**従う。
決定表にない組み合わせを自分で判断しない。要約すると:

- `status`: `success` = 全 criterion が `pass` か `fail` に確定 /
  `partial` = 未確定の criterion が残った / `failure` = 検証を実施できなかった
- `verdict`: `go` = `status: success` かつ全 `pass` /
  `no_go` = 1 件以上 `fail`、または `status: failure` /
  `conditional_go` = `fail` が 0 件で、未確定項目のすべてに次 action と担当が書かれている場合のみ

`conditional_go` は「たぶん大丈夫」ではない。未確定項目が列挙され、それぞれに
次 action があることが条件である。書けないなら `no_go` である。

### Step 6 — result document の出力

`result_path` に、`schemas/acceptance-result.v1.json` に適合する JSON を書く。
`result_schema_version` は `1` である。**この Step は途中で失敗した場合も必ず実行する。**

### Step 7 — human-readable summary

result document と同じ内容を、次の順で提示する。
利用者が離席から戻ったときに、これだけで状態を復元できることが要件である。

1. 判定（`verdict`）と 1 行の理由
2. 検証対象（Issue、repository、branch、commit、dirty かどうか）
3. 受入条件ごとの outcome 一覧（id、要約、outcome、根拠 evidence の id）
4. **実行した check と実行しなかった check**（未実行はその理由つきで別に並べる）
5. 未確定項目と次 action（担当つき）
6. evidence の保存先

summary の雛形は [`references/verdict-rubric.md`](./references/verdict-rubric.md) にある。

## 5. 失敗時の動作

| 状況 | 動作 |
|---|---|
| 入力が欠けている | 推測で補わない。`status: failure`、`verdict: no_go`、`blocking_reasons` に不足入力を記録 |
| Issue を取得できない | 再試行は 1 回まで。失敗したら `status: failure` |
| 受入条件が 0 件 | `status: failure`（Step 1-3） |
| 確認が得られない | 当該 check を `not_run`、`status: partial` |
| command が異常終了 | それ自体は failure ではない。exit code を evidence に残し、criterion を `fail` か `blocked` に分類する（環境要因なら `blocked`） |
| 環境が要件を満たさない | `blocked`。`fail` に丸めない |
| 途中で中断された | そこまでの evidence を保存し、未実行を `not_run` として `status: partial` を出力 |
| result document を書けない | summary を必ず標準出力へ出し、書けなかったことを明示する |

いかなる失敗経路でも、**result document と summary を出さずに終了しない**。

## 6. 完了条件（completion check）

以下がすべて真になったときにだけ、この Skill は完了したと報告してよい。
1 つでも偽なら `status` は `success` にならない。

1. 受入条件をすべて列挙し、それぞれに `id` と `classification` と `outcome` がある。
2. `pass` の criterion に、それを裏づける evidence が 1 件以上結び付いている。
3. 実行した check と実行しなかった check が、summary で分けて示されている。
4. `confirm_required` の check はすべて、確認記録（`confirmations`）を伴っている。
5. evidence に token、secret、環境変数の値、無関係な file の内容が含まれていない。
6. result document が `schemas/acceptance-result.v1.json` に適合している。
7. `status` と `verdict` が決定表と矛盾していない。
8. 未確定項目のすべてに次 action と担当がある（`conditional_go` の必要条件）。

## 7. Agent 差異

対応 Agent の差、fallback、再読み込みの方法は
[`references/agent-compatibility.md`](./references/agent-compatibility.md) を参照する。
version ごとの変更点・期待効果・制約は
[`references/changelog.md`](./references/changelog.md) にある。

## 8. 参照

- [`references/test-plan.md`](./references/test-plan.md) — 分類と risk tier、cleanup plan
- [`references/evidence.md`](./references/evidence.md) — evidence の必須項目と redaction
- [`references/verdict-rubric.md`](./references/verdict-rubric.md) — 決定表と summary 雛形
- [`references/agent-compatibility.md`](./references/agent-compatibility.md) — Agent 差異と reload
- [`references/changelog.md`](./references/changelog.md) — version 履歴・期待効果・制約
- [`schemas/acceptance-result.v1.json`](./schemas/acceptance-result.v1.json) — result document schema
