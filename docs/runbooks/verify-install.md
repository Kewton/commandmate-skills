# Runbook: release 後のクリーン環境での導入検証

対象読者: maintainer、および互換宣言（`compatibility.agents`）を更新する人。

このリポジトリの CI が見られるのは **package が正しいこと**までである。
「Catalog に出るか」「install できるか」「install 先から Agent が発見できるか」は、
release（tag → `release` environment 承認 → Catalog publish）が済んだ後にしか測れない。
その 1 回きりの検証手順を、記録すべき項目まで含めてここに置く。

**測っていないものを `native` と書かないこと。** 互換宣言の事実誤りは
[Kewton/CommandMate#1513](https://github.com/Kewton/CommandMate/issues/1513) の発端であり、
この runbook はその再発を防ぐためにある。

前提: CommandMate 0.15.0 以降（`.agents/skills` と `.claude/skills` の両方へ配置するのは
[#1460](https://github.com/Kewton/CommandMate/issues/1460) 以降の挙動）。

---

## 0. 隔離環境を用意する

**本番の DB と worktree に触れないこと。** 専用ポート・専用 DB・skills 未導入の新規 git リポジトリで
測り、測定後に環境を破棄する。ここには 2026-07-31 の監査
（[CommandMate#1590](https://github.com/Kewton/CommandMate/issues/1590)）で踏んだ罠を書いてある。

### 0-1. 置き場所: config dir を `/tmp` `/var` 配下に置かない

CommandMate の config dir（`$HOME/.commandmate`）を system directory 配下に置くと、
skill snapshot store が初期化できず **install が必ず失敗する**。

```
Error: The Skill artifact could not be retrieved. [SKILL_SNAPSHOT_STORE_IO]   # exit 1
```

`/etc /usr /bin /sbin /var /tmp /dev /sys /proc` が対象で、**macOS の `mktemp -d` は
`/var/folders/…` に落ちる**。したがって隔離用 HOME を `mktemp -d` で作ると、この症状を踏む。
**専用 HOME は real home 配下（例 `~/.cmate-probe-<issue>`）に置くこと。**
worktree 側は `/tmp` 配下でも install できる（実測済み）ので、隔離が要るのは config dir である。

### 0-2. 継承された `CM_*` env を潰す

CommandMate の worker シェルには `CM_ROOT_DIR` / `CM_DB_PATH` / `CM_PORT` が既に export
されていることがある。**dotenvx は既存の env を上書きしない**ため、隔離用 `.env` を書いても
黙って無視され、**専用ポートで起動したサーバが本番 DB を掴む**。2026-07-31 の監査では実際にこれを踏んだ
（`commandmate ls` が本番 worktree を列挙したことで気づき、当該 PID のみ kill して復旧した）。

wrapper 越しに毎回明示 export するのが確実である。

```bash
PROBE=~/.cmate-probe-1590                 # real home 配下（0-1）
mkdir -p "$PROBE/home" "$PROBE/root"
git -c init.defaultBranch=main init "$PROBE/root/probe-repo"
git -C "$PROBE/root/probe-repo" commit --allow-empty -m init
git -C "$PROBE/root/probe-repo" worktree add -b probe1 "$PROBE/root/probe-repo-probe1"

cat > "$PROBE/cmp" <<EOF
#!/bin/sh
export HOME="$PROBE/home"
export CM_ROOT_DIR="$PROBE/root"
export CM_DB_PATH="$PROBE/home/.commandmate/data/cm.db"
export CM_PORT=39590                      # 本番の 3000 と衝突しない専用ポート
export CM_BIND=127.0.0.1
export WORKTREE_REPOS="$PROBE/root/probe-repo"   # 0-3
exec <commandmate を install した prefix>/node_modules/.bin/commandmate "\$@"
EOF
chmod +x "$PROBE/cmp"
```

起動したら **`commandmate ls` の出力が probe の worktree だけ**であることを必ず確認する。
本番の worktree が 1 つでも出たら本番 DB を掴んでいる。即座にそのサーバを止める。

### 0-3. worktree を登録する

サーバは `WORKTREE_REPOS`（カンマ区切りの repository path）を渡さないと worktree を 1 つも
認識せず、`--worktree` に渡す ID が得られない。登録後に起動し直すと `<repo 名>-<branch>` の
ID で出る。以降 `WT` とする。

```bash
"$PROBE/cmp" --no-open start --daemon --port 39590
"$PROBE/cmp" ls          # -> probe-repo-main / probe-repo-probe1
```

### 0-4. CLI の version を確認する

`commandmate --version` が 0.15.0 未満なら `skill` サブコマンド自体が無いことがある
（Homebrew 版は npm 版より古いことがある）。**測定に使う CLI の version を記録すること。**

## 1. Catalog に出ているか

```bash
commandmate skill list --json | grep -o '"id": *"[^"]*"'
commandmate skill info <skill-id> --version <version>
```

出ない場合、release が Catalog へ publish されていない
（`catalog/v1/catalog.json` に当該 version の entry があるかを先に見る）。

## 2. install する

```bash
# 書き込み無しで plan を見る
commandmate skill plan <skill-id> --worktree "$WT" --version <version>

# 実行。非対話環境では --yes が必須。high-risk package は --ack-risk の完全一致も必要
commandmate skill install <skill-id> --worktree "$WT" --version <version> \
  --yes --ack-risk <skill-id>@<version>
```

`declared_risk: high` の package は `--yes` だけでは通らない（exit 12）。
**通ってしまったらそれ自体が不具合**である。

どれが high かを README や本書の列挙で判断しないこと（本書はかつて 3 件と書いたまま
`cmate-verify` の追加に追随できていなかった）。**正本は各 package の
`commandmate.skill.yaml` の `declared_risk`** であり、`commandmate skill info <skill-id>`
の `RISK` 列でも確認できる。リポジトリからはこう出す。

```bash
grep -l '^declared_risk: high' skills/*/commandmate.skill.yaml
```

## 3. 配置を確認する（両 root・byte-identical）

```bash
cd <worktree path>
ls -d .agents/skills/<skill-id> .claude/skills/<skill-id>
diff -r .agents/skills/<skill-id> .claude/skills/<skill-id> && echo "byte-identical"

# receipt が両 root を記録しているか（install_roots は receipt file 側にある。
# skill status --json は installed と plan しか返さない）
python3 -c "import json;print(json.load(open('.agents/skills/<skill-id>/.commandmate-receipt.json'))['install_roots'])"
```

`.claude/skills` 側が無ければ CommandMate が 0.15.0 未満である。
その環境で Claude の discovery を測っても、測っているのは installer の version であって
package ではない。

### 3.1 Catalog に無い package を手で両置きする

publish 前の package は `skill install` の経路が無い（`skill info` が exit 2
`SKILL_NOT_FOUND`）。それでも Agent からの発見を測りたいときは、**両 root へ手で置く**。
片側だけに置くと、Claude か Codex のどちらかから必ず不可視になる（第 5 節の対照実験）。

```bash
cd <worktree path>
for ROOT in .agents/skills .claude/skills; do
  mkdir -p "$ROOT"
  rm -rf "$ROOT/<skill-id>"
  cp -R <commandmate-skills>/skills/<skill-id> "$ROOT/<skill-id>"
done

# 両置きの検証（必須）
diff -r .agents/skills/<skill-id> .claude/skills/<skill-id> && echo "byte-identical"
```

手動配置には receipt が付かない。CommandMate から見ると未 install のままなので、
**`skill status` / `skill uninstall` の対象にならない**。測定が済んだら手で消すこと。
publish 後は必ず catalog 経由で追試し、その結果で
[agent-support-matrix.md](../agent-support-matrix.md) の「経路」列を更新する。

## 4. 配布物が manifest と一致するか

```bash
cd .agents/skills/<skill-id>
python3 - <<'PY'
import hashlib, pathlib, re
text = pathlib.Path('commandmate.skill.yaml').read_text(encoding='utf-8')
block = text.split('\nfiles:\n', 1)[1]
entries = re.findall(r"- path: '?([^'\n]+)'?\n\s+sha256: '?([0-9a-f]{64})'?", block)
bad = [p for p, d in entries
       if hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest() != d]
print(f'{len(entries)} declared files, mismatches: {bad or "none"}')
PY
```

artifact そのものを Catalog の digest まで遡って検証する手順は
[verify-artifact.md](./verify-artifact.md) にある。

## 5. Agent から発見できるか

**TUI プローブは必ず throwaway な tmux セッションで行う。** 稼働中の worker セッションを流用すると
composer の残テキストに入力が混ざる。また **update / trust prompt に盲目的に Enter を送らない**
（過去に Codex を意図せずグローバル更新した事故がある）。毎回 `capture-pane` で画面を読み、
caret がどの選択肢にあるかを確認してから Enter を送る。終わったら `kill-session` する。

```bash
tmux new-session -d -s probe-<issue> -c <worktree path> -x 200 -y 60
tmux send-keys -t probe-<issue> 'codex' Enter
tmux capture-pane -t probe-<issue> -p        # ← 先に読む
# 例: update prompt が出ていたら caret を "Skip" へ動かしてから Enter
tmux send-keys -t probe-<issue> Down
tmux capture-pane -t probe-<issue> -p        # ← caret 位置を確認
tmux send-keys -t probe-<issue> Enter
...
tmux kill-session -t probe-<issue>
```

### Claude Code

1. その worktree で **新しい session** を開始する（既存 session は古い discovery のまま）。
2. slash palette に `/<skill-id>` が出るか、scope 表示（`(project)`）とともに確認する。
   palette は一度に数件しか出さないので、**skill-id 単位で prefix を打って**全件を潰す。
3. `~/.claude/skills` と `~/.claude/commands` が無いことを確認する。あると user scope の
   skill が混ざり、project の配置を測ったことにならない。
4. 出た／出ないと、**Claude Code の exact version** を記録する。

Claude は `.claude/skills` を読み、`.agents/skills` は読まない。
`.claude/skills` 側の配置（手順 3）が前提である。

### Codex CLI

1. 新しい session を開始する。
2. slash palette を確認する。**0.145.0 では skill は slash として露出しない。**
   対照として `/mo` → `/model` がマッチすることを確かめれば、palette 機構自体は
   正常だと切り分けられる。
3. 発見の確認は、**tool を使わないよう指示したうえで** SKILL.md の絶対 path を答えさせる。
   これは **model の自己申告**であり機械的証跡ではない。記録にそう書くこと。

### どちらの root を読んでいるかを確定させる（対照実験）

「両 root へ置いたら両方から見えた」だけでは、どちらの root が効いているか分からない。
片側だけ消して**新しい session**で測り直すと確定する。2026-07-31 の結果は次のとおり。

| 操作 | Agent | 期待される結果 |
|---|---|---|
| `.claude/skills/<id>` だけ削除 | Claude Code | palette から `<id>` が消える（他の skill は残る） |
| `.agents/skills/<id>` だけ削除 | Codex CLI | 列挙から `<id>` が消える |

消した側を戻すのを忘れないこと（`cp -R` し直して `diff -r`）。
この実験は **`claude: native` が両 root 配置に依存している**ことの証拠でもある。
片置きに戻す変更が入ったら、この宣言は即座に嘘になる。

### 同梱 script の smoke test（`cmate-orchestrate-monitor`）

```bash
.agents/skills/cmate-orchestrate-monitor/scripts/verify-completion.sh \
  --started 1 --state IDLE --idle-streak 8 --idle-threshold 8 --commits 1 --uncommitted 0
# -> COMPLETE
```

## 6. 記録する

| 項目 | 例 |
|---|---|
| 測定日 | 2026-07-31 |
| CommandMate | 0.16.0（npm 公開版と同一か） |
| Agent と version | Claude Code 2.1.220 / Codex CLI 0.145.0 |
| OS / Node | macOS 26.5.2 / v24.1.0 |
| 対象 Skill と version | 測った package を全部（1 件で代表させたなら、そう書く） |
| 配置経路 | catalog install / 手動両置き（3.1） |
| 配置 | 両 root・`diff -r` 差分なし |
| 発見 / slash 呼出 | Agent ごとに YES / NO |
| 証跡の性質 | 機械的 / self-report |
| 未計測 | Gemini / OpenCode / vibe-local |

**未計測の Agent は `unknown` のままにする。** 「たぶん動く」は記録ではない。
**1 package で測った結果を全 package に敷衍したなら、敷衍だと書く。**
package 単位で測ったのか install 経路の共通性から言っているのかは、後から必ず問題になる。

## 7. 後始末

隔離環境を破棄し、本番（既定ポート・既定 DB）が無傷であることを確認する。

- probe サーバの PID だけを止める（本番サーバを巻き込まない）
- probe の HOME / root を削除する
- `tmux ls` に `probe-*` セッションが残っていないこと
- TUI が書いた global config を戻す（例: Codex は trust した path を `~/.codex/config.toml` に
  書く。プローブ前にバックアップし、後で差分を消す）
- Agent CLI の version が**プローブ前と同じ**であること（update prompt を踏んでいない証拠）

## 8. 結果を反映する

1. [docs/agent-support-matrix.md](../agent-support-matrix.md) を更新する。
2. 該当 package の `compatibility.agents[].support` / `evidence` を更新する。
   **manifest を変えたら `version` を必ず上げる**（公開済み version は immutable。
   `build_catalog.py` は同一 version の再登録を拒否する）。
3. `python3 scripts/validate.py` を回し、**終了コードを実測**する。

---

## よくある結果と読み方

| 症状 | 意味 |
|---|---|
| `.claude/skills` に無い | CommandMate が 0.15.0 未満。installer の問題であって package の問題ではない |
| Codex の palette に出ない | 0.145.0 の仕様。配置先の問題ではない（対照実験で切り分け済み） |
| install が digest 検査で失敗する | pin が機能している状態。別 artifact で retry せず、事象として報告する |
| high-risk package が `--yes` だけで入る | 承認ゲートの不具合。install を止めて報告する |
| `SKILL_SNAPSHOT_STORE_IO`（exit 1） | config dir が `/tmp` `/var` 配下。取得失敗ではない（0-1） |
| `skill info` が exit 2 `SKILL_NOT_FOUND` | まだ publish されていない。手動両置き（3.1）で測る |
| `skill install` が exit 11 | 既に入っている等で worktree が拒否した。二重実行を疑う |
| `commandmate ls` に本番の worktree が出る | 本番 DB を掴んでいる。即座に止める（0-2） |
| `skill` サブコマンドが無い | CLI が古い。npm 公開版と Homebrew 版の version 差を疑う（0-4） |
