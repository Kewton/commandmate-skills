# commandmate-skills

CommandMate 公式 Agent Skills の配布リポジトリ。

CommandMate は本リポジトリを **唯一の公式 Skill 供給元** として扱い、
immutable commit SHA と artifact SHA-256 を検証したうえで、
登録済み worktree の `.agents/skills/<skill-id>/` へ配備する。

- 親 Epic: [Kewton/CommandMate#1227](https://github.com/Kewton/CommandMate/issues/1227)
- 本リポジトリの release pipeline: [Kewton/CommandMate#1238](https://github.com/Kewton/CommandMate/issues/1238)

> **状態**: 骨組みのみ。manifest schema・catalog schema・release pipeline は
> [#1228](https://github.com/Kewton/CommandMate/issues/1228) の契約確定後に実装する。
> 確定前に schema を先取りして書かないこと。

## ディレクトリ構成

```
skills/<skill-id>/
  SKILL.md                  # Agent Skills 標準の authoring artifact
  commandmate.skill.yaml    # CommandMate 固有の配布・runtime metadata
catalog/v1/
  catalog.json              # CommandMate が取得する Catalog（生成物）
scripts/                    # reproducible release pipeline (#1238)
docs/design/                # 本リポジトリ側の設計メモ
```

`SKILL.md` は Agent が読む標準 artifact、`commandmate.skill.yaml` は
CommandMate の配布・互換性・risk 宣言であり、責務を混在させない。

## 公式 Skill（Phase 1 MVP）

| Skill ID | 内容 | Issue |
|---|---|---|
| `cmate-repository-analysis` | リポジトリ構造・規約の分析手順 | [#1239](https://github.com/Kewton/CommandMate/issues/1239) |
| `cmate-issue-refinement` | Issue 精緻化の標準手順 | [#1240](https://github.com/Kewton/CommandMate/issues/1240) |
| `cmate-acceptance-test` | 受入テストの標準手順 | [#1241](https://github.com/Kewton/CommandMate/issues/1241) |

`cmate-parallel-issue-development` は high-risk な Runtime 依存のため Phase 5
（[#1258](https://github.com/Kewton/CommandMate/issues/1258)〜[#1261](https://github.com/Kewton/CommandMate/issues/1261)）で扱う。

## 配布の前提

- artifact は tar.gz（PAX 拡張不使用）、archive root は skill-id 1 ディレクトリ。
- 必須 entry は `SKILL.md` と `commandmate.skill.yaml`。
- artifact 全体の SHA-256 は Catalog 側に置き、manifest へ自己参照させない。
- symlink / hardlink / device / FIFO / setuid・setgid・sticky を含めない。
- CommandMate は install / download だけでは Skill 内の script を実行しない。
  `declared_permissions` は宣言であって sandbox enforcement ではない。

## 公開設定

現在 **private**。Catalog と release asset は CommandMate から credential なしで
取得される設計のため、公式 release の時点で public へ切り替える。

## License

MIT（[LICENSE](./LICENSE)）。個々の Skill の license は各 `commandmate.skill.yaml` の
`license` を正本とする。
