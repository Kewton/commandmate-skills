# catalog/v1

CommandMate が取得する Catalog。**生成物であり、手で編集しない。**

## file

| path | 内容 |
|---|---|
| `catalog.json` | `schema_version: 1` の Catalog。全 Skill・全 version の履歴を持つ |

まだ公式 Skill が release されていないため、`catalog.json` は存在しない。
最初の release で `release.yml` が生成し、`main` へ commit する。

## なぜ手で編集しないのか

`catalog.json` の各 version entry は、release 時に実際に build された artifact の
SHA-256・size・resolved commit SHA を持つ。手で書き換えると、
**Catalog が約束する digest と配布されている byte 列が食い違う**。
CommandMate は install を digest に固定するので、これは install 失敗として現れる。

生成は `scripts/build_catalog.py` が行い、書き出す前に
`validateSkillCatalog` 相当の検証を通す。既に載っている version の
再登録は拒否される（公開済み version は immutable）。

## version 履歴について

`catalog.json` は `latest` だけでなく全 version を保持する。
`latest` は SemVer precedence で決まり、
**stable release が存在する限り prerelease は `latest` にならない。**

各 release 時点の Catalog は
`catalog-<skill-id>-<version>.json` として release asset にも添付される。
後続の release で `catalog.json` が更新されても、
その時点の Catalog 状態が immutable に残る。

## 読む側の前提

- `versions[].source.commit` は 40桁の resolved commit SHA。tag は表示用にすぎない。
- `versions[].artifact.url` は公開済み release asset の安定 URL。
- `versions[].declared_risk` は publisher の申告であり、
  CommandMate が検査から算出する `computed_risk` とは別物である。実効値は高い方。
