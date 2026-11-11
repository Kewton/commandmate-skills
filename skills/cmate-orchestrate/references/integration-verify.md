# 合流後の統合ブランチ検証（`--integration-verify`）の運転ノート

この文書は [SKILL.md](../SKILL.md) 第3.3節「合流後の統合ブランチ検証」の本文を**そのまま移送した**ものである。**削っていない・文言を変えていない。** 正本は [merge-contract.md](./merge-contract.md) 第5.4節で、食い違ったら正本が勝つ。

**wave barrier の後半である。** 「全 worker completed + verification pass」は
**1本ずつの branch** についての条件で、**合流後については何も言っていない**。
wave の衝突検出は `suspected_files` の重なりしか見ず、guarded merge が確認する CI は
**兄弟 PR が入る前の base** で走っているので、「片方がデータを直し、もう片方がそのデータの
性質に依存する検査を書く」類の**意味的衝突は誰にも捕まらない**
（[#175](https://github.com/Kewton/commandmate-skills/issues/175) の実測では develop に入った
直後から赤で、**発覚は promotion PR の CI** だった）。

- **やること**: この invocation の全 merge が終わったあと、`git fetch origin <base>` で合流後の
  tip を読み直し、**使い捨ての detached checkout** に取り出して **profile の `baseline`** を
  そこで回す。終わったら畳む。**invocation の作業ツリーには触れない。**
- **何を実行するかは profile から取る。** `npm` も `develop` も runner は持たない。
- **赤なら success にしない**（`partial` / exit 7 / `stop_reason: merge_failed` / 名指しは
  `blocking_reasons[]` の **`integration_verify_failed`**）。**次 wave を dispatch しない。**
  次 wave 側が読むのは `merge-report.json` の **`integration_verify.outcome`** で、
  進んでよいのは **`status: success` かつ `outcome: "pass"`** のときだけである
  （`"not_run"` は「測っていない」であって green ではない。field ごと無いのはフラグを
  使っていない run である）。**受け口の実装は
  [#183](https://github.com/Kewton/commandmate-skills/issues/183) が入れる**
  —— #175 では dispatch を1行も変えていない。
- **profile が `baseline` を宣言していなければ、1件も merge せずに拒否する**
  （`failure` / exit 1 / `preflight_failed` / `integration_verify_unavailable`）。
  opt-in した検証が走らないまま「完了」と報告されるのが、この機能が消しに来た事象そのものだからである。
- **既定 off で、フラグ無しの report は #175 以前と byte 単位で同一**である（fixture で固定）。
  `merge_schema_version` は 1 のまま、`stop_reason` にも `outcome` にも値を足していない。
- 代替案の **merge queue（base 更新 → CI 再走 → merge の直列化）は実装していない** ——
  まずは合流後検証の1段で足りる、が #175 の裁定である。
