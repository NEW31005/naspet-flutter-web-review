# 評価タスク

現在の公開情報とあなただけの秘密情報を読み、内部評価を更新してください。
これは思考の整理であり、発言ではありません。出力は指定された構造化データのみで、長い思考過程は書かないでください。

# 現在の状況
- {{day}}日目 / フェーズ: {{phase}} / 最大{{maxDays}}日
- 生存者: {{aliveList}}
- 死亡者: {{deadList}}

# あなたの秘密情報
- あなたの役職: {{roleLabel}}
{{roleBlock}}
{{factsBlock}}
{{advicesBlock}}

# あなたの推論力({{reasoning}}/100)で使える観点
以下の観点だけを使って推理してください。リストにない高度な観点は、まだあなたには使えません。
{{reasoningUnlocksBlock}}

# 公開ログ
{{publicLogBlock}}

# 前回のあなたの評価(参考。状況が変わっていれば更新する)
{{previousEvalBlock}}

# 出力項目の意味
- suspicions: 生存中の他参加者それぞれの「狼憑きらしさ」0-100。キーは参加者ID({{candidateIds}})。
- {{attackPrioritiesHint}}
- {{skillPrioritiesHint}}
- primaryHypothesis: 現在の主要仮説を1〜2文で。
- altHypotheses: 別の可能性を最大3件、各1文で。
- confidence: 主要仮説への確信度0-100。
- toShare: 次の発言で公開してよいと考える情報(短句)。
- toWithhold: 伏せるべきと考える情報(短句)。
- questionTargetId / questionTheme: 次に質問したい相手と質問テーマID(なければ両方null)。下の「今回利用できる質問テーマ」にあるIDだけを使う。

# 今回利用できる質問テーマ
{{questionThemesBlock}}
- voteCandidateId: いま裁判になったら投票する相手のID(なければnull)。
- reasonSummary: 判断理由の要約を2文以内で。思考過程の羅列ではなく結論の根拠を書く。

# 評価の注意
- 名指しされた、発言が短い、慎重に保留した、抽選の討論対象になった、という事実だけで怪しさを上げない。公開ログ上の具体的な主張・矛盾・便乗・投票との不一致を根拠にする。
- 狼憑きは自然な市民の発言を装える。発言を額面どおり受け取るだけでなく、誘導や部分的な真実の可能性も、現在使える推論観点の範囲で検討する。
- 前回と同じ結論なら、新しく増えた根拠があるかを確認する。新しい材料がなければ確信度を不必要に上げない。
