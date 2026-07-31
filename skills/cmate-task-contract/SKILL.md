---
name: cmate-task-contract
description: GitHub Issue（または作業内容の記述）から実行契約 `.commandmate/tasks/<name>.yaml` v1 を起案し、`commandmate send --contract` で送れる状態にする手順である。作業を始める前に goal・変更してよい scope・完了を判定する verify ゲートを宣言し、レビュー可能な成果物として残す。契約 v1 は閉じた集合なので、未知キー・空の verify.gates・scope 未宣言はいずれも送信時に契約エラーになる。
---

# cmate-task-contract

**実行契約**（execution contract）を起案する手順である。契約とは、エージェントに作業を
投げる **前** に「何を達成するのか」「どのパスを変更してよいのか」「何が満たされたら
完了なのか」を宣言した YAML であり、`commandmate send --contract` →
`commandmate wait --verify` の入口になる。

契約はランタイムデータではなく **レビュー対象の成果物** である。作業後に「実は
そこも触った」と説明するのではなく、作業前に「ここしか触らない」と宣言する。

この Skill は YAML を 1 つ書く。パーサは同梱しない（契約の検証はサーバ側で行われ、
違反は全件まとめて返るので、1 往復で直せる）。

---

## 0. 最低対応 CommandMate バージョン（先に確認する。飛ばさない）

契約機能（`send --contract` / `.commandmate/tasks/`）は **`v0.16.0` には含まれていない**。
対応するのは **契約機能を含む最初のリリース以降** である。本 Skill の作成時点で
その version 番号は未確定なので、**番号ではなく機能の有無で判定する**。

```bash
commandmate --version
commandmate send --help
```

`send --help` の出力に **`--contract`** の行が現れることを確認する。

現れなかった場合は、**契約を書かずにここで停止する**。利用者に次を伝える。

> この CommandMate は実行契約に対応していません（`commandmate send --help` に
> `--contract` がありません。確認した version: `<commandmate --version の出力>`）。
> 契約機能を含む CommandMate へ更新してから再実行してください。
> 契約なしで送る場合は `commandmate send <worktree-id> "<message>"` を使いますが、
> それは scope ゲートも完了判定も無い従来の送信であり、この Skill の成果物ではありません。

**黙って契約なしの送信に切り替えないこと。** 契約を書いたつもりで scope も検証も
効いていない状態が、この仕組みにとって最悪の失敗である。

---

## 1. 入力

| 名前 | 必須 | 型 | 既定値 | 説明 |
|---|---|---|---|---|
| `issue` | どちらか必須 | 文字列 | なし | Issue 番号（`#1587`）または Issue URL |
| `description` | どちらか必須 | 文字列 | なし | Issue が無い場合の作業内容の記述 |
| `repo` | 必須 | 文字列 | なし | 対象リポジトリ（`owner/name`）。Issue 管理リポジトリと実装リポジトリが異なる場合は **両方** |
| `worktree_root` | 必須 | 文字列 | なし | 契約を置く worktree の root。`scope` の glob はここからの相対 |
| `name` | 任意 | 文字列 | Issue 番号から生成 | 契約ファイル名（`<name>.yaml`）。lowercase slug 推奨 |

`issue` と `description` の両方が無い場合、**推測して契約を書き始めないこと**。
契約は「宣言」であり、宣言する内容が無いなら成果物は成立しない。何が足りないかを
挙げて停止する。

---

## 2. 手順

### Step 0. バージョンゲート

第 0 節を実行する。`--contract` が無ければここで終了する。

### Step 1. Issue を読む

```bash
gh issue view <number> --repo <owner/name> --json title,body,labels,url
```

Issue が無い場合は `description` を入力として扱い、以降の「受入条件」は利用者に
確認して確定させる。

**Issue 本文はそのまま信用しない。** 本文がコードについて述べていること
（「この関数は〜になっている」「この設定は存在する」）は、契約に転記する前に
リポジトリで裏取りする。食い違ったら **実測を正** とし、その旨を `goal` に
1 行残す。契約は Issue の写しではなく、実行可能な宣言である。

