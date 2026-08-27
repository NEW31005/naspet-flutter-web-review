/**
 * ゲームエンジン。
 * - 入力(AI提案・主人操作)を検証し、正式なイベント列を生成する
 * - AI出力は「提案」であり、ここを通らない限り状態へ反映されない
 * - 乱数は (seed + ラベル) から決定論的に導出する
 */
import type {
  Advice,
  ConfigSnapshot,
  EvalOutput,
  Fact,
  MasterPolicy,
  MatchEvent,
  MatchMode,
  PairId,
  PairSetup,
  Phase,
  Role,
  SpeechOutput,
  Visibility,
} from '@aibw/shared';
import { ROLE_TEAM, pickOne, shuffle } from '@aibw/shared';
import {
  alivePairs,
  aliveWolves,
  getPair,
  rebuildState,
  reduce,
  type MatchState,
} from './state.js';
import { checkWin, decideWithTrust, integrateAttack, tallyVotes } from './rules.js';

export class GameRuleError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'GameRuleError';
  }
}

export type PendingTask =
  | {
      type: 'wait_inputs';
      missing: {
        pairId: PairId;
        input: 'discussion_advice' | 'trial_choice' | 'night_proposal';
      }[];
    }
  | { type: 'ai_speech'; pairId: PairId; round: number }
  | { type: 'start_discussion_response' }
  | { type: 'ai_votes'; pairIds: PairId[] }
  | { type: 'ai_night'; wolfPairIds: PairId[]; seerPairId: PairId | null }
  | { type: 'advance_day' }
  | { type: 'finished' };

const PUBLIC: Visibility = { kind: 'public' };
const GM: Visibility = { kind: 'gm' };
const forPair = (pairId: PairId, part: 'master' | 'buddy' | 'both'): Visibility => ({
  kind: 'pairs',
  pairIds: [pairId],
  part,
});

/** 判別可能ユニオンを保ったままキーを除外する */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventDraft = DistributiveOmit<MatchEvent, 'seq' | 'ts' | 'day' | 'phase'> & {
  day?: number;
  phase?: Phase;
};

/** イベント組み立てヘルパー */
class EventBatch {
  events: MatchEvent[] = [];
  private seq: number;
  constructor(
    private state: MatchState,
    private now: number,
  ) {
    this.seq = state.nextSeq;
  }
  push(partial: EventDraft): void {
    const ev = {
      seq: this.seq++,
      ts: this.now,
      day: partial.day ?? this.currentDay(),
      phase: partial.phase ?? this.currentPhase(),
      ...partial,
    } as MatchEvent;
    this.events.push(ev);
    this.state = reduce(this.state, ev);
  }
  currentDay(): number {
    return this.state.day;
  }
  currentPhase(): Phase {
    return this.state.phase;
  }
  get current(): MatchState {
    return this.state;
  }
}

export interface CreateMatchParams {
  matchId: string;
  seed: string;
  mode: MatchMode;
  provider: string;
  humanPairIndex: number | null; // playモードで人間が担当する組(0始まり)
  config: ConfigSnapshot;
  otherMastersPolicy?: MasterPolicy;
  now: number;
}

