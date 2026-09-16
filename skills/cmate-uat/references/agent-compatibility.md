# Agent 差異、fallback、再読み込み

同じ手順を複数の Agent で読ませるため、この Skill は特定 Agent の tool 名・slash command・
subagent 機構に依存しない。ここでは差が出る点と、その埋め方を書く。

---

## 1. 依存しないもの

SKILL.md の手順は次のいずれも前提にしない。

- 特定の tool 名（`TodoWrite` / `AskUserQuestion` / `Read` / `Bash` などの固有名）
- subagent やタスク分割の機構
- 会話履歴・作業 directory・直前の実行結果といった暗黙 context
- `dev-reports/` のような特定 project の慣習的な path
- ブラウザ自動操作が使えること（第 2 節）

必要な入力は SKILL.md 第 1 節の表にすべて挙げてある。表にない情報を前提にしない。

---

## 2. 能力差と fallback

| 能力 | ある場合 | ない場合の fallback |
|---|---|---|
| command 実行 | 環境を立て、TC を実行する | **この Skill は使えない。** `status: failure` で停止し、environment を立てられないことを報告する |
| file 書き込み | 報告書・証跡・result document を書く | 報告書を標準出力へ出し、result document を code block で提示。書けなかったことを明示する |
| **ブラウザ操作** | 画面 TC を実行し、スクリーンショットを残す | `ui.e2e` があればそれを test command として実行する。無ければ該当 TC を `manual_pending` にして**申し送りへ**（第 3 節） |
| 利用者との対話 | `uat.yaml` が無ければ起案して承認を得る | **起案しない。** `uat_yaml_missing` で停止（SKILL.md 第 3.1 節） |
| network | `gh` で Issue を取得する | 受入条件を入力として渡してもらう。取得できなければ `failure` |

fallback を使った場合は、その事実を result document の `limitations` と報告書の申し送りに
**必ず書く**。**能力が無かったことは、条件が満たされたことを意味しない。**

---

## 3. 画面 TC の判断は Agent がする（人に聞かない）

画面を触る TC は、**TC ごとに「自分の道具で実行できるか」を実行者が判断する**。

```
ui.e2e の宣言がある      → それを実行する（Agent 非依存）
宣言が無く、操作手段がある → 実行し、スクリーンショットを証跡に残す
どちらも無い             → manual_pending。申し送りへ
```

**人に問い合わせて待たない。** この Skill は無人運転で使われる前提で、待つと run が止まる。
`manual_pending` は `cmate-orchestrate` の uat runner で `acceptance_conditional` になり、
owner が `human` の next action として人に届く —— **止まるのではなく、正直に人へ回る。**

Agent ごとの状況（2026-09-16 時点）:

| Agent | 画面 TC |
|---|---|
| ブラウザ拡張や Playwright 系の tool を持つ | 実行できる |
| Codex CLI（`--sandbox read-only`） | **network が既定で遮断される**ので、`ui.e2e` も落ちることがある。落ちたら `blocked`（`fail` に丸めない） |
| Command Code | 書き込み系 tool の許可が要る（[onboarding.md](./onboarding.md)） |
| それ以外 | `ui.e2e` が無ければ `manual_pending` |

---

## 4. Agent 別の状況

`commandmate.skill.yaml` の `compatibility.agents` が正本である。ここは補足で、
`support` の値は次を意味する。

- `native` — Agent 自身が install 先の `SKILL.md` を discovery できる
- `commandmate_runtime` — CommandMate の Runtime 経由で手順を渡す必要がある
- `unknown` — この version では検証していない。動かないという意味ではない

**`support` は discovery 経路の話であって、この手順を最後まで回せるかとは別である。**
環境を立てる手順なので、`command 実行`（第 2 節）が無い Agent では `native` でも使えない。

install 先の root は Agent ごとに違う。Claude は `.claude/skills`、Codex / Antigravity /
Command Code / opencode は `.agents/skills` を読む（Command Code と Antigravity は
`.claude/skills` を読まない）。CommandMate の installer は両方へ byte-identical に配置するので、
package 側で path を指定することはない。

---

## 5. 再読み込み（reload）

1. CommandMate 側で対象 Skill の新しい version を install する。
2. Agent の session を開始し直す。多くの Agent は SKILL.md を session 開始時に読み込むため、
   session を跨いだ自動反映は期待しない（Command Code は再起動不要、opencode は再起動が要る、
   Antigravity は未計測）。
3. 反映されたかは `SKILL.md` の frontmatter `name` と `commandmate.skill.yaml` の
   `version` を突き合わせて確認する。

install / update が script や hook を自動実行することはない。同梱 script は
`scripts/uat-env.sh` 1 本で、**実行 bit は付いていない**（`bash scripts/uat-env.sh …` で呼ぶ）。

---

## 6. 実行環境の記録

再現性の主張には、次が揃っている必要がある。

1. Agent 名と version
2. Skill の `id` と `version`
3. 対象 repository の commit SHA と、作業 tree が dirty かどうか
4. **使ったポートと `isolation.checks` の実測結果**（この Skill 固有）

いずれかが欠けた実行は、報告書で「再現条件が不完全」と明示する。
