# 設定とプロンプトの変更ガイド

すべて**コード変更なし**で変更できる。編集方法は2通り:

1. ファイルを直接編集(エディタ)
2. Web UIの「実験設定」画面(`#/settings`)から編集

Web UIでは、よく使うルール・親密度・助言・AIモデル・単価を「かんたん設定」で日本語の項目名から変更できる。プロンプトも「推理・内部評価の指示」「狼憑きの嘘・判断」などの日本語名から選ぶ。能力アンロックなど全内部項目を触る場合だけ、画面下部の「開発者向け詳細設定（JSON原文）」を開く。保存時は従来どおりスキーマ検証され、本番モバイル用の書き出し形式も変わらない。

**反映タイミング**: 設定は試合作成時にスナップショットされる。編集後に**新しい試合を開始**すれば反映される(アプリ再起動不要)。Node版では進行中試合のプロンプト/モデル設定だけをLab画面の「♻️ プロンプト/モデル再読込」で差し替えられる(ルールは差し替え不可)。公開Web Labの編集内容は使用中ブラウザの `localStorage` にだけ保存される。既定ファイルのバージョンが上がっても、保存済みの独自設定やプロンプトを自動上書きしない。新しい既定値を使うときは、設定画面から明示的に初期値へ戻すか、新しいブラウザ領域で開始する。

## どのファイルを変更すると何が変わるか

| 変えたいもの | ファイル | 主なキー |
|---|---|---|
| 組数・狼数・役職構成 | `config/presets/*.json` | `pairCount`, `roleSetup.{werewolf,seer,guardian,medium}`(残りは市民) |
| 最大日数・討論時間・同時AI数 | 同上 | `maxDays`, `discussionMode`, `discussionDurationSec`, `discussionMaxMessages`, `discussionBatchSize`, `firstDayFocusCount`。既定の`timed`は `opening → awaiting_master_advice → response` の3段階。焦点対象2人の弁明と他AIの意見後に主人相談で止まり、相談中は時計を消費しない。助言/スキップ後は残り時間で再開する。最大`discussionBatchSize`人が個別に処理され、期限後の生成は破棄される。旧`turns`方式では`discussionRounds`, `speechesPerBuddyPerRound`を使う |
| 初日の占い結果 | 同上 | `firstNightDivination`: `false` / `true` / `"white"` |
| 主人の助言回数 | 同上 | `advicePerDay` |
| 同票処理 | 同上 | `tieBreak`(現状 `random` のみ) |
| 死亡時の役職公開 | 同上 | `revealRoleOnDeath` |
| 狼襲撃の統合方式 | 同上 | `wolfAttackIntegration.method`(現状 `sumNormalized`) |
| 親密度補正関数 | 同上 | `trust.{trialChoice,nightProposal,skillProposal,subjectiveAdvice}` = `{type, maxBonus}` |
| 他の主人のポリシー | 同上 | `otherMastersPolicy`: `none`/`random`/`simple`/`ai` |
| 助言メニュー(有効/無効/文言) | `config/advice.json` | `menu[]` |
| 役職を名乗る選択肢 | 同上 | `roleClaimOptions[]` |
| 質問テーマの増減 | 同上 | `questionThemes[]`(`mockTemplate`はモック用、`promptHint`はLive用) |
| 立ち回り指示の増減 | 同上 | `behaviorDirectives[]` |
| 推論力アンロック | `config/abilities.json` | `reasoningUnlocks[]`(`at`=解放ポイント) |
| 虚言力アンロック | 同上 | `deceptionUnlocks[]` |
| バディの人格・能力値 | `config/buddies.json`(またはバディ設定画面) | `persona.*`, `abilities.{reasoning,deception,trust}` |
| モデル・temperature・推論強度・トークン上限・タイムアウト・リトライ | `config/models.json` | ローカルは `providers.anthropic.*`、公開Labは `providers.lab-live.*` |
| モデル単価(原価計算) | 同上 | 各Live providerの `prices` |
| 既定プロバイダー | 同上 | `defaultProvider` |
| システム/評価/発言/役職別プロンプト | `prompts/*.md` | 後述 |

## ルール変更方法

`config/presets/quick-test.json` を編集するか、同形式のJSONを `config/presets/` に増やす(`presetId` を一意にすればホームのプリセット一覧に自動で出る)。Zodスキーマ(`packages/shared/src/schemas.ts` の `rulesConfigSchema`)で検証される。

