# AIバディ人狼 — Phase0 検証用WEBアプリ

> 裏切りか、信頼か。2人で力を合わせて生き残れ。

人間プレイヤー(主人)とAIバディの二人一組で戦う人狼ゲームの、**ゲームの核が本当に面白いかを検証するためのPhase0実験装置**です。討論・嘘・推理・最終投票を行うのはAIバディであり、人間は限られた助言でAIの判断に影響を与えます。

- 企画の全体像: [docs/GAME_OVERVIEW.md](docs/GAME_OVERVIEW.md)
- 技術構成: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 設定・プロンプトの変え方: [docs/CONFIG_AND_PROMPTS.md](docs/CONFIG_AND_PROMPTS.md)
- 実験の進め方: [docs/EXPERIMENT_GUIDE.md](docs/EXPERIMENT_GUIDE.md)
- 引き継ぎ(Codex/別エージェント向け): [docs/HANDOFF_CODEX.md](docs/HANDOFF_CODEX.md)
- 確定事項と仮決定: [docs/DECISIONS.md](docs/DECISIONS.md)

## 必要環境

- Node.js 20以上(動作確認: v22)
- npm 10以上
- LLMを使う場合のみ: Anthropic APIキー(モックAIのみなら不要)

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

## Live AI(Anthropic Claude)での起動方法

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # または .env に記載
npm run dev
```

試合作成時にプロバイダーで `anthropic` を選択します。使用モデル・温度・トークン上限・単価は `config/models.json` で変更できます(既定: `claude-opus-5`)。キー未設定のままLiveを選んだ場合、各コールはエラー記録を残して決定論的モックへフォールバックします。

## テスト方法

```bash
npm test        # vitest (役職配布/秘密分離/信頼度補正/襲撃統合/勝敗/リプレイ復元/モック完走 など34件)
npm run lint    # ESLint (strict / no-explicit-any)
```

## ビルド方法

```bash
npm run build   # 全パッケージの型チェック + Webのproductionビルド
```

## 基本的な使い方

1. **ホーム**: プリセット・モード・プロバイダー・シードを選んで試合開始
2. **ゲーム画面**: 討論ログを読み、1日1回の助言(疑い/質問/確定情報共有/スキル対象/立ち回り)を送る。裁判では処刑したい相手を選ぶ(最終投票はバディが決める)。狼なら夜に襲撃提案
3. **結果画面**: 勝敗・全役職・主人とAIの選択の一致/不一致・トークン/原価/時間
4. **リプレイ画面**: 試合中は隠されていた怪しい度の推移・仮説・補正の詳細
5. **Lab画面**(`/match/<id>/lab`): 1ステップ実行/自動進行/フェーズ巻き戻し/任意の組への注入/生リクエスト確認/JSON・CSV書き出し
6. **設定画面**: ルール・助言メニュー・能力アンロック・モデル・プロンプトをブラウザから編集(再起動不要、次の試合から反映)

### CLIで連続シミュレーション

```bash
npm run simulate -- --preset quick-test --matches 5 --seed exp1 --provider mock
```

結果は `data/matches/*.json` に保存され、Web UIの過去試合一覧からも開けます。

## ディレクトリ概要

```
apps/web        モバイル前提の検証UI (React + Vite)
apps/server     APIサーバー + CLI (Node, 依存最小)
packages/game-core  純TSのゲームロジック(状態/ルール/可視性/イベントソーシング)
packages/ai-engine  LLMプロバイダー抽象化・評価/発言コール・モックAI・進行ランナー
packages/shared     共通型・Zodスキーマ・シード付き乱数
config/         ルールプリセット/バディ/助言/能力アンロック/モデル・単価
prompts/        Live AI用プロンプト(評価/発言/役職別) + バージョン
data/           試合データ(JSON, gitignore)
docs/           日本語ドキュメント一式
```
