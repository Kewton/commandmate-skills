# Agent 差異と互換宣言

この Skill は特定の Agent の tool 名・命令形式に依存しない。判定は同梱の bash script が行い、
Agent は script を呼んで出力トークン（`GENERATING` / `COMPLETE` …）を解釈するだけである。
したがって同じ capture からは同じ判定が出る。

## 1. 必要な能力

| 能力 | 用途 | 無いときの動作 |
|---|---|---|
| shell command の実行 | script の実行 | この Skill は成立しない。`process_execution` を要求する |
| file の書き込み | ポーリング結果と worker 横断状態の保持（temp directory） | ループが回らない。`filesystem_write` を要求する |
| `tmux` の実行 | 介入（Enter / `a` / 再送）の送出 | 分類と完了判定は動くが、介入が worker へ届かない |
| `git` の実行 | 完了フック（`hooks-git.sh`） | 完了判定が発火しない（[SKILL.md](../SKILL.md)「フックを配線する」節） |

`monitor.sh` の既定 launcher は `npx commandmate@latest` である。npm registry への network access を
避けたい場合は `CM=commandmate` を指定する。

## 2. Agent の責務

1. 監督対象の worktree-id を決める。
2. `monitor.sh` を **`--verbose --hooks` 付き**で起動する（証拠が残らない起動は避ける）。
   自分でループを回す場合は、分類を `classify-state.sh`、完了判定を `verify-completion.sh` に委ねる。
3. 出力を **そのまま**報告する。capture の JSON を自前で grep して状態を判断しない。
4. `NOT_STARTED` を「たぶん終わった」と読み替えない。フック未配線の可能性を先に疑う。

script が exit 2 で失敗した場合、その原因（引数不正・hooks file 不在）は stderr に出ている。
Agent はそれを報告し、**推測で監視結果を捏造しない**。

## 3. 互換宣言の方針

manifest の `compatibility.agents` には **実測した Agent と CLI version の結果だけ**を書く。
`unknown` は「動かない」ではなく「確認していない」である。

| agent | 宣言 | 根拠 |
|---|---|---|
| `claude` | `native` | Claude Code 2.1.220 で、install された Skill を `.claude/skills` から発見し slash palette からも呼び出せることを実測（2026-07-26）。installer は `.agents/skills` と `.claude/skills` の両方へ byte-identical に配置する |
| `codex` | `native` | Codex CLI 0.145.0 が `.agents/skills` の `SKILL.md` を読むことを確認。ただし **発見は model の自己申告**であり、**この version は skill を slash command として露出しない** |
| `gemini` | `unknown` | 未計測 |
| `opencode` | `unknown` | 未計測 |

測定条件と限界は [evidence.md](./evidence.md) 第3節に記録してある。

### CommandMate version の宣言

`compatibility.commandmate` はスキーマ上 **1 本のレンジしか持てない**ので、そこに書くのは
**package 全体の下限**（`>=0.15.0`＝フォールバック経路が成立する最小版）である。
経路ごとの最小版は **台帳による一次ソースが `>=0.17.0`、`hold:policy` の検出が `>=0.21.0`** で、
どちらも無くて Skill は成立する（[SKILL.md](../SKILL.md)「どちらの経路で走っているか」節）。

どちらの経路で走っているかを **version の照合で決めない**。実行時に判る:
台帳が引けなければ `FALLBACK MODE` 行が出て、引ければ poll 行に `task=` が付く。
「現時点の公開版は…」という形の断定を SKILL.md に書かないのはこのためである
（0.4.0 の SKILL.md にはそれがあり、書いた当日に嘘になった。[evidence.md](./evidence.md) 第1b節）。

### Codex での呼び出し方（既知の制約）

Codex CLI 0.145.0 では `/cmate-orchestrate-monitor` のような slash 呼出はできない。
skill 名を自然文で指示するか、script を直接実行する。

```bash
<skill-dir>/scripts/monitor.sh --verbose --hooks <skill-dir>/scripts/hooks-git.sh <worktree-id>
```

判定コアは shell script なので、**どの Agent から呼んでも結果は同じ**である。
slash 露出の有無は discovery の利便性の問題であって、Skill の成否ではない。

## 4. install 後の確認

```bash
# 両 root に配置されているか（#1460 以降の挙動）
ls .agents/skills/cmate-orchestrate-monitor .claude/skills/cmate-orchestrate-monitor
diff -r .agents/skills/cmate-orchestrate-monitor .claude/skills/cmate-orchestrate-monitor

# script が実行できるか（判定コアの smoke test）
.agents/skills/cmate-orchestrate-monitor/scripts/verify-completion.sh \
  --started 1 --state IDLE --idle-streak 8 --idle-threshold 8 --commits 1 --uncommitted 0
# -> COMPLETE
```
