# Research Question

このrepoをNode.js 24へ移行して問題ないか調査して

# Conclusion

現時点では Node.js 24 への移行は推奨しない。pkg-x 3.4.2 が Node 24 を support 対象に含まず（Finding 1）、この workspace は起動時に pkg-x の native binding を読み込む（Finding 2）。先に pkg-x を 4.x へ上げる必要がある。4.x へ上げたときに src/storage/blob-cache.js が壊れるかは未確認で、2 つの読みが残っている（UNRESOLVED CONTRADICTION）。

# What This Means for This Workspace

pkg-x の support matrix は 3.x の対象を Node 18 / 20 / 22 としている（外部の事実）。この workspace は lockfile で pkg-x 3.4.2 に解決し、src/storage/blob-cache.js:3 で native binding を読み込み、src/server.js:6 から起動時に呼ぶ（この workspace の実際）。したがって Node 24 に上げると起動時の native binding の読み込みが support 外になり、版指定 4 箇所（package.json / .nvmrc / Dockerfile / CI）を上げるだけでは足りない（このプロジェクトへの含意）。CI は native binding を差し替えて test するので、CI の matrix に 24 を足して緑になっても、この問題は見えない。

# Key Findings

## Finding 1

- Finding: pkg-x 3.x は Node.js 24 を support 対象に含まず、この workspace は pkg-x 3.4.2 に解決している
- Status: VERIFIED
- Why it matters: 移行の blocker。pkg-x を 4.x へ上げるまで Node 24 は support 外の組合せになる

### Workspace Evidence

- package.json:15 — "pkg-x": "^3.4.2"
- package-lock.json:18-19 — pkg-x は 3.4.2 に解決
- package-lock.json:22-23 — pkg-x 3.4.2 の engines は node <23

### Web Evidence

- https://pkg-x.example.com/docs/support-matrix — pkg-x Support Matrix（2026-06-30 更新）, as-of 2026-09-11

## Finding 2

- Finding: この workspace は起動時に pkg-x の native binding を読み込む
- Status: VERIFIED
- Why it matters: support 外の binding が起動経路に乗っている。使っていない依存ではない

### Workspace Evidence

- src/storage/blob-cache.js:3 — require('pkg-x/native')
- src/server.js:6 — 起動時に openCache を呼ぶ

### Web Evidence

- なし — Workspace 内の事実だけで決まる

## Finding 3

- Finding: CI は pkg-x の native binding を読み込まないので、CI の緑は Node 24 での互換性の根拠にならない
- Status: VERIFIED
- Why it matters: 「CI の matrix に 24 を足して緑なら安全」という両者の共有前提が崩れた

### Workspace Evidence

- test/blob-cache.test.js:9-11 — pkg-x/native を差し替える
- .github/workflows/ci.yml:10 — node-version: [20, 22]

### Web Evidence

- なし — Workspace 内の事実だけで決まる

## Finding 4

- Finding: pkg-x 4.x へ上げたとき src/storage/blob-cache.js の同期の open 呼び出しが壊れるかは未確認
- Status: UNVERIFIED
- Why it matters: blocker を外す手段（4.x への更新）の手間を左右する

### Workspace Evidence

- src/storage/blob-cache.js:8 — native.open(dir) を同期で呼ぶ
- src/storage/blob-cache.js::openCache

### Web Evidence

- https://pkg-x.example.com/changelog#4.0.0 — pkg-x Changelog 4.0.0（2026-05-12）, as-of 2026-09-11

# What Changed Through Cross Check

### C-1

- Initial: Node.js 24 への移行は版指定 4 箇所の更新で可（command-code の初期調査）
- Cross Check: pkg-x 3.x の support 対象が Node 18 / 20 / 22 だけ（antigravity の初期調査）
- Verified: lockfile は pkg-x 3.4.2 に解決し（package-lock.json:18-19）、起動時に native binding を読み込む（src/storage/blob-cache.js:3）。support matrix を command-code が開き、3.x の binary が Node-API ではないことを antigravity が確かめた
- Final: pkg-x を 4.x へ上げるまで Node.js 24 への移行は blocked

### C-2

- Initial: CI の matrix に 24 を足して緑になれば互換性は確かめられる（両者の共有前提）
- Cross Check: Shared Assumption Check
- Verified: test/blob-cache.test.js:9-11 が pkg-x/native を差し替えており、CI は native binding を読み込まない
- Final: CI の緑は native binding の互換性の根拠にならない。Risks に移した

# Risks / Counterevidence

- **UNRESOLVED CONTRADICTION** — pkg-x 4.0.0 の「open() is now async」が src/storage/blob-cache.js:8 の同期呼び出しに及ぶか。antigravity は「及ぶ」、command-code は「トップレベルの open() の話で native は変わらない」と読んだ。changelog の文面だけでは決まらない。4.x を入れて native binding を実際に読み込む test を回すまで決着しない。
- CI の緑は native binding の互換性を示さない（Finding 3）。Node 24 を CI に足しても、この blocker は見えない。
- Node.js 24 本体の変更は、リリースノートの要約で標準 API の範囲だけを確かめた（evidence.md R-007、PARTIAL）。

# Unknowns

- pkg-x 4.x の open() の変更が native binding に及ぶか（UNRESOLVED CONTRADICTION）
- 本番が Dockerfile 以外の経路（別の base image や host の Node）で動いていないか

# Recommended Next Actions

1. 別 task で pkg-x を 4.x へ上げ、pkg-x/native を差し替えずに読み込む test を 1 本足して回す（UNRESOLVED CONTRADICTION の決着）
2. その後に package.json:8 / .nvmrc:1 / Dockerfile:1 / .github/workflows/ci.yml:10 を Node 24 へ揃える
3. 本番の実行環境の Node の出どころを確認する

# Sources

## Web

- https://pkg-x.example.com/docs/support-matrix — pkg-x Support Matrix（2026-06-30 更新）, as-of 2026-09-11
- https://pkg-x.example.com/changelog#4.0.0 — pkg-x Changelog 4.0.0（2026-05-12）, as-of 2026-09-11
- https://nodejs-release.example.org/blog/release/v24.0.0 — Node.js 24.0.0 release notes（2025-05-06）, as-of 2026-09-11

## Workspace

- package.json:8
- package.json:15
- package-lock.json:18-19
- package-lock.json:22-23
- .nvmrc:1
- Dockerfile:1
- .github/workflows/ci.yml:10
- src/server.js:6
- src/storage/blob-cache.js:3
- src/storage/blob-cache.js:8
- test/blob-cache.test.js:9-11

# Research Metadata

- Agents: command-code（Workspace-first, completed）, antigravity（External-first, completed）
- Workspace: node-app（/work/node-app）
- AS_OF: 2026-09-11
- Depth: standard（requested: standard）
- Coverage: full
- Workspace integrity: unchanged — git status --porcelain の before / after が一致（run-dir を除外）
- Run: .commandmate/workspace-research/node24-migration-20260911-001/
