# Cross Check と Targeted Verify

[SKILL.md](../SKILL.md) 第6・7節の正本である。目的は多数決ではない。
**結論を変えうる Finding を選び、Evidence で確かめ、何が変わったかを残す**ことである。

## 1. 何を選ぶか（§19 / §20）

全 Finding を相互レビューしない。親が次の優先順位で選ぶ。

| 順位 | 選ぶもの | 例（Node.js 24 移行） |
|---|---|---|
| 1 | final conclusion に直結する | 「移行は問題ない」という結論そのもの |
| 2 | Agent 間で矛盾している | A「移行は問題ない」 / B「package X v3 は Node <=22 のみ supported」 |
| 3 | 複数の Agent が同じ前提を置いている | 両者とも「CI が Node 24 で緑なら安全」と見ている |
| 4 | Evidence が弱い | 検索スニペットだけの support 情報（`CITED_NOT_VERIFIED`） |
| 5 | 最新性が重要 | support matrix や release notes のように更新されるもの |
| 6 | Workspace と Web で結果が食い違う | Web は「v4 で対応」、workspace は v3 に固定 |

確認する型: contradiction / shared assumption / unsupported claim / version mismatch /
scope mismatch / stale information / Web ↔ Workspace mismatch / important omission。

## 2. 共有前提の問い（§22）

複数の Agent が同じ誤った前提を共有するケースは実際に起きている。だから**一致した項目も
安全とみなさない**。重要な共通前提ごとに、次の 2 つを問う。

```text
What assumption do all agents appear to share?
What evidence would falsify it?
```

`cross-check.md` の `Shared Assumptions` には、前提を 1 行、その前提を覆す evidence を
`反証:` として 1 行、書く。**空にしない。** 子が 1 つのときも、その子の前提を挙げる。

## 3. challenge の中身（`challenges/<key>.challenge-<n>.md`）

独立の段は終わっているので、**他の子の主張を名指しで見せてよい**。見せるのは主張と
その locator であって、他の子の返答全文（`agents/`）ではない。

<!-- BEGIN CHALLENGE TEMPLATE -->
```markdown
# Challenge <n> for <key>

Run: <run-id>. Re-read brief.md if you need to. Still do not read <absolute run-dir>/agents/.

## Claims to check

1. <another agent | your own report> says: "<claim>"
   - cited: <locator>
   - Check: <what to open, in this workspace and on the Web>
   - Decide: <the question this settles, e.g. is this a real blocker for this workspace?>

## Shared assumption to falsify

- <the assumption every report so far appears to share>
  What evidence would falsify it? <where to look>

## Reply

For each claim: VERIFIED / PARTIAL / REJECTED / UNVERIFIED, with the locator you actually opened
(WORKSPACE `path:line`, WEB `<URL> — <source> (<date>), as-of <YYYY-MM-DD>`).
Then one line on the shared assumption: held / falsified / undecided.
End with a line starting with `DONE:`.
```
<!-- END CHALLENGE TEMPLATE -->

§21 の例（Node.js 24 移行）なら、package X の主張に対する Check は次の 3 つになる。

1. Workspace の package X の version（manifest と lockfile の resolved）
2. 実際の利用箇所（どこで load しているか）
3. package X の公式 support matrix

## 4. challenge の送信文

送信文は短く、challenge ファイル 1 つを読ませるだけにする。5 欄は調査の送信文と同じ
（[research-brief.md](./research-brief.md) 第2節）。

<!-- BEGIN CHALLENGE SEND TEMPLATE ja -->
```text
【依頼】cross check（cmate-workspace-research、run <run-id>、challenge <n>）をお願いします。

■ 目的
<どの結論を確かめたいか。1 行>

■ 対象
- <run-dir の絶対 path>/challenges/<key>.challenge-<n>.md を読み、そこに挙げた claim を確かめてください

■ 出力の形
- challenge ファイルの「Reply」の形で、このチャットに返す

■ 触ってはいけないもの
- run-dir を含め、workspace に 1 byte も書かない
- run-dir の agents/ と、他の Agent の roles/ は読まない
- push / PR / deploy / 外部への書き込みをしない

■ 締め方
最後に `DONE:` で始まる 1 行で要約してください。
```
<!-- END CHALLENGE SEND TEMPLATE ja -->

<!-- BEGIN CHALLENGE SEND TEMPLATE en -->
```text
[Request] Cross check for a workspace research run (cmate-workspace-research, run <run-id>, challenge <n>).

# Purpose
<which conclusion this is meant to test, in one line>

# Target
- Read <absolute run-dir>/challenges/<key>.challenge-<n>.md and check the claims listed there

# Expected output
- The "Reply" format in that challenge file, as your reply in this chat

# Do not touch
- Do not write a single byte into the workspace, the run-dir included
- Do not read the run-dir's agents/ or any other agent's roles/ file
- Do not push, open a PR, deploy, or write to any external system

# How to close
End with a single line starting with `DONE:`.
```
<!-- END CHALLENGE SEND TEMPLATE en -->

`standard` の challenge は子ごとに 1 往復である。複数ラウンドは `deep`（後続）の領分である。

## 5. 子が 1 つのとき（自己反証）

他の子の主張が無いので、challenge は「あなたの結論を覆す evidence を探せ」になる。
Claims to check には、その子自身の結論と、それを支える最も弱い Finding を挙げる。
Shared assumption には、その子の報告が暗に置いている前提を挙げる。

## 6. Targeted Verify の分担（§23）

| 確かめるもの | 誰が | どうやって |
|---|---|---|
| Workspace の claim（version、利用箇所、config の値） | **親** | locator の path と行を読む（`filesystem_read`）。コマンドは使わない |
| Web の claim（support matrix、release notes、advisory） | `WEB: available` の子 | challenge に同梱するか、`challenge-2` を 1 往復だけ送る |
| test を回さないと分からないもの | 誰も確かめない | Unknowns と Recommended Next Actions に回す（Research ≠ Execution） |

親は Web に出ない。この Skill は network 権限を宣言していない。

## 7. `cross-check.md` の書き方

見出しは次の 7 つで、この順（雛形は [artifacts.md](./artifacts.md) 第5節）。

`Important Agreements` / `Important Contradictions` / `Shared Assumptions` / `Challenges Sent` /
`Verification Performed` / `Corrections` / `Remaining Disagreements`

- `Challenges Sent` には送った challenge ファイルと宛先を書く。
- `Corrections` は初期調査から変わったこと。無ければ `- 修正なし`。ここに書いたものが
  final の `What Changed Through Cross Check` になる。
- `Remaining Disagreements` は決着しなかった矛盾。無ければ `- なし`。

## 8. 未解決の矛盾（§37.4）

矛盾を無理に統合しない。どちらかの主張を「多い方」「もっともらしい方」で採らない。

`Remaining Disagreements` に書いたものは、final に **`UNRESOLVED CONTRADICTION`** として
必ず現れる。書くのは次の 4 つである。

1. どの claim とどの claim が食い違っているか
2. それぞれの evidence（locator）と Finding state
3. 決着に何が要るか（例: 別 branch で依存を上げて test を回す）
4. その矛盾が結論のどこを弱くしているか
