# 出力 code の一覧と、停止からの復帰

この文書は [SKILL.md](../SKILL.md) 第4節・第5節から**そのまま移送した**一覧である。
**削っていない。** 移送の理由は [runner-operations.md](./runner-operations.md) の冒頭と同じ
（[#135](https://github.com/Kewton/commandmate-skills/issues/135)）。

SKILL.md 側には「読み方」（status と exit の写像、まず `status.mjs` を読むこと、そして
**止まったら押し通さず読む**という規律）が残っている。ここに在るのは、そこから引く
**全一覧**である —— plan の失敗 code、plan の warning code、limitation code、そして
**停止したときの対処表の正本**と、無人 run の取り消し手順。

`status.mjs --run <run-dir>` は第4節の対処表を機械的に引いて表示する。表がその正本であり、
status runner はそれを引くだけなので、**ここに無い code は status runner も推測しない。**

| SKILL.md での位置 | ここでの節 |
|---|---|
| 第4節 plan の失敗 code と exit | 第1節 |
| 第4節 plan の warning code | 第2節 |
| 第4節 limitation code | 第3節 |
| 第5節 停止したとき、人間が何をするか（対処表） | 第4節 |
| 第5節 無人 run を取り消す | 第5節 |

---


## 1. plan の失敗 code と exit

| 状況 | code | exit |
|---|---|---|
| Issue 番号が無い / 引数不正 / max-parallel 範囲外 | `invalid_input` | 3 |
| mutating phase 指定（実行は dispatch runner の担当） | `not_implemented` | 2 |
| unverified profile（`--allow-unverified` 無し） | `unverified_profile` | 3 |
| Issue / profile / fixture が読めない | `load_error` | 6 |
| 依存 cycle / 不完全 override / 順序違反 | `cycle_detected` / `override_incomplete` / `dependency_order_violation` | 5 |
| run directory が既存 | `run_exists` | 4 |

失敗時も stdout に `status: failure` の result を出す。**plan を推測で埋めない。**


## 2. plan の warning code（1件でも出れば `partial`）

| code | 意味 |
|---|---|
| `profile_repository_mismatch` | 既定 profile の対象リポジトリが cwd の `origin` と一致しない |
| `profile_repository_override` | `--repo` でリポジトリを差し替えたため profile の検証が対象を失った |
| `external_dependency` | この plan に含まれない Issue への依存を宣言している |
| `ambiguous_dependency_direction` | 1行に順方向と逆方向の方向語が同居し、依存の向きを一意に読めない |
| `no_acceptance_criteria` | 受入条件を1件も読み取れない。何をもって完了かが宣言されていない |
| `no_suspected_files` | 対象 file を1件も読み取れない。worker に与える scope が空になる |
| `unrecognized_file_extension` | 既知拡張子外の backtick path が抽出から落ちた |
| `shadowed_file_candidate` | 他候補の path 境界つき suffix だったため候補から落とした |

`no_acceptance_criteria` / `no_suspected_files` は dispatch の open question ゲートと対になる。
**この2つを放置したまま `--allow-questions` で押し通さないこと。**


## 3. limitation code（停止はしていないが、後から効いてくる制約）

| code | runner | 意味 |
|---|---|---|
| `contract_unsupported` | dispatch | CLI が実行契約に非対応で、より弱い baseline 裁定に落ちた |
| `contract_disabled` | dispatch | `--contract-mode off` を明示したため probe していない |
| `contract_scope_unknown` | dispatch | 対象 file が空の Issue を dispatch しなかった（その wave は advance しない） |
| `open_questions_accepted` | dispatch | `--allow-questions` で未回答 question を引き受けた |
| `auto_yes_used` | dispatch | `--auto-yes` で prompt を自動応答した |
| `parallelism_truncated` | dispatch | wave が `max_parallel` より広かったので上限で切った |
| `unsafe_worktree_target` | dispatch | worktree path が path-escape guard に弾かれた |
| `worktree_sync_ran` | dispatch | `ls` で解決できず `commandmate sync` を1度実行して `ls` を読み直した（解決した branch / なお未解決の branch を detail に列挙） |
| `worktree_sync_unavailable` | dispatch | `commandmate sync` が失敗した（0.21.0 未満には subcommand が無い）。**この失敗自体では停止しない**が、server 未登録の worktree は登録し直せていない |
| `worktree_setup_ran` | dispatch | `--prepare-worktrees` で `cmate-worktree-setup` provider を1回呼んだ（対象 Issue・status・phase を detail に記録） |
| `worktree_prepared` | dispatch | provider が worktree を作成/再利用した。**Issue ごとに1件**（branch・base SHA・baseline 合否を detail に記録） |
| `worktree_setup_partial` | dispatch | 要求したうち一部しか作られなかった。作れた分は**消さずに保持**し、未解決 Issue については停止する |
| `worktree_setup_skipped` | dispatch | `--prepare-worktrees` を指定したが、pre-flight が別の drift で先に止まったため provider を呼んでいない |
| `worktree_sync_rescanned` | dispatch | 準備段のため `commandmate sync` を2回実行した（解決時の1回＋作成後の強制1回） |
| `worker_method_declared` | dispatch | `--worker-method <id>` 付きの run である。**run 全体で1件。** 停止した run にも残る（何を前提にした run だったかが読めるように） |
| `worker_method_applied` | dispatch | その Issue の worktree に skill が在り、task text に `## Method` 節を書いた。**Issue ごとに1件。** 「適用された」であって「守られた」ではない |
| `unattended_mode` | dispatch | `--unattended` 付きの run である。**run 全体で1件。** 停止した run にも残る。含意した締め付け（contract require / pre-flight の scope 検査 / wall-clock budget / worktree lock）と拒否する緩和フラグを detail に記録する |
| `unattended_baseline` | dispatch | その Issue の worktree が dispatch 開始時どこに居たか（**branch 名と短縮 SHA**。絶対 path は書かない）。**Issue ごとに1件。** 取り消しの起点であり、**担保するのは worktree branch の1段だけ**である（本書第5節） |
| `verification_unrecorded` | dispatch | completed した worker に裁定が1つも記録されなかった（runner 側の欠陥。`verification_recorded` completion check も落ちる） |
| `verification_gates_unrecorded` | dispatch | verification は pass だが `GATE` 行を読めず、pass の根拠となった gate を report が名指しできない |
| `drift_<check>` | dispatch | 非 blocking な drift（`integration_clean` / `worktrees_present`）を記録して続行した |
| `issue_autoclose_not_default_branch` | merge | base がデフォルトブランチでないため `Resolves #n` が効かない。**merge 後に手動クローズが要る** |
| `unsafe_branch` | merge | branch 名が safe-ref guard に弾かれた |
| `change_evidence_unavailable` | merge | branch の実変更 file を読めなかった（worktree 不在など）。PR 本文もそう書く。**scope 内に収まっていた証拠ではない** |
| `branch_changed_outside_declared_scope` | merge | 実変更に宣言 scope（`scope.allow`）外の file がある。PR 本文が違反 path を名指しする |
| `acceptance_not_run` | uat | 意味ゲートが verdict を出せず、baseline のみで裁定した |
| `no_eligible_issues` | merge / uat | dispatch report に completed かつ verification pass の Issue が無い |
| `completion_check_failed` | dispatch / merge / uat | completion check のどれかが passed でない |

`conditional_go` の保持（`acceptance_conditional`）と fix 上限到達（`max_attempts_reached`）は
limitation ではなく **stop_reason / blocking reason** である。**停止であって、続行しながらの
注記ではない。**


## 4. 停止したとき、人間が何をするか（対処表の正本）

**runner が止まったら、それは「押し通す」合図ではなく「読む」合図である。**
`blocking_reasons` の code と `summary_markdown` を読み、次の対応を取る。

`status.mjs --run <run-dir>`（[SKILL.md](../SKILL.md) 第3.6節）は**この表を機械的に引いた結果**を、どの Issue の話かを
添えて出す。JSON を自分で突き合わせる前に、まずこれを読めばよい。表がこの節の正本であり、
status runner はそれを引くだけなので、**ここに無い code は status runner も推測しない**
（「detail と `summary_markdown` を読む」に落ちる）。

| 止まり方 | 何が起きたか | 人間がすること |
|---|---|---|
| plan `status: partial` + `no_acceptance_criteria` / `no_suspected_files` | Issue に受入条件か対象 file が書かれていない | **Issue 本文に書き足して re-plan する。** run_id は本文を含む hash なので自動的に別 run になる |
| plan `cycle_detected` / `override_incomplete` / `dependency_order_violation` | 依存グラフが実行不能 | `dependency-plan.md` の edge `reason`（どの方向語をどの行から読んだか）を見て、Issue 本文か `--depends` を直す |
| plan `run_exists` | 入力が完全に同一の再実行 | 本文を直すか、`--run-id <new-id>` / `--runs-dir <dir>` を渡す |
| plan `profile_repository_mismatch` | cwd の origin と profile の対象リポジトリが違う | `--profile` / `--profile-json` / `--repo` のどれかを渡して意図を明示する |
| dispatch `open_questions` + `human_required` | 未回答の question を持つ Issue がある | blocking reason に**質問の本文**が出ている。Issue 本文に回答を書いて re-plan する |
| dispatch `drift` | plan 承認後に branch / HEAD / 権限が動いた | drift の内容を確認し、必要なら re-plan する。**drift の上に dispatch しない** |
| dispatch `worktree_unresolved`（`stop_reason: drift`） | 対象 Issue の worktree が `commandmate ls` で解決できない（runner は `commandmate sync` を1度試したうえでの結論。`limitations` の `worktree_sync_ran` / `worktree_sync_unavailable` を見る）。**worker は1人も起動していない**（`task_id: null`・worker ログ無し） | **`cmate-worktree-setup` で worktree を作成し、同じコマンドで再実行する**（最初の Wave 前で止まった場合、`--out` は消費されていない）。plan と同じ profile（同じ `branch_template`）を使う。**Issue の分割や re-plan は不要** |
| dispatch `worktree_setup_unavailable`（`stop_reason: dispatch_error`） | `--prepare-worktrees` を指定したのに `cmate-worktree-setup` を呼べなかった（未 install / `--worktree-setup` 未指定 / launcher が起動不能） | **`cmate-worktree-setup` を install し、`--worktree-setup <launcher>` でその呼び出し口を渡して再実行する。** 準備段を使わないなら `--prepare-worktrees` を外し、従来どおり worktree を用意してから dispatch する |
| dispatch `worktree_setup_failed`（同上） | provider は動いたが result contract を返さなかった、または1件も作らなかった | provider の出力（blocking reason）を読んで原因を直し、同じコマンドで再実行する。**作成済みの worktree は削除していない**ので、再実行の対象は残りの Issue だけになる |
| dispatch `worktree_profile_mismatch`（同上） | provider が作った branch が plan の branch と違う（**profile の不一致**） | plan と `cmate-worktree-setup` に**同じ profile（同じ `branch_template`）**を渡す。既に作られた branch を使いたいなら、その branch を作る profile で plan を作り直す |
| dispatch `worker_method_unavailable`（`stop_reason: dispatch_error`） | `--worker-method <id>` を指定したのに、その Skill が対象 worktree に無い（`.claude/skills/<id>/SKILL.md` と `.agents/skills/<id>/SKILL.md` の**両方**が要る。detail が「無い」のか「片側だけ在る」のかを名指しする）。**worker は1人も起動していない** | **`commandmate skill install <skill-id>` で対象 worktree に入れ、同じコマンドをそのまま再実行する**（最初の Wave 前で止まった場合、`--out` は消費されていない）。方法論なしで走らせてよいと判断したなら `--worker-method` を外す。**Issue の分割や re-plan は不要** |
| dispatch exit 10（prompt 検出） | worker が人間の判断を求めている | `capture` の内容が report に出ている。**自分で判断して答える。** runner は自動応答しない |
| dispatch `verification_not_judged`（exit 99） | run が error / cancelled で**誰も判定していない** | **再 dispatch では解けない。** CommandMate 側のログを見る。判定していないものを worker に直させない |
| dispatch `worker_failed`（`--max-turns` 到達で未 commit） | worker が起動したが commit まで到達しなかった（worktree 未解決はこの code に落ちない。上の行） | prompt / worker ログを読む。指示が過大なら Issue を分割して re-plan する |
| dispatch `verification_failed` / `worker_failed` / `timeout` で **一部の Issue だけ**落ちた | pass 済みの Issue と落ちた Issue が同じ run に混ざっている | 落ちた分を直したうえで **`dispatch.mjs --plan <plan.json> --resume <その run の dispatch ディレクトリ>`**。pass 済みは再 dispatch されず記録だけ引き継がれる（[SKILL.md](../SKILL.md) 第3.2節）。**re-plan は不要** |
| dispatch `resume_plan_mismatch`（`stop_reason: dispatch_error`） | `--resume` 先の report が**別 plan**のものだった（`run_id` / repository / base 不一致） | その plan 自身の dispatch ディレクトリを `--resume` に渡す。新規に走らせるなら `--out` で始める。**何も dispatch していないので、直して同じコマンドを再実行してよい** |
| dispatch `resume_invalid`（同上） | `--resume` 先の report が `dispatch-report.v1` として読めない（schema version 違い / JSON 破損） | detail が「何がどう合わないか」を名指ししている。報告どおりの report を指すか、`--out` で新規 run にする。**壊れた report を半分だけ信じて引き継がない** |
| dispatch `resume_no_work`（`status: success`） | 再実行対象が1件も無い（全 Issue が completed かつ pass） | 停止ではない。その attempt の report をそのまま merge / uat に渡す |
| dispatch `contract_unsupported` + `require` | CLI が実行契約に非対応 | CommandMate を 0.17.0 以上に上げるか、弱い裁定を承知のうえで `auto` に落とす。**`--unattended` の run では `auto` は選べない**（`require` を含意する。落とすなら `--unattended` を外して人間が読む運転に戻す） |
| dispatch `contract_scope_unknown`（`stop_reason: dispatch_error`。**`--unattended` のとき**） | 対象 file を1件も宣言していない Issue が plan に在る。**1人も dispatch していない**（`--out` も未作成） | **Issue 本文に対象ファイルを書いて re-plan する。** フラグ無しの run では同じ Issue が wave の中で1人ずつ拒否される（そのときは他 Issue の worker が既に走っている）。無人ではその始末をする読み手が居ないので、pre-flight で全 Issue を検査している |
| dispatch `unattended_locked`（同上） | 同じ worktree を**別の dispatch run が動かしている**（`--out` も未作成・`human_required: false`） | **先行 run の終了を待って、同じコマンドをそのまま再実行する。** lock が残り続けるなら所有 run の pid が生きているかを確認する（`kill -9` された run の lock は次の run が自動で回収する）。lock は `$CMATE_ORCHESTRATE_LOCK_DIR`（既定 `$TMPDIR/cmate-orchestrate-locks/`）に置かれる |
| dispatch `wall_clock_budget_exhausted`（`stop_reason: timeout` / `partial`） | `--wall-clock-budget` に到達して打ち切った。**成功ではない** | 何に時間を使ったかを確認する（**profile baseline と acceptance コマンドは自前の timeout を持たない**ので、まずそこを疑う）。原因を潰すか budget を実測に合わせてから **`--resume` で再開する**。**打ち切りを success に丸めない** |
| merge `ci_failed` / `ci_pending` | CI が green でない | CI を直す。**green 無しに merge しない** |
| merge `pr_missing` / `merge_failed` | PR が無い / conflict | PR の状態を確認し、conflict は手で解消する |
| merge `issue_autoclose_not_default_branch` | base がデフォルトブランチでない | merge 後に **Issue を手動でクローズする** |
| uat `acceptance_conditional` | 受入判定が `conditional_go` | **条件を読んで人間が判断する。** 自動修正の対象ではない |
| uat `blocked` / `max_attempts_reached` | 上限まで直しても不合格 | `unresolved_issues` と `next_actions` を読む。**success に丸めない** |
| uat `acceptance_not_run` | 意味ゲートを掛けずに baseline だけで裁定した | cmate-acceptance-test を入れて result を用意し、必要なら `--require-acceptance` で必須にする |


## 5. 無人 run を取り消す（`unattended_baseline` の読み方）

`--unattended` の run は、dispatch した worktree ごとに開始時の HEAD を
`limitations` の `unattended_baseline` に **branch 名と短縮 SHA** で残す。取り消しはそれを起点に、
**上流から順に**行う。

1. `git reset --hard <sha>`（worktree が残っている場合）。
2. worktree が既に片付いていれば **`git branch -f <branch> <sha>`**。
   `git reset` は exit 128 で使えない。**baseline を branch 名で書いてあるのはこのためで、
   絶対 path では手が届かない。**

**この起点が担保するのは worktree branch の1段だけである。** 次の4つでは足りない
（[#115](https://github.com/Kewton/commandmate-skills/issues/115) の実測）:

1. **untracked file は `git reset --hard` で戻らない**（`.commandmate/tasks/*.yaml` を含む）。
   完全に戻すには `git clean -fdx` が要るが、それは worker の成果物も消す ——
   **無人で機械にやらせる操作ではない。**
2. **既に merge / push されていたら戻らない。** 下流から先に取り消す（PR を close し、
   remote branch を消し、必要なら revert PR を立てる）。**force push で歴史を消さない。**
3. **worktree が片付いていると `git reset` は使えない**（上の 2）。
4. **branch も消えて `git gc --prune=now` が走ると object ごと消える。** baseline が base branch から
   到達可能なら生き残るので、危ないのは **baseline が base から到達できないとき** ——
   `--prepare-worktrees` が既存 worktree を再利用した場合や、前の run の commit の上に
   baseline が乗っている場合である。

**取り消せるのはリポジトリの状態であって、送られた通知ではない。** push は対象リポジトリの CI を
起動し（実行時間・課金・通知）、PR 作成は reviewer に通知を出す。

`worktree_setup_unavailable` / `worktree_setup_failed` / `worktree_profile_mismatch` と
`resume_attempt` / `resume_no_work` / `resume_invalid` / `resume_plan_mismatch` は、
この表には在るが **status runner の hint map にはまだ無い**（`status.mjs` は別 Issue で追随する）。
それまで `status.mjs --run` はこれらを「detail と `summary_markdown` を読む」に落として表示する。
**推測で別の対処を出さない**のが status runner の約束なので、これは劣化ではなく既定の振る舞いである。
dispatch report の `summary_markdown` には上表と同じ next action が出ている。
