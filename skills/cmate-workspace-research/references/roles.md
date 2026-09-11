# role と割当規則

[SKILL.md](../SKILL.md) 第4節の正本である。

role は **CAPABILITY PROBE の後に**決める。Web に出られるかは Agent に依存し
（Codex は sandbox が network を既定で遮断する。gemini / copilot / antigravity の Web 到達は
測られていない）、External-first を機械的に割り当てると Web の無い子に Web 役が当たるからである。

ユーザーは Agent 名だけを指定する。role を人に選ばせない。

## 1. role の定義

各段落は `roles/<key>.md` の `## Your role` にそのまま写す。

### Hybrid Researcher（子が 1 つ）

Web と Workspace の両方を調べる。主な問いは「外部で分かっていることが、この Workspace に
とって何を意味するか」。Cross Check は自己反証だけになる。

### Workspace-first Researcher

最初に Workspace を理解する。優先: source / config / docs / tests / logs / dependencies /
git information。その後、Web で外部情報を確認する。
主な問い: **このWorkspaceでは実際に何が使われているか？**

### External-first Researcher

最初に外部情報を調べる。優先: official docs / release notes / GitHub issues /
security advisories / standards / papers / latest Web information。その後、Workspace への
適用可能性を確認する。主な問い: **外部世界では現在何が分かっているか？**
**`WEB: available` の子にだけ割り当てる。**

### Falsifier / Coverage Researcher（3 つ目の子）

他の子が共通して置いていそうな前提、見落とした候補、counterexample、stale information、
alternative explanation、missing evidence を重点的に探す。独立調査の段では他の子の結果を
見ないので、**「このテーマで人が普通に置く前提」を自分で挙げてから崩しにいく**。

### Workspace Falsifier（誰も Web に出られないときの 2 つ目の子）

Workspace の中で反証を探す。test、CI、lockfile、実行時設定、ログ、git 履歴。
Workspace-first の子が「使っていない」と言いそうなものを、使っている証拠から探す。

### 専門 role（子が 4 つ以上）

Security / Performance / Architecture / Cost / Competition / Compatibility / Verification から、
request に要るものだけを選ぶ。**Agent の数を増やすこと自体を目的にしない。**
既定は 2 子であり、3 つ目以降は役割が明確なときにだけ価値がある。

## 2. 割当規則

probe の報告から、子ごとに `web`（`available` / `unavailable`）と `workspace`
（`readable` / `unreadable`）が決まる。次の順に当てはめる。

0. **`web: unavailable` かつ `workspace: unreadable` の子は role を持てない。** 除外する
   （`status = failed`、`reason = capability: none`）。残りが 0 なら FAILED（`no_agents_left`）。
1. **Workspace-first には `workspace: readable` の子、External-first には `web: available` の子を
   当てる。** 両立する割当が複数あるときは `agents` の指定順で、先の子を Workspace-first にする。
2. 両立する割当が無いときは下の表に落ちる。

### 2.1 子が 1 つ

| web | workspace | role | coverage |
|---|---|---|---|
| available | readable | Hybrid | 通常 |
| unavailable | readable | Hybrid（Workspace only） | Workspace evidence only（§37.2） |
| available | unreadable | Hybrid（external only） | external evidence only（§37.3、`PARTIAL`） |

### 2.2 子が 2 つ（既定: Workspace-first と External-first）

| A の web | B の web | A | B | coverage |
|---|---|---|---|---|
| available | available | Workspace-first | External-first | 通常（`agents` の順） |
| available | unavailable | External-first | Workspace-first | 通常 |
| unavailable | available | Workspace-first | External-first | 通常 |
| unavailable | unavailable | Workspace-first | Workspace Falsifier | Workspace evidence only（§37.2） |

`workspace: unreadable` の子は External-first にしかなれない。2 つとも unreadable なら
External-first と Falsifier / Coverage（Web 側）にし、coverage を external evidence only に下げる
（§37.3、`PARTIAL`）。

### 2.3 子が 3 つ

A: Workspace-first / B: External-first / C: Falsifier / Coverage。
規則 1 を A と B に先に当て、C には残りの子を当てる。C は `web: available` を優先する
（stale information を外で確かめられるから）が、必須ではない。

### 2.4 子が 4 つ以上

A・B・C を 2.3 のとおりに決め、残りに専門 role を当てる。Web が要る専門 role
（Security の advisory 調査、Competition など）は `web: available` の子にだけ当てる。

## 3. 記録する

- `run.json` の `agents[].role` に role 名を、`agents[].capability` に probe の報告を書く。
- coverage を下げたら、`run.json` の `coverage` と final の Research Metadata に理由を書く。
- probe で止まった子（exit 10 など）は role を持たない。残りで 2.1〜2.4 をやり直す。
