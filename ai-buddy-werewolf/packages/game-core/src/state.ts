/**
 * 試合状態とリデューサー。
 * 状態は必ずイベント列から再構築できる(リプレイ・巻き戻しの根拠)。
 * AI出力が直接状態を書き換えることはなく、engine.ts が検証してイベント化する。
 */
import type {
  Advice,
  BehaviorDirective,
  ConfigSnapshot,
  DiscussionStage,
  DiscussionTurn,
  DiscussionTurnKind,
  EvalOutput,
  Fact,
  MasterPolicy,
  MatchEvent,
  MatchMode,
  PairId,
  Phase,
  Role,
  Winner,
} from '@aibw/shared';
import { ROLE_TEAM } from '@aibw/shared';

export interface PairState {
  pairId: PairId;
  masterName: string;
  buddyName: string;
  buddyId: string;
  role: Role;
  alive: boolean;
  deathDay: number | null;
  deathCause: 'execution' | 'attack' | null;
}

export type PublicLogEntry =
  | { seq: number; day: number; t: 'day_start'; deaths: { pairId: PairId; name: string }[] }
  | { seq: number; day: number; t: 'phase'; phase: Phase }
  | {
      seq: number;
      day: number;
      t: 'speech';
      round: number;
      turnKind: DiscussionTurnKind;
      question?: DiscussionTurn['question'];
      pairId: PairId;
      name: string;
      text: string;
      /** 発言中で主に疑いを向けた相手(公開発言から読み取れる情報) */
      accusesId: PairId | null;
    }
  | { seq: number; day: number; t: 'discussion_stage'; stage: DiscussionStage }
  | {
      seq: number;
      day: number;
      t: 'vote';
      pairId: PairId;
      name: string;
      targetId: PairId;
      targetName: string;
    }
  | {
      seq: number;
      day: number;
      t: 'execution';
      targetId: PairId | null;
      targetName: string | null;
      tally: Record<PairId, number>;
      tie: boolean;
      revealedRole: Role | null;
    }
  | { seq: number; day: number; t: 'finish'; winner: Winner; reason: string };

export interface DiscussionState {
  stage: DiscussionStage;
  queue: DiscussionTurn[];
  cursor: number;
}

export interface MatchState {
  matchId: string;
  seed: string;
  mode: MatchMode;
  provider: string;
  humanPairId: PairId | null;
  otherMastersPolicy: MasterPolicy;
  config: ConfigSnapshot;
  nextSeq: number;
  day: number;
  phase: Phase;
  pairs: PairState[];
  publicLog: PublicLogEntry[];
  rewindNonce: number;
  winner: Winner | null;
  finishReason: string | null;
  finalRoles: Record<PairId, Role> | null;

  discussion: DiscussionState | null;
  adviceUsedToday: Record<PairId, number>;
  /** 主観的な疑い助言の履歴 {day, targetId}(組ごと) */
  suspicionAdvices: Record<PairId, { day: number; targetId: PairId }[]>;
  /** 未消化の質問指示(次の自分の発言で消化) */
  pendingQuestion: Record<PairId, { targetId: PairId; themeId: string } | null>;
  /** その日の立ち回り指示 */
  behaviorToday: Record<PairId, string | null>;
  /** 次回スキル対象の提案(夜に消化) */
  skillProposal: Record<PairId, PairId | null>;
  /** 主人が保持する確定情報(占い結果) */
  facts: Record<PairId, Fact[]>;
  /** バディへ共有済みの確定情報ID */
  sharedFactIds: Record<PairId, string[]>;

  /** 当日の裁判: 主人の意思表示(undefined=未提出) */
  trialChoices: Record<PairId, PairId | null | undefined>;
  /** 当日の夜: 狼主人の襲撃提案(undefined=未提出) */
  nightProposals: Record<PairId, PairId | null | undefined>;

  voteHistory: { day: number; pairId: PairId; targetId: PairId }[];
  trialChoiceHistory: { day: number; pairId: PairId; targetId: PairId | null }[];
  executionHistory: { day: number; targetId: PairId | null }[];
  attackHistory: { day: number; targetId: PairId | null }[];
  wolfReports: Record<
    PairId,
    { day: number; masterProposalId: PairId | null; buddyTopId: PairId | null; finalTargetId: PairId | null }[]
  >;
  /** 占い役ごとの占い済み対象 */
  divined: Record<PairId, PairId[]>;
  /** 各バディの最新評価(エンジン/ポリシー用) */
  latestEvals: Record<PairId, EvalOutput | null>;
}

