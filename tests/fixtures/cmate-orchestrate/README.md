# cmate-orchestrate の評価

`skills/cmate-orchestrate/` の計画コア（dry-run runner）を、決定的な fixture に対して
検証するための一式である。GitHub には一切触れない。

```
cases/<case-id>/issues.json     planner に渡す Issue fixture（オフライン）
cases/<case-id>/case.json       引数と、機械で判定できる期待値
cases/<case-id>/expected-plan.json  （任意）golden な plan。byte 一致で照合
dispatch-cases/<id>/case.json   plan 生成引数・scenario・dispatch 期待値。`plan_patch` は
                                生成された plan を dispatch に渡す前に書き換える（merge-case と
                                同じ理由。`dispatch_defaults` の case は #180 当時は planner が本 field を
                                拒否していたのでこの経路しか無かったが、#196 の着地後は
                                **dispatch が「自分が作っていない plan」も受けること**を測るための選択である。
                                planner 側の echo は plan case 66/67 と `d93` が本物の profile で測る）
dispatch-cases/<id>/scenario.json  fake CLI に注入する worker/verify/drift の挙動
dispatch-cases/<id>/contracts/  （契約 case のみ）生成された実行契約の golden。byte 一致で照合
dispatch-cases/issues-multifile.json  複数 file を保有する Issue fixture（契約決定性の case 用）
dispatch-cases/issues-negative-constraints.json  否定的制約（禁止の表・非対象節）を持つ Issue
                                fixture（#176 の転記 case 用）
dispatch-cases/issues-acceptance-gates*.json  受入ゲート case の Issue fixture（ブロック有り / 無し / 未知 id）
dispatch-cases/issues-open-questions-block.json  著者が宣言した未決の問いを持つ Issue fixture（#178 の case 用）
dispatch-cases/issues-max-turns-evidence.json  `--max-turns` 到達（exit 21）の分類 case 用 Issue fixture（#220）。
                                独立6件で、case ごとに1件だけを dispatch する
dispatch-cases/issues-dag-*.json  スケジューリングの case 用 Issue fixture（#183）。`-chain` は
                                「3件独立 + 1件だけが片方に依存」（wave では最遅 worker を全員が待つ形）、
                                `-failure` は「独立2系列がそれぞれ1件を従える」（上流失敗の伝播を
                                下流だけに閉じ込められるかを見る形）、`-parallel` は依存ゼロ3件
dispatch-cases/<id>/expected-dispatch-report.json  （任意）golden な dispatch report。`out_dir` だけ
                                `<out>` に置換して byte 一致で照合（#183 の非回帰 case。merge-case の
                                `expected-merge-report.json` と同じ規約）
resume-cases/<id>/case.json     複数 attempt を1つの run directory に append する case。
                                `--resume`（再 dispatch）と `--reverify`（送らずに再裁定）の両方が
                                ここに入る: attempt の配置規約・append-only 不変条件・台帳・
                                整合性ガードが同じものだからである
resume-cases/<id>/attempt-N.json  attempt ごとに fake CLI へ注入する世界
merge-cases/<id>/case.json      plan/dispatch 生成・merge scenario・merge 期待値（scenario は inline）
merge-cases/<id>/expected-merge-report.json  （任意）golden な merge report。`out_dir` だけ
                                `<out>` に置換して byte 一致で照合（#175 の非回帰 case）
uat-cases/<id>/case.json        plan/dispatch 生成・uat scenario・UAT/修正ループ 期待値（scenario は inline）
status-cases/<id>/case.json     status view の期待値（phase 状態・Issue ごとの値・次アクション）
status-cases/<id>/run/          checked-in の run directory。実 runner の出力をそのまま置いた status の入力
profile-init-cases/<id>/repo/   profile-init に読ませる小さな fixture リポジトリ
profile-init-cases/<id>/case.json           provenance source・todo/warning code の期待値
profile-init-cases/<id>/expected-profile.json  golden な draft profile。byte 一致で照合
inspect-cases/<id>/repo/        inspect.mjs --check-references に突き合わせさせる小さな fixture リポジトリ
inspect-cases/<id>/issues.json  点検対象の Issue fixture（planner に渡すものと同形）
inspect-cases/<id>/case.json    warning code 列・references[]/line_claims[] の期待値・
                                ambiguous/dropped の期待値。`found_at` と `measured` は
                                **harness が repo/ の bytes から独立に計算して**照合するので、
                                case が「runner 自身と一致しているだけ」で緑になることはない
inspect-cases/gate-fake.mjs     `--evaluate-gates` の case で gate の代わりに走る fake。呼び出しを
                                $CMATE_GATE_FAKE_LOG（**checkout の外**）に記録し、spec で
                                pass / fail / flip（1回目だけ緑）/ codes / hang を出し分ける
fake-cli.mjs                    commandmate/git/gh を模した stub（failure injection）。`workers.<n>.capture_extra`
                                は `capture --json` の payload に混ぜる field（`realtimeSnippet` /
                                `lineCount` / `structuredEvents` / `cliToolId` / `upstreamFault`。#220）。
                                最後に spread するので `cliToolId: null` のような**欠落**も書ける。
                                hook の timestamp は run 中に決まるので、`"@now"` / `"@long-ago"` の
                                2 token が capture 時に解決される（最後の send の前後を書き分けるため）
profiles/                       独自 profile の例（unverified）
run_tests.mjs                   fixture test harness（Node stdlib のみ）
rubric.md                       人が見る採点基準
```

`catalog/` にも release `scripts/` にも触れない。ここにある `.mjs` は
release pipeline の一部ではなく、この Skill の評価専用である。

## 実行

```bash
node tests/fixtures/cmate-orchestrate/run_tests.mjs
```

依存が無く、いつ実行しても同じ結果になる。harness は各 case について次を確かめる。

- exit code と `status` が期待どおりであること
- result envelope が `orchestrate-result.v1.json` に適合すること
- 成功時、plan が `execution-plan.v2.json` に適合すること
- Wave・merge 順・依存 kind・classification・risk が期待どおりであること
- どの Wave も `max_parallel` を超えず、file 重複 pair を含まないこと
- **同じ入力から同じ plan が出ること**（2回実行して byte 一致）
- golden がある case では、plan が checked-in の期待値と byte 一致すること
- `warning_codes` を宣言した case では、warnings の code 列がその集合と完全一致すること
  （`plan.warnings` と `result.warnings` が同じ `(code, detail)` 列であることも確認する。
  `severity` は plan にだけ載るので byte 一致ではなく対で比べ、**envelope が `severity` を
  1件も運ばないこと**を別途固定する。#199）
- `warning_severities` を宣言した case では、`plan.warnings[].severity` が位置対応で一致すること
  （`null` は field 不在＝fail-closed の `blocking` 既定。#199）
- **全 case について**、`severity` は `notice` か不在のどちらかであること（planner は `blocking` を
  綴らない＝notice を持たない plan は #199 以前と byte 一致する）と、`status` が `partial` で
  あることと blocking な warning が在ることが一致すること。notice 集合は #210 の棚卸しで
  `harness_path_in_scope` / `profile_repository_override` の2件になったので、この不変条件は
  「1件だけ」を仮定していない —— **notice 側が広がったら、blocking を期待している case が赤くなる**
- `questions_count` / `questions_include` を宣言した case では、`issues[].questions` の**件数**と
  **含む文字列**が期待どおりであること。dispatch が読むのは `warnings` ではなくこの field であり、
  推論由来の question（`acceptance_requires_tests_but_scope_has_none`, #145）は判定の元になった
  受入条件を**原文で**載せるので、件数と原文の両方を固定する

case.json に `cwd` があると、harness は使い捨ての working directory を作ってそこで planner を
起動する（`{"git": true, "origin": "<url>"}` なら `git init` + `remote add origin`、
`{"git": false}` なら git リポジトリでない素の directory）。既定 profile は cwd の `origin` を
照合するため、cwd は plan の入力の一部である（Issue #36）。決定性の 2 回目も同じ cwd で回す。
`cwd` を持たない case は harness 自身の directory で動き、profile を明示するので照合に入らない。

harness 自身の健全性も見る（`validator self-test`）: 壊れた plan を schema validator が
実際に落とせることを確認する。何でも通す validator は何も検証していないのと同じである。

## case 一覧

