# このリポジトリについて

このリポジトリには2つの独立した内容が同居しています。

1. **ルート直下のファイル群**(`index.html`, `main.dart.js`, `assets/` など)
   - naspet Flutter Webアプリの**ビルド成果物**(gh-pages公開用)。ソースコードは含まれません。**手で編集しないでください。**
2. **`ai-buddy-werewolf/`**
   - 『AIバディ人狼』Phase0検証用WEBアプリ(TypeScriptモノレポ)。こちらが開発対象です。
   - 始め方・ドキュメント: [ai-buddy-werewolf/README.md](ai-buddy-werewolf/README.md)

```bash
cd ai-buddy-werewolf
npm install
npm run dev   # http://localhost:5173 (モックAIならAPIキー不要)
```
