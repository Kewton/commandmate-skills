---
name: cmate-verify
description: リポジトリの検証ゲート（lint / typecheck / test / build 等）を .commandmate/verify.yaml に宣言し、worktree の cwd で逐次実行して exit code で合否を判定する。verify.yaml が無いリポジトリでは CI 定義から起案する。作業完了を主張する前の検証や、並列ワーカーの完了判定に使う。
allowed-tools: Bash(.claude/skills/cmate-verify/scripts/*), Bash(.agents/skills/cmate-verify/scripts/*), Bash(git worktree list), Read, Write, Glob, Grep
---

# cmate-verify

> **ランチャー表記** — 本文中の `commandmate …` は**読み替え可能**である。グローバル導入をしない
> npx 運用では `npx commandmate@latest …` と読む。呼び出し頻度が高い経路では npx の起動コスト
> （1 回あたり 0.5〜0.9 秒）を避けるため、`~/.local/bin/commandmate` に
> `exec npx --yes commandmate@latest "$@"` の薄いラッパを置く導入形態を推奨する（README の
> 「CommandMate CLI の導入形態」）。

「このリポジトリで何が通れば合格か」を `.commandmate/verify.yaml` に宣言し、
**実 exit code で** 判定するランナー。CommandMate 本体の検証ゲート
（`commandmate verify <worktree-id>` / `commandmate wait <worktree-id> --verify`）の
代替ではなく、次の 2 つの役割を持つ。

1. **verify.yaml の起案**（手順 1）— CI 定義や package manifest からゲート候補を起案する。
   本体のローダも同じ v1 形式を読むので、起案した verify.yaml はそのまま引き継げる。
2. **スタンドアロンランナー**（手順 2）— CommandMate が無い環境や、検証ゲートをまだ
   持たない version の CommandMate でも、**bash と git だけで**同じ判定を出す。

> **なぜ exit code か**: `cmd | grep ...` は `$?` を grep に渡して非ゼロ終了を隠す。vitest は
> 全テスト緑でも Unhandled Rejection で exit 1 を出しうるので、出力を grep した要約は
> それを PASS と報告してしまう。ゲートは必ず `sh -c "$cmd" > log 2>&1` で走らせ `$?` を直接読む。

設定形式 v1 の正準仕様は CommandMate リポジトリの
[`docs/design/verification-config.md`](https://github.com/Kewton/CommandMate/blob/develop/docs/design/verification-config.md)。

## 構成

同梱するのは `SKILL.md` / `commandmate.skill.yaml`（配布 metadata。Agent は読まない）と
`scripts/verify-run.sh`（ランナー本体。bash 3.2 互換）だけである。
**テストは package に同梱しない**（Issue #69。後述「テスト」）。

install 先は `.claude/skills/cmate-verify/` と `.agents/skills/cmate-verify/` の両方で、
中身は byte-identical である（Claude は前者、Codex は後者を読む）。以下のコマンド例は
`.claude/...` で書いてあるが、`.agents/...` に読み替えても同じものが走る。

## 手順 1: init（`.commandmate/verify.yaml` が無い場合）

**コードを書かず、リポジトリをスキャンしてゲートを起案し、ユーザーの確認を得てから書き出す。**
検出優先順位は **CI ジョブ（`.github/workflows/*.yml` の `run:`）> `package.json` の
`scripts` > `Makefile` のターゲット > 言語マニフェスト（`Cargo.toml` / `pyproject.toml` /
`go.mod` 等）** で、上位が見つかったら下位は補助として扱う。CI 定義はそのリポジトリにおける
「何が通れば合格か」の既存の定義なので第一候補である。

- 実行時間の長いゲートには `timeoutSec` を明示する（既定は 600 秒）。
- 並び順がそのまま実行順になる。速いゲートを先に置くと失敗が早く読める（途中で失敗しても
  残りは実行されるので、順序は打ち切りではなく可読性のための選択）。
- **デプロイ・publish・リリース・外形変更を伴うコマンドはゲートにしない。** 何度でも
  安全に再実行できるものに限る。
- 起案結果は「どこから拾ったか」（CI ジョブ名 / npm script 名）とセットで提示し、
  **ユーザーの確認を得てから**書き出す。書き出したら 1 回実行して `RESULT passed` まで確認する。

### 受入条件との対応付け（ゲートで担保されないものを明示する）

起案したゲート集合を提示するとき、**受入条件それぞれについて「どのゲートが担保するか」を
対応付け**、どのゲートにも担保されない受入条件を明示的に列挙する（Issue #47 /
CommandMate #1678 B-5: 静的検査だけのゲート集合が PASS を返し、アプリの中心機能が動かない
状態が 3 件すり抜けた。**PASS は「宣言したゲートが通った」以上のことを意味しない**）。
担保するゲートを追加できるなら追加を起案し（例: 中心機能の smoke テスト）、ゲート化できない
条件（実機確認・e2e・目視・外部サービス連携等）は消さずに **「ゲート外」として明示**して
UAT / 人間の確認に残す。担保されない条件を黙って落とすことが、すり抜けの正体である。

## 手順 2: run（verify.yaml がある場合）

```bash
.claude/skills/cmate-verify/scripts/verify-run.sh --cwd <worktree-path>
```

| オプション | 意味 |
|---|---|
| `--config <path>` | 既定は `<cwd>/.commandmate/verify.yaml` |
| `--cwd <path>` | ゲートを実行する worktree。既定はカレントディレクトリ |
| `--base-ref <ref>` | work-evidence の基準。`options.baseRef` より優先 |
| `--gates id1,id2` | 一部のゲートだけ実行する。存在しない id は設定エラー |
| `--skip-work-evidence` | 未着手ガードを飛ばす |

出力は stdout に 1 ゲート 1 行、最終行が判定:

```
GATE work-evidence PASS commits=3 uncommitted=2
GATE lint PASS exit=0 duration=12s
GATE unit FAIL exit=1 duration=45s
RESULT failed
```

| 行 | 形式 |
|---|---|
| コマンド系ゲート | `GATE <id> PASS\|FAIL exit=<code> duration=<n>s` |
| 再実行したゲート | `GATE <id> FLAKY\|FAIL exit=<c1>,<c2> duration=<n>s,<n>s` |
| タイムアウト | `GATE <id> TIMEOUT exit=124 duration=<n>s` |
| skip | `GATE <id> SKIP reason=primary-checkout\|flag\|mutex-wait\|no-baseline` |
| work-evidence | `GATE work-evidence PASS\|FAIL commits=<n> uncommitted=<n>` |
| 判定 | `RESULT passed\|failed\|not_started\|skipped` |

`mutex` を宣言したゲートは末尾に `waited=<n>s` が付く。
**製品 CLI は同じ値を括弧で描画する**（`GATE lint PASS (exit=0, 12.3s)`）—— 元から別形式であり、
契約は**フィールド名・単位・「waited を duration に足さない」ことであって区切り文字ではない**
（verification-config.md §9.3 の表が綴りの確定形）。

| RESULT | exit code | 意味 |
|---|---|---|
| `passed` | 0 | 実行した全ゲートが PASS |
| — | 2 | 設定エラー（verify.yaml 不正 / ファイル無し / git でない cwd 等） |
| `failed` | 20 | 1 つ以上のゲートが FAIL / FLAKY（`flakyIsPass` 未宣言）/ TIMEOUT |
| `not_started` | 21 | work-evidence が「作業の痕跡ゼロ」と判定（コマンド系ゲートは走らない） |
| `skipped` | 22 | 実行したコマンド系ゲートが 0 件、または `mutex` が空かず**裁定に到達しなかった**ゲートが在る |

**`skipped` を `passed` と読まないこと。** 何も検証していない状態であり、緑ではない。
CommandMate 本体はこの「判定不能」を exit 99 で表すが、本ランナーの語彙に 99 は無い。
22 が「ここでは何も裁定していない。これは緑ではない」を既に意味しているので、そちらに寄せている。
**実際に落ちたゲートが在れば 20 が勝つ** —— 在る裁定は無い裁定より強い。

失敗ゲートのログ末尾は **stderr** に出る（stdout をパース可能に保つため）。FAIL / TIMEOUT では
**必ず理由行が出る** — 出力が 1 バイトも無ければ `no output captured`、`maxLogTailBytes: 0` なら
`log tail disabled`、出力ゼロで exit 126/127 なら「コマンドが起動できていない可能性」を
**断定ではなく手がかりとして**添える（無言で終わると「不合格」しか残らない。Issue #1607）。

## verify.yaml の書き方

```yaml
# .commandmate/verify.yaml — v1
version: 1
gates:
  - id: lint
    command: "npm run lint"
    timeoutSec: 600
  - id: unit
    command: "npm run test:unit"
    timeoutSec: 1800
    retryOnFail: 1            # 落ちたら同一 tree でもう 1 回だけ回す（0 か 1 のみ）
    flakyIsPass: false        # FLAKY を pass と数えるか（既定 false = 数えない）
  - id: e2e
    command: "npm run test:e2e"
    timeoutSec: 1800
    mutex: e2e-port           # マシン全体で同時に 1 つ
options:
  baseRef: origin/develop
  skipInPrimaryCheckout: true
  maxLogTailBytes: 8192
  requireCommit: false        # true で work-evidence が commit を要求する（既定 false）
  requireEnvClean: false      # CommandMate の組み込み env-clean ゲート（本ランナーは判定できない）
```

### キーの一覧（両ランナーが受理する集合）

正準は CommandMate の `src/lib/verification/verify-config.ts`。**本ランナーと
cmate-verify-advisor はこの集合に追随する**（`tests/fixtures/cmate-verify-advisor/parser-parity.sh`
が 3 実装の集合一致を機械的に固定している）。**v1 は閉じた集合なので、ここに無いキーは
無視されるのではなく exit 2 である。**

| 場所 | キー | 値域 | 既定 |
|---|---|---|---|
| `gates[]` | `id` | `^[a-z0-9][a-z0-9-]{0,31}$`。`work-evidence` / `scope` / `env-clean` は予約 | 必須 |
| `gates[]` | `command` | 1 行スカラー | 必須 |
| `gates[]` | `timeoutSec` | 整数 1..7200 | 600 |
| `gates[]` | `mutex` | `^[A-Za-z0-9_.-]+$` / 64 文字以内 | 宣言しない |
| `gates[]` | `retryOnFail` | **`0` か `1` のみ**（2 以上は設定エラー） | 0 |
| `gates[]` | `flakyIsPass` | `true` / `false`。**`true` は `retryOnFail: 1` を伴わないと設定エラー** | false |
| `options` | `baseRef` | ref 名 | `refs/remotes/origin/HEAD` |
| `options` | `skipInPrimaryCheckout` | `true` / `false` | true |
| `options` | `maxLogTailBytes` | 整数 0..1048576 | 8192 |
| `options` | `requireCommit` | `true` / `false` | false |
| `options` | `requireEnvClean` | `true` / `false` | false |

このランナーは awk / sed で読むため、**YAML のサブセットしか受け付けない**:

- インデントは 2 スペース固定（タブは不可）
- 値は 1 行スカラーのみ。アンカー / エイリアス（`&` `*`）・複数行文字列（`|` `>`）・
  フロースタイル（`[...]` `{...}`）は拒否する
- 行内コメントは無し。`#` で始まる行のみコメント
- `key:` の**最初のコロン**で分割するので、値の中のコロンはそのまま書ける

**制約に反する verify.yaml は「best-effort で解釈」せず exit 2 で拒否する。** 黙って一部を
読み飛ばすと「設定したつもりのゲートが走っていないのに passed」になるため。本体のローダは
一般的な YAML パーサを使うが、この形式で書いておけば両方で読める。各フィールドの型・既定値・
範囲は上記の仕様表が正準。

## 組み込みゲート work-evidence

コマンド系ゲートより先に、**そもそも作業が行われたか**を判定する。
`merge-base(baseRef, HEAD)..HEAD` のコミット数と未コミットのエントリ数のどちらかが > 0 なら
PASS、**両方 0 なら `RESULT not_started` (exit 21)** でコマンド系ゲートを 1 つも実行しない。
未起動のセッションを「全ゲート PASS」と誤報告しないためのガードである（変更ゼロの
リポジトリでは lint も typecheck も当然通る）。

**`.commandmate/tasks/` 配下の実行契約は作業証跡に数えない。** 実行契約はオーケストレーターの
証跡であってエージェントの証跡ではなく、委任した直後の worktree（契約ファイルが 1 件置かれた
だけの状態）が「作業済み」に見えると exit 21 が意味を失う。両方のカウンタから除外し、契約を
実作業へ rename した場合は作業として数える。除外が効いて両カウンタが 0 になったときは、その旨を
stderr に 1 行出す（`FAIL commits=0 uncommitted=0` を「ゲートのバグ」と読ませないため）。

### `options.requireCommit`（既定 false）

`true` にすると、work-evidence は「変更が在る」ではなく **「commit が在る」** を要求する。
`commits=0 uncommitted=1` は FAIL（`RESULT not_started` / exit 21）になり、ゲート行に
`requireCommit=true` が付く。理由は stderr に出る（`commits=0 uncommitted=3` は「作業が在る」
とも読めるため、FAIL の理由が行から読み取れない唯一のケースである）。

`commits=0 uncommitted=1` は「ここで何か起きたか」への答えとしては正しく、「これは完了したか」
への答えとしては誤りである。後者を訊きたいリポジトリだけが opt-in する。**既定を false に
しているのは、このゲート本来の問いが前者だから。**

**このランナーは実行契約を読まない。** `.commandmate/tasks/*.yaml` にも
`success.requireCommit` があり、本体の実装は両者を **OR** で合成するが、本ランナーが見るのは
`options.requireCommit` だけである（シェルから起動したランは、どの委任にも紐付いていない）。
**両方のランナーで効かせたい要求は verify.yaml に書く**。それが 2 実装が共に読む唯一の
ファイルである。

## 並列 worktree と共有資源（`mutex` / env）

### `mutex: <name>` — マシン全体の排他

固定ポート・ローカル DB・エミュレータのように **worktree ごとに分けられない資源**を持つゲートに
宣言する。同じ名前を宣言したゲートはマシン全体で同時に 1 つしか走らない。

```
GATE e2e PASS exit=0 duration=190s waited=42s
```

- `duration` は**ゲート自身のコマンドが動いていた時間**、`waited` は**ロック待ちの時間**。
  **足さないこと** —— 混ぜると timeout の調整も advisor の入力も歪む。
- `mutex` を宣言していて待たなかったゲートも `waited=0s` を出す（「排他されていて待たなかった」と
  「排他していない」は別の事実である）。宣言していないゲートの行は従来どおりで、`waited=` は付かない。
- ロックが空かないまま `timeoutSec` に達したら `GATE <id> SKIP reason=mutex-wait waited=<n>s`。
  **TIMEOUT ではない**（コマンドは 1 度も起動していない）し **FAIL でもない**（work を裁定していない）。
  その run は `RESULT skipped` / exit 22 になる。

**ロックの置き場と方式は規約であり実装詳細ではない。** CommandMate の runner と本ランナーは
同じマシンに対して独立に起動されるので、どちらか一方でも違えば排他にならない。

| 項目 | 規約 |
|---|---|
| パス | `~/.commandmate/locks/<name>.lock`（環境変数 `CM_VERIFY_LOCK_ROOT` で差し替え可。**テストは必ずこれを使う**） |
| 方式 | **`mkdir` によるアトミックな作成**（macOS に `flock(1)` が無いため） |
| 保有者記録 | ロックディレクトリ内の `owner`。JSON `{"pid":N,"host":"…","token":"…","acquiredAt":ms}` |
| 待ち | 空くまでポーリング（250ms 間隔）。上限は**そのゲートの `timeoutSec`** |
| 解放 | `owner.token` が自分のものであるときだけ削除する |
| 死んだ保有者 | `host` が自ホストと一致し、かつ `pid` が存在しないときのみ、待つ側が奪ってよい。**他ホストの pid では判断しない** |

### `CM_WORKTREE_INDEX` / `CM_WORKTREE_ID`

CommandMate はゲートに worktree ごとの採番を渡す（`~/.commandmate/worktree-index/<n>` を
`O_EXCL` で確保する）。**本ランナーはこの 2 つを設定しない。** 呼び出し側が export していれば
それがそのまま子プロセスへ渡り、していなければ未設定のまま走る。

理由は臆病さではなく**採番を知らないこと**である。CommandMate の番号は worktree ID に紐づいて
永続化されており、standalone 側が別の根拠で振った番号は**同じ worktree に別の番号を与える** ——
その結果、製品 run が既に握っているポートにゲートを載せることになる。無いより悪い。

**ゲート側が既定値を持つこと。**

```yaml
gates:
  - id: e2e
    command: "sh -c 'E2E_PORT=$((60400+${CM_WORKTREE_INDEX:-0})) npm run test:e2e'"
```

`${CM_WORKTREE_INDEX:-0}` と書いておけば、CommandMate 経由でも素の shell からでも同じ
verify.yaml が走る。既定値なしで `$((60400+CM_WORKTREE_INDEX))` と書くと、変数が未設定の
経路で全 worktree が 60400 に潰れる。

## `retryOnFail` / `flakyIsPass` — FLAKY

環境・乱数由来の赤に名前を付ける。`retryOnFail: 1` を宣言したゲートが**非ゼロ終了したときだけ**、
**同一 tree でもう 1 回だけ**回す。

| outcome | 条件 | GATE 行 | 裁定 |
|---|---|---|---|
| FLAKY | 1 回目 fail → 2 回目 pass、`flakyIsPass` 未宣言／`false` | `FLAKY` | **fail**（`RESULT failed` / exit 20） |
| FLAKY | 1 回目 fail → 2 回目 pass、`flakyIsPass: true` | `FLAKY` | pass（`RESULT passed` / exit 0） |
| FAIL | 2 回とも fail | `FAIL` | fail |

- **値域は `0` か `1` のみ。** 十分な回数を回せばどんな赤も緑になるので、**上限そのものが機能の中身**である。
- **再実行するのは `FAIL` だけ。** `TIMEOUT` は再実行しない（既に予算を使い切っており、2 回目は
  予算が最も大きいゲートの実時間を倍にする）。`SKIP`（mutex 待ち）はコマンドが 1 度も走っていない。
- 2 回目が裁定に到達しなかったとき（TIMEOUT・mutex 待ち）は **1 回目の FAIL がそのまま立つ**。
- **既定では FLAKY は fail 扱い。** 再実行を宣言してもゲートは 1 bit も弱くならない。
  `retryOnFail: 1` が買うのは「何が起きたか」に名前が付くことであって、pass ではない。
- **`FLAKY` の綴りは `flakyIsPass` で変わらない。** 変わるのは RESULT と exit code だけである。
  FLAKY を `PASS` と綴ると、この機能が可視化するために存在する唯一の事実が消える。
- `mutex` と併用したとき、ロックは**試行ごとに取得・解放する**。

両ランの記録は stderr に出る機械可読アンカーで運ばれる（`maxLogTailBytes` は**ラン単位**に適用）:

```
[flaky] runs=2 outcome=flaky exit=1,0 duration=45.0s,44.0s verdict=fail
--- [flaky] run 1/2: failed exit=1 duration=45.0s ---
--- [flaky] run 2/2: passed exit=0 duration=44.0s ---
[mutex] name=e2e-port waited=42.0s lock=/Users/me/.commandmate/locks/e2e-port.lock
```

**`outcome=fail`（2 回とも fail）でもアンカーを書く。** 2 回落ちたゲートは flakiness に対する
**反証**であり、flake advisor はその分母を必要とする。flaky 側にしか印が無ければ、再実行した
ゲートは全て flaky に見える。

## `options.requireEnvClean`（既定 false）

CommandMate の組み込み `env-clean` ゲート（#1740）を有効にするキー。**本ランナーは受理するが
判定はできない** —— このゲートは「タスク作成時（`send --contract`）に撮ったマシンのスナップショット」
と現在を比較するものであり、shell から起動した run はどのタスクにも紐付いていないので、
比較対象のベースラインが存在しない。

宣言されたときは `GATE env-clean SKIP reason=no-baseline` を出し、理由を stderr に書く
（黙って飲み込まない）。**この行は判定を変えない** —— 有効にしただけの repository の run を
すべて緑でなくしてしまえば、読めない設定（exit 2）を別の読めない設定（決して緑にならない）に
置き換えただけになる。このゲートの裁定を持っているのは `commandmate verify` である。

## メイン checkout での skip

`options.skipInPrimaryCheckout`（既定 `true`）が有効なとき、**プライマリ checkout では
コマンド系ゲートを実行しない**。プライマリ checkout は稼働中サーバの cwd になっている
ことがあり、その足元で build / test を回すと動いている画面を壊す。判定は
`git rev-parse --git-dir` と `--git-common-dir` が同じ実パスを指すかで行う。
検証は linked worktree で回すこと。

## テスト

回帰 suite は package ではなく **commandmate-skills リポジトリ**に在り、CI が回す
（`.commandmate/verify.yaml` の `verify-selftest` ゲートと `.github/workflows/validate.yml` の
`runner-suites` job）。install 先には存在しないので、利用者がこれを実行する手順は無い。
カバレッジ・変異注入の結果・本体実装との conformance の正本は
[`tests/fixtures/cmate-verify/README.md`](https://github.com/Kewton/commandmate-skills/blob/main/tests/fixtures/cmate-verify/README.md)。

## 変更履歴

なぜ今の挙動なのかは
[`references/release-notes.md`](./references/release-notes.md)（経緯の記録）。
**契約の正本はこの file である** —— 食い違ったら SKILL.md が正しい。
