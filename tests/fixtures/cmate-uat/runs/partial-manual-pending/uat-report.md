# 実機受入テスト報告 — #2601 / #2602

- run id: 20260916-2601-2602
- 実行者: Command Code 1.53.1（無人）
- 対象: develop `67b4cf89`（dirty なし）

## 環境

| 項目 | 値 |
|---|---|
| ポート | 3011（`uat-env.sh port-find 3010 3030` が返した空き） |
| 起動 | `env.up` を実行し、`wait-health` が 7 秒で通った |
| 停止 | `uat-env.sh stop-listen 3011` → 解放を確認 |

isolation.checks（3 件すべて exit 0。隔離の実測は `evidence/EV-00-isolation.txt`）:

| # | command | exit |
|---|---|---|
| 1 | `lsof -p <pid> -Fn \| grep -q '<run_dir>/uat.db'` | 0 |
| 2 | `! lsof -p <pid> -Fn \| grep -q '/.commandmate/data/cm.db'` | 0 |
| 3 | `curl -fsS 127.0.0.1:3011/api/repositories \| grep -q '<run_dir>/root'` | 0 |

## Issue ごとの結果

### #2601 — go

| 受入条件 | TC | outcome | 証跡 |
|---|---|---|---|
| AC-01 API が警告フィールドを返す | TC-2601-01 | pass | EV-01 |
| AC-02 lint / tsc / unit が exit 0 | TC-2601-02 | pass | EV-02 |

### #2602 — conditional_go

| 受入条件 | TC | outcome | 証跡 |
|---|---|---|---|
| AC-01 警告つきの行が記録される | TC-2602-01 | pass | EV-03 |
| AC-02 Logs タブで警告が判別できる | TC-2602-02 | manual_pending | — |

## 申し送り

- **#2602 AC-02 は未確認（manual_pending）。** `ui.e2e` が宣言されておらず、この実行者に
  ブラウザを操作する手段が無いため、TC-2602-02 を実行できなかった。pass にも fail にも
  丸めていない。人が画面を見るか、`uat.yaml` に `ui.e2e` を宣言してから再実行する。
- 上記により #2602 の verdict は `conditional_go` であり、**受入の可否は人が決める**。