export function alivePairs(state: MatchState): PairState[] {
  return state.pairs.filter((p) => p.alive);
}

export function getPair(state: MatchState, pairId: PairId): PairState {
  const p = state.pairs.find((x) => x.pairId === pairId);
  if (!p) throw new Error(`unknown pair: ${pairId}`);
  return p;
}

export function aliveWolves(state: MatchState): PairState[] {
  return alivePairs(state).filter((p) => p.role === 'werewolf');
}

export function aliveCitizens(state: MatchState): PairState[] {
  return alivePairs(state).filter((p) => ROLE_TEAM[p.role] === 'citizens');
}

export function findBehaviorDirective(
  state: MatchState,
  pairId: PairId,
): BehaviorDirective | null {
  const id = state.behaviorToday[pairId];
  if (!id) return null;
  return state.config.advice.behaviorDirectives.find((d) => d.id === id) ?? null;
}

/** match_created イベントから初期状態を作る */
function initialState(ev: Extract<MatchEvent, { type: 'match_created' }>, config: ConfigSnapshot): MatchState {
  const p = ev.payload;
  const pairs: PairState[] = p.pairs.map((setup) => ({
    pairId: setup.pairId,
    masterName: setup.masterName,
    buddyName: setup.buddy.persona.name,
    buddyId: setup.buddy.id,
    role: 'villager',
    alive: true,
    deathDay: null,
    deathCause: null,
  }));
  const byPair = <T>(make: () => T): Record<PairId, T> =>
    Object.fromEntries(pairs.map((x) => [x.pairId, make()]));
  return {
    matchId: p.matchId,
    seed: p.seed,
    mode: p.mode,
    provider: p.provider,
    humanPairId: p.humanPairId,
    otherMastersPolicy: p.otherMastersPolicy,
    config,
    nextSeq: ev.seq + 1,
    day: 1,
    phase: 'day_start',
    pairs,
    publicLog: [],
    rewindNonce: 0,
    winner: null,
    finishReason: null,
    finalRoles: null,
    discussion: null,
    adviceUsedToday: byPair(() => 0),
    suspicionAdvices: byPair(() => []),
    pendingQuestion: byPair(() => null),
    behaviorToday: byPair(() => null),
    skillProposal: byPair(() => null),
    facts: byPair(() => []),
    sharedFactIds: byPair(() => []),
    trialChoices: {},
    nightProposals: {},
    voteHistory: [],
    trialChoiceHistory: [],
    executionHistory: [],
    attackHistory: [],
    wolfReports: byPair(() => []),
    divined: byPair(() => []),
    latestEvals: byPair(() => null),
  };
}

function buildDiscussionQueue(state: MatchState): DiscussionState {
  const order = alivePairs(state).map((p) => p.pairId);
  const queue: DiscussionTurn[] = [];
  for (let rep = 0; rep < state.config.rules.speechesPerBuddyPerRound; rep++) {
    for (const pairId of order) queue.push({ pairId, round: 1, kind: 'opening' });
  }
  return { stage: 'opening', queue, cursor: 0 };
}

/**
 * 相談後の会話順を決定論的に組み立てる。
 * 質問がある日は質問者→対象の単独回答→質問者の受け止め→最大2組の反応。
 * 質問がなければ、主人組を先頭に全員が冒頭討論を受けて意見を更新する。
 */
function buildResponseQueue(state: MatchState): DiscussionTurn[] {
  const alive = alivePairs(state).map((p) => p.pairId);
  const humanFirst = state.humanPairId && alive.includes(state.humanPairId)
    ? [state.humanPairId, ...alive.filter((id) => id !== state.humanPairId)]
    : alive;
  const questioner = humanFirst.find((id) => {
    const question = state.pendingQuestion[id];
    return question != null && alive.includes(question.targetId) && question.targetId !== id;
  });
  const queue: DiscussionTurn[] = [];

  if (questioner) {
    const question = state.pendingQuestion[questioner];
    if (question) {
      const ref = { askerId: questioner, targetId: question.targetId, themeId: question.themeId };
      queue.push({ pairId: questioner, round: 2, kind: 'question', question: ref });
      queue.push({ pairId: question.targetId, round: 2, kind: 'answer', question: ref });
      queue.push({ pairId: questioner, round: 2, kind: 'follow_up', question: ref });
      const reactors = alive.filter((id) => id !== questioner && id !== question.targetId).slice(0, 2);
      for (const pairId of reactors) {
        queue.push({ pairId, round: 2, kind: 'reaction', question: ref });
      }
    }
  } else {
    for (let rep = 0; rep < state.config.rules.speechesPerBuddyPerRound; rep++) {
      for (const pairId of humanFirst) queue.push({ pairId, round: 2, kind: 'reaction' });
    }
  }

  // 3周目以降を設定した場合は、全員の通常リアクションとして追加する。
  for (let round = 3; round <= state.config.rules.discussionRounds; round++) {
    for (let rep = 0; rep < state.config.rules.speechesPerBuddyPerRound; rep++) {
      for (const pairId of alive) queue.push({ pairId, round, kind: 'reaction' });
    }
  }
  return queue;
}

