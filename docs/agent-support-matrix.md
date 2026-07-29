# Agent 対応 matrix

対象読者: 公式 Skill を導入する人。

各 package の `commandmate.skill.yaml` の `compatibility.agents` が正本であり、
ここはその要約と、**その宣言が何の測定に基づいているか**である。

原則: **未計測の Agent は `unknown`。** `unknown` は「動かない」ではなく「確認していない」。
推測で `native` と書かない（それが
[Kewton/CommandMate#1513](https://github.com/Kewton/CommandMate/issues/1513) の是正対象だった）。

---

## 1. `support` が意味すること

`support` は **discovery 経路**、すなわち「Agent が install 先の `SKILL.md` に
自力で辿り着けるか」を表す。

| 値 | 意味 |
|---|---|
| `native` | Agent 自身が install 先の `SKILL.md` を discovery できる |
| `commandmate_runtime` | CommandMate の Runtime 経由で手順を渡す必要がある |
| `unsupported` | 経路が無い |
| `unknown` | 測っていない |

`support` は **品質の宣言ではない**。その Agent で手順を回した rubric 評価は別物で、
各 package の `tests/fixtures/<skill-id>/` と `references/agent-compatibility.md` に属する。

## 2. install 先（前提）

CommandMate 0.15.0 以降、`commandmate skill install` は package を

- `.agents/skills/<skill-id>/`
- `.claude/skills/<skill-id>/`

の **両方へ byte-identical に配置**する（[#1460](https://github.com/Kewton/CommandMate/issues/1460)。
install receipt の `install_roots` に両 root が記録される）。

**Claude は `.claude/skills` を読み、`.agents/skills` は読まない。**
Codex は `.agents/skills` を読む。したがって「`.agents/skills` からの標準 discovery で
Claude が native」という説明は誤りであり、正しくは「両 root へ配置されるから成立している」である。

## 3. 実測（2026-07-26）

skills 未導入の新規 git リポジトリ・専用ポート・専用 DB の隔離環境で実測した。

| 項目 | 値 |
|---|---|
| CommandMate | 0.15.0（npm 公開版と同一） |
| Claude Code | 2.1.220 |
| Codex CLI | 0.145.0 |
| OS / Node | macOS 26.5.2 / v24.1.0 |
| 測定に使った Skill | `cmate-repository-analysis` 0.1.0 |

| Agent | 発見 | slash 呼出 | 証跡の性質 |
|---|---|---|---|
| Claude Code 2.1.220 | **YES**（`.claude/skills` から） | **YES**（palette に完全一致・`(project)` scope） | 機械的 |
| Codex CLI 0.145.0 | **YES**（`.agents/skills` から） | **NO** | 発見は model の自己申告 |
| Gemini | 未計測 | 未計測 | — |
| OpenCode | 未計測 | 未計測 | — |
| vibe-local / copilot / antigravity | 未計測 | 未計測 | — |

evidence:
<https://github.com/Kewton/CommandMate/issues/1513#issuecomment-5083878264>

install 先は package に依存しないので、この測定は全 package の discovery 経路に効く。
ただし **測定に使った package は 1 件（low risk・script 無し）**である。

### Codex の slash 非露出について

配置先の問題ではない。対照実験で `/mo` → `/model` はマッチし、`~/.codex/skills` 配下の
既存 skill もマッチしないことを確認しており、**当該 CLI version の制約**である。
Codex では skill 名を自然文で指示するか、同梱 script を直接実行する。

## 4. package 別の宣言

| Skill | version | claude | codex | gemini | opencode |
|---|---|---|---|---|---|
| `cmate-acceptance-test` | 0.1.1 | native | native | unknown | unknown |
| `cmate-issue-refinement` | 0.1.1 | native | native | unknown | unknown |
| `cmate-orchestrate` | 0.7.1 | native | native | unknown | unknown |
| `cmate-orchestrate-monitor` | 0.1.0 | native | native | unknown | unknown |
| `cmate-repository-analysis` | 0.1.1 | native | native | unknown | unknown |
| `cmate-worktree-cleanup` | 0.1.2 | native | native | unknown | unknown |
| `cmate-worktree-setup` | 0.1.2 | native | native | unknown | unknown |

すべて第3節の同一測定に基づく。package ごとに別の測定があるわけではない。

## 5. 既知の制約

- **Codex の発見は self-report**（model が SKILL.md の絶対 path を答えた）であり、
  機械的証跡ではない。
- **Codex 0.145.0 は skill を slash command として露出しない。**
- **high risk package（`cmate-orchestrate` / `cmate-orchestrate-monitor`）は
  クリーン環境での install 実測をまだ行っていない。** install には `--yes` に加えて
  `--ack-risk <skill-id>@<version>` の完全一致が必要である。
- **Gemini / OpenCode / vibe-local / copilot / antigravity は未計測。**
- Claude / Codex とも、更新の反映には **新しい session の開始**が要る。
  実効 version は install 済み `commandmate.skill.yaml` の `version` で確認する
  （Catalog は「入手可能なもの」を示すだけである）。

## 6. 更新するとき

1. [docs/runbooks/verify-install.md](./runbooks/verify-install.md) の手順で実測する。
2. 該当 package の manifest を更新し、**`version` を必ず上げる**（公開済み version は immutable）。
3. この matrix を同じ commit で更新する。
4. `python3 scripts/validate.py` の**終了コードを実測**する。
