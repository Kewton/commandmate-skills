# release notes

## 0.2.0 — 文脈の上限で止まった依頼を、完了ではなく失敗として返す（CommandMate#3011）

**何が起きたか。** 管理（Command Code）のセッションを長く使い続けたら、依頼が
`400 This model's maximum context length is 1048576 tokens. However, you requested 1070861 tokens`
で何もされずに終わった。ターンは終わるので `wait` / `ask` は `0` を返し、
通常の完了と区別がつかなかった。

**だからこう変えた。** CommandMate の CLI 側で `ask` が文脈の上限を既存の `11`（`UPSTREAM_FAULT`）で返し、
`--json` と stderr に `id=context-limit` を出す（CommandMate 側で実装）。新しい exit code は作らない。
この Skill は `ask.sh` が `11` を素通しにし、`id=context-limit` のときは「待っても送り直しても直らない。
`commandmate instances <wt> kill <instance>` で新しいセッションにして送り直す」と表に載せた。
CLI が未対応の版向けの保険として、`scripts/ask.sh` は上流が `0` を返したときに限り、返答の末尾 20 行を見て、
`⚠ Error: 400 This model's maximum context length is N tokens ...` がエラーとして行頭に出ていれば
`11` を返し、stderr に `id=context-limit` と kill の案内を出す。引用されているだけの語は当たらない。
Claude の `Prompt is too long` と OpenAI 系の `context_length_exceeded` は別 Issue で、検出しない。
定義は [exit-codes.md](./exit-codes.md) 第2.1節。

**送る前に文脈の量を測って勧める提案は実装していない。** 上流 CLI に、相手の文脈の量を読む
手段が無い。文脈の使用量（`sessionContext`）は opencode でしか取れず、Command Code では
取れない（CommandMate#3011 のやり取りで確認）。手段ができたら別 Issue で扱う。
