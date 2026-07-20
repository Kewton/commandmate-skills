# Frozen repository evidence

## `src/export/formats.ts`

```
  3  export type ExportFormat = 'json';
  4
  5  export const formatters = {
  6    json: toJson,
  7  };
```

## `src/ui/ExportButton.tsx`

```
 18  // Single fixed format. There is no select element yet.
 19  <button onClick={() => exportAs('json')}>エクスポート</button>
```

## Body of `#377`, verbatim

```text
## 概要

現在エクスポートは JSON 固定になっている。形式を選べるようにし、
まず CSV と JSON の 2 種類を選択できるようにする。

## スコープ

- `src/export/formats.ts` に ExportFormat を union 化し csv formatter を追加
- `src/ui/ExportButton.tsx` を select + button に変更
- 形式ごとの単体テスト

## 受入条件

- [ ] select で JSON / CSV を切り替えてエクスポートできる
- [ ] csv formatter の単体テストが通る
```

## Body of `#390`, verbatim

```text
エクスポートしたファイル名に日本語が含まれると Content-Disposition が
壊れてダウンロードできない。`src/export/download.ts` の header 生成を修正する。
```

## Body of `#255`, verbatim

```text
README のエクスポート手順が JSON 前提のままなので追記する。
```
