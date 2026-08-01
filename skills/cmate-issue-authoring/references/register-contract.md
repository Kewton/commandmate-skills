# Phase 2（登録）の契約

承認された計画を GitHub の Issue にする step である。**この Skill で唯一 mutation を
持つ経路**であり、そこに至る条件は 3 つとも満たされていなければならない。

1. `--register` が明示されている。
2. `node scripts/validate-plan.mjs <plan.json>` が exit 0 である。
3. 人間が**その計画**を承認した。

3 について: 「Issue を作って」は計画の承認ではない。承認とは、人間が計画（Issue 一覧・
依存・重複の疑い・open question）を見たうえで、それを登録してよいと言うことである。
open question が 1 件でも未解決なら承認を求めない。

## 1. 二重登録ガード

登録が終わったら receipt を計画と同じ directory に書く。

```json
{
  "receipt_version": 1,
  "plan_id": "split-ae26c30119f1",
  "repository": "Kewton/CommandMate",
  "registered": [
    {"key": "session-store-rotation", "number": 1620, "url": "https://github.com/Kewton/CommandMate/issues/1620"}
  ],
  "skipped": [
    {"key": "rotation-metrics", "reason": "gh issue create failed: HTTP 403"}
  ]
}
```

**同じ `plan_id` の receipt が既にあるなら、既定で登録を拒否する。** 同じ Feature 記述から
同じ割り方で作った計画は同じ `plan_id` になるので、計画を作り直しても再登録は防げる。

続けたい場合（前回が途中で失敗した等）は、`skipped` に残っている key だけを対象に、
人間の明示指示のもとで再開する。receipt を消して最初からやり直させてはならない。

## 2. 登録順

**依存順**（依存先が先）に登録する。`depends_on` を満たす順序は計画時点で DAG が
保証されているので必ず存在する。

依存先を先に作ることで、本文の `{{issue:<key>}}` placeholder を `#<番号>` に置換できる。
置換できない placeholder が残ったまま投稿してはならない（依存が失われるうえ、
planner が読めない）。

## 3. 相互リンク

- **依存する側**: 本文の `## 依存` 節に `depends on #<番号>` が入る（placeholder の置換結果）。
- **依存される側**: 依存する Issue がすべて登録できた後で、`gh issue comment` で
  「#N がこの Issue に依存している」と 1 件だけ記録する。**本文は書き換えない**
  （本文の編集は既存 Issue の変更であり、この Skill のスコープ外である）。

ラベルは計画の `labels` を `gh issue create --label` で付ける。存在しないラベルは
`gh` がエラーにするので、**先に `gh label list` で実在を確認する**。存在しないラベルを
作るかどうかは人間の判断であり、勝手に作らない。

## 4. 実行

```bash
gh issue create --repo <owner/name> \
  --title "<title>" \
  --body-file <本文を書き出した file> \
  --label "<label>" --label "<label>"
```

`--body-file` を使う。`--body` に長い Markdown を渡すと shell の quoting で本文が壊れる。

## 5. 途中で失敗したとき

1 件失敗したら**そこで停止する**。残りは `skipped` として receipt と報告の両方に載せる。

- 成功に丸めない。「3 件中 2 件成功」を「登録しました」と報告してはならない。
- 作成済みの Issue を巻き戻す（close する）ことはしない。close は人間の判断である。
- 失敗理由（HTTP status、`gh` の stderr）をそのまま残す。要約して消さない。

## 6. 登録後

作成した Issue 番号を報告し、次の行動と実行者を述べる。

- 出口品質に届かなかった Issue → `cmate-issue-refinement` で精錬する（人間が判断）。
- 実行計画を立てる → `cmate-orchestrate` の planner に Issue 番号を渡す。
- 実行契約を書く → `cmate-task-contract`。

この Skill は登録後の Issue を編集しない。close しない。ラベルを張り替えない。
