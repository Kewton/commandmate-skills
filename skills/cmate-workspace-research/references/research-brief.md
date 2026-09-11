# 送信文と role ファイルの雛形

[SKILL.md](../SKILL.md) 第2.5・3・4・5.1 節の正本である。
**送信文は短く、調査契約はファイルで読ませる**——すべての欄はこの一点から決まっている。

## 1. 何をどこに書くか

| 置き場 | 書く人 | 読む人 | 中身 |
|---|---|---|---|
| 送信文（`sent/<name>.txt` に保存してから送る） | 親 | その子 | cmate-delegate の 5 欄だけ。ファイルへの参照、`WEB:` の報告、`DONE:` |
| `brief.md` | 親 | 全員 | 調査の問い。Original Request は一字も変えない |
| `roles/<key>.md` | 親 | **その子だけ** | 調査契約（MODE / 記録項目 / Evidence Status / 報告の 8 見出し / locator / 禁止事項）と role |
| `challenges/<key>.challenge-<n>.md` | 親 | その子だけ | cross check / verify で確かめてほしい claim（[cross-check.md](./cross-check.md)） |
| `agents/` | 親（例外: 書き出し例外の子の `agents/<key>.md`） | **親だけ** | 返答・exit code・stderr |

- `<key>` は子の `instanceId`。別 worktree の子は `<worktree-id>@<instanceId>`。
- `<name>` は `<key>`（調査）/ `<key>.probe` / `<key>.warmup` / `<key>.challenge-<n>`。
- run-dir の path は、子から見て曖昧にならないよう**絶対 path**で書く。別 worktree の子は
  親の worktree の相対 path を解決できない。

送信文に調査契約を入れない。長い本文が Claude に途中から届いた事象（CommandMate#2464）が
発端だが、それが塞がっても短いまま保つ——何を見せ何を見せないかを、ファイル単位で統制できる
からである。送信文にあるのは「何を読み、何を読まず、何も書かず、どう締めるか」だけである。

## 2. 調査の送信文（INDEPENDENT）

必須の欄は cmate-delegate と同じ 5 つである。**1 つでも欠けたら送らない。**
加えて、次の 4 つを必ず含める。

1. 1 行目に `WEB: available | unavailable` を報告してから調査に入ること
2. `brief.md` と `roles/<key>.md` を読んでから始めること
3. run-dir の `agents/` と他の子の `roles/` を読まないこと
4. run-dir を含め、workspace に 1 byte も書かないこと

<!-- BEGIN SEND TEMPLATE ja -->
```text
【依頼】workspace 調査（cmate-workspace-research、run <run-id>）の独立調査をお願いします。

■ 目的
<Research Goal を 1〜2 行。例: このリポジトリを Node.js 24 へ移行してよいかを判断したい>

■ 対象
- workspace: <worktree-id>（path: <絶対 path>）
- 最初に次の 2 つを読み、それに従ってください: <run-dir の絶対 path>/brief.md と <run-dir の絶対 path>/roles/<key>.md

■ 出力の形
- 1 行目: 最初に公式 doc を 1 件 fetch し、`WEB: available — <URL>` か `WEB: unavailable — <理由>` を報告してから調査に入る
- 本文: roles/<key>.md の「Report」の 8 見出しで、このチャットに返す

■ 触ってはいけないもの
- run-dir を含め、workspace に 1 byte も書かない（ファイルの作成・編集、git の状態を変える操作、依存の更新をしない）
- run-dir の agents/ と、他の Agent の roles/ は読まない
- push / PR / deploy / 外部への書き込みをしない

■ 締め方
最後に `DONE:` で始まる 1 行で結論を要約してください。判断できない場合は `DONE: 判断不能 — <理由>` と書いてください。
```
<!-- END SEND TEMPLATE ja -->

