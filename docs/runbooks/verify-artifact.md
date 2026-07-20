# Runbook: 公開 artifact の keyless 検証

対象読者: 本リポジトリの release を独立に検証したい人（maintainer / 監査 / 利用者）。

本リポジトリの artifact に署名はない。代わりに、
**誰でも辿れる checksum の連鎖**と**再現可能 build** がある。
この runbook はその 2 つを実際に確認する手順である。

---

## 検証 A: 公開された artifact が Catalog と一致するか

「配布されている byte 列が、Catalog が約束したものか」を確認する。
所要 1 分。

### A-1. Catalog と artifact を取得する

```bash
SKILL=cmate-issue-refinement
VERSION=1.0.0
REPO=Kewton/commandmate-skills

curl -fsSL -o catalog.json \
  "https://raw.githubusercontent.com/${REPO}/main/catalog/v1/catalog.json"

curl -fsSL -o "${SKILL}-${VERSION}.tar.gz" \
  "https://github.com/${REPO}/releases/download/${SKILL}-v${VERSION}/${SKILL}-${VERSION}.tar.gz"
```

### A-2. checksum だけを見る（tool 不要）

```bash
curl -fsSL "https://github.com/${REPO}/releases/download/${SKILL}-v${VERSION}/${SKILL}-${VERSION}.tar.gz.sha256" \
  | sha256sum -c -
```

`OK` が出れば、release asset は release 時に記録された digest と一致する。
ただしこれは release asset 内部の整合しか見ていない。
**Catalog が同じ digest を指しているか**は次で確認する。

### A-3. 連鎖全体を検証する

```bash
python3 scripts/verify_artifact.py \
  --catalog catalog.json \
  --skill "${SKILL}" \
  --version "${VERSION}" \
  --artifact "${SKILL}-${VERSION}.tar.gz"
```

このコマンドは以下を順に確認する。

```
Catalog が schema_version 1 を満たす
Catalog にその version が載っている            → resolved commit SHA を表示
artifact の SHA-256 が Catalog と一致する
artifact の size が Catalog と一致する
asset 名が <skill-id>-<version>.tar.gz である
content_type が application/gzip である
archive が strict reader を通る                 → root directory / entry 数
必須 entry (SKILL.md / commandmate.skill.yaml) がある
manifest が safe YAML profile で parse できる
manifest が schema_version 1 を満たす
manifest の id / version が Catalog と一致する
manifest の files が archive の payload と完全一致する
各 payload file の digest / size / 実行bit / script 宣言が一致する
Catalog の declared_risk が manifest と一致する
```

最後に `VERDICT: ACCEPT` または `VERDICT: REJECT` を出し、
exit code もそれに従う。

### A-4. 出力の読み方

```
skill            cmate-issue-refinement 1.0.0
provider         CommandMate  license MIT
source commit    3f2a...（40桁）
declared risk    low
computed risk    moderate
effective risk   moderate
permissions      filesystem_read, process_execution
                 declared by the publisher; not sandbox enforcement
scripts          scripts/collect.sh
executables      (none)
```

- `computed risk` が `declared risk` より高い場合、**実効値は高い方**である。
  publisher の申告で緩和されることはない。
- `permissions` は **宣言であって隔離ではない**。
  「この Skill はこれを使うと言っている」以上の意味はない。
- `scripts` に file がある場合、install しただけでは実行されないが、
  Agent が手順に従って実行しうる。中身を読んでから install する。

---

## 検証 B: source から artifact を再現する

「その artifact が本当にその commit から作られたか」を、
release を信じずに確認する。所要 2 分。

### B-1. Catalog が指す commit を checkout する

```bash
COMMIT=$(python3 - <<'EOF'
import json
catalog = json.load(open("catalog.json"))
entry = next(e for e in catalog["entries"] if e["id"] == "cmate-issue-refinement")
version = next(v for v in entry["versions"] if v["version"] == "1.0.0")
print(version["source"]["commit"])
EOF
)

git clone https://github.com/Kewton/commandmate-skills.git
cd commandmate-skills
git checkout "${COMMIT}"
```

**tag ではなく commit SHA で checkout すること。** tag は後から動かせる。

### B-2. 同じ artifact を build する

```bash
python3 scripts/build_release.py \
  --skill cmate-issue-refinement \
  --repository Kewton/commandmate-skills \
  --ref "cmate-issue-refinement-v1.0.0" \
  --commit "${COMMIT}" \
  --out /tmp/reproduce
```

出力の `sha256` が Catalog の `artifact.sha256` と一致すれば、
**公開されている artifact はその commit の内容そのものである。**

```bash
sha256sum /tmp/reproduce/cmate-issue-refinement-1.0.0.tar.gz
diff /tmp/reproduce/cmate-issue-refinement-1.0.0.tar.gz \
     ../cmate-issue-refinement-1.0.0.tar.gz && echo "byte-identical"
```

`build_release.py` は内部で 2 回 build して一致を確認しているので、
このコマンドが成功した時点で再現性そのものも検証されている。

---

## 一致しなかったとき

**その artifact を install しないこと。** そして次を切り分ける。

| 症状 | 意味 | 対応 |
|---|---|---|
| A-2 は OK、A-3 の Catalog digest 照合が FAIL | Catalog と release asset が食い違っている | Catalog の生成漏れ、または publish 順序の失敗。[release runbook](./release.md) の rollback 判定へ |
| A-3 の archive 検証が FAIL | download 経路の破損、または改竄 | 再 download。再現するなら security advisory へ非公開報告 |
| A-3 の file set / digest が FAIL | manifest と payload が食い違う package が publish された | **security 事案として扱う。** advisory へ非公開報告 |
| B-2 の digest が一致しない | artifact が source 由来でない、または build が再現していない | commit SHA を再確認。合っているなら security 事案 |

報告先と要領は [SECURITY.md](../../SECURITY.md) を参照。
**secret や payload の中身を public issue に貼らないこと。**

---

## この検証が保証しないこと

- 配布経路そのもの（GitHub の release / raw content）の完全性には依存している。
  Catalog を取得した経路自体が改竄されていれば、この連鎖は「改竄された Catalog に
  対して整合している」ことしか示さない。署名 / transparency log は Phase 6 の課題である。
- Skill の**内容**が安全かどうかは検証しない。
  digest の一致は「review された byte 列であること」を示すだけである。
