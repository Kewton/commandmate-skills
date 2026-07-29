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

**本番の DB と worktree に触れないこと。** 過去の実測では、専用ポート・専用 DB・
skills 未導入の新規 git リポジトリで測り、測定後に環境を破棄している。

```bash
WORK=$(mktemp -d)
git -c init.defaultBranch=main init "$WORK/probe"
cd "$WORK/probe" && git commit --allow-empty -m init

# CommandMate は専用ポート・専用 DB で起動する（起動方法は CommandMate 側の手順に従う）。
# 本番（既定ポート・既定 DB）へ相乗りしないこと。
```

worktree を 1 つ登録し、その worktree-id を控える（`commandmate ls`）。以降 `WT` とする。

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

`declared_risk: high` の package（**`cmate-worktree-cleanup` / `cmate-orchestrate` /
`cmate-orchestrate-monitor` の 3 件**）は `--yes` だけでは通らない。
**通ってしまったらそれ自体が不具合**である。

どれが high かを README や本書の列挙で判断しないこと。**正本は各 package の
`commandmate.skill.yaml` の `declared_risk`** であり、`commandmate skill info <skill-id>`
の `RISK` 列でも確認できる。

## 3. 配置を確認する（両 root・byte-identical）

```bash
cd <worktree path>
ls -d .agents/skills/<skill-id> .claude/skills/<skill-id>
diff -r .agents/skills/<skill-id> .claude/skills/<skill-id> && echo "byte-identical"

# receipt が両 root を記録しているか
commandmate skill status <skill-id> --worktree "$WT" --json
```

`.claude/skills` 側が無ければ CommandMate が 0.15.0 未満である。
その環境で Claude の discovery を測っても、測っているのは installer の version であって
package ではない。

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

### Claude Code

1. その worktree で **新しい session** を開始する（既存 session は古い discovery のまま）。
2. slash palette に `/<skill-id>` が出るか、scope 表示（`(project)`）とともに確認する。
3. 出た／出ないと、**Claude Code の exact version** を記録する。

Claude は `.claude/skills` を読み、`.agents/skills` は読まない。
`.claude/skills` 側の配置（手順 3）が前提である。

### Codex CLI

1. 新しい session を開始する。
2. slash palette を確認する。**0.145.0 では skill は slash として露出しない。**
   対照として `/mo` → `/model` がマッチすることを確かめれば、palette 機構自体は
   正常だと切り分けられる。
3. 発見の確認は、**tool を使わないよう指示したうえで** SKILL.md の絶対 path を答えさせる。
   これは **model の自己申告**であり機械的証跡ではない。記録にそう書くこと。

### 同梱 script の smoke test（`cmate-orchestrate-monitor`）

```bash
.agents/skills/cmate-orchestrate-monitor/scripts/verify-completion.sh \
  --started 1 --state IDLE --idle-streak 8 --idle-threshold 8 --commits 1 --uncommitted 0
# -> COMPLETE
```

## 6. 記録する

| 項目 | 例 |
|---|---|
| 測定日 | 2026-07-26 |
| CommandMate | 0.15.0（npm 公開版と同一か） |
| Agent と version | Claude Code 2.1.220 / Codex CLI 0.145.0 |
| OS / Node | macOS 26.5.2 / v24.1.0 |
| 対象 Skill と version | `cmate-repository-analysis` 0.1.0 |
| 配置 | 両 root・`diff -r` 差分なし |
| 発見 / slash 呼出 | Agent ごとに YES / NO |
| 証跡の性質 | 機械的 / self-report |
| 未計測 | Gemini / OpenCode / vibe-local |

**未計測の Agent は `unknown` のままにする。** 「たぶん動く」は記録ではない。

## 7. 後始末

隔離環境を破棄し、本番（既定ポート・既定 DB）が無傷であることを確認する。

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