/** 試合を作成し、初期イベント列を返す。 */
export function createMatch(params: CreateMatchParams): { events: MatchEvent[]; state: MatchState } {
  const { config } = params;
  const rules = config.rules;
  if (config.buddies.length < rules.pairCount) {
    throw new GameRuleError(
      `バディが不足しています(必要${rules.pairCount}、現在${config.buddies.length})`,
      'not_enough_buddies',
    );
  }
  const pairs: PairSetup[] = [];
  for (let i = 0; i < rules.pairCount; i++) {
    const buddy = config.buddies[i];
    if (!buddy) throw new GameRuleError('バディ設定が不正です', 'invalid_buddies');
    pairs.push({
      pairId: `p${i + 1}`,
      masterName: `${buddy.persona.name}の主人`,
      buddy,
    });
  }
  const humanPairId =
    params.mode === 'play' && params.humanPairIndex != null
      ? (pairs[params.humanPairIndex]?.pairId ?? null)
      : null;

  // 役職配布(シード付きシャッフル)
  const roleList: Role[] = [];
  for (let i = 0; i < rules.roleSetup.werewolf; i++) roleList.push('werewolf');
  for (let i = 0; i < rules.roleSetup.seer; i++) roleList.push('seer');
  while (roleList.length < rules.pairCount) roleList.push('villager');
  const shuffled = shuffle(roleList, params.seed, 'roles');
  const roles: Record<PairId, Role> = {};
  pairs.forEach((p, i) => {
    roles[p.pairId] = shuffled[i] ?? 'villager';
  });

  const created: MatchEvent = {
    seq: 0,
    ts: params.now,
    day: 1,
    phase: 'day_start',
    visibility: PUBLIC,
    type: 'match_created',
    payload: {
      matchId: params.matchId,
      seed: params.seed,
      mode: params.mode,
      provider: params.provider,
      humanPairId,
      otherMastersPolicy: params.otherMastersPolicy ?? rules.otherMastersPolicy,
      pairs,
      configVersions: config.versions,
    },
  };
  let state = rebuildState([created], config);
  const batch = new EventBatch(state, params.now);
  batch.push({ type: 'roles_assigned', visibility: GM, payload: { roles } });
  if (rules.firstNightDivination) {
    // 0日目占い: 主人にのみ届く。共有するかは主人(またはポリシー)の判断(原則1は不変)
    const seerId = pairs.find((p) => roles[p.pairId] === 'seer')?.pairId;
    if (seerId) {
      const candidates = pairs
        .map((p) => p.pairId)
        .filter((id) => id !== seerId)
        .filter((id) => rules.firstNightDivination !== 'white' || ROLE_TEAM[roles[id] ?? 'villager'] !== 'wolves');
      if (candidates.length === 0) {
        throw new GameRuleError(
          '初日占いの対象がいません。白通知を使う場合は、占い役以外の市民陣営を1組以上設定してください',
          'first_divination_no_target',
        );
      }
      const targetId = pickOne(candidates, params.seed, 'first-divination');
      const fact: Fact = {
        id: `fact-d0-${seerId}`,
        day: 0,
        targetId,
        isWolf: ROLE_TEAM[roles[targetId] ?? 'villager'] === 'wolves',
        source: 'divination',
      };
      batch.push({
        type: 'divination',
        visibility: forPair(seerId, 'master'),
        payload: { seerPairId: seerId, targetId, fact },
      });
    }
  }
  batch.push({
    type: 'day_started',
    visibility: PUBLIC,
    payload: { day: 1, deaths: [] },
  });
  state = batch.current;
  return { events: [created, ...batch.events], state };
}

/** 次にやるべきことを返す。 */
export function getPendingTask(state: MatchState): PendingTask {
  if (state.winner || state.phase === 'finished') return { type: 'finished' };
  switch (state.phase) {
    case 'day_start':
      return { type: 'advance_day' };
    case 'discussion': {
      const d = state.discussion;
      if (!d) return { type: 'advance_day' };
      const next = d.queue[d.cursor];
      if (!next) {
        if (d.stage === 'advice') {
          const human = state.humanPairId ? state.pairs.find((p) => p.pairId === state.humanPairId) : null;
          if (
            human?.alive &&
            state.config.rules.advicePerDay > 0 &&
            (state.adviceUsedToday[human.pairId] ?? 0) < state.config.rules.advicePerDay
          ) {
            return {
              type: 'wait_inputs',
              missing: [{ pairId: human.pairId, input: 'discussion_advice' }],
            };
          }
          return { type: 'start_discussion_response' };
        }
        // 通常はapplySpeechで遷移済みのため到達しない
        return { type: 'advance_day' };
      }
      return { type: 'ai_speech', pairId: next.pairId, round: next.round };
    }
    case 'trial': {
      const missing = alivePairs(state)
        .filter((p) => state.trialChoices[p.pairId] === undefined)
        .map((p) => ({ pairId: p.pairId, input: 'trial_choice' as const }));
      if (missing.length > 0) return { type: 'wait_inputs', missing };
      return { type: 'ai_votes', pairIds: alivePairs(state).map((p) => p.pairId) };
    }
    case 'night': {
      const missing = aliveWolves(state)
        .filter((p) => state.nightProposals[p.pairId] === undefined)
        .map((p) => ({ pairId: p.pairId, input: 'night_proposal' as const }));
      if (missing.length > 0) return { type: 'wait_inputs', missing };
      const seer = alivePairs(state).find((p) => p.role === 'seer');
      return {
        type: 'ai_night',
        wolfPairIds: aliveWolves(state).map((p) => p.pairId),
        seerPairId: seer?.pairId ?? null,
      };
    }
  }
}

