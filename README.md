# commandmate-skills

CommandMate 公式 Agent Skills の配布リポジトリ。

CommandMate は本リポジトリを **唯一の公式 Skill 供給元** として扱い、
immutable commit SHA と artifact SHA-256 を検証したうえで、
登録済み worktree の `.agents/skills/<skill-id>/` へ配備する。

- 親 Epic: [Kewton/CommandMate#1227](https://github.com/Kewton/CommandMate/issues/1227)
- 本リポジトリの release pipeline: [Kewton/CommandMate#1238](https://github.com/Kewton/CommandMate/issues/1238)

> **状態**: release pipeline と公式 Skill 3 件
> （`cmate-repository-analysis` / `cmate-issue-refinement` / `cmate-acceptance-test`）が揃っている。

## ディレクトリ構成

```
skills/<skill-id>/
  SKILL.md                  # Agent Skills 標準の authoring artifact
  commandmate.skill.yaml    # CommandMate 固有の配布・runtime metadata
catalog/v1/
  catalog.json              # CommandMate が取得する Catalog（release workflow の生成物）
scripts/                    # reproducible release pipeline (#1238)
  cmate_skills/             # CommandMate 側配布契約の mirror（正本は CommandMate）
tests/fixtures/skills/
  pipeline-selftest/        # pipeline を通す最小の package。新規 Skill の雛形
docs/design/                # 設計（pipeline / 契約 mirror の同期手順）
docs/runbooks/              # release・rollback・artifact 検証の手順書
```

`SKILL.md` は Agent が読む標準 artifact、`commandmate.skill.yaml` は
CommandMate の配布・互換性・risk 宣言であり、責務を混在させない。

## 使い方

pipeline は **Python 標準ライブラリのみ**で動く。依存の install は不要である
（外部 registry が公式 artifact の中身を左右できないようにするための制約）。

```bash
python3 scripts/validate.py                    # 全 package と Catalog を検証
python3 scripts/selftest.py                    # pipeline 自体のテスト
python3 scripts/manifest_files.py <skill-dir>  # manifest の files: を生成
python3 scripts/verify_artifact.py --help      # 公開 artifact の keyless 検証
```

- Skill を追加する: [CONTRIBUTING.md](./CONTRIBUTING.md)
- release する / 失敗から戻す: [docs/runbooks/release.md](./docs/runbooks/release.md)
- 配布物を独立に検証する: [docs/runbooks/verify-artifact.md](./docs/runbooks/verify-artifact.md)
- pipeline の設計判断: [docs/design/release-pipeline.md](./docs/design/release-pipeline.md)

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
- asset 名は `<skill-id>-<version>.tar.gz`、Content-Type は `application/gzip`。
- 必須 entry は `SKILL.md` と `commandmate.skill.yaml`。
- artifact 全体の SHA-256 は Catalog 側に置き、manifest へ自己参照させない。
- Catalog は tag ではなく **40桁の resolved commit SHA** を記録する。
- symlink / hardlink / device / FIFO / setuid・setgid・sticky を含めない。
- CommandMate は install / download だけでは Skill 内の script を実行しない。
  `declared_permissions` は宣言であって sandbox enforcement ではない。

## 信頼の根拠（署名はない）

署名鍵の代わりに、**再現可能 build と公開 checksum の連鎖**を使う。

```
Catalog source.commit（40桁 resolved SHA）
  → その commit から build すると誰でも同じ byte 列になる
  → Catalog artifact.sha256 と一致する
  → その中の commandmate.skill.yaml の files[] が payload と完全一致する
  → 各 payload file の sha256 と一致する
```

第三者がこの連鎖全体を検証する手順は
[docs/runbooks/verify-artifact.md](./docs/runbooks/verify-artifact.md) にある。
限界（配布経路自体の完全性は GitHub に依存する）については
[SECURITY.md](./SECURITY.md) を参照。

## 公開設定

**public**。Catalog と release asset は CommandMate から credential なしで取得される。

## License

MIT（[LICENSE](./LICENSE)）。個々の Skill の license は各 `commandmate.skill.yaml` の
`license` を正本とする。