<!-- BEGIN SEND TEMPLATE en -->
```text
[Request] Independent investigation for a workspace research run (cmate-workspace-research, run <run-id>).

# Purpose
<the Research Goal in one or two lines, e.g. decide whether this repository can move to Node.js 24>

# Target
- workspace: <worktree-id> (path: <absolute path>)
- Read these two files first and follow them: <absolute run-dir>/brief.md and <absolute run-dir>/roles/<key>.md

# Expected output
- First line: fetch one official document first, then report `WEB: available — <URL>` or `WEB: unavailable — <reason>` before you start
- Body: the eight headings under "Report" in roles/<key>.md, as your reply in this chat

# Do not touch
- Do not write a single byte into the workspace, the run-dir included (no file creation or edits, no git state changes, no dependency updates)
- Do not read the run-dir's agents/ or any other agent's roles/ file
- Do not push, open a PR, deploy, or write to any external system

# How to close
End with a single line starting with `DONE:` that summarises your conclusion. If you cannot decide, write `DONE: undecided - <reason>`.
```
<!-- END SEND TEMPLATE en -->

### 2.1 書き出し例外（`copilot` / `gemini` / `vibe-local` の子だけ）

転写リーダーの無い tool は `ask` の返答が pane 末尾 80 行に限られる。その子にだけ、上の雛形の
2 欄を次に差し替える。**それ以外の子に例外を与えない。**

- ■ 出力の形 — 「本文は roles/<key>.md の 8 見出しで `<run-dir の絶対 path>/agents/<key>.md` に書き、
  このチャットには `WEB:` 行と `DONE:` 行だけを返す」
- ■ 触ってはいけないもの — 「workspace に 1 byte も書かない。例外は
  `<run-dir の絶対 path>/agents/<key>.md` の 1 ファイルだけ」（他の 2 行はそのまま）

`run.json` の `agents[].write_exception` にその path を残す（[artifacts.md](./artifacts.md) 第3節）。

## 3. probe の送信文（CAPABILITY PROBE）

role を決める前に、Web と Workspace に届くかだけを確かめる。**調査を始めさせない。**

<!-- BEGIN PROBE TEMPLATE ja -->
```text
【依頼】調査の前の確認（cmate-workspace-research、run <run-id>）。まだ調査は始めないでください。

■ 目的
この後の調査で、あなたに Web と Workspace のどちらを任せられるかを決めたい

■ 対象
- <run-dir の絶対 path>/brief.md（run-dir で読むのはこれだけ）
- Web: brief.md の主題に関係する公式 doc を 1 件

■ 出力の形
次の 3 行だけを返す:
WEB: available — <fetch できた URL>（または WEB: unavailable — <理由>）
WORKSPACE: readable — <読めた path>（または WORKSPACE: unreadable — <理由>）
DONE: probe

■ 触ってはいけないもの
- workspace に 1 byte も書かない
- brief.md 以外の run-dir を読まない

■ 締め方
3 行目の `DONE: probe` で締める
```
<!-- END PROBE TEMPLATE ja -->

<!-- BEGIN PROBE TEMPLATE en -->
```text
[Request] A check before the research starts (cmate-workspace-research, run <run-id>). Do not start investigating yet.

# Purpose
Decide whether the research can rely on you for the Web, the workspace, or both

# Target
- <absolute run-dir>/brief.md (the only run-dir file you read)
- Web: one official document related to the subject of brief.md

# Expected output
Exactly three lines:
WEB: available — <the URL you fetched>   (or WEB: unavailable — <reason>)
WORKSPACE: readable — <the path you read>   (or WORKSPACE: unreadable — <reason>)
DONE: probe

# Do not touch
- Do not write a single byte into the workspace
- Do not read anything in the run-dir except brief.md

# How to close
End with the third line, `DONE: probe`.
```
<!-- END PROBE TEMPLATE en -->

## 4. warm-up の送信文（`running: false` の子だけ）

文面は固定である。訳さない。

