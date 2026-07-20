# Fixture input

- repository: `example-org/widget-service`
- issue number: `571`
- title: `fix: セッションが 30 分で切れてしまう`
- labels: `bug`
- state: open

## Body

```text
## 概要

セッションの有効期限が 30 分に設定されているため、作業中にログアウトされる。

## 根本原因

`src/auth/session.ts` で maxAge が 30 分にハードコードされている。
Redis の TTL も同じ値で設定されているため、両方を伸ばす必要がある。

## 対策案

maxAge と Redis TTL を 8 時間に変更する。

## 受入条件

- [ ] 8 時間ログインが維持される
```
