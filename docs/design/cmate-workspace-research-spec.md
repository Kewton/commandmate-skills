# cmate-workspace-research 設計（Issue #245）

> この文書は [Issue #245](https://github.com/Kewton/commandmate-skills/issues/245) の本文を repo に移したものである。
>
> - **第 I 部** — Issue 本文（目的・背景・確定仕様 A〜I・パッケージ構成・受入・対象外）。
> - **第 II 部** — 起票時点の仕様書 v2 全文（`cmate-workspace-research-spec-v2.md`）。
> - **第 III 部** — 実装で決めたこと（Issue に書かれていない細部）。
>
> **第 I 部の「確定仕様」は第 II 部に対する差分であり、食い違う箇所は確定仕様を優先する。**
> 実装の正本は `skills/cmate-workspace-research/SKILL.md` と同 `references/` であり、
> この文書は「なぜそうなっているか」を辿るためのものである。

---

# 第 I 部 — Issue #245 本文

## 目的と照合基準

`cmate-workspace-research` を公式 Skill として追加する。ユーザーが `agents` と `request` だけを指定すると、指定した複数の Agent セッションが **Web と Workspace を独立に調査 → 重要 Finding を相互反証 → 結論を左右する claim を追加検証 → Evidence 付きで 1 本の `final.md`** に統合する。元は `multi-agent-evolution-rules-v7.md`（110KB の汎用「意見進化」プロトコル）を親に読ませ `cmate-delegate` で回していた運用を、技術調査に絞った MVP として package 化する。

- 照合基準: Kewton/commandmate-skills `develop` `f95dcc2`、CommandMate **v0.33.3**（`ask` / `whoami` / `peers` / `instances --json` = CommandMate#2376、relay = #2377）
- 仕様書 v2 の全文は本 Issue 末尾に添付（起票時点の正本。実装 PR で `docs/design/cmate-workspace-research-spec.md` として repo に入れる）
- 本 Issue の「確定仕様」は仕様書 v2 に対する**差分**である。差分の無い項目は仕様書どおり

## 背景 — 元運用との関係

| 元運用（v7 rules ＋ cmate-delegate） | 本 Skill（MVP） |
|---|---|
| 親の責務 37 項目、Anti-Pattern 30 種、Q0–Q4 の定量 claim 型、Goal Lock、run 間 continuity、coverage matrix | 6 phase（FRAME → INDEPENDENT → CROSS CHECK → TARGETED VERIFY → EVIDENCE MERGE → SYNTHESIZE）、Evidence 3 分類（WEB / WORKSPACE / DERIVED）、Finding state 5 種 |
| 汎用の意見・ランキング | Web と Workspace を突き合わせる技術調査（migration / upgrade / incident / architecture / security / OSS） |
| 親が 110KB の規則を毎回読む | `references/evidence-rules.md`（2〜3KB）に規律だけを抜く |

v7 から残すのは次だけ: Goal invariance（4.1）、Independence before interaction（4.2）、Evidence over consensus（4.6 / 4.15）、Source independence（5.6: 同一 URL の重複は独立 evidence ではない）、Evidence-to-Assertion（5.8 の軽量版: Finding state が final の文言の強さを決める）、Anti-pattern 5 つ（20.4 同一ソース合意 / 20.6 共有盲点 / 20.9 多数決 / 20.16 検証済みだが不完全 / 20.17 stale unknown）。Q-level・Goal Lock・continuity・coverage matrix・`cmate-evolution-validator` は仕様書 §42 どおり後続。

## 確定仕様（仕様書 v2 との差分。実機で測った CommandMate の挙動に合わせる）

### A. 子の権限を preflight で確かめ、足りなければ開始前に 1 回だけ人へ返す（§4 / §10 / §18）

実測（2026-09-08/09）: read-only コマンド（`git status --porcelain` / `git log` / `git show`）でも Antigravity・Codex（sandbox、prefix ごと）・Claude（`permissions.allow` 無し）は権限ダイアログを出し、**`ask` / `wait` は相手の Auto-Yes が ON でも prompt 検出で先に exit 10 を返す**（CommandMate#2463）。cmate-delegate §5 / §6 は「親は答えない・相手の auto-yes を触らない」。

- preflight で各子の `instances --json` の `cliTool` / `running` / `autoYes` を表に出し、**コマンド実行を伴う Workspace 調査には子側の権限が要る**ことを、tool 別の整え方（Claude: `.claude/settings.local.json` の `permissions.allow` に `Bash(git log:*)` 等 / Codex: `--sandbox read-only` 起動と prefix 承認 / Antigravity: Auto-Yes）と一緒に示す
- 人は「整えてから続行」「コマンド無し（ファイル読取のみ）で続行」のどちらかを選ぶ。**親は auto-yes を触らず、respond も打たない**（cmate-delegate の規律をそのまま）
- 調査中に exit 10 が返ったら、cmate-delegate §5 どおり prompt を人へ写して**その子だけ停止**。他の子の調査は続け、§37.1 の coverage 降格で final に残す
- CommandMate#2463 が入った版では猶予窓で自動承認が先に走るので、この節の手間が減る。Skill は版で分岐せず、exit 10 の扱いを上のとおり固定する

### B. Web 能力は Agent 依存なので、役割は capability 報告の後に割り当てる（§14 / §37.2）

Codex は sandbox が network を既定で遮断し、gemini / copilot / antigravity の Web 到達は support matrix に未計測。External-first を機械的に割り当てると Web の無い子に Web 役が当たる。

- 子への送信文の先頭に「最初に公式 doc を 1 件 fetch し、`WEB: available | unavailable` を報告してから調査に入る」を必須にする
- 親は報告後に role を確定する（`FRAME → CAPABILITY PROBE → ROLE → INDEPENDENT`）。全員 `unavailable` なら §37.2 の「Workspace evidence only」で coverage を下げて続行、全員が Workspace も読めなければ FAILED

### C. 子は chat で返答し、run-dir に書くのは親だけ（§13 / §18 / §28）

仕様書 §28 の `agents/<agent>.md` を子が書くと、§18 の read-only と §13 の独立性（共有 dir を他の子が読める）に反する。

- **子の成果物は chat の返答**。親は `ask --json` の `source: history` で本文全文を回収する（転写リーダーのある claude / codex / command-code / antigravity で実測 5,050 字 + `DONE:` 行）
- `source: pane` の tool（転写リーダー無し。pane 末尾 80 行しか読めない）だけ、送信文で「本文を `<run-dir>/agents/<self>.md` に書け」と例外を明示し、`run.json` にその旨を残す
- run-dir は **`.commandmate/workspace-research/<run-id>/`**（仕様書の `.cmate/` は CommandMate の慣習と違う）。`.commandmate/` が gitignore されていない workspace では preflight で警告する（CommandMate 管理 repo は `.commandmate/*` を ignore 済み）
- 子への送信文の「触ってはいけないもの」欄に「run-dir を含め、workspace に 1 byte も書かない」を書く（`pane` fallback の例外を除く）。親は各子の調査前後で `git status --porcelain` を比べ、差分があれば final の Risks に「workspace が変更された」として記録する（§18 の実効化。止めはしない）

### D. 送信文は短く、契約と role はファイルで読ませる（§15）

**長い本文が Claude に途中から届く**事象（2 回再現、CommandMate#2464）。

- 子への送信文は cmate-delegate §3 の 5 欄（目的 / 対象 / 出力の形 / 触ってはいけないもの / 締め方）だけの短文にし、`WEB` 報告（B）と「`<run-dir>/brief.md` と `<run-dir>/roles/<agent>.md` を読んでから始めよ」を含める
- 仕様書 §15 の調査契約（MODE / Evidence Status / 報告の 8 見出し）は `brief.md` / `roles/<agent>.md` に親が書く。子は自分の role ファイルだけ読み、`agents/` は読まない（独立性）
- CommandMate#2464 が塞がっても送信文は短いまま（ファイル参照の方が独立性の統制にも都合がよい）

### E. 並列は `ask --json` を背景ジョブで N 本（§13 / §39）

`ask` は block するので、順に呼ぶと latency が N 倍になる。

- 親は `commandmate ask <wt> --instance <id> "<送信文>" --timeout 3600 --json > <run-dir>/agents/<agent>.json &` を子の数だけ起動し、shell の `wait` で揃うのを待つ。stderr は `<run-dir>/agents/<agent>.log`
- Codex を親にした場合は sandbox が背景ジョブを切ることがあるので、**直列を fallback** として SKILL.md に明記する
- `--async` / `--reply-to`（relay）は MVP では使わない（返答が親の composer に次 turn として届き、run の状態を `run.json` に持たせないと切れる）。後続で `phase` を `run.json` に持たせる形で検討
- `--timeout` は 3600（既定 1800 では調査 turn が 124 を出しやすく、124 後の再送は二重実行）。124 は「その子は未完」として §37.1 で扱い、再送しない

### F. `--agents` の解決と自己除外（§8 / §10）

- 値は alias でも instanceId でもよい。cmate-delegate §2 の解決（`instances --json`、完全一致 → 大小無視 → 部分一致、2 件以上なら選ばず人へ列挙）をそのまま使う。仕様書 §10 のエラー例の `claude-code` は実 ID `claude` に直す
- **親自身を含めたら開始前に拒否**（`whoami --json` → 環境変数 → tmux 逆引き、cmate-delegate §1）。1 Agent モードは「子 1 ＋ 親が統合」であり、親が自分で調査する形ではない
- 対象 worktree は親と同じものが既定。別 worktree の子は `<worktree-id>@<instance>` 表記で許す（`ask` はそのまま送れる）。ただし別 worktree の子は**その worktree** を調査するので、Workspace evidence の locator に worktree を併記させる
- 1 Agent でも動く。2 Agent 以上を推奨し、preflight で 1 Agent のときは「Cross Check は自己反証のみ」と表示する

### G. 冷間起動と warm-up（§37.1）

Command Code の冷間起動は `prompt not ready`（15 秒）で `ask` が失敗することがあり、Antigravity も初回に権限ダイアログを出す。preflight で `running: false` の子には短い warm-up 1 通（"Stand by. A research request will arrive shortly. Reply with READY."）を送り、READY を確認してから本番の送信文を送る。warm-up も失敗する子は §37.1 の failure として除外し、残りで続ける（残りが 0 なら FAILED）。

### H. 入力の受け取り方（§7 / §9）

- `/cmate-workspace-research --agents a,b --request "…"` に加え、**名前付き欄**（`agents:` / `request:` / `depth:`）でも受ける。Codex は slash を露出しないので名前で起動される（cmate-repository-analysis の「引数名を発明しない」と同じ流儀）
- MVP の入力は `agents`（必須）/ `request`（必須）/ `depth`（`standard` のみ実装。`quick` / `deep` は受理して `standard` として動き、`run.json` に要求値を残す）
- `--workspace` / `--output` / `--no-web` / `--no-local` は MVP から外す（B と C で代替）
- `request` が空、または「何を判断したいか」が読めないときは調査を始めず、cmate-repository-analysis と同じく即座に失敗を返す（`ambiguous_request`）

### I. 出力（§33 〜 §35）

- `final.md` の見出しは仕様書 §33 どおり。**`What Changed Through Cross Check` は空でも見出しを残し「修正なし」と書く**（§34）
- チャットへの報告は §35 の形（結論 → Workspace への意味 → 修正された点 → 未知 → 次の一手 → `final.md` のパス）。Agent 数や内部メッセージ数は主役にしない
- `run.json` に `agents[].capability`（`web` / `workspace`）、`agents[].status`（`completed` / `prompt_stopped` / `timeout` / `failed`）、`agents[].source`（`history` / `pane` / `file`）を足す

## パッケージ構成

```
skills/cmate-workspace-research/
  SKILL.md                    親の手順書。0 使うとき/使わないとき（cmate-delegate / cmate-orchestrate /
                              cmate-repository-analysis との境界）→ 1 入力（H）→ 2 preflight
                              （自己特定・宛先解決・権限・warm-up = A/F/G）→ 3 FRAME（brief.md）→
                              4 CAPABILITY PROBE → ROLE（B）→ 5 INDEPENDENT（背景 ask ×N = D/E）→
                              6 CROSS CHECK → 7 TARGETED VERIFY → 8 EVIDENCE MERGE → 9 SYNTHESIZE →
                              10 失敗と停止（§37、exit 10 / 124 / 21 / 99 の扱い）
  commandmate.skill.yaml      declared_permissions: process_execution / filesystem_read /
                              filesystem_write（run-dir のみ、risk_rationale に明記）/ environment_read。
                              declared_risk: moderate。requirements.commands: commandmate
                              （ask / whoami / instances を使うので version_range は '>=0.31.3 <1.0.0'）
  references/
    research-brief.md         子への送信文（5 欄・短文、ja/en）と brief.md / roles/<agent>.md の雛形（§15）
    roles.md                  1 / 2 / 3 / 4+ Agent の role（§14）と、capability 報告後の割当規則（B）
    evidence-rules.md         v7 抜粋（上記「背景」の 10 項目）＋ locator 規則（§16 / §17）＋ Finding state（§26）
    cross-check.md            選定優先順位（§20）・共有前提の問い（§22）・challenge 送信文の雛形・§37.4 の残し方
    artifacts.md              run-dir 構成と brief / agents / cross-check / evidence / final / run.json の雛形（§28–§38）
    delegate-contract.md      cmate-delegate §1 / §2 / §5 / §6 / §7 を「正本はそちら」と参照し、
                              未導入時に最低限動く ask（無ければ send → wait → capture）の写し
  scripts/                    初版は無し。背景 ask の wrapper は SKILL.md の bash 断片で足りる
tests/fixtures/cmate-workspace-research/
  two-agent-contradiction/    仕様書 §21 の Node 24 移行の例を fixture 化: brief / roles / agents/*.json（history 形）
                              / cross-check / evidence / final の期待形。「What Changed Through Cross Check」が
                              空でない run と、1 子が exit 10 で止まった run の 2 本
```

`commandmate.skill.yaml` の `compatibility.agents` は**親として**動く tool の宣言（claude / codex / opencode / command-code は discovery 実測あり、gemini / copilot / antigravity は `unknown`）。**子として使える tool** は SKILL.md の表で別に示し、Web 到達（B）と prompt の出やすさ（A）の実測を添える。

Skill 間依存の field は manifest schema に無いので、cmate-delegate は名前で参照し（cmate-worker-development → cmate-repository-analysis と同じ）、未導入でも `references/delegate-contract.md` で成立させる。

## 受入

仕様書 §40 の AC-01〜17 を上の差分で読み替えたうえで、次を足す。

- AC-02 は「存在」だけでなく、親自身の除外（F）と権限・Web の preflight 表（A/B）を含む
- AC-03 の委譲は `ask --json --timeout 3600` の背景 N 本（E）。fixture の `agents/*.json` は `history` 形
- AC-04（独立）: 送信文と role ファイルに「`agents/` を読まない」が入り、子の返答に他の子への言及が無いことを fixture で確認
- AC-07 / AC-08（locator）: `final.md` の Workspace Evidence が `path:line` または `path::symbol`、Web Evidence が URL ＋ as-of で書かれていることを `evidence-rules.md` の規則で機械的に確認（正規表現で可）
- AC-15（read-only）: `git status --porcelain` の前後比較を final に残す（C）
- AC-16（1 子失敗）: exit 10 / 124 / 21 の 3 通りで、残りの子で final が出ること。`run.json.agents[].status` に理由が残ること
- 追加 AC-18: 子の権限不足を preflight で 1 回にまとめて人へ示し、調査中の exit 10 で親が `respond` / `auto-yes` を打たない（A）
- 追加 AC-19: `python3 scripts/validate.py` が通る（manifest / files / risk）
- 追加 AC-20: 実機 1 本 — 2 子（claude ＋ command-code、両方 Auto-Yes ON）で仕様書 §50 の Node 24 移行の request を流し、`final.md` に `What Changed Through Cross Check` が書かれ、run 前後で workspace が dirty になっていない

## 対象外

- `deep` depth（複数 challenge round、coverage audit）、`cmate-evolution-validator` 連携（§46）、Persistent Workspace Research（§47）、Research → Implementation handoff（§48）
- `--async` / relay 経由の非同期回収（E）
- v7 の Q-level・Goal Lock・continuity（§42）
- CommandMate 側の修正（CommandMate#2463 / #2464 / 冷間起動の `prompt not ready`）。本 Skill はそれらが無くても A/D/G の回避策で動く

## 関連

- CommandMate#2463 — `wait` / `ask` が相手の Auto-Yes を待たず exit 10（A の主因）
- CommandMate#2464 — 長い本文が Claude に途中から届く（D の主因）
- CommandMate#2376（`ask` / `whoami` / `peers`）、#2377（relay）
- 既存 Skill: cmate-delegate（委任の規律の正本）、cmate-repository-analysis（Workspace 走査の evidence 規律）、cmate-orchestrate（契約付き dispatch。本 Skill は契約を使わない）

---

# 第 II 部 — 仕様書 v2（起票時点の正本）

# cmate-workspace-research 仕様書

- Status: Draft
- Target: CommandMate
- Feature / Skill name: `cmate-workspace-research`
- Primary goal: 複数のAI Coding Agentを使い、WebとローカルWorkspaceを横断した調査を、独立探索・相互反証・Evidence確認まで含めて実行する
- MVP scope: Web × Workspace × Multi-Agent Research + Cross Check + Evidence-aware Synthesis

---

# 1. 背景

AI Coding Agent は、単なるコード生成ツールではなく、以下を扱えるようになっている。

- Web Search
- Web Fetch
- ローカルファイル検索
- ソースコード検索
- 設定ファイル・ログ・テストの参照
- Git / GitHub情報の確認
- CLI / shellによる検証

一方、実際の技術調査では、Web上の一般情報だけでも、ローカルWorkspaceだけでも不十分なことが多い。

例えば、

> このリポジトリを Node.js 24 に移行して問題ないか？

という問いに答えるには、

### Web側
- Node.js 24 のBreaking Changes
- 利用ライブラリの対応状況
- Upstream Issues
- Migration Guide
- Release Notes

### Workspace側
- `package.json`
- lockfile
- 実際に利用しているAPI
- CI
- Dockerfile
- test
- 独自実装
- バージョン固定箇所

を突き合わせる必要がある。

必要なのは単なるWeb Searchではなく、

```text
Web Evidence
      +
Workspace Evidence
      ↓
Project-specific Analysis
      ↓
Cross Check / Verification
      ↓
Research Result
```

である。

---

# 2. 目的

`cmate-workspace-research` は、ユーザーが指定した複数のAI Coding Agentに対して、WebとローカルWorkspaceを横断した調査を委譲し、互いの見落とし・矛盾・誤った前提を確認したうえで、1つの調査結果へ統合する。

ユーザーは原則として以下だけを指定する。

1. 利用するAgent
2. 調査依頼

例:

```text
/cmate-workspace-research \
  --agents command-code,antigravity \
  --request "このリポジトリをNode.js 24へ移行して問題ないか調査して"
```

---

# 3. Core Value

この機能の価値は、

> Webを検索できること

でも、

> ローカルファイルを検索できること

でもない。

価値は、

> **複数のAI Coding Agentが、WebとWorkspaceを別々の角度から調査し、互いの見落としや誤った前提をEvidenceで確認しながら、「このWorkspaceにとって何を意味するか」までまとめること。**

である。

---

# 4. UX Principle

ユーザーにAgent orchestrationを管理させない。

ユーザーが覚える操作は基本的にこれだけとする。

```text
/cmate-workspace-research \
  --agents <agent names> \
  --request "<research request>"
```

内部の、

```text
役割設定
↓
独立調査
↓
相互レビュー
↓
追加確認
↓
Evidence統合
↓
最終レポート
```

はCommandMateが実行する。

ユーザーは必要な場合のみ中間成果物を確認する。

---

# 5. 想定利用者

主な対象:

- Command Code利用者
- Antigravity CLI利用者
- Claude Code利用者
- Codex CLI利用者
- OpenCode利用者
- 複数のAI Coding Agentを併用している開発者
- 既存コードベースを前提とした技術調査を頻繁に行う開発者

特に、

> Webの一般論ではなく、自分のRepo / Workspaceを踏まえて判断したい

ユーザーを対象とする。

---

# 6. 想定ユースケース

## 6.1 Runtime / Framework Migration

```text
/cmate-workspace-research \
  --agents command-code,antigravity \
  --request "このプロジェクトをNode.js 24に移行可能か調査して"
```

調査対象:

### Web
- Breaking Changes
- dependency compatibility
- known issues
- migration guide

### Workspace
- package.json
- lockfile
- CI
- Dockerfile
- Node API usage
- tests

最終結果:

- 移行可能性
- blocker
- 影響箇所
- 未確認事項
- 推奨検証手順

---

## 6.2 Dependency / Library Upgrade

```text
/cmate-workspace-research \
  --agents command-code,antigravity \
  --request "Next.jsを最新版へ更新した場合の影響を調査して"
```

Web:

- release notes
- migration guide
- breaking changes
- GitHub issues

Workspace:

- current version
- App Router / Pages Router
- config
- deprecated API usage
- custom plugins

---

## 6.3 Incident / Error Research

```text
/cmate-workspace-research \
  --agents command-code,antigravity \
  --request "wrangler実行時に発生するこのエラーの原因と回避策を調査して"
```

Web:

- GitHub issues
- official docs
- release notes
- known regressions

Workspace:

- wrangler version
- config
- Worker code
- logs
- dependency versions

---

## 6.4 Architecture Decision

```text
/cmate-workspace-research \
  --agents command-code,antigravity \
  --request "このシステムではPostgreSQLとCosmos DBのどちらを採用すべきか調査して"
```

Web:

- current specifications
- limits
- pricing
- architecture guidance

Workspace:

- schema
- query pattern
- transaction requirements
- expected scale
- existing infrastructure
- operational constraints

---

## 6.5 Security Research

```text
/cmate-workspace-research \
  --agents command-code,antigravity \
  --request "このリポジトリに現在影響する重大な既知脆弱性を調査して"
```

Web:

- CVE
- advisories
- upstream issues

Workspace:

- dependency versions
- configuration
- actual affected paths

---

## 6.6 OSS / Product Research

```text
/cmate-workspace-research \
  --agents command-code,antigravity \
  --request "このOSSの競合の最新動向を調査し、READMEと現在の実装を踏まえて差別化余地を整理して"
```

Web:

- competitors
- release notes
- pricing
- GitHub issues
- community feedback

Workspace:

- README
- roadmap
- source code
- implemented features
- open issues

---

# 7. CLI / Skill Interface

## 7.1 Canonical Interface

```text
/cmate-workspace-research \
  --agents <agent1,agent2,...> \
  --request "<natural language request>"
```

例:

```text
/cmate-workspace-research \
  --agents command-code,antigravity \
  --request "このrepoをNode.js 24に移行して問題ないか調査して"
```

---

# 8. Required Arguments

## `--agents`

利用するCommandMate上のAgent / Session名。

```text
--agents command-code,antigravity
```

要件:

- 1個以上
- カンマ区切り
- 指定されたAgentが存在することを実行前に確認

1 Agentでも利用可能だが、2 Agent以上を推奨する。

---

## `--request`

自然言語による調査依頼。

```text
--request "このrepoをNode.js 24に移行できるか調査して"
```

CommandMateはこの依頼を変更せず、Original Requestとして保存する。

---

# 9. Optional Arguments

MVPではOptional Argumentを増やしすぎない。

## `--workspace`

調査対象。

Default:

```text
current working directory / current repository
```

例:

```text
--workspace .
```

---

## `--depth`

```text
quick
standard
deep
```

Default:

```text
standard
```

MVPでは `standard` を中心に実装する。

---

## `--output`

成果物の保存先。

Default:

```text
.cmate/workspace-research/<run-id>/
```

---

## `--no-web`

Web調査を禁止。

---

## `--no-local`

Workspace調査を禁止。

通常は使用しない。

---

# 10. Agent Validation

実行前に指定Agentを確認する。

例:

```text
--agents command-code,antigravity
```

存在しない場合:

```text
ERROR

Agent session "antigravity" was not found.

Available sessions:
- command-code
- claude-code
- codex
```

指定された一部Agentのみ存在する場合、デフォルトでは実行を開始せずユーザーへエラーを返す。

将来的に `--allow-partial-agents` を追加可能。

---

# 11. Research Workflow

MVPでも以下を必須とする。

```text
FRAME
↓
INDEPENDENT RESEARCH
↓
CHALLENGE / CROSS CHECK
↓
TARGETED VERIFY
↓
EVIDENCE MERGE
↓
SYNTHESIZE
```

単純な、

```text
Agent Aに検索
+
Agent Bに検索
+
結果を要約
```

にはしない。

---

# 12. Phase 1 — FRAME

親Agentはユーザーの依頼を変更せず保持し、内部用Research Briefを作成する。

生成物:

```text
brief.md
```

形式:

```markdown
# Original Request

<ユーザーの依頼>

# Research Goal

<何を判断可能にするか>

# Workspace Scope

<対象workspace>

# Questions to Investigate

## Web
- ...

## Workspace
- ...

# Key Uncertainties
- ...

# Expected Output
- ...
```

Research Brief作成時に、元の依頼を勝手に別ゴールへ置き換えない。

---

# 13. Phase 2 — INDEPENDENT RESEARCH

指定された各Agentに `cmate-delegate` を利用して調査を依頼する。

重要要件:

> 初期Research中は、他Agentの調査結果を見せない。

目的:

- Anchoring抑制
- Shared blind spotの発見可能性向上
- 異なる検索経路の確保
- 異なる推論経路の確保

---

# 14. Default Role Assignment

ユーザーはAgent名のみ指定すればよい。

RoleはCommandMateが自動設定する。

---

## 14.1 1 Agent

```text
Hybrid Researcher
```

WebとWorkspaceの両方を調査する。

---

## 14.2 2 Agents

Default:

### Agent A — Workspace-first Researcher

最初にWorkspaceを理解する。

優先:

- source
- config
- docs
- tests
- logs
- dependencies
- git information

その後Webで外部情報を確認する。

主な問い:

> このWorkspaceでは実際に何が使われているか？

---

### Agent B — External-first Researcher

最初に外部情報を調査する。

優先:

- official docs
- release notes
- GitHub issues
- security advisories
- standards
- papers
- latest Web information

その後Workspaceへの適用可能性を確認する。

主な問い:

> 外部世界では現在何が分かっているか？

---

## 14.3 3 Agents

```text
Agent A: Workspace-first
Agent B: External-first
Agent C: Falsifier / Coverage Researcher
```

Agent Cは、

- A/Bが共通して置いている前提
- 見落とした候補
- counterexample
- stale information
- alternative explanation
- missing evidence

を重点的に探す。

---

## 14.4 4 Agents以上

依頼内容に応じて専門Roleを追加する。

例:

```text
Security
Performance
Architecture
Cost
Competition
Compatibility
Verification
```

Agent数を増やすこと自体を目的にしない。

---

# 15. Child Agent Research Contract

各Agentへの依頼では、最低限以下を要求する。

```text
MODE: WORKSPACE_RESEARCH

Original request:
{{REQUEST}}

Workspace:
{{WORKSPACE}}

Your role:
{{ROLE}}

Investigate independently.

When relevant, use BOTH:

1. LOCAL WORKSPACE
   - source code
   - configuration
   - documentation
   - logs
   - tests
   - dependency files
   - git information

2. WEB
   - official documentation
   - primary sources
   - release notes
   - GitHub issues
   - advisories
   - standards
   - papers
   - current information

Do not assume general Web information automatically applies to this workspace.

For every important finding, record:

- Finding
- Source Type: WEB | WORKSPACE | DERIVED
- Locator
- Evidence Status
- Why it matters
- Assumptions
- Uncertainty

Evidence Status:
- VERIFIED
- PARTIAL
- CITED_NOT_VERIFIED
- UNVERIFIED

Finally report:

# Conclusion

# Web Findings

# Workspace Findings

# Web ↔ Workspace Connections

# Assumptions

# Risks / Counterevidence

# Unknowns

# Recommended Next Checks
```

---

# 16. Workspace Evidence Rules

Workspace evidenceでは、可能な限り具体的なlocatorを残す。

Good:

```text
apps/api/package.json
src/auth/auth.service.ts::AuthService.login
.github/workflows/ci.yml
docker/Dockerfile:23-31
```

Avoid:

```text
the source code
the config file
some test
```

可能であれば以下を記録する。

```text
relative path
+
line range
or symbol / function / section
```

---

# 17. Web Evidence Rules

重要な外部Claimには可能な限り以下を残す。

```text
exact URL
source name
source date
access / as-of date
```

Source priority:

```text
Official / Primary
↓
Original repository / issue / advisory
↓
Authoritative secondary source
↓
Community discussion
```

重要な結論を、出所不明な検索スニペットだけで確定しない。

---

# 18. Read-only Principle

`cmate-workspace-research` のDefaultはResearch Onlyとする。

実行中に以下を行わない。

```text
source modification
config modification
dependency update
git commit
push
deployment
external write action
```

検証のためのread-only commandは利用可能。

例:

```text
git status
git log
npm ls
node --version
grep
find
test command without modification
```

実装変更が必要な場合はResearch完了後に別Taskとして扱う。

---

# 19. Phase 3 — CHALLENGE / CROSS CHECK

独立Research完了後、重要なFindingをAgent間でCross Checkする。

目的は多数決ではない。

確認対象:

```text
contradiction
shared assumption
unsupported claim
version mismatch
scope mismatch
stale information
Web ↔ Workspace mismatch
important omission
```

---

# 20. Cross Check Selection

全Findingを相互レビューしない。

親Agentが「結論を変えうるFinding」を選ぶ。

優先順位:

1. Final conclusionに直結する
2. Agent間で矛盾している
3. 複数Agentが同じ前提を置いている
4. Evidenceが弱い
5. 最新性が重要
6. WorkspaceとWebで結果が食い違う

---

# 21. Cross Check Example

Agent A:

```text
Node.js 24への移行は問題ない。
```

Agent B:

```text
package X v3はNode <=22のみsupported。
```

親Agent:

```text
Check:
1. Workspaceのpackage X version
2. 実際の利用箇所
3. package X公式support matrix

Determine whether this is a real blocker.
```

必要なAgentへ追加確認を委譲する。

---

# 22. Shared Assumption Check

今回までのMulti-Agent実験で、複数Agentが同じ誤った前提を共有するケースが確認されている。

そのためCross Checkでは、

> 両Agentが一致した項目

も安全とはみなさない。

重要な共通前提について、

```text
What assumption do all agents appear to share?

What evidence would falsify it?
```

を確認する。

Agent consensusはEvidenceとして扱わない。

---

# 23. Phase 4 — TARGETED VERIFY

Cross Checkで以下に該当するものは、可能なら追加確認する。

- 結論を左右する
- 外部から確認可能
- Evidenceが不足
- Agent間で矛盾
- 共有前提
- 時点依存

Verify対象例:

```text
official docs
current release notes
actual package version
actual source usage
upstream issue
config value
test result
```

Verifyできない場合は、未確認のまま明示する。

無理に結論を確定しない。

---

# 24. Phase 5 — EVIDENCE MERGE

親AgentはFindingを統合する。

推奨内部形式:

```yaml
finding_id: R-001
finding: "package X v3 blocks Node.js 24 migration"
status: VERIFIED
importance: HIGH
evidence:
  - type: WORKSPACE
    locator: package.json
  - type: WEB
    locator: https://example.com/support
agents:
  - command-code
  - antigravity
assumptions: []
```

同じURLを複数Agentが発見しても、独立Evidenceが増えたとはみなさない。

---

# 25. Evidence Categories

最低限以下を区別する。

```text
WEB
WORKSPACE
DERIVED
```

必要に応じて:

```text
OFFICIAL_WEB
UPSTREAM_REPOSITORY
COMMUNITY
SOURCE_CODE
CONFIG
LOG
TEST_RESULT
GIT
```

へ細分化可能。

MVPでは3分類でよい。

---

# 26. Finding State

各重要Findingに以下のStateを付与する。

```text
VERIFIED
PARTIAL
CITED_NOT_VERIFIED
UNVERIFIED
REJECTED
```

最終Reportで、未検証のFindingを検証済みの事実と同じ強さで書かない。

---

# 27. Phase 6 — SYNTHESIZE

親Agentが最終レポートを作る。

結論はAgentの多数決で決めない。

優先するもの:

```text
Workspace facts
+
Primary Web evidence
+
Verified cross-check results
+
Project-specific reasoning
```

Agent consensusは、

```text
Process robustness
```

として参考にしてよいが、

```text
Substantive evidence
```

として扱わない。

---

# 28. Output Directory

Default:

```text
.cmate/workspace-research/<run-id>/
```

例:

```text
.cmate/workspace-research/
└── node24-migration-20260911-001/
    ├── brief.md
    ├── agents/
    │   ├── command-code.md
    │   └── antigravity.md
    ├── cross-check.md
    ├── evidence.md
    ├── final.md
    └── run.json
```

---

# 29. `brief.md`

```markdown
# Original Request

# Research Goal

# Workspace Scope

# Web Questions

# Workspace Questions

# Key Uncertainties

# Expected Output
```

---

# 30. `agents/<agent>.md`

各Agentの独立Research結果。

最低限:

```markdown
# Role

# Conclusion

# Web Findings

# Workspace Findings

# Web ↔ Workspace Connections

# Assumptions

# Counterevidence

# Unknowns

# Recommended Next Checks
```

---

# 31. `cross-check.md`

```markdown
# Important Agreements

# Important Contradictions

# Shared Assumptions

# Challenges Sent

# Verification Performed

# Corrections

# Remaining Disagreements
```

重要なのは、

> 最終的に何が修正されたか

を残すことである。

---

# 32. `evidence.md`

例:

```markdown
# Evidence

## R-001

Finding:
package X v3 blocks Node.js 24.

Status:
VERIFIED

Workspace:
- package.json

Web:
- https://...

Impact:
HIGH
```

---

# 33. `final.md`

推奨形式:

```markdown
# Research Question

<Original Request>

# Conclusion

<このWorkspaceに対する結論>

# What This Means for This Workspace

<具体的影響>

# Key Findings

## Finding 1

- Finding:
- Status:
- Why it matters:

### Workspace Evidence
- ...

### Web Evidence
- ...

# What Changed Through Cross Check

<初期Researchから修正された重要事項>

# Risks / Counterevidence

# Unknowns

# Recommended Next Actions

# Sources

## Web

## Workspace

# Research Metadata

- Agents:
- Workspace:
- AS_OF:
- Depth:
```

---

# 34. `What Changed Through Cross Check`

MVPでもこのSectionを必須とする。

理由:

Multi-Agent Researchの価値は、

> Agentを複数使ったこと

ではなく、

> **複数Agentを使ったことで、初期分析の何が修正・棄却・追加されたか**

で評価すべきだからである。

例:

```text
Initial:
Node.js 24 migration = safe

Cross Check:
package X v3 is incompatible

Verified:
workspace uses package X v3

Final:
migration blocked until package X is upgraded
```

---

# 35. User-facing Result

チャット上では長いResearch Reportをそのまま表示する必要はない。

例:

```text
Workspace Research completed.

Conclusion:
Node.js 24への移行は現時点ではblockされています。

Main blocker:
package X v3 が Node.js 24 未対応です。

Checked:
✓ Workspace dependencies
✓ CI / Dockerfile
✓ Node.js 24 official migration information
✓ package X upstream support status

Cross-check result:
1件の初期判断を修正しました。

Remaining unknowns:
2

Recommended next step:
package X v4への更新可否を検証。

Full report:
.cmate/workspace-research/.../final.md
```

表示優先順位:

```text
何が分かったか
↓
このWorkspaceへの意味
↓
何が修正されたか
↓
何がまだ分からないか
↓
次に何をすべきか
```

Agent数や内部メッセージ数は主役にしない。

---

# 36. Depth Modes

## quick

- 軽量調査
- 1 Agentでも利用可能
- Cross Checkは明確な矛盾のみ
- Evidence最小限

## standard

Default。

```text
Independent Research
+
Cross Check
+
Targeted Verify
+
Evidence Merge
+
Final
```

## deep

将来拡張。

- broader candidate search
- multiple challenge rounds
- coverage audit
- deeper verification
- `cmate-evolution-validator` integration

MVPでは `standard` を完成させることを優先する。

---

# 37. Failure Handling

## 37.1 Agent Failure

Agentの1つが失敗した場合:

- 残りAgentの成果を保持
- failureを明示
- Cross Check可能なら継続

Final:

```text
Research coverage reduced:
antigravity did not complete.
```

ただし、残存Agentだけでは依頼を満たせない場合はFAILEDとする。

---

## 37.2 Web Search unavailable

```text
Web research unavailable.
Result is based on Workspace evidence only.
```

FinalのResearch Coverageを下げる。

---

## 37.3 Workspace unavailable

```text
Workspace research unavailable.
Result is based on external evidence only.
```

`Workspace Research`として完全成功扱いにしない。

---

## 37.4 Unresolved Contradiction

矛盾を無理に統合しない。

```text
UNRESOLVED CONTRADICTION
```

としてFinalに残す。

---

# 38. `run.json`

例:

```json
{
  "run_id": "node24-migration-20260911-001",
  "request": "このrepoをNode.js 24に移行できるか調査して",
  "agents": [
    "command-code",
    "antigravity"
  ],
  "workspace": ".",
  "depth": "standard",
  "mode": "WORKSPACE_RESEARCH",
  "status": "COMPLETED",
  "started_at": "...",
  "completed_at": "..."
}
```

---

# 39. Progress UX

長いResearchの場合、CommandMateは最低限の進捗を表示する。

例:

```text
[1/6] Framing research question
[2/6] Independent research
      command-code ✓
      antigravity  working
[3/6] Cross-checking findings
[4/6] Verifying 3 critical claims
[5/6] Merging evidence
[6/6] Finalizing report
```

詳細なAgent会話を常時表示する必要はない。

---

# 40. Acceptance Criteria — MVP

## AC-01

以下の形式で起動できる。

```text
/cmate-workspace-research \
  --agents command-code,antigravity \
  --request "..."
```

---

## AC-02

指定Agentの存在を事前確認できる。

---

## AC-03

指定した各Agentへ `cmate-delegate` でResearch Taskを送れる。

---

## AC-04

初期ResearchはAgentごとに独立して実行され、他Agentの結果を参照しない。

---

## AC-05

2 Agentの場合、Default roleとして以下を割り当てる。

```text
Workspace-first
External-first
```

---

## AC-06

各AgentはWeb EvidenceとWorkspace Evidenceを区別して記録する。

---

## AC-07

Workspace Evidenceに具体的なfile path / symbol / lineを可能な範囲で記録する。

---

## AC-08

Web Evidenceに具体的なURLを記録する。

---

## AC-09

独立Research完了後、重要FindingについてCross Checkを実行する。

---

## AC-10

Agent間の矛盾だけでなく、重要なShared Assumptionも確認対象とする。

---

## AC-11

結論を変えうる未確認Claimについて、可能であればTargeted Verifyを実行する。

---

## AC-12

Agent consensusをEvidenceとして扱わない。

---

## AC-13

最終的に `final.md` を生成する。

---

## AC-14

`final.md` に最低限以下を含む。

```text
Conclusion
Workspace-specific impact
Key findings
Workspace evidence
Web evidence
What changed through cross-check
Risks / counterevidence
Unknowns
Recommended next actions
```

---

## AC-15

Research中にWorkspaceを変更しない。

---

## AC-16

1 Agent失敗時に、継続可能なら残りAgentで処理を継続する。

---

## AC-17

未解決の矛盾を無理に統合せず、明示して残す。

---

# 41. MVPで含めるもの

以下はMVPから削らない。

```text
✓ Web Research
✓ Workspace Research
✓ Multi-Agent
✓ Independent Research
✓ Default Role Assignment
✓ Cross Check
✓ Shared Assumption Check
✓ Targeted Verify
✓ Evidence付きFinal
✓ What Changed Through Cross Check
✓ Unknowns
✓ Recommended Next Actions
```

この部分が `cmate-workspace-research` の中核価値である。

---

# 42. MVPでは実装しないもの

以下は後続でよい。

```text
Persistent Belief Registry
cmate-evolution-validator hard integration
独自Web crawler
独自search engine
独自Vector DB
Embedding index
Long-term monitoring
Scheduled research
automatic code modification
automatic deployment
complex quantitative claim schema
full epistemic lifecycle engine
```

理由は、既存Coding Agentが持つWeb / Local調査能力を利用できるため。

CommandMateはまず、

> **Research OrchestrationとCross-Agent Verification**

に集中する。

---

# 43. Existing CommandMate Components

MVPは可能な限り既存機能を利用する。

```text
cmate-workspace-research
        │
        ├─ existing session discovery
        ├─ cmate-delegate
        ├─ shared workspace / files
        ├─ wait / status
        └─ parent session synthesis
```

新しいResearch Engineをゼロから作らない。

---

# 44. Recommended Internal Architecture

```text
User Request
     │
     ↓
cmate-workspace-research
     │
     ↓
Research Framer
     │
     ├───────────────┐
     ↓               ↓
Workspace-first   External-first
Agent A           Agent B
     │               │
     └──────┬────────┘
            ↓
      Finding Collector
            ↓
      Cross Check Selector
            ↓
      Challenge / Verify
            ↓
       Evidence Merge
            ↓
       Final Synthesis
            ↓
          final.md
```

3 Agent時:

```text
Workspace-first
External-first
Falsifier / Coverage
```

---

# 45. Important Design Decisions

## 45.1 Agentを増やせば良いわけではない

Defaultは2 Agent。

理由:

- コスト
- latency
- supervision
- duplicate search

3 Agent目以降は役割が明確な場合のみ価値がある。

---

## 45.2 Consensus ≠ Truth

```text
Agent A agrees
Agent B agrees
```

はEvidenceではない。

特に両Agentが同じ前提を共有している可能性がある。

---

## 45.3 Web ≠ Workspace

一般的なWeb情報が、現在のWorkspaceに適用できるとは限らない。

最終Reportでは必ず、

```text
General external finding
↓
Actual workspace condition
↓
Project-specific implication
```

の接続を行う。

---

## 45.4 Research ≠ Execution

Research中に変更を行わない。

```text
調査
↓
結論
↓
ユーザー判断
↓
必要なら別Taskで実装
```

を原則とする。

---

# 46. Future: cmate-evolution-validator Integration

後続フェーズでは、

```text
Workspace Research
↓
claims.json
evidence.json
final-assertions.json
↓
cmate-evolution-validator
↓
PASS / REPAIR
↓
Final
```

へ拡張可能。

Validatorが担う候補:

- Evidence locator
- Quantitative type
- Future certainty
- Unsupported assertion
- Evidence propagation
- Readiness

---

# 47. Future: Persistent Workspace Research

同じResearch Questionを継続的に更新する。

```text
Previous Research
       +
Workspace Changes
       +
New Web Evidence
       ↓
Affected Findings
       ↓
Re-research
       ↓
Research Diff
```

例:

> Node.js 24移行可否を1か月後に再確認

結果:

```text
package X:
UNSUPPORTED
    ↓
SUPPORTED

Recommendation:
BLOCKED
    ↓
READY TO TEST
```

---

# 48. Future: Research → Implementation Handoff

Research完了後に、

```text
Implement recommendation
```

を選択可能にする。

```text
Research
↓
Recommended Changes
↓
User approval
↓
Implementation Task Contract
↓
Coding Agent
↓
verify
```

ResearchとImplementationの責務は分離する。

---

# 49. Success Metrics

MVP評価では、単純なレポート文字数やAgent数を指標にしない。

測定候補:

### Quality
- Single Agentでは見落とした重要事項を発見した件数
- Cross Checkで修正されたClaim数
- Shared Assumptionの発見数
- Unsupported Claim数
- Human review後に発見された重大ミス数

### Utility
- ユーザーが追加検索した回数
- 調査後に次Actionを判断できた割合
- Workspaceに即したFindingの割合

### Cost
- token / model cost
- elapsed time
- Agent数

将来的には、

```text
Single Agent
vs
Multi-Agent Workspace Research
```

を比較する。

---

# 50. Example End-to-End

User:

```text
/cmate-workspace-research \
  --agents command-code,antigravity \
  --request "このrepoをNode.js 24へ移行して問題ないか調査して"
```

Internal:

```text
FRAME
  ↓
command-code
  Workspace-first
  ↓
antigravity
  External-first
  ↓
Independent findings
  ↓
Cross Check
  ↓
"package X support" が矛盾
  ↓
Targeted Verify
  ↓
Workspace = package X v3
Official = Node <=22
  ↓
Evidence Merge
  ↓
Final
```

User result:

```text
Conclusion:
現時点ではNode.js 24への移行は推奨しません。

Blocker:
package X v3

Workspace evidence:
package.json

Web evidence:
package X official support documentation

Cross-check:
初期分析では移行可能と判断していましたが、
依存ライブラリの対応状況を相互確認した結果、
1件のblockerを発見し結論を修正しました。

Unknown:
package X v4への移行影響

Next:
package X v4への更新可否を調査
```

---

# 51. Product Message

短い説明:

> **Research across your Web and Workspace with multiple AI coding agents.**

ユーザー向けの価値表現:

> **Webの一般論だけでなく、自分のコード・設定・ログまで踏まえて調査する。**

CommandMateらしい差分:

> **複数のAI Coding Agentが独立に調査し、互いの見落としや誤った前提を確認してから結果を返す。**

---

# 52. Definition of Done — MVP

MVP完了条件:

1. `agents + request` で起動できる
2. 2 Agentへ独立Researchを委譲できる
3. WebとWorkspaceの両方を調査できる
4. Evidence locatorを残せる
5. 重要な矛盾・共有前提をCross Checkできる
6. 必要な追加Verifyを行える
7. 初期分析から何が変わったかを記録できる
8. `final.md` を生成できる
9. Research中にWorkspaceを変更しない
10. ユーザーが「このWorkspaceについて次に何をすべきか」を判断できる

---

# 53. 最終的に目指すUX

ユーザー:

```text
/cmate-workspace-research \
  --agents command-code,antigravity \
  --request "このWorkspaceについて○○を調査して"
```

CommandMate:

```text
複数Agentが
Web
+
Workspace
を独立に調査
↓
相互反証
↓
重要Evidenceを確認
↓
結果を統合
```

ユーザーに返すもの:

```text
結論
+
このWorkspaceへの具体的影響
+
Web Evidence
+
Workspace Evidence
+
Cross Checkで修正された点
+
残る不確実性
+
次のAction
```

ユーザーに複数Agentを「管理」させるのではなく、

> **調べたいことを1回依頼すれば、自分のWorkspaceを踏まえた検証付きResearchが返ってくる**

ことを最終的なUXとする。

---

# 第 III 部 — 実装で決めたこと（Issue に書かれていない細部）

確定仕様 A〜I の範囲で、0.1.0 の実装が決めた細部を記録する。正本は `SKILL.md` と `references/` である。

1. **CAPABILITY PROBE は独立調査とは別の 1 往復にした。** B の「親は報告後に role を確定する」を満たすには、
   報告と role の確定の間に親が入る必要がある。probe は `brief.md` を読ませて `WORKSPACE: readable | unreadable`
   も同時に報告させる（「全員が Workspace も読めなければ FAILED」を判定するため）。調査の送信文にも `WEB:` の
   報告を残した（D）。warm-up と probe の `--timeout` は 600、調査と challenge は 3600。
2. **run-dir に `sent/`・`challenges/`・`integrity/`・`commands.log` を足した。** `sent/<name>.txt` は親が実際に
   送った文面、`challenges/<key>.challenge-<n>.md` は cross check で確かめてほしい claim（送信文を短く保つため
   ファイルで読ませる）、`integrity/` は `git status --porcelain` の前後、`commands.log` は親が打った
   `commandmate` / `git` のコマンドである。AC-04（送信文に `agents/` の禁止）、AC-15（前後比較）、
   AC-18（`respond` / `auto-yes` を打っていない）を fixture で機械的に確かめるためにある。
3. **`ask` の exit code は `agents/<name>.exit` に分けて残す。** `--json` の stdout は exit code で形が違う
   （0 は `{worktreeId, instanceId, cliToolId, source, reply}`、10 は `wait --on-prompt agent` と同じ prompt JSON）。
   JSON の形で分岐しない。
4. **run 全体の status を COMPLETED / PARTIAL / FAILED の 3 値にした**（§38 の例は COMPLETED のみ）。
   §37.1〜§37.3 の coverage 降格はすべて PARTIAL で、final は出す。
5. **`agents[].status` は調査の `ask` の exit code で決める。** 調査まで届かなかった子は最後に届いた
   warm-up / probe の exit code で決め、challenge が返らなかったことは status を変えない。
   `ask` が送信前に「相手が prompt で止まっている」として exit 2 を返す場合（CommandMate の `ask` 実装）も
   `prompt_stopped` として扱う。
6. **locator の規則を正規表現で固定した**（`references/evidence-rules.md` 第4.3節）。fixture の検査器
   `tests/fixtures/cmate-workspace-research/check_run.py` はこの節を読んで同じ正規表現を使う。
   Workspace の locator は `path:line` / `path:start-end` / `path::symbol`（別 worktree は `[<worktree-id>] ` を前置）、
   Web の locator は `<URL> — <source name>（<source date>）, as-of <YYYY-MM-DD>`。
7. **親は Web に出ない。** manifest が network 権限を宣言しないためで、Web の Targeted Verify は
   `WEB: available` の子へ challenge として送る。Workspace の claim は親が locator を読んで確かめる。
8. **回収ジョブが harness に切られて `.exit` が書かれなかった子には再送しない。**
   `commandmate wait` → `capture --pane --tail 80` で回収し、`source = pane` と記録する。
9. **`ask` の無い版（manifest の下限 0.31.3）では send → wait → capture で代え、全員に書き出し例外を与える。**
   この経路の返答は常に画面の末尾で、長い調査の返答は先頭が欠けるからである（`references/delegate-contract.md` 第3節）。
10. **fixture の run は手で組んだ期待形であり、実機の capture ではない。** 実機 2 Agent の live run（AC-20）は
    この文書を書いた worktree では実施していない。
11. **SKILL.md の本文に位置引数の記法を書かない（0.1.1、#247）。** Claude Code は Skill を slash で起動すると、
    本文の `$0`〜`$9`（0 始まりの起動引数）と `$ARGUMENTS` を置き換えてからモデルに渡す（2.1.268 で実測。
    範囲外の添字と名前付き変数は置き換わらない）。0.1.0 の第5.2節は背景 `ask` を関数の位置引数で書いていたため、
    AC-20 の実機 run（2026-09-11）で宛先が `claude-2,command-code` に化けた。第5.2節を名前付き変数だけで
    書き直し、`tests/fixtures/cmate-workspace-research/run_tests.sh` の第5節がこの記法の不在を検査する。
12. **ignore 対象への書き込みも洗い出す（0.1.2、#249）。** `git status` の前後比較は gitignore 対象を見ない。
    #245 の AC-20 と UAT では、子の Command Code が taste 機能で `.commandcode/taste/` を run の最中に書き、比較には
    映らなかった。第7節で `before.txt` の更新時刻より後に更新された run-dir 外の file を `find` で拾い、
    `integrity/<worktree-id>.touched.txt` に `ignored` / `visible` で残す。`ignored` の path は `run.json` の
    `workspace_integrity.ignored_touched`・final の Research Metadata（`ignore 対象の更新: N 件`）・Risks に書く。止めはしない。
13. **`WEB:` 行は 1 行目に限らない（0.1.2、#254）。** `ask --json` の history 返答は tool によって形が違う。Claude は
    最終メッセージだけ、Command Code はターン内の独り言も含む。第5.3節は「報告の最初の見出しより前にある最初の
    `WEB:` 行」を読む。検査器の REPLY-SHAPE も同じ規則である（#253）。
