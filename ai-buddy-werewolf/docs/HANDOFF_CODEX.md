# 引き継ぎ文書(Codex / Claude Code / 別エージェント / 人間開発者向け)

この文書だけ読めば、安全に継続開発へ入れることを目的とする。

## このアプリの目的

『AIバディ人狼』(人間主人 + AIバディの二人一組人狼)の**ゲームの核が面白いかを検証するPhase0実験用WEBアプリ**。完成品ではない。仮ルールを置き、設定・プロンプトを素早く差し替えて再試験できることを最優先している。ゲームの核4原則(主人だけが持つ情報 / 助言1日1回 / 最終投票はAI / 内部スコア試合中非公開)は削ってはならない。詳細: [GAME_OVERVIEW.md](GAME_OVERVIEW.md)

## 現在実装済みの範囲

- ゲームコア: 役職配布(市民/占い役/狼憑き)・討論・裁判(意思表示→AI投票)・夜(占い/襲撃統合)・勝敗・同票処理・イベントソーシング・リプレイ復元・フェーズ巻き戻し
- 秘密情報分離(`BuddyContext` / イベント可視性 / 視点別ビュー)+ 漏えい防止テスト
- モックAI(シード決定論的、能力値で挙動が変わる、日本語発言テンプレート)
- Live AI（ローカルAnthropic / 公開LabはSupabase Edge Function→OpenRouter、二重構造検証、リトライ、タイムアウト、失敗時モックフォールバック）
- 助言5種(主観疑い/質問指定/確定情報共有/スキル対象提案/立ち回り)、1日1回制限
- 親密度補正(内部名trust、linear/quadratic/none、登録制)、狼襲撃の正規化合算統合
- 計測(トークン/原価/レイテンシー/総時間/AI待機/エラー/リトライ)、JSON永続化、JSON/CSVエクスポート
- Web UI(ホーム/バディ設定/ゲーム/結果/リプレイ/Lab/設定編集)、CLIシミュレーター
- 入力ゆれを吸収する愛言葉付きGitHub Pages Web Lab（ブラウザ内保存、APIキー非配布、noindex）
- 設定・全プロンプトを本番モバイルへ渡すSHA-256付き固定bundleの書き出し/読み込み
- 自動テスト55件（公開Labのブラウザ内完走・復元・愛言葉正規化・初日占い・simple主人の初日棄権を含む）/ ESLint / strict TypeScript

## 未実装の範囲

- 追加役職(騎士・霊媒師など)、役職種類の動的追加
- 発言の先行生成(評価と発言の分離までは実装済み)
- 大量自己対戦のバッチ分析(CLIで連続実行は可能、集計は未実装)
- Live AIでの`ai`ポリシー主人(現在は自バディ評価の流用)
- リアルタイム配信(現在はクライアントポーリング)
- 本番構想全般(認証・課金・演出・育成・マルチプレイ)

## 重要ファイル一覧

