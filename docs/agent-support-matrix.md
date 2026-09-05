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

この表は 2026-07-26 時点の記録である。**OpenCode と Command Code は
2026-09-04 に実測した**（第 3.4 節）ので、現在の宣言は第 4 節を見ること。

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

### 3.3 publish 後の追試（2026-08-02、CommandMate#1592）

第 3.2 節が残した宿題 —「手動両置きで測った 2 件」「未 publish で測れなかった 2 件」
「repo 側だけ先行していた 2 件」— を、**6 package を Catalog へ publish したうえで
catalog install 経由で測り直した**。

| 項目 | 値 |
|---|---|
| CommandMate | **0.17.0**（npm 公開版を専用 prefix へ install） |
| Claude Code | 2.1.220 |
| Codex CLI | 0.145.0（0.146.0 への update prompt は caret を "Skip" へ動かしてから確定） |
| OS | macOS（Darwin 25.5.0） |
| 隔離 | 専用 HOME（real home 配下）・専用 DB・専用ポート 31592・使い捨て git repo（測定後に破棄） |
| 対象 | publish した 6 package。**1 件で代表させていない** |

| 項目 | 結果 |
|---|---|
| `skill list` | **11 package**（全件 `compatible`）。`SKILL_NOT_FOUND` はゼロ |
| install | 6 package すべて exit 0（**catalog 経由**） |
| 配置 | 6 件とも両 root へ `diff -r` 差分なし |
| receipt | 6 件とも `install_roots` に両 root |
| manifest digest 照合 | 6 package 計 **74 file、mismatch 0** |
| high risk gate | **`cmate-verify` 0.1.1** で `--yes` のみ → **exit 12**・書き込みなし |
| 同梱 script smoke | `verify-completion.sh` → `COMPLETE`（exit 0） |

| Agent | 発見 | slash 呼出 | 証跡の性質 |
|---|---|---|---|
| Claude Code 2.1.220 | **YES（6/6・`(project)` scope）** | **YES（6/6）** | 機械的 |
| Codex CLI 0.145.0 | **YES（6/6）** | **NO**（対照 `/mo` → `/model` は match） | **機械的**（下記） |

**両 root 配置が load-bearing であることを、catalog install 経由で両方向から確定した:**

| 操作 | Agent | 結果 |
|---|---|---|
| `.claude/skills/cmate-task-contract` だけ退避 | Claude Code | palette から**消えた**。`cmate-verify-advisor` は残る |
| `.agents/skills/cmate-task-contract` だけ退避 | Codex CLI | skill picker から**消えた**。他 5 件は残る |

退避したものは戻し、`diff -r` で byte-identical を再確認した。

#### Codex の発見は self-report ではなく機械的証跡だった（第 5 節の訂正）

Codex 0.145.0 は起動時に `Use /skills to list available skills` を出し、
**`/skills` → List skills（あるいは `@`）で開く picker に、install した skill が
`Skill` ラベルで列挙される**（`Plugin` と区別されている）。6 package すべてが出た。

したがって「0.145.0 に skill 一覧を機械的に吐かせる口が無い」は**誤り**である。
slash command として露出しない点は変わらない（`/cmate-` はマッチしない）。

**公開済み package の manifest はこの誤りを含んだまま immutable になっている**
（`compatibility.agents[].measured.discovery.evidenceKind = self_report`）。
訂正には version bump と再 publish が要るため、ここでは記録に留める。

### 3.4 opencode / Command Code（2026-09-04）

