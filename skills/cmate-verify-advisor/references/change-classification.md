# 変更の分類（非対称ルールの正本）

`.commandmate/verify.yaml` への変更は「**強める**」か「**弱める**」のどちらかに分類される。
この表がその正本であり、`scripts/verify-advisor.mjs` の `classifyChange()` はこの表を
実装したものである。

## 分類表

| 変更 | 方向 | 理由 |
|---|---|---|
| ゲート追加 | 強める | 検証されていなかった性質が検証されるようになる |
| ゲート削除 | **弱める** | 検証されていた性質が検証されなくなる |
| `timeoutSec` の短縮 | 強める | 固まったゲートが早く報告される（検出までの時間が縮む） |
| `timeoutSec` の増加 | **弱める** | 固まったゲートを待つ時間が伸びる |
| ゲートの並べ替え | 強める | 集合は変わらず、失敗が読めるまでの時間だけが縮む |
| `options.maxLogTailBytes` の増加 | 強める | 失敗の原因がログに残る |
| `options.maxLogTailBytes` の減少 | **弱める** | 失敗の原因がログから消える |
| `options.skipInPrimaryCheckout` を `true` へ | **弱める** | 実行されるゲートが減る |
| `options.skipInPrimaryCheckout` を `false` へ | 強める | 実行されるゲートが増える |
| `options.baseRef` の変更 | **弱める** | 「何が変更か」の基準が動く。履歴からは強化と示せない |
| 上記以外 | **弱める** | 認識できない変更は fail closed |

## 「timeout の増加は弱める」について

Issue の設計文は「timeout **大幅**増」を弱体化としている。実装は**あらゆる増加**を
弱体化として扱う。「大幅」の閾値を実装が決めると、その閾値のすぐ下の増加が
無審査で通る道になるためである。増加が正しい場合（ゲートの仕事が本当に増えた場合）は
提案として出るので、reviewer が読んで merge すればよい。

反対方向の非対称も意図的である。timeout の短縮は「強める」なので `--apply` の対象だが、
**実測最大値と 30 秒**という 2 つの下限で守ってある（SKILL.md の該当節を参照）。

## 適用の可否

`--apply` が書き込むのは次の 3 条件をすべて満たす提案だけである。

1. `layer === 1`（履歴の数値だけから決まる機械的調整である）
2. `direction === 'strengthen'`
3. `kind` が層 1 の 3 種（`set-timeout` / `set-option` / `reorder-gates`）のいずれかである

**層 2 の提案は、強化方向であっても適用されない。** すり抜けを塞ぐゲート追加は
まさに強化だが、それが本当に塞ぐのかは履歴の数値では決まらない。人間がレビューして
merge するところまでが手順である。

## 三重の門

同じ規則を 3 か所で守っている。1 か所が壊れたときに黙って通ってしまわないためである。

1. `classifyChange()` — 方向を `(key, 変更前, 変更後)` から導出する。提案者の自己申告を
   信用しない
2. `isApplicable()` — 上の 3 条件を満たすかを判定する
3. `assertNoWeakening()` — **書き込む直前に、書こうとしているバイト列を再パースして
   元のファイルと比較する**。ゲートが減っていないか、`timeoutSec` が伸びていないか、
   `maxLogTailBytes` が縮んでいないか、`baseRef` / `skipInPrimaryCheckout` が動いていないか。
   1 つでも該当すれば内部ガードとして exit 2 で停止する

3 番目は 1・2 の記録を一切参照しない。提案の帳簿が嘘をついても、ファイル同士の比較は
嘘をつけない。`tests/fixtures/cmate-verify-advisor/run_tests.sh --mutants` の
`apply-weakening` / `apply-weakening-without-guard` は、この二重化が実際に効いていることを
（1 だけ壊す / 1 と 3 を壊す、の 2 通りで）確かめる変異である。

## 層 2 の提案 JSON

```json
{
  "proposals": [
    {
      "kind": "add-gate",
      "gate": { "id": "migration-check", "command": "npm run check:migrations", "timeoutSec": 300 },
      "position": "after:typecheck",
      "rationale": "なぜこのゲートが要るのか",
      "evidence": [{ "runId": 103, "at": "2026-07-12T09:00:00.000Z", "gateId": "unit", "fact": "status=failed exit=1" }]
    }
  ]
}
```

`kind` は `add-gate` / `remove-gate` / `set-timeout` / `set-option` の 4 つ。
`reorder-gates` は層 1 の計算結果なので層 2 からは受け付けない。

`rationale` と `evidence`（`runId` を持つ要素が 1 つ以上）は**必須**である。
どちらかが無い提案は exit 2 で拒否する。レビューできない提案は提案ではない。

`command` は verify.yaml のサブセットで表現できる 1 行スカラーでなければならない。
制御文字を含むもの、`"` と `'` の両方を含むものは拒否する（`cmate-verify` のランナーが
読めない設定を書くと、次の検証が exit 2 になる）。
