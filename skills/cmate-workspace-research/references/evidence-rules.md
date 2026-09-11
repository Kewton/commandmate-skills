# Evidence の規律

[SKILL.md](../SKILL.md) 第6〜9節と、子の role ファイルが従う規律の正本である。
元の運用（multi-agent-evolution-rules v7、110KB）から、技術調査に要る規律だけを抜いた。
Q-level・Goal Lock・run 間 continuity・coverage matrix は後続であり、ここには無い。

## 1. v7 から残した 10 項目

| # | 規律（v7 の節） | この Skill での形 |
|---|---|---|
| 1 | Goal invariance（4.1） | Original Request を一字も変えずに残し、Research Goal を別のゴールへ置き換えない |
| 2 | Independence before interaction（4.2） | 独立調査の間は他の子の結果を見せない。子は自分の role ファイルだけを読み、`agents/` を読まない |
| 3 | Evidence over consensus（4.6 / 4.15） | Agent の一致は Evidence ではない。process robustness の参考に留める |
| 4 | Source independence（5.6） | 同じ URL の重複は独立 evidence ではない。1 Finding の中で同じ locator を 2 回数えない |
| 5 | Evidence-to-Assertion（5.8 の軽量版） | Finding state が final の文言の強さを決める（第3節） |
| 6 | 同一ソース合意（20.4） | 2 つの子が同じ 1 本の記事に依拠して一致したら、独立 evidence は 1 である |
| 7 | 共有盲点（20.6） | 全員が一致した前提にも「それを反証する evidence は何か」を問う（[cross-check.md](./cross-check.md) 第2節） |
| 8 | 多数決（20.9） | 2 対 1 で結論を決めない |
| 9 | 検証済みだが不完全（20.16） | claim の一部だけを確かめたものは VERIFIED ではなく PARTIAL |
| 10 | stale unknown（20.17） | 初期調査の Unknown を、確かめずに解決済みとして持ち越さない |

## 2. Evidence の 3 分類

| 分類 | 例 |
|---|---|
| `WEB` | official docs、release notes、upstream の issue / advisory、standards |
| `WORKSPACE` | source、config、lockfile、CI、Dockerfile、test、log、git の情報 |
| `DERIVED` | WEB と WORKSPACE を繋いだ推論。**根拠にした Finding を必ず指す** |

MVP は 3 分類で足りる。細分化（`OFFICIAL_WEB` / `SOURCE_CODE` / `TEST_RESULT` …）はしない。

## 3. Finding state

| state | 条件 | final での書き方 |
|---|---|---|
| `VERIFIED` | claim そのものを、この run の中で開いた locator で確かめた（Workspace は親が `path:line` を読んだ。Web は子が一次ソースを fetch して該当箇所を示した） | 断定してよい |
| `PARTIAL` | claim の一部だけを確かめた | 確かめた部分と未確認の部分を分けて書く |
| `CITED_NOT_VERIFIED` | 出典は挙がっているが、この run の中で誰も開いていない（記憶・検索スニペット・二次引用） | 「未確認」と書く。結論の根拠にしない |
| `UNVERIFIED` | claim そのものを支える locator が無い（周辺の evidence はあってもよい） | 「未確認」と書く。結論の根拠にしない |
| `REJECTED` | 確かめた結果、claim が否定された | What Changed Through Cross Check か Risks に置く。支持材料として書かない |

**結論は `VERIFIED` と `PARTIAL` の Finding だけから組み立てる。**
未検証の Finding を、検証済みの事実と同じ強さで書かない。

## 4. locator

### 4.1 Workspace（§16）

workspace root からの相対 path ＋ 行（範囲）または symbol。

- Good: `package.json:14` / `docker/Dockerfile:23-31` / `src/auth/auth.service.ts::AuthService.login`
- Avoid: 「the source code」「the config file」「some test」、行の無い path だけ
- 別 worktree の子の locator は、先頭に `[<worktree-id>] ` を付ける（`[api-wt] src/app.ts:12`）

### 4.2 Web（§17）

exact URL / source name / source date / as-of date の 4 つを残す。

- Source priority: Official / Primary → Original repository / issue / advisory →
  Authoritative secondary source → Community discussion
- 重要な結論を、出所不明の検索スニペットだけで確定しない。

### 4.3 機械的に確かめる形

`final.md` の `### Workspace Evidence` / `### Web Evidence` の各行と、`evidence.md` の
`Workspace evidence:` / `Web evidence:` の各行（先頭の `- ` を除いた部分）は、次の正規表現
（Python `re`）のどれかに**全体一致**する。区切りは ` — `（または ` - `）である。

<!-- BEGIN LOCATOR RULES -->
```text
WORKSPACE_LOCATOR = ^(\[[A-Za-z0-9._-]+\] )?[^\s:\[\]]+(:[1-9][0-9]*(-[1-9][0-9]*)?|::[A-Za-z_$][A-Za-z0-9_$.#-]*)( (—|-) .+)?$
WEB_LOCATOR = ^https://[^\s]+ (—|-) .+[(（][^)）]+[)）], as-of [0-9]{4}-[0-9]{2}-[0-9]{2}$
NONE_LOCATOR = ^(なし|none) (—|-) .+$
```
<!-- END LOCATOR RULES -->

- `WORKSPACE_LOCATOR` の後ろの ` — <注記>` は任意（`package.json:14 — "pkg-x": "^3.4.2"`）。
- `WEB_LOCATOR` の括弧の中は source date。分からなければ `（date unknown）` と書く
  （`https://... — pkg-x Support Matrix（2026-06-30 更新）, as-of 2026-09-11`）。
- evidence の無い側は `NONE_LOCATOR` で理由を書く（`なし — Workspace 内の事実だけで決まる`）。
  空にしない。
- **Agent の名前は locator ではない。**「command-code もそう言った」は Evidence の行に書けない。
  誰が言ったかは `Agents:` の欄に書く（Agent consensus は Evidence ではない）。

`tests/fixtures/cmate-workspace-research/check_run.py` はこの節をそのまま読み、同じ正規表現で
fixture の `final.md` と `evidence.md` を検査する。ここを変えたら検査も変わる。
