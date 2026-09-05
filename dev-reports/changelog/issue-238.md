# issue-238 — opencode / Command Code の discovery 実測を宣言に反映

対象: [Kewton/commandmate-skills#238](https://github.com/Kewton/commandmate-skills/issues/238)

このリポジトリに `CHANGELOG.md` は無い（package ごとの
`skills/<id>/references/release-notes.md` が事実上の changelog にあたるが、
本 Issue の実行契約は `skills/*/commandmate.skill.yaml` しか触れないため
そちらへの追記は行っていない）。変更内容をここに残す。

## Added

- `scripts/cmate_skills/constants.py`: `CLI_TOOL_IDS` に `command-code` を追加。
  upstream（`src/lib/cli-tools/types.ts`、[CommandMate#2250](https://github.com/Kewton/CommandMate/issues/2250)）
  には入っていたのにこの mirror が追いついておらず、`agent: command-code` を宣言した
  manifest が `INVALID_ENUM` で撥ねられていた mirror drift の解消。
- 全 12 package の `compatibility.agents` に `command-code: native` を evidence 付きで追加。
- `docs/agent-support-matrix.md` 第 3.4 節「opencode / Command Code（2026-09-04）」。
  root ごとの discovery 表、evidence の性質（`GET /skill` の絶対 path・`cmd skills list -d` の
  列挙・NDJSON の `skill_loaded` event ＝ いずれも機械的）、陰性対照、reload 挙動。
- `docs/runbooks/verify-install.md` 第 5 節に opencode と Command Code の実測手順。
  どちらも model 呼び出し不要の経路（`opencode serve --pure` + `GET /skill` /
  `cmd skills list -d`）を先に置き、Command Code は `.claude/skills` だけに置いた
  probe を陰性対照として要求する。

## Changed

- 全 12 package の `opencode` を `unknown` → `native`（evidence 差し替え）。
- 全 12 package の `version` を patch bump（公開済み version は immutable）:

  | package | version |
  |---|---|
  | `cmate-acceptance-test` | 0.1.3 → 0.1.4 |
  | `cmate-issue-authoring` | 0.9.0 → 0.9.1 |
  | `cmate-issue-refinement` | 0.4.0 → 0.4.1 |
  | `cmate-orchestrate` | 0.32.0 → 0.32.1 |
  | `cmate-orchestrate-monitor` | 0.7.0 → 0.7.1 |
  | `cmate-repository-analysis` | 0.2.0 → 0.2.1 |
  | `cmate-task-contract` | 0.2.2 → 0.2.3 |
  | `cmate-verify` | 0.5.0 → 0.5.1 |
  | `cmate-verify-advisor` | 0.3.0 → 0.3.1 |
  | `cmate-worker-development` | 0.2.0 → 0.2.1 |
  | `cmate-worktree-cleanup` | 0.1.5 → 0.1.6 |
  | `cmate-worktree-setup` | 0.1.5 → 0.1.6 |

- `skills/cmate-orchestrate/scripts/lib.mjs` の `SKILL_VERSION` を `0.32.1` へ、
  manifest の `scripts/lib.mjs` の `sha256` を追随させた。
  `scripts/validate.py` の `check_version_constant` がこの一致を要求するため、
  この package だけ manifest 以外の payload を触る必要があった（実行契約の
  `scope.allow` を 1 file 超過している。ユーザー確認済み）。
- `tests/fixtures/cmate-orchestrate/**` の golden 11 件の `skill_version` を
  `0.32.0` → `0.32.1`（`cases/` 9 件・`dispatch-cases/d87`・`merge-cases/m22`）。
- `docs/agent-support-matrix.md` 第 4 節の表: `command-code` 列を追加、`opencode` を
  `native` へ、`cmate-worker-development` の行を追加、version 列を「宣言 version」に
  改めて実測 version / 日付を右 2 列へ分離。
- `docs/agent-support-matrix.md` 第 5 節: Command Code が `.claude/skills` を読まないこと、
  opencode が自身の palette に Skill を出さないこと、reload の要否が Agent ごとに違うことを追加。
  「未計測」の列挙から opencode を外した（gemini / copilot / vibe-local / antigravity は据え置き）。

## Not changed（意図的）

- `catalog/**` — release 生成物。本 Issue では触らない。
- `tests/fixtures/cmate-orchestrate/status-cases/**` の `skill_version`
  （`0.13.0` / `0.17.0`）— これは status runner に食わせる**入力の run 成果物**で、
  「古い版が書いた artifact」を再現するためのもの。golden ではないので据え置き。
- `tests/fixtures/cmate-issue-authoring/cases/valid-*.json`（`0.1.0` / `0.7.0`）と
  `tests/fixtures/cmate-repository-analysis/samples/*.json`（`0.1.0` / `0.2.0`）—
  どちらも validator / grader に食わせる**入力**で、runner が生成する golden ではない。
  bump 前から manifest version と一致しておらず、更新しなくても両 suite は緑
  （`issue-authoring-fixtures` 96 passed / `repository-analysis-fixtures` 11 samples PASSED）。
- 各 package の `references/release-notes.md` — 実行契約の scope 外。
- 実際の release（tag push・maintainer 承認）— スコープ外。

## 検証

| gate | 結果 |
|---|---|
| `python3 scripts/validate.py` | exit 0（12 package すべて OK・reproducible、catalog 12 entries / 77 versions） |
| `python3 scripts/validate.py --skills-root tests/fixtures/skills` | exit 0 |
| `python3 scripts/selftest.py` | exit 0（51 tests OK。`test_unknown_agent_is_refused` を含む） |
| `find skills tests -name '*.sh' -print0 \| xargs -0 -n1 bash -n` | exit 0 |
| `node tests/fixtures/cmate-orchestrate/run_tests.mjs` | exit 0 |
| `bash tests/fixtures/cmate-issue-authoring/run_tests.sh` | exit 0 |
| `python3 tests/fixtures/cmate-repository-analysis/check_result.py --selftest` | exit 0 |
| `bash tests/fixtures/cmate-verify-advisor/run_tests.sh` | exit 0 |

evidence の長さ（`SKILL_EVIDENCE_MAX_LENGTH = 300`）: opencode 275 / command-code 258。
12 package 全件を safe YAML parser で読み直して実測した。