| case | 何を見るための case か |
|---|---|
| `01-independent` | 依存も conflict も無い3件が1 Wave に収まるか |
| `02-explicit-dependency` | 本文の `Depends on #N` を explicit 依存として2 Wave に割るか（golden 照合つき） |
| `03-inferred-dependency` | contract 生産者と消費者が **語彙しか共有していない**とき、edge にせず question にするか（#182。file を共有する側は `55-…`） |
| `04-file-conflict` | 同一 file を触る2件を、依存が無くても同一 Wave に置かないか |
| `05-cycle` | 相互依存を cycle として拒否するか |
| `06-override-incomplete` | 集合外を指す override を不完全として拒否するか |
| `07-unverified-profile` | unverified profile を確認なしで拒否するか |
| `08-unverified-allowed` | `--allow-unverified` で plan を出し、risk を high にするか |
| `09-no-infer` | `--no-infer` で推論依存を抑止できるか |
| `10-default-profile-repo-mismatch` | 既定 profile が cwd の origin と食い違うとき warning + `partial` にするか（#36） |
| `11-default-profile-repo-match` | origin が一致するとき従来どおり warning 無しの success か（#36） |
| `12-default-profile-cwd-not-git` | cwd が git リポジトリでないとき照合をスキップして success のままか（#36） |
| `13-repo-override-unverified` | `--repo` が `verified` を降格させ、確認なしでは拒否するか（#36） |
| `14-repo-override-allow-unverified` | `--allow-unverified` 時に降格が plan（verified/risk/warning）に見えるか（#36）。その warning が `severity: notice` で `status` を落とさないか（#210。**2つの明示 flag が揃わないと出ない code** ＝ operator が既に決めて command line に記録した事実の報告） |
| `83-repo-override-with-blocking` | 同じ notice と blocking な warning が同居したとき、`status` が blocking 側で決まるか（#210。notice が**先頭**に立つ並びで固定してある。case 72 の profile 版） |
| `28-acceptance-gates-block` | ```acceptance-gates ブロックが `acceptance_gates` に載るか。ブロック有無の**双子 Issue**で `test_expectations` が byte 一致するか（#114 Phase 0-3: strip しないと本ブロックの終了 fence が後続 ```bash の開始として拾われ、3件が1件に落ちる） |
| `29-acceptance-gates-invalid` | 2個・未知 version・不正 id・空ブロックを `acceptance_gate_block_invalid` として open question にし、**「ブロックが無かった」に丸めない**か |
| `30-acceptance-gates-defined` | `gates:`（新規コマンドゲート）を読み、`{id, command, timeoutSec}` を著者の順のまま `acceptance_gates.gates` に載せるか。`timeoutSec` を書かなかった entry では**キーごと落ちる**（上流の既定に任せ、runner が決めた数を混ぜない）。`require:` と併記でき、warning は 1 件も出ない |
| `84-acceptance-gate-definition-invalid` | `gates:` の定義が上流の契約パーサに拒否される 6 通り（予約 id・Issue 番号スコープ違反・command 無し・上限超過・require との重複・timeout 範囲外）を、**planner が**`acceptance_gate_block_invalid` で止めるか。上限超過は 32 件に**切らずに**件数を名乗る |
| `85-acceptance-gate-definition-mutex-retry` | **記法が CommandMate #1771 / #1772 の 3 field を運ぶ（[#223](https://github.com/Kewton/commandmate-skills/issues/223) / [#224](https://github.com/Kewton/commandmate-skills/issues/224)）。** 上流は verify.yaml の `gates[]` と契約の `verify.gateDefinitions` を**同じ validator** で検査するので、受理集合はここでも同一でなければならない —— planner が拒む block は著者が書けない受入条件であり、planner が通して `send --contract` が拒む block は「走らなかった worker についての exit 2」である。転記は写しのまま: 著者順・`flakyIsPass: false`（既定の明示は合法）・宣言しなかった entry の `timeoutSec` は**不在** |
| `86-acceptance-gate-definition-range` | **同じ 3 field の値域側（fail-closed）。** `retryOnFail: 2`（上限そのものが機能の中身）・retry を伴わない `flakyIsPass: true`（決して発火しない宣言）・path segment として安全でない `mutex` を planner が止める。4 件目は**対照**で、同じ組み合わせを**逆順に書いた** block —— YAML の mapping に順序は無いので、順序を理由に拒めば上流が受理する block を拒むことになる（この規則は entry を読み終えてから検査する） |
| `87-scope-pattern-declared` | **著者が宣言した glob / ディレクトリが `suspected_files` に入るか（[#219](https://github.com/Kewton/commandmate-skills/issues/219)）。** `## 対象ファイル` に素書きの `data/geo/landmarks/*.json`・backtick の `data/geo/**/*.json`・末尾スラッシュの `data/geo/stations/` の3通りを並べる。0.31.0 では素書きの2つは**警告も出さずに落ちて**おり、backtick のものだけが `CANDIDATE_BACKTICK` の `[^`\s]+` を偶然通っていた。`scope_pattern_declared`（notice）が pattern を**列挙**し、`status` は success のままであること |
| `88-scope-pattern-outside-deliverable` | **その逆側: 成果物見出しの外の glob は scope に入らない。** 根拠節の pattern は落とされ、落としたことが `scope_pattern_dropped`（notice）に出る。**`unrecognized_file_extension` には落ちない**（`.json` は既知拡張子であり、綴りを直せと言うのは誤診である）。同じ本文の `src/regen.ts` は従来どおり抽出されるので、これは「抽出が止まった」ではなく「pattern だけが宣言を要求する」ことの case である |
| `89-scope-pattern-over-broad` | **repository 全体を意味する pattern を拒むか。** 単独 `**` は `contract_scope_dropped` の理由 `over_broad` として契約から落ち、`src/lint.ts` は残る（＝「scope が空」とは別の欠陥として読める）。狭めるのではなく落とす —— `**` の意図を推測すれば ADR 不変条件1が禁じる導出になる |
| `90-scope-pattern-file-conflict` | **case 04 の glob 版。** `data/geo/**` と `data/geo/landmarks/13101.json` が同一 Wave に入らないか。0.31.0 の `sharedFiles` は完全一致集合の交差だったので、この2件は同じ wave に並び**同じ file を2人の worker が書いた**。`classification` が両方 `conflicting` になることまで固定する（wave 分割だけでは依存 edge による分割と区別できない） |
| `54-lexical-edge-not-serialized` | 相互参照ゼロの3 Issue（実測 #104/#105/#106 の形）が、語彙一致だけで3 wave に直列化されず、1 wave のまま question になるか（#182） |
| `55-inferred-edge-file-conflict` | 逆向き: 同じ file を書く生産者/消費者は inferred edge のまま残り、`basis: file_conflict` と共有 file を名乗るか（#182） |
| `56-context-heading-issue-number` | `## 根拠` 配下で**否定するために**書いた `depends on #N` が phantom 依存にならず、かつ CONTEXT の外に書いた依存は残るか（#182） |
| `57-shadowed-path-is-a-question` | 宣言した短い path が、説明文の長い path に shadow されて scope から落ちないか（両方 scope に入り question になるか。#182） |
| `58-shadowed-path-cited-as-context` | 逆向き: 長い方を `## 根拠` で引用しただけなら**訊かない**か（著者が既に区別を書いている。かつ、旧規則ではこの形が scope 空になっていた。#182） |
| `59-open-questions-declared` | 著者が ```open-questions ブロックで宣言した未決の問いが、1件につき1件の blocking question になるか。**ブロックを消した双子の Issue** と `test_expectations` / `suspected_files` / `scope_defaults` が byte 一致するか（#178。strip しないと終了 fence が後続 ```bash の開始として拾われ 3件が1件に落ち、問いの中に書いた path が scope に入る） |
| `60-open-questions-block-invalid` | 2個・未知 version・未知 key・空ブロックを `open_question_block_invalid` として open question にし、**「ブロックが無かった」に丸めない**か（#178。acceptance-gates 記法 第7節をそのまま適用） |
| `61-open-questions-heading-not-read` | 見出し（未決 / undecided / open questions）**だけ**の本文では question が1件も立たないか。golden は**この機能の実装前の runner が生成した**もので、ブロックの無い本文の plan が byte 単位で従来どおりであることの測定である（#178） |
| `62-scope-companions-literal-required` | profile の `scope_companions.require` が宣言した**リテラル path**（どのソース名とも対応しない集約テスト）が、`when` 一致時に `scope_defaults` へ入るか。2つの宣言が一致しても**1件しか出ない**か。`derive` の placeholder 形式と**併存**するか（#181） |
| `63-scope-companions-literal-not-matched` | 逆向き: 同じ profile で、どの `when` にも一致しない Issue には literal が出ないか。literal も**宣言に gate されている**ことの測定（#181） |
| `64-scope-companions-reject-literal-escape` | literal は宣言済み path から作られないので、`isSafeRepoPath` を通していなければ profile 経由の path traversal になる。`users/…`（`..` でも絶対 path でもなく、**この述語だけが落とせる**形）が load 時に拒否されるか（#181） |
| `65-scope-companions-reject-literal-harness` | #177 の既定除外（`.claude/skills/` 等）を profile が literal で開け直せないか。**静かな2つ目の扉**を作らないことの測定（#181） |
| `66-dispatch-defaults-declared` | `dispatch_defaults` を宣言した profile が**plan 段階を通り**、宣言が `plan.profile` に echo されるか（#196）。profile は4 key を契約と違う順で書いており、plan は**契約の順**で載せる —— profile は丸ごと run_id の hash に入るので、組み直さないと key の並べ替えで id が割れる。golden は 45 と `run_id` / `profile.id` / この field 以外**完全に同一**である |
| `67-dispatch-defaults-with-companions` | **任意 field の echo 順の固定**（#196）。`scope_companions` → `dispatch_defaults` の順で、#195 の `integration_baseline` はさらに後ろに付く（3つ揃った形は 74）。順序が plan のバイト列を決めるので、間に差し込む実装は内容の変わっていない plan の golden を壊す。`profile_keys` が順序付きの field 一覧をそのまま述べる |
| `68-dispatch-defaults-reject-unknown-key` | 未知 key（`schedule` —— #180 が意図的に**外した**もの）を読み飛ばさず拒否するか。新しい runner 向けの profile が古い runner で半分だけ効く状態を作らない（第10.2節） |
| `69-dispatch-defaults-reject-type` | boolean key に文字列 `"true"` を書いた profile を拒否するか。`Boolean("false")` は true なので、強制変換する loader は **off と書いた profile を on と読む** |
| `70-dispatch-defaults-reject-non-positive` | `wait_timeout: 0` を拒否するか。0 は人には「無制限」に読め、`commandmate wait` には「即 timeout」を意味する |
| `71-dispatch-defaults-reject-not-object` | field 自体が object でない（`[{…}]`）ものを拒否するか。`typeof [] === 'object'` を素通しすると、誰も書いていない key `"0"` を名指す refusal になる |
| `73-integration-baseline-declared` | `integration_baseline` を宣言した profile が**plan 段階を通り**、宣言が `plan.profile` に echo されるか（#195）。merge は profile を開かず `plan.profile.integration_baseline` を読むので、**この echo が経路そのもの**である。golden は 45 と `run_id` / `profile.id` / この field 以外**完全に同一**（planner は本 field を使わない） |
| `74-integration-baseline-echo-order` | **任意 field 3つが揃ったときの echo 順の固定**（#195 × #196）。profile は契約と**逆順**で書き、plan は `scope_companions` → `dispatch_defaults` → `integration_baseline` で載せる。新しい任意 field を末尾でなく途中に足す実装は、内容の変わっていない plan の golden を壊す |
| `75-integration-baseline-declared-empty` | **宣言された `[]` が `[]` のまま plan に載るか**（#195 の固定事項2）。merge の解決は key の**存在**で分岐するので、空宣言を落とす loader は「統合検証は無い」を「未宣言」と同じにしてしまい、merge から見て**区別が付かなくなる**（merge 側の測定は `m30`） |
| `76-integration-baseline-reject-not-array` | 配列でない（素の文字列）宣言を拒否するか。1要素の配列に丸める実装は `"npm run lint && npm test"` を whitespace 分割で1 command として回す（runner は shell を経由しない）ので、**違う argv を測って緑にする** |
| `77-integration-baseline-reject-item-type` | 要素が文字列でない（入れ子配列）宣言を、要素単位でなく**丸ごと**拒否するか。`String(["bin/verify-all"])` は文字列として通ってしまうので、強制変換する loader は2要素になった瞬間に comma 連結の command を黙って作る。**検証集合の1本だけが走らない**のは本 Issue が消しに来た緑の形である |
| `78-issue-fixture-reject-non-object` | object でない `--issue-json` 要素を捨てず、fixture ごと拒否するか（#208）。要求した番号は在って読めるのに止まるのが要点 —— 読める分だけで組んだ plan は「測っていない Issue を測ったことにした plan」である。5件とも #208 以前の runner では **exit 0 で plan が出ていた** |
| `79-issue-fixture-reject-fractional-number` | `"12.9"` が 12 として読まれないか。`parseInt` は数ではなく数の前置部分を読むので、この fixture を `--issues 12` で回すと plan が出ていた。**書き間違いが落ちるのではなく別の Issue が計画される**のがこの経路の害である |
| `80-issue-fixture-reject-duplicate-number` | 同じ `number` の重複を後勝ちにせず拒否するか。2要素は別の対象ファイル・別の受入条件を書いており、どちらを意図したかは planner に決められない。message が衝突した2要素の index を両方名指しすることも固定する |
| `81-issue-fixture-reject-number-prefix` | `"482abc"` が 482 として読まれないか（79 と対の誤読形）。整数として読めるのは整数そのものと整数だけからなる文字列に限る |
| `82-issue-fixture-reject-number-absent` | `number` が**無い**要素と**読めない**要素が別の message になるか。同じ文言に丸めると、著者は key の書き忘れと値の書き損ねを file を読み直して判別することになる |

## dispatch case 一覧

`dispatch-cases/<id>/` は、まず plan を生成し、その plan を `dispatch.mjs` に渡して
`fake-cli.mjs`（`commandmate`/`git`/`gh` を模した stub）に対して監督ループを回す。
`scenario.json` が worker の挙動・verification・drift を注入する。worker は各ターン後に
idle 化し（`wait` は exit 0 を返す）、`commit_on`（既定 1）ターン目に「commit」する
（`git rev-parse HEAD` の SHA が進む）モデルで、runner が **idle を完了と誤認せず新規 commit を
完了判定**にすることを検証できる（#1468）。`confirm_after` は送信直後の `capture` で「まだ動いて
いない」と見せ、送信確定（再送）の経路を試せる。`fake-cli.mjs` は各呼び出しを `CMATE_FAKE_LOG` に
JSONL で記録するので、`respond` が呼ばれていないことや `send`（初回 + nudge）の回数まで検証できる。

**実行契約（#1588）**: `cli_contract: true` の scenario は CommandMate 0.17.0 相当の CLI を模し、
`send --contract` / `wait --verify` / `verify --json` を受け付け、`<sub> --help` にもそれらを載せる。
false（既定）の scenario は逆にそれらを**拒否**し `--help` からも隠すので、runner のバージョンゲートと
フォールバックが実際に効いているかを試せる。契約経路の裁定は `verify_exits`（ターンごとに消費する
exit code の列。`0` / `20` / `21` / `99`）で、`failed_gates` が `commandmate verify --json` の
失敗ゲートになる。

**Issue 本文（#176）**: dispatch runner は task text を作るとき `gh issue view <n> --json body` を
呼んで本文の否定的制約を原文転記する。plan は本文を運んでいないので、fake `gh` が返す本文は
**その plan を作った issue fixture そのもの**でなければならない（違う本文を返す fake に対して
契約 golden を pin しても、何も pin していない）。harness は plan 生成時に `issue-bodies.json` を
plan の隣へ書き、dispatch 実行時にそれを `scenario.gh.issues` として fake へ渡す —— case ごとの
ノブにすると、書き忘れた case が plan と食い違う本文を配ることになるからである。scenario が自分で
`gh.issues` を宣言すればそちらが勝つ（plan 承認後に本文が動いた世界のモデル）。
`gh.issue_view: "fail"` は読めない世界（未認証 / 網なし / `gh` 未 install）を注入する。

**受入ゲート（#114）**: `verify_exits` は「fake がこう答えろと言われた」でしかないので、
**受入ゲートが何かを測っている証拠にはならない** — 成果物が壊れていようがいまいが 20 を返す。
**timeout 時の生死（#179）**: `--wait-timeout` は `commandmate wait` の1回あたりの上限であって
worker の1ターンの上限ではないので、timeout は「runner が見るのをやめた」か「worker が止まった」の
どちらでもありうる。runner はその時点で `capture --json` を1回だけ叩いて見分けるので、fake 側の
`workers.<n>.capture` がその答えを注入する: `"idle"`（答えるが稼働の証拠なし）・`"fail"`（呼び出し
自体が exit 1）・`"unparseable"`（exit 0 のまま JSON でない出力）。既定（キー無し）は従来どおり
「送信が登録されていれば稼働中」である。`idle` / `fail` は**送信確定の信号も返さない**ので、その
worker は1回再送される —— 同じ世界を一貫して語らせるためで、case 側の `send_counts` はその 2 を固定する。
**時間（#122）**: scenario の `delay_ms`（`{"wait": 900, "send": 300}`。subcommand ごとの
ミリ秒）は、その subcommand を**実時間だけ遅らせる**。実 CLI では `wait` は worker の1ターン、
baseline はリポジトリのテスト一式だが、ローカルの fake ではどちらも 0 秒に潰れるので、
これが無いと wall-clock budget の case は「到達しない budget」を測ることになる。

**排他 lock（#122）**: dispatch runner は `--unattended` のとき worktree ごとの lock を取る。
harness は run ごとに `CMATE_ORCHESTRATE_LOCK_DIR` を work ディレクトリ配下へ向けるので、
case 同士も、開発機の実 run も巻き込まない（`unattendedLockTest` だけが**共有の**根を渡して
2本目の衝突を作る）。

そこで受入ゲートの case だけは `run_declared_gates: true` を使う。この scenario では fake が
本物と同じことをする: worktree の `.commandmate/verify.yaml` を読み、各ゲートの command を
その worktree で `sh -c` で**実際に実行し**、exit status から PASS/FAIL と run の verdict を
導く（契約が `verify.gates` を宣言していればその id だけを走らせる）。worktree の中身は
scenario の `worktree_files`（`{"<相対 path>": "<内容>"}`）が作る。
これで**二点測定の差分が成果物そのものになる**: 緑 run と赤 run は同じ Issue・同じ契約・
同じ verify.yaml で、違うのは worktree に成果物があるかどうかだけである（ADR 第4節 (2)）。契約 case では生成された契約を `contracts/` の golden と byte 比較し、さらに
**同じ plan で 2 回目の dispatch を回して byte 一致**を確かめる（決定性）。1 file しか持たない Issue では
並びを崩す変異を検出できないため、決定性の case は `issues-multifile.json`（1 Issue に 3 file）を使う。

| case | 何を見るための case か |
|---|---|
| `d01-two-waves-success` | 全 worker 完了（commit 検出）・全 verification pass で2 Wave を通過し success になるか |
| `d02-max-parallel` | `max_parallel` を超えて dispatch しないか（幅 2 の上限を守るか） |
| `d03-worker-failed-barrier` | 前 Wave の worker 失敗時に後続 Wave を dispatch しないか（barrier） |
| `d04-verification-failed-gate` | 完了しても verification 失敗なら success にせず後続を止めるか（gate） |
| `d05-prompt-human-required` | prompt 検出時に自動応答せず human-required で停止し、excerpt を redaction するか |
| `d06-drift-refuses-dispatch` | mutation 前の drift（base 未解決）で1件も dispatch しないか |
| `d07-auto-yes-respond` | `--auto-yes` 明示時のみ `respond` で応答して継続し、auto-yes 使用を記録するか |
| `d08-nudge-until-commit` | idle だが未 commit の worker を継続 nudge で駆動し、3ターン目の commit を完了判定にするか（#1468） |
| `d09-blocked-max-turns` | 永遠に未 commit の worker を `--max-turns` 到達で failed とし、idle を完了と誤認しないか（#1468） |
| `d10-send-confirm` | 送信未確定（Enter 未送信）を `capture` で検出して1回だけ再送し、その後 commit まで駆動するか（#1468） |
| `d11-worktree-path-mismatch` | 登録 path が plan template と違っても branch で解決し、git 操作を同じ worktree に向けるか（#1473） |
| `d12-parallel-supervision` | Wave 内の worker を逐次でなく並行に監督するか（send の crossover で確認、#1474） |
| `d13-contract-verified-pass` | 契約を決定的に生成して配置・`send --contract` し、`wait --verify` の exit 0 を裁定とし task id を記録するか（#1588） |
| `d14-contract-verify-failed` | exit 20 で `commandmate verify --json` から失敗ゲートを特定して再指示し、上限到達でも success に丸めないか |
| `d15-contract-not-started` | exit 21 を pass に丸めず nudge し、上限到達で dispatch 失敗系（failed）とするか |
| `d16-contract-prompt-halts` | 契約経路でも exit 10 を自動応答せず human 提示で停止するか（`--on-prompt agent` を渡していること） |
| `d17-contract-no-verdict` | **exit 99 を 20 の再指示ループへ流さず**、`not_run` として human へ上げるか（本 Issue の中心規則） |
| `d18-contract-fallback-unsupported` | 契約非対応 CLI で明示メッセージつきに baseline 裁定へフォールバックするか（黙って劣化しない） |
| `d19-contract-required-refuses` | `--contract-mode require` がフォールバックを拒否し、1件も dispatch せず failure で止まるか |
| `d20-contract-mode-off` | 契約対応 CLI でも `--contract-mode off` で従来裁定を選べ、その選択を limitation に残すか |
| `d37-acceptance-gate-pass` | 受入ゲートの**適合側（緑）**。`require` した id が実在し、fake CLI が worktree の verify.yaml のゲートを**実際に実行**して通る。契約に `verify:` key は書かれず、由来は `origin: issue` / `repo` に分かれる |
| `d38-acceptance-gate-mutation` | 同じ**変異側（赤）**。d37 と Issue も契約も verify.yaml も同一で、違いは worktree から成果物が消えていることだけ。赤の理由も固定する（exit 20 であり、失敗ゲートに当該 id が名指しで含まれ、その exit は 1） |
| `d39-acceptance-gate-id-unknown` | `require` した id が verify.yaml に無い Issue を **`send` の前に**拒否し、実在する id を列挙して止めるか |
| `d40-acceptance-gate-absent-non-regression` | ブロックを持たない Issue の契約が従来どおりか。d37 と同じ worktree・同じ deliverable で本文からブロックだけ抜いた双子（golden が byte で固定） |
| `d41-acceptance-gate-command-missing` | ゲートのコマンドが起動不能（binary 不在→exit 127）のとき赤になり、report がその事実を名指しするか。**この case を d38 の変異側に流用してはならない**（打ち間違えた偽ゲートは成果物が正しくても 127 で赤くなる） |
| `d42-acceptance-gate-union` | `--verify-gates` と Issue の `require:` の**和集合**（sort + 重複除去）を契約に書くか。素朴な書き出しは lint を止め、operator の列挙をそのまま使うと Issue の要求が落ちる |
| `d43-acceptance-gates-not-enforceable` | 実行契約の無い run（`--contract-mode off`）で受入ゲートを宣言した Issue を dispatch しないか（裁定に運ぶ口が無いので fail-closed） |
| `d94-acceptance-gate-defined-pass` | **Issue が定義した**ゲートの適合側（緑）。定義は契約の `verify.gateDefinitions` に載り、fake CLI は verify.yaml のゲート集合とマージして実行する。契約に `verify.gates` は書かれない。そして **`.commandmate/verify.yaml` が byte 単位で不変**であることを assert する（#125 の中心的な主張） |
| `d95-acceptance-gate-defined-mutation` | 同じ**変異側（赤）**。d94 と Issue も契約も verify.yaml も同一で、違いは worktree から成果物が消えていることだけ。exit 20 であり、**契約にしか存在しない** gate id が失敗集合に名指しで含まれ、その exit は 1 |
| `d96-acceptance-gate-defined-conflict` | 定義した id が worktree の verify.yaml に**既に在る**とき、`send` の前に `acceptance_gate_id_conflict` で止めるか。契約は足せるだけで上書きできない（上流は同じ契約を送信時 exit 2 で拒否する） |
| `d97-acceptance-gate-defined-union` | `--verify-gates` を渡した run で、契約の `verify.gates` に**定義した id が列挙される**か。列挙しない契約は上流が「定義したのに誰も走らせない」として拒否するので、fake の送信時照合が exit 2 を返す |
| `d98-acceptance-gate-defined-not-enforceable` | 実行契約の無い run で `gates:` を宣言した Issue を dispatch しないか（d43 の `require:` 版と対になる） |
| `d99-verification-flaky-tolerated` | **`FLAKY` の受理側（[#224](https://github.com/Kewton/commandmate-skills/issues/224)）。** `wait --verify` が `GATE unit FLAKY` を出して **exit 0** を返す世界（gate の `flakyIsPass: true` が効いた）。report の gates に `verdict: flaky` が残り、裁定は exit code に従って `pass` のままであること。**製品 CLI の括弧形式**と **standalone runner の空白区切り（`waited=` 付き）**を 1 つの出力に混在させ、どちらも読めることを同時に測る |
| `d101-acceptance-gate-defined-flaky` | **契約が運んだ `retryOnFail` / `flakyIsPass` が本当に効くことの端から端まで（[#223](https://github.com/Kewton/commandmate-skills/issues/223) / [#224](https://github.com/Kewton/commandmate-skills/issues/224)）。** ゲートのコマンドは 1 回目に marker を置いて exit 1・2 回目は exit 0 なので、緑になるのは**同一 tree の再実行が実際に走ったときだけ**である。契約に 3 行が宣言どおり書かれ、report の gates はそのゲートを `flaky` として残し、裁定は wait の exit code に従い、**`.commandmate/verify.yaml` は 1 バイトも変わらない** |
| `d102-contract-scope-patterns` | **宣言 glob が実行契約の `scope.allow` に byte 一致で載ることの golden（[#219](https://github.com/Kewton/commandmate-skills/issues/219)）。** dispatch の `contractScopeReview` は 0.31.0 の時点で既に `*` を拒まず契約へ書いていたが、それを測る case も文書も無く、planner が glob を1つも作れなかったので**通ったことが一度も無い経路**だった。`## Files you may change` は plan の順、`scope.allow` は sort 済みという既存の規約がそのまま効き、pattern は特別扱いされない。`data/geo/stations/` は**末尾スラッシュを保ったまま**運ばれる |
| `d100-verification-flaky-counted-as-failure` | **d99 との二点測定（既定側）。** GATE 行の綴りは d99 と同一の `FLAKY` で、違うのは exit code（20）だけ —— `flakyIsPass` を宣言しない repository では FLAKY は fail として数えられる。gates の `flaky` は裁定が転んでも書き換わらず（「本当に 2 回落ちた run」と区別できなくなるため）、`verify --json` 側の `status: failed` + `flaky.outcome: flaky` が worker への再指示に「再現しなかったが失敗として数える」と載ること |
| `d110-max-turns-upstream-pane` | **[#220] `--max-turns` 到達の3分類、上流障害を pane で見る側。** exit 21 が続いて cap に達したとき、その時点の `capture --json` の `realtimeSnippet` が上流エラー署名（`529 Overloaded`）に一致する。`worker_turn_evidence.code` は `worker_upstream_unavailable` で、同じ code が blocking にも並ぶ。**裁定は 1 つも動かない**（`verification.outcome: fail` / `worker_state: failed` / `worker_failed` はそのまま）—— これが本 Issue の中心的な主張で、d110〜d116 の全 case が同じ裁定を assert している |
| `d111-max-turns-upstream-transcript` | **同じ 3 分類の、実測そのもの（CommandMate #1834）。** pane は 1,001 行すべて空白で**画面には何も無い**。判定材料は worker の transcript で、末尾が同一の 1 行エラー（`API Error: 529 Overloaded`）13 件連続である。`snippet_blank: true` / `line_count: 1001` は転記であって判定材料ではない。transcript の `path` が **redaction 後**であること（絶対 path が artifact に出ないこと）もここで固定する |
| `d112-max-turns-produced-nothing` | **反対側（ターン成立の肯定的証拠）。** transcript に tool 使用と非エラー出力があり、pane にも非空白・非エラーの出力がある —— **「Issue を分割 / 書き直して re-plan」が正しい唯一の世界**である。`upstream_signature` は `null`、`trailing_identical_error_entries` は 0 |
| `d113-max-turns-capture-unreadable` | **測れなかった側。** `capture` の呼び出し自体が失敗し、画面も `cliToolId` も hooks も 1 つも読めない。`worker_output_unreadable` を名乗り、detail は**どちらとも読み替えない**ことと手動確認コマンド（path-free）を出す。転記できなかった field は `false` ではなく `null` である |
| `d114-max-turns-transcript-ambiguous` | **「読めなかった」の 2 つ目の形: 候補が絞れない。** pane は空白だけ・hooks 無し・transcript の directory に session が 2 つ。1 つ選べば推測を測定に見せかけることになるので、runner は選ばずに `read: false` と件数を名乗る。**空白だけの pane は肯定的証拠ではない**（d111 では同じ空白の pane が `worker_upstream_unavailable` になっており、判定していたのが pane でないことがそこで分かる） |
| `d115-max-turns-hooks-stop-returned` | **hooks だけで「ターンは成立した」を測る側。** pane も transcript も何も言わない世界で、`structuredEvents.lastStopEventAt` が最後の send より**新しい**ので `worker_produced_nothing`。`isRunning` は tmux セッションが healthy の意味なので使えず、`stop` だけが「ターンが終わった」を言う |
| `d116-max-turns-hooks-no-stop` | **d115 の双子（変数は timestamp の前後だけ）。** `lastStopEventAt` が最後の send より**古い** —— 投げたターンが終わっていないので `worker_upstream_unavailable`。2 点にしてあるのは、`stop` の比較を反転する変異が**両方を赤にする**ようにするためである（片側だけなら定数を裏返して緑を保てる） |
| `d49-unattended-two-waves-parity` | **無人運転の二点測定（#122）。** 同じ世界を `--unattended` 有り／無しで2回 dispatch し、`status` / `stop_reason` / `waves[]` / `drift_checks` / `blocking_reasons` / `completion_check` / `redactions` が**一致**し、差分は limitation の `unattended_mode` / `unattended_baseline` **だけ**であることを assert する（「緩めない」の機械的証明。self-report の boolean より強い） |
| `d50-unattended-prompt-halts` | 無人でも prompt（exit 10）で止まり、`respond` を送らず `human_required: true` のままか。**無人だから human_required を false にする、はしない** |
| `d51-unattended-not-judged` | 無人でも exit 99 を pass に丸めず、20 の再指示ループにも流さないか。フラグ無しの run との二点測定つき |
| `d52-unattended-open-questions` | 未回答 question を持つ plan を pre-flight で拒否し、**`--out` を作らない**か（フラグ無しの run は従来どおり `--out` を作って停止する）。`--allow-questions` の案内を出さないことも固定する |
| `d53-unattended-scope-preflight` | scope を宣言できない Issue を含む plan で、**worktree を1つも probe せず・1人も dispatch せず・`--out` も作らずに** all-or-nothing で止まるか。`contract_scope_unknown` が limitation ではなく blocking であること |
| `d54-scope-refused-without-unattended` | **d53 の対（二点測定のフラグ無し側）。** 同じ plan・同じ世界で、`--unattended` 無しなら他 Issue は従来どおり dispatch される（＝ d53 の停止は新しい拒否ではなく**検出時点を早めた**もの）ことを示す |
| `d55-unattended-contract-required` | `--contract-mode` を渡していないのに `require` が含意され、契約非対応 CLI が limitation ではなく blocking になるか（scope 必須化と契約必須化は同義） |
| `d56-unattended-wall-clock-budget` | `--wall-clock-budget` 到達で `partial` / `stop_reason: timeout` になり、**`stop_reason` の enum に新値を足していない**か。`scenario.delay_ms` で `wait` / `send` に実時間を持たせている |
| `d73-constraints-transcribed-verbatim` | **否定的制約の原文転記（#176）。** 否定語を含まない見出しの下に在る「送ってはいけない」表と `## 非対象` 節が、要約されず**全行原文で** goal に載るか。転記が完走したので切り捨ての1行は入らない |
| `d74-constraints-untranscribed` | 転記が上限に収まらなかったとき、**ブロックを途中で切らず**に打ち切り、落とした節を名指しして `本文に他節がある。gh issue view <n> で全文を読め` を入れ、`issue_constraints_untranscribed` を記録するか（#176） |
| `d75-issue-body-unreadable` | `gh issue view` が落ちる世界で dispatch は止まらないが、goal が「読めなかったこと」と `gh issue view <n>` を名指しし、`issue_body_unreadable` を記録するか。**「制約なし」の goal を黙って送らない**（#176） |
| `d76-timeout-worker-alive` | **timeout の生死（#179）の「生きている」側。** wait が timeout した時点で `capture` を**1回だけ**叩き、稼働中なら `wait_window_exhausted` と `worker_liveness` を記録し、next action が「待って `--reverify`」（**再 dispatch ではない**）になるか。timeout していない相方の worker には `worker_liveness` が**付かない** |
| `d77-timeout-worker-stalled` | **同じ timeout の「稼働の証拠なし」側**（d76 の対）。`capture: "idle"` を注入して `worker_stalled` になり、next action が `--resume` 側に変わるか。**契約非対応 CLI（フォールバック経路）で回す**ので、契約経路にだけ生死判定を入れた実装はここで赤くなる |
| `d78-timeout-liveness-unreadable` | **読めなかった側（受入条件4）。** `capture` が失敗する worker と、exit 0 のまま想定外の出力を返す worker の2件で、どちらも `worker_liveness_unreadable` になり detail がどちらの壊れ方かを名指しするか。**「読めなかった」を「止まっている」に丸めない。** blocking reason が `workers` の順に並ぶ（並行監督の完了順で report が変わらない）ことも固定する |
| `d79-open-questions-block-refused` | 著者が宣言した未決の問いが**既存の** open question ゲートで止めるか。`send` は 0 回で、blocking reason が著者の原文を引用するか（#178） |
| `d80-open-questions-block-accepted` | 同じ plan が `--allow-questions` では通り、しかし question は消えず `open_questions_accepted` と summary に残るか（#178。新しい緩和フラグを足していないことの確認） |
| `d81-dispatch-defaults-from-profile` | **profile が宣言した運転既定（#180）。** flag を1つも渡さない run で `dispatch_defaults` の3値が効くか。効いた証拠は report の self-report ではなく **fake CLI が受け取った argv**（`wait --timeout 600` / `send --auto-yes --duration 3h`）に取る。3h は `max_turns × wait_timeout` から導かれる窓なので、宣言を読んだだけで使っていない実装はここで 1h を送る |
| `d82-dispatch-defaults-cli-overrides` | **d79 の相方（二点測定）。** 世界も plan patch も同一で `dispatch_args` だけが違う。`--wait-timeout` / `--max-turns` が profile を上書きし、600 を運ぶ `wait` が1つも無く、auto-yes の窓が**解決後の値から導き直されて** 1h になるか |
| `d83-dispatch-defaults-explicit-false` | **明示した off が profile の true を上書きするか（受入条件2）。** profile が `auto_yes: true`、run は `--no-auto-yes` だけ。三値で読んでいない実装は profile の true を残して prompt を自動応答し、**exit 0 の success** を返す —— 断れなかったことが status の違いとして出る |
| `d84-dispatch-defaults-unattended-refused` | **既存の排他が解決後の値に効くか（受入条件3）。** flag を1つも渡していないのに profile 由来の auto-yes と `--unattended` の併用を `invalid_input`（exit 3）で拒否し、**`--out` を作らず CLI を1回も呼ばない**か。`accepted_with_args` で `--no-auto-yes` を足せば完走することも測るので、「`--unattended` を常に拒否する」実装では緑にならない |
| `d85-dispatch-defaults-no-infer-mismatch` | **dispatch が消費できない宣言を黙って無視しないか。** `no_infer` は planner の flag なので、承認済み plan を dispatch が un-infer することはできない。profile が宣言しているのに plan は `inputs.infer: true` で作られている（付け忘れが残る形そのもの）とき、止まりはしないが limitation で名指しし `--no-infer` で取り直せと言うか |
| `d86-dispatch-defaults-no-infer-honored` | **d83 の相方。** 世界も plan patch も同一で、planner を `--no-infer` で回した側。依存が explicit なので wave 構成は d83 と同じで、差分は **limitation が1件も出ないこと**だけ。合致まで報告する実装は、読む価値のある行を noise で埋める |
| `d87-schedule-wave-default-nonregression` | **既定（wave）の byte 非回帰（#183 受入条件1）。** `--schedule` を渡さない run の report が **#183 実装前の runner が書いた golden**（`expected-dispatch-report.json`。`out_dir` だけ `<out>` に置換）と byte 一致するか。同時に barrier そのものも固定する: #300 にしか依存していない #303 が、**同じ wave に居合わせただけの最遅 worker #302（6ターン）の最後の send より後**でなければ1度も送られない（`barrier_send_order`）。d88 の双子で、違うのは `dispatch_args` だけである |
| `d88-schedule-dag-independent-not-blocked` | **d87 の相方（#183 受入条件2）。** 同じ plan・同じ world を `--schedule dag` で回すと、#300 が green になった時点で #303 が空き枠へ入り、#302 の**最後の** send より前に送られる（`parallel_send_crossover`。wave barrier では構造的に不可能な crossover）。`waves[]` は投入ラウンドで `[[300,301,302],[303]]` になり、limitation `schedule_dag` が3点（`--max-parallel` は同時実行数の上限／`plan.waves` は参考情報／CommandMate#1771）を名乗る |
| `d89-schedule-dag-upstream-failure-downstream-only` | **失敗の伝播は下流だけ（#183 設計論点1）。** #310 が1ターンで failed、#311 は3ターンで green。#310 の下流 #312 だけが `blocked_by_upstream_failure` で止まり、**独立系列の #313 は #311 が green になった時点で投入されて完走する**（wave barrier なら #312 も #313 も1件も dispatch されない）。stop_reason が結果（`not_dispatched`）ではなく原因（`worker_failed`）になることも固定する |
| `d90-schedule-dag-unattended-halts-all` | **d89 の双子（安全側）。** 世界も plan も scenario も同一で、違いは `--unattended`（と必須の `--wall-clock-budget`）だけ。無人では**従来どおり全停止**し、上流 #311 が green になっても #313 は1度も send されない。止めた理由は Issue ごとに正確に分ける —— #312 は本当に上流が壊れているので `blocked_by_upstream_failure`、#313 は依存が pass しているので `schedule_halted_unattended`（対処が違うので丸めない） |
| `d91-schedule-dag-max-parallel-bound` | **`--max-parallel` は同時実行数の上限のまま（#183 受入条件3）。** 依存ゼロ3件を `--max-parallel 2` の DAG で回すと、3件とも ready なのに round 0 は2件だけで、3件目は枠が空いてから入る（`waves_dispatched: [[400,401],[402]]`）。ready を全部投入する実装は `dispatched.length 3 > max_parallel 2` を書き、全 dispatch case にかかる上限 assert で落ちる |
| `d92-schedule-dag-timeout-liveness` | **#183 × #179。** DAG では worker の終了順が投入順と一致しないので、timeout の生死の見分け（`wait_window_exhausted` / `worker_stalled`）が壊れていないことをここで測る。#402 は timeout しないので `worker_liveness` を**持たない**。生死の blocking reason を完了順に push した実装は run ごとに並びが変わるので、`blocking_order` が plan 順（#400 → #401）を固定している |
| `d93-dispatch-defaults-real-profile` | **d81 の相方（#196）。宣言が profile から run まで通ることの端から端までの測定。** 世界も期待値も d81 と同一で、`plan_patch` を使わず**本物の profile を planner に渡して plan を作る**。したがって測っているのは planner の echo であり、`publicProfile()` が宣言を落とせば `wait` の argv は 300 に、`send` の窓は 1h に戻って赤くなる |

## merge case 一覧

`merge-cases/<id>/` は、まず plan を生成し、次にその plan を `dispatch.mjs` に通して
`dispatch-report.json` を作り（plan→dispatch→merge の handoff を実証）、その report を
`merge.mjs` に渡して1つの mutating phase（`--create-prs` か `--merge-prs`）を `fake-cli.mjs`
（`gh`/`git` を模した stub）に対して実行する。case.json に inline した `merge_scenario` が
PR 作成・CI・merge の挙動を注入する。`fake-cli.mjs` は各呼び出しを `CMATE_FAKE_LOG` に記録
するので、`--approve` 無しに `git push`/`gh pr create`/`gh pr merge` が呼ばれていないこと、
CI が green でないときに `gh pr merge` が呼ばれていないことまで検証できる。

**合流後の統合ブランチ検証（#175 / #195）**: `--integration-verify` を渡した run は、merge の後に
`git fetch origin <base>` → `git worktree add --detach` → **profile の検証集合
（`integration_baseline` ?? `baseline`。#195）をその checkout で実行** →
`git worktree remove --force` を行う。`merge_scenario.integration` がその4段を injection
する（`verify: "pass"` で使い捨て checkout に `cmate-verify-ok` を置く＝ baseline が緑になる。
`fetch` / `worktree_add` / `remove` に `"fail"`）。緑 case と赤 case は **同じ world・同じ引数**で、
違いは合流後の checkout に成果物が在るかどうかだけである。フラグ**無し**の case（`m22`）は
`expected-merge-report.json`（`out_dir` だけを `<out>` に置換）と **byte 比較**し、その golden は
**#175 実装前の runner**（`git show HEAD:skills/cmate-orchestrate/scripts/merge.mjs`）が書いたもので
ある —— opt-in が opt-in であること（既定の出力を1 byte も変えていないこと）の機械的な証明である。

**呼び出し元 worktree の `index.lock`（#222）**: merge runner は run の開始時（pre-flight より前）と
report を書く直前に `git rev-parse --git-path index.lock` → `stat` し、`caller_worktree` に2つの
読みを載せる。fake の `rev-parse --git-path` は `.git/index.lock` を返す（本物の git が main
worktree で返す形。linked worktree では絶対 path になるが、fixture が作れて残せるのは前者である）。
case の `caller_index_lock: "pre_existing"` は **harness が run の前に** 0 バイトの lock を
呼び出し cwd へ置き、`merge_scenario.integration.caller_index_lock: "appear"` は **fake が
`git worktree remove` の時に**（＝ run の最中に）置く。**どちらも誰も消さない** ——
`caller_index_lock_remains` が run 後に lock が**残っていること**をファイルシステムの事実として
確かめるので、limitation の綴りが合っていても unlink する実装は赤くなる。
`git.git_path: false` は「そもそもリポジトリでない cwd」を模し、そのときは両方 null になる
（＝「lock は無かった」ではなく「何も測っていない」）。

case.json は `plan_patch` で**生成された plan を merge に渡す前に書き換えられる**
（`dispatch_report_patch` と同じ理由: plan はこの runner の**入力**であり、`baseline` を埋め忘れた
profile のような状態は、harness 自身の dispatch 段が baseline を必要とするため planner だけでは
作れない）。**`plan.profile_json` はその逆**で、実在の profile fixture を **planner に食わせて** plan を
作る（#195 の `m28`〜`m30` がこちら）—— 測りたいのが「宣言が profile から merge まで通ること」
なので、plan に手で書いてしまうと planner の echo が測定から外れる。`dispatch_scenario` の
`worktree_files` は worker の worktree にだけ file を置くので、**worker が回す `baseline`** と
**merge が回す統合検証**を別々に緑／赤にできる（`m29` の二重変異はこれで作っている）。

| case | 何を見るための case か |
|---|---|
| `m01-create-prs-approved` | 承認ありで verification pass branch を push し PR を作成し success になるか |
| `m02-create-prs-preview` | `--approve` 無しで push/PR 作成をせず preview に留まるか |
| `m03-create-pr-fails` | PR 作成失敗（injection）で partial 停止し、後続を skip するか |
| `m04-merge-prs-approved` | 承認あり・CI green で PR を merge し success になるか |
| `m05-merge-prs-preview` | `--approve` 無しで CI を read-only 確認し merge しないか |
| `m06-merge-ci-fails` | CI failure（injection）で merge を拒否し partial 停止するか |
| `m07-merge-conflict` | CI green でも merge conflict（injection）で partial 停止するか |
| `m08-merge-ci-pending` | CI pending を pass 扱いせず merge を拒否するか |
| `m09-merge-pr-missing` | PR が無い eligible で merge を捏造せず partial 停止するか |
| `m10-preflight-gh-unavailable` | gh 不在の preflight で何も試さず failure になるか |
| `m11-no-eligible` | verification pass が無いとき no-op success（mutation なし）になるか |
| `m12-single-phase-guard` | `--create-prs` と `--merge-prs` の同時指定を invalid_input で拒否するか |
| `m13-base-not-default-branch` | base がデフォルトブランチでないとき `Resolves #n` の無効を limitation と PR body に記録するか（#39） |
| `m14-base-is-default-branch` | base がデフォルトブランチのとき何も記録しないか（#39） |
| `m15-default-branch-unknown` | `gh repo view` 失敗時に照合をスキップするだけで PR 作成を阻害しないか（#39） |
| `m21-pr-body-nonascii-path` | 非ASCII を含む path で、対比が git の**表記**でなく path そのもので行われるか（#174）。fake の `git diff` は本物と同じく出力を munge する（`core.quotePath` 既定 true で非ASCII を8進エスケープ、`"` は設定に関係なくクォート）ので、`-z` を使わない runner は同じ file を2行に割り `Out-of-scope changes: 1` を立てる。宣言 scope が日本語ファイル名の #300 は 0 件・表1行、宣言外の変更を持つ #301 は 1 件を**読める形で**名指し（空振り防止）。#301 の宣言外 path が `"` を含むので、最小修正 `-c core.quotePath=false` へ後退しても赤になる |
| `m22-integration-verify-absent` | **#175 (a)。** `--integration-verify` 無しの run が **#175 実装前と byte 一致**するか（`expected-merge-report.json` と byte 比較。`out_dir` だけ `<out>` に置換）。`integration_verify` field を持たず、`git fetch` も `git worktree` も**1回も呼ばない**こと。m24 の双子で、違うのは `merge_args` だけである |
| `m23-integration-verify-red` | **#175 (b)。** PR 個別 CI が両方 green で2件とも merge できたのに、**合流後の baseline が赤**。`integration_verify.outcome: fail` と blocking `integration_verify_failed` を載せ、`partial`（exit 7 / `stop_reason: merge_failed`）にして **success に丸めない**か。次 wave を止める信号がこの3つである。m24 との違いは合流後 checkout に成果物が在るかだけ |
| `m24-integration-verify-green` | **#175 (c)。** 合流後が green なら従来どおり `success` / `completed` で、`integration_verify.outcome: pass`。使い捨て checkout を**作って畳む**（fetch 1回・worktree 2回）ので、緑の検証は何も残さない。#222 でここに `tree_removed: true` が加わった —— 「畳んだ」を **`integration_verify_tree_left` が無いこと**で表すのをやめ、report が自分で言うようにした（`m35` が false 側） |
| `m25-integration-verify-no-baseline` | profile が `baseline` を宣言していない plan に `--integration-verify` を渡したとき、**1件も merge せずに拒否**するか（`failure` / exit 1 / `preflight_failed` / `integration_verify_unavailable`）。skip にすると「opt-in した検証が走らないまま merge phase 完了」になり、#175 が消しに来た事象そのものになる |
| `m26-integration-verify-create-prs-refused` | `--create-prs` との併用を `invalid_input`（exit 3）で拒否し、**受理して無視しない**か。push も PR 作成も 0 回 |
| `m27-integration-verify-preview-not-run` | preview（`--approve` 無し）では merge が無いので合流後も無く、`outcome: not_run` + limitation `integration_verify_not_run` になるか。**fetch も checkout もしない**こと。「測っていない」を pass に丸めない |
| `m28-integration-baseline-declared-red` | **#195 の空振り検査（変異）。** 宣言した `integration_baseline` が**実際に走っている**か。profile は #175 を起票させた実測の形（`baseline` は proportional で合流後も **green**、`integration_baseline` はそれ＋ unit 相当の1本で **red**）なので、宣言を無視して `baseline` を回す実装 —— #175 の挙動 —— では `outcome: pass` になり、このケースは「緑だが何も測っていない」に化ける。`source` と `failed_command` が「宣言の側だけが持つ command で落ちた」ことを名指す。profile は `plan_patch` でなく **planner に食わせる**ので、planner の echo も同時に測っている |
| `m29-integration-baseline-declared-green` | **m28 の逆向きの変異。** ここでは**フォールバックが赤・宣言が緑**なので、`pass` は `integration_baseline` を読んだ実装にしか出せない（`baseline` は worker の worktree にだけ在る marker を読み、使い捨て checkout には無い）。緑の report にも `source` が載ることの測定でもある —— **静かな2つ目の baseline が隠れるのは赤ではなく緑の report である** |
| `m30-integration-baseline-declared-empty` | **#195 の固定事項2。** `"integration_baseline": []` は「統合検証の定義は無い」という**宣言**であり、`baseline` へは落とさない。profile の `baseline` は**実行可能で緑**なので、空かどうかでフォールバックを決める実装は2件 merge して緑を報告する。ここでは merge 前に拒否（exit 1 / `preflight_failed` / `integration_verify_unavailable`、fetch 0回）し、next action は m25 の「`baseline` を宣言しろ」**ではない**こと（`summary_absent` が固定する。意図した宣言を取り消せという案内になるため） |
| `m32-pr-body-flaky-gate` | **PR 本文は転記であって再判定ではない（[#224](https://github.com/Kewton/commandmate-skills/issues/224)）。** `verdict: flaky` の gate が Verification 表にそのまま載り、その語の意味が表の隣で説明される —— `| unit | flaky | 1 |` だけでは pass の一種か fail の一種か判断できず、判断しようとすると `flakyIsPass`（本文にも report にも無い宣言）を両方向に取り違える。注記は「どう数えたか」を言わず `Verdict` 行を指す。`flaky` を持たない Issue の本文にはこの注記が出ない（使っていない repository の本文は 1 バイトも変わらない） |
| `m33-caller-index-lock-pre-existing` | **#222 (a)。** m24 の world に、run の**開始前から** 0 バイトの `.git/index.lock` が呼び出し元に在る。この runner は呼び出し元の index を読み書きしないので**止める理由が無く**、status / stop_reason / target は m24 と同じまま `caller_index_lock_pre_existing` を積むか。`caller_index_lock_appeared` は**出てはならない**（2つを混同する実装はここで赤くなる）。run 後も lock が**残っている**ことを確かめる |
| `m34-caller-index-lock-appeared` | **#222 (b)。** 開始時は clean で、run の**最中に** lock が出現する（fake が `git worktree remove` の時に置く）。`caller_index_lock_appeared` は limitation であって**停止ではない** —— merge も統合検証も終わった run を failure に落とすのが、この Issue が消しに来た誤読そのものだからである。`index_lock_before` は null、`index_lock_after` に size / mtime が載り、**file は残っている**。`caller_index_lock_pre_existing` は出てはならない（区別は**開始時の読み**だけが持っている） |
| `m35-integration-tree-remove-fails` | **#222 (c)。** 使い捨て checkout は作れて baseline も緑だが、`git worktree remove --force` が失敗する。後片付けは best effort なので**裁定は動かず** `success` / `pass` のまま、`integration_verify.tree_removed: false` と limitation `integration_verify_tree_left` が**併存**するか。#222 以前は失敗側しか記録が無く、成功が無言だった（＝「畳んだ」と「言えるほど新しくない runner」が同じ report だった）ので、m24 の true 側を測定として固定するにはこの false 側が要る。呼び出し元は無傷（両方 null） |
| `m40-scope-pattern-parity` | **PR 本文の scope 対比が上流の `globToRegExp`（CommandMate #1546）と同じ解釈をするか（[#219](https://github.com/Kewton/commandmate-skills/issues/219)）。** 0.31.0 の `scopeMatches` は `*` と `**` だけを解釈したので、上流が許可する3つの形（ディレクトリ前置 `src/lib`・`?`・`{a,b}`）をすべて違反として数えていた。#520 の変更 6 件のうち宣言外は 3 件で、`docs/ab.md`（`?` は1文字）・`src/c/x.ts`（`{a,b}` は選択）・`src/lib2/note.ts`（前置は segment 境界で切れる）が**逆側**の証拠である —— これが無いと「全部 in-scope と答える matcher」でも緑になる。#521 は pattern を持たない対照 |
| `m31-integration-baseline-plan-not-array` | **plan を読む側の fail-closed。** planner は配列でない `integration_baseline` を拒否する（plan case 76）が、**手で書いた plan** はこの runner に届く（#180 / profile-contract 第10.6節）。素の文字列は「強制変換すれば動く」形で `baseline` は緑なので、丸める実装も「配列でない＝未宣言」と読む実装も 2件 merge して緑を報告する。merge 前に拒否し、`source` は `integration_baseline` のまま（宣言は読めている。実行できる command が無いだけである） |

## uat case 一覧

`uat-cases/<id>/` は、plan と `dispatch-report.json` を生成した後、その report を `uat.mjs` に渡して
1つの phase（`--write-uat` か `--create-uat-fix-worktrees`）を `fake-cli.mjs` に対して実行する。
`uat_scenario` が UAT の合否（`fix_on` で attempt ごとに変える）、fix worker の挙動（`commit_on` で
completed までのターン数を、`state` で prompt/timeout/failed を注入）、fix worktree 作成の可否、
再merge の conflict を注入する。fix worker も dispatch worker と同じく idle を完了とみなさず **新規 commit**
を完了判定に使う（#1468）。`fake-cli.mjs` は各呼び出しを `CMATE_FAKE_LOG` に記録するので、preview で
worktree 作成・fix dispatch・再merge が呼ばれていないこと、修正ループが上限で停止（回数無制限でない）
していること、attempt 履歴が上書きでなく append されていること、fix worker の `send`（初回 + nudge）
回数まで検証できる。

| case | 何を見るための case か |
|---|---|
| `u01-write-uat-all-pass` | write_uat が read-only で UAT を実行し、全 pass で mutation なし success になるか |
| `u02-write-uat-fail` | write_uat が UAT 不合格を partial（uat_failed）として報告し next action を返すか |
| `u03-fix-pass-after-one` | UAT fail→fix worktree→修正→再検証→再merge→再UAT pass を上限内で success にするか |
| `u04-fix-blocked-max-attempts` | UAT が通らないとき上限回数で停止し blocked（成功に丸めない）で未解決を報告するか |
| `u05-fix-preview` | `--approve` 無しで worktree 作成・fix dispatch・再merge をせず preview に留まるか |
| `u06-fix-worktree-fail` | fix worktree 作成失敗（injection）で fix dispatch 前に partial 停止するか |
| `u07-no-eligible` | verification pass が無いとき UAT を実行せず no-op success になるか |
| `u08-fix-remerge-conflict` | 再検証は pass しても再merge conflict（injection）で partial 停止するか |
| `u09-fix-nudge-until-commit` | idle だが未 commit の fix worker を継続 nudge で駆動し、commit を完了判定にしてから再検証・再merge するか（#1468） |

## status case 一覧

`status-cases/<id>/` だけは fake CLI を使わない。`status.mjs` は run directory の artifact を
読むだけの完全 read-only runner なので、case の入力は **checked-in の run directory**
（`status-cases/<id>/run/`）そのものである。中身は実 runner（plan / dispatch / merge / uat）の
出力を1度生成して置いたもので、`out_dir` だけは生成時の絶対 temp path を run 相対に書き換えて
ある（`status.mjs` は読まないフィールドであり、他人の host path を repo に入れないため）。

checked-in artifact が古い形のまま緑になり続けることを防ぐため、harness は **view を見る前に
各 artifact を同梱 schema（`execution-plan.v2` / `dispatch-report.v1` / `merge-report.v1` /
`uat-report.v1`）で検証する**。意図的に壊した artifact だけが `schema_unvalidatable` で免除される。
さらに全 case で次を無条件に確かめる: artifact が無い phase は Issue 行でも必ず「未実行」、
全 artifact が読めない phase は必ず「読取不能」、その2つは text 表にも必ず現れる、`--json` は
2回実行して byte 一致（決定性）、そして 3 回実行しても run directory が byte 単位で変わらない
（read-only であること）。

| case | 何を見るための case か |
|---|---|
| `s01-plan-only` | plan だけの run で dispatch/merge/uat を「未実行」と出し、次アクションを最初の未実行 phase 1件に絞るか |
| `s02-plan-dispatch` | dispatch の worker_state と verification.outcome を Issue ごとに出し、完走時のみ次 phase のコマンドを示すか |
| `s03-all-phases` | create_prs と merge_prs の2 artifact から PR 番号・URL・CI verdict・merge 状態を畳み、uat verdict まで1表に出すか |
| `s04-dispatch-partial` | partial を success に丸めず、`failed/pass`（完了と裁定の分離）と未 dispatch の「記録なし」を出すか |
| `s05-unreadable-dispatch` | 壊れた dispatch report で当該 phase だけを「読取不能」に落とし、他 phase を通常表示するか |
| `s06-unreadable-plan` | plan.json が読めないとき Issue 集合と run_id を下流 artifact から復元し、plan phase だけを落とすか |
| `s07-blocking-hints` | blocking/limitation の code を §5 対処表にマップし、Issue を名指しした reason だけをその行に出し、未登録 code を推測しないか |
| `s08-uat-blocked` | 上限到達の blocked と Issue ごとの fix attempt 数、未承認 merge の `previewed` を丸めずに出すか |
| `s10-unattended-budget` | wall-clock budget で打ち切った無人 run。**新しい `stop_reason` 値を足していない**ので既存の `timeout` の hint が引かれ、何が起きたかは blocking の `wall_clock_budget_exhausted` が名指しする。run 全体の宣言と Issue ごとの取り消し起点が、それぞれ run 行と Issue 行に分かれるか |
| `s11-unattended-locked` | 排他 lock で拒否された無人 run（何も書いていないので `out_dir: null`・wave 0件）。hint が「先行 run の終了を待って同じコマンドを再実行する」になり、**`human_required` は false** であるか |
| `s12-dispatch-flaky-gate` | **マトリクスは `FLAKY` を残す（[#224](https://github.com/Kewton/commandmate-skills/issues/224)）。** `unit=flaky` がそのまま出て、さらに `flaky_gates` として**独立に名指し**される（20 本並ぶ gate 行では、カンマ区切りの 1 トークンは読み飛ばされる）。`verification=pass` は runner の exit code であって、この行から再計算したものではない |
## profile-init case 一覧

`profile-init-cases/<id>/repo/` は、`profile-init.mjs` に読ませる**小さな本物のリポジトリ**である
（`package.json` / `Cargo.toml` / workflow / CONTRIBUTING 等を実 file として置く）。harness は
その tree に対して起案を回し、`expected-profile.json` と **byte 一致**するかを見る。
起案 runner は network も subprocess も clock も使わないので、golden は tree の純粋関数である。

各 case について確かめるのは次のとおりである。

- `--emit profile` の stdout と `--out` が書く bytes が、どちらも golden と一致すること
- 2 回実行して **stdout が byte 一致**すること（Claude/Codex parity）
- `verified` が常に `false` で、envelope が `draft: true` を宣言すること
- provenance の `source` が case.json の宣言どおりであること（`detected` / `default` / `flag` / `derived` / `fixed`）
- **`source: default` の field には必ず対の TODO があり、evidence を主張しないこと**
  （「材料が無くて雛形を置いた」が「読み取った」に化けないこと。この feature の要点）
- **`dispatch_defaults` を起案しないこと**（#180。key も TODO も出さない）。case 固有ではなく
  **全 case で無条件に**見る —— これは repo についての判定ではなく runner についての決定だからである。
  「このリポジトリには `--no-infer` が要る」は tree に書いてある事実ではなく動かした人間が到達した
  結論なので、起案すれば必ず推測になり、推測した `auto_yes: true` は検出した値と見分けがつかない。
  `scope_companions` のような空宣言 + TODO も置かない（決定すべき材料が最初から無いので、
  その TODO はどのリポジトリでも永久に消えない）。新しい case directory を足していないのは、
  足しても同じ1つの決定を2回測ることにしかならないためである
- provenance の evidence が実在する file を指し、**その行番号の行が引用文を実際に含む**こと
- todo code 列・warning code 列が期待と完全一致すること
- `--out` が既存 file を上書きせず `out_exists`（exit 4）で拒否すること
- 起案した profile を `orchestrate.mjs --profile-json` に渡して **plan が通り**、
  そこでも `verified: false` と risk factor `unverified_profile` が保たれること

| case | 何を見るための case か |
|---|---|
| `01-node-npm` | 全部宣言してある node repo で、slug/base/branch/worktree/baseline を全部 evidence つきで読めるか（TODO ゼロ = status success が到達可能か） |
| `02-rust-cargo` | clippy を「証跡があるときだけ」入れるか。CI が2 branch を挙げるとき、選択を `base_ambiguous` として明示するか |
| `03-no-material` | 何も宣言していない repo で例外を投げず、全 field が安全側の雛形 + 明示 TODO になるか。**baseline の placeholder が実際に exit 0 しない**か（fail-closed） |
| `04-python-uv` | `[project.urls]` から slug を、tool table から検査 command を読み、uv 管理下であることを `baseline_env_prefix` として申告するか |
| `05-polyglot` | lockfile 2つ・toolchain 2つの曖昧さを黙って解決せず warning に出すか。branch prefix が `feature` 決め打ちでなく README の `feat/` を読めるか |

引数と失敗系（`profile-init input handling`）も別に見る: 存在しない `--repo-root`（`load_error`）、
未知の `--emit`（`invalid_input`）、slug 形でない `--repo`、token 形でない `--id` が、
それぞれ machine code つきの failure envelope になること。`--repo` / `--id` を渡したときは
推定を上書きし、その事実が provenance に `source: flag` として残ること。

## profile-init `--check`（[#197](https://github.com/Kewton/commandmate-skills/issues/197)）

起案の逆向き —— 既にある profile の `scope_companions` 規則を repo tree に突き合わせるモードは、
`profile-init --check reports what a declaration matches (#197)` が見る。case directory を持たず、
**tree を実行時に組み立てる**: 走査の skip 集合を測るには `node_modules/` の subtree が要り、
このリポジトリはその名前を gitignore しているためである。

- **件数** —— Issue #197 が挙げた実測そのもの。`scripts/{base}.mjs` は `scripts/util.mjs` だけに、
  `scripts/{dir}{base}.mjs` は `scripts/` 配下の `.mjs` 全部に一致する。**どちらも合法**で
  4 文字しか違わないので、`--check` が無ければ plan を回す以外に区別する方法が無かった
- **skip 集合** —— tree 全体に一致する規則（`{dir}{base}.mjs`）が `node_modules/` の 1 件に
  届かないこと。report が skip した directory を名指すこと
- **0 件一致は warning** —— `companion_when_unmatched` / `companion_add_missing` が出て、
  **exit は 0・`errors` は空・`status` は partial** であること。これから作る file を見越した
  宣言はありうるので、**裁定しない**のがこのモードの前提である
- **read-only** —— tree も profile も byte 一致のまま、`artifacts` が空であること。
  2 回実行して stdout が byte 一致すること
- **一致判定が1つであること** —— (a) `--check` が「一致した」と言う file を planner が同じ
  profile で導出すること、(b) `--check` が拒否する宣言を planner も拒否し、**detail 文字列が
  一致する**こと。ローダを2つ持ったら最初に落ちるのがこの 2 本である
- **`--check` は mode である** —— `--out` / `--emit` / `--repo` / `--id` と併用すると
  `invalid_input`（exit 3）で、`--out` の file は作られないこと

## inspect case 一覧（[#217](https://github.com/Kewton/commandmate-skills/issues/217)）

`inspect-cases/<id>/repo/` は、`inspect.mjs --check-references` に突き合わせさせる**小さな
本物のリポジトリ**である。`issues.json` はその tree について何かを主張する Issue 本文で、
harness は「主張と実物のずれ」が期待どおりに出るか（**出ないか**）を見る。

**`found_at` と `measured` は harness が `repo/` の bytes から独立に計算して照合する。**
case.json に期待値として書き写すのではなく、`readFileSync` して数え直す —— そうしないと
case は「runner が自分自身と一致していること」しか測らず、測定が壊れたあとも緑のままになる。
それは本 runner が消しに来た失敗そのものである。

各 case について確かめるのは次のとおりである。

- warning code 列が期待と**完全一致**すること、`errors` が空で `completion_check.passed` が true であること
- **何を見つけても exit は 0** であること（所見は warning であって裁定ではない）
- `references[]` / `line_claims[]` が期待どおりの `verdict` を持つこと
- 走らせたあとの `repo/` が **byte 一致のまま**であること（read-only を信じるのではなく測る）
- 2 回実行して stdout が **byte 一致**すること

| case | 何を見るための case か |
|---|---|
| `i01-file-missing` | 本文が引く `path:line` の file が tree に無い。同じ本文の**実在する**引用は `ok` のまま残る（片方のずれが全体を汚染しない） |
| `i02-line-out-of-range` | 行番号が実測行数を超える。`:N` と `:N-M`（範囲の終端が超える形）の両方 |
| `i03-identifier-moved` | 同じ行の backtick 識別子が `:N` に無い。**`found_at` が実測行と一致する**（harness が file を数え直して照合する） |
| `i04-line-count-stale` | `<path>（N 行）` の N が実測とずれる。`claimed` / `measured` が warning に載る |
| `i05-claim-inconsistent` | 同一 path に 2 つの行数主張が併存する。**stale は出さない** —— どちらが著者の意図かは runner には決められないので、`reference_claim_inconsistent` 1 本に畳んで実測を detail に載せる |
| `i06-all-current` | 本文の主張がすべて実物と一致する。**`status: success`・warning 0 件・exit 0**（この runner が「何も言わない」状態） |
| `i07-ambiguous-and-dropped` | 表記ゆれの pair（`web/src/lib/filter.ts` と `src/lib/filter.ts`）は**どちらも点検しない**（planner の `ambiguous_file_candidate` の担当）。`..` / system root は候補になる前に落ち、`dropped[]` として**名乗る** |
| `i08-citation-two-identifiers` | 同一 `path:line` が 2 つの識別子と結び付いている。両方ともその行に**在る**ので、出るのは不整合 1 本だけである |
| `i09-unchecked-and-absent` | **warning にしない 2 つの verdict。** 照合できる識別子が同じ行に無い citation（`unchecked`）と、識別子が file に 1 度も現れない citation（`identifier_absent`）。後者を「移動した」と呼ぶのは、その語がこの file の識別子だという前提が測れていないまま下す裁定である |
| `i10-no-trailing-newline` | 「N 行」の数え方の固定。**末尾改行の無い最終行も 1 行**として数える（`wc -l` より 1 多い） |

case directory を持たない 3 本が別に在る。

- `inspect input handling` —— 読めない入力は**点検せずに拒否**する。`--repo-root` 不在 /
  fixture が JSON でない / entry に `number` が無い / 要求した Issue が fixture に無いは
  `load_error`（exit 6）、mode 無し / 対象 Issue 無し / 番号が整数でない / 未知 flag は
  `invalid_input`（exit 3）。**どの失敗でも `inspection` は `null`、`warnings` は空**である ——
  「見て何も無かった」と「見られなかった」が同じ形で返ることを許さない。`--out` は既存 file を
  上書きせず `out_exists`（exit 4）で拒否し、書いた bytes は stdout と一致する
- `inspect --ref` —— 本当に動いた tree に対して測る。12 行で commit してから working tree を
  20 行に伸ばし、`--ref <sha>` では `success`（実測 12）・省略時は `partial`（`claimed` 12 /
  `measured` 20）になること。working tree 経路は `git rev-parse HEAD` を envelope に記録し、
  解決できない `--ref` は `load_error` で**拒否**する（working tree に黙って落ちない）
- `inspect does not reach the plan` —— ずれだらけの同じ本文が**従来どおり plan でき**、
  plan に `reference_*` の語彙が 1 つも入らないこと。byte 単位の非回帰は
  `cases/*/expected-plan.json` の golden 側が持つ

## evaluate-gates case 一覧（[#218](https://github.com/Kewton/commandmate-skills/issues/218)）

`inspect-cases/` の case のうち **`case.json` の `mode` が `evaluate-gates`** のものは、
`inspect.mjs --evaluate-gates`（Issue が宣言した受入ゲートを base で先行実行する mode）へ回る。
harness は case の `repo/` を **temp へ複写して `git init` + commit** し、`gate-fake.mjs` を
その checkout に置いてから走らせる —— この mode は `--repo-root` が clean であることを
要求するので、fixture tree（＝このリポジトリの一部）をそのまま渡すことはできない。

**呼び出し回数は fake の log から独立に照合する。** report が「2 回走らせた」と言い、
fake が「2 回呼ばれた」と言うのは別の主張である。log は checkout の外に書かれるので、
「走らせたあとの checkout が byte 一致のまま」という assert と両立する。

各 case について確かめるのは次のとおりである。

- warning code 列が期待と**完全一致**すること、`notice` の件数と、**notice が status を動かさない**こと
- `runs[]` の exit code が**全回・順序どおり**であること（件数でも中央値でも 1 回目でもない）
- gate ごとに `detail` が空でないこと（outcome だけ言って理由を言わない報告を許さない）
- fake の呼び出し回数が期待と一致すること
- 走らせたあとの checkout が **byte 一致**で、`git status --porcelain` が空のままであること

| case | 何を見るための case か |
|---|---|
| `i20-gate-already-satisfied` | `gates:` の command が base で全回 exit 0。**`already_satisfied`（warning）・`status: partial`・exit 0** —— 直しても直らなくても緑になる条件はゲートではない |
| `i21-gate-nondeterministic` | 1 回目 exit 0 / 2 回目 exit 1 の fake。`nondeterministic`（`verdict_flipped`）。**1 回しか走らせない実装・「1 回でも緑なら緑」の実装はここで赤くなる** |
| `i22-gate-failing-at-base` | 全回 非 0。`failing_at_base`・**warning 0 件・`status: success`** —— 期待どおりの状態は所見ではない |
| `i23-gate-id-unresolved` | `require:` の id が `.commandmate/verify.yaml` に無い。`not_evaluable`（`gate_id_unresolved`）の **notice**、`status` は `success` のまま |
| `i24-gate-timeout` | `timeoutSec: 1` を超えて終わらない fake。`not_evaluable`（`timeout`）で、**repeat はそこで打ち切られる**（`runs[]` は 1 件、fake の呼び出しも 1 回） |
| `i25-require-resolved-and-builtin` | `require:` の id を **verify.yaml の command から解決して実行**する（dispatch と同じ `readVerifyConfigGates`）。`work-evidence` は解決できる id だが走らせるコマンドが無いので `gate_id_builtin` —— **解決できることと測れることは別である** |
| `i26-no-declared-block` | 散文の受入条件だけの本文。**gate 0 件・warning 0 件・`declared: none`** —— 散文からコマンドを導出しないことと、「宣言が無い」を「測れなかった」に丸めないこと |
| `i27-block-invalid` | planner が読めないブロック（`command` の無い `gates:` entry）。`not_evaluable`（`block_invalid`）で `declared: invalid` —— 「ブロックが無い」と**別の状態**として残る |

case directory を持たない 2 本が別に在る。

- `evaluate-gates input handling` —— **dirty な `--repo-root` は `invalid_input`（exit 3）で
  拒否し、gate を 1 回も実行しない**（untracked file / tracked file の編集の両方。
  「実行しなかった」は exit code ではなく **fake の log が空であること**で測る）。
  `--base` が HEAD と違えば全 gate が `not_evaluable`（`repo_root_not_base`）で**何も走らず**、
  `--base HEAD` なら通常どおり走る。`--repeat 3` は実行も log も 3 回になり、`--repeat 1` では
  `nondeterministic` に到達できないことを `summary_markdown` が明記する。mode を 2 つ /
  `--ref` と併用 / `--repeat` を `--check-references` と併用 / `--repeat 0` / 非整数 /
  git でない `--repo-root` は `invalid_input`、解決しない `--base` は `load_error`（exit 6）で、
  **どれも `evaluation` は `null`**
- `evaluate-gates does not reach the plan` —— ブロックを持つ同じ本文が**従来どおり plan でき**、
  plan に `already_satisfied` / `failing_at_base` / `nondeterministic` / `not_evaluable` /
  `base_sha` の語彙が 1 つも入らないこと

### 空振り検査の実測（2026-08-20）

**「緑になった」はテストが効いている証拠にならない。** 上の case が本当に何かを測っていることを、
`scripts/inspect.mjs` に **7 通りの変異を 1 箇所ずつ注入して赤くなることで**確かめた
（各回とも注入 → 実行 → 復元。復元後は緑に戻ることも確認した）。最初の 2 つは
[#218](https://github.com/Kewton/commandmate-skills/issues/218) 本文が名指しした変異である。

| 変異 | 赤くなった case と assert |
|---|---|
| `already_satisfied` を「**1 回でも exit 0**」に緩める | i21（`warning codes ["acceptance_gate_already_satisfied"] != ["acceptance_gate_nondeterministic"]`・`gate[0].reason is null, expected "verdict_flipped"`） |
| `--repeat` の既定を **1 に固定**する | i20（`runs exit codes [0] != [0,0]`・`the fake was called {"issue-280-under-100ms":1}`）と i21（`outcome is "already_satisfied"`） |
| clean tree の検査を外す（dirty でも実行する） | `evaluate-gates input handling`（`a dirty --repo-root should exit 3, exited 0`。**fake の log が空でないことで**「実行してしまった」を捕まえる） |
| `timeout` を `failing_at_base` に丸める | i24（`warning codes [] != ["acceptance_gate_not_evaluable"]`・completion check の `runs_recorded` が false） |
| `not_evaluable` の `severity: notice` を落とす | i23 / i24 / i27（`status partial != success`・`0 notice(s), expected 1`） |
| `runs[]` を **1 回目だけ**に丸める | i20 / i21 / i22 / i25（`runs exit codes [0] != [0,0]`・`runs_recorded` が false） |
| `--repeat 1` の注記を出さなくする | `evaluate-gates input handling`（`at --repeat 1 the summary must say which outcome it can no longer reach`） |

## 受入ゲートの `gates:` — 空振り検査の実測（[#125](https://github.com/Kewton/commandmate-skills/issues/125)）

**「緑になった」はテストが効いている証拠にならない**（ADR 第4節）。`gates:`（新規コマンドゲート）で
足した case が本当に何かを測っていることを、**13 通りの変異を注入して赤くなることで確かめた**
（2026-08-15。各変異は repo を temp へ複写して 1 箇所だけ書き換え、suite を回して戻す）。

| 変異 | 赤くなった case |
|---|---|
| dispatch が契約に `verify.gateDefinitions` を書かなくなる | d94 / d95 / d97（golden 不一致・`contract_contains`・`verification.gates`・裁定そのもの） |
| dispatch が **worktree の verify.yaml に定義を追記する**（#1791 が避けた経路） | d94 / d95 / d97。うち `.commandmate/verify.yaml in #320's worktree was rewritten by the run` が名指しで落ちる |
| 定義 id と worktree の既存 id の衝突検査を外す | d96（`acceptance_gate_id_conflict` が出ず、fake の送信時照合が exit 2 を返して worker が failed になる） |
| `contractVerifyGates` の和集合から定義 id を落とす | d97（上流と同じ「定義したのに誰も走らせない」で送信が exit 2） |
| 定義ゲートの `origin` を `issue` にしない | d94 / d95 / d97（`verification.gates[].origin` が `repo` に化ける） |
| planner が 32 件超を**切って**受理する | `84`（#363） |
| planner が予約 id を受理する | `84`（#360） |
| planner が `issue-<番号>-` 接頭辞を要求しなくなる | `84`（#361） |
| planner が command 無しの entry を受理する | `84`（#362）＋ plan schema 違反 |
| **入力側**: Issue 本文の `gates:` から `command:` 行を消す | d94 / d95（planner が open question を立て、dispatch が 1 人も送らない） |
| **入力側**: worktree の verify.yaml に同じ id を先に置く | d94（`acceptance_gate_id_conflict` で送らない ← d96 と同じ停止） |
| **入力側**: ブロックの宣言を 33 件にする | `30`（`acceptance_gate_block_invalid` が立ち、`acceptance_gates` が null になる） |
| merge の段階 C が `require:` だけを declaration と読む | unattended stage C の `gates:`-only case（#354 が `acceptance_gates_required` で止められ、PR が 0 件になる） |

うち 4 件（`impl-truncates-to-32` / `impl-command-optional` / `impl-allows-reserved-id` /
その組み合わせ）は `acceptance-gates-conformance.mjs` も同時に赤くする ——
planner の関数を書き換えると `PRODUCER_LAG` の patch が当たらなくなるためで、
**記法の乖離が黙って増えない**ことの側からも押さえられている。

`--max-turns` 到達の 3 分類（#220。`d110`〜`d116`）についても同じことを実測した
（2026-08-20。各変異は 1 箇所だけ書き換えて suite を回し、戻した）。

| 変異 | 赤くなった case |
|---|---|
| `lib.mjs` の上流エラー署名を**どれにも一致しないもの**に置き換える | d110（`worker_produced_nothing` に化ける）／ d111（同上。`trailing_identical_error_entries` が 13 → 0） |
| hooks の `stop` 比較を反転する（`>=` → `<`） | d115 と d116 の**両方**（互いの code に入れ替わる） |
| 転写した transcript を読まない（`read: false` を即返す） | d111 / d112（`worker_output_unreadable` と、pane 由来の弱い判定に落ちる） |
| `TRANSCRIPT_ERROR_RUN_MIN` を 3 → 99 にする | d111（13 件連続が閾値に届かず `worker_output_unreadable`） |
| ターンを閉じる `closeTurn()` を 1 箇所落とす | d110〜d116 の**全件**（`turn_durations_seconds` の要素数が `turns` と一致しなくなる。件数の不変条件は全 case にかかる） |

## Claude/Codex parity の確認

plan は入力の純粋関数なので、Agent の種類によらず同じ plan が出る。
実機での確認は、対象 Agent に `SKILL.md` を読ませて runner を
`--issue-json cases/<id>/issues.json` で回させ、得た plan.json を
同 case の期待値（`--run-id fixture` を付ければ golden）と diff するだけでよい。

## その他の suite（case ディレクトリを持たないもの）

| suite | 何を見るための suite か |
|---|---|
| **issue fixture の綴り**（#208） | `--issue-json` の `number` を `200` と書いた fixture と `"200"` と書いた fixture が、**同じ run_id・同じ plan bytes** を出すか。#208 は読めない要素を `load_error` へ締めた（refusal は case `78`〜`82`）が、締めた副作用として**受理する綴りが狭まっていない**ことは refusal case では測れない。2形は `gh` が返す形と手書き fixture の形であり、plan-contract 第1.1節はこれを同じ入力だと約束している —— 片方が別の run directory に落ちる実装は、#208 が閉じたのと同じ欠陥（著者が言ったつもりのない差で plan の同一性が変わる）である |
| **run id vs profile**（#157 / #180 / #196 / #195） | profile を1 field だけ変えた2つの plan が**別の run_id になる**か（かつ、その field が本当に plan を動かしているか）。key の並べ替えでは id が割れないこと、同一入力の再実行は同じ id で `run_exists` に落ちること。variants 表の7件目が `dispatch_defaults` で、これは #180 が求めた性質が**追加の実装なしに**付いてきたことの測定である（署名は field を列挙しないので、loader が受理した瞬間に成立する）。並べ替えの assert は**宣言の内側の key 順**についても1件持つ —— 本 field は値が複数 key の object である最初の profile field なので、組み直しを省いた loader は「profile の2行を入れ替えただけ」で run_id を割る。8件目が `integration_baseline`（#195）で、ここでは性質の意味が1段強い —— **書き換えたのは「合格の定義」そのもの**なので、id を共有して既存 run directory を再利用すれば、差し替える前の定義で merge して「検証した」と報告することになる |
| contract parity | runner が叩く `commandmate` の subcommand と flag が `commandmate-cli-contract.json` の範囲内か（実 CLI が在れば実物とも突き合わせる） |
| launcher resolution | `--cli` の多トークン展開・`$CM` へのフォールバック・起動不能な launcher の拒否（#37） |
| worktree-setup input | `--worktree-setup` の二重指定・shell 構文を、世界に触れる前に `invalid_input` で拒否するか（#93） |
| **unattended input**（#122） | `--unattended` と緩和フラグ（`--auto-yes` / `--allow-questions` / `--contract-mode off｜auto`）の併用、および `--wall-clock-budget` 欠落を **exit 3・CLI 呼び出し 0 回**で拒否するか。**`--contract-mode require` を明示した併用は受理される**（この対照が無いと「`--unattended` を常に拒否する実装」でも緑になる）。段階 B の外（`uat.mjs --unattended`）が拒否されることも固定する |
| **unattended exclusivity**（#122） | worktree lock の4規則 —— 生きた所有者は拒否（`--out` も作らず CLI も叩かない）／`kill -9` された所有者（死んだ pid）の lock は回収／別 host の lock は回収せず拒否／完走した run は自分の lock を返す。**`--unattended` を渡さない run は lock をまったく見ない**ことも同じ suite で固定する |
| **unattended merge**（#134。段階 B） | `merge.mjs --create-prs --unattended` の5項目。①**twin の二点測定**: 同じ世界を `--unattended` 有り／無しで2回 `--create-prs --approve` し、`status` / `stop_reason` / `targets` / **実際に作られた PR**（fake の invocation log から読む）／ `blocking_reasons` / `completion_check` / `redactions` が**一致**し、差分は limitation `unattended_mode` の1件**だけ**であること。この世界は scope 外変更を1件持たせてあるので、**昇格しないと裁定した `branch_changed_outside_declared_scope` が両方で limitation のまま**であることも同時に固定する ②**`--unattended` だけでは PR を作らない**（`--approve` を含意しない）③`change_evidence_unavailable` の**二点測定**: フラグ無しは limitation で続行して PR を2つ作り、`--unattended` は blocking になり **PR も push も0回**で `partial` / `pr_create_failed` に落ち、作らない PR の本文も書かない ④`--merge-prs --unattended` は **exit 3**（段階 C 未実装）⑤緩和フラグとの併用も **exit 3・CLI 呼び出し 0 回**。merge-case ではなく suite なのは、①③が**2つの run の比較**であり、独立した case 同士では report を突き合わせられないためである |

## 実機評価の記録

Agent を実際に動かした評価は、実施のたびに次の表へ追記する。

| 日付 | Agent / version | case | run_tests | rubric 合計 | 備考 |
|---|---|---|---|---|---|
| — | 未実施 | — | — | — | — |

**この version（0.10.0）の時点で、実機評価は未実施である。**
実施済みなのは `run_tests.mjs`（14 plan case + 20 dispatch case + 15 merge case + 17 uat case が緑）だけ
である。dispatch の実機確認（2 Issue / 2 並列の dispatch→`send --contract`→`wait --verify`）、PR 作成→
CI 確認→merge の実機確認（2 Issue）、UAT 不合格→fix worktree→修正→再検証→再merge の実機確認は live
環境で別途行う。契約 yaml が CommandMate の実パーサ（`src/lib/tasks/contract-parser.ts`）を通ることは
0.9.0 の実装時に手元で確認済みだが（scope あり/なし・`verify.gates` あり/なし・`autoYes` off/safe の
4 形）、この harness は Node stdlib のみなので YAML パースは行わず、閉じたキー集合・必須キー・
`verify.gates: []` の不在という構造条件のみを検査する。
`commandmate.skill.yaml` の `compatibility.agents` が `claude` と `codex` を
`native` と宣言しているのは SKILL.md の discovery 経路と runner の決定性についてであり、
品質評価の結果ではない。