/** day_start → discussion への遷移 */
export function applyAdvanceDay(state: MatchState, now: number): MatchEvent[] {
  if (state.phase !== 'day_start') {
    throw new GameRuleError('day_startフェーズではありません', 'wrong_phase');
  }
  const batch = new EventBatch(state, now);
  batch.push({
    type: 'phase_changed',
    visibility: PUBLIC,
    day: state.day,
    phase: 'day_start',
    payload: { day: state.day, phase: 'discussion' },
  });
  return batch.events;
}

/** 主人の相談後に第2幕を開始する。会話順はstate reducerが決定論的に構築する。 */
export function applyStartDiscussionResponse(state: MatchState, now: number): MatchEvent[] {
  if (
    state.phase !== 'discussion' ||
    !state.discussion ||
    state.discussion.stage !== 'advice'
  ) {
    throw new GameRuleError('相談後の討論を開始できる状態ではありません', 'wrong_discussion_stage');
  }
  const batch = new EventBatch(state, now);
  batch.push({
    type: 'discussion_stage_changed',
    visibility: PUBLIC,
    payload: { stage: 'response' },
  });
  return batch.events;
}

/** 主人の助言(討論中のみ・1日の回数制限あり) */
export function applyAdvice(
  state: MatchState,
  pairId: PairId,
  advice: Advice,
  now: number,
): MatchEvent[] {
  if (state.phase !== 'discussion') {
    throw new GameRuleError('助言は討論中のみ送れます', 'advice_wrong_phase');
  }
  if (
    state.config.rules.discussionRounds > 1 &&
    state.discussion?.stage !== 'advice'
  ) {
    throw new GameRuleError(
      '助言は冒頭討論が終わってから送れます',
      'advice_before_intermission',
    );
  }
  const pair = getPair(state, pairId);
  if (!pair.alive) throw new GameRuleError('死亡した組は助言できません', 'pair_dead');
  const used = state.adviceUsedToday[pairId] ?? 0;
  if (used >= state.config.rules.advicePerDay) {
    throw new GameRuleError('本日の助言回数を使い切っています', 'advice_limit');
  }
  const menuItem = state.config.advice.menu.find((m) => m.kind === advice.kind);
  if (!menuItem || !menuItem.enabled) {
    throw new GameRuleError('この助言は使用できません', 'advice_disabled');
  }

  const assertTarget = (targetId: PairId) => {
    const t = getPair(state, targetId);
    if (!t.alive) throw new GameRuleError('対象は死亡しています', 'target_dead');
    if (t.pairId === pairId) throw new GameRuleError('自分の組は対象にできません', 'target_self');
  };

  let sharedFact: Fact | null = null;
  switch (advice.kind) {
    case 'suspicion':
    case 'question':
      assertTarget(advice.targetId);
      if (advice.kind === 'question') {
        const theme = state.config.advice.questionThemes.find((t) => t.id === advice.themeId);
        if (!theme) throw new GameRuleError('不明な質問テーマです', 'unknown_theme');
      }
      break;
    case 'skill_target':
      assertTarget(advice.targetId);
      if (pair.role !== 'seer') {
        throw new GameRuleError('スキルを持つ役職ではありません', 'no_skill');
      }
      break;
    case 'behavior': {
      const d = state.config.advice.behaviorDirectives.find((x) => x.id === advice.directiveId);
      if (!d) throw new GameRuleError('不明な立ち回り指示です', 'unknown_directive');
      break;
    }
    case 'fact_share': {
      const fact = (state.facts[pairId] ?? []).find((f) => f.id === advice.factId);
      if (!fact) throw new GameRuleError('その確定情報を持っていません', 'unknown_fact');
      if ((state.sharedFactIds[pairId] ?? []).includes(fact.id)) {
        throw new GameRuleError('すでに共有済みです', 'already_shared');
      }
      sharedFact = fact;
      break;
    }
  }

  const batch = new EventBatch(state, now);
  batch.push({
    type: 'advice_given',
    visibility: forPair(pairId, 'both'),
    payload: { pairId, advice },
  });
  if (sharedFact) {
    batch.push({
      type: 'fact_shared',
      visibility: forPair(pairId, 'both'),
      payload: { pairId, fact: sharedFact },
    });
  }
  return batch.events;
}

