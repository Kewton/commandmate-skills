# skills/

公式 Skill package の置き場。`skills/<skill-id>/` の 1 directory が 1 package で、
directory 名がそのまま `<skill-id>` になる。

```
skills/<skill-id>/
  SKILL.md                  # Agent が読む標準 artifact（frontmatter の name = <skill-id>）
  commandmate.skill.yaml    # 配布・互換性・risk 宣言（id = <skill-id>）
  references/...            # 補助資料（manifest の files: で宣言する）
  schemas/...  scripts/...  # 任意。宣言した file だけが package に入る
```

## 現在の package

| Skill ID | version | risk | 内容 |
|---|---|---|---|
| `cmate-acceptance-test` | 0.1.1 | moderate | 受入テストの標準手順 |
| `cmate-issue-authoring` | 0.1.0 | moderate | Feature 記述から Issue 群を起案（計画 validator 同梱） |
| `cmate-issue-refinement` | 0.1.1 | moderate | Issue 精緻化の標準手順 |
| `cmate-orchestrate` | 0.9.0 | high | 計画・実行契約 dispatch・PR/merge・UAT 二層裁定（Node runner 同梱） |
| `cmate-orchestrate-monitor` | 0.4.0 | high | 並列 worker 監視の判定コア（bash script 同梱） |
| `cmate-repository-analysis` | 0.1.1 | low | リポジトリ構造・規約の分析手順 |
| `cmate-task-contract` | 0.1.0 | moderate | Issue から実行契約 yaml を起案する手順 |
| `cmate-verify` | 0.1.1 | high | 検証ゲートの起案と実 exit code 判定（bash script 同梱） |
| `cmate-verify-advisor` | 0.1.0 | moderate | 検証履歴から verify.yaml の改善案を出す（Node script 同梱） |
| `cmate-worktree-cleanup` | 0.1.2 | high | worktree の安全な後始末 |
| `cmate-worktree-setup` | 0.1.2 | moderate | 専用 worktree の作成と baseline 取得 |

`cmate-issue-authoring` と `cmate-task-contract` と `cmate-verify` と
`cmate-verify-advisor` は **まだ Catalog に publish されていない**
（[CommandMate#1592](https://github.com/Kewton/CommandMate/issues/1592) で一括公開予定）。

この表は目次であって正本ではない。version と risk は各
`commandmate.skill.yaml` を読むこと。Agent 対応状況は
[docs/agent-support-matrix.md](../docs/agent-support-matrix.md) にまとめてある。

`.gitkeep` だけの directory は「まだ書かれていない Skill の予約枠」として
`scripts/validate.py` の検査対象から外れる。中身を書いた時点で自動的に検査対象になる。

## 追加するには

`tests/fixtures/skills/pipeline-selftest/` を雛形として copy する。
手順は [CONTRIBUTING.md](../CONTRIBUTING.md) を参照。

各 Skill は独立に追加できる。互いの package にも
`catalog/` にも触れないので、並行に PR を出して衝突しない。

## 変更するとき

公開済み version は immutable である。**payload だけでなく manifest を変えた場合も
`version` を上げる**（artifact には manifest が入るので digest が変わる）。
`files:` は `python3 scripts/manifest_files.py skills/<skill-id>` で生成し直す。