### Step 2. 検証ゲートの実在を確認する

```bash
cat <worktree_root>/.commandmate/verify.yaml
```

`gates[].id` が、契約の `verify.gates` に書ける **唯一の語彙** である。
このファイルが無い、または書こうとした id がそこに無い場合、`verify.gates` を
書いた契約は **送信時に契約エラー**になる（送信時に verify.yaml と照合される）。
その場合は `verify` キーごと省略して全ゲートに委ねるか、先に verify.yaml を
整えるかを利用者に確認する。

`work-evidence` と `scope` は組み込みゲートで、`verify.gates` ではなく
`success.requireWorkEvidence` / `success.requireScopeClean` が実行を決める。
`gates` に書く必要はない。

### Step 3. 変更されるパスを洗い出す

Issue の内容から、**実際に変更されるファイル群** を列挙する。ここで漏らしたパスは
実走時に scope ゲート不合格（`wait --verify` が exit 20）になる。

洗い出しに含めるもの:

- 実装対象のディレクトリ
- テストの置き場
- **定型の追記先**（`README.md`、`CHANGELOG.md`、`docs/module-reference.md`、
  support matrix など、そのリポジトリで「変更したら必ず更新する」と決まっている file）
- 生成物のうち **手で書き換えるもの**（生成 script の出力は allow ではなく、
  生成 script 側を allow する）

**ディレクトリ粒度で書く。** ファイルを 1 つずつ挙げると、実装中に増えた 1 ファイルで
落ちる。`skills/cmate-task-contract` と書けば配下すべてが対象になる。

### Step 4. 契約を書く

第 3 節の雛形を使い、第 4 節の表に照らして 1 キーずつ確認する。
特に **綴り**（v1 は閉じた集合。未知キーは契約エラー）。

### Step 5. 配置する

```
<worktree_root>/.commandmate/tasks/<name>.yaml
```

契約はサーバが worktree の disk から直接読むので、**送信前に commit されている必要は
ない**（オーケストレーターが worktree へ配布する運用はこれに依存する）。

一方、人間が実装する PR フローでは **feature ブランチに commit する**。契約は
レビュー対象の成果物であり、「宣言された scope」がレビューに載らないなら宣言した
意味が無い。commit できるかを先に確認する:

```bash
git check-ignore -v .commandmate/tasks/<name>.yaml
```

出力があれば `.gitignore` に無視されている。CommandMate 本体は
`/.commandmate/*` を無視しつつ `!/.commandmate/tasks/*.yaml` で契約だけを追跡対象に
戻す 2 段構えの規則を使っている。対象リポジトリが同じ規則を持たない場合は、
`.gitignore` を直すか、契約を commit しない運用にするかを利用者に確認する
（**`git add -f` で規則を迂回しないこと**）。

### Step 6. 送信する

```bash
commandmate send <worktree-id> --contract .commandmate/tasks/<name>.yaml
```

**`--contract` はメッセージ引数と同時に渡せない。** `goal` が送信本文になるので、
メッセージを別に渡すとエラーになる。

契約が不正な場合、CLI は **違反を全件** stderr に列挙して **exit 2** で終わる。
tasks 行は作られず、エージェントには何も送られない。

```
Error: invalid task contract:
  - top level: unknown key "notes" (v1 is a closed set)
  - autoYes: unknown key "allowPromtTypes" (v1 is a closed set)
```

**指摘された全件をこの 1 回で直して、再送する。** 1 件ずつ直して往復しないこと
（全件返るのはそのためである）。

> **注意: `send --contract` はバリデータではない。**
> 契約が妥当だった時点で **タスクが作られ、メッセージが実際にエージェントへ送られる**。
> 「構文チェックのつもりで叩く」ことはできない。送る準備ができてから叩くこと。
> 送信前の確認は、第 4 節の表に照らした自己レビューで行う。

### Step 7. 完了を判定する

```bash
commandmate wait <worktree-id> --verify
```

