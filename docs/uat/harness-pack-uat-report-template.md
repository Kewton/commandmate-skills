# Harness Pack 実機UAT レポート（#1458）— テンプレート

> このファイルは**雛形**。実施時に写しを作り（例 `harness-pack-uat-report-YYYYMMDD.md`）、`__FILL__` を埋める。
> §1（機械検証）は作成時点で確認済みの値を記載済み。§2 以降は実施者が記録する。
> **エージェント代理実施はしない**（実 Agent・実機ブラウザ・初見観察は人が実施）。

- **実施日**: `__FILL__`
- **実施者**: `__FILL__`
- **総合 Go/No-Go**: `__FILL__`（Harness Pack release 判定。#1242 MVP 判定とは別記）

## 実施環境

| 項目 | 値 |
|---|---|
| OS | `__FILL__` |
| CommandMate version | `__FILL__`（`/api/app/update-check` の currentVersion で確認） |
| Claude Code CLI version | `__FILL__`（`claude --version`） |
| Codex CLI version | `__FILL__`（`codex --version`） |
| sandbox repository | `__FILL__` |
| 隔離 DB（CM_DB_PATH） | `__FILL__` |
| Catalog（publish 方法） | `__FILL__`（release.yml / test-only injection のどちらか） |

---

## 1. 機械検証（実施済み・再現可能）

- 基点 commit（commandmate-skills main）: `15478e8b9a8b849ac7f0d1b9609d3da10218c0c5`

### 1-1. package / reproducible artifact

| Skill | version | artifact SHA-256 | size | reproducible |
|---|---|---|---|---|
| cmate-worktree-setup | 0.1.0 | `0d9b25c46dbc3c5b6d6ae8200c9d32c49d18457713701156d63f8a193c698c96` | 18342 | yes（byte-identical 2 builds） |
| cmate-worktree-cleanup | 0.1.0 | `e8bd06536a34b1993a2102985d4268b54f98b6871b12e4b4f318a666ad229918` | 20527 | yes |
| cmate-orchestrate | 0.4.0 | `d983f7a899e14e78aee52472bbf8c8938ba89d5df746f19a4debad2f6f3ec0e4` | 76854 | yes |

### 1-2. suite 結果

| suite | 結果 |
|---|---|
| `python3 scripts/validate.py` | PASSED（3 Skill + catalog） |
| `python3 scripts/selftest.py` | 51 tests OK |
| `python3 tests/harness_pack/run.py` | **159 assertions / 4 phases PASSED**（residue-0） |
| `node tests/fixtures/cmate-orchestrate/run_tests.mjs` | 9 plan + 7 dispatch + 12 merge + 8 uat = **36 cases PASSED** |

> 境界: 上記は package の正当性・再現性・Skill 振る舞い契約（fake CLI）まで。**実 install-into-worktree E2E は #1242 の領域**、**実 Agent UAT は本 §2 以降**。

---

## 2. 実機UAT 結果（実施者が記録）

各シナリオ: 結果（PASS/FAIL/未実施）・所要時間・介入・証跡（スクショ/ログのパス）を記録。

### S1. Discovery / reload（Claude / Codex）
- Claude: `__FILL__` / Codex: `__FILL__`
- 未検証 Agent の `unknown` 表示: `__FILL__`
- 証跡: `__FILL__`

### S2. 2 Issue / 2 並列 live run
| フェーズ | 結果 | 証跡 |
|---|---|---|
| setup（2 worktree、非上書き、baseline） | `__FILL__` | `__FILL__` |
| orchestrate dry-run（Wave=1・max_parallel=2・Auto Yes off） | `__FILL__` | `__FILL__` |
| dispatch / wait / capture（2 worker 監督） | `__FILL__` | `__FILL__` |
| verification gate（worker完了≠success） | `__FILL__` | `__FILL__` |
| PR作成 → CI → guarded merge（CI pass必須） | `__FILL__` | `__FILL__` |
| UAT → 修正ループ（回数上限 blocked） | `__FILL__` | `__FILL__` |
| cleanup（proof付き安全削除） | `__FILL__` | `__FILL__` |

### S3. Failure injection
| 注入 | 期待 | 実測 |
|---|---|---|
| worker prompt | human-required 停止 | `__FILL__` |
| worker failure | 後続 Wave 停止 | `__FILL__` |
| verification failure | 次 Wave 停止 | `__FILL__` |
| plan後 drift | mutation 拒否 | `__FILL__` |

### S4. Safety
- Auto Yes off で自動応答なし: `__FILL__`
- high-risk acknowledgment 要求: `__FILL__`
- cleanup zero-delete（dirty/unmerged 保持、force/`-D` 不使用）: `__FILL__`

### S5. desktop / mobile Catalog・detail・install preview
- desktop（Chrome/Safari）: `__FILL__` / mobile（iOS/Android）: `__FILL__`
- high-risk が色以外で識別可: `__FILL__` / stale・offline 警告: `__FILL__`
- スクリーンショット: `__FILL__`

### S6. 初見利用者 plan 到達性
- 被験者数 / 到達率 / 中央値所要時間 / 障害点: `__FILL__`

---

## 3. Go / No-Go チェック（#1458 受入条件）

- [ ] S1 discovery/呼出（Claude・Codex）
- [ ] S2 2 Issue/2並列 完遂（Wave barrier・verification・PR/CI/merge・UAT修正ループ）
- [ ] S2 `/orchestrate` 相当を公式 Skill のみで完遂（人による受け入れ基準）
- [ ] S3 安全停止（prompt/worker/verification failure）
- [ ] S4 Auto Yes off・high-risk ack・cleanup zero-delete
- [ ] 本 report から Go/No-Go・未検証 Agent・既知制約・Phase 5 follow-up を判断できる

**判定**: `__FILL__`

---

## 4. 既知制約・未検証・follow-up

- 未検証 Agent（gemini / opencode 等）: `unknown`（推測認定しない）
- 既知制約: `__FILL__`（UI install 導線 #1441/#1431、CLI `--version` #1237 等）
- #1242 人手UAT（2b）との併実施結果: `__FILL__`
- Phase 5 へ送る事項: `__FILL__`（Runtime 監督・cross-model review・5 Issue/3並列）
