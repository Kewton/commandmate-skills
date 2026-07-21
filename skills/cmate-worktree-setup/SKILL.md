---
name: cmate-worktree-setup
description: 1つ以上のIssueについて、対象repositoryを検証し、既存branch/directory/worktreeを暗黙上書きせず、repository profile（Node/CommandMate・Rust/CommandAgent）から解決したbranch・directory・base commit・proportional baselineで衝突しない専用worktreeを作成し、証跡付きの versioned result を返す。base SHA を明示し、dependency install は明示承認時のみ、CommandMate sync は利用可能なら worktree ID を返す（optional）。実装や orchestrate を始める前の準備段階で使う。
---

# cmate-worktree-setup

1つ以上のIssueについて、対象repositoryを検証し、**衝突しない専用worktree**を作成し、
その base commit と baseline 結果を **証跡付き** で返すための、portable な標準手順である。

CommandMate（Node）と CommandAgent（Rust）双方の実績あるworktree作成手順を統合したものであり、
どちらか一方の branch 命名・directory・baseline を hardcode しない。branch / base / path / baseline は
すべて **repository profile から解決** する。

この Skill は既存の branch / directory / worktree を **暗黙に上書き・reset・reuse しない**。
作成前に dry-run の plan を提示し、利用者の確認を経てから作成する。

## 1. この Skill が答える問い

1. この repository はどの profile か（Node/CommandMate か Rust/CommandAgent か、あるいは unverified か）。
2. どの branch・directory に、どの base commit（**resolved SHA**）から worktree を作るか。
3. その target は既存の branch / directory / worktree と衝突しないか。
4. 作成後、どの baseline を実行し、その結果はどうだったか。
5. CommandMate worktree sync は利用可能か。可能なら worktree ID は何か。
6. どこで止まったか。作成済み / 未作成のどちらか。次に何をすべきか。

## 2. 入力

| 名前 | 必須 | 型 | 既定値 | 説明 |
|---|---|---|---|---|
| `issue_numbers` | 必須 | 正の整数の配列 | なし | 対象Issue番号。1件以上。正の整数以外は拒否する |
| `profile` | 任意 | `node` / `rust` / `unverified` | 自動検出 | profile を明示指定して自動検出を上書きする |
| `base` | 任意 | 文字列（git ref） | profile 既定 | branch 作成元の base ref を上書きする |
| `max_issues` | 任意 | 正の整数 | 5 | 1回の run で扱うIssueの上限 |
| `reuse_existing` | 任意 | 真偽 | `false` | exact match の branch/directory/worktree の reuse を許可する（明示時のみ） |
| `install_dependencies` | 任意 | 真偽 | `false` | dependency install を許可する。plan 表示＋明示承認が別途必要 |

### 入力検証（Step 0 で行い、不備があればここで終了する）

- `issue_numbers` が空、正の整数でない値を含む、または全体が読み取れない場合は、
  status `failure`、`blocking_reasons` に理由を記録して即座に返す。**推測で番号を補わない。**
- `issue_numbers` が `max_issues` を超える場合は、先頭 `max_issues` 件だけを採用し、
  落とした番号を `limitations` に記録する。**黙って切り捨てない。**
- `profile` / `base` に client・Agent が構成した **絶対path・`..`・symlink・repository 外を指す値**
  が含まれる場合は、その値を採用せず status `failure`、`blocking_reasons` に記録する。
  詳細は [references/safety.md](./references/safety.md)。

## 3. 権限と禁止事項

宣言している権限は `filesystem_read` / `filesystem_write` / `process_execution` / `network_access` である。
この Skill の手順として **禁止** される操作は次のとおりで、利用者に許可を求めることもしない。

- 既存の branch / directory / worktree の暗黙上書き・reset・削除
- dirty な integration worktree への変更
- repository root（および許可された worktree 作成先）の **外** への書き込み
- 絶対path・`..`・symlink 経由で解決される target への作成
- 明示承認のない dependency install、および private package 内 script の install 時実行
- token・secret・環境変数・絶対path を result / audit へ残すこと
- CommandMate server の起動停止、GitHub Project 更新、PR / Issue への write
- 既存worktree の強制削除、cleanup、並列 dispatch

