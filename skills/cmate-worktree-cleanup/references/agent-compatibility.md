# Agent 差異と fallback

この Skill は特定の Agent の tool 名・命令形式に依存しない。SKILL.md は「何を検査し、
何を証明し、何を消すか」だけを規定し、「どの tool でそれを行うか」は各 Agent の裁量に委ねる。

Issue #1449 の受入条件は Claude と Codex 双方での dry-run/confirm 理解と result parity を
求めている。manifest の `compatibility.agents` では、SKILL.md の discovery 経路が確認できて
いる Claude と Codex を `native` として宣言する。

## 1. 必要な能力

この Skill が成立するために Agent 側へ求めるのは次の3つである。

| 能力 | 用途 | 無いときの動作 |
|---|---|---|
| command 実行（exit code が取れること） | git / gh の検査と削除、exit code 判定 | `status: failure`。この Skill は command 実行を前提とする |
| 対話確認 | apply 前の明示確認 | 確認できなければ `mode` を `dry_run` に留める（第3節） |
| 構造化出力 | plan / result 文書の生成 | `summary_markdown` に続けて JSON を単一 code block で出す |

network access は gh / git fetch に使う。fetch できない環境では
[proof-algorithm.md](./proof-algorithm.md) 第0節に従い、remote を要する候補を
`unverifiable` にする。

## 2. exit code が曖昧な場合

`git merge-base --is-ancestor` や `git update-ref -d` の判定は exit code に依存する。
Agent が exit code を確実に取得できない場合、その判定は **成立とみなさない**。
`command_failed` として `unverifiable` にする。**「たぶん成功した」で削除しない。**

## 3. 非対話 invocation

対話できない実行形態（batch 等）では、apply 前の明示確認を取れない。この場合は
`confirmation.granted` を null のままにし、`mode` を `dry_run` に留めて plan だけを返す。
**「対話できないから承認された」とはしない。** 削除は行わない。

## 4. gh が使えない / 認証が無い場合

`merged_equivalent` の判定には gh が要る。gh が無い・未認証・rate limit の場合、
その候補は `github_data_missing` として `unverifiable` になる。`direct`（ローカルの
祖先関係だけで閉じる）は gh 無しでも判定してよい。gh の認証 token を result に出さない。

## 5. context 長が足りない場合

候補が多い場合、worktree を1件ずつ検査して plan の該当要素を確定し、raw な command 出力は
保持しない。証跡は `pr_number` / `merge_commit_oid` / tip SHA など小さな値で足りる。
途中で保持を諦めた場合は、未検査の候補を `unverifiable` にはせず、plan を `partial` として
「未検査の候補が残っている」と `limitations` に明記する。

## 6. 出力形式

plan / result は JSON である。Agent が構造化出力の機構を持つ場合はそれを使う。
持たない場合は `summary_markdown` に続けて JSON を単一 code block で出す。
`summary_markdown` は文書の field であって、文書の代わりではない。片方だけを返さない。

## 7. 検証済みの組み合わせ

`compatibility.agents` に `native` と宣言するのは、discovery 経路が確認できた Agent だけである。
実機での品質評価を行った Agent と version、および profile（Node/CommandMate、
Rust/CommandAgent）の確認記録は、配布元リポジトリ
<https://github.com/Kewton/commandmate-skills> の
`tests/fixtures/cmate-worktree-cleanup/README.md` に記録する。この file は package には
含まれないので、install 済みの copy には無い。

`unknown` の Agent で動かないという意味ではない。確認していない、という意味である。