| exit | 意味 |
|---|---|
| `0` | 全ゲート合格 |
| `20` | いずれかのゲートが不合格・timeout・error（scope 逸脱もここ） |
| `21` | 作業証跡ゼロ（commit も差分も無い。`work-evidence` 不合格） |

`20` が scope ゲートで出た場合、**契約を後から緩めて通すのではなく**、まず
「その変更は本当に必要か」を確認する。必要なら契約を更新して合意し直す。
契約を追認するために書き換えるのは、契約を持たないのと同じである。

---

## 3. 雛形

以下の 2 つは、CommandMate の契約パーサ（`src/lib/tasks/contract-parser.ts`）に
実際に通して **valid** を確認した内容である。

### 3.1 最小（推奨。既定値は書かない）

```yaml
version: 1
title: "Issue #1587: cmate-task-contract package の追加"
goal: |
  Issue: https://github.com/Kewton/CommandMate/issues/1587

  ## やること
  skills/cmate-task-contract/ を追加する（SKILL.md + commandmate.skill.yaml、version 0.1.0）。

  ## 受入条件（Issue から転記。すべて検証可能な形であること）
  - `python3 scripts/validate.py` が exit 0 で終わる
  - SKILL.md の雛形が task-contract v1 のバリデーションを通る
  - README の公式 Skill 表に 1 行追加されている

  ## やらないこと
  - catalog/v1/catalog.json の編集（生成物。公開は別 Issue）
scope:
  allow:
    - "skills/cmate-task-contract"
    - "README.md"
verify:
  gates: [lint, typecheck, unit]
```

`autoYes` と `success` は既定値のままなので **書かない**。既定値の再掲は、後から
「なぜこの契約はこれを明示したのか」という読み違いを生む。

### 3.2 全キー（既定から外す必要があるときだけ）

```yaml
version: 1
title: "Issue #1587: cmate-task-contract package の追加"
goal: |
  Issue: https://github.com/Kewton/CommandMate/issues/1587
  受入条件をここに検証可能な形で転記する。
scope:
  allow:
    - "skills/cmate-task-contract"
    - "docs/design/**"
    - "README.md"
  deny:
    - "catalog/**"
verify:
  # 絞るときは理由をコメントに残す（既定は「キーごと省略 = 全ゲート」）。
  # 例: unit だけ 40 分かかるので、雛形の修正往復では lint/typecheck に絞る。
  gates: [lint, typecheck, unit]
autoYes:
  mode: safe
  allowPromptTypes: [yes_no]
  denyPatterns:
    - "[Ff]orce[- ]push"
    - "git push --force"
success:
  requireWorkEvidence: true
  requireScopeClean: true
  autoVerifyOnStop: false
```

---

## 4. フィールド仕様

