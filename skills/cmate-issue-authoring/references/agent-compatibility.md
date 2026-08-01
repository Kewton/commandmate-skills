# Agent 対応と代替

`SKILL.md` の手順は tool 名ではなく **capability** で書いてある。各 Agent は自分の持つ
tool を当てる。持たない capability には代替を使い、使ったことを `warnings` に記録する。
語彙が変わらないので、Agent が違っても結果を field 単位で突き合わせられる。

## 手順が必要とする capability

| Capability | 何に使うか | 無いときの代替 |
|---|---|---|
| checkout の file を読む | 実査と evidence | 該当箇所を caller に貼ってもらい、evidence の `kind` を `input` にする |
| checkout を pattern 検索する | 主張の根拠になる seam を探す | directory 一覧から候補を名前で開く |
| read-only の shell command を実行する | `gh issue view` / `gh issue list` / `gh pr list` / `git ls-files` | Feature 記述を caller から受け取り、重複検索は `duplicate_search_skipped` を warning に積む |
| Node を実行する | 計画の機械検証（`scripts/validate-plan.mjs`） | **代替は無い。** 検証していない計画は承認に回さない |
| 構造化された質問を返す | open question | 対話できなくてもよい。`open_questions` に積んで承認を求めずに終える |
| 長い構造化出力を出す | 計画 artifact | artifact を先に、要約を後に出す。要約に合わせて artifact を切り詰めない |

対話は**どこでも任意**である。質問できない Agent が詰まることは無い。聞けなかった質問は
`open_questions` になり、その run は承認を求めずに終わる。これは設計された縮退であって
失敗ではない。

Node だけは代替が無い。validator は Node の標準ライブラリのみで動くので、Node 18 以降が
あれば追加 install は要らない。無い環境では計画を「未検証」として明示し、
**承認を求めない**。

## 記録されている support

| Agent | Support | 根拠 |
|---|---|---|
| `claude` | native | Claude Code 2.1.220 / 2026-07-26 実測: `.claude/skills` から `SKILL.md` を発見し、slash palette に一致する（`.agents/skills` は読まない）。経路は package 非依存であり、**本 package を個別に測ってはいない** |
| `codex` | native | Codex CLI 0.145.0 / 2026-07-26 実測: `.agents/skills` から `SKILL.md` を読む（model の自己申告であり機械的証跡ではない）。当該 version は skill を slash command として露出しないので名前で呼ぶ。**本 package は個別に測っていない** |
| `gemini` | unknown | 未計測 |
| `opencode` | unknown | 未計測 |

`support` は **discovery 経路**の記録である。CommandMate 0.15.0 以降、package は
`.agents/skills/<skill-id>/` と `.claude/skills/<skill-id>/` の両方へ byte-identical に
配置されるので、上の測定はどの package にも効く。**手順の出来を表すものではない。**

`unknown` は意図的である。誰も測っていない Agent を `native` と書けば、compatibility
block はそれが存在する理由である判断に使えなくなる。測ったら entry を動かし、
Skill の version を上げる。

## Agent によって変わらないもの

安全境界（[safety.md](./safety.md)）、本文の契約
（[issue-body-contract.md](./issue-body-contract.md)）、計画の schema、Phase 2 の承認条件、
completion check は、どの Agent でも同一である。満たせない Agent は**弱い規則に
差し替えず**、満たせなかったことを報告する。
