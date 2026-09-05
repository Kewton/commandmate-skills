# issue-238 — module reference

該当なし（このリポジトリに `module-reference.md` 相当のドキュメントは無い）。

参考までに、本 Issue が触れた module と役割の対応:

| path | 役割 | 本 Issue での変更 |
|---|---|---|
| `scripts/cmate_skills/constants.py` | CommandMate 側 `src/lib/skills/constants.ts` / `src/lib/cli-tools/types.ts` の mirror。ここが upstream と食い違うと、CI は緑なのに利用者の machine で install が拒否される | `CLI_TOOL_IDS` に `command-code` を追加 |
| `scripts/cmate_skills/schema.py` | manifest の schema 検査（`_read_agent_compat` が `CLI_TOOL_IDS` を enum として使う） | 変更なし（constants 側の追加だけで `agent: command-code` が通る） |
| `scripts/validate.py` | package 全件の検査。`check_version_constant` が `scripts/lib.mjs` の `SKILL_VERSION` と manifest `version` の一致を要求する | 変更なし（この制約に従って lib.mjs を bump した） |
| `skills/*/commandmate.skill.yaml` | 各 package の宣言の正本。`compatibility.agents` が agent 対応の正本で、`docs/agent-support-matrix.md` はその要約 | 12 件すべて更新（opencode / command-code / version） |
| `skills/cmate-orchestrate/scripts/lib.mjs` | 4 runner 共通の library。`SKILL_VERSION` は各 report の `skill_version` に刻まれる | `0.32.0` → `0.32.1` |
| `tests/fixtures/cmate-orchestrate/**` | planner / dispatch / merge / uat の golden。byte 一致で照合される | golden 11 件の `skill_version` を追随 |
| `docs/agent-support-matrix.md` | `support` の意味（= discovery 経路）と、その宣言が何の測定に基づくかの記録 | 第 3.4 / 4 / 5 節 |
| `docs/runbooks/verify-install.md` | 実測手順。matrix を更新する人が従う | 第 5 節に opencode / Command Code |
