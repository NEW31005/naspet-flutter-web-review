# 公開Web Labの課金保護

`ai-buddy-lab` Edge Function は、愛言葉を知る利用者が誤操作しても、1回の中継要求が無制限に大きくならないように境界を設けています。IPアドレス、端末識別子、愛言葉、APIキーは保存しません。

## 各リクエストで必ず強制する上限

| 項目 | 上限 |
| --- | ---: |
| HTTP本文 | 192 KiB |
| systemプロンプト | 24,000文字 |
| userプロンプト | 48,000文字 |
| 評価出力 | 1,200 tokens |
| 発言出力 | 400 tokens |
| reasoning effort | `low` 固定 |
| OpenRouter待機 | 90秒 |

モデルはコード上の許可リストにあるものだけを利用できます。ブラウザから上限を超える `maxTokens` や `effort` を送っても、Edge側で縮小します。

## ベストエフォートの急増防止

- 同一Edge isolate内で、OpenRouterへの同時実行は既定8件までです。Pack Testの裁判で8バディを並列評価しても、正常な要求を落とさない値です。
- 同一Edge isolate内で、30分あたり既定320件までです。
- 超過時はOpenRouterへ転送せず、`429`、`Retry-After`、`X-AIBW-Budget-Remaining`を返します。
- 失敗したOpenRouter要求も、再試行連打を防ぐため呼び出し件数に含めます。

必要な場合はSupabaseの環境変数で次を狭められます。

| 環境変数 | 意味 | 許容範囲 |
| --- | --- | ---: |
| `AI_BUDDY_LAB_MAX_CONCURRENT` | isolate内の同時実行数 | 1〜16 |
| `AI_BUDDY_LAB_MAX_CALLS_PER_WINDOW` | isolate内の30分上限 | 1〜1,000 |

Edge Functionは複数isolateで動作し、コールドスタート時にメモリが初期化されます。そのため、この2つは全世界・全試合をまたぐ強い課金上限ではありません。IP等を永続化しない現在の構成で、信頼できる「1試合N回まで」を保証することもできません。

強い上限が必要になった場合は、ブラウザからランダムな試合IDを送り、Edgeが発行した短寿命署名と、Supabase DB等の原子的な回数カウンターを組み合わせます。単にブラウザ自己申告の回数だけを信頼してはいけません。

## 異常時の停止

`AI_BUDDY_LAB_LIVE_DISABLED=true` をEdge環境へ設定すると、愛言葉の確認画面は残したまま、生成だけをOpenRouterへ送らず `503` で停止します。環境反映後、`generate` が「Live AIは管理者により一時停止中です」を返すことを確認してください。再開時は値を削除するか `false` に戻します。

この停止スイッチも、既にOpenRouterへ到達済みの要求を取り消すものではありません。異常課金時は、併せてプロバイダー側のAPIキー停止・利用上限も使用してください。プロバイダー側の上限が、複数isolateをまたぐ最終防衛線です。

## テスト

```bash
deno test supabase/functions/ai-buddy-lab/index_test.ts
```

テストでは実APIへ接続せず、本文・文字数・出力token・停止スイッチ・同時実行・時間窓上限をスタブで検証します。
