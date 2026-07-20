# Runbook: release と rollback

対象読者: maintainer。

設計の背景は [docs/design/release-pipeline.md](../design/release-pipeline.md) を参照。
ここは手順と、失敗したときに何をするかだけを書く。

---

## 事前確認（初回および設定変更後）

| 項目 | 期待値 |
|---|---|
| Workflow permissions | read repository contents（既定を read-only に） |
| `release` environment | 存在し、required reviewers に maintainer が設定されている |
| `main` branch protection | PR 必須 / `validate` が required check / force push 禁止 |
| `github-actions[bot]` | `main` の branch protection を bypass できる（Catalog commit のため） |
| tag protection | `*-v*` の作成が maintainer に限定されている |

bypass を許可しない運用にする場合は、`release.yml` 最終 step を
Catalog の PR 作成に変更し、その PR の merge をもって release 完了とすること。

---

## release 手順

### 1. package を `main` に入れる

```bash
git checkout develop
python3 scripts/validate.py     # ここで落ちるなら release してはいけない
# PR: develop → main、validate が緑であることを確認して merge
```

### 2. annotated tag を打つ

```bash
git checkout main && git pull
git tag -a cmate-issue-refinement-v1.0.0 -m "初回リリース。Issue精緻化の標準手順を追加。"
git push origin cmate-issue-refinement-v1.0.0
```

- tag 形式は `<skill-id>-v<version>`。`version` は manifest の `version` と一致必須。
- **lightweight tag は不可。** annotation が Catalog の `changelog` になるため、
  注釈のない tag は build job で失敗する。

### 3. build job を確認する

`release.yml` の `build` job（write 権限なし）が以下を行う。

- tag → 40桁 commit SHA の解決
- 全 package の validate
- pipeline selftest
- 二重 build と byte 一致検証
- preflight Catalog に対する `verify_artifact.py`

ここで失敗した場合、**何も公開されていない**。tag を削除して修正する。

```bash
git push --delete origin <tag> && git tag -d <tag>
```

### 4. 承認する

`release` environment の承認待ちになる。承認前に確認すること。

- build job の log に出た `sha256` と `size`
- `verify_artifact.py` の出力にある `computed risk` / `scripts` / `executables`
  （申告と実体が食い違っていれば build job で既に落ちているが、
  「この risk の Skill を公式として出してよいか」は人間の判断である）
- resolve された commit SHA が、review した commit と一致すること

### 5. publish の進行を見る

承認後、`publish` job が以下の順で進む。

```
draft release 作成 + asset upload
  → asset を download し直して digest 再照合
  → release を公開（安定URLが解決するようになる）
  → Catalog 生成
  → 公開済み asset に対して verify_artifact
  → Catalog snapshot を release asset として添付
  → Catalog を main へ commit
```

完了後、[verify-artifact runbook](./verify-artifact.md) の検証 A を
自分の手元で 1 回実行する。CI の緑は CI 自身の主張であり、
外から見た配布物の検証にはならない。

---

## rollback

### 判断基準

**公開済み Catalog がその artifact を指しているか。** これだけで分岐する。

```bash
# Catalog が既に main に入っているか
git fetch origin main
git show origin/main:catalog/v1/catalog.json | grep -c "<version>"
```

### ケース1: Catalog に入っていない

release / tag を消してよい。client から観測されていない。

```bash
gh release delete "<tag>" --yes --cleanup-tag
```

`--cleanup-tag` が使えない場合は tag を個別に削除する。

### ケース2: Catalog に入っている

**asset を先に消してはいけない。** Catalog が 404 を指す時間が生じる。

```bash
# 1. Catalog commit を revert（先）
git checkout main && git pull
git revert --no-edit <catalog commit>
git push origin main

# 2. Catalog が指していないことを確認してから release を削除（後）
gh release delete "<tag>" --yes
```

### ケース3: publish の途中で job が落ちた

`publish` job の log で、どの step まで完了したかを確認する。
step 名は設計文書の順序表と一対一に対応している。

| 最後に成功した step | 状態 | 対応 |
|---|---|---|
| draft 作成 / upload | draft のみ | ケース1 |
| digest 再照合 | draft のみ | ケース1 |
| release 公開 | 公開済み・Catalog なし | ケース1（release は draft に戻すか削除） |
| Catalog 生成 / verify | 公開済み・Catalog は local のみ | ケース1。local の変更は破棄 |
| Catalog snapshot 添付 | 同上 | ケース1 |
| Catalog commit（push 失敗） | 公開済み・Catalog 未 commit | **再実行してよい。** asset は digest 検証済み。workflow を re-run するか、Catalog commit を手で行う |

---

## やってはいけないこと

- **同じ version 番号を再利用しない。** 一度 Catalog に載った version は immutable。
  `build_catalog.py` は再登録を拒否するが、それ以前に、
  既存の receipt が digest で固定されているため破壊的である。
- **tag を付け替えない。** Catalog が記録するのは resolved commit SHA なので、
  tag を動かしても記録は動かず、両者が食い違うだけになる。
- **Catalog を手で編集しない。** 生成物であり、次の release で上書きされる。
  緊急に version を取り下げる必要がある場合も、revert commit として行う。
- **公開済み asset を差し替えない。** 同じ URL で byte 列が変わることは、
  digest 検証を前提にした利用者にとって最悪の失敗である。

---

## 緊急取り下げ（publish 済みの Skill に問題が見つかった）

1. まず Catalog から該当 version を revert する（client の新規 install を止める）。
2. release asset は**残す**。既に install した利用者の receipt 検証に必要である。
3. [SECURITY.md](../../SECURITY.md) の手順で advisory を作成する。
4. 修正版は**新しい version**として release する。取り下げた番号は再利用しない。
