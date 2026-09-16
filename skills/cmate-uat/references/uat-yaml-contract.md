# `.commandmate/uat.yaml` 契約 v1

この Skill が環境を立てるために読む宣言の**正本**である。SKILL.md 第 3 節はこの文書の要約で、
食い違ったらこちらを採る。

**リポジトリ単位**の宣言であり、run ごとでも Issue ごとでもない。`verify.yaml`
（検証ゲートの宣言）と同じ位置づけで、リポジトリに commit する。

---

## 1. 全体の形

```yaml
version: 1
env:
  build: "npm run build"                                  # 任意
  up: "PORT={port} DB_PATH={run_dir}/uat.db node dist/server.js"
  down: "uat-env.sh stop-listen {port}"                   # 任意
  health: "curl -fsS -m 5 -o /dev/null 127.0.0.1:{port}/api/health"
  health_timeout_sec: 90                                  # 任意（既定 60）
  port_range: [3010, 3030]
isolation:
  checks:                                                  # 必須キー
    - "lsof -p {pid} -Fn | grep -q '{run_dir}/uat.db'"
ui:
  e2e: "npx playwright test"                              # 任意
report_dir: ".commandmate/uat"                            # 任意
```

| key | 必須 | 既定 | 意味 |
|---|---|---|---|
| `version` | 必須 | — | `1` のみ。未知の値は読まずに停止する |
| `env.up` | 必須 | — | 環境を起動する command |
| `env.health` | 必須 | — | 起動を確かめる URL か command |
| `env.port_range` | 必須 | — | `[from, to]`。この範囲から空きを取る |
| `env.build` | 任意 | なし | 起動前に 1 回だけ実行する |
| `env.down` | 任意 | `uat-env.sh stop-listen {port}` | 停止する command |
| `env.health_timeout_sec` | 任意 | `60` | health を待つ上限 |
| `isolation.checks` | **必須** | — | 隔離できていることを確かめる command の配列。第 3 節 |
| `ui.e2e` | 任意 | なし | 画面を確かめる test command |
| `report_dir` | 任意 | `.commandmate/uat` | 出力先の親 |

**未知のキーは無視せず、利用者に提示して確認する。** typo で隔離の宣言が無効になるのが
最も危険な失敗なので、黙って読み飛ばさない。

### 1.1 `env.health` は URL でも command でもよい

同梱の `uat-env.sh wait-health` は、値の scheme が `http` か `https`（`<scheme>://…` の形）なら
curl で取得し、それ以外は shell command として実行して exit code で判定する。どちらでもよい。

**本書と SKILL.md の例が `curl …` の command 形なのは、この package が平文 scheme の URL を
リテラルとして含められないからである**（この repository の検査 `SKILLS_LINK_INSECURE` は
loopback も例外にしない。Skill の本文は Agent が従いうる指示なので、平文 URL を配布物に
埋めない、という規則である）。**あなたの `uat.yaml` はこの package の配布物ではない**ので、
`env.health` に loopback の平文 URL（`<scheme>://127.0.0.1:{port}/healthz` の scheme を
平文側にしたもの）をそのまま書いてよい。loopback ではこの用途で問題にならない。

---

## 2. placeholder

command 文字列の中で次が展開される。

| placeholder | 値 |
|---|---|
| `{port}` | `env.port_range` から取った空きポート |
| `{run_dir}` | `<report_dir>/<run_id>/` の絶対 path |
| `{pid}` | `env.up` で起動したプロセスの pid（`isolation.checks` でのみ有効） |
| `{target}` | `target_ref` が解決した checkout の絶対 path |

`{pid}` を `env.up` の中で使えないのは、起動する前に pid が無いからである。
`isolation.checks` は起動後に走るので使える。

---

## 3. `isolation.checks` は必須である

### 3.1 なぜ必須か

この Skill は**本番と同じ形のものを起動する**。DB の path やデータ root の指定が本番へ落ちると、
UAT が本番のデータを書き換える。**「別ポートで起動したから別環境」は成り立たない** ——
プロセスが読む設定ファイルや環境変数が本番を指していれば、ポートだけ違う本番である。

実際に起きている。CommandMate では worktree 上で起動した UAT サーバーが、`.env` の解決が
本番へ落ちて**本番 DB を掴んだ**。気づけたのは、サーバーが開いている sqlite を `lsof` で
実測したからである。

### 3.2 書き忘れと「不要」を区別する

`isolation.checks` は**キー自体が必須**で、空配列（`[]`）だけが「隔離不要」の明示宣言である。