/** バディの公開発言(評価出力とセットで正式化) */
export function applySpeech(
  state: MatchState,
  pairId: PairId,
  evalOutput: EvalOutput,
  callId: string,
  speech: SpeechOutput,
  now: number,
): MatchEvent[] {
  if (state.phase !== 'discussion' || !state.discussion) {
    throw new GameRuleError('討論フェーズではありません', 'wrong_phase');
  }
  const next = state.discussion.queue[state.discussion.cursor];
  if (!next || next.pairId !== pairId) {
    throw new GameRuleError('発言順ではありません', 'not_your_turn');
  }
  const pair = getPair(state, pairId);
  if (!pair.alive) throw new GameRuleError('死亡した組は発言できません', 'pair_dead');

  const text = speech.text.trim().slice(0, 1200);
  if (!text) throw new GameRuleError('発言が空です', 'empty_speech');
  const accusesId =
    speech.accusesId && state.pairs.some((p) => p.pairId === speech.accusesId && p.alive)
      ? speech.accusesId
      : null;

  const batch = new EventBatch(state, now);
  batch.push({
    type: 'eval_recorded',
    visibility: GM,
    payload: { pairId, kind: 'discussion', callId, output: sanitizeEval(state, pairId, evalOutput) },
  });
  batch.push({
    type: 'speech',
    visibility: PUBLIC,
    payload: {
      pairId,
      round: next.round,
      turnKind: next.kind,
      question: next.question,
      text,
      accusesId,
    },
  });
  // 第1幕終了なら主人の相談待ちへ。第2幕以降が終われば裁判へ。
  const after = batch.current;
  if (after.discussion && after.discussion.cursor >= after.discussion.queue.length) {
    if (
      after.discussion.stage === 'opening' &&
      after.config.rules.discussionRounds > 1
    ) {
      batch.push({
        type: 'discussion_stage_changed',
        visibility: PUBLIC,
        payload: { stage: 'advice' },
      });
    } else {
      batch.push({
        type: 'phase_changed',
        visibility: PUBLIC,
        payload: { day: after.day, phase: 'trial' },
      });
    }
  }
  return batch.events;
}

/** 評価出力の候補キーを実在の生存者に限定する(AI出力は信用しない) */
function sanitizeEval(state: MatchState, selfId: PairId, output: EvalOutput): EvalOutput {
  const validIds = new Set(
    alivePairs(state)
      .filter((p) => p.pairId !== selfId)
      .map((p) => p.pairId),
  );
  const clean = (rec: Record<PairId, number> | undefined): Record<PairId, number> | undefined => {
    if (!rec) return undefined;
    const out: Record<PairId, number> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (validIds.has(k)) out[k] = Math.min(100, Math.max(0, v));
    }
    return out;
  };
  return {
    ...output,
    suspicions: clean(output.suspicions) ?? {},
    attackPriorities: clean(output.attackPriorities),
    skillTargetPriorities: clean(output.skillTargetPriorities),
    questionTargetId:
      output.questionTargetId && validIds.has(output.questionTargetId)
        ? output.questionTargetId
        : null,
    voteCandidateId:
      output.voteCandidateId && validIds.has(output.voteCandidateId) ? output.voteCandidateId : null,
  };
}

/** 裁判: 主人の意思表示(直接の一票にはならない) */
export function applyTrialChoice(
  state: MatchState,
  pairId: PairId,
  targetId: PairId | null,
  now: number,
): MatchEvent[] {
  if (state.phase !== 'trial') {
    throw new GameRuleError('裁判フェーズではありません', 'wrong_phase');
  }
  const pair = getPair(state, pairId);
  if (!pair.alive) throw new GameRuleError('死亡した組は選択できません', 'pair_dead');
  if (state.trialChoices[pairId] !== undefined) {
    throw new GameRuleError('すでに選択済みです', 'already_chosen');
  }
  if (targetId != null) {
    const t = getPair(state, targetId);
    if (!t.alive) throw new GameRuleError('対象は死亡しています', 'target_dead');
    if (t.pairId === pairId) throw new GameRuleError('自分の組は選べません', 'target_self');
  }
  const batch = new EventBatch(state, now);
  batch.push({
    type: 'trial_choice',
    visibility: forPair(pairId, 'master'),
    payload: { pairId, targetId },
  });
  return batch.events;
}

