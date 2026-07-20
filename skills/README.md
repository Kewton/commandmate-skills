# skills/

公式 Skill package の置き場。`skills/<skill-id>/` の 1 directory が 1 package で、
directory 名がそのまま `<skill-id>` になる。

```
skills/<skill-id>/
  SKILL.md                  # Agent が読む標準 artifact（frontmatter の name = <skill-id>）
  commandmate.skill.yaml    # 配布・互換性・risk 宣言（id = <skill-id>）
  references/...            # 補助資料（manifest の files: で宣言する）
```

## 現在の状態

| Skill ID | 状態 | Issue |
|---|---|---|
| `cmate-repository-analysis` | placeholder | [#1239](https://github.com/Kewton/CommandMate/issues/1239) |
| `cmate-issue-refinement` | placeholder | [#1240](https://github.com/Kewton/CommandMate/issues/1240) |
| `cmate-acceptance-test` | placeholder | [#1241](https://github.com/Kewton/CommandMate/issues/1241) |

`.gitkeep` だけの directory は「まだ書かれていない Skill の予約枠」として
`scripts/validate.py` の検査対象から外れる。中身を書いた時点で自動的に検査対象になる。

## 追加するには

`tests/fixtures/skills/pipeline-selftest/` を雛形として copy する。
手順は [CONTRIBUTING.md](../CONTRIBUTING.md) を参照。

3つの Skill は独立に追加できる。互いの package にも
`catalog/` にも触れないので、並行に PR を出して衝突しない。
