# Evidence

## R-001

- Finding: pkg-x 3.x は Node.js 24 を support 対象に含まず、この workspace は 3.4.2 に解決している
- Status: VERIFIED
- Importance: HIGH
- Agents: command-code（初期調査、challenge-1 で再確認）
- Workspace evidence:
  - package.json:15 — "pkg-x": "^3.4.2"
  - package-lock.json:18-19 — pkg-x は 3.4.2 に解決
- Web evidence:
  - https://pkg-x.example.com/docs/support-matrix — pkg-x Support Matrix（2026-06-30 更新）, as-of 2026-09-12
- Independent sources: 3
- Assumptions: なし

## R-002

- Finding: この workspace は起動時に pkg-x の native binding を読み込む
- Status: VERIFIED
- Importance: HIGH
- Agents: command-code（初期調査）
- Workspace evidence:
  - src/storage/blob-cache.js:3 — require('pkg-x/native')
  - src/server.js:6 — 起動時に openCache を呼ぶ
- Web evidence:
  - なし — Workspace 内の事実だけで決まる
- Independent sources: 2
- Assumptions: なし

## R-003

- Finding: pkg-x 4.x へ上げたときに src/storage/blob-cache.js がそのまま動くかは未確認
- Status: UNVERIFIED
- Importance: MEDIUM
- Agents: command-code（challenge-1）
- Workspace evidence:
  - src/storage/blob-cache.js:8 — native.open(dir) を同期で呼ぶ
- Web evidence:
  - https://pkg-x.example.com/changelog#4.0.0 — pkg-x Changelog 4.0.0（2026-05-12）, as-of 2026-09-12
- Independent sources: 2
- Assumptions: なし