`network_access` は **dependency install を明示承認したときだけ** 使う。その host は
target repository の package manager 設定に依存するため、install 前に plan で列挙する（[references/safety.md](./references/safety.md)）。
worktree 作成そのもの（branch を local の resolved SHA から作る）は network を必要としない。

## 4. 手順

各 step は順に実行する。完了できなかった step は握りつぶさず、result に記録して続行する。
作成に踏み込むのは Step 4（plan 確認後）以降だけである。

### Step 0. 入力を検証する

第2節の規則で `issue_numbers` と `profile` / `base` を検証する。不備があればここで終了する。

### Step 1. repository を inspect する（read-only）

`git worktree list --porcelain` と repository の実体を正本とし、文字列 grep だけで判定しない。
次を把握する。存在しないことも結果である。

- repository root と remote（`slug` は remote から導く。**絶対path を result に出さない**）
- current branch と integration branch、default base
- 既存の local branch / remote branch / worktree
- 各Issueに対応する target directory の有無
- integration worktree が dirty か（dirty なら **変更しない**）

### Step 2. profile を検出する

[references/profile-conventions.md](./references/profile-conventions.md) の signal で
`node`（Node/CommandMate）か `rust`（Rust/CommandAgent）かを判定する。

- `profile` 入力があればそれを優先し、検出結果と食い違えば `limitations` に記録する。
- signal が曖昧、またはどちらの profile にも一致しない場合は、profile を `unverified` とし、
  **実行前に profile / base / path 規約を利用者へ提示して確認を得る**。確認が得られなければ
  status `failure` で止まる。動作確認済みは Node / Rust profile のみである。
- 検出根拠は `profile.detection_evidence` に repository 相対 path 付きで記録する。

### Step 3. plan を組み立てる（dry-run。ここでは作成しない）

profile から branch / directory / base ref を解決し、base ref を **resolved commit SHA** に確定する
（`profile.base_sha` と各 `plan[].base_sha`）。symbolic ref だけを base として記録しない。

各Issueについて plan に次を載せる。

- Issue番号 / branch / directory（**repository 相対**） / base ref と base SHA
- baseline command（profile の proportional baseline）
- CommandMate sync の有無
- collision（既存の local/remote branch・directory・worktree との一致）

collision を検出した対象は `plan[].blocked_by` に列挙し、`collisions` にも記録する。
plan を提示し、利用者の確認を得る。**確認前に作成へ進まない。**

### Step 4. worktree を作成する（確認後）

作成の直前に **base SHA を再確認** する（plan 後に base が動いていないか）。plan 時と食い違う場合は、
その entry を作成せず drift として `limitations` に記録し、当該Issueを未作成のまま残す。

- `blocked_by` が空でない entry は作成しない。ただし `reuse_existing` が明示され、かつ
  exact match の場合のみ reuse を許可する（`worktrees[].reused = true`、`created = false`）。
- 再確認した SHA から branch と worktree を作成する（`worktrees[].base_sha` に記録）。
- dependency install は `install_dependencies` が真、かつ plan を提示して **明示承認** を得たときだけ実行する。
  package lifecycle script（`postinstall` 等）が走りうる risk と network host を承認前に説明する
  （[references/safety.md](./references/safety.md)）。承認が無ければ install しない。

### Step 5. baseline を実行する

profile 別の **proportional baseline** を、作成した worktree 内で実行する。

- 結果は丸めず `baseline[]` に `outcome`（pass/fail/not_run/skipped）と `exit_code` で記録する。
- **baseline が失敗しても worktree を自動削除しない。** 作成済みworktreeを保持し、診断できる形で返す。
  この場合 status は `success` にならない（`partial`）。
- 出力は redaction した短い excerpt だけを残す。raw terminal の全量は残さない。

### Step 6. CommandMate sync を行う（optional）

CommandMate の worktree sync が利用可能なら実行し、返った worktree ID を
`commandmate_sync.worktree_id` に記録する。

- **sync が無い環境では失敗にしない。** `available=false`、`worktree_id=null` として記録し、
  worktree 作成自体の成否には影響させない（sync は optional）。
