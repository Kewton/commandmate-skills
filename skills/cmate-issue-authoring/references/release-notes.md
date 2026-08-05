# Release notes

## planner mirror の同期規約

`scripts/validate-plan.mjs` は cmate-orchestrate planner の抽出の**逐語の写し**である。
この関係については、次の 1 文だけを正とする。

> planner mirror は **planner 本体と同じ commit で同時に変更する**。両者の一致は
> リポジトリの conformance テストが保証する。

**参照 planner の version 番号は書かない。** 0.5.0 より前は 3 箇所で別々の番号
（0.7.1 / 0.11.0 / 0.13.0）に割れており、どれも実物と一致していなかった。番号は必ず
腐るので、番号ではなく不変条件を書く。以下の changelog に残る番号は、その version の
package が公開された時点の履歴であって、現在の参照先ではない。

検証は**リポジトリの CI** が行う。install 先の package には conformance テストは
含まれない（`commandmate.skill.yaml` の `files:` に無いものは artifact に入らない）ので、
install 先で走らせるよう案内している箇所は無い。

## Changelog

### 0.5.0 — mirror の同期を機械で保証し、ペアの境界を双方向にする（Issue #62 / #65）

- planner mirror の一致を検証する conformance テストを追加した。定数を byte 単位で
  比較するだけでなく、両者のミラー領域を module として読み込んで corpus を流し、
  抽出結果が全 field 一致することを確かめる（定数が同じままコードだけずれる乖離は
  定数比較では捕まらないため）。比較対象は**ミラー領域だけ**であり、planner file 全体の
  digest は取らない。marker が動いて比較できなくなった場合は exit 2 で止まる。
- 参照 planner version の表記を 3 通りから 1 つの不変条件へ統一した（上記）。
- install 先に存在しない test への案内を 5 箇所から削除し、「リポジトリの CI が
  検証する」に改めた。install 先で確かめられるのは validator の exit code だけである。
- `cmate-issue-refinement` との境界を双方向に明記した。**split の勧告までが
  refinement、登録を伴う分割がこちら**である。境界は「GitHub に Issue を作るか否か」
  1 点で引く。refinement の `decomposition.children` をそのまま Feature 入力として
  受け取る受け渡しも SKILL.md に書いた。
- 語彙の対応表を [`plan-contract.md`](./plan-contract.md) 第 7 節と schema の
  `description` に置いた（`size` の帯・`parallel_safe` の 3 値・重複判定の値域）。
  **値域そのものは片方に寄せていない。** どちらの契約も v1 として公開済みで、
  値域の変更は既に出た artifact を遡って invalid にするからである（第 6 節）。
  この package の field の値域は 1 つも変わっていない。
- 本体 CommandMate の `/issue-create` `/issue-split` との関係を SKILL.md に明記した。
- SKILL.md の description を 200 字以内に縮め、`cmate-issue-refinement` と同じ言語・
  同じ構造（何を・いつ・そうでないときは相方へ）で対称に書き直した。

### 0.4.0 — 引用しかしない path を対象外として扱う（Issue #54）

- planner mirror に `CONTEXT_HEADING_RE` を同期した。「根拠」「出典」「参考」「参照」
  「背景」「関連」「References」「Context」等の見出し配下**にしか現れない** path は
  `suspected_files` に入らない（planner 本体と同時変更で、集合は byte 単位で同一）。
- 判定は出現ごとではなく path 単位である。散文で指示したうえで根拠にも引用した path は
  対象のまま残る（引用は指示を取り消さない）。`## 再現手順` `## 現状` `## 調査` は
  対象外の見出しに含めていない — バグ報告が直すべき file を挙げる場所だからである。
- 対象外の宣言方法を `issue-body-contract.md` の対象ファイル節に追記した。
  file をすべて根拠としてしか書かない Issue は `suspected_files` が空になり、
  planner が「Affected files are unclear」を立てる。

### 0.3.0 — planner mirror の path 抽出を token 先頭に固定（Issue #49）

- planner mirror の抽出 pattern を **token 先頭からしか一致しない**形に変えた。
  `web/src/lib/filter.ts` から `src/lib/filter.ts` を、
  `` `.claude/skills/x/scripts/a.sh` `` から `scripts/a.sh` を切り出していた挙動が
  止まる。抽出結果は `suspected_files` を経て worker の `scope.allow` になるため、
  途中一致は**実在しない path への書き込み権限**を配ることと同義だった。
  planner 本体と同時変更で、pattern は byte 単位で同一。