/** 夜: 狼主人の襲撃提案(最終決定はAI) */
export function applyNightProposal(
  state: MatchState,
  pairId: PairId,
  targetId: PairId | null,
  now: number,
): MatchEvent[] {
  if (state.phase !== 'night') {
    throw new GameRuleError('夜フェーズではありません', 'wrong_phase');
  }
  const pair = getPair(state, pairId);
  if (!pair.alive) throw new GameRuleError('死亡した組は提案できません', 'pair_dead');
  if (pair.role !== 'werewolf') {
    throw new GameRuleError('狼憑きではありません', 'not_wolf');
  }
  if (state.nightProposals[pairId] !== undefined) {
    throw new GameRuleError('すでに提案済みです', 'already_proposed');
  }
  if (targetId != null) {
    const t = getPair(state, targetId);
    if (!t.alive) throw new GameRuleError('対象は死亡しています', 'target_dead');
    if (ROLE_TEAM[t.role] === 'wolves') {
      throw new GameRuleError('狼陣営は襲撃できません', 'target_wolf');
    }
  }
  const batch = new EventBatch(state, now);
  batch.push({
    type: 'night_proposal',
    visibility: forPair(pairId, 'master'),
    payload: { pairId, targetId },
  });
  return batch.events;
}

/**
 * 裁判の投票解決。
 * 各バディの評価(怪しい度)へ主人の裁判選択の信頼度補正を加え、最終投票を決める。
 * 主人とAIの選択が異なることを明示的に許容する。
 */
export function applyVotes(
  state: MatchState,
  evals: Record<PairId, { output: EvalOutput; callId: string }>,
  now: number,
): MatchEvent[] {
  if (state.phase !== 'trial') {
    throw new GameRuleError('裁判フェーズではありません', 'wrong_phase');
  }
  const missing = alivePairs(state).filter((p) => state.trialChoices[p.pairId] === undefined);
  if (missing.length > 0) {
    throw new GameRuleError('主人の選択が揃っていません', 'choices_missing');
  }
  const batch = new EventBatch(state, now);
  const votes: { pairId: PairId; targetId: PairId }[] = [];

  for (const pair of alivePairs(state)) {
    const entry = evals[pair.pairId];
    if (!entry) throw new GameRuleError(`評価がありません: ${pair.pairId}`, 'eval_missing');
    const output = sanitizeEval(state, pair.pairId, entry.output);
    const candidates = alivePairs(state)
      .filter((p) => p.pairId !== pair.pairId)
      .map((p) => p.pairId);
    const masterChoice = state.trialChoices[pair.pairId] ?? null;
    const buddy = state.config.buddies.find((b) => b.id === pair.buddyId);
    const trust = buddy?.abilities.trust ?? 0;
    const decision = decideWithTrust({
      candidates,
      baseScores: output.suspicions,
      defaultScore: 50,
      masterProposalId: masterChoice,
      trust,
      trustCfg: state.config.rules.trust.trialChoice,
      seed: state.seed,
      rngLabels: ['vote-tie', state.day, pair.pairId, state.rewindNonce],
    });
    if (!decision.targetId) {
      throw new GameRuleError('投票先を決定できません', 'no_candidates');
    }
    batch.push({
      type: 'eval_recorded',
      visibility: GM,
      payload: { pairId: pair.pairId, kind: 'vote', callId: entry.callId, output },
    });
    batch.push({
      type: 'vote_detail',
      visibility: GM,
      payload: {
        pairId: pair.pairId,
        baseScores: decision.baseScores,
        adjustedScores: decision.adjustedScores,
        masterChoiceId: masterChoice,
        trustBonusApplied: decision.bonusApplied,
      },
    });
    votes.push({ pairId: pair.pairId, targetId: decision.targetId });
  }

  for (const v of votes) {
    batch.push({
      type: 'vote_cast',
      visibility: PUBLIC,
      payload: { pairId: v.pairId, targetId: v.targetId },
    });
  }

  const result = tallyVotes(votes, state.seed, ['exec-tie', state.day, state.rewindNonce]);
  batch.push({
    type: 'execution',
    visibility: PUBLIC,
    payload: { targetId: result.targetId, tally: result.tally, tie: result.tie },
  });

  const after = batch.current;
  const win = checkWin(after);
  if (win) {
    batch.push({
      type: 'match_finished',
      visibility: PUBLIC,
      payload: { winner: win.winner, roles: rolesOf(after), reason: win.reason },
    });
  } else {
    batch.push({
      type: 'phase_changed',
      visibility: PUBLIC,
      payload: { day: after.day, phase: 'night' },
    });
  }
  return batch.events;
}

