# 運用（起動モード・定点・自動化）

## v1 は手動起動である

人間が起点になる。推奨する定点は 2 つ。

1. **リリース前** — その版で「何が通れば合格か」が実態と合っているかを見る
2. **週次** — 履歴が溜まった分だけ調整余地が出る

どちらも「読む」だけで終わってよい。**提案 0 件は正常な出力である。**

## 週次の実行例

```bash
cd <worktree>
node .claude/skills/cmate-verify-advisor/scripts/verify-advisor.mjs \
  --worktree-prefix "$(basename "$PWD")" \
  --days 30 --limit 200 \
  --dump .commandmate/advisor/snapshot-$(date +%F).json \
  | tee .commandmate/advisor/report-$(date +%F).txt
```

`--dump` した snapshot があれば、同じ解析を後から `--input` で完全に再現できる
（層 1 は決定的である）。レビューで「この数字はどこから来たのか」と聞かれたときに、
当時の履歴そのものを出せる。

## `--worktree-prefix` は実質必須である

`commandmate verify history` は**マシン全体**の run を返す。複数のリポジトリを同じ
マシンで扱っていると、別リポジトリの `lint` の実行時間が混ざる。層 1 は宣言済みの
ゲート id しか見ないので id が衝突しなければ実害は無いが、`lint` / `test` / `build` は
普通に衝突する。

```bash
# 混入していないかは observation で分かる
OBSERVATION multiple-worktrees samples come from 7 worktrees: ...
```

worktree 名がリポジトリ名で始まる運用（CommandMate の既定）なら、
`--worktree-prefix <repo-slug>-` で足りる。

## 自動化（運用の発展形）

スケジューラ本体はこの Skill の範囲外である。OS に委ねる。

### launchd（macOS）

`~/Library/LaunchAgents/com.example.verify-advisor.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.example.verify-advisor</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>cd /path/to/worktree &amp;&amp; node .claude/skills/cmate-verify-advisor/scripts/verify-advisor.mjs --worktree-prefix myrepo- &gt;&gt; /tmp/verify-advisor.log 2&gt;&amp;1</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>9</integer></dict>
  </dict>
</plist>
```

### cron

```cron
0 9 * * 1 cd /path/to/worktree && node .claude/skills/cmate-verify-advisor/scripts/verify-advisor.mjs --worktree-prefix myrepo- >> /tmp/verify-advisor.log 2>&1
```

### 自動化するときの注意

- **`--apply` を無人で回さないこと。** 強化方向しか書かれないとはいえ、timeout の短縮は
  「最も遅い実行環境で通るか」という、履歴に写っていない情報を要る判断である
- exit 3（履歴が取れない）を**成功として握り潰さないこと**。黙って劣化しないための
  終了コードが、cron のログの中で黙って消えては意味がない
- 提案 0 件で通知を出さない運用にすること。0 件は正常であり、毎週「何もありません」を
  読ませると本当に何かあった週に読まれなくなる

## この Skill が触るもの・触らないもの

| | |
|---|---|
| 読む | `commandmate verify history` / `verify show`（どちらも read-only）、`<cwd>/.commandmate/verify.yaml` |
| 書く | `--apply` のときだけ `--config` が指すファイル（**`--cwd` の内側に限る**）、`--dump` の出力先 |
| 実行しない | `commandmate verify <worktree>`（新しい run を作る）、対象リポジトリのゲートコマンド |
| 作らない | commit / PR / merge / push |