- 経路・認証は Harness Pack ADR に従う。公式経路は public `commandmate` を使い、
  `commandmatedev` は公式経路に使わない。詳細は [references/profile-conventions.md](./references/profile-conventions.md)。

### Step 7. result を組み立てる

[references/result-contract.md](./references/result-contract.md) と
[schemas/worktree-setup.result.v1.json](./schemas/worktree-setup.result.v1.json) に従って
result object を作り、`summary_markdown` に人が読む要約を同 reference の見出し構成で書く。

### Step 8. completion check を実行する

result を返す前に、6つの check を自分で実行し `completion_check` に記録する。

| check id | 内容 |
|---|---|
| `input_validated` | `issue_numbers` が正の整数のみで、上限適用が記録されている |
| `plan_confirmed` | 作成前に plan を提示し、確認を得た（または未作成で終わった） |
| `no_implicit_overwrite` | 既存 branch/directory/worktree を暗黙上書き・reset・reuse していない |
| `base_reconfirmed` | 作成した worktree の base SHA を作成直前に再確認した |
| `baseline_reported` | baseline の結果を丸めず、失敗時は worktree を保持した |
| `no_secret_or_abspath` | result / summary に token・secret・絶対path が無い |

いずれかが false なら status は `success` にならない。

## 5. 出力

result object 1件を返す。契約は [references/result-contract.md](./references/result-contract.md) にある。
status は次の3値である。

- `success` — 要求された全Issueの worktree を作成し、baseline が pass、6つの check がすべて通った
- `partial` — worktree は作成したが、baseline 失敗・sync 未提供・collision による skip・drift など、
  check の失敗が1つ以上ある。作成済みworktreeは保持する。`limitations` を必ず1件以上書く
- `failure` — worktree を1件も作成していない。`blocking_reasons` を必ず1件以上書く

`partial` を `success` に見せかけないこと。この Skill の価値は、
**作成済み / 未作成と、どこで止まったか** が後から検証できることにある。

## 6. 失敗時の動作

| 状況 | status | 動作 |
|---|---|---|
| `issue_numbers` が空・非整数 | `failure` | `input_invalid`。inspect しない |
| `profile`/`base` に path escape | `failure` | 採用せず `path_escape_rejected` |
| profile が unverified で確認が得られない | `failure` | `profile_unconfirmed`。作成しない |
| integration worktree が dirty | `failure` | `dirty_integration`。変更しない |
| collision（reuse 明示なし） | `partial`/`failure` | 当該Issueを作成せず `collisions` に記録 |
| plan 後に base が drift | 続行 | 当該entryを作成せず `limitations` に drift を記録 |
| baseline が失敗 | `partial` | worktree を保持し `baseline[].outcome=fail` |
| CommandMate sync が無い | 続行 | `available=false`、失敗にしない（optional） |
| dependency install 未承認 | 続行 | install せず `limitations` に記録 |

推測で作成しないこと。確信が持てない target は作らず、plan と未解決点だけを返す。

## 7. 完了条件

次がすべて満たされたときにのみ、この Skill の実行は完了である。

- [ ] result object が result contract に適合している
- [ ] `completion_check.passed` が true、または status が `partial` / `failure` で理由が記録されている
- [ ] branch 作成元が resolved commit SHA として plan / result に記録されている
- [ ] 既存 branch / directory / worktree を1件も暗黙上書きしていない
- [ ] baseline 失敗が success に丸められず、作成済みworktreeが保持されている
- [ ] result / summary に token・secret・絶対path が含まれていない
- [ ] `summary_markdown` が既定の見出し構成を満たしている

## 8. 参照

- [references/profile-conventions.md](./references/profile-conventions.md) — Node/Rust profile 規約、検出、unverified、CommandMate sync 経路
- [references/result-contract.md](./references/result-contract.md) — result の各 field と summary の構成
- [references/safety.md](./references/safety.md) — path escape 拒否、redaction、暗黙上書き禁止、dependency install risk
- [references/agent-compatibility.md](./references/agent-compatibility.md) — Agent 差異と Claude/Codex の reload・呼出方法
- [schemas/worktree-setup.result.v1.json](./schemas/worktree-setup.result.v1.json) — 機械検証用 schema
