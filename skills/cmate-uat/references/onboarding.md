# リポジトリをこの運用に載せる

**1 リポジトリにつき 1 回**やる作業をまとめたもの。以降の run はこの上で回る。

想定する体制は 4 層である。

```
人 → 窓口セッション → develop の管理セッション（cmate-orchestrate）→ feature/bug のワーカー
```

人に届くのが**申し送りがある Issue だけ**になることが目的で、この文書はそのための準備である。

---

## 1. 宣言ファイルは 3 つ

| ファイル | 宣言する内容 | 起案する Skill |
|---|---|---|
| orchestrate の profile | 分岐元・branch と worktree の雛形・ワーカーの baseline | [cmate-orchestrate](../../cmate-orchestrate/) の `profile-init.mjs` |
| `.commandmate/verify.yaml` | lint / typecheck / test などの検証ゲート | [cmate-verify](../../cmate-verify/) の init |
| `.commandmate/uat.yaml` | 起動・停止・health・ポート範囲・**隔離の実測**・任意の e2e | この Skill（[契約](./uat-yaml-contract.md) 第 5 節） |

**3 つとも「人が書く宣言」である。** 下書きと検証は管理セッションがやってよいが、
承認するのはリポジトリの持ち主である。

`uat.yaml` は `.gitignore` の除外に当たることがある。CommandMate 自身では
`!/.commandmate/uat.yaml` の 1 行を例外に足している（run の成果物は `.commandmate/uat/` に
出るので、**prefix ではなくファイル 1 本を名指す**）。

---

## 2. 起案の流れ

1. 人が窓口へ「このリポジトリを載せて」と頼む。
2. 管理セッションが 3 つを起案する。**どこから拾ったかと、判断材料が無かった項目**を添える。
3. 窓口が起案を人に見せ、人が承認する。
4. 管理セッションが書き出し、`up` → `health` → `isolation.checks` → `down` を 1 周させる。
5. PR で commit する。

**`isolation.checks` だけは起案で埋めない。** 何が本番なのかはリポジトリの外の事実で、
推測で書いた検査は「通ること」しか保証しない（[契約 第 5.2 節](./uat-yaml-contract.md)）。

---

## 3. 管理セッションの権限

この Skill は**プロセスを起動し・ファイルを書き・ポート単位でプロセスを止める**。
管理セッションにその許可が無いと、**警告なく無作業のまま成功として終わる**ことがある。

### 3.1 Command Code

対話セッションの権限モードは、worktree の `.commandcode/settings.local.json` の
`permissions.defaultMode` で**起動時に**決まる。

```json
{ "permissions": { "defaultMode": "bypass" } }
```

| mode | 意味 |
|---|---|
| `default` | 編集と command のたびに訊く。**無人運転では止まる** |
| `auto-accept` | 編集は無確認。**shell は訊く**ので、環境の起動で止まる |
| `bypass` | 全部無確認（`--yolo` と同じ） |
| `dont-ask` | 一切訊かず、**`permissions.allow` に無いものは無言で deny** |

**`dont-ask` は勧めない。** 規則に無い形が無言で失敗し、「作業ゼロなのに成功」に見える。
無人運転なら `bypass`、規則を固めたいなら `dont-ask` ＋ `permissions.allow` を明示的に書く。

書いたら**フッタで確かめる**。`» permission bypass on` が出ていれば効いている。
設定ファイルを書いただけで確かめないのは、この Skill が禁じている「実測しない」に当たる。

### 3.2 Antigravity

対話モードは hooks の許可判定を無視してダイアログを出すので、事前許可は
`~/.gemini/antigravity-cli/settings.json` の `permissions.allow` に書く。

```json
{ "permissions": { "allow": ["command(node)", "command(npm)", "command(gh)", "command(bash)"] } }
```

規則は `command(<prefix>)` で、token は full word 照合である（`git` は `git add` に当たり
`github` には当たらない）。**`command(git)` を入れると push まで通る**ので、最初は入れずに
おくのが無難である。

初回起動の **trust ダイアログ**を承認しないと、project の customization（Skill を含む）が
丸ごと落ちる。承認は `trustedWorkspaces` に永続する。

---

## 4. 窓口から管理セッションへの依頼文

定型に**「確認を求めず進める」を入れる**。これが無いと、モデルが下書きを作って
「送ってよいか」と訊いて止まることがある（実測）。

```
リポジトリ <repo> の Issue #<n> ... を受け入れてください。
- cmate-uat を使い、.commandmate/uat.yaml の宣言で環境を立てる
- 画面を確かめる TC は、自分の道具で実行できるかを TC ごとに判断する。
  できなければ manual_pending にして申し送りに回す（人に問い合わせて待たない）
- 不合格は修正せず記録して止める
- 確認を求めず進める。判断に迷ったら申し送りに書く
- 終わったら uat-report.md の「申し送り」節だけを要約して返す
```

最後の 1 行が、人に届く量を決める。**報告書全文を返させない。**

---

## 5. 最初の run で確かめること

1. `isolation.checks` が**実際に落ちる**ことを 1 回見る（DB path をわざと本番へ向けて、
   `blocked` で止まることを確かめる）。落ちない検査は書いていないのと同じである。
2. `env.down` の後にポートが解放されること。
3. `acceptance/issue-<n>.json` が `cmate-orchestrate` の `--acceptance-dir` で `loaded` に
   なること（runner が 0.33.0 以降であること）。
4. 申し送りが窓口経由で人に届くこと。

---

## 6. よくある失敗

| 症状 | 原因 |
|---|---|
| UAT が本番のデータを書き換えた | `isolation.checks` が空か、キーごと無い。**「別ポートだから別環境」は成り立たない** |
| 無関係なブラウザタブの通信が切れた | `env.down` が `lsof -ti:<port>` 形。LISTEN で絞る |
| 成功したのに何も変わっていない | 管理セッションの書き込み権限が無い（第 3 節） |
| `prompt not ready` で送信できない | 相手セッションの cold start。2 分ほど待って再送する |
| 画面 TC が全部 `manual_pending` | `ui.e2e` が未宣言で、実行者にブラウザ操作の手段が無い |
| run ディレクトリが commit に入った | `.gitignore` の例外を prefix（`uat*`）で書いた。ファイル 1 本を名指す |
