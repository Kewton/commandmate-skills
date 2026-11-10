# changelog

## 0.1.0 — 最初の版（CommandMate#4228）

- 目的（次のセッションが環境から読み直せないもの＝意図・次の一手・人への質問・決定・罠を取り戻す）と
  書かないもの（正本から導けるもの）を本文の先頭に置いた。書く中身を kind の列挙以外の規則で狭めない
- 入口の判定は `commandmate mem mode --json` が exit 0 かつ `"mode": "on"` のときだけ「使う」。
  `off`・`derived`・未登録・曖昧・サーバ停止・`mem` を持たない古い CLI はすべて「使わない」で、正常として扱う
- 形の要件（kind・`close_when`・evidence・key）、decision の引用と promote の頼み方、
  無人のときの扱い（人への質問は `next`＋`--close-when manual`＋`--evidence`。新しい kind は作らない）、
  brief からの再開、区切りでの `mem check --suggest --quiet`、他の Skill との分担、止まるとき
- 同梱の script は無い。CLI を 1 行ずつ呼ぶだけである
- `compatibility.commandmate` の下限は、mem を含む最初の CommandMate のリリースの版に合わせる（未リリースの間は次の minor を置いている）
