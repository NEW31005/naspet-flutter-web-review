/**
 * モックAIプロバイダー。
 * APIキーなしでゲーム進行・情報可視性・投票・襲撃・保存を確認するための決定論的AI。
 * 完璧な人狼AIではないが、能力値(推論力/虚言力/信頼度)の差が挙動に出るよう作ってある。
 * シード+ラベルから導出する乱数のみを使うため、同じシードなら同じ試合を再現できる。
 */
import type { EvalOutput, PairId, SpeechOutput } from '@aibw/shared';
import { ROLE_LABEL, pickOne, rand } from '@aibw/shared';
import { trustBonus } from '@aibw/game-core';
import type { BuddyContext } from '@aibw/game-core';
import type { CallOpts, LlmProvider, ProviderResult } from './provider.js';

const clamp = (v: number) => Math.min(100, Math.max(0, Math.round(v)));

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  constructor(private simulatedLatencyMs = 0) {}

  async evaluate(ctx: BuddyContext, opts: CallOpts): Promise<ProviderResult<EvalOutput>> {
    if (this.simulatedLatencyMs > 0) await delay(this.simulatedLatencyMs);
    const output = mockEvaluate(ctx, opts);
    return {
      output,
      model: 'mock',
      usage: { inputTokens: 0, outputTokens: 0 },
      jsonRetries: 0,
      rawRequest: { note: 'mock-eval', stepLabel: opts.stepLabel },
      rawResponse: output,
    };
  }

  async speak(
    ctx: BuddyContext,
    evalOutput: EvalOutput,
    opts: CallOpts,
  ): Promise<ProviderResult<SpeechOutput>> {
    if (this.simulatedLatencyMs > 0) await delay(this.simulatedLatencyMs);
    const output = mockSpeak(ctx, evalOutput, opts);
    return {
      output,
      model: 'mock',
      usage: { inputTokens: 0, outputTokens: 0 },
      jsonRetries: 0,
      rawRequest: { note: 'mock-speech', stepLabel: opts.stepLabel },
      rawResponse: output,
    };
  }
}

const unlocked = (list: { id: string }[], id: string) => list.some((u) => u.id === id);

