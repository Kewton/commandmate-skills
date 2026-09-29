# cmate-worker-development リリースノート（なぜ今の挙動なのか）

この file は「何が起きたか → だからこう変えた」の**経緯の記録**である。**契約の正本ではない**
—— 手順の正本は [SKILL.md](../SKILL.md) と `references/*-contract.md` であり、食い違ったら
そちらが正しい。

**この file は CommandMate#3012 の変更から始まる。** それ以前の経緯を遡って書き起こしてはいない。
それ以前は commit 履歴と ADR（`skills/cmate-orchestrate/references/adr-worker-development-skill.md`）を読むこと。

---

## 未リリース

### 委譲先の「未 install」を、確かめた結果として書かせる（CommandMate#3012）

**何が起きたか.** 利用側 Kewton/Musunest の PR 本文で、ワーカーが「`cmate-verify` は未 install の
ため契約のコマンドを直接実行した」「`cmate-repository-analysis` が worktree に無いので自力で調べた」
と繰り返し申告していた（#203・#222・#225・#238。それぞれ Issue #200・#210・#213・#233）。
Issue は「worktree の中で Skill が見えていない」ことを疑った。

**実測（2026-09-30、Command Code 1.66.0、`--no-auto-update`）.**

- `mktemp -d` 配下に git リポジトリを作り、`.agents/skills/` と `.claude/skills/` の両方へ
  `cmate-verify` と `cmate-repository-analysis` を複製して commit し、`git worktree add` した。
- worktree の root でも、その下位 directory でも、`cmd skills list -d` の `Project (2)` に
  両方が出た。**worktree であることは発見を妨げない。**
- worktree で `cmd -p "/cmate-verify" --output-format json --trust --skip-onboarding --max-turns 1`
  → NDJSON に `skill_loaded`（`name: cmate-verify`）が 1 件（exit 8 は `--max-turns 1` の打ち切り）。
- 陰性対照: `.agents/skills/cmate-verify` を退避して `.claude/skills` 側だけを残すと、
  `Project` から消え、`Skipped` にも出ない（黙って見えなくなる）。
- 陰性対照: `cmate-repository-analysis` の SKILL.md から frontmatter を外すと、
  `Skipped (1)` / `Missing fields (1)` / `name: Skill name is required` が出る。
- 1.66.0 の `skills list -d` は「Looking in:」行を出さない（Issue が引いた 1.49.0 の記述とは違う）。
  読んだ root の自己申告は無く、手がかりは `Project` / `Skipped` の節だけである。
- tool を使わせずに「runner はどこか」と訊くと、model は Skill を見つけたうえで
  `.agents/skills/cmate-verify/verify-run.sh`（`scripts/` 抜け）と答えた。

**利用側の実物（`gh api`、Musunest `main`）.** `.agents/skills/` と `.claude/skills/` に
`cmate-verify` 0.5.1（`scripts/verify-run.sh` は mode 100755）と `cmate-worker-development` は在る。
`cmate-repository-analysis` は**どちらの root にも無い**。そして同じ期間の #225 は
`verify-run.sh --cwd <worktree>` で `RESULT passed` / exit 0 を取っている。

**だから.** 置き場所は原因ではなかった。`cmate-verify` の「未 install」は**確かめずに書かれた誤り**、
`cmate-repository-analysis` の「未 install」は**事実**で、両者は同じ文面だった。
SKILL.md 第2節に「未 install と書く前に確かめる」を足し、確かめ方（worktree root からの
絶対 path・runner は `scripts/` の下・`cmd skills list -d` の `Project` / `Skipped` の読み方・
file が在れば Agent の一覧に出なくても path で使う）と、書き方（確かめた path と結果・Agent 側の
証跡・理由の名指し）を [delegate-discovery-contract.md](./delegate-discovery-contract.md) に置いた。
既定の手順は変えていない——委譲先が本当に無いときに停止せず劣化を明記して続行する挙動はそのままで、
変わったのは「無い」と言うための条件である。

Issue のコメント欄で方針が確定した（利用側も Musunest の worktree で `cmd skills list -d` を回し、
`cmate-verify` を含む 13 件が `Project` に出た——原因は model の推測）。それを受けて、判定を
**一文**（`<worktree>/.agents/skills/<id>/SKILL.md`、Claude なら `.claude/skills` 側も、の有無。
無ければ確かめた path を成果物に書く）で SKILL.md と正本の冒頭に置き、Claude・Codex のワーカーも
同じ判定になるよう Agent 別の表を足した。`cmd skills list -d` は Command Code 用の補助に下げた。
あわせて `cmate-verify` の SKILL.md の実行例が `.claude/skills/...` に固定されていたので、
`<skills-root>`（在る方の root）で書く形に直した（Command Code と Codex は `.claude/skills` を読まない）。
