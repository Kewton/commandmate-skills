# Security Policy

本リポジトリは CommandMate が **唯一の公式 Skill 供給元** として扱う。
ここに置かれた package は、review を経て利用者の worktree
（`.agents/skills/<skill-id>/`）へ配備される。したがって本リポジトリの
security 上の役割は「安全な Skill を書くこと」ではなく、
**「review を通っていない byte 列が公式 artifact として出て行かないこと」** を保証することである。

## 脆弱性の報告

**public issue を立てないこと。**

GitHub の [Security Advisories](https://github.com/Kewton/commandmate-skills/security/advisories/new)
から非公開で報告する。以下を含めてほしい。

- 影響する skill-id と version（または pipeline の該当箇所）
- 再現手順、または悪意ある package が検証を通過することを示す最小の成果物
- 想定される影響（利用者の worktree で何が起きうるか）

artifact 自体に secret が含まれている疑いがある場合は、
**その値を報告本文へ貼らないこと**。asset 名と該当 file path のみを書く。

初回応答の目安は 5 営業日以内。

## この repository が保証すること / しないこと

### 保証する

- **供給元の同一性**: Catalog の各 version は 40桁の resolved commit SHA を持ち、
  その commit の内容から再現可能に build された artifact の SHA-256 を持つ。
  tag は人向けの表示にすぎず、信頼の根拠にしない。
- **完全一致**: Catalog → artifact → manifest → payload file の digest が
  一つでも食い違えば install は失敗する。CI は同じ照合を release 前に行う。
- **宣言と実体の一致**: `commandmate.skill.yaml` の `files` は archive 内の
  payload file 集合と完全一致する。未宣言 file、未宣言 script、
  未宣言の実行bitはいずれも拒否される。
- **再現性**: 同じ commit から build すれば誰でも同じ artifact byte 列を得る。
  第三者が digest を独立に再計算できる（[verification runbook](./docs/runbooks/verify-artifact.md)）。
- **payload の形**: regular file と directory のみ。symlink / hardlink /
  device / FIFO / socket / setuid / setgid / sticky は build 時にも検査時にも拒否する。

### 保証しない（誤解しないこと）

- **`declared_permissions` は enforcement ではない**。publisher の申告であり、
  sandbox でも認可でもない。CommandMate は申告を表示し、
  検査結果から独立に `computed_risk` を算出し、高い方を実効 risk として扱う。
- **"official" は安全性の絶対値ではない**。「検証済みの供給元から来た」という意味であり、
  「何をしても安全」という意味ではない。
- **署名 / PKI / transparency log は本 phase に存在しない**。
  署名の代わりに、誰でも辿れる checksum の連鎖を公開している。
  署名は Phase 6 の ADR 後に検討する。
- **SKILL.md 本文の prompt injection 無害化は範囲外**。
  Skill は Agent への指示文であり、その内容の安全性は Runtime 側の課題である
  （CommandMate #1250）。本リポジトリは「install 前に risk・permission・script を
  提示できる形で配布すること」までを担う。

## 署名がない状態でどう信頼を担保するか

署名鍵を持たない代わりに、**再現可能 build と公開 checksum** を使う。

```
Catalog versions[].source.commit   ← 40桁 resolved SHA（tagを信頼しない）
        ↓ この commit から build すると
Catalog versions[].artifact.sha256 ← 誰が build しても同じ値になる
        ↓ その byte 列の中の
commandmate.skill.yaml             ← files[] が payload と完全一致
        ↓ 各 file の
sha256                             ← 個別 payload file の digest
```

第三者は artifact を download し、`scripts/verify_artifact.py` で
この連鎖全体を検証できる。さらに、同じ commit を checkout して
`scripts/build_release.py` を実行すれば、公開されている digest と
一致する artifact を自分の手元で再生成できる。
**digest が一致しない artifact は、鍵がなくても偽物と断定できる。**

これは署名の代替として完全ではない（配布経路そのものの改竄には
GitHub の release 保護に依存する）。この限界を承知の上での phase 判断である。

## release 権限

- 既定の `GITHUB_TOKEN` 権限は `contents: read`。
- 書き込みが必要なのは `release.yml` の `publish` job のみで、
  `contents: write` に限定し、`release` environment の承認 gate を通す。
- untrusted な pull request（fork 由来）は build job しか動かせず、
  secret にも write 権限にも触れられない。
- 詳細な設定要件は [docs/design/release-pipeline.md](./docs/design/release-pipeline.md) を参照。

## 依存関係について

pipeline は **Python 標準ライブラリのみ** で書かれている。
CI に package install 手順がないため、registry の障害や汚染が
「公式 artifact に何が入るか」を左右できない。
この制約は意図的なものであり、便利さのために外部依存を追加しないこと。
