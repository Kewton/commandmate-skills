# クイックスタート: 契約と検証ゲートで 1 本流す

対象読者: CommandMate と公式 Skill をこれから導入する人。

個々の Skill の SKILL.md は揃っているが、**それらが 1 本のワークフローとして
どう繋がるのか**はどこにも書かれていない。このページはその導線だけを扱う。
セットアップから「実行契約を宣言 → エージェントに投げる → 実 exit code で裁定 →
メトリクスで定点観測」までを 1 ページで通す。

各 Skill の使い方そのものは各 SKILL.md が正本である。ここでは**繰り返さず、リンクする**。

> **このページに貼ってある出力はすべて実測値である。**
> 測定条件と、測っていない項目は[末尾](#実測条件)に明記してある。
> 長い絶対 path・繰り返しの `Waiting:` 行・prompt の本文だけ `…` で省略してあり、
> それ以外は加工していない。

---

## 0. 前提

| 要件 | 最低 | 確認 |
|---|---|---|
| CommandMate | **0.17.0** | `commandmate --version` |
| Node.js | v22+ | `node -v` |
| git | 2.30+ | `git --version` |
| tmux | — | `tmux -V` |
| Agent CLI | Claude Code または Codex CLI（**認証済み**） | `claude --version` / `codex --version` |
| OS | macOS / Linux（Windows は WSL2） | — |

**0.17.0 が最低である理由**: 実行契約（`send --contract`）と検証ゲート
（`commandmate verify` / `wait --verify`）を含む最初のリリースだからである。
v0.16.0 には `src/cli/commands/task.ts` も `verify.ts` も存在せず、`send` に
`--contract` が無い。

version 番号ではなく**機能の有無**で判定してもよい（こちらのほうが確実である）。

```bash
commandmate send --help | grep -- --contract
commandmate verify --help
```

`--contract` が出ないなら、以降の手順 4 以降は成立しない。**契約なしの
`commandmate send <worktree-id> "<message>"` に黙って読み替えないこと。**
それは scope ゲートも完了判定も無い従来の送信であり、このページの成果物ではない。

---

## 1. セットアップ

install / `commandmate init` / `commandmate start` は CommandMate 本体の公式手順が正本である。

- [CLI セットアップガイド](https://github.com/Kewton/CommandMate/blob/main/docs/user-guide/cli-setup-guide.md)
- [クイックスタートガイド（CommandMate 本体）](https://github.com/Kewton/CommandMate/blob/main/docs/user-guide/quick-start.md)

ここで満たすべき条件は 1 つだけである。**対象リポジトリの worktree が
`commandmate ls` に出ていること。**

```
$ commandmate ls
ID                      NAME           STATUS  DEFAULT
----------------------  -------------  ------  -------
demo-app-feature-greet  feature/greet  ready   claude
demo-app-main           main           idle    claude
demo-two-main           main           idle    claude
```

出ない場合、リポジトリが登録されていない。登録経路は 2 つある。

1. Web UI（`http://127.0.0.1:<port>`）のリポジトリ管理から追加する
2. `~/.commandmate/.env` に `WORKTREE_REPOS=<repo-path>[,<repo-path>...]` を書いて
   サーバを再起動する（**リポジトリの path をカンマ区切りで列挙する**）

**`CM_ROOT_DIR` は browse root であってスキャン対象リストではない。**
その配下に git リポジトリを置いても自動登録はされない（実測）。

> **落とし穴 2 つ。** どちらも実測で踏んだ。
>
> - `~/.commandmate/.env` は dotenvx が `override: true` で読み込む。
>   シェルで `export CM_PORT=...` してあっても **`.env` の値が勝つ**。
> - 逆に、CLI 側は `.env` を読まない経路がある。API の接続先は
>   `CM_PORT`（未設定なら `3000`）から決まるので、既定以外のポートでサーバを
>   動かしているなら **CLI を実行する環境にも `CM_PORT` を渡す**。
>   渡さないと、意図しない別のサーバを叩く。

---

## 2. Skill を install する

Catalog に publish 済みの Skill は `commandmate skill install` で入る。

```
$ commandmate skill list
SKILL_ID                   NAME                       LATEST  RECOMMENDED  COMPATIBILITY
-------------------------  -------------------------  ------  -----------  -------------
cmate-acceptance-test      cmate-acceptance-test      0.1.1   0.1.1        compatible
cmate-issue-refinement     cmate-issue-refinement     0.1.1   0.1.1        compatible
cmate-orchestrate          cmate-orchestrate          0.7.1   0.7.1        compatible
cmate-orchestrate-monitor  cmate-orchestrate-monitor  0.1.0   0.1.0        compatible
cmate-repository-analysis  cmate-repository-analysis  0.1.1   0.1.1        compatible
cmate-worktree-cleanup     cmate-worktree-cleanup     0.1.2   0.1.2        compatible
cmate-worktree-setup       cmate-worktree-setup       0.1.2   0.1.2        compatible
```

### 2.1 high risk の 3 件は `--ack-risk` の完全一致が要る

上の一覧のうち **`cmate-orchestrate` / `cmate-orchestrate-monitor` /
`cmate-worktree-cleanup` の 3 件が high risk** である
（risk の正本は [README の公式 Skill 表](../README.md#公式-skill)。
本リポジトリには high risk の package が 4 件あるが、`cmate-verify` は
まだ Catalog に無いので `skill install` の対象外である）。

high risk の install には `--yes` に加えて
`--ack-risk <skill-id>@<version>` が要る。**version まで完全一致**でなければ通らない。

```bash
commandmate skill install cmate-worktree-cleanup \
  --worktree <worktree-id> --version 0.1.2 \
  --yes --ack-risk cmate-worktree-cleanup@0.1.2
```

`--ack-risk` を欠く／version が install 対象とずれていると、**書き込みは行われず exit 12** で止まる。

```
Installable:  yes
High risk:    installing requires --ack-risk cmate-orchestrate-monitor@0.1.0 in addition to --yes
Error: cmate-orchestrate-monitor 0.1.0 is high risk. Re-run with --ack-risk cmate-orchestrate-monitor@0.1.0 to acknowledge it explicitly.
```

**ack する version は「Catalog から install する version」である。** 本リポジトリの
`skills/<id>/commandmate.skill.yaml` の version は Catalog より先行していることがあり、
そちらを書くと落ちる（上の実測は repo 側 0.4.0 を ack して Catalog 側 0.1.0 に弾かれた例）。

### 2.2 Catalog にまだ無い 3 件

**`cmate-verify` / `cmate-task-contract` / `cmate-issue-authoring` は
まだ Catalog に publish されていない**
（[CommandMate#1592](https://github.com/Kewton/CommandMate/issues/1592) で一括公開予定）。
`skill install` の経路が無いので、使うなら `.agents/skills/` と `.claude/skills/` の
**両方へ手で置く**。手順とスニペットは [README の該当節](../README.md#公式-skill) と
[docs/runbooks/verify-install.md 第 3.1 節](./runbooks/verify-install.md) にある。

**手順 3 と手順 4 はこの 2 件（`cmate-verify` / `cmate-task-contract`）を使う。**
先に配置しておくこと。

> install 後は **Agent のセッションを再起動する。** 各 Agent は起動時に自分の
> discovery root を読むので、走っているセッションからは新しい Skill が見えない
> （[CommandMate の skills.md](https://github.com/Kewton/CommandMate/blob/main/docs/user-guide/skills.md)）。

---

## 3. 検証ゲートを起案する — `cmate-verify`

`.commandmate/verify.yaml` は「このリポジトリで何が通れば合格か」の宣言である。
CI 定義や package manifest からゲート候補を起案する手順は
[skills/cmate-verify/SKILL.md](../skills/cmate-verify/SKILL.md)、
形式 v1 の正準仕様は
[CommandMate docs/design/verification-config.md](https://github.com/Kewton/CommandMate/blob/main/docs/design/verification-config.md)
にある。ここでは繰り返さない。

書けたら、**作業を投げる前に 1 回空撃ちして exit code を見る。**

```
$ commandmate verify <worktree-id>
Verifying: demo-app-feature-greet (run 6)
GATE work-evidence FAIL (commits=0, uncommitted=0)
work-evidence: baseRef=main commits=0 uncommitted=0 (contract files excluded)
No commits and no uncommitted changes: nothing to verify.
GATE scope SKIP (skipped: the work-evidence gate did not pass.)
GATE unit SKIP (skipped: the work-evidence gate did not pass.)
RESULT not_started
$ echo $?
21
```

作業前の worktree では **21（作業証跡ゼロ）が正しい応答**である。ここで 0 が返るなら
work-evidence が効いていない。

`verify.yaml` そのものが無いと、判定ではなく**設定エラー**になる。

```
$ commandmate verify <worktree-id>
Verifying: demo-app-main (run 1)
GATE config ERROR (0.0s)
.commandmate/verify.yaml not found in …/demo-app. Declare the repository verification gates there before running verification.
RESULT error
$ echo $?
99
```

**99 は「判定して落ちた」ではない。「判定に到達しなかった」である。**
20 と 99 を同じ扱いにすると、ゲートが 1 つも走っていない状態を「不合格だが動いている」と
読み違える。

---

## 4. 契約付きタスクを 1 本流す — `cmate-task-contract`

実行契約は、作業を投げる**前**に「何を達成するか」「どのパスを変更してよいか」
「何が満たされたら完了か」を宣言した YAML である。起案手順と全キーの仕様は
[skills/cmate-task-contract/SKILL.md](../skills/cmate-task-contract/SKILL.md) にある。

### 4.1 送る

```bash
commandmate send <worktree-id> --contract .commandmate/tasks/<name>.yaml
```

契約が不正なら、**違反を全件** stderr に出して **exit 2** で止まる。
タスク行は作られず、エージェントには何も送られない。

```
$ commandmate send demo-app-feature-demo --contract .commandmate/tasks/bad.yaml
Error: invalid task contract:
  - top level: unknown key "notes" (v1 is a closed set)
$ echo $?
2
```

妥当なら、その場でタスクが作られて**実際に送信される**。

```
$ commandmate send demo-app-feature-greet --contract .commandmate/tasks/greet.yaml
Task created: a9c2e1af-8d54-4305-bd13-a80614ba8af9
a9c2e1af-8d54-4305-bd13-a80614ba8af9
Message sent.
```

### 4.2 待つ — `--on-prompt` の選択

```bash
commandmate wait <worktree-id> --verify
```

`--on-prompt` は**プロンプトを検出したときの振る舞い**を選ぶ。挙動は次のとおりである
（CommandMate `src/cli/commands/wait.ts`）。

| `--on-prompt` | プロンプト検出時 |
|---|---|
| `agent`（既定） | プロンプト情報を JSON で stdout に出し、**exit 10 で抜ける** |
| `human` | **抜けない。** メッセージを stderr に出して polling を継続し、人が UI か tmux で答えるまでブロックし続ける |

**`human` は「プロンプトを提示して止まる」ではない。** 呼び出し側に制御は戻らず、
exit 10 も返らない。人が画面の前にいる前提のモードである。

無人で回す・script から呼ぶなら `agent`（既定）を使い、exit 10 を受けてから
`commandmate respond <worktree-id> <answer>` で答え、`wait` を再実行する。

```
$ commandmate wait demo-app-feature-greet --verify --timeout 600
{"worktreeId":"demo-app-feature-greet","cliToolId":"claude","type":"multiple_choice","question":"… Do you want to create greet.sh?","options":[{"number":1,"label":"Yes","isDefault":true,…}],"status":"pending"}
$ echo $?
10
$ commandmate respond demo-app-feature-greet 2
Response sent.
```

完了まで進むと、検証が走って裁定が出る。

```
$ commandmate wait demo-app-feature-greet --verify --timeout 900
Waiting: demo-app-feature-greet (status=running, running=true, prompt=false)
…
Completed: demo-app-feature-greet
Verifying: demo-app-feature-greet (run 7)
GATE work-evidence PASS (commits=1, uncommitted=0)
GATE scope PASS (exit=0, 0.0s)
GATE unit PASS (exit=0, 0.0s)
RESULT passed
$ echo $?
0
```

### 4.3 exit code 早見表

`wait --verify` と `commandmate verify` が返す裁定。

| exit | 意味 | 次のアクション |
|---|---|---|
| `0` | 全ゲート合格 | PR へ進む |
| `10` | プロンプト検出（`--on-prompt agent`） | `commandmate respond` で答えて `wait` を再実行する |
| `20` | ゲートが不合格・timeout・error（scope 逸脱もここ） | 4.4 |
| `21` | 作業証跡ゼロ（work-evidence 不合格） | 4.5 |
| `99` | **判定に到達しなかった**（run が error / cancelled、`verify.yaml` 不在など） | ゲートは走っていない。設定を直してから測り直す |
| `124` | timeout | 未着手か長時間ジョブかを `commandmate capture` で切り分ける |

裁定に到達する前に止まる 2 つ（**どちらも副作用は起きていない**）:

| exit | どのコマンド | 意味 |
|---|---|---|
| `2` | `send --contract` | 契約が不正。違反を**全件この 1 回で**直して再送する（4.1） |
| `12` | `skill install` | 書き込みが確定しなかった（`--yes` 無し／`--ack-risk` 不一致）（2.1） |

### 4.4 exit 20 が出たとき

**再実行せず、記録を読む。** `verify` を叩き直すのは新しい run を起こすことであり、
落ちた run の証跡ではない。

```
$ commandmate verify history --worktree demo-app-feature-greet
#9  2026-08-01T16:53:12.880Z  demo-app-feature-greet  wait    failed       failed: scope
#8  2026-08-01T16:52:41.826Z  demo-app-feature-greet  manual  passed
#7  2026-08-01T16:52:01.887Z  demo-app-feature-greet  wait    passed
#6  2026-08-01T16:49:56.583Z  demo-app-feature-greet  manual  not_started  failed: work-evidence

$ commandmate verify show 9
run #9  failed  worktree=demo-app-feature-greet  trigger=wait
started=2026-08-01T16:53:12.880Z  finished=2026-08-01T16:53:12.954Z
baseRef=main  instance=-  task=9b22d1bc-cd16-453f-85bf-ee93e3a18e37
  work-evidence  passed  exit=0  0.0s
    | work-evidence: baseRef=main commits=2 uncommitted=0 (contract files excluded)
  scope  failed  exit=1  0.0s
    | scope: baseRef=main changed=3 violations=1
    | allow: scripts
    | deny: (none)
    | out of scope:
    |   - README.md
  unit  passed  exit=0  0.0s
```

`history` と `show` は読み取り専用で、**20 / 21 を返さない**（過去の run への問い合わせは
現在の作業に対する裁定ではない）。

scope で落ちたときは、**契約を後から緩めて通さないこと。** まず「その変更は本当に
必要か」を確認する。必要なら契約を更新して合意し直す。

> **scope ゲートが効くのは、契約が run に紐づいているときだけである。**
> `wait --verify` は直前の `send --contract` で作られたタスクを run に紐づけるので
> scope が判定される。一方、**単体の `commandmate verify <worktree-id>` には契約が
> 紐づかず、scope は SKIP される**（実測）。
>
> ```
> GATE scope SKIP (scope: no contract is attached to this run, so no scope is declared to check.)
> ```
>
> scope 逸脱を裁定に含めたいなら `wait --verify` を使うこと。単体 verify の
> `RESULT passed` は「scope も見たうえで合格」ではない。

### 4.5 exit 21 が出たとき

作業の痕跡がゼロという意味である（`merge-base(baseRef, HEAD)..HEAD` のコミット 0 件
**かつ** `git status --porcelain` が空）。ゲートは 1 つも走っていない。

疑うのはこの順番である。

1. エージェントのセッションが起動していない → `commandmate capture <worktree-id>` で画面を見る
2. エージェントが別の worktree に書いた → `commandmate ls` で送り先 id を確認する
3. 契約ファイルしか変わっていない → **work-evidence は契約ファイルを除外して数える**
   （`work-evidence: baseRef=main commits=0 uncommitted=0 (contract files excluded)`）。
   契約を置いただけでは「作業した」ことにならない

タスク側からも同じ裁定を引ける。

```
$ commandmate task list <worktree-id>
a9c2e1af-8d54-4305-bd13-a80614ba8af9	succeeded	claude	unit	demo: add a greet script and cover it with the unit gate

$ commandmate task show a9c2e1af-8d54-4305-bd13-a80614ba8af9
ID:        a9c2e1af-8d54-4305-bd13-a80614ba8af9
STATUS:    succeeded
WORKTREE:  demo-app-feature-greet
AGENT:     claude
TITLE:     demo: add a greet script and cover it with the unit gate
CONTRACT:  .commandmate/tasks/greet.yaml
SCOPE:     scripts
GATES:     unit
VERIFY:    run 7 passed
  GATE work-evidence passed (exit=0)
  GATE scope passed (exit=0)
  GATE unit passed (exit=0)
```

---

## 5. メトリクスを見る

1 本通したら、**単発の成否ではなく傾向**を見る。

```
$ commandmate report metrics --days 7
Vibe Metrics (last 7 days)
Tasks:        3 total / 1 succeeded / 2 failed / 0 not-started  (success 33.3%)
Verification: 9 runs, pass 44.4%  (top fails: work-evidence x2, scope x1, unit x1)
Intervention: 1 human responds / 4 auto answered
Retry loops:  avg 0.0 per failed task
```

読み方:

- **`success`** はタスク（契約）単位、**`pass`** は検証 run 単位である。
  分母が違うので一致しない。
- **`top fails`** がどのゲートに偏っているかが、次に直すべき場所である。
  `scope` に偏るなら契約の scope 宣言が実態より狭い。`work-evidence` に偏るなら
  そもそもエージェントが起動していない。
- **`human responds`** が減らないなら、契約か `verify.yaml` が曖昧で、
  エージェントが判断を人に返している。

**定点観測すること。** 週 1 回同じ窓（`--days 7`）で見て前週と比べる。1 回の値には
意味が無く、**成功率が上がっているか・介入が減っているか**だけが意味を持つ。

---

## 6. 次のステップ

| やりたいこと | Skill | 備考 |
|---|---|---|
| 複数 Issue を並列で流す | [`cmate-orchestrate`](../skills/cmate-orchestrate/SKILL.md) | **high risk。** install に `--yes --ack-risk cmate-orchestrate@<version>` が要る（2.1） |
| 並列 worker を監視する | [`cmate-orchestrate-monitor`](../skills/cmate-orchestrate-monitor/SKILL.md) | **high risk。** 同上 |
| 受入条件を証跡付きで裁定する | [`cmate-acceptance-test`](../skills/cmate-acceptance-test/SKILL.md) | moderate |
| Issue を精緻化する / Issue 群を起案する | [`cmate-issue-refinement`](../skills/cmate-issue-refinement/SKILL.md) / [`cmate-issue-authoring`](../skills/cmate-issue-authoring/SKILL.md) | 後者は Catalog 未 publish（2.2） |

並列化に進む前に、**この 1 本が exit 0 まで通ることを先に確認すること。**
契約と verify.yaml が甘いまま並列度だけ上げると、20 と 21 が同時に何本も出て
原因の切り分けができなくなる。

---

## 実測条件

このページの出力は 2026-08-02 に次の環境で実測した。

- CommandMate **0.17.0**（npm、隔離 prefix へ install）
- macOS（Darwin 25.5.0）、Claude Code、tmux
- 隔離した `HOME` / 専用ポート / 専用 DB / 専用の demo リポジトリ
  （本番サーバと DB には触れていない。隔離の作法は
  [docs/runbooks/verify-install.md 第 0 節](./runbooks/verify-install.md)）
- 実測した exit code: **0 / 2 / 10 / 12 / 20 / 21 / 99**

**未実測（出力を貼っていない）**:

- `--on-prompt human` — 第 4.2 節の説明は CommandMate `src/cli/commands/wait.ts` の
  実装から書いた。ブロックし続ける挙動の性質上、貼れる終了時出力が無い
- `124`（timeout） — 発生させていない