- 他の候補の path 境界つき suffix になっている候補は捨て、`shadowed_file_candidate`
  として `warnings` に積む（黙って落とさない）。
- 成果物の見出し配下に書かれた path が拡張子を問わず `suspected_files` に入る
  ようになった（Issue #50）。この振り分け規則を
  `issue-body-contract.md` の対象ファイル節に反映した。

### 0.2.0 — planner mirror の拡張子集合を同期（Issue #43 / CommandMate #1678 B-1）

- planner mirror の `FILE_EXT` に `geojson` / `topojson` / `geojsonl` を追加した。
  planner 本体と同時変更で、集合は byte 単位で同一。
- planner が、既知拡張子外の backtick path が抽出されなかった場合に plan の
  `warnings` へ `unrecognized_file_extension` を積むようになった（黙って落とさない）。
  この挙動を `issue-body-contract.md` の対象ファイル節に追記した。
- planner が、対象ファイルに依存 manifest（`package.json` 等）を含む Issue に
  同 directory の lockfile を既定許可として加え `scope_defaults` に明示するように
  なった（Issue #44 / CommandMate #1678 B-2）。lockfile を本文に書き並べる必要が
  無いことを `issue-body-contract.md` に追記した。

### 0.1.0 — initial release

- 公式カタログの Issue 工程の**上流**を埋める最初の package である。既存の
  `cmate-issue-refinement` は「既存 Issue の精錬」であり、SKILL.md に
  "not writing it from nothing" と明記されている。Feature 記述から Issue 群を起案する
  層はどの公式 Skill も持っていなかった。
- 2 phase・plan/approve 型。Phase 1 は read-only で分割計画を出し、Phase 2 は
  `--register` と明示承認の下でだけ `gh issue create` を実行する。
- 計画 artifact を versioned schema（`issue-split-plan.v1.json`）で定義し、Node 標準
  ライブラリのみの validator（`scripts/validate-plan.mjs`）を同梱した。schema file を
  読んで解釈するので、schema を直せば検証も変わる。
- 目標関数を「起案した Issue が cmate-orchestrate の planner に blocking question を
  立てられない品質であること」と定義し、**その条件を planner の実測から導いて**
  本文の契約（`issue-body-contract.md`）と validator の `planner_ready` rule に落とした。
- 重複ガードを手順に組み込んだ。既存 Issue と着地済み PR の両方を検索し、`duplicate`
  判定は open question で blocking しなければ計画が validator を通らない。
- Phase 2 は依存順に登録し、`{{issue:<key>}}` placeholder を `#<番号>` へ置換し、
  途中失敗を `skipped` として報告し、同じ `plan_id` の receipt があれば再登録を拒否する。

このテキストは、Catalog の `changelog` になる annotated tag message の元である。

## 期待する効果

- 「Feature はあるが Issue が無い」状態から、着手できる Issue 群までを 1 手順で渡せる。
- 起案された Issue がそのまま `cmate-orchestrate` の planner に入り、blocking question
  ゼロで Wave plan になる（本文の型がその条件を満たしているため）。
- 事実誤認を含む Issue が量産されない。裏取りできない主張は本文に入らず、open question
  として人間に返る。
- 既存 Issue や着地済み PR と重複した Issue が、作られる前に止まる。
- 承認前に GitHub が変更されない。計画は検証可能な artifact として残り、後から
  「何を根拠にこう割ったか」を辿れる。

## 制約

- **documentation 専用の Issue は、この planner の前では blocking question ゼロに
  できない。** planner は `docs/` 配下と `.md` / `.rst` / `.txt` を reference に分類し、
  suspected file には入れないためである（`issue-body-contract.md` 第 2.3 節）。計画に
  含めるなら `warnings` に `docs_only_issue` を積んで人間に判断を返す。
- `planner_ready` rule は planner の抽出の**写し**である。planner の抽出が変われば、
  この package も同時に変える必要がある（冒頭の同期規約）。写しである以上、
  install 済みの package 単体では正しさを確認できない。確認はリポジトリの CI が行う。
- 実機 dogfood のうち、**GitHub への実登録は未実施**である。計画 → 本文描画 →
  実物の planner まではリポジトリの CI が毎回機械的に検証しているが、
  `gh issue create` を実リポジトリへ流した記録は無い。
- Phase 2 は既存 Issue の本文を編集しない。依存される側への相互リンクは comment 1 件で
  行う。

## 再読込

Claude / Codex とも、更新の反映には**新しい session の開始**が要る。実効 version は
install 済み `commandmate.skill.yaml` の `version` で確認する。