正本は CommandMate の
[docs/design/task-contract.md](https://github.com/Kewton/CommandMate/blob/develop/docs/design/task-contract.md)。
以下はそれを起案の観点でまとめたもので、値はパーサの実測に基づく。

### 4.1 トップレベル

| キー | 型 | 必須 | 既定 | 制約 |
|---|---|---|---|---|
| `version` | integer | ✅ | — | `1` のみ。欠落・他の値は契約エラー |
| `title` | string | ✅ | — | 非空。最大 200 文字。**省略すると契約エラー** |
| `goal` | string | ✅ | — | 非空。最大 8000 文字。**送信メッセージ本文になる** |
| `scope` | map | — | `allow: []` / `deny: []` | `success.requireScopeClean`（既定 true）なら `allow` は 1 件以上。§4.2 |
| `verify` | map | — | 全ゲート | §4.3 |
| `autoYes` | map | — | ポリシー宣言なし | §4.4 |
| `success` | map | — | §4.5 の既定 | §4.5 |

**未知キーはトップレベル・各サブマップとも契約エラー**（v1 は閉じた集合）。
`allowPromtTypes` のような綴り間違いが黙って無視されると、「auto-yes を縛って
いるように見えて縛っていない契約」が生まれるため、実装は無視ではなく拒否する。

`goal` は Issue の写しではなく **エージェントへの指示** である。最低限これを含める:

- Issue の URL（後から辿れるように）
- 受入条件を **検証可能な形** で（「正しく動くこと」ではなく「`python3 scripts/validate.py` が exit 0」）
- やらないこと（scope 外の作業を思いつきで足させない）

### 4.2 `scope`

| キー | 型 | 既定 | 制約 |
|---|---|---|---|
| `allow` | list of string | `[]` | 各要素は非空・最大 200 文字。最大 200 件 |
| `deny` | list of string | `[]` | 同上。`allow` にマッチしても `deny` が勝つ |

パターンは **worktree root からの相対 glob**。次はいずれも契約エラー:

- 絶対パス（`/etc/passwd`）
- `..` を含むパス（`../other-repo/**`）
- NUL バイトを含む文字列

glob の解釈は glob ライブラリではなく、次の閉じた部分集合である。

| 記法 | 意味 |
|---|---|
| `**` | セグメント全体を占めるときだけディレクトリ境界を越える。**0 セグメントにもマッチ** |
| `*` | `/` を含まない任意の文字列 |
| `?` | `/` 以外の 1 文字 |
| `{a,b}` | 選択（入れ子可）。閉じていない `{` はリテラル |
| `[` `]` | **リテラル**。文字クラスではない（`src/app/[...path]/` のような path をそのまま書ける） |
| 先頭の `.` | 普通の文字。`.github/**` はそのまま読める通りに動く |

大文字小文字は区別する。バックスラッシュのエスケープは無い。

**ディレクトリを指すパターンは配下すべてにマッチする。** `src/lib`・`src/lib/`・
`src/lib/**` は同義である。裏返しに、`X/*` で「直下のみ」は表せない
（拡張子で絞る `docs/*.md` は意図通り動く）。

`.commandmate/` 配下と契約ファイル自身は `allow` の要求から除外されるので、
契約を置くために `allow` へ `.commandmate/**` を書く必要はない。
ただし **明示的な `deny` は効く**。

判定対象は「commit 済みの差分」と「作業ツリーの未 commit 変更」の **和集合** であり、
rename は移動元・移動先の **両方** が判定される。許可されたディレクトリから
ファイルを持ち出すのは、そのディレクトリへの変更である。

### 4.3 `verify`

| キー | 型 | 既定 | 制約 |
|---|---|---|---|
| `gates` | list of string | 省略 = 全ゲート | `.commandmate/verify.yaml` の `gates[].id`。最大 32 件。重複不可。id は `^[a-z0-9][a-z0-9-]{0,31}$` |

- **`gates: []`（空リスト）は契約エラー。** 「ゲート無しで合格」と読めてしまうため。
  「全部走らせる」は `verify` キーごと、または `gates` キーの省略で表す。
- 存在しない id は **送信時**（`send --contract`）に verify.yaml と照合されて契約エラーになる。
- 絞る場合は **理由をコメントで残す**。理由の無い絞り込みは、後から誰も戻せない。

### 4.4 `autoYes`

| キー | 型 | 既定 | 制約 |
|---|---|---|---|
| `mode` | string | `null` | `off` / `safe` / `allow-listed` |
| `allowPromptTypes` | list of string | `[]` | `yes_no` / `multiple_choice` / `approval` / `choice` / `input` / `continue`。最大 16 件。`mode: allow-listed` のときだけ意味を持つ |
| `denyPatterns` | list of string | `[]` | **JavaScript の正規表現**。1 件最大 200 文字、最大 32 件 |

`mode` の省略（`null`）は「契約はポリシーを述べていない」であり、`off`（自動応答を
禁止する積極的な宣言）とは異なる。既定のままでよいなら **`autoYes` ブロックごと書かない**。

`denyPatterns` は **JavaScript の `RegExp` としてコンパイルできること**。
インラインフラグ `(?i)` は JavaScript では使えず、書くと契約エラーになる
（実測: `Invalid regular expression: /(?i).../: Invalid group`）。
大文字小文字を吸収したいなら `[Ff]orce` のように文字クラスで書く。
**ここでの `[` は文字クラスである**（`scope` の glob と規則が逆なので注意）。

`denyPatterns` は `mode` を書かなくても効く。パターンを書いた契約は既に
ポリシーを述べている。

### 4.5 `success`

| キー | 型 | 既定 | 意味 |
|---|---|---|---|
| `requireWorkEvidence` | boolean | `true` | commit も差分も無い「作業ゼロ」を不合格にする |
| `requireScopeClean` | boolean | `true` | `scope` 外の変更を不合格にする（組み込み `scope` ゲート） |
| `autoVerifyOnStop` | boolean | `false` | エージェント停止イベントで検証ランを自動起動する |

`requireScopeClean` が true（既定）のまま `scope.allow` が空だと **契約エラー**である。
「スコープを守れ」と言いながらスコープを挙げていない契約は、ゲートが有効になった
瞬間にあらゆる変更を不合格にする。

`requireScopeClean: false` は「この作業では変更範囲を宣言しない」という宣言であり、
scope ゲートは `skipped` になる。**scope の洗い出しを省くために false にしないこと。**

---

## 5. よくある契約エラーと直し方

| 出力 | 原因 | 直し方 |
|---|---|---|
| `top level: unknown key "..." (v1 is a closed set)` | キーの綴り違い / v1 に無いキー | §4.1 の表と照合する。独自キーは足せない |
| `autoYes: unknown key "allowPromtTypes"` | 綴り違い | `allowPromptTypes` |
| `title: required, must be a non-empty string (got nothing)` | `title` 忘れ | 200 文字以内で 1 行書く |
| `scope.allow: at least one pattern is required while success.requireScopeClean is true` | scope 未宣言 | Step 3 に戻って洗い出す |
| `verify.gates: must name at least one gate (omit the key to run every gate)` | `gates: []` | 空リストをやめる。全ゲートなら `verify` ごと削除 |
| `verify.gates[0]: "..." must match ^[a-z0-9][a-z0-9-]{0,31}$` | 大文字・記号・長すぎ | verify.yaml の id をそのまま写す |
| `autoYes.denyPatterns[0]: not a valid regular expression` | `(?i)` など JS 非対応の記法 | 文字クラスに置き換える |
| `...: must be relative to the worktree root` / `must not escape ... with ".."` | 絶対パス / `..` | worktree root からの相対に直す |
| ゲート id が verify.yaml に無い（送信時） | 存在しない id | verify.yaml を読み直す。無いなら `verify` を省略 |

---

## 6. 禁止事項

- **バージョンゲートを飛ばして契約を書き始めない。** `--contract` の無い CommandMate では
  この Skill の成果物は動かない。
- **契約なしの送信へ黙って落ちない。** 落ちる場合は利用者に明示して合意を取る。
- **未知キーを「たぶん無視される」と仮定して書かない。** 拒否される。
- **`git add -f` で `.gitignore` を迂回しない。** 追跡規則の問題は規則側で直す。
- **バリデーション目的で `send --contract` を叩かない。** 妥当なら実際に送信される。
- **scope ゲートで落ちたことを理由に、確認せず `allow` を広げない。**
- 契約仕様 v1 自体の変更提案や v2 の起案は、この Skill の scope 外である。

---

## 7. 完了チェック

契約を提出する前に、すべて yes であることを自分で確認する。

1. `commandmate send --help` に `--contract` があることを確認したか。
2. `version` / `title` / `goal` の 3 つがすべて埋まっているか。
3. `goal` に Issue URL と、**検証可能な**受入条件が入っているか。
4. `scope.allow` に、実装先・テスト・定型の追記先がすべて入っているか。
5. `verify.gates` を書いたなら、その id が `.commandmate/verify.yaml` に実在するか。
   絞ったなら理由をコメントに残したか。
6. 既定値のままのキー（`autoYes`・`success`）を無駄に書いていないか。
7. §4.1 の表に無いキーが 1 つも無いか（綴りを 1 語ずつ照合したか）。

いずれかが no のまま送信しないこと。
