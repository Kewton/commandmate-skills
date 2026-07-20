# AGENTS

- `app/` は App Router の route のみを置く。ビジネスロジックは `lib/` へ置く。
- `lib/` の各 module には同じ directory に `*.test.ts` を置く。
- session に関わる変更は必ず `lib/auth/session.ts` を経由させる。
  route から cookie を直接読み書きしない。
- 環境変数は `lib/config.ts` の `readEnv()` 経由でのみ参照する。