現在のQuick Testは `discussionDurationSec: 150`、`discussionMaxMessages: 30`、`discussionBatchSize: 2`。Pack Testは150秒、最大48発言、同時3件である。150秒は仮値であり、`discussionDurationSec` を変えればコード変更なしで調整できる。時間にはAIの議論だけを含め、主人相談待ちの読解・選択時間は含めない。

## 役職変更方法

役職は `villager`（市民）/ `seer`（占い師）/ `guardian`（騎士）/
`medium`（霊媒師）/ `werewolf`（狼憑き）の5種。人数は `roleSetup` で変更でき、
残りが市民になる。9組の標準構成は `config/presets/standard-nine.json` で、
狼憑き2・占い師1・騎士1・霊媒師1・市民4を初期値とする。

役職をさらに増やす場合は、`shared/types.ts` の `Role`、配役、能力解決、秘密イベント、
`buildBuddyContext`、モック、役職別プロンプトを一組として更新する。表示名だけを追加して
能力処理を伴わない「見かけ上の役職」を作ってはならない。

現行Quick / Quick-info / Packは、初日から「占う→主人が共有を選ぶ→卓が反応する」を試すため、「初日の朝に、占い主人へ白結果を1件届ける」を既定でオンにしている。内部値 `firstNightDivination: "white"` として同じプリセットJSONへ保存される。`true` は狼判定もあり得る通常抽選、`false` は初日結果なし。結果は自動でバディへ渡らず、主人専用通知→相談で確定情報共有という境界を維持する。

## 助言メニュー変更方法

`config/advice.json` の `menu[]` で種類ごとに `enabled` を切り替え、文言(`label`/`description`)を変更する。質問テーマ・立ち回り指示は配列に要素を足すだけで選択肢が増える。影響度(主観助言の重み)はプリセットの `trust.subjectiveAdvice` で変更する。

`role_claim`（画面表示は「名乗り出る」）では、主人が
`roleClaimOptions[]` から名乗ってほしい役職を選ぶ。自分の本当の役職と同じ役職も、
あえて別の役職も選べるが、これは主人からバディへの非公開提案であり、実際に名乗るかは
親密度とバディ自身の判断で決まる。公開ログへ出るのはバディが実際に名乗った役職だけで、
本当かどうかは試合中に公開しない。別役職を名乗る提案は、存在しない占い結果・霊媒結果を
自動で作る許可ではない。

画面と説明文では専門用語を避け、「役職を名乗る」「名乗り出る」と表記する。
内部互換用のIDが残っていても、そのIDを利用者向け表示へ直接出さない。

## 推論力・虚言力アンロック変更方法

`config/abilities.json` の配列を編集する。`at` 以上の能力値を持つバディにその観点/技術が解放され、

- Live AI: `promptHint` が「使える観点リスト」としてプロンプトへ入る
- モックAI: `id` を見てヒューリスティックの分岐が変わる(`face_value`, `vote_consistency`, `bandwagon_detect`, `multi_hypothesis`, `plain_denial`, `plausible_reason`, `misdirection` は実装済みの分岐がある。それ以外のidはLiveプロンプトにのみ効く)

## 親密度補正変更方法

プリセットの `trust.*` を編集する。画面上の名称は「親密度」、内部互換名は `trust`。正解率ではなく、バディが主人との関係をどれだけ優先するかを表す。`type` は `linear`(maxBonus×trust/100) / `quadratic` / `none`。**新しい関数型を足す**場合は `packages/game-core/src/rules.ts` の `TRUST_FUNCTIONS` へ1エントリ追加し、`shared/schemas.ts` のenumへ型名を足す。確定情報はこの補正を通らない仕様を崩さないこと。

## モデル変更方法

ローカルNode版は `providers.anthropic.model`、公開Web Labは `providers.lab-live.model` を変更する。公開Labで利用できるモデルは、Edge Functionのallowlistにも同じIDを追加する必要がある。試合作成時のプロバイダー選択で `mock` / `anthropic`（ローカル）または `mock` / `lab-live`（公開Lab）を切り替える。別プロバイダー追加は [HANDOFF_CODEX.md](HANDOFF_CODEX.md) を参照。

公開Labの初期allowlistは `anthropic/claude-sonnet-5` / `anthropic/claude-opus-4.8` / `anthropic/claude-haiku-4.5`。今回の主人相談ターン調整ではモデル差を混ぜないため、既定をSonnet 5、推論強度を `low` のまま据え置いた。モデルがtemperatureを受け付けない場合は `null` にする（送信しない）。

## コスト単価変更方法

`config/models.json` の `prices` にモデルIDごとの `inputPerMTok` / `outputPerMTok`(USD/100万トークン)を設定する。原価はコールごとに `usage × 単価` で計算され、試合の推定原価として集計される。

