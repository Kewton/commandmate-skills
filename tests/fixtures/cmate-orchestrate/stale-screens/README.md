# stale-screens — `capture --json` of a session a previous turn left on a question (CommandMate#3007)

The dispatch runner reads `commandmate capture <worktree-id> --json` before a worker's
first send and stops when `isPromptWaiting` or `isSelectionListActive` is true
(`stale_prompt_on_session`). These three documents are what that capture returns on the
three Command Code screens the issue is about. A scenario points a worker at one with
`workers.<n>.stale_screen: "<file>"`; the fake CLI serves it from `capture` until a
`commandmate interrupt` has cleared it (see fake-cli.mjs).

| file | screen | flags the server publishes | source pane (Kewton/CommandMate `tests/fixtures/`, read only) |
|---|---|---|---|
| `askuserquestion.json` | AskUserQuestion the server can read | `isPromptWaiting: true`, `promptData` = the parser's golden | `command-code-askuserquestion-2522/question-flat-short.txt` + `promptdata-golden-2755.json` |
| `unreadable-question.json` | a question UI the parser refuses (multi-select checkboxes) | `isSelectionListActive: true`, `isPromptWaiting: false` | `command-code-askuserquestion-2522/unsupported-multi-select-checkboxes.txt` |
| `plan-review.json` | the plan review overlay (1.58.0) | `isSelectionListActive: true`, `isPromptWaiting: false` (`detect.ts`: `waiting` + the selection-list family, `hasActivePrompt: false`) | `command-code-plan-review-2761/plan-review-1-58-0.txt` |

`content` is the pane text with the `# …` header rows (they carry the probe host's path)
and the trailing blank rows removed. The flags follow `current-output-builder.ts`:
`isPromptWaiting` is the prompt the server could answer, `isSelectionListActive` is
`status === 'waiting'` with a selection-list reason. Neither is re-derived here.
