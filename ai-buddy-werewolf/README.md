# AIバディ人狼 — Phase0 検証用WEBアプリ

> 裏切りか、信頼か。2人で力を合わせて生き残れ。

人間プレイヤー(主人)とAIバディの二人一組で戦う人狼ゲームの、**ゲームの核が本当に面白いかを検証するためのPhase0実験装置**です。討論・嘘・推理・最終投票を行うのはAIバディであり、人間は限られた助言でAIの判断に影響を与えます。

- 企画の全体像: [docs/GAME_OVERVIEW.md](docs/GAME_OVERVIEW.md)
- 技術構成: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 設定・プロンプトの変え方: [docs/CONFIG_AND_PROMPTS.md](docs/CONFIG_AND_PROMPTS.md)
- 本番モバイルへの持ち越し契約: [docs/MOBILE_HANDOFF.md](docs/MOBILE_HANDOFF.md)
- 実験の進め方: [docs/EXPERIMENT_GUIDE.md](docs/EXPERIMENT_GUIDE.md)
- 引き継ぎ(Codex/別エージェント向け): [docs/HANDOFF_CODEX.md](docs/HANDOFF_CODEX.md)
- 確定事項と仮決定: [docs/DECISIONS.md](docs/DECISIONS.md)

## 必要環境

- Node.js 20以上(動作確認: v22)
- npm 10以上
- ローカルでLive AIを使う場合のみ: Anthropic APIキー(モックAIのみなら不要)

## 公開Web Lab（覚えやすい愛言葉付き）

公開確認先: <https://new31005.github.io/naspet-flutter-web-review/ai-buddy-lab/>

- 入口は覚えやすい愛言葉で保護し、愛言葉そのものはGitHubやビルド成果物へ含めない
- 愛言葉は前後空白・大文字小文字・全角英数字を吸収。タブを閉じるまでの `sessionStorage` に保持する
- Live AIはSupabase Edge Functionを経由し、OpenRouterのAPIキーはサーバー側だけで保持
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
「プリセット: Quick Test / モード: Play Test / プロバイダー: mock」で試合を開始してください。

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

ローカル開発では試合作成時に `anthropic`、公開Web Labでは `lab-live` を選択する。公開Web Labの既定モデルは `anthropic/claude-sonnet-5`。使用モデル・推論強度・温度・トークン上限・単価は `config/models.json` で変更できる。Live呼び出しの構造検証または通信に失敗した場合は、エラー記録を残して決定論的モックへフォールバックする。

## テスト方法

```bash
npm test        # vitest (役職配布/秘密分離/信頼度補正/襲撃統合/勝敗/リプレイ復元/公開Lab復元/愛言葉正規化/引継ぎ整合性/モック完走 など41件)
npm run lint    # ESLint (strict / no-explicit-any)
```

## ビルド方法

```bash
npm run build   # 全パッケージの型チェック + Webのproductionビルド
npm run build:lab  # GitHub Pages用の愛言葉付き静的Web Labビルド
```

## 基本的な使い方

1. **ホーム**: プリセット・モード・プロバイダー・シードを選んで試合開始
2. **ゲーム画面**: 討論ログを読み、1日1回の助言(疑い/質問/確定情報共有/スキル対象/立ち回り)を送る。裁判では処刑したい相手を選ぶ(最終投票はバディが決める)。狼なら夜に襲撃提案
3. **結果画面**: 勝敗・全役職・主人とAIの選択の一致/不一致・トークン/原価/時間
4. **リプレイ画面**: 試合中は隠されていた怪しい度の推移・仮説・補正の詳細
5. **Lab画面**(`/match/<id>/lab`): 1ステップ実行/自動進行/フェーズ巻き戻し/任意の組への注入/生リクエスト確認/JSON・CSV書き出し
6. **設定画面**: ルール・助言メニュー・能力アンロック・モデル・プロンプトをブラウザから編集(再起動不要、次の試合から反映)
7. **本番へ持ち越す**: 設定画面の「モバイル引継ぎパッケージを書き出す」で、全設定・全プロンプト・各バージョン・SHA-256を1つのJSONへ固定する。APIキーと合言葉は含まれない

### CLIで連続シミュレーション

```bash
npm run simulate -- --preset quick-test --matches 5 --seed exp1 --provider mock
```

結果は `data/matches/*.json` に保存され、Web UIの過去試合一覧からも開けます。

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