<!-- BEGIN WARMUP TEMPLATE -->
```text
Stand by. A research request will arrive shortly. Reply with READY.
```
<!-- END WARMUP TEMPLATE -->

返答に `READY` が無い、または exit が 0 でない子は除外する（[SKILL.md](../SKILL.md) 第2.5節）。

## 5. `roles/<key>.md` の雛形

調査契約（仕様書 §15）はここに書く。子が読むファイルなので英語で書いてある。
`<...>` を埋め、role の段落は [roles.md](./roles.md) 第1節から写す。

<!-- BEGIN ROLE TEMPLATE -->
```markdown
# Role: <Workspace-first Researcher | External-first Researcher | Hybrid Researcher | Falsifier / Coverage Researcher | Workspace Falsifier | ...>

MODE: WORKSPACE_RESEARCH

- Run: <run-id>
- Original request: see brief.md (verbatim; do not restate it as a different goal)
- Workspace: <worktree-id> (<absolute path>)
- Permission mode: <prepared | files_only>
- Web capability you reported: <available | unavailable>
- AS_OF: <YYYY-MM-DD>

## Your role

<one paragraph from roles.md: what to look at first, and the main question you own>

## Rules

- Investigate independently. Do not read <absolute run-dir>/agents/ or any other agent's roles/ file.
- Do not write a single byte into the workspace, the run-dir included.
- prepared: read-only commands only (git status / git log / git show / npm ls / node --version / grep / find, tests that modify nothing).
  files_only: run no command at all; read files only.
- Do not assume general Web information automatically applies to this workspace.
- Do not settle an important conclusion on an unsourced search snippet.

## For every important finding, record

- Finding
- Source Type: WEB | WORKSPACE | DERIVED
- Locator
- Evidence Status
- Why it matters
- Assumptions
- Uncertainty

Evidence Status: VERIFIED | PARTIAL | CITED_NOT_VERIFIED | UNVERIFIED

## Locators

- WORKSPACE: `path:line`, `path:start-end` or `path::symbol`, relative to the workspace root. Never "the source code" or "the config file".
- WEB: `<exact URL> — <source name> (<source date or "date unknown">), as-of <YYYY-MM-DD>`.
  Prefer official / primary sources, then the original repository / issue / advisory,
  then authoritative secondary sources, then community discussion.

## Report (your reply in this chat, in this order)

WEB: available — <URL>   (or WEB: unavailable — <reason>)

# Conclusion
# Web Findings
# Workspace Findings
# Web ↔ Workspace Connections
# Assumptions
# Risks / Counterevidence
# Unknowns
# Recommended Next Checks

DONE: <one line that summarises your conclusion>
```
<!-- END ROLE TEMPLATE -->

差分が要る 2 つの子:

- **書き出し例外の子** — `## Rules` に 1 行足す: `Exception: write the report to <absolute run-dir>/agents/<key>.md (that one file only) and reply in chat with the WEB line and the DONE line only.`
- **別 worktree の子** — `## Locators` の WORKSPACE を `[<worktree-id>] path:line` にする。
  調べるのはその worktree であって、親の worktree ではない。

## 6. `brief.md` の雛形

全員が読む。仕様書 §29 の 7 見出しを、この順で置く。

<!-- BEGIN BRIEF TEMPLATE -->
```markdown
# Original Request

<request を一字も変えずに>

# Research Goal

<何を判断可能にするか。Original Request を別のゴールへ置き換えない>

# Workspace Scope

- Workspace: <worktree-id> (<absolute path>)
- AS_OF: <YYYY-MM-DD>
- Read-only. Nothing in the workspace is to be changed by this research.

# Web Questions

- <外部で確かめること>

# Workspace Questions

- <この workspace で確かめること>

# Key Uncertainties

- <結論を左右しそうな未知>

# Expected Output

- <結論の形。例: 移行可否 / blocker / 影響箇所 / 未確認事項 / 推奨検証手順>
```
<!-- END BRIEF TEMPLATE -->
