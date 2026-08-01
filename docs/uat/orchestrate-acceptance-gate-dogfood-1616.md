# UAT 二層裁定の実機 dogfood 証跡（#1616）

- **対象**: 公式 Skill `cmate-orchestrate` v0.8.0 の UAT runner（`scripts/uat.mjs`）
- **対応 Issue**: [Kewton/CommandMate#1616](https://github.com/Kewton/CommandMate/issues/1616)（Epic [#1585](https://github.com/Kewton/CommandMate/issues/1585)）
- **実施日**: 2026-08-01
- **実施者**: claude（`claude-opus-5[1m]`、non-interactive）
- **対象 commit**: `bf5821d`（実施時点の HEAD。working tree に本 Issue の未 commit 変更あり）
- **このドキュメントの位置づけ**: 受入条件「実 Issue 1 件で acceptance result を生成し合成裁定まで通した証跡」に対する
  実測記録である。**到達した範囲と未達の範囲を分けて書く。**

> **未達を先に書く。** 実 CommandMate worker の dispatch・監督（send/wait/commit 検出）は
> **実施していない**。外部リポジトリへの mutation を伴う操作を承認なしに行わないためである。
> したがって dispatch report は手書きの hand-off であり、この dogfood は
> 「**plan 生成 → 意味ゲート生成 → 二層裁定**」までの証跡である。§4 に未達の一覧がある。

---

## 1. 何を実データで通したか

| 層 | 実データか | 内容 |
|---|---|---|
| Issue 取得 | **実データ** | live の `gh issue view 1616 --repo Kewton/CommandMate`（read-only）。planner が title を取得 |
| plan 生成 | **実 runner** | `orchestrate.mjs 1616 --profile-json <profile> --allow-unverified` が exit 0 で plan を生成 |
| dispatch report | **手書き** | 実 worker を dispatch していないため hand-off を手書き。`dispatch-report.v1` に適合することは検証済み |
| 機械ゲート（baseline） | **実行した** | この repository で `validate.py` / `selftest.py` / fixture suite を実際に実行（worktree = `.`） |
| 意味ゲート（acceptance） | **実データ** | #1616 の受入条件 6 件を実測し `acceptance-result.v1` document を生成（`conditional_go`） |
| 合成裁定 | **実 runner** | `uat.mjs --write-uat --acceptance-dir` が両ゲートを合成 |

dogfood に使った profile（この repository を worktree に指し、baseline を本物の gate にしたもの）:

```json
{
  "id": "commandmate-skills-dogfood-1616",
  "repository": "Kewton/CommandMate",
  "base": "main",
  "branch_template": "feature/{number}-uat-acceptance-integration",
  "worktree_template": ".",
  "baseline": [
    "python3 scripts/validate.py",
    "python3 scripts/selftest.py",
    "node tests/fixtures/cmate-orchestrate/run_tests.mjs"
  ],
  "verified": false
}
```

`verified: false` なので `--allow-unverified` を付けている（未検証 profile を verified と偽らない）。

## 2. 意味ゲートの入力（実測した受入判定）

`<acceptance-dir>/issue-1616.json` として置いた `acceptance-result.v1` document の要約である。
document は `skills/cmate-acceptance-test/schemas/acceptance-result.v1.json` に**適合することを検証済み**。

| criterion | outcome | 根拠 |
|---|---|---|
| AC-01 `validate.py` exit 0 | `pass` | 実行し exit 0（10 package + catalog） |
| AC-02 per-issue の baseline / acceptance / 合成 verdict を記録（additive schema） | `pass` | fixture が per-issue で突き合わせ。追加は optional field・enum 値追加・`maxItems` 緩和のみ |
| AC-03 5 分岐が決定的、`conditional_go`・`no_go` が success に丸まらない | `pass` | u10〜u17 が green。丸め込みへの変異注入 8 件がすべて赤 |
| AC-04 `--acceptance-dir` 無しの従来挙動が不変 | `pass` | 既存 u01〜u09 の期待値を 1 つも変えずに green |
| **AC-05 実機 dogfood** | **`manual_pending`** | **worker dispatch 層が未到達（§4）。pass にしない** |
| AC-06 README / SKILL.md 更新、catalog 直接編集なし | `pass` | 更新済み。`catalog/` の変更は 0 件 |

→ **verdict `conditional_go`**（status `partial`）。5 件 pass・1 件未解決なので `go` にしない。

## 3. 合成裁定の結果（実行結果）

```
$ node skills/cmate-orchestrate/scripts/uat.mjs \
    --plan <runs>/dogfood-1616/plan.json \
    --dispatch <dogfood>/dispatch-report.json \
    --write-uat --acceptance-dir <dogfood>/acceptance --out <dogfood>/uat-out
exit 7
```

| 項目 | 値 |
|---|---|
| `status` / `stop_reason` | `partial` / `acceptance_conditional` |
| per-issue `verdict` / `verdict_source` | `conditional` / `acceptance_conditional_go` |
| `baseline.outcome` | `pass`（3 command すべて exit 0） |
| `acceptance.state` / `acceptance.verdict` | `loaded` / `conditional_go` |
| `conditional_issues` / `unresolved_issues` | `[1616]` / `[]` |
| legacy `outcome`（v1 reader が読む値） | `fail`（**`pass` に丸めていない**） |
| `completion_check.passed` | `true`（`acceptance_not_rounded` を含む 6 件すべて true） |

**この dogfood が証明していること**: baseline（機械ゲート）が全 green でも、受入条件が未解決なら
`success` にならない。`conditional_go` は `pass` にも「不合格」にも丸められず、
`conditional_issues` として human 判断に回り、条件が report に残る。exit code は 7（partial）である。

## 4. 未達（この dogfood で到達していない範囲）

- [ ] **実 CommandMate worker の dispatch・監督**（`commandmate send` / `wait` / commit 検出）。
      外部 mutation を伴うため未承認・未実施。dispatch report は手書きの hand-off である。
- [ ] **fix loop の実機実行**（`--create-uat-fix-worktrees --approve`）。fix worktree 作成・再merge は
      実リポジトリを変更するため未実施。fixture（u17）でのみ検証している。
- [ ] **cmate-acceptance-test の Skill としての実行**。受入判定は同 Skill の手順に沿って実測したが、
      別 Agent としての invocation は行っていない（同一 Agent が手順を辿った）。
- [ ] **Issue へのコメント・登録**。GitHub への書き込みは一切していない（read-only の `gh issue view` のみ）。

この 4 点は、実 CommandMate 環境を持つ maintainer が §1 の手順をなぞれば到達できる。
到達するまで AC-05 は `manual_pending` のままであり、**pass に繰り上げない**。

## 5. 再現手順

1. この repository を checkout し、`docs/uat/` の本ファイルの §1 の profile を JSON として置く。
2. `node skills/cmate-orchestrate/scripts/orchestrate.mjs 1616 --profile-json <profile> --allow-unverified --runs-dir <runs> --run-id dogfood-1616`
3. `cmate-acceptance-test` の手順で #1616 の受入判定を行い、`<acceptance-dir>/issue-1616.json` に置く。
4. `dispatch-report.v1` に適合する hand-off を用意する（または実 dispatch を行う）。
5. `node skills/cmate-orchestrate/scripts/uat.mjs --plan <plan> --dispatch <dispatch> --write-uat --acceptance-dir <acceptance-dir> --out <out>`

working tree が dirty な状態で実施した場合、その run はそのままでは再現できない（document の
`target.dirty` に記録する）。
