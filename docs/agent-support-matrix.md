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

この非対称は 2026-07-31 に**両方向の対照実験で機械的に確認した**（第 3.2 節）。
`commandmate` 0.16.0 でも両 root 配置は同じである。

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
測定に使った package は 1 件（`cmate-repository-analysis` 0.1.0・low risk・script 無し）だが、
**publish 後に当時の 7 package 全件で追試済み**（第 3.1 節）であり、
**2026-07-31 には 9 package 全件を package 単位で測り直した**（第 3.2 節）。

### 3.1 Catalog publish 後の追試（2026-07-29）

第 3 節は**手動配置**した payload での測定である。Catalog へ publish したあと、
**catalog 経由で install した状態**で同じ隔離環境（npm 公開版 `commandmate@0.15.0`・
専用 HOME / 専用 DB / 専用ポート・skills 未導入の新規 git リポジトリ）を組んで追試した。

| 項目 | 結果 |
|---|---|
| `skill list` | 7 package すべて表示（`compatible`） |
| install | **7 package すべて成功** |
| 配置 | 全件 `.agents/skills/<id>` と `.claude/skills/<id>` へ `diff -r` 差分なし |
| receipt | 全件 `install_roots` に両 root を記録 |
| manifest digest 照合 | mismatch なし |
| Claude Code 2.1.220 の palette | **7 件すべて完全一致（機械的証跡）** |
| Codex CLI 0.145.0 の palette | 非露出（対照 `/mo` → `/model` は match ＝ palette 機構は正常） |
| Codex の SKILL.md 絶対 path 自己申告 | 正答（self-report） |

**high risk の承認ゲートもここで初めて実測した。**

| 試行 | 結果 |
|---|---|
| `--yes` のみ | **exit 12 で拒否**・ファイル書き込みなし |
| `--ack-risk <id>@<誤った version>` | 拒否（完全一致を要求） |
| `--ack-risk <id>@<正しい version>` | install 成功 |

`skill plan` が書き込みを行わないことも確認した（実行後に `.agents` / `.claude` が生成されない）。

evidence:
<https://github.com/Kewton/CommandMate/issues/1513#issuecomment-5116598691>

