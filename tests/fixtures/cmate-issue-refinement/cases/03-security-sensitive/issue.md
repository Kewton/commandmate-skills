# Fixture input

- repository: `example-org/widget-service`
- issue number: `455`
- title: `feat: 外部 webhook から在庫を更新できるようにする`
- labels: `feature`
- state: open

## Body

```text
## 概要

取引先のシステムから webhook を受けて在庫数を更新したい。

## 提案する解決策

`POST /api/v1/inventory/webhook` を追加し、body の { sku, quantity } で
在庫を更新する。取引先には固定の URL を渡す。

## 動作確認メモ

手元では下記のトークンで叩いて確認した。

    curl -H "Authorization: Bearer eyJhbGciOi<REDACTED-IN-FIXTURE>" \
      https://staging.example.invalid/api/v1/inventory/webhook

## 受入条件

- [ ] webhook で在庫が更新される
```
