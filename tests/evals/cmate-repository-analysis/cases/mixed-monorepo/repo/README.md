# atlas

api と web の2 package を持つ monorepo。`vendor/` と `build/` は生成物である。

| package | 役割 |
|---|---|
| `packages/api` | HTTP API |
| `packages/web` | 管理画面 |

検証は `make verify` にまとまっている。
