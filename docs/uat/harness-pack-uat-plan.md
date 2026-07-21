# Harness Pack 実機UAT 実行計画（#1458）

- **対象**: 公式 Skill `cmate-worktree-setup` / `cmate-worktree-cleanup` / `cmate-orchestrate`
- **対応 Issue**: [Kewton/CommandMate#1458](https://github.com/Kewton/CommandMate/issues/1458)（Epic [#1452](https://github.com/Kewton/CommandMate/issues/1452)、契約 ADR [#1447](https://github.com/Kewton/CommandMate/issues/1447)）
- **人による受け入れ基準**: 現行 `/orchestrate` 相当のハーネスエンジニアリング（PR作成・merge・UAT修正ループを含む）を公式 Skill のみで完遂できること
- **このドキュメントの位置づけ**: 実行者（人）が実機UATを効率よく実施するための runbook。機械で確認できる事前チェックは実施済み（§1a）。実機の人手確認（§2 以降）は実行者が行い、結果を [harness-pack-uat-report-template.md](./harness-pack-uat-report-template.md) の写しへ記録する。

> **エージェント代理実施はしない**。#1242 の MVP UAT レポートと同じ方針で、実 Agent・実機ブラウザ・初見利用者の観察は人が実施する。本 runbook は準備と手順の提供に限る。

---

## 0. 前提と安全

| 項目 | 要件 |
|---|---|
| sandbox repository | GitHub 上の **使い捨て repository**（例 `<you>/harness-pack-uat-sandbox`）。production repository を使わない |
| credential | **最小 scope・短命**の PAT。UAT 専用。log/artifact へ残さない |
| CommandMate | 稼働環境。**隔離 DB**（`CM_DB_PATH` を homedir 配下の専用パスに差し替え、本番 `cm.db` を汚さない） |
| namespace | worktree / branch / DB を **一意 namespace**（例 `hpuat-`）で分離 |
| Agent CLI | `claude` / `codex` の記録済み version を控える（`claude --version` / `codex --version`） |
| 前提 Skill | 下記 §1b の **Catalog publish が未実施**。install 手順の前に実施が必要 |

安全の赤線（実機で必ず守る）:

- **Auto Yes は default off** のまま UAT を開始する。
- **high-risk acknowledgment** をUI/CLI automation で bypass しない。
- cleanup は **dirty/unmerged/unverifiable を zero-delete**、`--force`/`branch -D` を使わない。
- native Skill は CommandMate Runtime の enforcement 対象外であることを理解して実施する（Phase 1B の制約）。

---

## 1. 事前準備

### 1a. 機械検証済み（本計画作成時点で確認済み・再実行可能）

| 確認項目 | コマンド | 結果 |
|---|---|---|
| 3 Skill package 検証 | `python3 scripts/validate.py` | PASSED（3 Skill reproducible） |
| Harness Pack 統合suite | `python3 tests/harness_pack/run.py` | **159 assertions / 4 phases PASSED**（residue-0） |
| orchestrate fixture | `node tests/fixtures/cmate-orchestrate/run_tests.mjs` | 9 plan + 7 dispatch + 12 merge + 8 uat = **36 cases PASSED** |
| reproducible artifact | `python3 scripts/build_release.py --skill <id> --repository Kewton/commandmate-skills --ref main --commit <sha> --out dist/` | 3 Skill とも byte-identical（SHA は report §1 参照） |

これらは「機械が確認できる範囲」の担保であり、実機 install / discovery / live run は §2 以降で人が確認する。

### 1b. Catalog publish（**実publishが必須・要 authorization**）

現在 `catalog/v1/catalog.json` の entries は既存3件（cmate-acceptance-test / -issue-refinement / -repository-analysis）のみで、**Harness Pack 3 Skill は未公開**。§2 の「Catalog→install」を実施するには先に publish が必要。

**重要（実装確認済み）**: CommandMate の Catalog 取得元 `SKILL_CATALOG_URL` は
`raw.githubusercontent.com/Kewton/commandmate-skills/main/catalog/v1/catalog.json` の
**compile-time 定数**であり、環境変数・設定・リクエストから導出できない（`src/config/skill-catalog-config.ts`、SSRF 対策）。
allowlist も完全一致1件のみ。**稼働中の CommandMate に local / test-only Catalog を注入する経路は無い。**
したがって実機の「Catalog→install」を回すには、**main の `catalog/v1/catalog.json` 更新＋GitHub release asset の実 publish** が唯一の方法である。

- **手順（実 publish）**: skill ごとに `<skill-id>-v<version>` タグを push すると `release.yml` が起動する。
  - `build` ジョブ: 権限なし・secretなし・network なしで artifact を再現ビルドし、reproducible を証明（安全）。
  - `publish` ジョブ: **`release` environment の required reviewer（維持者 `Kewton`）の承認**の後にのみ、artifact upload → Catalog 更新（artifact-then-Catalog 順）を行う。**承認するまで何も公開されない**。
  - 3 タグを同時 push すると `release` concurrency（同時1本）で中間のものが pending 段階で cancel される。**cancel されたものは approve 完了後に re-run する**。
- ローカルの `build_release.py` → `build_catalog.py` は「**publish される Catalog 内容の事前検証**」用（reproducible 確認・fixture）であり、**稼働サーバーには注入できない**。実機 install には上記の実 publish が必要。

### 1c. sandbox 環境構築

```bash
# 例（値は環境に合わせる）
export CM_DB_PATH="$HOME/.commandmate-hpuat/cm.db"     # 隔離DB
export UAT_NS="hpuat"                                   # 一意namespace
# 使い捨て sandbox repo を用意し、CommandMate に登録
```

---

## 2. UAT シナリオ（人が実機で実施）

各シナリオで **Agent/CLI/OS/CommandMate version・fixture SHA・介入・失敗・証跡** を report へ記録する。

### S1. Discovery / reload（Claude / Codex）

1. sandbox worktree へ 3 Skill を install（§1b 公開後）。
2. `claude` CLI と `codex` CLI をそれぞれ起動し version を記録。
3. 各 CLI で 3 Skill が候補として提示・呼出できるかを version ごとに記録。
4. 未検証 Agent（gemini / opencode 等）を `unsupported` / `runtime` と**誤表示していない**ことを確認（`unknown` 表示が正）。

**合格条件**: Claude Code・Codex の記録 version で 3 Skill を発見・呼出できる。

### S2. 2 Issue / 2 並列 live run（中核）

sandbox repo に **file-disjoint な 2 Issue** を作成（例、Node profile）:

- **Issue A**: `src/util/slug.ts` に `slugify()` を追加し `tests/util/slug.test.ts` を追加。
- **Issue B**: `src/util/clamp.ts` に `clamp()` を追加し `tests/util/clamp.test.ts` を追加。
- 2 Issue は依存なし・ファイル重複なし（同一 Wave に入るべき）。

実行フロー（`cmate-orchestrate` を使用、Auto Yes off）:

1. `cmate-worktree-setup` で 2 Issue の worktree を準備（base SHA・baseline を確認、既存を上書きしない）。
2. `cmate-orchestrate` を **dry-run** で起動 → manifest / issue analysis / dependency / **Wave（2 Issue が同一 Wave / max_parallel=2）** / risk / 権限 / Auto Yes off を確認。
3. plan を承認し dispatch → `commandmate send/wait/capture` で 2 worker を監督。
4. 各 worker 完了後、**verification report の pass** を確認（worker 完了だけを success 扱いしないこと）。
5. 明示承認のうえ **PR 作成 → CI 確認 → guarded merge**（CI pass 必須）。
6. UAT フェーズを実行。不合格が出たら **fix worktree → 修正 → 再検証 → 再merge の修正ループ**（回数上限で blocked 停止すること）。
7. `cmate-worktree-cleanup` で merged worktree を安全削除（proof 付き、dirty/unmerged は保持）。

**合格条件**: Wave barrier と verification evidence を守り、PR作成・CI確認・merge・UAT修正ループまで公式 Skill のみで完遂できる。

### S3. Failure injection（安全停止）

| 注入 | 期待挙動 |
|---|---|
| worker が prompt を出す | 自動応答せず **human-required で停止**、利用者へ提示 |
| 1 worker が failure | 後続 Wave を **dispatch しない**、partial として報告 |
| verification failure | 次 Wave を **dispatch しない**、blocked/partial |
| plan 後に branch/HEAD drift | mutation 前に再検証し **拒否** |

### S4. Safety 実機確認

- Auto Yes **default off** で prompt が自動応答されないこと。
- high-risk Skill の install/実行で **acknowledgment** が要求されること。
- cleanup で **dirty/unmerged/unverifiable が zero-delete**、force/`branch -D` が使われないこと。

### S5. desktop / mobile Catalog・detail・install preview

- desktop（Chrome/Safari）と mobile（iOS Safari / Android Chrome）実機で `/skills` と `/skills/[id]` を開く。
- 能力・**Phase 1B 制約**・files/scripts/permissions/risk・target/diff が視認でき、high-risk が色以外（label/icon）でも識別できること。
- Catalog stale/offline 時の警告と理由コード。
- 各画面スクリーンショットを証跡化。

> **既知阻害要因**（#1242 レポート §3 と共通）: UI の install 導線は #1441/#1431 で接続済みだが、初見 UX 調査は #1248 の状況も踏まえる。CLI install は `--version` 必須（#1237）。

### S6. 初見利用者 plan 到達性

- 支援なしで「2 Issue の plan（dry-run）まで到達」できるかを観察し、到達可否・障害点・所要時間を記録（複数名なら 80% 以上を目安）。

---

## 3. Go / No-Go 判定（#1458 受入条件）

- [ ] Claude Code・Codex の記録 version で 3 Skill を発見・呼出できる（S1）
- [ ] 2 Issue/2 並列 run が Wave barrier と verification evidence を守り、PR作成・CI確認・merge・UAT修正ループまで完了（S2）
- [ ] 現行 `/orchestrate` 相当のハーネスエンジニアリングを公式 Skill のみで完遂（S2、人による受け入れ基準）
- [ ] prompt・worker failure・verification failure で安全に停止（S3）
- [ ] Auto Yes off・high-risk ack・cleanup zero-delete（S4）
- [ ] UAT report から Go/No-Go、未検証 Agent、既知制約、Phase 5 follow-up を判断できる

---

## 4. #1242 人手UAT との関係

#1458 は #1242（Phase 1 MVP release gate）に依存する。#1242 の **自動検証（2a）は Go・マージ済み**（114 test、install E2E 機構）だが、**人手検証（2b）は保留**である。重複を避けるため:

- #1242 §3-1（初見導入 UX）・§3-2（mobile/desktop UAT）・§3-3（実 Agent discovery）は、本 UAT の S5/S6/S1 と**同時に実施**して1回の観察で両 Issue の証跡を取ると効率的。
- #1242 の総合判定「保留」は本 UAT 完了により前進しうるが、**MVP 出荷可否（#1242）と Harness Pack release（#1458）は別判定**として report に分けて記録する。