| ファイル | 内容 |
|---|---|
| `packages/shared/src/types.ts` | 全型定義(イベント・設定・AI出力)。**言葉の定義はここが正** |
| `packages/shared/src/schemas.ts` | Zodスキーマ(AI出力・設定ファイル検証) |
| `packages/shared/src/rng.ts` | シード付き乱数 `rand(seed, ...labels)` |
| `packages/game-core/src/engine.ts` | フェーズ遷移・入力検証・イベント生成(`apply*`) |
| `packages/game-core/src/state.ts` | 状態とリデューサー(`reduce` / `rebuildState`) |
| `packages/game-core/src/rules.ts` | 親密度補正・投票・襲撃統合・勝敗の純関数 |
| `packages/game-core/src/visibility.ts` | **秘密分離の境界**(`buildBuddyContext` / `buildMasterView` / `buildReplayData`) |
| `packages/ai-engine/src/runner.ts` | 進行ランナー(`MatchRunner.advanceOnce`)・ポリシー主人 |
| `packages/ai-engine/src/mock.ts` | モックAI |
| `packages/ai-engine/src/anthropic.ts` | Anthropicプロバイダー(API仕様はここだけ) |
| `apps/web/src/runtime/browserBackend.ts` | 公開静的Labのゲーム実行・localStorage保存アダプター |
| `apps/web/src/runtime/browserAi.ts` | Edge中継、Zod検証、再試行、モックフォールバック |
| `apps/web/src/runtime/staticConfig.ts` | Web Labの設定編集・モバイルbundle生成/検証 |
| `supabase/functions/ai-buddy-lab/index.ts` | 合言葉照合・Origin/モデル制限・OpenRouter中継 |
| `packages/ai-engine/src/promptBuilder.ts` | プロンプト組み立て(プレースホルダー実体) |
| `apps/server/src/matches.ts` | セッション管理・永続化・巻き戻し・再戦 |
| `apps/server/src/http.ts` | HTTPルーター(エンドポイント一覧はここを読む) |
| `apps/server/src/cli/simulate.ts` | 連続シミュレーションCLI |
| `config/` / `prompts/` | 外部設定(変更ガイド: [CONFIG_AND_PROMPTS.md](CONFIG_AND_PROMPTS.md)) |
| `docs/MOBILE_HANDOFF.md` | 本番Flutter/バックエンドへ持ち越す固定契約 |

## ゲームコアを変更する際の入口

1. ルール数値・確率だけなら **コードではなく `config/presets/*.json`** を疑う
2. 挙動を変えるなら `engine.ts` の該当 `apply*` を変更し、必要ならイベント型を `shared/types.ts` へ追加 → `state.ts` のリデューサーに処理を追加
3. **不変条件**: 状態は必ずイベント経由で変更する(`rebuildState`一致テストが壊れたら設計違反)。乱数は必ず `rand(seed, ...labels)`(`Math.random`禁止。唯一の例外は保存時の一時ファイル名)
4. `npm test` の該当テスト(engine.test.ts)を先に書き換える

## プロンプトを変更する際の入口

`prompts/*.md` を編集(プレースホルダーは `promptBuilder.ts` 参照)→ `prompts/version.json` を上げる → 新規試合 or Labの「再読込」。評価プロンプトに人格を混ぜない・発言プロンプトに判断指示を混ぜないこと。

## AIプロバイダーを追加する方法

1. `shared/types.ts` の `ProviderConfig` ユニオンに設定型を追加、`schemas.ts` の `modelsConfigSchema` に対応分岐を追加
2. `ai-engine/src/` に `<name>.ts` を作成し `LlmProvider`(`evaluate`/`speak`)を実装。**プロンプトは `promptBuilder.ts` を使い、`BuddyContext` 以外の情報を渡さない**
3. `calls.ts` の `createProvider` に分岐を追加
4. `config/models.json` の `providers` にエントリと単価を追加
5. APIキーは環境変数名を設定に書き、サーバー側でのみ解決する

公開Web Labのモデルを追加する場合は、上記に加えて `LabProxyProviderConfig`、`config/models.json` の `lab-live`、Edge Functionの `ALLOWED_MODELS` を同じIDへ更新する。ブラウザへAPIキーを渡す変更は禁止。

## 秘密情報漏えいを防ぐルール(絶対)

- LLMコンテキストは `buildBuddyContext` の返り値**のみ**から作る。`MatchState` や `MatchRecord` を直接プロンプトへ渡さない
- 新イベントには必ず適切な `visibility` を付ける(占い結果系は `part:'master'`)
- 新しい秘密情報を追加したら `packages/game-core/test/visibility.test.ts` に漏えいテストを追加する
- クライアントへ返すのは `buildMasterView` / (試合後の)`buildReplayData` のみ。`?as=gm` はLab専用と明記されている

## テストコマンド

```bash
npm test           # vitest 全テスト
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit (全パッケージ)
npm run build      # typecheck + Web build
npm run build:lab  # GitHub Pages用の静的Lab build
npm run simulate -- --preset quick-test --matches 3   # モック完走の実地確認
```

