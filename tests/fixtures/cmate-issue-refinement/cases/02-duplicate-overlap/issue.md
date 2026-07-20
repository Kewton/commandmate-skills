# Fixture input

- repository: `example-org/widget-service`
- issue number: `412`
- title: `feat: エクスポートに CSV 形式を追加`
- labels: `feature`
- state: open

## Body

```text
## 概要

レポート画面からのエクスポートで CSV を選べるようにする。

## 提案する解決策

`src/export/formats.ts` に csv formatter を追加し、UI の select に
"CSV" を足す。

## 受入条件

- [ ] CSV でエクスポートできる
```

## Related Issues visible to the run

- `#377` — `feat: レポートエクスポートの形式を選択式にする` (open)
- `#390` — `fix: エクスポートのファイル名に日本語が入ると壊れる` (open)
- `#255` — `docs: エクスポート手順を README に追記` (closed)
