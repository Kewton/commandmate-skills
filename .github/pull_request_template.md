<!--
本リポジトリの成果物は CommandMate が「検証済み供給元」として扱う。
review が供給元の信頼そのものなので、該当しない項目は削除せず「N/A」と書く。
-->

## 目的

<!-- 何を変えるか、なぜ必要か。関連 Issue へのリンク。 -->

## 変更種別

- [ ] 新しい Skill package の追加
- [ ] 既存 Skill package の変更
- [ ] pipeline / CI の変更
- [ ] 契約 mirror (`scripts/cmate_skills/`) の同期
- [ ] ドキュメントのみ

## 確認

- [ ] `python3 scripts/validate.py` が通る
- [ ] `python3 scripts/selftest.py` が通る
- [ ] `catalog/` を手で編集していない（release workflow の生成物）

### Skill package を追加・変更した場合

- [ ] `version` を上げた（公開済み version は immutable）
- [ ] `python3 scripts/manifest_files.py <dir>` で `files:` を再生成した
- [ ] directory 名 = manifest `id` = `SKILL.md` frontmatter `name` が一致する
- [ ] `declared_risk` が computed risk を下回っていない
- [ ] `capabilities` / `expected_outcomes` が「何ができるようになるか」を説明している
- [ ] 新たに script / 実行可能 file / network host を導入した場合、その理由を下に書いた

### 契約 mirror を変更した場合

- [ ] `docs/design/contract-sync.md` の手順に従った
- [ ] `scripts/validate.py` の `CONTRACT_UPSTREAM_REVISION` を更新した
- [ ] 生成物が upstream の `inspectSkillPackage` / `validateSkillCatalog` を通ることを確認した

## risk / security 上の注記

<!--
新しい permission、script、network host、外部依存を導入した場合はここに書く。
「宣言は enforcement ではない」ので、なぜそれが必要かを reviewer が判断できる形で。
なければ「なし」。
-->
