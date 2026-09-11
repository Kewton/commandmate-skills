# run-dir と成果物の雛形

[SKILL.md](../SKILL.md) 第2.4・5〜9節の正本である。run-dir は
**`.commandmate/workspace-research/<run-id>/`** で、**書くのは親だけ**である
（例外は書き出し例外の子の `agents/<key>.md` 1 ファイル）。

`brief.md` / `roles/<key>.md` / 送信文の雛形は [research-brief.md](./research-brief.md)、
challenge の雛形は [cross-check.md](./cross-check.md) にある。

## 1. 構成

```text
.commandmate/workspace-research/<run-id>/
├── run.json                           run の状態（第3節）
├── commands.log                       親が打った commandmate / git のコマンド（第4節）
├── brief.md                           FRAME。全員が読む
├── roles/<key>.md                     子ごとの調査契約。その子だけが読む
├── sent/<name>.txt                    親が実際に送った文面
├── agents/<name>.json                 ask --json の stdout
├── agents/<name>.exit                 ask の exit code
├── agents/<name>.log                  ask の stderr
├── agents/<key>.md                    書き出し例外の子だけ。子が書く
├── challenges/<key>.challenge-<n>.md  cross check で確かめてほしい claim。その子だけが読む
├── integrity/<worktree-id>.before.txt git status --porcelain（調査の前）
├── integrity/<worktree-id>.after.txt  git status --porcelain（調査の後）
├── cross-check.md                     第5節
├── evidence.md                        第6節
└── final.md                           第7節
```

`sent/<name>.txt` を送った `ask` の結果が `agents/<name>.json` / `.exit` / `.log` に入る。
送信文と返答は 1 対 1 であり、どの返答がどの文面への答えかを後から辿れる。

| `<name>` | いつ | `--timeout` |
|---|---|---|
| `<key>.warmup` | `running: false` の子だけ（SKILL.md 第2.5節） | 600 |
| `<key>.probe` | CAPABILITY PROBE（第4節） | 600 |
| `<key>` | INDEPENDENT（第5節） | 3600 |
| `<key>.challenge-<n>` | CROSS CHECK / TARGETED VERIFY（第6・7節） | 3600 |

## 2. `agents/<name>.json` の形

**形は exit code によって違う。必ず `.exit` を先に読む。**

exit 0 — 返答。`source` は `history`（チャット履歴から読んだ本文全文）か `pane`（画面の末尾 80 行）。
どちらでもない、または `reply` が空なら、返答は読めていない。

```json
{
  "worktreeId": "node-app",
  "instanceId": "command-code",
  "cliToolId": "command-code",
  "source": "history",
  "reply": "WEB: available — https://...\n\n# Conclusion\n...\n\nDONE: ..."
}
```

exit 10 — prompt JSON（1 行。`wait --on-prompt agent` と同じ形）。返答ではない。

```json
{"worktreeId":"node-app","cliToolId":"antigravity","type":"multiple_choice","question":"...","options":[{"number":1,"label":"Allow once","isDefault":true}],"status":"pending"}
```

124 / 21 / 99 / 2 / 1 — stdout は空のことが多い。理由は `.log`（stderr）に出る。

## 3. `run.json`

```json
{
  "run_id": "node24-migration-20260911-001",
  "request": "このrepoをNode.js 24へ移行して問題ないか調査して",
  "mode": "WORKSPACE_RESEARCH",
  "depth": "standard",
  "depth_requested": "standard",
  "status": "COMPLETED",
  "phase": "DONE",
  "as_of": "2026-09-11",
  "started_at": "2026-09-11T10:00:02+09:00",
  "completed_at": "2026-09-11T10:52:40+09:00",
  "self": { "worktreeId": "node-app", "instanceId": "claude", "cliTool": "claude" },
  "workspace": { "worktreeId": "node-app", "path": "/work/node-app" },
  "dispatch": "parallel",
  "ask_path": "ask",
  "preflight": {
    "permission_mode": "prepared",
    "gitignore": "ignored",
    "single_agent": false
  },
  "agents": [
    {
      "key": "command-code",
      "requested_as": "command-code",
      "worktreeId": "node-app",
      "instanceId": "command-code",
      "alias": "Command Code",
      "cliTool": "command-code",
      "running": true,
      "autoYes": true,
      "warmup": "not_needed",
      "capability": { "web": "available", "workspace": "readable" },
      "role": "Workspace-first",
      "write_exception": null,
      "source": "history",
      "exit_code": 0,
      "status": "completed",
      "reason": null
    }
  ],
  "coverage": { "web": "full", "workspace": "full", "reduced_by": [] },
  "workspace_integrity": { "worktrees": ["node-app"], "changed": false }
}
```

