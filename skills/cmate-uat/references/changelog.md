# changelog — version 履歴、期待効果、制約

Catalog の `changelog` はこの Skill の release tag の annotation から生成される。
その annotation の元になる記述をここに置く。install 前の利用者が読む前提で書く。
**新しい version を上に置く。version を上げたらこの file も同じ commit で更新する。**

## 0.1.0

初回リリース。**実機環境を立ててから**受入条件を検証する手順を追加した（#260）。

### なぜ要るか

[cmate-acceptance-test](../../cmate-acceptance-test/) は**渡された対象を検証する判定器**で、
環境を立てない。サーバや DB を起動しないと確かめられない受入条件は `manual_pending` にしか
落とせず、`cmate-orchestrate` の uat では `acceptance_conditional`（owner `human`）で止まる。
つまり**実機確認が要る Issue は、必ず人が呼ばれる**。

この Skill はその穴を埋める。環境の起動・隔離の実測・TC の実行・証跡の収集・判定・停止までを
1 本で行い、判定を `acceptance-result.v1` として返すので、runner が無人で裁定できる。

**両方を直列に回す形は採っていない。** acceptance-test は外から渡された証跡を受け取る入力を
持たないので、直列にすると受入条件の抽出・計画の確認・実行・証跡の記録がまるごと二重になる。
そこで同じ schema を共有し、runner が producer を 2 値で受ける形にした
（`cmate-orchestrate` 0.33.0 / #259）。

### できるようになること

- `.commandmate/uat.yaml` にリポジトリ単位で環境を宣言し、**同じ手順を別のリポジトリでも回せる**。
  CommandMate 専用の起動手順が手順書に埋まっている状態から抜ける
- **隔離を実測してからテストを始める。** `isolation.checks` が 1 つでも落ちたら
  テストを 1 つも実行せずに `blocked` で止まる
- 複数 Issue を 1 つの環境で受け入れ、**報告書を 1 本**にまとめる
- 画面 TC を実行できない実行者でも、`manual_pending` として**申し送りに残る**（pass に丸めない）
- 判定が `cmate-orchestrate` の `--acceptance-dir` にそのまま渡る

### 制約（この version で意図的にやらないこと）

- **修正しない。** 不合格は記録して止まり、修正は orchestrate の fix loop か別手順へ渡す
- **HTML の報告書を出さない。** 人が読む面は `uat-report.md` 1 本、機械が読む面は
  `acceptance/issue-<n>.json` である
- **`uat.yaml` が無い無人 run では起案しない。** 推測した command で未知のプロセスを
  起動しないためで、`uat_yaml_missing` で停止する
- **画面 TC で人を待たない。** 実行できなければ `manual_pending` にして先へ進む
- schema はこの package に複製していない。正本は `cmate-acceptance-test` 側の 1 本である

### 要る環境

- `bash`（同梱 script は bash 3.2 互換。実行 bit は付いていない）
- `lsof` か `ss`（ポートの listener を特定する。**どちらも無ければ停止する** ——
  「listener が居ない」と「判別できない」を同じ扱いにしないため）
- `gh` / `git`（Issue の取得と対象の解決。読み取りのみ）
- `curl`（`env.health` に URL を使う場合）

### 既知の未計測

- `compatibility.agents` の `claude` / `codex` / `opencode` / `command-code` は
  **install 経路の共通性からの敷衍**であり、この package 単体では測っていない。
  `antigravity` は 2026-09-16 に経路を実測した（[matrix 第 3.5 節](../../../docs/agent-support-matrix.md)）
- `gemini` / `copilot` は未計測（`unknown`）
- **この手順を最後まで回した rubric 評価は、どの Agent でも未実施**である。
  0.1.0 が固定しているのは手順と同梱 script の振る舞いまでで、実機 run は
  最初の適用で測る