公開LabのEdge Functionは、1要求につき本文192 KiB、system 24,000文字、user 48,000文字、評価1,200 tokens、発言400 tokens、effort `low`、待機90秒を上限にする。同一isolate内では同時8件・30分320件が既定で、`AI_BUDDY_LAB_LIVE_DISABLED=true` により生成を緊急停止できる。これは複数isolateをまたぐ厳密な予算上限ではないため、強い上限にはOpenRouter側の利用上限も併用する。詳細は `supabase/functions/ai-buddy-lab/COST_GUARD.md`。

## プロンプト変更方法

| ファイル | 用途 | 主なプレースホルダー |
|---|---|---|
| `prompts/system.base.md` | 全コール共通の世界観・ルール・判断原則 | `{{buddyName}} {{masterName}} {{pairCount}} {{maxDays}} {{trust}}` |
| `prompts/eval.md` | 評価コール本文(人格を含めない) | `{{day}} {{aliveList}} {{factsBlock}} {{advicesBlock}} {{reasoningUnlocksBlock}} {{publicLogBlock}} {{previousEvalBlock}} {{candidateIds}}` |
| `prompts/speech.md` | 発言コール本文(人格を含める) | `{{firstPerson}} {{speechStyle}} {{primaryHypothesis}} {{directiveBlock}} {{recentLogBlock}}` |
| `prompts/role.villager.md` / `role.seer.md` / `role.guardian.md` / `role.medium.md` | 市民・占い師・騎士・霊媒師の役職別方針 | (プレーンテキスト) |
| `prompts/role.werewolf.md` | 狼の方針 + 虚言力アンロック | `{{wolfPartners}} {{deception}} {{deceptionUnlocksBlock}}` |

プレースホルダーの実体は `packages/ai-engine/src/promptBuilder.ts` にある。**評価プロンプトへ人格を、発言プロンプトへ判断指示を混ぜない**こと(判断と表現の分離)。

評価コールへ渡す公開ログは、投票などの永続的な公開イベントを残しつつ、発言本文を直近24件に制限する。これは同じ長い履歴を毎コール再送して入力tokenが二次的に膨らむのを防ぐためである。上限を変える場合は、原価だけでなく長期矛盾の検出率も同条件で比較する。

## プロンプトバージョン管理方法

`prompts/version.json` の `version` を上げてからプロンプトを編集する。現在の役職を名乗る相談・騎士・霊媒師対応版は `0.9.0-role-claim-special-roles.1`。試合作成時に `configSnapshot.promptVersion` / `versions.prompts` として記録され、結果画面・エクスポートJSONで確認できる。どのバージョンのプロンプトで実行された試合かを比較実験の軸にする。

## 本番モバイルへ持ち越す方法

設定画面上部の「モバイル引継ぎパッケージを書き出す」を押すと、現在このブラウザで有効な次の内容を1つのJSONへ固定する。

- Quick Test / Pack Test / 9組標準テスト、助言、能力、モデル単価、バディ人格
- system / eval / speech / 5役職の役職別プロンプト / prompt version
- 各設定バージョン、書き出し時刻、内容全体のSHA-256
- 本番実装契約（権威あるイベントエンジン、プロンプトはサーバー側、秘密を含めない）

APIキー・平文の合言葉・試合履歴は含まれない。現在の書き出しはv2の16ファイル固定で、旧v1の13ファイルも読み込み可能。読み込み時はZodスキーマとSHA-256の両方を検証し、全ファイルの検証が完了してから一括反映する。本番Flutter/バックエンド側の受け入れ手順と境界は [MOBILE_HANDOFF.md](MOBILE_HANDOFF.md) を正とする。

## 設定変更時の注意点

- 各設定ファイルの `version` を上げる習慣をつける(試合に記録されるのはこの文字列)
- `pairCount` は `config/buddies.json` のロスター数(既定8)以下にする
- 検証はサーバー側で行われ、不正なJSONはUI/PUTで拒否される(エラーメッセージ表示)
- 進行中の試合の `configSnapshot` は変わらない。「同じ設定で再戦」はスナップショットを引き継ぐため、**編集後の設定で試したい場合は新規試合**を作ること
- モックAIは決定論的(同シード同結果)、**Live AIは非決定的**(同シードでも結果が変わる)
- 公開Labの進行中メモリには全AIコールを保持するが、リロード後にlocalStorageから復元できる生リクエスト/レスポンスは直近30コールだけ。完全な生ログが必要な実験では、リロード前に試合JSONを書き出す。イベントと集計指標はこの30件制限とは別に保持される