| field | 値 |
|---|---|
| `status` | `COMPLETED` / `PARTIAL` / `FAILED`（SKILL.md 第10.3節） |
| `phase` | 今いる段。`PREFLIGHT` / `FRAME` / `PROBE` / `INDEPENDENT` / `CROSS_CHECK` / `VERIFY` / `MERGE` / `SYNTHESIZE` / `DONE`。止まったらその段のまま残す |
| `depth` / `depth_requested` | 実行した depth（常に `standard`）と、要求された値 |
| `dispatch` | `parallel`（背景 ask ×N）/ `serial`（親が Codex のときの fallback） |
| `ask_path` | `ask` / `send-wait-capture`（[delegate-contract.md](./delegate-contract.md) 第3節） |
| `preflight.permission_mode` | `prepared`（人が子の権限を整えた）/ `files_only`（コマンド無し） |
| `preflight.gitignore` | `ignored` / `not_ignored`（`not_ignored` なら警告済みであること） |
| `agents[].warmup` | `not_needed` / `ready` / `failed` |
| `agents[].capability.web` | `available` / `unavailable` / `unknown`（probe に届かなかった） |
| `agents[].capability.workspace` | `readable` / `unreadable` / `unknown` |
| `agents[].write_exception` | 書き出し例外の path（`agents/<key>.md`）か `null` |
| `agents[].source` | `history` / `pane` / `file` / `null`（回収できなかった） |
| `agents[].exit_code` | 調査の `ask` の exit code（`agents/<key>.exit` と同じ値）。調査まで届かなかったら `null` |
| `agents[].status` | `completed` / `prompt_stopped` / `timeout` / `failed` |
| `agents[].reason` | `completed` 以外のときの理由。exit code と、人へ何を返したか |
| `coverage.reduced_by` | 完了しなかった子の `key` |
| `workspace_integrity.changed` | before と after が 1 つの worktree でも違えば `true` |

`agents[].status` は、その子の**調査の `ask`**（`<key>`）の exit code で決まる。調査まで届かなかった子は、
最後に届いた warm-up / probe の exit code で決まる。challenge が返らなかったことは status を変えず、
`cross-check.md` の `Challenges Sent` に書く。

| exit code | `status` |
|---|---|
| `0` かつ返答が読めた | `completed` |
| `0` だが返答が読めない（`reply` が空 / `source` が `history`・`pane` 以外） | `failed` |
| `10`、または `2` で stderr が `waiting on a prompt` | `prompt_stopped` |
| `124` | `timeout` |
| それ以外（`21` / `99` / ...） | `failed` |

`self`（親自身）は `agents` に入らない。入っていたら preflight が止めているはずである。

## 4. `commands.log`

親が打った `commandmate` と `git` のコマンドを、打った順に 1 行ずつ残す。
送信文の本体は `@sent/<name>.txt` と書いて参照する。

```text
2026-09-11T10:00:02+0900 commandmate whoami --json
2026-09-11T10:00:03+0900 commandmate instances node-app --json
2026-09-11T10:01:50+0900 git check-ignore -q .commandmate/workspace-research/node24-migration-20260911-001
2026-09-11T10:01:51+0900 git -C /work/node-app status --porcelain --untracked-files=all -- . :(exclude).commandmate/workspace-research
2026-09-11T10:02:10+0900 commandmate ask node-app --instance command-code @sent/command-code.probe.txt --timeout 600 --json
2026-09-11T10:04:30+0900 commandmate ask node-app --instance command-code @sent/command-code.txt --timeout 3600 --json
```

この log は run の**監査点**である。

- `commandmate respond` / `commandmate auto-yes` / `--auto-yes` / `commandmate interrupt` が
  **1 行も無い**こと（親は子の prompt に答えず、子の auto-yes を触らない）。
- 調査と challenge の `ask`（`@sent/<key>.txt` / `@sent/<key>.challenge-<n>.txt`）は
  `--timeout 3600 --json` を持ち、`--async` / `--reply-to` を持たないこと。
- `agents/<name>.json` の 1 つ 1 つに、それを作った `ask` の行があること。

## 5. `cross-check.md`

見出しは次の 7 つで、この順（§31）。書き方は [cross-check.md](./cross-check.md) 第7節。

<!-- BEGIN CROSS-CHECK TEMPLATE -->
```markdown
# Important Agreements

- <全員が一致した Finding と、それを何で確かめたか。一致そのものは Evidence ではない>

# Important Contradictions

- <X-1: <key> の主張 / <key> の主張 / それぞれの locator>

# Shared Assumptions

- <全員が置いていそうな前提>
  - 反証: <その前提を覆す evidence と、どこを見れば分かるか>

# Challenges Sent

- challenges/<key>.challenge-1.md → <key>（何を確かめさせたか）

# Verification Performed

- <親が読んだ path:line、子が開いた URL と、その結果>

# Corrections

- 修正なし

# Remaining Disagreements

- なし
```
<!-- END CROSS-CHECK TEMPLATE -->

