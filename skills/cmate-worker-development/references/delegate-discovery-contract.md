# 委譲先の在否 — 「未 install」と書く前に確かめること

B 段（`cmate-repository-analysis`）と E 段（`cmate-verify`）の委譲先が**在るか無いか**を
どう確かめ、無いときに**どう書くか**の正本である。[SKILL.md](../SKILL.md) 第2節の要約と
食い違ったら、この文書を採る。ただし**実行契約と食い違ったら契約が勝つ**（不変条件 3）。

## なぜこの文書が在るか

「未 install のため委譲できなかった」は、**確かめた結果**でなければ証拠にならない。
確かめずに書いた「未 install」は、**本当に無い場合と見分けがつかない**——そして本当は在る場合、
使えたはずの検証を黙って捨てたことになる。

実測（CommandMate#3012、利用側 Kewton/Musunest、2026-09 の PR 本文）では、同じリポジトリの
同じ `main` から切った worktree で、`cmate-verify` を

- 「未 install」と書いて契約のコマンドを直接回した PR（#203・#238）と、
- `verify-run.sh --cwd <worktree>` で `RESULT passed` / exit 0 を取った PR（#225）

が並んでいた。`main` の `.agents/skills/cmate-verify/`（0.5.1、`scripts/verify-run.sh` は mode
100755）と `.claude/skills/cmate-verify/` はどちらも追跡されており、worktree にも複製される。
**install されていた。** 在ったものを「無い」と申告していたのである。

一方 `cmate-repository-analysis` は、同じ `main` の `.agents/skills/` にも `.claude/skills/` にも
**無い**。こちらの「未 install」は事実であり、直すのは利用側の install である。
**二つの申告は同じ文面だが、片方は事実で片方は誤りだった。** 読み手が区別できる形で書く、
というのがこの文書の要求である。

## 判定（一文）

**install 済みかは、`<worktree>/.agents/skills/<id>/SKILL.md`（Claude のワーカーなら
`<worktree>/.claude/skills/<id>/SKILL.md` も）が在るかで判定する。無いときは、確かめた path を
成果物（PR 本文・報告）に書く。**

`<worktree>` は `git rev-parse --show-toplevel` の出力である。この判定は Agent に依存しない——
Claude・Codex・Command Code のどのワーカーでも同じ file の有無を見る。Agent ごとに違うのは
「どの root を Skill として読むか」だけで、それは補助の確かめ（第3項）である。

| ワーカー | 判定に見る file | 補助 |
|---|---|---|
| Claude Code | `<worktree>/.claude/skills/<id>/SKILL.md` と `<worktree>/.agents/skills/<id>/SKILL.md` | slash palette |
| Codex CLI | `<worktree>/.agents/skills/<id>/SKILL.md` | —（model 呼び出しなしの一覧手段は無い） |
| Command Code | `<worktree>/.agents/skills/<id>/SKILL.md`（`.commandcode/skills/<id>/SKILL.md` も） | `cmd --no-auto-update skills list -d` |

**model の推測で判定しない。** Skill 一覧に見えた・見えなかった、runner の path はこうだろう、は
どちらも判定の根拠にならない（下記「なぜ」の実測で、誤った「未 install」はこの推測から出ていた）。

## 確かめ方

### 1. 根を決める

```bash
git rev-parse --show-toplevel
```

以下の path はすべて、この出力（worktree の root）からの**絶対 path**で扱う。
cwd が worktree の下位 directory でも、相対 path で探して「無い」と結論しない。

### 2. file の在否を見る（Agent に依存しない）

```bash
ls -l <root>/.agents/skills/<skill-id>/SKILL.md \
      <root>/.claude/skills/<skill-id>/SKILL.md \
      <root>/.commandcode/skills/<skill-id>/SKILL.md
```

CommandMate の installer は `.agents/skills/<id>/` と `.claude/skills/<id>/` の両方へ
byte-identical に置く。`.commandcode/skills/` は Command Code だけが読む追加の root である。
**どれか 1 つに SKILL.md が在れば、その委譲先は install されている**（Claude 以外のワーカーは
`.claude/skills` 側だけに在る場合を「Agent が読まない root にだけ在る」として扱う——第4項のとおり
path で使える）。

`cmate-verify` の runner は **`scripts/` の下**に在る。

```bash
<root>/.agents/skills/cmate-verify/scripts/verify-run.sh --cwd <root>
```