第 3 節から第 3.3 節までは Claude Code と Codex CLI しか測っておらず、`opencode` は
全 package で `unknown` のままだった。`command-code` に至っては、upstream の
`CLI_TOOL_IDS`（[CommandMate#2250](https://github.com/Kewton/CommandMate/issues/2250)）に
入っているのにこの repository の mirror が追いついておらず、宣言しようとすると
`validate.py` が `INVALID_ENUM` で撥ねる状態だった。2026-09-04 に**両方の discovery 経路を
機械的に測った**（mirror も同じ commit で追いつかせている）。

一次記録: [CommandMate#2322](https://github.com/Kewton/CommandMate/issues/2322)（Command Code）、
[CommandMate#2037](https://github.com/Kewton/CommandMate/issues/2037) と
`docs/design/opencode-server-live-verification.md` 第 12.4–12.5 節（opencode 1.18.22）。

| 項目 | 値 |
|---|---|
| opencode | **1.18.27**（discovery の再確認。invocation は 1.18.22 の #2037 実測） |
| Command Code | **1.47.0**（npm `command-code`、bin `cmd`） |
| 前提 | `skill install` が `.agents/skills/<id>/` と `.claude/skills/<id>/` の両方へ byte-identical に置く（第 2 節） |
| 測定に使った Skill | probe（`/probe-agents-root` ほか）と実 package 3 件 |

#### opencode 1.18.27

隔離 `HOME` に `opencode serve --pure` を立て、`GET /skill` の応答を読む。
**model 呼び出しを伴わない**ので、発見の証跡は絶対 path つきの機械的な列挙である。

| root | 発見 |
|---|---|
| `<project>/.agents/skills/` | **YES**（絶対 path つき） |
| `<project>/.claude/skills/` | **YES** |
| `<project>/.opencode/skills/` | **YES** |
| 実 package `cmate-repository-analysis`（両 root に配置） | **YES**。同名は 1 件に畳まれ、`location` は `.agents/skills` |

invocation は 1.18.22 で測ってある（[#2037](https://github.com/Kewton/CommandMate/issues/2037)）:
`/probe-agents-root` を送信すると SKILL.md 本文が読み込まれ、agent が
`PROBE_OK_probe-agents-root` を返す。

- **reload**: 起動時スキャンである。**install 後は再起動が要る。**
- **opencode 自身の slash palette には Skill が出ない**（`/skills` picker が `/<name>` を挿入する）。

#### Command Code 1.47.0

`cmd skills list -d`（**model 呼び出しなし**）、TUI の `/skills` picker、
headless `cmd -p "/<name>" --output-format json` の NDJSON を読む。

| root | 発見 |
|---|---|
| `<project>/.agents/skills/`（**primary install root**） | **YES**（`[.agents]` バッジ付き） |
| `<project>/.claude/skills/` | **NO — 読まない**（陰性対照は下記） |
| `<project>/.commandcode/skills/` | **YES** |
| `~/.agents/skills/` ・ `~/.commandcode/skills/` | bundle の走査対象（`dist/cli.mjs`） |
| 実 package `cmate-repository-analysis` / `cmate-verify`（`allowed-tools` frontmatter あり） / `cmate-orchestrate`（SKILL.md 59,914 bytes） | **YES（3/3）**、skip なし |

invocation: `/probe-agents-root` → NDJSON に
`{"type":"event","event":{"type":"skill_loaded","name":"probe-agents-root"}}` が出て、
`finalText` が `PROBE_OK_probe-agents-root` になる。`/<name>` は slash route で Skill に
解決され（予約語と衝突する場合は `/skill:<name>`）、model 側からは `activate_skill` tool でも
起動できる。

- **reload**: **再起動不要**。TUI 稼働中に足した Skill が `/skills` の開き直しで出た。

#### 陰性対照

| 対照 | 結果 |
|---|---|
| `.claude/skills` に**だけ**置いた probe を Command Code から呼ぶ（`/probe-claude-root`） | 「I don't see a skill named…」・`skill_loaded` **0 件** |

⇒ Command Code の `native` は **`.agents/skills` への配置**（installer の primary root）に
だけ依存する。第 2 節の両 root install のうち `.claude/skills` 側は Command Code には
効いておらず、**installer の `.agents/skills` 側だけで足りている**。
第 3.2 / 3.3 節が Claude と Codex に対してやったのと同じ形の対照であり、
「両方に置いたら両方から見えた」で止めていない。

#### evidence の性質

| Agent | 発見の証跡 | 呼出の証跡 |
|---|---|---|
| opencode 1.18.27 | **機械的**（`GET /skill` が返す絶対 path） | 1.18.22 で `/<name>` 送信 → 本文が読まれる（#2037） |
| Command Code 1.47.0 | **機械的**（`cmd skills list -d` の列挙・`/skills` picker） | **機械的**（NDJSON の `skill_loaded` event） |

どちらも model の自己申告ではない。**測ったのは discovery 経路だけである**（第 1 節）。
cmate-* の各手順を opencode / Command Code で最後まで回した rubric 評価は含まない。

## 4. package 別の宣言

| Skill | 宣言 version | claude | codex | gemini | opencode | command-code | claude / codex 実測 | opencode / command-code 実測 |
|---|---|---|---|---|---|---|---|---|
| `cmate-acceptance-test` | 0.1.4 | native | native | unknown | native | native | 0.1.1・2026-07-31 | 2026-09-04（経路） |
| `cmate-issue-authoring` | 0.9.1 | native | native | unknown | native | native | 0.1.0・**2026-08-02** | 2026-09-04（経路） |
| `cmate-issue-refinement` | 0.4.1 | native | native | unknown | native | native | 0.1.1・2026-07-31 | 2026-09-04（経路） |
| `cmate-orchestrate` | 0.32.1 | native | native | unknown | native | native | 0.9.0・**2026-08-02** | **2026-09-04（Command Code は 0.32.0 を実 package で実測）** |
| `cmate-orchestrate-monitor` | 0.7.1 | native | native | unknown | native | native | 0.4.0・**2026-08-02** | 2026-09-04（経路） |
| `cmate-repository-analysis` | 0.2.1 | native | native | unknown | native | native | 0.1.1・2026-07-31 | **2026-09-04（両者とも 0.2.0 を実 package で実測）** |
| `cmate-task-contract` | 0.2.3 | native | native | unknown | native | native | 0.1.0・**2026-08-02** | 2026-09-04（経路） |
| `cmate-verify` | 0.5.1 | native | native | unknown | native | native | 0.1.1・**2026-08-02** | **2026-09-04（Command Code は 0.5.0 を実 package で実測）** |
| `cmate-verify-advisor` | 0.3.1 | native | native | unknown | native | native | 0.1.0・**2026-08-02** | 2026-09-04（経路） |
| `cmate-worker-development` | 0.2.1 | native | native | unknown | native | native | 未（経路からの敷衍） | 2026-09-04（経路） |
| `cmate-worktree-cleanup` | 0.1.6 | native | native | unknown | native | native | 0.1.2・2026-07-31 | 2026-09-04（経路） |
| `cmate-worktree-setup` | 0.1.6 | native | native | unknown | native | native | 0.1.2・2026-07-31 | 2026-09-04（経路） |

「宣言 version」は本 commit 時点で各 package の `commandmate.skill.yaml` が名乗っている
version である。**evidence の文面を直すだけでも bump が要る**（公開済み version は immutable）
ので、実測に使った version とは普通ずれる。ずれた分は右 2 列に書いてある。

`claude` / `codex` 列は第 3.2 節（2026-07-31）と第 3.3 節（2026-08-02）で
**package ごとに**測った結果である（それ以前は第 3 節の 1 package の測定を
install 経路の共通性から全件に敷衍していた）。両節で重なる 4 件は新しい方で上書きしてある。
`cmate-worker-development` は両節より後に足した package なので、claude / codex は
まだ package 単位で測っていない（経路からの敷衍である）。

`opencode` / `command-code` 列は第 3.4 節（2026-09-04）の測定である。
**この 2 つは package 単位に全件を測ってはいない。** 測ったのは（a）root ごとの
discovery 経路と（b）実 package（opencode は `cmate-repository-analysis`、
Command Code はそれに `cmate-verify` と `cmate-orchestrate` を加えた 3 件）で、
残りは「install 先が package に依存しない」（第 2 節）ことからの敷衍である。
第 3 節が Claude / Codex に対して最初に採った立場と同じであり、
package 単位の追試は第 3.2 節がそうしたように別に行う。

`gemini` / `copilot` / `vibe-local` / `antigravity` は依然としてどの package でも測っていない。

## 5. 既知の制約

- **Codex 0.145.0 の発見は機械的証跡である**（2026-08-02 に訂正）。
  `/skills` → List skills（あるいは `@`）で開く picker が、install した skill を
  `Skill` ラベルで列挙する（`Plugin` と区別されている）。
  以前ここには「self-report であり 0.145.0 に skill 一覧を機械的に吐かせる口が無い」と
  書いてあったが、**それは誤りだった**。ただし
  **公開済み package の manifest はこの誤りを含んだまま immutable になっている**
  （`measured.discovery.evidenceKind = self_report`）。訂正には version bump と
  再 publish が要る。
- **Codex 0.145.0 は skill を slash command として露出しない。**
  **0.146.0 は未計測**（第 3.2 / 3.3 節とも update prompt を Skip して 0.145.0 のまま測った）。
- **high risk package は `cmate-worktree-cleanup` / `cmate-orchestrate` /
  `cmate-orchestrate-monitor` / `cmate-verify` の 4 件**である（`declared_risk` の正本は
  各 package の `commandmate.skill.yaml`）。install には `--yes` に加えて
  `--ack-risk <skill-id>@<version>` の完全一致が必要。ゲートの拒否（exit 12）は
  2026-07-29 に publish 済み 3 件で、2026-07-31 に `cmate-worktree-cleanup` 0.1.2 で、
  2026-08-02 に **`cmate-verify` 0.1.1** で実測した（4 件すべて実測済み）。
- **Command Code 1.47.0 は `.claude/skills` を読まない。** 読むのは primary install root
  （`.agents/skills`）と `.commandcode/skills`、および `~/.agents/skills` /
  `~/.commandcode/skills` である。`.claude/skills` にだけ置いた probe は
  「I don't see a skill named…」で終わり `skill_loaded` が 1 件も出ない（第 3.4 節の陰性対照）。
  したがって `command-code: native` は installer の `.agents/skills` 側の配置にだけ依存する
  —— `claude: native` が `.claude/skills` 側に依存しているのとちょうど対になっている。
- **opencode 1.18.27 は自身の slash palette に Skill を出さない。**
  `/skills` picker が `/<name>` を composer へ挿入する形であり、送信すれば Skill は読まれる
  （invocation は 1.18.22 で実測。第 3.4 節）。Codex 0.145.0 と同じく「palette に出ない」は
  配置先の問題ではない。
- **reload の要否は Agent ごとに違う。** opencode は起動時スキャンなので
  **install 後に再起動が要る**。Command Code は **再起動不要**で、TUI 稼働中に足した Skill が
  `/skills` の開き直しで出る。Claude / Codex は新しい session の開始が要る（下記）。
- **Gemini / vibe-local / copilot / antigravity は未計測。**
  opencode と Command Code は第 3.4 節（2026-09-04）で実測したので、ここから外した。
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
