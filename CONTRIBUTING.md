# Contributing

本リポジトリは CommandMate 公式 Skill の供給元である。
現時点で **外部からの contribution は受け付けていない**（Phase 1 の Non-goal）。
このドキュメントは maintainer と、公式 Skill を実装する各 Issue
（[#1239](https://github.com/Kewton/CommandMate/issues/1239) /
[#1240](https://github.com/Kewton/CommandMate/issues/1240) /
[#1241](https://github.com/Kewton/CommandMate/issues/1241)）の作業者向けである。

## 必要なもの

Python 3.11 以降のみ。pipeline は標準ライブラリだけで動くので、
`npm install` も `pip install` も不要である。

```bash
python3 scripts/validate.py    # 全package + Catalog を検証
python3 scripts/selftest.py    # pipeline 自体のテスト
```

---

## 新しい Skill package を追加する

### 1. fixture を出発点にする

```bash
cp -R tests/fixtures/skills/pipeline-selftest skills/<skill-id>
```

`tests/fixtures/skills/pipeline-selftest/` は「必要な要素をすべて持つ最小の
package」である。ここから削るのではなく、ここに足していく。

`<skill-id>` の規則:

- lowercase ASCII slug（`^[a-z0-9]+(-[a-z0-9]+)*$`）、64文字以内
- 予約語不可（`commandmate`, `system`, Windows の device 名 `con`/`nul`/`com1` など）
- **directory 名 = manifest の `id` = `SKILL.md` frontmatter の `name`**。
  3つが一致しない package は拒否される。利用者が review していない名前で
  install されることを防ぐためである。

### 2. `SKILL.md` を書く

Agent が読む標準 artifact。frontmatter は最小限にする。

```markdown
---
name: <skill-id と同じ>
description: <Agent が「この Skill を使うべきか」を判断するための1〜2文>
---

# <skill-id>

（Agent への手順書。命令形で、順序と、できなかった場合の扱いを書く）
```

`description` は Agent の discovery に使われるので、空にしない。
CommandMate 固有の配布 metadata は **ここに書かない**。`commandmate.skill.yaml` の責務である。

### 3. `commandmate.skill.yaml` を書く

配布・互換性・risk の宣言。schema は CommandMate 側 (#1228) が正本で、
`schema_version: 1` は **閉じた schema** である。未知の field は無視されず拒否される。

書くときに間違えやすい点:

| field | 注意 |
|---|---|
| `version` | SemVer 2.0。`v` prefix は不可（`1.2.0`、`v1.2.0` ではない） |
| `capabilities` / `expected_outcomes` | **空配列不可**。install 前に「何ができるようになるか」を説明できない Skill は成立しない |
| `compatibility.commandmate` | `>=0.11.0 <1.0.0` 形式。`\|\|` や `x` range は不可 |
| `compatibility.agents[].agent` | `claude` / `codex` / `gemini` / `vibe-local` / `opencode` / `copilot` / `antigravity` のみ |
| `compatibility.agents[].support` | `native` / `commandmate_runtime` / `unsupported` / `unknown`。`evidence` 必須。未検証なら `unknown` と正直に書く |
| `declared_permissions` | **宣言であって enforcement ではない**。実際に使うものだけを書く |
| `declared_risk` | 算出値より低く申告しない（後述） |
| `files` | 手で書かない（次項） |

YAML は安全な部分集合しか通らない。anchor / alias / merge key (`<<`) /
custom tag / 重複key / 複数document は拒否される。
普通に block mapping と block sequence だけを使えば問題ない。

加えて、**YAML の version によって型が変わる plain scalar は拒否する**。
`yes` / `no` / `on` / `off` は YAML 1.1 では boolean、1.2 では文字列であり、
`010` は 1.1 では 8 進数である。どちらに解釈されるかが読み手依存だと、
CI と install 時で manifest の意味が変わる。該当する値は quote すること。

```yaml
license: 'yes'     # 文字列として使いたいなら quote
executable: false  # boolean は true / false だけを使う
```

対象は `yes`/`no`/`on`/`off`/`y`/`n`、先頭 0 の整数、`0x`/`0o`/`0b` 表記、
`+` 付き数値、`_` 区切り数値、`.5`/`1.`、指数表記、`12:30` 形式、
`2026-07-20` 形式。エラーコードは `SKILL_YAML_AMBIGUOUS_SCALAR`。

### 4. `files:` を生成する

digest・size・kind・script・executable を手で維持すると、必ずどこかでずれる。

```bash
python3 scripts/manifest_files.py skills/<skill-id>
```

出力を manifest の `files:` にそのまま貼る。**payload を変更したら毎回やり直す。**

`commandmate.skill.yaml` 自身は `files` に入らない。
artifact 全体の SHA-256 は Catalog 側にあり、自己参照になるためである。

### 5. risk を正しく申告する

CommandMate は申告と独立に `computed_risk` を算出し、**高い方**を実効 risk とする。
低く申告しても緩和されないので、申告が低いと CI が落ちるだけである。

- `high`: 実行bit付き file を含む、または `credential_access` を宣言
- `moderate`: script file を含む、network host を持つ、
  `process_execution` または `filesystem_write` を宣言
- `low`: 上記以外

script の判定は拡張子（`.sh` `.py` `.js` `.ts` など）と shebang による。
広めに判定するので、「script のつもりはない」file も declare が必要になることがある。

### 6. 検証する

```bash
python3 scripts/validate.py
```

これが通れば、CI が見るものはすべて通っている。
build 再現性と strict reader の読み戻しまで含めて検証される。

### 7. Pull Request

- base branch は `develop`
- `catalog/` は **編集しない**（release workflow の生成物である）
- `.github/CODEOWNERS` により maintainer review が必須

---

## 既存 Skill を変更する

**`version` を必ず上げる。** 公開済み version は immutable である。
Catalog は install を artifact digest に固定しているので、
version を据え置いて byte 列を変えると、既存の receipt がすべて壊れる。

`build_catalog.py` は既に Catalog にある version の再登録を拒否する。

---

## Release（maintainer のみ）

1. `develop` → `main` を merge する。
2. annotated tag を打つ。**lightweight tag は不可**（tag の annotation が
   Catalog の `changelog` になるため、注釈のない release は拒否される）。

   ```bash
   git tag -a <skill-id>-v<version> -m "変更内容"
   git push origin <skill-id>-v<version>
   ```

3. `release.yml` が build → 再現性検証 → 承認待ちに入る。
4. `release` environment を承認すると、artifact → Catalog の順に publish される。

失敗した場合は [docs/runbooks/release.md](./docs/runbooks/release.md) の
rollback 手順に従う。**同じ tag を打ち直さないこと。** 新しい version を切る。

---

## `scripts/cmate_skills/` を触るとき

このディレクトリは CommandMate 側 (#1228 / #1230) の契約を写したものである。
値を「改善」してはならない。upstream と食い違った瞬間、
CI は緑のまま利用者の環境で install が失敗する。

変更手順は [docs/design/contract-sync.md](./docs/design/contract-sync.md) を参照。
