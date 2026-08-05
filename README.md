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

> **状態**: release pipeline と公式 Skill 11 件が揃っている。
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
docs/quickstart-vibe-engineering.md # 導入から契約付きタスク 1 本までの導線
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

- **はじめて使う / 1 本通してみる**:
  [docs/quickstart-vibe-engineering.md](./docs/quickstart-vibe-engineering.md)
  （セットアップ → Skill install → 検証ゲート起案 → 契約付きタスク 1 本 → メトリクス）
- Skill を追加する: [CONTRIBUTING.md](./CONTRIBUTING.md)
- release する / 失敗から戻す: [docs/runbooks/release.md](./docs/runbooks/release.md)
- 配布物を独立に検証する: [docs/runbooks/verify-artifact.md](./docs/runbooks/verify-artifact.md)
- release 後にクリーン環境で導入を実測する: [docs/runbooks/verify-install.md](./docs/runbooks/verify-install.md)
- Agent 対応状況: [docs/agent-support-matrix.md](./docs/agent-support-matrix.md)
- pipeline の設計判断: [docs/design/release-pipeline.md](./docs/design/release-pipeline.md)

## CommandMate CLI の導入形態

この repository の Skill は本文でもスクリプトでも CommandMate CLI を呼ぶ。**どちらの導入形態でも
動くが、前提はグローバル導入である。** npx 単独運用（`npx commandmate@latest`）も正式にサポート
するが、そのままでは遅く、追加の設定が要る。

| 形態 | 裸の `commandmate` が PATH に居るか | 1 呼び出しの起動コスト | 追加設定 |
|---|---|---|---|
| グローバル導入（`npm i -g commandmate`） | 居る | ほぼ 0 | 不要 |
| npx 運用（ラッパあり）**← 推奨** | 居る（ラッパとして） | ほぼ 0 | ラッパ 1 本 |
| npx 運用（ラッパなし） | **居ない** | **0.5〜0.9 秒**（報告者実測） | `CM` の設定 |

npx は `node_modules/.bin` を**実行中の子プロセスの PATH にしか足さない**。worker 側（CommandMate が
起こす tmux セッション）はサーバプロセスの PATH を継承するので裸名が引けるが、**オーケストレーター側**
（利用者自身のエージェントセッション・ターミナル・cron）では引けない。

### 推奨手順: 薄いラッパを置く

orchestrate の監視は `capture` / `wait` / `verify` を高頻度で叩くため、1 呼び出しあたり 0.5〜0.9 秒の
npx 起動コストがそのままポーリング周期に乗る。**npx 運用ならラッパを置くことを公式に推奨する。**

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/commandmate <<'EOF'
#!/usr/bin/env bash
exec npx --yes commandmate@latest "$@"
EOF
chmod +x ~/.local/bin/commandmate
# PATH に無ければ通す（お使いの shell の rc に）
export PATH="$HOME/.local/bin:$PATH"

commandmate --version   # ラッパ経由で引けることを確認する
```

`--yes` はラッパ側に置く。非対話（cron・エージェントセッション）で npx が install 確認を
求めて失敗するのを防ぐためである。`@latest` の pin は外さないこと — 外すと npx cache が
掴んでいる古い版が黙って走る（`cmate-orchestrate-monitor` の `verify-scope.sh` はこれを違反として数える）。

### ラッパを置かない場合: `CM`

ラッパ無しで回すなら、ランチャーを `CM` 環境変数で渡す。`cmate-orchestrate-monitor` の
`monitor.sh` / `hooks-task.sh`、`cmate-orchestrate` の `dispatch.mjs` / `uat.mjs`、
`cmate-verify-advisor` の `verify-advisor.mjs` が**同じ規約**で読む。

```bash
export CM="npx commandmate@latest"
```

- 解決順は `--cli <launcher>` → `$CM` → 既定（`monitor.sh` 系は `npx commandmate@latest`、
  Node runner 系は `commandmate`）。
- ランチャーは**スペース区切りで argv に分割**される。`npx commandmate@latest` のような複数
  トークンを受理する。
- **シェルは経由しない。** パイプ・リダイレクト・変数展開・引用符を含む値は、黙って誤動作する
  代わりに助言つきエラーで拒否される。それが要るならラッパスクリプトにして、そのパスを渡す。

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
| `cmate-verify-advisor` | 検証履歴から verify.yaml の改善案を出す（強化は適用可・弱体化は提案止まり。Node script 同梱） | moderate |

version と risk は `skills/<skill-id>/commandmate.skill.yaml` の `version` /
`declared_risk` が正本である（Catalog は「入手可能なもの」を示す）。high risk の
package（**`cmate-worktree-cleanup` / `cmate-orchestrate` / `cmate-orchestrate-monitor` /
`cmate-verify` の 4 件**）は install に `--yes` と `--ack-risk <skill-id>@<version>` の
完全一致が要る。

**11 package すべてが Catalog に publish 済みである**
（[CommandMate#1592](https://github.com/Kewton/CommandMate/issues/1592) で一括公開）。
どれも `commandmate skill install` で入るので、手で配置する必要はない。

install は `.agents/skills/<id>` と `.claude/skills/<id>` の**両方**へ byte-identical に書く。
**この両置きは load-bearing である** — 2026-08-02 の実測では、`.claude/skills/<id>` だけを
消すと Claude Code の palette から消え、`.agents/skills/<id>` だけを消すと Codex の
skill picker から消えた（両方向の対照実験）。

publish 前の package を試すなど、どうしても手で置く必要がある場合の手順と注意
（receipt が付かないため `skill status` / `skill uninstall` の対象外になる）は
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
