# Harness Pack 自動統合テストsuite

Harness Pack の3 Skill —
[`cmate-worktree-setup`](../../skills/cmate-worktree-setup/)・
[`cmate-orchestrate`](../../skills/cmate-orchestrate/)・
[`cmate-worktree-cleanup`](../../skills/cmate-worktree-cleanup/) —
を、**default CI で network・token・実model なしに**まとめて検証するための一式である。
fake な CommandMate/gh/git CLI、その場で作る一時 git repository/worktree、固定 clock を使い、
いつ実行しても同じ結果になる（Python 標準ライブラリのみ）。

```bash
python3 tests/harness_pack/run.py          # 全 phase を実行
python3 tests/harness_pack/run.py --keep   # 一時 workdir を残して調査する
```

## 境界（このsuiteが検証すること／しないこと）

このsuiteが検証するのは **package の正当性・artifact の再現性・3 Skill の振る舞い契約**である。
次は **意図的に再実装しない**。

- **CommandMate 本体の install-into-worktree E2E**（Catalog からの実 install / receipt 生成 /
  uninstall）。これは CommandMate 本体（`src/lib/skills`, #1242）の領域であり、この mirror repository には
  そのコードが存在しない。本suiteが検証するのは receipt が **照合する対象** —
  Catalog の checksum・manifest/file set・effective risk・compatibility — までの keyless な連鎖である。
- **実 Agent（Claude/Codex）による UAT**。実 install/discovery と 2 Issue/2 並列の実機確認は
  Harness Pack 実機UAT（#1458）が担う。本suiteの cross-skill lifecycle は、その実機実行の前提となる
  **契約**を fake CLI と実 git state に対して検証するものである。

setup と cleanup は runner を持たない prose 契約（SKILL.md ＋ schema）なので、本suiteは
`reference_setup.py` / `reference_cleanup.py` に **SKILL.md / proof-algorithm.md の手順を忠実に写した
git 駆動の reference driver** を置き、それを **実 git repository の敵対的な状態**に対して走らせて、
安全契約（暗黙上書き無し・zero-delete・guarded delete）が **実 git state として** 成り立つことを assert する。
orchestrate は runner を持つので、**実 runner**（`orchestrate.mjs` ほか）と既存の
[`run_tests.mjs`](../fixtures/cmate-orchestrate/run_tests.mjs)（36ケース）を **再利用**する（重複再実装しない）。

## phase 一覧

| phase | file | 何を確かめるか |
|---|---|---|
| 0. self-test | `phase_selftest.py` | suite自身の計器（schema validator・git guard・redaction scanner）が違反を実際に落とせること。何でも通す計器では緑が無意味になる |
| A. package/artifact | `phase_package.py` | 3 Skill が validate に合格し、2回独立ビルドが byte 一致（再現可能）で、Catalog に merge され、`verify_artifact.py` が Catalog→bytes→manifest→payload の連鎖を ACCEPT し、shipped payload に secret も絶対path も無いこと |
| B. cross-skill lifecycle | `phase_lifecycle.py` | 1つの実 git repository 上で setup→orchestrate(plan→dispatch/merge/uat)→cleanup を通し、ADR契約を実 git state に対して assert すること |
| C. profile matrix | `phase_profiles.py` | Node/CommandMate と Rust/CommandAgent で setup 検出・cleanup base 解決・orchestrate plan の値が **profile から解決**され hardcode でないこと |

## phase B が assert する ADR 契約

`setup → orchestrate → cleanup` を1つの流れとして、次を実 git state から確かめる。

- **setup**: 既存 branch/directory/worktree を1件も暗黙上書きしない。base を resolved SHA に確定して
  記録する。integration worktree を dirty にしない。partly-collision は success に丸めず partial にする。
- **orchestrate**: Wave barrier（前Wave完了＋verification pass まで次Wave dispatchしない）・bounded
  parallelism（max_parallel超過なし）・prompt検出時の human-required 停止（自動応答しない）・PR/merge の
  明示承認＋CI pass gate は、既存 `run_tests.mjs`（dispatch/merge/uat 27ケース＋plan 9ケース）を lifecycle の
  dispatch/merge/uat leg として走らせて担保する。plan は setup と同じ Issue 集合に対して生成し、
  handoff の整合を確かめる。
- **cleanup**: dirty / unmerged / unverifiable / detached を1件も削除しない（zero-delete）。削除は
  direct 祖先か、4条件完備の merged_equivalent（guarded ref delete）に限る。`--force` と `git branch -D` は
  guard により **構造的に不可能**で、かつ audit log に一切現れない。current/integration worktree は指定されても除外する。
- **横断**: どの文書にも secret/token/絶対path が残らない（redaction）。実行後に一時 residue を残さない。

## 失敗注入（sleep 非依存）

fake CLI と reference driver は、command exit / prompt event / verification report / branch drift /
collision / squash-merge を **状態として**注入する（実時間 sleep に依存しない）。

- dispatch/merge/uat の失敗注入（worker failure・verification failure・prompt・CI failure・merge conflict・
  UAT不合格→修正ループ・CommandMate unavailable・plan drift）は `run_tests.mjs` の scenario JSON が担う。
- lifecycle の cleanup では、dirty worktree・unmerged branch・squash-merge（merged_equivalent）・drift 再検査を
  実 git 操作で作り込む。

## 実機評価の記録

`run_tests.mjs` の 36ケースが緑であることと、本suiteの契約検証が緑であることは、
**実機 Agent 評価の代わりにはならない**。dispatch の実機確認（2 Issue/2 並列）、PR作成→CI→merge の実機確認、
UAT不合格→fix worktree→再検証→再merge の実機確認、実 install/discovery は #1458 の live 環境で別途行う。

| 日付 | 実施 | 内容 | 備考 |
|---|---|---|---|
| — | 未実施 | 実機 Agent UAT・実 install E2E | #1458 / #1242 |