/** 決定論的な内部評価の生成 */
export function mockEvaluate(ctx: BuddyContext, opts: CallOpts): EvalOutput {
  const seed = `${opts.seed}#${opts.nonce}`;
  const self = ctx.self;
  const partners = new Set(ctx.wolfPartners.map((w) => w.pairId));
  const isWolf = self.role === 'werewolf';
  const reasoning = self.unlockedReasoning;

  const suspicions: Record<PairId, number> = {};
  const accusationCount: Record<PairId, number> = {};
  const accusedMe: Record<PairId, boolean> = {};
  const accusedPartner: Record<PairId, boolean> = {};
  const lastAccusation: Record<PairId, PairId | null> = {};
  let prevSpeechTarget: PairId | null = null;
  const bandwagoners = new Set<PairId>();

  for (const entry of ctx.publicLog) {
    if (entry.t === 'speech') {
      if (entry.accusesId) {
        accusationCount[entry.accusesId] = (accusationCount[entry.accusesId] ?? 0) + 1;
        if (entry.accusesId === self.pairId) accusedMe[entry.pairId] = true;
        if (partners.has(entry.accusesId)) accusedPartner[entry.pairId] = true;
        if (prevSpeechTarget && entry.accusesId === prevSpeechTarget) {
          bandwagoners.add(entry.pairId);
        }
        prevSpeechTarget = entry.accusesId;
        lastAccusation[entry.pairId] = entry.accusesId;
      }
    }
  }
  const voteMismatch = new Set<PairId>();
  for (const v of ctx.publicLog) {
    if (v.t === 'vote') {
      const said = lastAccusation[v.pairId];
      if (said && said !== v.targetId) voteMismatch.add(v.pairId);
    }
  }

  // 狼のスケープゴート(押し付け先)は試合を通じて安定させる
  const nonPartnerCandidates = ctx.candidates.filter((c) => !partners.has(c.pairId));
  const scapegoat =
    isWolf && nonPartnerCandidates.length > 0
      ? pickOne(
          nonPartnerCandidates.map((c) => c.pairId),
          seed,
          'scapegoat',
          self.pairId,
        )
      : null;

  for (const c of ctx.candidates) {
    const id = c.pairId;
    // 関係ごとの安定した初期バイアス + 日ごとの小さな揺らぎ
    let s = 50 + (rand(seed, 'bias', self.pairId, id) * 24 - 12);
    s += rand(seed, 'noise', opts.stepLabel, id) * 10 - 5;

    if (isWolf) {
      // 狼にとって suspicions は「処刑へ誘導したい度」
      if (partners.has(id)) s = 8;
      if (id === scapegoat) s += 30;
      if (accusedMe[id]) s += 15;
      if (accusedPartner[id]) s += 10;
    } else {
      // 額面受け取り: 多く疑われている人へ流される(推論力が上がると弱まる)
      const herd = unlocked(reasoning, 'bandwagon_detect') ? 3 : 9;
      s += (accusationCount[id] ?? 0) * herd;
      if (accusedMe[id]) s += 12;
      if (unlocked(reasoning, 'vote_consistency') && voteMismatch.has(id)) s += 10;
      if (unlocked(reasoning, 'bandwagon_detect') && bandwagoners.has(id)) s += 8;
    }
    suspicions[id] = clamp(s);
  }

  // 確定情報(共有済みのみ)は事実として最優先。信頼度で疑わせない。
  for (const fact of ctx.sharedFacts) {
    if (suspicions[fact.targetId] !== undefined) {
      suspicions[fact.targetId] = fact.isWolf ? 97 : 4;
    }
  }

  // 主観的な疑い助言: 信頼度に応じた重み(当日は満額、過去は半分)
  const adviceCfg = ctxAdviceBonus(ctx);
  for (const a of ctx.advices) {
    if (a.advice.kind !== 'suspicion') continue;
    const target = a.advice.targetId;
    if (suspicions[target] === undefined) continue;
    const hasFact = ctx.sharedFacts.some((f) => f.targetId === target);
    if (hasFact) continue; // 事実がある対象へ主観補正は不要
    const scale = a.day === ctx.matchInfo.day ? 1 : 0.5;
    suspicions[target] = clamp((suspicions[target] ?? 0) + adviceCfg * scale);
  }

  const sorted = Object.entries(suspicions).sort((a, b) => b[1] - a[1]);
  const top = sorted[0]?.[0] ?? null;
  const second = sorted[1];
  const nameOf = (id: PairId | null) =>
    ctx.candidates.find((c) => c.pairId === id)?.name ?? '(不明)';

  // 襲撃優先度(狼のみ)
  let attackPriorities: Record<PairId, number> | undefined;
  if (isWolf) {
    attackPriorities = {};
    for (const c of ctx.candidates) {
      if (partners.has(c.pairId)) continue;
      let p = 40 + rand(seed, 'attack', opts.stepLabel, c.pairId) * 20;
      if (accusedMe[c.pairId]) p += 20;
      if (accusedPartner[c.pairId]) p += 15;
      // 質問が鋭い(質問系発言が多い)相手=役職持ちらしい相手を優先
      const sharp = ctx.publicLog.filter(
        (e) => e.t === 'speech' && e.pairId === c.pairId && e.text.includes('?'),
      ).length;
      p += Math.min(15, sharp * 5);
      attackPriorities[c.pairId] = clamp(p);
    }
  }

  // スキル対象優先度。
  // 占い役は疑わしい未確定者、騎士は比較的信頼できる生存者を優先する。
  let skillTargetPriorities: Record<PairId, number> | undefined;
  if (self.role === 'seer') {
    skillTargetPriorities = {};
    const known = new Set(ctx.sharedFacts.map((f) => f.targetId));
    for (const c of ctx.candidates) {
      const base = known.has(c.pairId) ? 5 : (suspicions[c.pairId] ?? 50);
      skillTargetPriorities[c.pairId] = clamp(
        base + rand(seed, 'skill', opts.stepLabel, c.pairId) * 10 - 5,
      );
    }
  } else if (self.role === 'guardian') {
    skillTargetPriorities = {};
    for (const c of ctx.candidates) {
      if (c.pairId === ctx.lastGuardTarget?.pairId) continue;
      skillTargetPriorities[c.pairId] = clamp(
        100 - (suspicions[c.pairId] ?? 50) + rand(seed, 'guard', opts.stepLabel, c.pairId) * 10,
      );
    }
  }

  const multiHypothesis = unlocked(reasoning, 'multi_hypothesis');
  const confidence = clamp(
    40 + ((sorted[0]?.[1] ?? 50) - (second?.[1] ?? 50)) * 1.2 + (multiHypothesis ? -5 : 10),
  );

  const primaryHypothesis = isWolf
    ? `${nameOf(scapegoat)}へ疑いを集めれば安全に立ち回れる`
    : `${nameOf(top)}が最も狼憑きらしい`;
  const altHypotheses: string[] = [];
  if (multiHypothesis && second) {
    altHypotheses.push(`${nameOf(second[0])}が役職を隠している可能性もある`);
  }
  if (multiHypothesis && !isWolf && top) {
    altHypotheses.push(`${nameOf(top)}は単に疑いを向けられているだけの市民かもしれない`);
  }

  const questionTargetId = top;
  const themes = ['vote_reason', 'most_suspicious', 'co_plan', 'why_changed'];
  const questionTheme = pickOne(themes, seed, 'qtheme', opts.stepLabel);

  const toShare: string[] = [];
  const toWithhold: string[] = [];
  if (self.role === 'seer') {
    toWithhold.push('自分が占い師であること(状況次第で公開)');
    for (const f of ctx.sharedFacts) {
      if (f.isWolf) toShare.push(`${nameOf(f.targetId)}が狼憑きだという確定情報`);
    }
  } else if (self.role === 'guardian') {
    toWithhold.push('自分が騎士であることと護衛先');
  } else if (self.role === 'medium') {
    toWithhold.push('自分が霊媒師であること(状況次第で公開)');
    for (const f of ctx.sharedFacts) {
      if (f.source === 'medium') {
        toShare.push(`${nameOf(f.targetId)}の霊媒結果`);
      }
    }
  } else if (isWolf) {
    toWithhold.push('自分が狼憑きであること');
    toWithhold.push('仲間の狼のこと');
  } else {
    toShare.push('自分の疑いと根拠');
  }

  return {
    suspicions,
    attackPriorities,
    skillTargetPriorities,
    primaryHypothesis,
    altHypotheses,
    confidence,
    toShare,
    toWithhold,
    questionTargetId,
    questionTheme,
    voteCandidateId: isWolf ? (scapegoat ?? top) : top,
    reasonSummary: isWolf
      ? `狼として${nameOf(scapegoat ?? top)}へ疑いを誘導する方針`
      : `発言と投票の傾向から${nameOf(top)}を第一候補とした`,
  };
}

