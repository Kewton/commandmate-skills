# Evidence

## R-001

- Finding: pkg-x 3.x は Node.js 24 を support 対象に含まない
- Status: VERIFIED
- Importance: HIGH
- Agents: antigravity（初期調査）, command-code（challenge-1 で support matrix を開いて確認）
- Workspace evidence:
  - package.json:15 — "pkg-x": "^3.4.2"
  - package-lock.json:18-19 — pkg-x は 3.4.2 に解決
  - package-lock.json:22-23 — pkg-x 3.4.2 の engines は node <23
- Web evidence:
  - https://pkg-x.example.com/docs/support-matrix — pkg-x Support Matrix（2026-06-30 更新）, as-of 2026-09-11
- Independent sources: 4
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

- Finding: Node の版は 22 系に 4 箇所で固定されている
- Status: VERIFIED
- Importance: MEDIUM
- Agents: command-code（初期調査）
- Workspace evidence:
  - package.json:8 — engines.node ">=20 <23"
  - .nvmrc:1 — 22
  - Dockerfile:1 — FROM node:22-bookworm-slim
  - .github/workflows/ci.yml:10 — node-version: [20, 22]
- Web evidence:
  - なし — Workspace 内の事実だけで決まる
- Independent sources: 4
- Assumptions: なし

## R-004

- Finding: CI は pkg-x の native binding を読み込まない（test が差し替える）
- Status: VERIFIED
- Importance: MEDIUM
- Agents: command-code（challenge-1）
- Workspace evidence:
  - test/blob-cache.test.js:9-11 — pkg-x/native を差し替える
- Web evidence:
  - なし — Workspace 内の事実だけで決まる
- Independent sources: 1
- Assumptions: なし

## R-005

- Finding: pkg-x 3.x の native binding は Node-API なので Node の major 更新で壊れない
- Status: REJECTED
- Importance: HIGH
- Agents: command-code（初期調査の前提）, antigravity（challenge-1 で否定）
- Workspace evidence:
  - なし — Web の記述で決まる
- Web evidence:
  - https://pkg-x.example.com/docs/support-matrix — pkg-x Support Matrix（2026-06-30 更新）, as-of 2026-09-11
- Independent sources: 1
- Assumptions: なし

## R-006

- Finding: pkg-x 4.0.0 の「open() is now async」が src/storage/blob-cache.js の同期呼び出しを壊すかは未確認
- Status: UNVERIFIED
- Importance: HIGH
- Agents: antigravity（challenge-1: 及ぶ）, command-code（challenge-1: 及ばない）
- Workspace evidence:
  - src/storage/blob-cache.js:8 — native.open(dir) を同期で呼ぶ
- Web evidence:
  - https://pkg-x.example.com/changelog#4.0.0 — pkg-x Changelog 4.0.0（2026-05-12）, as-of 2026-09-11
- Independent sources: 2
- Assumptions: changelog の文面だけでは対象の open() が決まらない

## R-007

- Finding: Node.js 24.0.0 のリリースノートに、この workspace が使う標準 API（node:http / node:test / node:assert）の破壊的変更は見当たらない
- Status: PARTIAL
- Importance: LOW
- Agents: command-code（初期調査）
- Workspace evidence:
  - src/server.js:3 — node:http
  - test/blob-cache.test.js:3-4 — node:test / node:assert
- Web evidence:
  - https://nodejs-release.example.org/blog/release/v24.0.0 — Node.js 24.0.0 release notes（2025-05-06）, as-of 2026-09-11
- Independent sources: 3
- Assumptions: リリースノートの要約に載らない変更は確かめていない
