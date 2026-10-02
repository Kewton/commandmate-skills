# runner — plan の形式と判定規則

`SKILL.md` の Step 4–7 を、command で検証できる受入条件について機械的に行う
`scripts/run-acceptance.mjs` の仕様である。Node 22 以上の標準ライブラリだけで動き、
実行 bit は無い。必ず `node` 経由で呼ぶ。

```
node skills/cmate-acceptance-test/scripts/run-acceptance.mjs \
  --plan <plan.json> --out <result_path> [--cwd <target worktree>]
```

- `--plan` — 下の §1 の JSON。
- `--out` — result document の出力先。cmate-orchestrate へ渡すなら
  `<acceptance-dir>/issue-<n>.json`（`SKILL.md` §1）。
- `--cwd` — command を実行する directory（既定は現在の directory）。
  `target` を plan で渡さなかった項目は、ここで `git rev-parse` / `git status` を読む。

exit code: `0` は result document を書いた（verdict に関係なく）、`2` は引数の誤りか
result document を書けなかった。summary は標準出力に出る。

## 1. plan

```json
{
  "issue_ref": "#60",
  "issue_title": "任意",
  "target": { "repository": "owner/repo", "branch": "任意", "commit": "任意", "dirty": false },
  "environment": { "agent": "claude", "agent_version": null, "invocation": "interactive" },
  "criteria": [
    { "text": "npm test が通る", "command": "npm test", "kind": "test" },
    { "text": "lint が通る", "command": "npm run lint", "timeout_sec": 300 },
    { "text": "e2e が安定して通る", "command": "npm run e2e", "attempts": 2,
      "next_action": { "action": "flaky の原因を調べる", "owner": "開発リーダー" } },
    { "text": "DB migration が戻せる", "command": "npm run migrate:roundtrip",
      "risk_tier": "confirm_required",
      "confirmation": { "granted": true, "cleanup_plan": "作るもの / 戻し方 / 戻せないもの / 失敗時に残るもの" } },
    { "text": "画面の表示が崩れない",
      "next_action": { "action": "画面を目視確認する", "owner": "user" } }
  ]
}
```

| field | 内容 |
|---|---|
| `criteria[].id` | 任意。省略すると `AC-01` から並び順に振る |
| `criteria[].command` | 実行する command（`/bin/sh -c`）。無ければ実行しない（§2） |
| `criteria[].kind` | `test` なら check の kind を `test` にする。既定 `command` |
| `criteria[].attempts` | 1–5。2 以上で exit code が揃わなければ `flaky` |
| `criteria[].timeout_sec` | 既定 600。超えたら強制終了し `exit_code: null` |
| `criteria[].risk_tier` | `safe`（既定）/ `confirm_required` / `blocked` |
| `criteria[].confirmation` | `confirm_required` のとき必須。`granted` は利用者の応答そのまま |
| `criteria[].next_action` | 未確定になったときの次 action と担当。runner は担当を推測しない |
| `criteria[].notes` | 分類の根拠など。`notes` に追記される |
| `environment.invocation` | `interactive` 以外は `non_interactive` として扱う |

`issue_ref` が無い・受入条件が 0 件・plan を読めない・`--cwd` が無いときは、
`status: failure` / `verdict: no_go` の document を書く（`SKILL.md` §5）。
`issue_ref` が無ければ `target.issue_ref` は `unspecified` である。

## 2. outcome の決め方

**合否は exit code で判定する。件数は参考。**

| 状況 | outcome |
|---|---|
| exit code 0 | `pass` |
| exit code が 0 以外 | `fail` |
| 複数回の試行で exit code が揃わない | `flaky`（全試行を `attempts` に残す） |
| timeout・signal で終了し exit code が無い | `not_run`（`exit_code: null`。0 と書かない） |
| shell を起動できなかった | `blocked` |
| `command` が無い | `manual_pending`（check は `executed: false`） |
| `risk_tier: blocked` | `blocked`（実行しない） |
| `confirm_required` で非対話、または `granted` が `true` でない | `not_run`（実行しない） |

テスト件数は、`node --test` の spec reporter（`ℹ tests N` / `ℹ pass N` / `ℹ fail N`）と
TAP（`# tests N` / `# pass N` / `# fail N`）の両方から、読めれば evidence の `summary` に
「件数 (参考, spec|tap)」として書く。読めなくても何も変わらない。件数が fail を示すのに
exit 0 だった場合も `pass` で、食い違いを `notes` に書く。

`status` と `verdict` は [`verdict-rubric.md`](./verdict-rubric.md) §2 / §3 の決定表を
上から順にそのまま当てる。runner は独自の規則を持たない。

## 3. evidence と redaction

- 1 条件につき `type: command` の evidence を 1 件書く（`EV-NN`、条件と同じ番号）。
  `exit_code` は最後の試行の実測値、`duration_ms` は全試行の合計。
- `output_excerpt` は stdout と stderr を混ぜた出力の**末尾** 3000 文字。
  切ったときは `truncated: true`。全文は保存しない（`path: null`）。
- 保存前に [`evidence.md`](./evidence.md) §3 の伏字処理を行う: token / API key の形、
  `*_TOKEN=` などの代入値、`--cwd` の絶対 path（`.` に置換）、home directory。
  伏せた entry は `redacted: true`。
- この伏字処理は既知の形だけを対象にする。command が secret を出力しうるなら、
  plan に入れる前に出力しない形へ変える。

## 4. runner がしないこと

- 受入条件の抽出、分類、test plan の提示、利用者への確認（Step 1–3）。plan はそれを
  終えた結果として渡す。
- `manual_observation` の evidence を作ること。手動確認は人が行い、記録する。
- 失敗の原因が環境か実装かの判断。0 以外の exit code は `fail` と記録するので、
  環境要因と分かったものは理由を添えて `blocked` に直してよい
  （直したら `status` / `verdict` も決定表で導き直す）が、`pass` にはしない。