`Corrections` に修正があれば、`- 修正なし` の代わりに final の `What Changed Through Cross Check`
と同じ `Initial:` / `Cross Check:` / `Verified:` / `Final:` の形で書く。
`Remaining Disagreements` に書いたものは final で `UNRESOLVED CONTRADICTION` になる。

## 6. `evidence.md`

Finding ごとに `## R-001` から。規則は [evidence-rules.md](./evidence-rules.md)。

<!-- BEGIN EVIDENCE TEMPLATE -->
```markdown
# Evidence

## R-001

- Finding: <1 文>
- Status: <VERIFIED | PARTIAL | CITED_NOT_VERIFIED | UNVERIFIED | REJECTED>
- Importance: <HIGH | MEDIUM | LOW>
- Agents: <この Finding を挙げた子と、どの段で。Evidence ではない>
- Workspace evidence:
  - <path:line — 注記>
- Web evidence:
  - <URL — source name（source date）, as-of YYYY-MM-DD>
- Independent sources: <重複を除いた locator の数>
- Assumptions: <なし | 前提>
```
<!-- END EVIDENCE TEMPLATE -->

- 無い側の evidence は `- なし — <理由>` と書く（数えない）。
- `DERIVED` の Finding は `- Derived from: R-001, R-002` を足し、根拠にした Finding を指す。
- **同じ URL / 同じ `path:line` を 1 つの Finding に 2 回書かない。** 2 つの子が同じ URL を
  挙げても、独立 evidence は 1 つである。`Independent sources` は重複を除いた数である。

## 7. `final.md`

見出しは次の順で、**すべて残す**（§33）。

<!-- BEGIN FINAL TEMPLATE -->
```markdown
# Research Question

<Original Request を一字も変えずに>

# Conclusion

<この Workspace に対する結論。VERIFIED / PARTIAL の Finding だけから組み立てる>

# What This Means for This Workspace

<外部の事実 → この Workspace の実際 → このプロジェクトへの含意>

# Key Findings

## Finding 1

- Finding: <1 文。UNVERIFIED / CITED_NOT_VERIFIED なら「未確認」と書く>
- Status: <VERIFIED | PARTIAL | CITED_NOT_VERIFIED | UNVERIFIED | REJECTED>
- Why it matters: <結論のどこに効くか>

### Workspace Evidence

- <path:line — 注記>

### Web Evidence

- <URL — source name（source date）, as-of YYYY-MM-DD>

# What Changed Through Cross Check

- 修正なし

# Risks / Counterevidence

- <リスクと反証>

# Unknowns

- <まだ分からないこと>

# Recommended Next Actions

1. <この Workspace について次にすべきこと>

# Sources

## Web

- <URL — source name（source date）, as-of YYYY-MM-DD>

## Workspace

- <path:line>

# Research Metadata

- Agents: <key（role, status）, ...>
- Workspace: <worktree-id>（<absolute path>）
- AS_OF: <YYYY-MM-DD>
- Depth: standard（requested: <depth_requested>）
- Coverage: <full | Research coverage reduced: <key> did not complete (<status>). | Web research unavailable. Result is based on Workspace evidence only. | Workspace research unavailable. Result is based on external evidence only.>
- Workspace integrity: <unchanged | changed> — git status --porcelain の before / after（run-dir を除外）
- Run: .commandmate/workspace-research/<run-id>/
```
<!-- END FINAL TEMPLATE -->

`What Changed Through Cross Check` に修正があるときは、`- 修正なし` の代わりに 1 件ごとに書く（§34）。

```markdown
### C-1

- Initial: <初期調査での判断と、それを出した子>
- Cross Check: <何がそれを揺らしたか>
- Verified: <何を開いて確かめたか>
- Final: <最終的な判断>
```

- 未解決の矛盾は `Risks / Counterevidence` に `**UNRESOLVED CONTRADICTION** — <中身>` として書く
  （[cross-check.md](./cross-check.md) 第8節）。
- `Workspace integrity: changed` のときは、`Risks / Counterevidence` に「workspace が変更された」と
  before / after の差分を書く。止めはしないが、隠さない。
- 完了しなかった子が 1 つでもあれば、`Coverage:` に `Research coverage reduced:` で始まる文を書き、
  その子の `key` と status を入れる（§37.1）。
