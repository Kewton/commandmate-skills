# commandmate-skills

CommandMate 公式 Agent Skills の配布リポジトリ。

CommandMate は本リポジトリを **唯一の公式 Skill 供給元** として扱い、
immutable commit SHA と artifact SHA-256 を検証したうえで、登録済み worktree の
`.agents/skills/<skill-id>/` と `.claude/skills/<skill-id>/` の**両方へ byte-identical に**
配備する（CommandMate 0.15.0 以降。Claude は後者を、Codex は前者を読む）。

**この両置きは飾りではない。** 2026-07-31 に片側だけ消す対照実験で、
Claude Code 2.1.220 は `.claude/skills` しか、Codex CLI 0.145.0 は `.agents/skills` しか
読まないことを確認している（[matrix 第 3.2 節](./docs/agent-support-matrix.md)）。
片側配置に戻せば、どちらかの Agent から必ず不可視になる。

- 親 Epic: [Kewton/CommandMate#1227](https://github.com/Kewton/CommandMate/issues/1227)
- 本リポジトリの release pipeline: [Kewton/CommandMate#1238](https://github.com/Kewton/CommandMate/issues/1238)

> **状態**: release pipeline と公式 Skill 10 件が揃っている。
> どの Agent でどこまで確認済みかは
> [docs/agent-support-matrix.md](./docs/agent-support-matrix.md) を参照。

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
tests/fixtures/<skill-id>/  # 各 Skill の評価・回帰テスト（package には含まれない）
docs/agent-support-matrix.md # どの Agent でどこまで実測したか
docs/design/                # 設計（pipeline / 契約 mirror の同期手順）
docs/runbooks/              # release・rollback・artifact 検証・導入検証の手順書
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
- release 後にクリーン環境で導入を実測する: [docs/runbooks/verify-install.md](./docs/runbooks/verify-install.md)
- Agent 対応状況: [docs/agent-support-matrix.md](./docs/agent-support-matrix.md)
- pipeline の設計判断: [docs/design/release-pipeline.md](./docs/design/release-pipeline.md)

## 公式 Skill

| Skill ID | 内容 | risk |
|---|---|---|
| `cmate-repository-analysis` | リポジトリ構造・規約の分析手順 | low |
| `cmate-issue-authoring` | Feature 記述から Issue 群を起案し、承認後に一括登録する手順 | moderate |
| `cmate-issue-refinement` | Issue 精緻化の標準手順 | moderate |
| `cmate-task-contract` | Issue から実行契約 `.commandmate/tasks/<name>.yaml` を起案する手順 | moderate |
| `cmate-acceptance-test` | 受入テストの標準手順 | moderate |
| `cmate-worktree-setup` | 専用 worktree の作成と baseline 取得 | moderate |
| `cmate-worktree-cleanup` | worktree の安全な後始末 | **high** |
| `cmate-orchestrate` | 複数 Issue の計画・dispatch・PR/merge・UAT（Node runner 同梱） | **high** |
| `cmate-orchestrate-monitor` | 並列 worker 監視の判定コア（bash script 同梱） | **high** |
| `cmate-verify` | 検証ゲートの起案と実 exit code 判定（bash script 同梱） | **high** |

version と risk は `skills/<skill-id>/commandmate.skill.yaml` の `version` /
`declared_risk` が正本である（Catalog は「入手可能なもの」を示す）。high risk の
package（**`cmate-worktree-cleanup` / `cmate-orchestrate` / `cmate-orchestrate-monitor` /
`cmate-verify` の 4 件**）は install に `--yes` と `--ack-risk <skill-id>@<version>` の
完全一致が要る。

`cmate-issue-authoring` と `cmate-task-contract` と `cmate-verify` は
**まだ Catalog に publish されていない**
（[CommandMate#1592](https://github.com/Kewton/CommandMate/issues/1592) で一括公開予定）。
それまでは `commandmate skill install` の経路が無いので、使いたい場合は両 root へ手で置く。
**片側だけに置くと、Claude か Codex のどちらかから必ず不可視になる。**

```bash
cd <worktree>
for ROOT in .agents/skills .claude/skills; do
  mkdir -p "$ROOT"; rm -rf "$ROOT/<skill-id>"
  cp -R <commandmate-skills>/skills/<skill-id> "$ROOT/<skill-id>"
done
diff -r .agents/skills/<skill-id> .claude/skills/<skill-id> && echo "byte-identical"
```

手動配置には install receipt が付かないため、CommandMate からは未 install に見える
（`skill status` / `skill uninstall` の対象外）。手順の詳細と注意は
[docs/runbooks/verify-install.md](./docs/runbooks/verify-install.md) 第 3.1 節にある。

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
