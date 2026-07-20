# Fixture input

- repository: `example-org/widget-service`
- issue number: `501`
- title: `feat: 在庫の単位を個数から重量に切り替える`
- labels: `feature`
- state: open

## Body

```text
## 概要

在庫の管理単位を個数 (quantity) から重量 (weight_g) に変更する。

## スコープ

- DB schema の items.quantity を weight_g に変更
- API のレスポンス項目を変更
- 在庫一覧 UI の表示を変更
- CSV エクスポートの列を変更
- 取引先向け webhook の payload を変更

## 受入条件

- [ ] 在庫一覧に重量が表示される
- [ ] 既存データが移行されている
```

## Related Issues visible to the run

- `#455` — `feat: 外部 webhook から在庫を更新できるようにする` (open)
- `#412` — `feat: エクスポートに CSV 形式を追加` (open)