function applyAdviceToState(state: MatchState, pairId: PairId, advice: Advice): void {
  state.adviceUsedToday[pairId] = (state.adviceUsedToday[pairId] ?? 0) + 1;
  switch (advice.kind) {
    case 'suspicion': {
      const list = state.suspicionAdvices[pairId] ?? [];
      list.push({ day: state.day, targetId: advice.targetId });
      state.suspicionAdvices[pairId] = list;
      break;
    }
    case 'question':
      state.pendingQuestion[pairId] = { targetId: advice.targetId, themeId: advice.themeId };
      break;
    case 'behavior':
      state.behaviorToday[pairId] = advice.directiveId;
      break;
    case 'skill_target':
      state.skillProposal[pairId] = advice.targetId;
      break;
    case 'fact_share':
      // fact_shared イベント側で処理
      break;
  }
}

/**
 * リデューサー本体。イベントを1つ適用した新しい状態を返す。
 * (draftをstructuredCloneで作ってから破壊的に更新する)
 */
export function reduce(prev: MatchState | null, event: MatchEvent): MatchState {
  if (event.type === 'match_created') {
    // configはイベントペイロードに含めず、外部スナップショットとして渡される前提。
    throw new Error('match_created は reduceWithConfig で処理してください');
  }
  if (!prev) throw new Error('state がありません(match_created が先頭に必要)');
  const state = structuredClone(prev);
  state.nextSeq = event.seq + 1;

  switch (event.type) {
    case 'roles_assigned': {
      for (const p of state.pairs) {
        const role = event.payload.roles[p.pairId];
        if (!role) throw new Error(`role missing for ${p.pairId}`);
        p.role = role;
      }
      break;
    }
    case 'phase_changed': {
      state.day = event.payload.day;
      state.phase = event.payload.phase;
      if (state.phase === 'discussion') {
        state.discussion = buildDiscussionQueue(state);
        state.publicLog.push({ seq: event.seq, day: state.day, t: 'phase', phase: 'discussion' });
      } else if (state.phase === 'trial') {
        state.discussion = null;
        state.trialChoices = {};
        state.publicLog.push({ seq: event.seq, day: state.day, t: 'phase', phase: 'trial' });
      } else if (state.phase === 'night') {
        state.nightProposals = {};
        state.publicLog.push({ seq: event.seq, day: state.day, t: 'phase', phase: 'night' });
      }
      break;
    }
    case 'discussion_stage_changed': {
      if (!state.discussion) throw new Error('discussion state is missing');
      state.discussion.stage = event.payload.stage;
      if (event.payload.stage === 'response') {
        state.discussion.queue = buildResponseQueue(state);
        state.discussion.cursor = 0;
      }
      state.publicLog.push({
        seq: event.seq,
        day: event.day,
        t: 'discussion_stage',
        stage: event.payload.stage,
      });
      break;
    }
    case 'day_started': {
      state.day = event.payload.day;
      // 日替わりリセット
      for (const p of state.pairs) {
        state.adviceUsedToday[p.pairId] = 0;
        state.pendingQuestion[p.pairId] = null;
        state.behaviorToday[p.pairId] = null;
      }
      state.publicLog.push({
        seq: event.seq,
        day: event.payload.day,
        t: 'day_start',
        deaths: event.payload.deaths.map((d) => ({
          pairId: d.pairId,
          name: getPair(state, d.pairId).buddyName,
        })),
      });
      break;
    }
    case 'speech': {
      const pair = getPair(state, event.payload.pairId);
      state.publicLog.push({
        seq: event.seq,
        day: event.day,
        t: 'speech',
        round: event.payload.round,
        turnKind: event.payload.turnKind,
        question: event.payload.question,
        pairId: pair.pairId,
        name: pair.buddyName,
        text: event.payload.text,
        accusesId: event.payload.accusesId,
      });
      if (event.payload.turnKind === 'question' || event.payload.turnKind === 'follow_up') {
        state.pendingQuestion[pair.pairId] = null; // 質問指示は質問者自身の発言で消化
      }
      if (state.discussion) state.discussion.cursor += 1;
      break;
    }
    case 'eval_recorded': {
      state.latestEvals[event.payload.pairId] = event.payload.output;
      break;
    }
    case 'advice_given': {
      applyAdviceToState(state, event.payload.pairId, event.payload.advice);
      break;
    }
    case 'fact_shared': {
      const ids = state.sharedFactIds[event.payload.pairId] ?? [];
      if (!ids.includes(event.payload.fact.id)) ids.push(event.payload.fact.id);
      state.sharedFactIds[event.payload.pairId] = ids;
      break;
    }
    case 'trial_choice': {
      state.trialChoices[event.payload.pairId] = event.payload.targetId;
      state.trialChoiceHistory.push({
        day: event.day,
        pairId: event.payload.pairId,
        targetId: event.payload.targetId,
      });
      break;
    }
    case 'vote_cast': {
      const voter = getPair(state, event.payload.pairId);
      const target = getPair(state, event.payload.targetId);
      state.voteHistory.push({
        day: event.day,
        pairId: voter.pairId,
        targetId: target.pairId,
      });
      state.publicLog.push({
        seq: event.seq,
        day: event.day,
        t: 'vote',
        pairId: voter.pairId,
        name: voter.buddyName,
        targetId: target.pairId,
        targetName: target.buddyName,
      });
      break;
    }
    case 'vote_detail':
    case 'divination_detail':
      break; // gm用詳細。状態には影響しない。
    case 'execution': {
      const targetId = event.payload.targetId;
      let revealedRole: Role | null = null;
      if (targetId) {
        const target = getPair(state, targetId);
        target.alive = false;
        target.deathDay = event.day;
        target.deathCause = 'execution';
        if (state.config.rules.revealRoleOnDeath) revealedRole = target.role;
      }
      state.executionHistory.push({ day: event.day, targetId });
      state.publicLog.push({
        seq: event.seq,
        day: event.day,
        t: 'execution',
        targetId,
        targetName: targetId ? getPair(state, targetId).buddyName : null,
        tally: event.payload.tally,
        tie: event.payload.tie,
        revealedRole,
      });
      break;
    }
    case 'night_proposal': {
      state.nightProposals[event.payload.pairId] = event.payload.targetId;
      break;
    }
    case 'divination': {
      const { seerPairId, targetId, fact } = event.payload;
      const facts = state.facts[seerPairId] ?? [];
      facts.push(fact);
      state.facts[seerPairId] = facts;
      const divined = state.divined[seerPairId] ?? [];
      divined.push(targetId);
      state.divined[seerPairId] = divined;
      state.skillProposal[seerPairId] = null; // 提案は消化
      break;
    }
    case 'attack_detail':
      break; // gm用
    case 'wolf_night_report': {
      const list = state.wolfReports[event.payload.pairId] ?? [];
      list.push({
        day: event.day,
        masterProposalId: event.payload.masterProposalId,
        buddyTopId: event.payload.buddyTopId,
        finalTargetId: event.payload.finalTargetId,
      });
      state.wolfReports[event.payload.pairId] = list;
      break;
    }
    case 'attack_resolved': {
      const targetId = event.payload.targetId;
      if (targetId) {
        const target = getPair(state, targetId);
        target.alive = false;
        target.deathDay = event.day;
        target.deathCause = 'attack';
      }
      state.attackHistory.push({ day: event.day, targetId });
      break;
    }
    case 'match_finished': {
      state.winner = event.payload.winner;
      state.finishReason = event.payload.reason;
      state.finalRoles = event.payload.roles;
      state.phase = 'finished';
      state.publicLog.push({
        seq: event.seq,
        day: event.day,
        t: 'finish',
        winner: event.payload.winner,
        reason: event.payload.reason,
      });
      break;
    }
    case 'rewound': {
      state.rewindNonce = event.payload.nonce;
      break;
    }
    case 'note':
      break;
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
    }
  }
  return state;
}

/** イベント列から状態を再構築する(リプレイ)。 */
export function rebuildState(events: MatchEvent[], config: ConfigSnapshot): MatchState {
  const head = events[0];
  if (!head || head.type !== 'match_created') {
    throw new Error('イベント列の先頭は match_created である必要があります');
  }
  let state = initialState(head, config);
  for (const ev of events.slice(1)) {
    state = reduce(state, ev);
  }
  return state;
}

export { initialState };
