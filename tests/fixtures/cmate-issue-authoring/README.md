# tests/fixtures/cmate-issue-authoring/

`skills/cmate-issue-authoring/` の回帰テスト。package には含まれない
（`commandmate.skill.yaml` の `files:` に無いものは artifact に入らない）。

```bash
bash tests/fixtures/cmate-issue-authoring/run_tests.sh
```

必要なのは bash と node だけ。network に出ない。

## 何を証明しているか

### 1. validator が空振りでないこと

`cases/valid-full.json` と `cases/valid-minimal.json` は schema と全 rule を満たす計画で、
どちらも exit 0 で通る。その上で、**通る計画に 1 箇所だけ変異を注入**して
「その変異を捕まえるはずの rule が実際に発火すること」を全 rule について確かめる。

変異は `mutate.mjs` が JSON Pointer で当てる。bad fixture を 40 個 commit する代わりに
変異注入にしてあるのは、case が主張しているものが**編集そのもの**
（`set /issues/0/depends_on ["rotation-metrics"]` → `acyclic_dependencies`）になり、
1 行で読めて、元の good fixture から乖離しないためである。

exit code は 3 値である。`1`（計画が invalid）と `2`（run 自体の失敗）を混同すると、
「検証していない」が「検証して通った」に化ける。両方を別々に固定してある。

### 2. Phase 1 が GitHub に触れないこと

受入条件の「承認無しで GitHub に一切 mutation しない」は主張では足りないので、
機械で確かめている。

- 呼び出しを log に書くだけの `gh` を PATH の先頭に置いて validator を走らせ、
  **log file が作られないこと**（= `gh` が 0 回呼ばれたこと）を確認する。
- package が同梱する script を `gh issue create` / `gh pr create` / `git push` /
  `--method POST` 等で grep し、1 件も無いことを確認する。
- 適合する計画が「read-only な command しか記録していない」ことを positive control として
  確認する（`dry_run_has_no_mutating_command` rule の裏返し）。

### 3. 出力が目標品質に届くこと

`to-issue-json.mjs` が計画を Phase 2 と同じ手順で本文に描画し
（`{{issue:<key>}}` → `#<番号>`）、**実物の `skills/cmate-orchestrate/scripts/orchestrate.mjs`**
に食わせる。`assert-planner-clean.mjs` が、生成された execution plan について

- どの Issue にも blocking question が無い
- objective・受入条件・対象 file が planner に読み取れている
- 依存が計画どおり復元されている（多くも少なくもない）

ことを確かめ、plan に `open_questions` risk factor が載っていないことも確認する。

planner の抽出が変われば、ここが落ちる。落ちたら
`skills/cmate-issue-authoring/references/issue-body-contract.md` と validator の
`planner_ready` rule を実測に合わせて直すこと（**この suite を緩めない**）。

### 4. planner mirror が乖離していないこと

`scripts/validate-plan.mjs` の抽出は cmate-orchestrate planner の**逐語の写し**である。
写しである以上、放っておけば必ず乖離する。`mirror-conformance.mjs` が 2 層で確かめる。

1. **定数が byte 単位で同一**であること（`ACCEPTANCE_HEADING_RE` / `HEADING_RE` /
   `FILE_EXT` / `SYSTEM_ROOTS` / `PATH_START` / `CANDIDATE_*` /
   `DELIVERABLE_HEADING_RE` / `CONTEXT_HEADING_RE`）。
2. **関数の挙動が同一**であること。両者のミラー領域をそれぞれ module として読み込み、
   各定数を突く corpus を流して、抽出結果（objective・受入条件・候補 path・成果物・
   引用のみ・suspected）が全 field 一致することを確認する。定数が同じままコードだけ
   ずれる乖離は、1 だけでは捕まらない。

**比較するのはミラー領域だけである。orchestrate.mjs 全体の digest は取らない。**
全体ハッシュはミラーと無関係な planner の変更で落ちるので、「落ちても気にしない test」
になるためである。読む範囲は marker で決めており（`firstNonEmptyLine` から
`isSafeRepoPath` の直前まで、＋ `classifyFileCandidates` 1 関数）、marker が動いたら
**exit 2** で「比較できなかった」と言って止まる。0（一致）と 1（乖離）と 2 を分けてある。

`isSafeRepoPath` はミラー領域の外にあるので比較しない。代わりに**同一の述語を両側へ
注入**する。そこの差分がミラーの乖離を隠したり、逆に無いものを作ったりしないためである
（`SYSTEM_ROOTS` は各 file 自身のものを読むので、この集合の乖離は捕まる）。

単体でも実行できる。

```bash
node tests/fixtures/cmate-issue-authoring/mirror-conformance.mjs
```

## file

| File | 役割 |
|---|---|
| `run_tests.sh` | suite 本体 |
| `cases/valid-full.json` | 依存・重複疑い・open question を含む適合計画 |
| `cases/valid-minimal.json` | 最小の適合計画（Issue 1 件） |
| `mutate.mjs` | JSON Pointer で 1 箇所だけ変異させる |
| `to-issue-json.mjs` | 計画 → cmate-orchestrate の `--issue-json` fixture |
| `assert-planner-clean.mjs` | execution plan に対する assertion |
| `mirror-conformance.mjs` | planner mirror の定数一致と挙動一致（単体実行可） |
