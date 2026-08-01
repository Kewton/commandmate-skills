# 重複ガード

新しい Issue を作る前に、**同じ仕事が既に tracked か、既に着地しているか**を調べる。
省略できる step ではない。重複した Issue は、それを掴んだ worker の時間ごと無駄になる。

調べる先は 2 つある。**片方だけでは足りない。**

- **既存 Issue**（open / closed 両方）— 同じ仕事が既に立っていないか。
- **着地済み PR**（merged）— 既に実装されていないか。closed されずに残った Issue や、
  Issue を伴わずに merge された PR は、Issue 検索だけでは見えない。

## 1. 手順

検索語は、Feature から**名詞**を取って作る。動詞や「改善」「対応」のような語は
ノイズしか返さない。

```bash
# 1. 既存 Issue（open + closed）
gh issue list --repo <owner/name> --state all \
  --search "<名詞> <名詞> in:title,body" --limit 30 \
  --json number,title,state,url

# 2. 着地済み PR
gh pr list --repo <owner/name> --state merged \
  --search "<名詞> <名詞>" --limit 30 \
  --json number,title,mergedAt,url

# 3. 対象 file を触った着地済み PR（file 名は最も強い検索語である）
gh pr list --repo <owner/name> --state merged \
  --search "<file 名>" --limit 30 --json number,title,url
```

どちらも read-only である。`gh issue list` / `gh pr list` は GitHub に何も書かない。

計画には、実行した command をそのまま `commands` に `mutating: false` で記録する。
記録しておくと、後から「何を検索して見つからなかったのか」が検証できる。

## 2. 判定

候補ごとに 1 つだけ選ぶ。

| verdict | 意味 | 計画での扱い |
|---|---|---|
| `duplicate` | 範囲がそのまま重なる | **open question で blocking する。登録しない** |
| `overlapping` | 一部が重なる | 警告として載せ、境界を本文に書く |
| `unrelated` | 語が似ているだけ | 載せない（載せるならその旨を `overlap` に書く） |

**title が似ていることは重なりではない。** `overlap` には「何がどう重なるか」を、
file 名か機能の単位で書く。書けないなら `unrelated` である。

`duplicate` と判定したものを黙って新規 Issue にしてはならない。validator の
`duplicate_needs_open_question` rule がこれを機械で強制する（[plan-contract.md](./plan-contract.md) 第 5.2 節）。

## 3. 検索できなかったとき

`gh` が無い、認証が無い、network が無い、rate limit に当たった —— どれであっても
**「重複は無い」と結論してはならない**。

```json
{"code": "duplicate_search_skipped", "detail": "gh pr list が rate limit で失敗した（既存 Issue 検索のみ実施）"}
```

を `warnings` に積み、人間に判断を返す。空の `duplicate_suspicions` は
「検索して見つからなかった」を意味するので、未実行と区別できなければならない。
