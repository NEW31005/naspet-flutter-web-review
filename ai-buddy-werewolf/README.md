# AIバディ人狼 — Phase0 検証用WEBアプリ

> 裏切りか、信頼か。2人で力を合わせて生き残れ。

人間プレイヤー(主人)とAIバディの二人一組で戦う人狼ゲームの、**ゲームの核が本当に面白いかを検証するためのPhase0実験装置**です。討論・嘘・推理・最終投票を行うのはAIバディであり、人間は限られた助言でAIの判断に影響を与えます。

- 企画の全体像: [docs/GAME_OVERVIEW.md](docs/GAME_OVERVIEW.md)
- 技術構成: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 設定・プロンプトの変え方: [docs/CONFIG_AND_PROMPTS.md](docs/CONFIG_AND_PROMPTS.md)
- 本番モバイルへの持ち越し契約: [docs/MOBILE_HANDOFF.md](docs/MOBILE_HANDOFF.md)
- 実験の進め方: [docs/EXPERIMENT_GUIDE.md](docs/EXPERIMENT_GUIDE.md)
- 2026-08-27 討論・主人相談ターン調整レポート: [docs/TUNING_REPORT_2026-08-27.md](docs/TUNING_REPORT_2026-08-27.md)
- 引き継ぎ(Codex/別エージェント向け): [docs/HANDOFF_CODEX.md](docs/HANDOFF_CODEX.md)
- 確定事項と仮決定: [docs/DECISIONS.md](docs/DECISIONS.md)

## 必要環境

- Node.js 20以上(動作確認: v22)
- npm 10以上
- ローカルでLive AIを使う場合のみ: Anthropic APIキー(モックAIのみなら不要)

## 公開Web Lab（覚えやすい愛言葉付き）

公開確認先: <https://new31005.github.io/naspet-flutter-web-review/ai-buddy-lab/>

- 入口は覚えやすい愛言葉で保護し、愛言葉そのものはGitHubやビルド成果物へ含めない
- 愛言葉は前後空白・大文字小文字・全角英数字を吸収し、日本語も使用可能。タブを閉じるまでの `sessionStorage` に保持する
- Live AIはSupabase Edge Functionを経由し、OpenRouterのAPIキーはサーバー側だけで保持
- Edge側で本文・プロンプト・出力token・同時実行・時間窓ごとの件数を制限し、緊急停止スイッチも用意する。ただし複数Edge isolateをまたぐ厳密な課金上限ではない
- 検索結果への掲載を避けるため `noindex` を指定。ただしURLを知る第三者から完全に存在を隠す認証サービスではない
- ブラウザデータを消す前に、試合JSONと「モバイル引継ぎパッケージ」を書き出すこと

## セットアップ

```bash
cd ai-buddy-werewolf
npm install
```

## 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Live AI使用時のみ | Anthropic APIキー。**サーバー側でのみ**読み込まれ、クライアントへは渡らない |
| `AIBW_PORT` | 任意 | APIサーバーのポート(既定: 8787) |

公開Web Labではローカル `.env` を使わない。Edge Function側の `OPENROUTER_API_KEY` と、合言葉のSHA-256である `AI_BUDDY_LAB_ACCESS_SHA256` をSupabase Secretsへ登録する。平文の合言葉をサーバーへ保存しない。

`ai-buddy-werewolf/.env` ファイル(`KEY=VALUE`形式)を置けば起動時に読み込まれます(gitignore済み)。

## モックAIでの起動方法(APIキー不要)

```bash
npm run dev
# → APIサーバー http://localhost:8787 + Web http://localhost:5173
```

ブラウザ(スマホまたはPCのモバイル表示)で http://localhost:5173 を開き、
「プリセット: クイックテスト / モード: プレイテスト / AI: モックAI」で試合を開始してください。

本番ビルドで動かす場合:

```bash
npm run build
npm start
# → http://localhost:8787 (ビルド済みWebを同一ポートで配信)
```

