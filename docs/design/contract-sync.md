# 契約 mirror の同期手順

## 何が mirror なのか

`scripts/cmate_skills/` は **CommandMate 側の実装を写したもの**である。正本ではない。

| 本リポジトリ | 正本（`Kewton/CommandMate`） |
|---|---|
| `constants.py` | `src/lib/skills/constants.ts` |
| `semver.py` | `src/lib/skills/semver.ts` |
| `schema.py` | `src/lib/skills/schema.ts` |
| `safe_yaml.py` | `src/lib/skills/safe-yaml.ts` |
| `package.py`（読み戻し側） | `src/lib/skills/package-reader.ts` |
| `repo.py` の分類・照合 | `src/lib/skills/package-validator.ts` |
| — | `docs/design/agent-skills-distribution.md`（決定表 D-1..D-16 / 脅威 T-1..T-11） |
| — | `tests/fixtures/skills/contract/{manifest,catalog}/` |

現在 pin している upstream revision は
`scripts/validate.py` の `CONTRACT_UPSTREAM_REVISION` に書かれており、
CI の実行ログの先頭に必ず出力される。

## なぜ写しているのか

本リポジトリの CI は CommandMate の TypeScript を実行できない
（別 repository であり、CI で取得すると外部依存になる）。
一方で、CI が検証していないことを利用者の環境で初めて発見する形は許容できない。
そのため「生成物が upstream の parser を通ること」を CI 側で予測できるよう、
同じ規則を独立に実装している。

## 乖離すると何が起きるか

**CI は緑のまま、利用者の install が失敗する。**

これが最も避けたい失敗の形である。乖離は「厳しすぎる」方向と
「緩すぎる」方向で影響が違う。

- mirror が **より厳しい**: publish できない package が出る。CI が落ちるので気づける。
- mirror が **より緩い**: upstream が拒否する artifact を publish してしまう。
  Catalog に載った後、利用者の install 失敗として現れる。**こちらが危険。**

したがって、判断に迷う箇所は常に厳しい側へ倒す。

## 同期が必要になる契機

- CommandMate 側で `schema_version` が上がった
- `constants.ts` の上限値・pattern・予約語・enum が変わった
- `SKILL_YAML_SAFE_PROFILE` が変わった
- `package-reader.ts` の受理条件（archive root 規約、entry type、mode）が変わった
- `CLI_TOOL_IDS` に agent が増減した（`compatibility.agents[].agent` に直結する）
- CommandMate が本リポジトリの artifact を拒否した（乖離が既に起きている状態）

## 手順

1. CommandMate の `develop` を checkout し、
   pin されている revision からの差分を上表の file について確認する。

   ```bash
   git -C <CommandMate> log --oneline <pinned>..develop -- src/lib/skills/
   git -C <CommandMate> diff <pinned>..develop -- src/lib/skills/constants.ts
   ```

2. 差分を `scripts/cmate_skills/` へ反映する。
   **値を丸めたり、より便利な形に直したりしない。**
3. `scripts/validate.py` の `CONTRACT_UPSTREAM_REVISION` を新しい revision に更新する。
4. `python3 scripts/selftest.py` を実行する。
   upstream の invalid fixture に対応する test が `ManifestSchema` にあるので、
   契約が変わればここが落ちる。落ちなければ test を足す。
5. 生成物が **実際に** upstream の validator を通ることを確認する（次項）。

## 生成物を upstream の validator に通す（推奨・release 前必須）

mirror の正しさを最終的に保証する唯一の方法は、
本リポジトリが生成した artifact と Catalog を
CommandMate の TypeScript validator に食わせることである。

```bash
# 1. 本リポジトリ側で fixture を build
python3 scripts/build_release.py \
  --skill pipeline-selftest --skills-root tests/fixtures/skills \
  --out /tmp/xcheck --repository Kewton/commandmate-skills \
  --ref pipeline-selftest-v0.1.0 \
  --commit 0123456789abcdef0123456789abcdef01234567
printf 'x\n' > /tmp/xcheck/changelog.md
python3 scripts/build_catalog.py \
  --record /tmp/xcheck/pipeline-selftest-0.1.0.build.json \
  --catalog /tmp/xcheck/catalog.json \
  --changelog-file /tmp/xcheck/changelog.md \
  --published-at 2026-07-20T09:30:00Z
```

CommandMate 側で一時的な test を書き、以下を確認する。

- `inspectSkillPackage(bytes, { skillId, version })` が throw しないこと
- `validateSkillCatalog(JSON.parse(catalog))` の `.ok === true`
- artifact 内の `commandmate.skill.yaml` を `parseSkillYaml` → `validateSkillManifest` で
  通したときの `.ok === true`

確認後、一時 test は削除すること（CommandMate 側に本リポジトリ由来の
成果物への依存を残さない）。

## 意図的に upstream より厳しくしている箇所

mirror は既定では upstream と同じ判定にするが、
**「二人の reader が同じ byte 列を別々に読む」余地がある箇所は、
upstream が許容していても拒否する**。生成側である本リポジトリが
そのような package を出す理由がないためであり、方向としても安全側である。

| 箇所 | upstream | 本リポジトリ | 理由 |
|---|---|---|---|
| tar の octal 数値 field | NUL/space をどこでも読み飛ばす | 最初の終端子で打ち切り、以降は padding のみ許可 | `size` が「0」と「1024」に読み分かれると、次 header の位置がずれて entry を丸ごと隠せる |
| gzip stream の末尾 | 先頭 member のみ読む | 末尾に余剰 byte・連結 member があれば拒否 | 同上（reader ごとに別の内容を渡せる） |
| version 依存の plain scalar | parser 実装依存 | `yes`/`010`/`12:30` 等を拒否し quote を要求 | YAML 1.1 と 1.2 で型が変わる値は、CI と install で意味が変わる |
| archive root（検証時） | 省略・`<skill-id>`・`<skill-id>-<version>` を許可 | `verify_artifact.py` は `<skill-id>` のみを合格とする | 本 pipeline が生成しない形の artifact は、供給元が本 pipeline でないことを意味する |

これらを upstream に合わせて緩める変更を入れてはならない。
逆に upstream 側でこれらが修正されたら、この表から該当行を削ってよい。

## 検証済みの状態

`CONTRACT_UPSTREAM_REVISION = 22014bb9`（`Kewton/CommandMate` develop、
`feat(security): Skill packageの完全照合・安全な検査・展開基盤 (#1230)`）の時点で、
上記 3 点をすべて確認済み。`pipeline-selftest` 0.1.0 の artifact は
`inspectSkillPackage` を通過し、`rootName = "pipeline-selftest"`、
`computedRisk = low`、`effectiveRisk = low` として受理された。
