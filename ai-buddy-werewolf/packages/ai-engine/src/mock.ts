/**
 * モックAIプロバイダー。
 * APIキーなしでゲーム進行・情報可視性・投票・襲撃・保存を確認するための決定論的AI。
 * 完璧な人狼AIではないが、能力値(推論力/虚言力/信頼度)の差が挙動に出るよう作ってある。
 * シード+ラベルから導出する乱数のみを使うため、同じシードなら同じ試合を再現できる。
 */
import type { EvalOutput, PairId, SpeechOutput } from '@aibw/shared';
import { pickOne, rand } from '@aibw/shared';
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

  // 占い先優先度(占い役のみ): 疑わしいが確定していない相手
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
    toWithhold.push('自分が占い役であること(状況次第で公開)');
    for (const f of ctx.sharedFacts) {
      if (f.isWolf) toShare.push(`${nameOf(f.targetId)}が狼憑きだという確定情報`);
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

  // 語尾は「名詞止め+語尾」の形で接続する(どの口調でも自然になる)
  const reasons = [
    '発言がふわっとしている',
    '投票の理由が曖昧',
    '流れに乗っているだけに見える',
    '昨日と言っていることが違う',
  ];
  const reason = () => pickOne(reasons, seed, 'reason', opts.stepLabel);

  // 1) 確定情報の公開(占い役が共有済みの狼情報を持つ場合)
  const wolfFact = ctx.sharedFacts.find((f) => f.isWolf);
  const hideRole = directive === 'hide_role';
  if (
    self.role === 'seer' &&
    wolfFact &&
    !hideRole &&
    ctx.candidates.some((c) => c.pairId === wolfFact.targetId) &&
    rand(seed, 'reveal', ctx.matchInfo.day) < 0.75
  ) {
    lines.push(
      `${exclaim()}${persona.firstPerson}は占い役${ending()}。占いで分かっている、狼憑きは${nameOf(wolfFact.targetId)}${ending()}`,
    );
    accusesId = wolfFact.targetId;
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
          `${exclaim()}${persona.firstPerson}が引っかかっているのは${nameOf(topId)}の昨日からの動き${ending()}。発言と投票が噛み合っていないのが理由${ending()}`,
        );
        accusesId = topId;
      } else if (canReason && topId) {
        lines.push(`${persona.firstPerson}が気になっているのは${nameOf(topId)}${ending()}。理由は、${reason()}から${ending()}`);
        accusesId = topId;
      } else {
        lines.push(`正直、まだ五分五分${ending()}。少なくとも${persona.firstPerson}は狼憑きじゃない`);
      }
    } else if (topId && (directive === 'push_hard' || (ev.confidence >= 55 && sorted.length > 0))) {
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

  const maxLines = persona.verbosity === 'short' ? 1 : persona.verbosity === 'medium' ? 2 : 3;
  const text = lines.slice(0, maxLines).join(' ');
  return { text, accusesId };
}
