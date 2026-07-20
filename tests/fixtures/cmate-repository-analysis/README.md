# cmate-repository-analysis の評価

`skills/cmate-repository-analysis/` が返す result を、
決定的な fixture に対して採点するための一式である。

```
cases/<case-id>/case.json   入力と、機械で判定できる期待値
cases/<case-id>/repo/       走査対象の fixture リポジトリ（決定的、外部依存なし）
samples/                    参考 result と、採点器が落とすべき result
check_result.py             形式の採点器（stdlib のみ）
rubric.md                   内容の採点基準
```

`catalog/` にも `scripts/` にも触れない。ここにある `.py` は
release pipeline の一部ではなく、この Skill の評価専用である。

## 実行

```bash
# 採点器そのものの健全性（受理すべき4件と、落とすべき5件）
python3 tests/fixtures/cmate-repository-analysis/check_result.py --selftest

# 実機実行の result を採点する
python3 tests/fixtures/cmate-repository-analysis/check_result.py \
    --case nextjs-app --result /path/to/run.json
```

`--selftest` は依存が無く、いつ実行しても同じ結果になる。
`--case` を使う実機評価は **opt-in** である。Agent を実際に動かす必要があり、
CI では実行しない。

## 2段階になっている理由

`check_result.py` は「この result を採点してよいか」だけを見る。
schema 適合、evidence が fixture 内に実在すること、行番号が file の行数内にあること、
除外すべき path を根拠にしていないこと、そして
**fixture の secret 値が result のどこにも現れないこと**。

内容が有用かどうかは [rubric.md](./rubric.md) で人（または独立した採点用 Agent）が見る。
自由文だけで自動合否にしないのは、それが「もっともらしいが誤った分析」を
通してしまう採点だからである。逆に、形式の判定を人に任せると見落とす。

`samples/` に **落とされるべき result** を5件置いてある。
何でも受理する採点器は、何も採点していないのと同じである。
`--selftest` が緑であることは、採点器がそれらを実際に落とせることまで含む。

- `nextjs-app.leaked-secret.json` — fixture の credential literal を finding へ写している
- `nextjs-app.dangling-evidence.json` — file 末尾を超えた行と、存在しない path を引いている
- `nextjs-app.escaping-path.json` — `..` で分析対象の外を指している
- `nextjs-app.overclaimed-status.json` — completion check が false のまま `success` を名乗っている
- `mixed-monorepo.vendor-evidence.json` — vendor 配下を根拠にし、除外を申告していない

secret の検出は完全一致ではなく **断片一致** である
（`case.json` の `forbidden_fragments`）。走査policyが禁じているのは
値そのものだけでなく値の一部と先頭数文字でもあるので、
切り詰めた literal や部分伏字も同じように落ちる。

## fixture リポジトリ

| case | 形 | 何を見るための case か |
|---|---|---|
| `nextjs-app` | Next.js App Router、単一 package | 規約 file・manifest script・test が揃った基準線 |
| `cli-tool` | Python CLI、Makefile と pyproject | 検証手段を package manager 以外から取れるか |
| `mixed-monorepo` | workspace、vendor・生成物・binary・secret 形式の値を含む | 除外規則と redaction |
| `invalid-input` | repo を置かない | 走査 budget を使う前に入力不備で止まるか |

`mixed-monorepo` の `config/secrets.example.yaml` と
`nextjs-app` の `.env.example` に置いてある値は **すべて架空**であり、
`fixture-not-a-real-secret-` または `FIXTUREKEYNOTREAL` で始まる。
どちらも実在 service の credential 形式には一致しない
（`scripts/cmate_skills/repo.py` の secret pattern にも掛からない）。

## 実機評価の記録

Agent を実際に動かした評価は、実施のたびに次の表へ追記する。
記録の粒度は [rubric.md](./rubric.md) の第4節に従う。

| 日付 | Agent / version | case | check_result | rubric 合計 | 0点項目 | 採点者 |
|---|---|---|---|---|---|---|
| — | 未実施 | — | — | — | — | — |

**この version（0.1.0）の時点で、実機評価は未実施である。**
実施済みなのは `--selftest`（採点器が参考 result 4件を受理し、
落とすべき result 5件を落とすこと）だけである。
`commandmate.skill.yaml` の `compatibility.agents` が
`claude` と `codex` を `native` と宣言しているのは
SKILL.md の discovery 経路についてであり、
品質評価の結果ではない。

### 手順

1. 対象 Agent に `skills/cmate-repository-analysis/SKILL.md` を読ませる。
2. `cases/<case-id>/repo/` を作業対象として、`case.json` の `input` を入力に与える。
   `repo/` の外を読ませないこと。case の期待値は `repo/` 相対で書かれている。
3. 返ってきた result を JSON として保存し、`--case <case-id>` で採点する。
4. 受理されたら `rubric.md` で採点し、上の表へ追記する。
5. rejected の場合は、result と採点器の出力を添えて Issue を立てる。
   **SKILL.md を先に直さない。** 何が落ちたかの記録が先である。