なお、この追試中に CommandMate 側の不具合を 1 件検出している
（uninstall 後の再 install が idempotency replay で握り潰され、exit 0 のまま
ファイルが書かれない → [CommandMate#1552](https://github.com/Kewton/CommandMate/issues/1552)）。
**初回 install には影響しない**が、drift 修復のための入れ直しは現状 no-op になる。

### 3.2 全 package 実測監査（2026-07-31）

第 3 節・第 3.1 節は「install 先は package に依存しない」という前提に寄りかかっており、
Agent からの発見を **package 単位**で測ってはいなかった。
[CommandMate#1590](https://github.com/Kewton/CommandMate/issues/1590) で、
**9 package 全件 × {Claude Code, Codex}** を測り直した。宣言は見ずに測ってから突き合わせている。

| 項目 | 値 |
|---|---|
| CommandMate | **0.16.0**（npm 公開版を専用 prefix へ install） |
| Claude Code | 2.1.220 |
| Codex CLI | 0.145.0（起動時の 0.146.0 への update prompt は "Skip" を明示選択） |
| OS / Node | macOS 26.5.2 (25F84) / v24.1.0 |
| 隔離 | 専用 HOME・専用 DB・専用ポート 39590・skills 未導入の新規 git worktree（測定後に破棄） |

| 項目 | 結果 |
|---|---|
| `skill list` | 7 package（`compatible`）。未 publish の 2 件は `skill info` が exit 2 `SKILL_NOT_FOUND` |
| install | catalog 経由の 7 package すべて exit 0 |
| 配置 | 7 件とも `.agents/skills/<id>` と `.claude/skills/<id>` へ `diff -r` 差分なし |
| receipt | 7 件とも `.commandmate-receipt.json` と DB の `install_roots` に両 root |
| manifest digest 照合 | 7 package 計 62 file、mismatch なし |
| high risk gate | `cmate-worktree-cleanup` 0.1.2 で `--yes` のみ → **exit 12**・ファイル書き込みなし |
| 未 publish の 2 件 | 手動で両 root へ cp → `diff -r` 差分なし・digest mismatch なし |
| 同梱 script smoke | `verify-completion.sh` → `COMPLETE`（exit 0） |

| Agent | 発見 | slash 呼出 | 証跡の性質 |
|---|---|---|---|
| Claude Code 2.1.220 | **YES（9/9）** | **YES（9/9・`(project)` scope）** | 機械的 |
| Codex CLI 0.145.0 | **YES（9/9）** | **NO**（対照 `/mo` → `/model` は match） | self-report |

Claude 側は user scope からの混入を排除してある（`~/.claude/skills` と `~/.claude/commands` が
存在しないことを確認済み）。

**両 root 配置が必要であることの対照実験**（第 2 節の前提を、既知事実として信じずに潰した）:

| 操作 | 結果 |
|---|---|
| `.claude/skills/<id>` だけ削除（`.agents` 側は残す）→ 新規 Claude session | その skill が palette から消える。他は match |
| `.agents/skills/<id>` だけ削除（`.claude` 側は残す）→ 新規 Codex session | その skill だけ列挙から消えて 8 件 |

⇒ **Claude は `.claude/skills` のみ、Codex は `.agents/skills` のみ**を読む。
`claude: native` は両 root 配置の上にだけ成り立つ。

**宣言との突合**: 9 package の `claude: native` / `codex: native` は実測と一致し、
`gemini` / `opencode` は今回も未計測なので `unknown` のままである（**drift 0 件**）。
manifest の `evidence` 文面は 2026-07-26 の測定を引いたままにしてある。
文面だけの更新にも `version` bump が要る（公開済み version は immutable）ため、
各 package の次回 bump で反映する。とくに `cmate-verify` の
"this package was not separately measured" は本節で解消済みだが、**過小申告であって事実誤りではない**。

evidence:
<https://github.com/Kewton/CommandMate/issues/1590#issuecomment-5140433442>

### Codex の slash 非露出について

配置先の問題ではない。対照実験で `/mo` → `/model` はマッチし、`~/.codex/skills` 配下の
既存 skill もマッチしないことを確認しており、**当該 CLI version の制約**である
（2026-07-26 / 2026-07-29 / 2026-07-31 の 3 回とも同じ）。
Codex では skill 名を自然文で指示するか、同梱 script を直接実行する。

## 4. package 別の宣言

| Skill | version | claude | codex | gemini | opencode | 実測日（package 単位） | 経路 |
|---|---|---|---|---|---|---|---|
| `cmate-acceptance-test` | 0.1.1 | native | native | unknown | unknown | 2026-07-31 | catalog install |
| `cmate-issue-authoring` | 0.1.0 | native | native | unknown | unknown | **未実測** | 未 publish |
| `cmate-issue-refinement` | 0.1.1 | native | native | unknown | unknown | 2026-07-31 | catalog install |
| `cmate-orchestrate` | 0.9.0 | native | native | unknown | unknown | 2026-07-31（**0.7.1 で実測**） | catalog install |
| `cmate-orchestrate-monitor` | 0.4.0 | native | native | unknown | unknown | 2026-07-31（**0.1.0 で実測**） | catalog install |
| `cmate-repository-analysis` | 0.1.1 | native | native | unknown | unknown | 2026-07-31 | catalog install |
| `cmate-task-contract` | 0.1.0 | native | native | unknown | unknown | 2026-07-31 | **手動両置き** |
| `cmate-verify` | 0.1.1 | native | native | unknown | unknown | 2026-07-31（**0.1.0 で実測**） | **手動両置き** |
| `cmate-worktree-cleanup` | 0.1.2 | native | native | unknown | unknown | 2026-07-31 | catalog install |
| `cmate-worktree-setup` | 0.1.2 | native | native | unknown | unknown | 2026-07-31 | catalog install |

`claude` / `codex` 列は第 3.2 節で **package ごとに**測った結果である
（それ以前は第 3 節の 1 package の測定を install 経路の共通性から全件に敷衍していた）。
`gemini` / `opencode` は依然としてどの package でも測っていない。

**`cmate-issue-authoring` 0.1.0 は第 3.2 節の実測（9 package）に含まれていない。**
2026-08-01 に追加した package であり、`claude` / `codex` の `native` は第 3.2 節が示した
「install 先が package に依存しない」ことからの敷衍である。install 経路も payload の
配置規則も他 package と同じなので同じ結果になる見込みだが、**見込みは実測ではない。**
publish 後に [verify-install.md](./runbooks/verify-install.md) の手順で追試が要る。

`cmate-task-contract` 0.1.0 と `cmate-verify` 0.1.1 は **まだ Catalog に publish されていない**
（[CommandMate#1592](https://github.com/Kewton/CommandMate/issues/1592) で一括公開する）。
`skill info` は exit 2 `SKILL_NOT_FOUND` を返す。第 3.2 節ではこの 2 件だけ
[verify-install.md](./runbooks/verify-install.md) の**手動両置き手順**で配置して測った。
**publish 後に catalog 経由での追試が要る。**

`cmate-orchestrate-monitor` は [CommandMate#1589](https://github.com/Kewton/CommandMate/issues/1589)
で 0.2.0 へ、[CommandMate#1602](https://github.com/Kewton/CommandMate/issues/1602) で 0.3.0 へ、
[CommandMate#1614](https://github.com/Kewton/CommandMate/issues/1614) で 0.4.0 へ
bump したが、**第 3.2 節の実測は publish 済みの 0.1.0 に対するものである**
（0.2.0 / 0.3.0 / 0.4.0 はいずれも Catalog 未公開で、これも #1592 で公開する）。version 列は manifest の
正本に合わせて 0.4.0 にし、`claude` / `codex` 列と実測日は 0.1.0 の測定値を据え置いてある。
install 経路も payload の配置規則も変えていないため結果は同じになる見込みだが、
**見込みは実測ではない。publish 後に 0.4.0 で追試が要る。**

## 5. 既知の制約

- **Codex の発見は self-report**（model が SKILL.md の絶対 path を答えた）であり、
  機械的証跡ではない。0.145.0 に skill 一覧を機械的に吐かせる口が無い。
  第 3.2 節の対照実験で「`.agents/skills` を読んでいる」ことまでは機械的に示せたが、
  「発見した」こと自体の証跡は self-report のままである。
- **Codex 0.145.0 は skill を slash command として露出しない。**
  **0.146.0 は未計測**（第 3.2 節では update prompt を Skip して 0.145.0 のまま測った）。
- **high risk package は `cmate-worktree-cleanup` / `cmate-orchestrate` /
  `cmate-orchestrate-monitor` / `cmate-verify` の 4 件**である（`declared_risk` の正本は
  各 package の `commandmate.skill.yaml`）。install には `--yes` に加えて
  `--ack-risk <skill-id>@<version>` の完全一致が必要。ゲートの拒否（exit 12）は
  2026-07-29 に publish 済み 3 件で、2026-07-31 に `cmate-worktree-cleanup` 0.1.2 で実測した。
  **`cmate-verify` の承認ゲートは未 publish のため未実測**である。
- **Gemini / OpenCode / vibe-local / copilot / antigravity は未計測。**
- **CommandMate の config dir（`$HOME/.commandmate`）を `/tmp` や `/var` 配下に置くと
  install できない。** snapshot store が system directory を拒否するため、
  `SKILL_SNAPSHOT_STORE_IO`・exit 1 で失敗する（macOS の `mktemp -d` は `/var/folders/…`）。
  worktree 側は `/tmp` 配下でも install できる。隔離環境の組み方は
  [verify-install.md](./runbooks/verify-install.md) 第 0 節を見ること。
- Claude / Codex とも、更新の反映には **新しい session の開始**が要る。
  実効 version は install 済み `commandmate.skill.yaml` の `version` で確認する
  （Catalog は「入手可能なもの」を示すだけである）。

## 6. 更新するとき

1. [docs/runbooks/verify-install.md](./runbooks/verify-install.md) の手順で実測する。
2. 該当 package の manifest を更新し、**`version` を必ず上げる**（公開済み version は immutable）。
3. この matrix を同じ commit で更新する。
4. `python3 scripts/validate.py` の**終了コードを実測**する。