`<id>/verify-run.sh` ではない。実測（Command Code 1.66.0、tool を使わせずに訊いた）では、
model は Skill 一覧から `cmate-verify` を正しく見つけたうえで、runner の path を
`.agents/skills/cmate-verify/verify-run.sh`（`scripts/` 抜け）と**推測で答えた**。
推測した path が無いことは、委譲先が無いことの証明ではない。path は `ls` で確かめる。

### 3. Agent が読んでいるかを見る

file が在っても、Agent がその root を読まなければ Skill としては見えない。
この項は**補助**であり、判定は上の file の有無で済んでいる。root の対応は [Agent 対応表](https://github.com/Kewton/commandmate-skills/blob/main/docs/agent-support-matrix.md)
が正本であり、要点は次のとおりである。

| Agent | 読む project root | 確かめ方（model 呼び出しなし） |
|---|---|---|
| Claude Code | `.claude/skills` | slash palette に `/<skill-id>` が出るか |
| Codex CLI | `.agents/skills` | 手段なし（model の自己申告だけ）。file の有無で判定する |
| opencode / Antigravity | `.agents/skills`（opencode は `.claude/skills` も） | 対応表の各節 |
| Command Code | `.agents/skills`・`.commandcode/skills`（`$HOME` の同名 2 つも）。**`.claude/skills` は読まない** | `cmd --no-auto-update skills list -d` |

Command Code の `cmd skills list -d` は model を呼ばない（課金されない）。読むのは 2 か所である。

- **`Project (<n>)` の節**に `<skill-id>` が在るか。在れば発見されている。
- **`Skipped (<n>)` の節**。frontmatter の欠落などで読み飛ばされた Skill は、ここに
  名前と理由つきで出る（実測: `name` を欠く SKILL.md → `Missing fields (1)` /
  `name: Skill name is required`）。

**`.claude/skills` にだけ在る Skill は、`Project` にも `Skipped` にも出ない。**
Command Code はその root を読まないので、読み飛ばしたという記録も残らない。
「Skipped に無い」は「在る」の証明ではない。

起動まで確かめる必要があるときだけ、`cmd -p "/<skill-id>" --output-format json --trust
--skip-onboarding --max-turns 1 --no-auto-update` を 1 回回し、stdout の NDJSON に
`{"type":"event","event":{"type":"skill_loaded","name":"<skill-id>"}}` が出るかを見る
（model を呼ぶので課金される。`--max-turns 1` の打ち切りで exit 8 になるのは想定どおりで、
判別子は `skill_loaded` の有無である。転写 jsonl には出ない）。

### 4. Agent に見えなくても、file が在るなら使う

`cmate-verify` の runner は bash script であり、Skill として読み込まれていなくても
**path を指定して実行できる**。`cmate-repository-analysis` の手順も SKILL.md を path で読めば
辿れる。**file が在るのに Agent の一覧に出ないことは、「未 install」ではない。**
その場合は委譲を続行し、「Agent の Skill 一覧には出なかったが path で実行した」と書く。

## 書き方

委譲できなかったと書くときは、F 段の「読めなかったこと・委譲できなかったこと」
（[evidence-vocabulary.md](./evidence-vocabulary.md)）に、次の 3 つを**転記**する。

1. **確かめた path と結果** —— 第2項の `ls` の出力（無い root は「No such file」のまま）。
2. **Agent 側の証跡** —— Command Code なら `cmd --no-auto-update skills list -d` の
   `Project` と `Skipped` の節。他の Agent なら確かめられなかったことをそう書く。
3. **理由** —— 次のどれか 1 つを名指しする。

| 理由 | 何を見てそう言えるか | 直す側 |
|---|---|---|
| どの root にも無い | 第2項の `ls` がすべて No such file | 利用側。`commandmate skill install <id>` |
| Agent が読まない root にだけ在る | 例: `.claude/skills` にだけ在り、Command Code の `Project` に出ない | 利用側。`.agents/skills` にも置く（installer は既定で両方に置く） |
| Agent が読み飛ばした | `Skipped` の節に名前と理由が出る | package の frontmatter。理由の行をそのまま転記する |
| 在るが実行できなかった | runner を path で起動して exit 126 / 127 | 実行ビット・shebang。exit code と stderr を転記する |

**「未 install」とだけ書かない。** 上の 3 つが揃っていない申告は、確かめた結果か
確かめなかった結果かを読み手が区別できない。

## 参照

- [../SKILL.md](../SKILL.md) —— 第2節 委譲の規約
- [evidence-vocabulary.md](./evidence-vocabulary.md) —— F 段の節構成
- [release-notes.md](./release-notes.md) —— この文書ができた経緯と実測の記録