/** 主観助言の加点。設定(trust.subjectiveAdvice)と信頼度から決まる。 */
function ctxAdviceBonus(ctx: BuddyContext): number {
  return trustBonus(ctx.self.abilities.trust, ctx.trustConfig.subjectiveAdvice);
}

/** 決定論的な発言生成(人格は語尾・言い回しにのみ反映) */
export function mockSpeak(ctx: BuddyContext, ev: EvalOutput, opts: CallOpts): SpeechOutput {
  const seed = `${opts.seed}#${opts.nonce}`;
  const self = ctx.self;
  const persona = self.persona;
  const isWolf = self.role === 'werewolf';
  const deception = self.unlockedDeception;
  const directive = ctx.behaviorDirective?.id ?? null;

  const nameOf = (id: PairId | null) =>
    ctx.candidates.find((c) => c.pairId === id)?.name ?? '誰か';
  const ending = () =>
    persona.mockFlavor.endings.length > 0
      ? pickOne(persona.mockFlavor.endings, seed, 'end', opts.stepLabel, lines.length)
      : '';
  const exclaim = () =>
    persona.mockFlavor.exclamations.length > 0 &&
    rand(seed, 'exc', opts.stepLabel) < 0.5
      ? pickOne(persona.mockFlavor.exclamations, seed, 'exc2', opts.stepLabel) + '、'
      : '';

  const sorted = Object.entries(ev.suspicions).sort((a, b) => b[1] - a[1]);
  const topId = (ev.voteCandidateId ?? sorted[0]?.[0] ?? null) as PairId | null;
  const lines: string[] = [];
  let accusesId: PairId | null = null;
  let declaredRole: SpeechOutput['declaredRole'] = null;
  const turn = ctx.discussionTurn;
  const participantIndex = Math.max(
    0,
    ctx.participants.findIndex((participant) => participant.pairId === self.pairId),
  );
  const speechCount = ctx.publicLog.filter((entry) => entry.t === 'speech').length;
  const angleIndex =
    (ctx.matchInfo.analysisLensRotation + participantIndex + speechCount) % 8;
  // 語尾は「名詞止め+語尾」の形で接続する(どの口調でも自然になる)
  const reasons =
    ctx.matchInfo.day === 1
      ? [
          '質問への答えが論点から外れている',
          '同意に新しい根拠が足されていない',
          '疑い始めたタイミングが流れに乗る形だった',
          '前の発言から今の結論へ急に飛んでいる',
          '相手を庇う理由と評価が噛み合っていない',
          '疑い先を変えた説明がまだない',
          '多数意見への乗り方が早すぎる',
          '弁明への返しが中身より印象に寄っている',
        ]
      : [
          '昨日の投票と今日の疑い先が噛み合っていない',
          '質問への答えが論点から外れている',
          '同意に新しい根拠が足されていない',
          '疑い先を変えた説明がまだない',
          '庇い方と投票先の組み合わせが不自然に見える',
          '疑い始めたタイミングが流れに乗る形だった',
          '昨日の主張から今の結論へ急に飛んでいる',
          '多数意見への乗り方が早すぎる',
        ];
  const reason = () => reasons[angleIndex % reasons.length] ?? reasons[0];
  const hideRole = directive === 'hide_role';

  // 主人から届いた「役職をどう名乗るか」の相談を、親密度と虚言力を含めて
  // 決定論的に採否判断する。信頼100でも必ず採用にはしない。
  const roleProposal = ctx.roleClaimProposal;
  if (roleProposal?.claimedRole) {
    const requestedRole = roleProposal.claimedRole;
    const currentClaim = ctx.publicRoleClaims[self.pairId]?.claimedRole ?? null;
    if (currentClaim !== requestedRole) {
      const isTruth = requestedRole === self.role;
      const trustWeight = self.abilities.trust / 100;
      const deceptionWeight = self.abilities.deception / 100;
      const changePenalty = currentClaim === null ? 0 : 0.15;
      const adoptionChance = Math.min(
        0.95,
        (isTruth ? 0.3 : 0.1) + trustWeight * 0.65 + (isTruth ? 0 : deceptionWeight * 0.2) - changePenalty,
      );
      if (rand(seed, 'role-claim', self.pairId, ctx.matchInfo.day, opts.stepLabel) < adoptionChance) {
        declaredRole = requestedRole;
        lines.push(
          isTruth
            ? `${exclaim()}${persona.firstPerson}は${ROLE_LABEL[requestedRole]}。ここで役職を明かす`
            : `${exclaim()}${persona.firstPerson}は${ROLE_LABEL[requestedRole]}として名乗る`,
        );
      }
    }
  }

  if (turn?.kind === 'opening_defense') {
    const otherFocus = ctx.discussionFocus.find((pair) => pair.pairId !== self.pairId);
    const defenses = isWolf
      ? [
          `${exclaim()}${persona.firstPerson}は狼憑きではない。抽選だけで決めず、この後に理由なく便乗する人を見てほしい`,
          `先に言うけれど、${persona.firstPerson}は狼憑きではない。${otherFocus ? `${otherFocus.name}も含めて、` : ''}言葉と次の投票が合うかで判断してほしい`,
        ]
      : [
          `${exclaim()}${persona.firstPerson}は狼憑きではない。抽選で選ばれただけだから、この後の受け答えと投票まで見て判断してほしい`,
          `身の潔白を先に話すなら、${persona.firstPerson}は市民側だ。${otherFocus ? `${otherFocus.name}も抽選だけでは決めつけず、` : ''}説明の中身を比べてほしい`,
        ];
    return {
      text: pickOne(defenses, seed, 'opening-defense', opts.stepLabel),
      accusesId: null,
      declaredRole: null,
    };
  }

  if (turn?.kind === 'opening_opinion' && ctx.discussionFocus.length > 0) {
    const focusBySuspicion = ctx.discussionFocus
      .map((pair) => ({ ...pair, score: ev.suspicions[pair.pairId] ?? 50 }))
      .sort((a, b) => b.score - a.score);
    const selected = focusBySuspicion[0];
    const other = focusBySuspicion[1];
    if (selected) {
      const scoreGap = selected.score - (other?.score ?? 50);
      const clearContradiction = selected.score >= 75 && scoreGap >= 20 && ev.confidence >= 70;
      const opinions = clearContradiction
        ? [
            `${selected.name}の弁明は聞いた。ただ、説明と今までの主張が噛み合っていないので、ここは具体的に確かめたい`,
            `${other ? `${other.name}より` : ''}${selected.name}の説明には明確な食い違いがある。抽選ではなく、その矛盾を理由に見ている`,
          ]
        : [
            `${selected.name}は質問へどう答えるか見たい。今は疑いより返答の一貫性を重く見る`,
            `${selected.name}へ早く同意する人が出るか見たい。同意に新しい根拠があるかが大事`,
            `この時点で${selected.name}へ疑いが集まるなら、理由なく流れへ乗る人の方を警戒したい`,
            `${selected.name}の弁明は一応筋が通る。${other ? `${other.name}との違いを` : '次の受け答えを'}見てから決めたい`,
            `2人の白黒より、この後に疑い先を急に変える人が出るかを見たい`,
            `同じ意見が続いても、新しい根拠が足されるかを見たい。数だけでは決めない`,
            `${selected.name}への反応が早すぎる人は少し気になる。今は弁明そのものを比べたい`,
            `${other ? `${selected.name}と${other.name}` : selected.name}の言い方より、質問へ正面から答えるかで見たい`,
          ];
      return {
        text: opinions[angleIndex % opinions.length] ?? opinions[0] ?? '次の受け答えを見たい',
        accusesId: clearContradiction ? selected.pairId : null,
        declaredRole: null,
      };
    }
  }

  // 2幕討論では役割を先に固定する。指名された回答者が話題をそらさないことを
  // モックでも保証し、Liveと同じ会話構造を検証できるようにする。
  if (turn?.kind === 'question' && turn.theme && turn.targetName) {
    return {
      text: turn.theme.mockTemplate.replace('{target}', turn.targetName),
      accusesId: null,
      declaredRole: null,
    };
  }
  if (turn?.kind === 'answer' && turn.theme && turn.askerName) {
    const answerByTheme: Record<string, string> = {
      vote_reason:
        ctx.matchInfo.day === 1
          ? 'まだ最初の裁判前だから、昨日の投票はない。今の発言だけで考えている'
          : `${persona.firstPerson}が昨日選んだ相手は、その時点で一番説明が弱く見えたから${ending()}`,
      most_suspicious: topId
        ? `今いちばん疑っているのは${nameOf(topId)}${ending()}。${reason()}のが理由${ending()}`
        : `今はまだ一人に絞れていない${ending()}`,
      co_plan:
        self.role === 'seer' && !hideRole
          ? `必要になれば役職は明かす。でも今この場で明かすかは、もう少し発言を見て決める${ending()}`
          : `${persona.firstPerson}は今のところ、役職を名乗る予定はない`,
      why_cover: `庇うつもりではなく、今ある発言だけでは決めつけられないと言っただけ${ending()}`,
      why_changed: `直前の発言を聞いて評価を更新した。変えた理由はそこ${ending()}`,
    };
    return {
      text: answerByTheme[turn.theme.id] ?? `今ある公開情報だけで答える${ending()}`,
      accusesId: turn.theme.id === 'most_suspicious' ? topId : null,
      declaredRole: null,
    };
  }
  if (turn?.kind === 'follow_up' && turn.targetName) {
    const latestAnswer = [...ctx.publicLog]
      .reverse()
      .find((entry) => entry.t === 'speech' && entry.pairId === turn.targetId);
    const reactions = latestAnswer
      ? [
          `${turn.targetName}の答えは聞いた。理由は分かったけれど、まだ結論は保留する`,
          `${turn.targetName}の返答で考えは少し整理できた。ただ、その説明だけで白とは決めない`,
          `${turn.targetName}は質問には答えた。この返しと冒頭の主張が合うかを見たい`,
        ]
      : [`${turn.targetName}の返答を待って判断したい`];
    return {
      text: pickOne(reactions, seed, 'follow-up', opts.stepLabel),
      accusesId: null,
      declaredRole: null,
    };
  }

  // 1) 確定情報の公開(占い役/霊媒師が共有済みの狼情報を持つ場合)
  const wolfFact = ctx.sharedFacts.find((f) => f.isWolf);
  if (
    (self.role === 'seer' || self.role === 'medium') &&
    wolfFact &&
    !hideRole &&
    ctx.candidates.some((c) => c.pairId === wolfFact.targetId) &&
    rand(seed, 'reveal', ctx.matchInfo.day) < 0.75
  ) {
    const sourceRole = wolfFact.source === 'medium' ? '霊媒師' : '占い師';
    const sourceAction = wolfFact.source === 'medium' ? '霊媒' : '占い';
    lines.push(
      `${exclaim()}${persona.firstPerson}は${sourceRole}${ending()}。${sourceAction}で分かっている、狼憑きは${nameOf(wolfFact.targetId)}${ending()}`,
    );
    declaredRole = self.role;
    accusesId = wolfFact.targetId;
  }

  // 1b) 白確の言及(共有済みの白ファクトがあれば時々卓へ出す)
  const whiteFact = ctx.sharedFacts.find((f) => !f.isWolf);
  if (whiteFact && !hideRole && lines.length === 0 && rand(seed, 'white', opts.stepLabel) < 0.6) {
    const source = whiteFact.source === 'medium' ? '霊媒' : '占い';
    lines.push(`${nameOf(whiteFact.targetId)}は${source}で白と分かっている${ending()}。疑うだけ無駄${ending()}`);
  }

  // 2) 主人からの質問指示(最優先で消化。質問文自体には語尾を付けない)
  if (ctx.pendingQuestion) {
    const q = ctx.pendingQuestion.theme.mockTemplate.replace(
      '{target}',
      ctx.pendingQuestion.targetName,
    );
    lines.push(`${exclaim()}${q}`);
  }

  // 3) メインの発言(役職と虚言力・立ち回り指示で分岐)
  if (lines.length < 2 || persona.verbosity === 'long') {
    if (directive === 'low_profile') {
      lines.push(`今日は聞き役に回るつもり${ending()}`);
    } else if (turn?.kind === 'reaction') {
      const latest = [...ctx.publicLog]
        .reverse()
        .find(
          (entry): entry is Extract<(typeof ctx.publicLog)[number], { t: 'speech' }> =>
            entry.t === 'speech' && entry.pairId !== self.pairId &&
              (!turn.replyToId || entry.pairId === turn.replyToId),
        );
      if (latest) {
        const reactions = turn.replyToName
          ? [
              `${turn.replyToName}の指摘は聞いた。どの言葉からそう見えたのか、こちらの理由も返す`,
              `${turn.replyToName}、疑われたこと自体には反発しない。印象ではなく今の主張を比べてほしい`,
              `${turn.replyToName}の見方は分かった。今は言い返すより、どこが矛盾して見えたのかを整理したい`,
            ]
          : isWolf
          ? [
              `${latest.name}の今の説明は聞いた。すぐ否定せず、次の受け答えまで保留したい`,
              `${latest.name}の言いたいことは分かった。ただ、今の主張と投票が合うかは見ておきたい`,
              `${latest.name}の発言には納得できる部分もある。今は結論を急がない`,
            ]
          : [
              `${latest.name}の今の発言は筋が通る部分もある。いったん受け止めて、他の返答とも比べたい`,
              `${latest.name}の根拠だけではまだ決めきれない。ただ、論点は前より分かりやすくなった`,
              `${latest.name}の今の発言で考えを少し更新した。ここでは結論を保留する`,
            ];
        lines.push(pickOne(reactions, seed, 'reaction', opts.stepLabel));
      }
    } else if (isWolf) {
      const canMisdirect = deception.some((d) => d.id === 'misdirection');
      const canReason = deception.some((d) => d.id === 'plausible_reason');
      const beingAccused = ctx.publicLog.some(
        (e) => e.t === 'speech' && e.accusesId === self.pairId,
      );
      if (beingAccused && !canReason) {
        lines.push(`${exclaim()}${persona.firstPerson}は狼憑きじゃない。それだけは本当${ending()}`);
      } else if (canMisdirect && topId) {
        lines.push(
          ctx.matchInfo.day === 1
            ? `${exclaim()}${persona.firstPerson}が引っかかっているのは${nameOf(topId)}の今の誘導${ending()}。疑い先と理由が噛み合っていないのが理由${ending()}`
            : `${exclaim()}${persona.firstPerson}が引っかかっているのは${nameOf(topId)}の昨日からの動き${ending()}。発言と投票が噛み合っていないのが理由${ending()}`,
        );
        accusesId = topId;
      } else if (canReason && topId) {
        lines.push(`${persona.firstPerson}が気になっているのは${nameOf(topId)}${ending()}。理由は、${reason()}から${ending()}`);
        accusesId = topId;
      } else {
        lines.push(`正直、まだ五分五分${ending()}。少なくとも${persona.firstPerson}は狼憑きじゃない`);
      }
    } else if (
      !isWolf &&
      ctx.publicLog.some((e) => e.t === 'speech' && e.accusesId === self.pairId) &&
      rand(seed, 'defend', opts.stepLabel) < 0.5
    ) {
      lines.push(
        `${persona.firstPerson}を疑う声があるようだけど、${persona.firstPerson}は狼憑きじゃない。むしろ気になるのは${topId ? nameOf(topId) : '別の組'}${ending()}`,
      );
      if (topId) accusesId = accusesId ?? topId;
    } else if (topId && (directive === 'push_hard' || (ev.confidence >= 48 && sorted.length > 0))) {
      lines.push(
        `${exclaim()}${persona.firstPerson}が一番怪しいと思うのは${nameOf(topId)}${ending()}。${reason()}のが理由${ending()}`,
      );
      accusesId = accusesId ?? topId;
    } else if (topId) {
      lines.push(`まだ確信はないけれど、強いて言えば${nameOf(topId)}${ending()}`);
      accusesId = accusesId ?? topId;
    } else {
      lines.push(`${persona.firstPerson}はまだ様子見${ending()}`);
    }
  }

  const maxLines = persona.verbosity === 'short' ? 1 : 2;
  const text = lines.slice(0, maxLines).join(' ');
  return { text, accusesId, declaredRole };
}
