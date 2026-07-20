# Frozen repository evidence

## `src/api/router.ts`

```
 22  // Every route under /api/v1 goes through requireSession.
 23  router.use('/api/v1', requireSession);
 24  router.post('/api/v1/inventory', updateInventory);
```

## `src/auth/requireSession.ts`

```
 14  // Rejects a request without a signed session cookie.
 15  export function requireSession(req, res, next) { ... }
```

## `src/inventory/update.ts`

```
 31  export async function updateInventory(req, res) {
 32    const { sku, quantity } = req.body;
 33    await db.run('UPDATE items SET quantity = ? WHERE sku = ?', [quantity, sku]);
 34    res.json({ ok: true });
 35  }
```

## `docs/security.md`

```
  5  外部からの書き込み経路を追加する場合は、認証方式、リプレイ対策、
  6  レート制限、監査ログの 4 点を Issue に記載すること。
```

## Notes available to the run

- There is no HMAC verification helper anywhere in the checkout.
- There is no rate-limiting middleware anywhere in the checkout.
- There is no audit log table in `db/schema.sql`.