## Live AIでの起動方法

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # または .env に記載
npm run dev
```

ローカル開発では試合作成時に画面上の「Claude Live（ローカル開発用）」、公開Web Labでは「Claude Live（実際の会話を検証）」を選択する。内部IDはそれぞれ `anthropic` / `lab-live`。公開Web Labの既定モデルは、今回の討論構造だけを比較できるよう変更せず `anthropic/claude-sonnet-5`（effort: `low`）を継続する。使用モデル・考える深さ・出力量・待ち時間・単価は「実験設定」の日本語画面から変更でき、全項目は `config/models.json` でも変更できる。Live呼び出しの構造検証または通信に失敗した場合は、エラー記録を残して決定論的モックへフォールバックする。

新規試合画面の初期選択は「本格9組テスト」とLive AIです。公開Web Labでは `lab-live`、ローカル開発では `anthropic` が自動選択されます。動作確認だけを行う場合は、画面からモックAIへ切り替えられます。

## テスト方法

```bash
npm test        # vitest (5役職/秘密分離/役職を名乗る相談/討論3段階・複数相談・質疑完了優先・短文上限・名指し応答・期限終了/親密度補正/複数の占い・護衛・霊媒/初日占い/襲撃統合/勝敗/リプレイ境界/公開Lab復元/Live AI・9組の初期選択/旧試合・引継ぎ互換/モック完走 など139件)
npm run lint    # ESLint (strict / no-explicit-any)
```

## ビルド方法

```bash
npm run build   # 全パッケージの型チェック + Webのproductionビルド
npm run build:lab  # GitHub Pages用の愛言葉付き静的Web Labビルド
```

## 基本的な使い方

1. **ホーム**: プリセット・モード・プロバイダー・シードを選んで試合開始
2. **ゲーム画面**: 討論は `最初の議論 → 主人の相談待ち → 相談後の議論` を基本に、設定回数が残っていれば応答3件ごとに追加相談を挟める。初日は抽選された2人が先に弁明し、他のバディが意見を出したところで必ず主人へ返す。既定150秒の40%を相談後の議論へ予約し、相談待ち中は時計も停止する。本格9組テストは1日2回の選択式相談(疑い/質問/確定情報共有/占い・護衛対象/役職を名乗る相談/立ち回り)。定型選択そのものはLLMを呼ばず、その後の公開発言だけが原価へ加算される。「役職を名乗る相談」では本当の役職、別の役職、今日は名乗らない、を選べるが、実際に名乗るかはバディが判断する。AIは個別に判断し、短い質問→回答→追加反応を優先する。時間切れ後に完成した発言は採用しない。終了後の裁判で主人が処刑候補を示し、最終投票はバディが決める。狼なら夜に襲撃提案
3. **結果画面**: 勝敗・全役職・主人とAIの選択の一致/不一致・主人が提案した役職とバディが実際に名乗った役職・トークン/原価/時間
4. **リプレイ画面**: 試合中は隠されていた怪しい度の推移・仮説・補正に加え、役職を名乗った内容の真偽、護衛・霊媒結果を確認
5. **Lab画面**(`/match/<id>/lab`): 1ステップ実行/自動進行/フェーズ巻き戻し/任意の組への注入/生リクエスト確認/JSON・CSV書き出し。公開Labで生のAI要求・応答を完全保存したい場合は、リロード前にJSONを書き出す。再読込後は直近30コールだけをブラウザへ保持する
6. **設定画面**: ルール・助言メニュー・能力アンロック・モデル・プロンプトをブラウザから編集(再起動不要、次の試合から反映)。公開更新後に以前の調整を残したまま新しい既定値を試したい場合は先にbundleを書き出し、「新しい推奨設定を適用」を明示的に選ぶ。過去試合は消えない
7. **本番へ持ち越す**: 設定画面の「モバイル引継ぎパッケージを書き出す」で、全設定・全プロンプト・各バージョン・SHA-256を1つのJSONへ固定する。APIキーと合言葉は含まれない

### CLIで連続シミュレーション

```bash
npm run simulate -- --preset quick-test --matches 5 --seed exp1 --provider mock
```

結果は `data/matches/*.json` に保存され、Web UIの過去試合一覧からも開けます。

保存済み試合を勝率・発言・コール数・疑い表明率などで集計する場合:

```bash
npm run analyze:matches -- --seed-prefix exp1- --preset quick-test
```

`--json` を付けると機械可読JSONで出力する。対象試合がない場合はその旨を表示して終了する。

親密度50/80と最大影響値20/25/32/40を同一のAI基礎評価で比較する場合:

```bash
npm run analyze:intimacy
```

42試合を一時領域で実行し、再現用の基礎スコアを含む `docs/experiments/intimacy-gradient-v1.json` を生成します。通常の `data/matches/` は汚しません。

## ディレクトリ概要

```
apps/web        モバイル前提の検証UI (React + Vite)
apps/server     APIサーバー + CLI (Node, 依存最小)
supabase/functions/ai-buddy-lab  公開Lab専用の認証・OpenRouter中継(APIキー保護)
packages/game-core  純TSのゲームロジック(状態/ルール/可視性/イベントソーシング)
packages/ai-engine  LLMプロバイダー抽象化・評価/発言コール・モックAI・進行ランナー
packages/shared     共通型・Zodスキーマ・シード付き乱数
config/         ルールプリセット/バディ/助言/能力アンロック/モデル・単価
prompts/        Live AI用プロンプト(評価/発言/役職別) + バージョン
data/           試合データ(JSON, gitignore)
docs/           日本語ドキュメント一式
```
