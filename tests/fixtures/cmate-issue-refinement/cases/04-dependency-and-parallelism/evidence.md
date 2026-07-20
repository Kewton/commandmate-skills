# Frozen repository evidence

## `db/schema.sql`

```
 14  CREATE TABLE items (
 15    sku TEXT PRIMARY KEY,
 16    quantity INTEGER NOT NULL
 17  );
```

## `src/inventory/update.ts`

```
 31  export async function updateInventory(req, res) {
 32    const { sku, quantity } = req.body;
 33    await db.run('UPDATE items SET quantity = ? WHERE sku = ?', [quantity, sku]);
 34    res.json({ ok: true });
 35  }
```

## `src/ui/InventoryTable.tsx`

```
 27  <td>{item.quantity}</td>
```

## `src/export/formats.ts`

```
  3  export type ExportFormat = 'json';
  4
  5  export const formatters = {
  6    json: toJson,
  7  };
```

## `docs/api/v1.md`

```
 40  `GET /api/v1/inventory` は { sku, quantity } の配列を返す。
 41  この形は取引先 2 社が本番で参照している。
```

## Scope lists of the related Issues, verbatim

`#455`:

```text
- src/api/router.ts に POST /api/v1/inventory/webhook を追加
- src/inventory/update.ts に webhook 用の更新経路を追加
```

`#412`:

```text
- src/export/formats.ts に csv formatter を追加
- src/ui/ExportButton.tsx を select + button に変更
```