| 状態 | 意味 | この Skill の動作 |
|---|---|---|
| `checks: [ … ]` | 実測する command がある | 全部実行し、1 つでも落ちたら `blocked` |
| `checks: []` | **隔離は不要だと人が判断した** | 検査せず先へ進む。報告書にその宣言を書く |
| キーが無い | 宣言されていない（書き忘れと区別できない） | **`blocked`。起動もテストもしない** |

キーを任意にすると、書き忘れが「隔離不要」と同じ見え方になる。それは検知できない事故である。
`cmate-orchestrate` の `integration_baseline` が `[]` を宣言として扱うのと同じ考え方である。

### 3.3 何を書くか

**「本番を掴んでいない」ことを実測する command** を書く。プロセスが実際に開いているものを
見るのが最も強い。

```yaml
isolation:
  checks:
    # 起動したプロセスが開いている sqlite が run_dir のものだけか
    - "lsof -p {pid} -Fn | grep -q '{run_dir}/uat.db'"
    # 本番 DB を開いていないこと（陰性側も書く）
    - "! lsof -p {pid} -Fn | grep -q '/Users/me/prod/data/app.db'"
    # API が返すのがサンドボックスだけか
    - "curl -fsS 127.0.0.1:{port}/api/repositories | grep -qv '/prod/'"
```

**陽性（正しいものを掴んでいる）と陰性（誤ったものを掴んでいない）の両方**を書くと、
設定が別の本番を指すようになった場合も捕まる。

---

## 4. `env.down` を自分で書くときの制約

既定は同梱の `uat-env.sh stop-listen {port}` で、**そのポートで LISTEN しているプロセスだけ**を
止める。自分で書くなら同じ絞りを持たせる。

```bash
# 正しい
lsof -nP -iTCP:<port> -sTCP:LISTEN -t

# 間違い。接続しているだけのプロセスまで返る
lsof -ti:<port>
```

後者で止めると、UAT 画面を開いているブラウザの network service まで kill され、**無関係な
タブの通信が切れる**（CommandMate#2473 の実害）。

`env.down` に `pkill -f node` のような**名前での一括停止を書かない**。同じ名前の無関係な
プロセスを巻き込む。

---

## 5. 無いときの起案（人が居る run だけ）

### 5.1 根拠の優先順位

上位が見つかったら下位は補助として扱う。

1. **CI の e2e / 起動を含む job**（`.github/workflows/*.yml` の `run:`）—— そのリポジトリに
   おける「どう立てるか」の既存の定義である
2. **container 定義**（`Dockerfile` の `CMD` / `ENTRYPOINT`、`compose.yaml` の `command` と
   `healthcheck`）—— `healthcheck` は `env.health` にそのまま使えることが多い
3. **`package.json` の `scripts`**（`start` / `serve` / `dev` / `build`）や同等のもの
   （`Makefile` / `Cargo.toml` / `pyproject.toml`）
4. **README の起動手順**
5. **`.env.example`** —— ポート・DB path の環境変数名を読む。**値は読まない**

### 5.2 provenance と TODO を必ず添える

項目ごとに「どこから拾ったか」を書き、判断材料が無かった項目には**対の TODO** を置く。

```
env.up            detected  package.json scripts.start
env.health        detected  compose.yaml services.app.healthcheck.test
env.port_range    default   TODO: このリポジトリで使ってよいポート範囲を決める
isolation.checks  default   TODO: 本番の DB / データ root が何かを確認して実測 command を書く
```

**`isolation.checks` は起案で埋めない。** 何が本番なのかはリポジトリの外の事実であり、
推測で書いた検査は「通ること」しか保証しない。人に聞く。

### 5.3 書き出したら 1 回通す

`env.up` → `env.health` → `isolation.checks` → `env.down` を実際に 1 周させ、通ることを
確かめてから「起案できた」と報告する。**書き出しただけを完了としない。**

### 5.4 無人 run では起案しない

確認する相手が居ない状態で、推測した command で未知のプロセスを起動するのは、この Skill が
避けるべき操作そのものである。`status: failure` / `blocking_reasons` に `uat_yaml_missing` を
記録して終わる。**環境を立てずにテストケースを回して pass を作らない。**

---

## 6. 変更するとき

製品の動かし方（起動 command・ポートの決め方・DB の場所・health の URL・隔離の確かめ方）を
変える Issue は、**同じ PR で `uat.yaml` も直す**。委任するなら契約の `scope.allow` に
このファイルを入れる。

直し忘れは検知できる。`env.health` が通らないか `isolation.checks` が落ちるので、
SKILL.md 第 4 節 Step 3 で `blocked` になる。**そこで推測して直さない** ——
「uat.yaml を直せ」という申し送りを出して止まる。