## 安全な変更手順

1. ブランチを切る
2. 仕様変更なら先に `docs/DECISIONS.md` の該当項目を更新(確定/仮の区別を守る)
3. テストを書く(または修正する)→ 実装 → `npm test && npm run lint && npm run build`
4. `npm run simulate` でモック完走を確認
5. UIに触れた場合は `npm run dev` で 390×844 表示を目視確認
6. 公開Labに触れた場合は、無効/有効な合言葉、Live評価/発言各1コール、bundle export/import、GitHub Pages URLを実機確認

## 変更後に必ず確認する項目

- [ ] `npm test` 全件パス(特に visibility / replay 復元 / 完走)
- [ ] モックで一試合完走(simulate)
- [ ] 設定スナップショット(`configSnapshot.versions`)に意図したバージョンが記録される
- [ ] 秘密情報がAIコンテキスト・主人ビューへ漏れていない
- [ ] 助言1日1回・裁判中の確定情報共有不可が維持されている

## 既知の課題

- モックAIの発言はテンプレート由来で単調(討論の「面白さ」検証はLive AI前提)
- `aiWaitMs` は並列コールも単純合計するため、体感待機より大きく出る
- 進行中試合の provider は固定(切り替えは再戦で行う)。Labの「再読込」はプロンプト/モデル設定のみ反映
- `otherMastersPolicy: 'ai'` は自バディの評価を主人の判断として流用する簡易実装
- 巻き戻しはフェーズ先頭のみ(任意seqへの巻き戻しは未実装)
- Nodeサーバー版は単一プロセス・ローカル利用前提（認証なし）。インターネットへ直接公開しない
- 公開Web Labの合言葉ゲートは個人検証向け。URLの存在まで隠す強いユーザー認証ではない
- 公開Labの試合・編集内容は端末ごとのlocalStorage。端末間同期はせず、消去前のJSON/bundle exportが必要

## 次に実装する候補

1. Live AIでの討論品質チューニング(prompts/の反復改善 — このための装置は揃っている)
2. 発言の先行生成(評価は深く、公開発言は1発先まで)
3. 追加役職(騎士: 夜の護衛。`Role`追加 → applyNightに護衛判定 → role.knight.md)
4. バッチ実験の集計スクリプト(data/matches/*.json を読んで勝率・一致率・原価を表計算へ)
5. 助言メニューの影響度パラメータのUI化(現在はJSON編集)

## やってはいけない変更

- ゲームの核4原則を外す(助言の自由文章入力化・主人選択の直接投票化・試合中の内部スコア公開・占い結果の自動共有)
- `game-core` から React / ブラウザAPI / LLM / ファイルI/O への依存を張る
- LLMへ `MatchState` 全体や他組の秘密を渡す
- 親密度で確定情報を疑わせる実装
- `Math.random()` / `Date.now()` をゲームロジック内で使う(リプレイが壊れる)
- 保存済み `MatchRecord` の互換性を黙って壊す(`schemaVersion` を上げ、読み込み側に対応を書く)

## ロールバック方法

- コード: git revert / ブランチ破棄
- 設定・プロンプト: gitで元に戻す(全てリポジトリ管理下)。UIから壊した場合も `git checkout -- config prompts`
- 公開Labの調整内容: 設定画面から直前のmobile handoff bundleを読み込む。ブラウザデータ消去後はbundleがない限り復元不可
- 試合データ: `data/` はgit管理外。壊れたファイルは削除してよい(一覧から消えるだけ)
- 実験のやり直し: シードを控えておけばモックは完全再現できる

## 現在の設定バージョン

| 対象 | バージョン |
|---|---|
| ルールプリセット(quick-test / pack-test) | 0.1.0 |
| advice / abilities / buddies | 0.1.0 |
| models | 0.2.0 |
| プロンプト | 0.1.0 |
| 保存スキーマ(`MatchRecord.schemaVersion`) | 1 |