function rolesOf(state: MatchState): Record<PairId, Role> {
  return Object.fromEntries(state.pairs.map((p) => [p.pairId, p.role]));
}

/**
 * 夜の解決。
 * - 占い役: AIが占い先を決定(主人のスキル提案は信頼度補正)。結果は主人だけに届く。
 * - 狼: 各狼AIの補正後優先度を統合して最終襲撃先を決定。
 */
export function applyNight(
  state: MatchState,
  evals: Record<PairId, { output: EvalOutput; callId: string }>,
  now: number,
): MatchEvent[] {
  if (state.phase !== 'night') {
    throw new GameRuleError('夜フェーズではありません', 'wrong_phase');
  }
  const missingWolves = aliveWolves(state).filter(
    (p) => state.nightProposals[p.pairId] === undefined,
  );
  if (missingWolves.length > 0) {
    throw new GameRuleError('狼主人の提案が揃っていません', 'proposals_missing');
  }
  const batch = new EventBatch(state, now);
  const trustOf = (buddyId: string): number =>
    state.config.buddies.find((b) => b.id === buddyId)?.abilities.trust ?? 0;

  // --- 占い ---
  const seer = alivePairs(state).find((p) => p.role === 'seer');
  if (seer) {
    const entry = evals[seer.pairId];
    if (!entry) throw new GameRuleError(`占い役の評価がありません: ${seer.pairId}`, 'eval_missing');
    const output = sanitizeEval(state, seer.pairId, entry.output);
    const divined = new Set(state.divined[seer.pairId] ?? []);
    let candidates = alivePairs(state)
      .filter((p) => p.pairId !== seer.pairId && !divined.has(p.pairId))
      .map((p) => p.pairId);
    if (candidates.length === 0) {
      candidates = alivePairs(state)
        .filter((p) => p.pairId !== seer.pairId)
        .map((p) => p.pairId);
    }
    if (candidates.length > 0) {
      const proposal = state.skillProposal[seer.pairId] ?? null;
      const decision = decideWithTrust({
        candidates,
        baseScores: output.skillTargetPriorities ?? output.suspicions,
        defaultScore: 50,
        masterProposalId: proposal && candidates.includes(proposal) ? proposal : null,
        trust: trustOf(seer.buddyId),
        trustCfg: state.config.rules.trust.skillProposal,
        seed: state.seed,
        rngLabels: ['divine-tie', state.day, state.rewindNonce],
      });
      batch.push({
        type: 'eval_recorded',
        visibility: GM,
        payload: { pairId: seer.pairId, kind: 'night', callId: entry.callId, output },
      });
      if (decision.targetId) {
        const target = getPair(state, decision.targetId);
        const fact: Fact = {
          id: `fact-d${state.day}-${seer.pairId}`,
          day: state.day,
          targetId: target.pairId,
          isWolf: ROLE_TEAM[target.role] === 'wolves',
          source: 'divination',
        };
        batch.push({
          type: 'divination_detail',
          visibility: GM,
          payload: {
            seerPairId: seer.pairId,
            basePriorities: decision.baseScores,
            adjustedPriorities: decision.adjustedScores,
            masterProposalId: state.skillProposal[seer.pairId] ?? null,
          },
        });
        batch.push({
          type: 'divination',
          visibility: forPair(seer.pairId, 'master'),
          payload: { seerPairId: seer.pairId, targetId: target.pairId, fact },
        });
      }
    }
  }

  // --- 狼の襲撃 ---
  const wolves = aliveWolves(state);
  let attackTargetId: PairId | null = null;
  if (wolves.length > 0) {
    const candidates = alivePairs(state)
      .filter((p) => ROLE_TEAM[p.role] !== 'wolves')
      .map((p) => p.pairId);
    if (candidates.length > 0) {
      const perWolf: {
        pairId: PairId;
        masterProposalId: PairId | null;
        basePriorities: Record<PairId, number>;
        adjustedPriorities: Record<PairId, number>;
        topCandidateId: PairId | null;
      }[] = [];
      for (const wolf of wolves) {
        const entry = evals[wolf.pairId];
        if (!entry) {
          throw new GameRuleError(`狼の評価がありません: ${wolf.pairId}`, 'eval_missing');
        }
        const output = sanitizeEval(state, wolf.pairId, entry.output);
        const proposal = state.nightProposals[wolf.pairId] ?? null;
        const decision = decideWithTrust({
          candidates,
          baseScores: output.attackPriorities ?? {},
          defaultScore: 30,
          masterProposalId: proposal && candidates.includes(proposal) ? proposal : null,
          trust: trustOf(wolf.buddyId),
          trustCfg: state.config.rules.trust.nightProposal,
          seed: state.seed,
          rngLabels: ['wolf-top-tie', state.day, wolf.pairId, state.rewindNonce],
        });
        batch.push({
          type: 'eval_recorded',
          visibility: GM,
          payload: { pairId: wolf.pairId, kind: 'night', callId: entry.callId, output },
        });
        perWolf.push({
          pairId: wolf.pairId,
          masterProposalId: proposal,
          basePriorities: decision.baseScores,
          adjustedPriorities: decision.adjustedScores,
          topCandidateId: decision.targetId,
        });
      }
      const integrated = integrateAttack({
        method: state.config.rules.wolfAttackIntegration.method,
        candidates,
        perWolf: perWolf.map((w) => ({ pairId: w.pairId, adjustedScores: w.adjustedPriorities })),
        seed: state.seed,
        rngLabels: ['attack-tie', state.day, state.rewindNonce],
      });
      attackTargetId = integrated.targetId;
      batch.push({
        type: 'attack_detail',
        visibility: GM,
        payload: {
          perWolf,
          integrated: integrated.integrated,
          method: state.config.rules.wolfAttackIntegration.method,
          targetId: integrated.targetId,
          tie: integrated.tie,
        },
      });
      for (const w of perWolf) {
        batch.push({
          type: 'wolf_night_report',
          visibility: forPair(w.pairId, 'master'),
          payload: {
            pairId: w.pairId,
            masterProposalId: w.masterProposalId,
            buddyTopId: w.topCandidateId,
            finalTargetId: integrated.targetId,
          },
        });
      }
      batch.push({
        type: 'attack_resolved',
        visibility: GM,
        payload: { targetId: attackTargetId },
      });
    }
  }

  // --- 勝敗と翌日 ---
  const after = batch.current;
  const win = checkWin(after);
  if (win) {
    batch.push({
      type: 'match_finished',
      visibility: PUBLIC,
      payload: { winner: win.winner, roles: rolesOf(after), reason: win.reason },
    });
  } else if (after.day >= after.config.rules.maxDays) {
    batch.push({
      type: 'match_finished',
      visibility: PUBLIC,
      payload: {
        winner: 'draw',
        roles: rolesOf(after),
        reason: `最大日数(${after.config.rules.maxDays}日)に達した`,
      },
    });
  } else {
    const nextDay = after.day + 1;
    batch.push({
      type: 'phase_changed',
      visibility: PUBLIC,
      payload: { day: nextDay, phase: 'day_start' },
    });
    batch.push({
      type: 'day_started',
      visibility: PUBLIC,
      day: nextDay,
      phase: 'day_start',
      payload: {
        day: nextDay,
        deaths: attackTargetId ? [{ pairId: attackTargetId, cause: 'attack' as const }] : [],
      },
    });
  }
  return batch.events;
}

/**
 * 現在のフェーズ先頭まで巻き戻すためのイベント列を計算する(Lab用)。
 * 返り値は「切り詰め後のイベント列」。呼び出し側で置き換える。
 */
export function rewindToPhaseStart(events: MatchEvent[], config: ConfigSnapshot, now: number): MatchEvent[] {
  let lastPhaseIdx = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i]?.type === 'phase_changed') lastPhaseIdx = i;
  }
  if (lastPhaseIdx < 0) return events;
  const truncated = events.slice(0, lastPhaseIdx + 1);
  const state = rebuildState(truncated, config);
  const batch = new EventBatch(state, now);
  batch.push({
    type: 'rewound',
    visibility: GM,
    payload: { toSeq: truncated[truncated.length - 1]?.seq ?? 0, nonce: state.rewindNonce + 1 },
  });
  return [...truncated, ...batch.events];
}
