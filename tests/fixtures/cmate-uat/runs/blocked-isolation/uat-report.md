# 実機受入テスト報告 — #2610（隔離で停止）

- run id: 20260916-2610
- 実行者: Command Code 1.53.1（無人）
- 対象: develop `67b4cf89`

## 環境

| 項目 | 値 |
|---|---|
| ポート | 3012 |
| 起動 | `env.up` は成功し、`wait-health` は 5 秒で通った |
| 停止 | `uat-env.sh stop-listen 3012` → 解放を確認 |

isolation.checks（**2 本目が exit 1。ここで停止した**。実測は `evidence/EV-00.txt`）:

| # | command | exit |
|---|---|---|
| 1 | `lsof -p <pid> -Fn \| grep -q '<run_dir>/uat.db'` | 0 |
| 2 | `! lsof -p <pid> -Fn \| grep -q '/.commandmate/data/cm.db'` | **1** |
| 3 | （未実行） | — |

起動したプロセスが**本番 DB を開いていた**。テストケースを 1 つも実行せずに停止した。

## Issue ごとの結果

### #2610 — no_go（検証できていない）

| 受入条件 | TC | outcome | 証跡 |
|---|---|---|---|
| AC-01 警告つきの行が記録される | TC-2610-01 | not_run | — |
| AC-02 一覧 API が warning を返す | TC-2610-02 | not_run | — |

**この no_go は「受入条件が満たされていない」ではなく「検証できていない」である。**

## 申し送り

- **AC-01 / AC-02 はどちらも未実行（not_run）。** isolation.checks が落ちたため、
  テストケースを 1 つも実行していない。
- **原因**: `uat.yaml` の `env.up` が `CM_DB_PATH` を渡しておらず、起動したプロセスが
  本番 DB を開いた。**この run はデータを書き換える前に止まっている。**
- **次にやること**: `uat.yaml` の `env.up` を直してから再実行する。この Skill は
  推測して直さない（担当は人）。
