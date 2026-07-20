# Release pipeline 設計

対象 Issue: [Kewton/CommandMate#1238](https://github.com/Kewton/CommandMate/issues/1238)
依存する契約: [#1228](https://github.com/Kewton/CommandMate/issues/1228)（配布契約）/
[#1230](https://github.com/Kewton/CommandMate/issues/1230)（package検査）

## 1. 何を解く設計か

CommandMate は本リポジトリの artifact を、**署名なしで**信頼しなければならない。
署名鍵がない以上、信頼の根拠は「誰が作ったか」ではなく
**「同じ入力から誰でも同じ出力を得られること」** に置くしかない。

したがって pipeline の中心的な要求は次の一点に集約される。

> release される artifact の byte 列は、source commit のみの関数であること。

build 時刻・runner・contributor の umask・file system の順序が
1 bit でも digest に漏れた瞬間、Catalog の SHA-256 は
「この source」ではなく「あの build 機のあの瞬間」を指すものになり、
第三者による独立検証が成立しなくなる。

## 2. 責務の分割

| 構成要素 | 責務 |
|---|---|
| `scripts/cmate_skills/` | CommandMate 側契約の mirror（constants / safe YAML / schema / semver / package） |
| `scripts/validate.py` | PR 時点の全検証。schema・完全一致・digest・mode・secret・link・license・再現性 |
| `scripts/build_release.py` | 二重 build と digest 一致検証、artifact と build record の生成 |
| `scripts/build_catalog.py` | build record → versioned Catalog への追記。既存 version の上書き拒否 |
| `scripts/verify_artifact.py` | Catalog → artifact → manifest → payload の連鎖検証（keyless verification） |
| `scripts/manifest_files.py` | contributor 用。`files:` block の生成 |
| `scripts/selftest.py` | pipeline 自体の test。**壊して落ちることを確認する** |
| `.github/workflows/validate.yml` | 上記を PR / push で実行 |
| `.github/workflows/release.yml` | tag → build → 承認 → publish |

`validate.py` は「package が正しいこと」を示す。
`selftest.py` は「`validate.py` が間違いに気づくこと」を示す。
後者がないと、検証が実は何もしていない状態に静かに退行しうる。

## 3. 再現可能 build

`scripts/cmate_skills/package.py` の `build_artifact()` が行う正規化。

| 非決定要素 | 正規化 |
|---|---|
| entry の順序 | path 昇順。directory は自身の配下 file より先 |
| mtime | 全 entry 0 固定（`SOURCE_DATE_EPOCH` にも依存しない） |
| uid / gid | 0 固定 |
| uname / gname | 空文字（runner の account 名を artifact に混ぜない） |
| file mode | directory `0755` / file `0644` / 実行可能 file `0755` の3値のみ。contributor の umask を持ち込まない |
| tar format | `USTAR` 固定。PAX 拡張 record（高精度timestamp）を作らない |
| gzip header | `mtime=0`、`filename=''`（`fileobj.name` が header に入るのを防ぐ）、compress level 9 固定 |

archive root は `<skill-id>/` の 1 ディレクトリ。
CommandMate 側 (#1230) は root 省略・`<skill-id>`・`<skill-id>-<version>` を
受け付けるが、本リポジトリは常に `<skill-id>/` のみを出力する。
選択肢を残すと、生成側と検証側の解釈がずれる余地が残るためである。

### 既知の限界: deflate 実装への依存

上の正規化で決まるのは **gzip に入力される tar の byte 列**であり、
そこから先の圧縮結果は zlib の実装に依存する。同じ tar でも、
zlib-ng をリンクした interpreter など deflate 実装が異なる環境では
圧縮後の byte 列が変わりうる。

したがって「誰でも同じ digest」が成立する範囲は
**同等の zlib を持つ環境**である。CI は `ubuntu-latest` の system python を
使うので実務上は問題にならないが、第三者検証で digest が一致しない場合は
まず interpreter と zlib を疑い、`gzip -dc artifact | sha256sum` で
**解凍後の tar** を比較すること。tar 層まで一致していれば
内容は同一であり、差分は圧縮器由来である。

### 二重 build 検証

`build_release.py` は同じ package を 2 回 build し、byte 列を比較する。
一致しなければ artifact を一切書き出さずに失敗する。

`selftest.py` はこれをさらに強くする。fixture を temp directory へ copy し、
**mtime と mode を変えてから** build し、元と byte 一致することを確認する。
同一 process 内の 2 回は「同じ `stat` を 2 回読んだだけ」で一致しうるが、
timestamp と mode を変えた copy は一致しない。

## 4. publish 順序と、その理由

**artifact が先、Catalog が後。** 例外はない。

```
1. build job（write権限なし・secretなし）
     validate → 二重build → preflight Catalog 生成 → verify_artifact
2. release environment の承認 gate
3. draft release を作成し asset を upload
4. upload された asset を download し直して digest 再照合
5. release を draft から公開（ここで初めて安定URLが解決する）
6. Catalog を生成し、公開済み asset に対して verify
7. Catalog snapshot を release asset として添付
8. Catalog を default branch へ commit
```

### なぜこの順序か

Catalog は CommandMate が読む index である。
**Catalog を先に公開すると、まだ存在しない asset の URL が全 client から解決可能になる。**
一方 artifact を先に置いた場合の中間状態は
「asset は存在するが Catalog がまだ指していない」であり、
これは client から観測できない。安全側に倒れる中間状態だけを通る。

draft release を経由するのも同じ理由である。
draft の間は `/releases/download/<tag>/<asset>` が解決しないので、
asset を upload した直後の「digest 未検証の asset が公開されている」状態が存在しない。

step 4 の再 download は upload 経路の破損を検出する。
build job の宣言を信じずに、**実際に配布される byte 列** を測る。

## 5. 失敗時の rollback

判断基準は一つ: **公開済み Catalog がその artifact を指しているか。**

| 失敗した step | 状態 | rollback |
|---|---|---|
| 1〜2 | 何も起きていない | 不要。修正して tag を切り直す（新 version） |
| 3〜4 | draft release のみ存在 | `gh release delete <tag>` + tag 削除。client 影響なし |
| 5 | release 公開済み、Catalog 未更新 | release を draft へ戻す、または削除。Catalog は指していないので client 影響なし |
| 6〜7 | 公開済み、Catalog は local のみ | 同上。commit していない Catalog は破棄 |
| 8（push 失敗） | 公開済み、Catalog 未 commit | asset を残したまま Catalog commit を再実行して良い。asset は既に digest 検証済み |
| 8 の後 | Catalog が asset を指している | **asset を削除しない。** Catalog commit を revert し、その後で release を削除する。順序を逆にすると、Catalog が 404 を指す時間が生じる |

いずれの場合も **同じ version 番号を再利用しない**。
一度でも Catalog に載った version は immutable であり、
`build_catalog.py` は再登録を拒否する。

`git rebase --onto` で tag を付け替えることも禁止する。
Catalog に記録されるのは resolved commit SHA なので、
tag を動かしても記録は動かず、両者が食い違うだけである。

## 6. 権限設定（repository 側で必要な設定）

pipeline は以下を前提にしている。設定されていない場合、
「安全に見えるが実際には gate がない」状態になる。

### GitHub Actions permissions

- workflow の既定 `GITHUB_TOKEN` 権限を **read-only** に設定する
  （Settings → Actions → General → Workflow permissions）。
- `release.yml` の `publish` job だけが `contents: write` を宣言する。
- fork からの PR は `build` job しか到達しない（`publish` は `github.event_name == 'push'`）。

### Environment

`release` environment を作成し、**required reviewers に maintainer を設定**する。
これが唯一の人間による gate である。
deployment branch を `main` と tag に限定する。

### Branch protection

| branch | 設定 |
|---|---|
| `main` | PR 必須 / `validate` を required status check / force push 禁止 / 削除禁止 |
| `develop` | PR 必須 / `validate` を required status check / force push 禁止 |

**release workflow は `main` へ Catalog を直接 push する。**
branch protection を有効にする場合、`github-actions[bot]` を
bypass 許可リストへ追加する必要がある。
追加しない運用にするなら、workflow の最終 step を
「Catalog の PR を作成する」に変更し、release 完了の定義に
その PR の merge を含めること。どちらを選ぶかは repository 設定であり、
本 pipeline は前者を既定としている。

### tag protection

`*-v*` の tag について、maintainer 以外の作成を禁止する。
tag が release の trigger であり、resolved SHA へ変換される入口だからである。

## 7. 依存を持たない理由

pipeline は Python 標準ライブラリのみで書かれており、
CI に依存 install の step が存在しない。

これは利便性の放棄ではなく、脅威モデル上の判断である。
公式 artifact の中身を決める処理が外部 registry に依存していると、
registry の障害や汚染が「利用者の worktree に何が置かれるか」に直結する。
YAML parser を自前の部分集合実装にしているのも同じ理由で、
`SKILL_YAML_SAFE_PROFILE`（depth / node 数 / scalar 長 / anchor 禁止）を
強制できる汎用 parser が存在しないためである。

## 8. 契約の mirror について

`scripts/cmate_skills/` は CommandMate 側の実装を写したものであり、
**正本ではない**。乖離すると CI は緑のまま install が失敗する。
同期手順は [contract-sync.md](./contract-sync.md) を参照。
