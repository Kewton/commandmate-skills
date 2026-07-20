# changelog — version 履歴、期待効果、制約

Catalog の `changelog` はこの Skill の release tag の annotation から生成される。
その annotation の元になる記述をここに置く。install 前の利用者が読む前提で書く。

## 0.1.0

初回 release。Phase 1（MVP）の公式 Skill。

### 何ができるようになるか

- Issue の受入条件を自動検証と手動確認に分け、証跡付きで検証できる。
- 判定が `go` / `conditional_go` / `no_go` の 3 値で返る。
  「たぶん大丈夫」が `go` に混ざらない。
- 結果が schema 付きの JSON（`acceptance-result.v1.json`）で返るので、
  後続の自動処理や、離席後の状態復元に使える。
- 実行した check と実行しなかった check が分けて報告される。

### 期待効果

- 受入判断の根拠が、実行者の記憶ではなく evidence として残る。
- 未検証・環境依存・flaky・未承認が pass に丸められなくなる。
- 破壊的な検証が、cleanup plan つきの確認を経てからしか走らない。

### 制約（install 前に把握しておくこと）

- **実装や修正は行わない。** 検証のみを行う Skill である。
- 実行する command は、この Skill 自身の `gh` / `git`（読み取り用途）と、
  利用者が入力として渡し確認したもの**だけ**である。project の test command を
  推測して実行しない。渡さなければ自動検証は行われない。
- 対話できない実行形態では、`confirm_required` の check は必ず未実行になる。
  その分 `status` は `partial` に留まる。これは仕様であって不具合ではない。
- 受入条件が Issue 本文に定義されていない場合は判定せず `failure` を返す。
- 判定の質は受入条件の書かれ方に依存する。曖昧な条件は `not_verifiable` になる。
- この version の評価は `tests/fixtures/cmate-acceptance-test/` の deterministic
  fixture と rubric によるものである。実 Agent での opt-in 実機評価は未実施であり、
  `compatibility.agents` の `support` はその範囲でのみ `native` を宣言している。

### 権限と risk

- `declared_risk`: `moderate`
- 宣言権限: `filesystem_read` / `filesystem_write` / `process_execution` /
  `network_access` / `environment_read`
- script file と実行 bit 付き file は含まない。install / update が script や hook を
  自動実行することはない。
- network は Issue 本文の取得（`api.github.com` / `github.com`）に限る。

### 再読み込み

更新の反映手順は
[`agent-compatibility.md`](./agent-compatibility.md) の「再読み込み」を参照する。
要点は、install 後に Agent の session を開始し直すこと、そして反映確認は
`commandmate.skill.yaml` の `version` で行うことである。
