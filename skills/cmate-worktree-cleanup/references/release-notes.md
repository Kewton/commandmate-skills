# release notes

版の見出しはリリース時に付ける。ここには「何が起きたか → だからこう変えた」を残す。

## BEHIND を経た squash merge と、判定を実行する runner（CommandMate#3010）

**何が起きたか。** 保護された `main` では 2 本目以降の PR が BEHIND になり、ワーカーが
`git merge origin/main` してから squash merge される。この形の branch は、正味の差分が squash の
commit と一致していても、merge 前の個々の commit が squash の patch と一致しないので
`git cherry` に必ず `+` が出る。条件4は `+` が 1 行でもあれば `tree_mismatch` としていたため、
Kewton/Musunest の worktree `Musunest-issue-179`・`-181`・`-248` が「消せない」と判定されて残った。
さらに判定を実行する runner が同梱されておらず、利用側が点検スクリプトを書いた。そのスクリプトは
`git cherry` の判定を入れ忘れ、1 本を規則に反して消した（差分は一致していたので失われた作業は無い）。

**だからこう変えた。**

- 条件4の判定を「`mb..tip` と `<merge>^..<merge>` の diff を固定の flag
  （`--no-ext-diff --no-textconv --no-color --binary --full-index --no-renames`）で出し、バイト単位で
  比べる」に定めた。`git cherry` の `+` は単独の否決理由にせず、evidence（`cherry_unmatched`）として
  記録する。`tree_mismatch` は diff の不一致だけを表す。条件1〜3（exact な merged PR・head OID の
  一致・merge commit の到達可能性）は変えていない。
- どちらの経路で証明したかを `equivalence_path`（`patch_equivalent` / `net_diff_equal`）に残す。
  plan の `proof` と result の `removed[].evidence` の任意 field で、schema は v1 のまま（required にしない）。
- 判定と削除を実行する runner `scripts/cleanup.mjs`（本体は `scripts/lib.mjs`）を同梱した。dry-run が
  既定で、削除は `--apply --confirm` のときだけ。削除直前に drift を再検査し、`--force` と `-D` は使わない。
  利用側が点検スクリプトを書く必要をなくし、判定の取りこぼしを runner の側で塞ぐ。
- `tests/fixtures/cmate-worktree-cleanup/run_tests.sh` を新設し、本物の git リポジトリで direct /
  squash / BEHIND→merge→squash / 差分不一致 / dirty / squash 後に tip が進んだ形を dry-run と apply で
  確かめる。`NET_DIFF_SUFFICIENT` を外すと BEHIND の case が落ちることを変異注入で確かめる。
  `.commandmate/verify.yaml`（`worktree-cleanup-fixtures`）と `.github/workflows/validate.yml` の両方に配線した。
