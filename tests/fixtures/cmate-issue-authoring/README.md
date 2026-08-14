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

### 4. 受入ゲート記法の生産側が正本と一致していること（Issue #124）

`acceptance-gates` ブロックには実装が 3 つある。planner がブロックを読み、dispatch が
`require:` の id を `.commandmate/verify.yaml` に突き合わせ、**この package が両方を書く側**
である。生産側は後から入ったので、放っておけば必ず乖離する。

`acceptance-gates-conformance.mjs` が 4 層で固定する。

1. **定数が byte 一致**（`ACCEPTANCE_GATES_*` / `ACCEPTANCE_GATE_ID_RE` /
   `VERIFY_CONFIG_RELATIVE` / `CONTRACT_BUILT_IN_GATE_IDS`）。名前が違う対
   （dispatch の `GATE_ID_RE` ↔ mirror の `ACCEPTANCE_GATE_ID_RE`）も突き合わせる。
2. **関数本体が byte 一致**。comment 行を落とし、file 冒頭に列挙した rename
   （`planner` prefix、`checkoutGateIds` ↔ `readWorktreeGateIds` 等）だけを正規化して比較する。
   rename は対ごとにスコープしてある — ブロック側に dispatch の rename を当てると、
   本物の乖離を書き換えで隠してしまうため。
3. **corpus で挙動が一致**。正常系と、拒否されるべき 19 形（`gates:` / tab / 3 スペース /
   行末コメント / 未知 version / 2 個 / 33 件 …）を、**返る code まで**突き合わせる。
   `acceptance_gate_block_invalid`（直せ）と `acceptance_gate_block_unsupported`
   （この release では走らない）は著者の行き先が違うので、同じ「拒否」に丸めない。
4. **出す形が正本の例と byte 一致**。正本 `acceptance-gates-notation.md` の例をその id から
   renderer で描き直して byte 比較し、生産側 2 package が同梱するブロックも同じ形であること・
   `gates:` を含まないことを確かめる。各 package に例が 1 つも無ければ **fail** である
   （比較対象が消えたことを「一致」と読ませない）。

suite 側では、これに加えて次を測っている。

- `cases/valid-acceptance-gates.json` — 実在するゲートを `require:` した計画が通ること。
  本文のブロックは **renderer の出力そのもの**であることを機械で確認している。
- `cases/valid-unmeasurable.json` — 測れない受入条件をブロックにしない計画が通ること。
- `--checkout` **無し**で同じ計画を検証すると `acceptance_gates_verify_yaml_read` で落ちること
  （「見ていない」を「見て問題なかった」に化けさせない）。`verify.yaml` が無い checkout を
  渡したときは **exit 2**（＝計画が悪いのではなく検証できていない）。
- renderer が、checkout に無い id・不正な id・重複・`--checkout` 無しを **exit 2 で拒む**こと。
- ブロックだけを受入条件の見出しの下に置いた本文が `planner_ready` で落ちること。
  planner はブロックを剥がしてから散文を読むので、剥がし忘れた mirror はここで赤くなる。
- `assert-planner-gates.mjs` が、**実物の planner** に食わせた結果の `acceptance_gates` を
  本文のブロックと突き合わせる（id も順序も）。期待値は第 3 の素朴な reader が本文から
  取り出す — 実装に自分を確認させても証拠にならないため。

### 5. planner mirror が乖離していないこと

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

### 6. 未決の問い記法の生産側が正本と一致していること（Issue #198）

` ```open-questions ` 記法（[#178](https://github.com/Kewton/commandmate-skills/issues/178)）は
**読む側から先に**入った。planner は 0.28.0 からブロックを読むが、書く側が無かった。
書く側は `cmate-issue-refinement` で、そこは `scripts/` を持たない指示駆動の package である
——つまり突き合わせる関数本体が無い。

したがって `open-questions-conformance.mjs` は、生成規則
（`skills/cmate-issue-refinement/references/open-questions.md`）を `render()` と `blocking()`
として**この file に 1 つだけ**転写し、その出力を**実物の planner** に食わせる。
散文の写しを 2 つ置いて見比べるのではなく、片方を実行して読ませるのがこの file の形である。

固定しているもの。

1. **生産側の散文が、消費側の code の値を書いている**こと（上限 `32` と info string
   `open-questions` が literal として在ること、正本の file 名を名指していること）。
   二重に書くしかない 1 個の数値が腐らないようにする層である。
2. **package が同梱するブロックが、そのまま planner に読める**こと、かつ
   **自分の questions から描き直した形と byte 一致**すること。例が 1 つも無ければ **fail**。
3. **corpus が実 parser を往復する**こと（1 件・上限ちょうど 32 件・文中の `#`・backtick・
   CJK・先頭のハイフン）。読み返した list が順序ごと一致する。
4. **規則が挙げる制約が実際に効いている**こと。規則が「出すな」と言う形
   （0 件・空文字・完全一致の重複・改行を含む問い・33 件・YAML 予約文字始まり）を実 parser に
   食わせ、**`open_question_block_invalid` で拒否されること**まで確認する。
   一度も止めたことのない制約は制約ではない。
5. **ブロックが `open_questions[]` の射影である**こと（`blocks_required_section` だけが
   決める・配列順のまま）、および result schema の `open_questions_block` pattern が
   規則の出力を受け取り、人が手で直さないと貼れない形を拒むこと。
6. **実物の planner binary で end-to-end**。ブロックを載せた本文は 1 件につき 1 件の
   blocking question を逐語・順序どおりに返し、**ブロックだけ消した双子の本文**は 1 件も返さない。
   緑だけの fixture は証拠にしない（正本 第6節と同じ二点測定）。

`cmate-issue-authoring` 側のミラーは本 Issue の範囲外であり、入ったらこの file に
2 つ目の生産側が増える。

どの conformance テストも単体で実行できる。

```bash
node tests/fixtures/cmate-issue-authoring/mirror-conformance.mjs
node tests/fixtures/cmate-issue-authoring/acceptance-gates-conformance.mjs
node tests/fixtures/cmate-issue-authoring/open-questions-conformance.mjs
```

## file

| File | 役割 |
|---|---|
| `run_tests.sh` | suite 本体 |
| `cases/valid-full.json` | 依存・重複疑い・open question を含む適合計画 |
| `cases/valid-minimal.json` | 最小の適合計画（Issue 1 件） |
| `cases/valid-acceptance-gates.json` | 実在するゲートを `require:` した適合計画 |
| `cases/valid-unmeasurable.json` | 測れない受入条件をブロックにしなかった適合計画 |
| `mutate.mjs` | JSON Pointer で 1 箇所だけ変異させる |
| `to-issue-json.mjs` | 計画 → cmate-orchestrate の `--issue-json` fixture |
| `assert-planner-clean.mjs` | execution plan に対する assertion |
| `assert-planner-gates.mjs` | 本文のブロックと planner が読んだ `acceptance_gates` の突き合わせ |
| `mirror-conformance.mjs` | planner mirror の定数一致と挙動一致（単体実行可） |
| `acceptance-gates-conformance.mjs` | 受入ゲート記法の一致（定数・関数本体・corpus・正本の例。単体実行可） |
| `open-questions-conformance.mjs` | 未決の問い記法の生産側一致（生成規則の転写・corpus・拒否形・実 planner での end-to-end。単体実行可） |
