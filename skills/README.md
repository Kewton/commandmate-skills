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

| Skill ID | risk | 内容 |
|---|---|---|
| `cmate-acceptance-test` | moderate | 受入テストの標準手順 |
| `cmate-delegate` | moderate | 隣のセッションへ一言頼んで返答を回収する手順（bash ラッパ同梱） |
| `cmate-issue-authoring` | moderate | Feature 記述から Issue 群を起案し、承認後に一括登録する手順 |
| `cmate-issue-refinement` | moderate | Issue 精緻化の標準手順 |
| `cmate-orchestrate` | high | 複数 Issue の計画・dispatch・PR/merge・UAT（Node runner 同梱） |
| `cmate-orchestrate-monitor` | high | 並列 worker 監視の判定コア（bash script 同梱） |
| `cmate-repository-analysis` | low | リポジトリ構造・規約の分析手順 |
| `cmate-task-contract` | moderate | Issue から実行契約 `.commandmate/tasks/<name>.yaml` を起案する手順 |
| `cmate-verify` | high | 検証ゲートの起案と実 exit code 判定（bash script 同梱） |
| `cmate-verify-advisor` | moderate | 検証履歴から verify.yaml の改善案を出す（強化は適用可・弱体化は提案止まり。Node script 同梱） |
| `cmate-worker-development` | moderate | Issue や実行契約を受け取ったワーカーの作業方法（読取・調査・計画・実装・検証・証拠の6段） |
| `cmate-workspace-research` | moderate | 複数の Agent に Web と Workspace を独立に調査させ、相互反証と追加検証を経て Evidence 付きの `final.md` 1 本にまとめる手順 |
| `cmate-worktree-cleanup` | high | worktree の安全な後始末 |
| `cmate-worktree-setup` | moderate | 専用 worktree の作成と baseline 取得 |

**上の 14 package すべてが Catalog に publish 済み**であり、`commandmate skill install`
で入る（[CommandMate#1592](https://github.com/Kewton/CommandMate/issues/1592) で一括公開したものと、その後に足したもの）。

この表は目次であって正本ではない。**version は載せない**（package ごとに上がるので、ここに書くと必ずずれる）。
version と risk は各 `commandmate.skill.yaml` の `version` / `declared_risk` を読むこと。Agent 対応状況は
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
