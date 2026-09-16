# 記入例

`uat.yaml` を初めて書くときの下敷き。**そのまま貼らないこと** —— ポート範囲と
`isolation.checks` はリポジトリ固有の事実なので、必ず自分の環境で確かめてから書く。

契約の正本は [uat-yaml-contract.md](./uat-yaml-contract.md) である。

---

## 1. Next.js / Node のサーバー（sqlite を持つ）

CommandMate 自身がこの形である。`.claude/commands/uat.md` に直書きされていた手順を
契約の形に写すとこうなる。

```yaml
version: 1
env:
  build: "npm run build:all"
  up: >-
    env -i HOME=$HOME PATH=$PATH USER=$USER SHELL=$SHELL LANG=$LANG TERM=$TERM
    NODE_ENV=production CM_PORT={port} CM_BIND=127.0.0.1
    CM_DB_PATH={run_dir}/uat.db CM_ROOT_DIR={run_dir}/root
    node dist/server/server.js
  down: "uat-env.sh stop-listen {port}"
  health: "curl -fsS -m 5 -o /dev/null 127.0.0.1:{port}/api/worktrees"
  health_timeout_sec: 90
  port_range: [3010, 3030]
isolation:
  checks:
    # 開いている sqlite が run_dir のものだけか（陽性）
    - "lsof -p {pid} -Fn | grep -q '{run_dir}/uat.db'"
    # 本番 DB を開いていないか（陰性）
    - "! lsof -p {pid} -Fn | grep -q '/.commandmate/data/cm.db'"
    # API がサンドボックスだけを返すか
    - "curl -fsS 127.0.0.1:{port}/api/repositories | grep -q '{run_dir}/root'"
report_dir: ".commandmate/uat"
```

**`env -i` で環境を作り直しているのは、継承された環境変数が隔離を壊すからである。**
親シェルに `CM_DB_PATH` などが既に export されていると、設定ファイル側の指定が
**黙って無視される**。`up` の中で明示的に渡すのが確実である。

`isolation.checks` を陽性と陰性の両方書いてあるのは、設定が「別の本番」を指すように
なった場合も捕まえるためである。

---

## 2. Rust の CLI（サーバーを持たない）

サーバーが無いので `health` は command になる。

```yaml
version: 1
env:
  build: "cargo build --release"
  up: "true"
  down: "true"
  health: "test -x {target}/target/release/myapp"
  port_range: [0, 0]
isolation:
  checks: []
report_dir: ".commandmate/uat"
```

**`isolation.checks: []` は「隔離不要」の明示宣言である。** この形（プロセスを常駐させず、
共有状態を持たない）なら正しい宣言だが、**キーを省略するのとは違う**（省略は `blocked`）。
書き忘れと「不要」を区別するための規則である（[契約 第 3.2 節](./uat-yaml-contract.md)）。

`port_range: [0, 0]` は「ポートを使わない」を表す。`{port}` を参照する command が
無ければ port-find は走らない。

**この形なら [cmate-acceptance-test](../../cmate-acceptance-test/) の方が向いている。**
環境を立てる段が空になるなら、この Skill を使う理由が無い。

---

## 3. compose で外部サービスを要る web アプリ

```yaml
version: 1
env:
  build: "docker compose -f compose.uat.yaml build"
  up: "UAT_PORT={port} UAT_DATA={run_dir}/data docker compose -p uat-{port} -f compose.uat.yaml up -d"
  down: "docker compose -p uat-{port} -f compose.uat.yaml down -v"
  health: "curl -fsS -m 5 -o /dev/null 127.0.0.1:{port}/healthz"
  health_timeout_sec: 180
  port_range: [18080, 18099]
isolation:
  checks:
    # project 名で隔離しているので、本番 project の container を触っていないこと
    - "! docker compose -p uat-{port} ps --format '{{.Name}}' | grep -q '^prod-'"
    # volume が run_dir 配下か
    - "docker compose -p uat-{port} config --volumes | grep -q uat"
ui:
  e2e: "npx playwright test --config e2e/uat.config.ts"
report_dir: ".commandmate/uat"
```

**`down` に `-v` を付けているので、この command は volume を消す。** compose の
project 名（`-p uat-{port}`）で本番と分けているのが前提であり、`isolation.checks` の
1 本目はまさにそれを実測している。project 名を分けずにこの `down` を書くと、
**本番の volume を消す**。

`health_timeout_sec` を長くしているのは、container の起動が Node の直起動より遅いからである。

---

## 4. 書くときの共通の注意

- **`down` を名前の一括停止にしない。** `pkill -f node` は同じ名前の無関係なプロセスを
  巻き込む。ポート（`uat-env.sh stop-listen`）か、compose の project 名で絞る。
- **`{run_dir}` の外に書かせない。** DB・ログ・アップロード先をすべて `{run_dir}` 配下へ
  向けると、後始末が run ディレクトリの削除だけで済む。
- **`health` は「起動した」ではなく「使える」を確かめるものにする。** プロセスが居ることを
  見るだけの check（`kill -0 {pid}`）は、起動途中でも通る。
- **ポート範囲は本番と重ならないところにする。** 本番が 3000 なら 3010 以降にする、など。
- 空きポートの検出と起動の間に別の run が同じポートを取ることがある。`up` が
  「address in use」で落ちたら、**相手を止めずに** port-find をやり直す。
