/**
 * 秘密情報の分離。
 * - canSeeEvent: 視点ごとのイベント可視判定
 * - buildBuddyContext: AIバディへ渡してよい情報だけのViewModel(LLMコンテキストの唯一の材料)
 * - buildMasterView: 主人(人間プレイヤー)画面用ビュー
 * - buildReplayData: 試合後のリプレイ/分析用データ(内部スコアを含む)
 *
 * LLMへ全GameStateを渡してはならない。プロンプト組み立ては必ず BuddyContext を使う。
 */
import type {
  AbilityUnlock,
  Abilities,
  Advice,
  AdviceConfig,
  BehaviorDirective,
  DiscussionStage,
  DiscussionTurn,
  DiscussionTurnKind,
  EvalKind,
  EvalOutput,
  Fact,
  MatchEvent,
  PairId,
  Persona,
  Phase,
  QuestionTheme,
  Role,
  TrustFnConfig,
  Winner,
} from '@aibw/shared';
import { randInt, ROLE_LABEL, ROLE_TEAM } from '@aibw/shared';
import { alivePairs, getPair, type MatchState, type PublicLogEntry } from './state.js';
import { getPendingTask } from './engine.js';

export type Viewer =
  | { kind: 'gm' }
  | { kind: 'public' }
  | { kind: 'master'; pairId: PairId }
  | { kind: 'buddy'; pairId: PairId };

export function canSeeEvent(event: MatchEvent, viewer: Viewer): boolean {
  const v = event.visibility;
  if (viewer.kind === 'gm') return true;
  if (v.kind === 'public') return true;
  if (v.kind === 'gm') return false;
  // pairs
  if (viewer.kind === 'public') return false;
  if (!v.pairIds.includes(viewer.pairId)) return false;
  if (v.part === 'both') return true;
  return v.part === viewer.kind;
}

// ---------------------------------------------------------------------------
// AIバディ用コンテキスト
// ---------------------------------------------------------------------------

export interface BuddyContext {
  matchInfo: {
    day: number;
    phase: Phase;
    maxDays: number;
    discussionRounds: number;
    /** 試合シードから作る非秘密の回転値。シード自体や未来乱数はLLMへ渡さない。 */
    analysisLensRotation: number;
  };
  self: {
    pairId: PairId;
    /** 表示名を編集しても人格別の決定論的モックを識別できる設定ID。 */
    buddyId: string;
    buddyName: string;
    masterName: string;
    role: Role;
    roleLabel: string;
    team: 'citizens' | 'wolves';
    abilities: Abilities;
    persona: Persona;
    unlockedReasoning: AbilityUnlock[];
    unlockedDeception: AbilityUnlock[];
  };
  /** 狼のみ: 仲間の狼(自分以外) */
  wolfPartners: { pairId: PairId; name: string }[];
  participants: {
    pairId: PairId;
    name: string;
    alive: boolean;
    deathDay: number | null;
    deathCause: 'execution' | 'attack' | null;
    revealedRole: Role | null;
  }[];
  publicLog: PublicLogEntry[];
  /** 円卓で実際に公開された最新の名乗り。表示上も真偽は伏せる。 */
  publicRoleClaims: Record<PairId, { day: number; claimedRole: Role }>;
  /** 初日に抽選された公開の討論対象。抽選結果であり、役職の根拠ではない。 */
  discussionFocus: { pairId: PairId; name: string }[];
  /** 今回の発言が冒頭・質問・単独回答・追質問・周囲反応のどれか。公開会話の進行だけを含む。 */
  discussionTurn: null | {
    round: number;
    kind: DiscussionTurnKind;
    askerId: PairId | null;
    askerName: string | null;
    targetId: PairId | null;
    targetName: string | null;
    replyToId?: PairId | null;
    replyToName?: string | null;
    afterMasterAdvice?: boolean;
    theme: QuestionTheme | null;
  };
  /** 主人から共有された確定情報のみ(未共有の占い・霊媒結果は含まれない) */
  sharedFacts: Fact[];
  /** 騎士のみ: 前夜の護衛先。連続護衛を避けるための自分自身の行動情報。 */
  lastGuardTarget: { pairId: PairId; name: string } | null;
  /** 自分の主人からの助言のみ */
  advices: { day: number; advice: Advice }[];
  /** その日に主人から届いた役職の名乗り方の相談。自分の組だけが見られる。 */
  roleClaimProposal: { day: number; claimedRole: Role | null } | null;
  pendingQuestion: { targetId: PairId; targetName: string; theme: QuestionTheme } | null;
  behaviorDirective: BehaviorDirective | null;
  /** 自分の過去評価(直近) */
  previousEval: EvalOutput | null;
  /** 評価対象(生存かつ自分以外) */
  candidates: { pairId: PairId; name: string }[];
  /** 当日、AIが質問候補として返してよい公開設定のIDと表示名。 */
  questionThemes: { id: string; label: string }[];
  /** 主観助言をどの程度重く扱うかの設定(自分自身の判断規約であり秘密情報ではない) */
  trustConfig: { subjectiveAdvice: TrustFnConfig };
}

export function buildBuddyContext(
  state: MatchState,
  pairId: PairId,
  turnOverride?: DiscussionTurn,
): BuddyContext {
  const pair = getPair(state, pairId);
  const config = state.config;
  const buddy = config.buddies.find((b) => b.id === pair.buddyId);
  if (!buddy) throw new Error(`buddy config not found: ${pair.buddyId}`);
  const abilities = buddy.abilities;

  const unlockedReasoning = config.abilities.reasoningUnlocks.filter(
    (u) => abilities.reasoning >= u.at,
  );
  const unlockedDeception = config.abilities.deceptionUnlocks.filter(
    (u) => abilities.deception >= u.at,
  );

  const wolfPartners =
    pair.role === 'werewolf'
      ? state.pairs
          .filter((p) => p.role === 'werewolf' && p.pairId !== pairId)
          .map((p) => ({ pairId: p.pairId, name: p.buddyName }))
      : [];

  const sharedIds = new Set(state.sharedFactIds[pairId] ?? []);
  const sharedFacts = (state.facts[pairId] ?? []).filter((f) => sharedIds.has(f.id));
  const lastGuardTargetId =
    pair.role === 'guardian'
      ? ([...state.guardHistory]
          .reverse()
          .find((entry) => entry.guardianPairId === pairId)?.targetId ?? null)
      : null;

  const advices: { day: number; advice: Advice }[] = [];
  // イベントからではなく状態から復元すると助言の時系列が失われるため、
  // 助言はイベントベースで集める(自分の組のもののみ)。
  // ※ contextビルダーはstateのみで完結させたいので、stateに残した履歴を使う。
  for (const s of state.suspicionAdvices[pairId] ?? []) {
    advices.push({ day: s.day, advice: { kind: 'suspicion', targetId: s.targetId } });
  }
  const pq = state.pendingQuestion[pairId];
  if (pq) {
    advices.push({
      day: state.day,
      advice: { kind: 'question', targetId: pq.targetId, themeId: pq.themeId },
    });
  }
  const behavior = state.behaviorToday[pairId];
  if (behavior) {
    advices.push({ day: state.day, advice: { kind: 'behavior', directiveId: behavior } });
  }
  const skill = state.skillProposal[pairId];
  if (skill) {
    advices.push({ day: state.day, advice: { kind: 'skill_target', targetId: skill } });
  }
  const roleClaimProposal = state.roleClaimProposal[pairId] ?? null;
  if (roleClaimProposal) {
    advices.push({
      day: roleClaimProposal.day,
      advice: { kind: 'role_claim', claimedRole: roleClaimProposal.claimedRole },
    });
  }
  for (const f of sharedFacts) {
    advices.push({ day: f.day, advice: { kind: 'fact_share', factId: f.id } });
  }

  const theme = pq ? config.advice.questionThemes.find((t) => t.id === pq.themeId) : undefined;
  const directive = behavior
    ? (config.advice.behaviorDirectives.find((d) => d.id === behavior) ?? null)
    : null;
  const rawTurn = turnOverride ?? state.discussion?.queue[state.discussion.cursor] ?? null;
  const turnQuestion = rawTurn?.question;
  const turnTheme = turnQuestion
    ? (config.advice.questionThemes.find((t) => t.id === turnQuestion.themeId) ?? null)
    : null;

  return {
    matchInfo: {
      day: state.day,
      phase: state.phase,
      maxDays: config.rules.maxDays,
      discussionRounds: config.rules.discussionRounds,
      analysisLensRotation: randInt(
        1_009,
        state.seed,
        'analysis-lens-rotation',
        state.day,
        state.rewindNonce,
      ),
    },
    self: {
      pairId,
      buddyId: pair.buddyId,
      buddyName: pair.buddyName,
      masterName: pair.masterName,
      role: pair.role,
      roleLabel: ROLE_LABEL[pair.role],
      team: ROLE_TEAM[pair.role],
      abilities,
      persona: buddy.persona,
      unlockedReasoning,
      unlockedDeception,
    },
    wolfPartners,
    participants: state.pairs.map((p) => ({
      pairId: p.pairId,
      name: p.buddyName,
      alive: p.alive,
      deathDay: p.deathDay,
      deathCause: p.deathCause,
      revealedRole:
        !p.alive && state.config.rules.revealRoleOnDeath && p.deathCause === 'execution'
          ? p.role
          : null,
    })),
    publicLog: state.publicLog,
    discussionFocus: (state.discussion?.focusPairIds ?? []).map((focusId) => ({
      pairId: focusId,
      name: getPair(state, focusId).buddyName,
    })),
    discussionTurn: rawTurn
      ? {
          round: rawTurn.round,
          kind: rawTurn.kind,
          askerId: turnQuestion?.askerId ?? null,
          askerName: turnQuestion ? getPair(state, turnQuestion.askerId).buddyName : null,
          targetId: turnQuestion?.targetId ?? null,
          targetName: turnQuestion ? getPair(state, turnQuestion.targetId).buddyName : null,
          replyToId: rawTurn.replyToId ?? null,
          replyToName: rawTurn.replyToId ? getPair(state, rawTurn.replyToId).buddyName : null,
          afterMasterAdvice: rawTurn.afterMasterAdvice === true,
          theme: turnTheme,
        }
      : null,
    sharedFacts,
    lastGuardTarget: lastGuardTargetId
      ? { pairId: lastGuardTargetId, name: getPair(state, lastGuardTargetId).buddyName }
      : null,
    advices,
    roleClaimProposal,
    publicRoleClaims: structuredClone(state.publicRoleClaims),
    pendingQuestion:
      pq && theme
        ? { targetId: pq.targetId, targetName: getPair(state, pq.targetId).buddyName, theme }
        : null,
    behaviorDirective: directive,
    previousEval: state.latestEvals[pairId] ?? null,
    candidates: alivePairs(state)
      .filter((p) => p.pairId !== pairId)
      .map((p) => ({ pairId: p.pairId, name: p.buddyName })),
    questionThemes: config.advice.questionThemes
      .filter((item) => state.day > 1 || item.id !== 'vote_reason')
      .map((item) => ({ id: item.id, label: item.label })),
    trustConfig: { subjectiveAdvice: config.rules.trust.subjectiveAdvice },
  };
}

// ---------------------------------------------------------------------------
// 主人(人間)用ビュー
// ---------------------------------------------------------------------------

export interface MasterView {
  matchId: string;
  mode: string;
  provider: string;
  day: number;
  phase: Phase;
  discussionStage: DiscussionStage | null;
  discussionMode: 'timed' | 'turns' | null;
  discussionEndsAt: number | null;
  /** 主人入力待ちの間は討論時計を止める。remainingMsはこの間の表示値。 */
  discussionPaused: boolean;
  discussionRemainingMs: number;
  discussionDurationSec: number;
  discussionMessageCount: number;
  discussionMaxMessages: number;
  maxDays: number;
  winner: Winner | null;
  finishReason: string | null;
  finalRoles: Record<PairId, string> | null;
  humanPairId: PairId | null;
  pairs: {
    pairId: PairId;
    buddyName: string;
    masterName: string;
    alive: boolean;
    deathDay: number | null;
    deathCause: 'execution' | 'attack' | null;
    isSelf: boolean;
  }[];
  publicLog: PublicLogEntry[];
  /** 円卓で実際に公開された最新の名乗り。表示上も真偽は伏せる。 */
  publicRoleClaims: Record<PairId, { day: number; claimedRole: Role }>;
  /** この試合を作成した時点で凍結した助言設定。過去試合も同じ契約で表示する。 */
  adviceConfig: AdviceConfig;
  pending:
    | { type: 'wait_inputs'; missing: { pairId: PairId; input: string }[] }
    | { type: 'ai_step'; description: string }
    | { type: 'finished' };
  me: null | {
    pairId: PairId;
    buddyName: string;
    roleLabel: string;
    role: Role;
    team: string;
    abilities: Abilities;
    wolfPartners: { pairId: PairId; name: string }[];
    facts: (Fact & { targetName: string; shared: boolean })[];
    roleClaimProposal: { day: number; claimedRole: Role | null } | null;
    adviceUsedToday: number;
    advicePerDay: number;
    canAdvise: boolean;
    needDiscussionAdvice: boolean;
    needTrialChoice: boolean;
    needNightProposal: boolean;
    trialChoice: PairId | null | undefined;
    nightProposal: PairId | null | undefined;
    voteComparisons: {
      day: number;
      myChoiceId: PairId | null;
      myChoiceName: string | null;
      buddyVoteId: PairId | null;
      buddyVoteName: string | null;
    }[];
    wolfReports: {
      day: number;
      proposalName: string | null;
      buddyTopName: string | null;
      finalName: string | null;
    }[];
    guardReports: {
      day: number;
      proposalName: string | null;
      finalName: string | null;
    }[];
  };
}

export function buildMasterView(state: MatchState, pairId: PairId | null): MasterView {
  const task = getPendingTask(state);
  const nameOf = (id: PairId | null | undefined): string | null =>
    id ? getPair(state, id).buddyName : null;

  let pending: MasterView['pending'];
  if (task.type === 'finished') {
    pending = { type: 'finished' };
  } else if (task.type === 'wait_inputs') {
    pending = { type: 'wait_inputs', missing: task.missing };
  } else {
    const descriptions: Record<string, string> = {
      ai_speech: 'バディが発言を考えています',
      ai_speech_batch: '複数のバディが同時に考えています',
      start_discussion_response: '相談を受けた討論を始めています',
      close_discussion: '討論を締め切っています',
      ai_votes: 'バディたちが投票を判断しています',
      ai_night: '夜の判断が行われています',
      advance_day: '討論の開始を待っています',
    };
    pending = { type: 'ai_step', description: descriptions[task.type] ?? '進行中' };
  }

  let me: MasterView['me'] = null;
  if (pairId) {
    const pair = getPair(state, pairId);
    const buddy = state.config.buddies.find((b) => b.id === pair.buddyId);
    const sharedIds = new Set(state.sharedFactIds[pairId] ?? []);
    const voteComparisons = state.trialChoiceHistory
      .filter((t) => t.pairId === pairId)
      .map((t) => {
        const vote = state.voteHistory.find((v) => v.day === t.day && v.pairId === pairId);
        return {
          day: t.day,
          myChoiceId: t.targetId,
          myChoiceName: nameOf(t.targetId),
          buddyVoteId: vote?.targetId ?? null,
          buddyVoteName: nameOf(vote?.targetId),
        };
      });
    me = {
      pairId,
      buddyName: pair.buddyName,
      roleLabel: ROLE_LABEL[pair.role],
      role: pair.role,
      team: ROLE_TEAM[pair.role],
      abilities: buddy?.abilities ?? { reasoning: 0, deception: 0, trust: 0 },
      wolfPartners:
        pair.role === 'werewolf'
          ? state.pairs
              .filter((p) => p.role === 'werewolf' && p.pairId !== pairId)
              .map((p) => ({ pairId: p.pairId, name: p.buddyName }))
          : [],
      facts: (state.facts[pairId] ?? []).map((f) => ({
        ...f,
        targetName: getPair(state, f.targetId).buddyName,
        shared: sharedIds.has(f.id),
      })),
      roleClaimProposal: state.roleClaimProposal[pairId] ?? null,
      adviceUsedToday: state.adviceUsedToday[pairId] ?? 0,
      advicePerDay: state.config.rules.advicePerDay,
      canAdvise:
        pair.alive &&
        state.phase === 'discussion' &&
        state.discussion?.masterAdviceDecision === 'pending' &&
        (state.discussion?.mode === 'timed'
          ? state.discussion.stage === 'awaiting_master_advice'
          : state.config.rules.discussionRounds === 1 || state.discussion?.stage === 'advice') &&
        (state.adviceUsedToday[pairId] ?? 0) < state.config.rules.advicePerDay,
      needDiscussionAdvice:
        pair.alive &&
        state.phase === 'discussion' &&
        state.discussion?.masterAdviceDecision === 'pending' &&
        (state.discussion?.stage === 'awaiting_master_advice' ||
          (state.discussion?.mode !== 'timed' &&
            state.config.rules.discussionRounds > 1 &&
            state.discussion?.stage === 'advice')) &&
        (state.adviceUsedToday[pairId] ?? 0) < state.config.rules.advicePerDay,
      needTrialChoice:
        pair.alive && state.phase === 'trial' && state.trialChoices[pairId] === undefined,
      needNightProposal:
        pair.alive &&
        state.phase === 'night' &&
        pair.role === 'werewolf' &&
        state.nightProposals[pairId] === undefined,
      trialChoice: state.trialChoices[pairId],
      nightProposal: state.nightProposals[pairId],
      voteComparisons,
      wolfReports: (state.wolfReports[pairId] ?? []).map((r) => ({
        day: r.day,
        proposalName: nameOf(r.masterProposalId),
        buddyTopName: nameOf(r.buddyTopId),
        finalName: nameOf(r.finalTargetId),
      })),
      guardReports: state.guardHistory
        .filter((report) => report.guardianPairId === pairId)
        .map((report) => ({
          day: report.day,
          proposalName: nameOf(report.masterProposalId),
          finalName: nameOf(report.targetId),
        })),
    };
  }

  return {
    matchId: state.matchId,
    mode: state.mode,
    provider: state.provider,
    day: state.day,
    phase: state.phase,
    discussionStage: state.discussion?.stage ?? null,
    discussionMode: state.discussion?.mode ?? null,
    discussionEndsAt: state.discussion?.endsAt ?? null,
    discussionPaused: state.discussion?.pausedAt != null,
    discussionRemainingMs: state.discussion?.remainingMs ?? 0,
    discussionDurationSec: state.config.rules.discussionDurationSec ?? 150,
    discussionMessageCount: state.publicLog.filter(
      (entry) => entry.t === 'speech' && entry.day === state.day,
    ).length,
    discussionMaxMessages: state.config.rules.discussionMaxMessages ?? 30,
    maxDays: state.config.rules.maxDays,
    winner: state.winner,
    finishReason: state.finishReason,
    finalRoles: state.finalRoles
      ? Object.fromEntries(
          Object.entries(state.finalRoles).map(([k, r]) => [k, ROLE_LABEL[r]]),
        )
      : null,
    humanPairId: state.humanPairId,
    pairs: state.pairs.map((p) => ({
      pairId: p.pairId,
      buddyName: p.buddyName,
      masterName: p.masterName,
      alive: p.alive,
      deathDay: p.deathDay,
      deathCause: p.deathCause,
      isSelf: p.pairId === pairId,
    })),
    publicLog: state.publicLog,
    publicRoleClaims: structuredClone(state.publicRoleClaims),
    adviceConfig: structuredClone(state.config.advice),
    pending,
    me,
  };
}

// ---------------------------------------------------------------------------
// リプレイ/分析データ(試合後・Lab専用)
// ---------------------------------------------------------------------------

export interface ReplayData {
  matchId: string;
  seed: string;
  winner: Winner | null;
  finishReason: string | null;
  roles: Record<PairId, { name: string; role: Role; roleLabel: string }>;
  evalTimeline: {
    seq: number;
    day: number;
    phase: Phase;
    kind: EvalKind;
    pairId: PairId;
    pairName: string;
    output: EvalOutput;
  }[];
  advices: { seq: number; day: number; pairId: PairId; pairName: string; advice: Advice }[];
  roleClaimDetails: {
    day: number;
    pairId: PairId;
    pairName: string;
    trueRole: Role;
    trueRoleLabel: string;
    masterProposalSet: boolean;
    masterProposal: Role | null;
    publicClaims: {
      seq: number;
      claimedRole: Role;
      claimedRoleLabel: string;
      isTruth: boolean;
    }[];
  }[];
  trialDetails: {
    day: number;
    perPair: {
      pairId: PairId;
      pairName: string;
      masterChoiceId: PairId | null;
      trustBonusApplied: number;
      baseScores: Record<PairId, number>;
      adjustedScores: Record<PairId, number>;
      voteTargetId: PairId | null;
    }[];
    executionTargetId: PairId | null;
    tie: boolean;
  }[];
  nightDetails: {
    day: number;
    divination: {
      seerPairId: PairId;
      targetId: PairId;
      isWolf: boolean;
      masterProposalId: PairId | null;
      basePriorities: Record<PairId, number>;
      adjustedPriorities: Record<PairId, number>;
    } | null;
    attack: {
      perWolf: {
        pairId: PairId;
        masterProposalId: PairId | null;
        basePriorities: Record<PairId, number>;
        adjustedPriorities: Record<PairId, number>;
        topCandidateId: PairId | null;
      }[];
      integrated: Record<PairId, number>;
      targetId: PairId | null;
      tie: boolean;
    } | null;
  }[];
  speeches: {
    seq: number;
    day: number;
    round: number;
    pairId: PairId;
    pairName: string;
    text: string;
    reasonSummary: string | null;
  }[];
  events: MatchEvent[];
}

export function buildReplayData(state: MatchState, events: MatchEvent[]): ReplayData {
  const nameOf = (id: PairId): string => getPair(state, id).buddyName;
  const evalTimeline: ReplayData['evalTimeline'] = [];
  const advices: ReplayData['advices'] = [];
  const speeches: ReplayData['speeches'] = [];
  const roleClaimByPairDay = new Map<string, ReplayData['roleClaimDetails'][number]>();
  const trialByDay = new Map<number, ReplayData['trialDetails'][number]>();
  const nightByDay = new Map<number, ReplayData['nightDetails'][number]>();
  let lastEvalByPair = new Map<PairId, EvalOutput>();

  const roleClaimDetail = (
    day: number,
    pairId: PairId,
  ): ReplayData['roleClaimDetails'][number] => {
    const key = `${day}:${pairId}`;
    const existing = roleClaimByPairDay.get(key);
    if (existing) return existing;
    const pair = getPair(state, pairId);
    const detail: ReplayData['roleClaimDetails'][number] = {
      day,
      pairId,
      pairName: pair.buddyName,
      trueRole: pair.role,
      trueRoleLabel: ROLE_LABEL[pair.role],
      masterProposalSet: false,
      masterProposal: null,
      publicClaims: [],
    };
    roleClaimByPairDay.set(key, detail);
    return detail;
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'eval_recorded':
        evalTimeline.push({
          seq: ev.seq,
          day: ev.day,
          phase: ev.phase,
          kind: ev.payload.kind,
          pairId: ev.payload.pairId,
          pairName: nameOf(ev.payload.pairId),
          output: ev.payload.output,
        });
        lastEvalByPair.set(ev.payload.pairId, ev.payload.output);
        break;
      case 'advice_given':
        advices.push({
          seq: ev.seq,
          day: ev.day,
          pairId: ev.payload.pairId,
          pairName: nameOf(ev.payload.pairId),
          advice: ev.payload.advice,
        });
        if (ev.payload.advice.kind === 'role_claim') {
          const detail = roleClaimDetail(ev.day, ev.payload.pairId);
          detail.masterProposalSet = true;
          detail.masterProposal = ev.payload.advice.claimedRole;
        }
        break;
      case 'role_declared': {
        const detail = roleClaimDetail(ev.day, ev.payload.pairId);
        detail.publicClaims.push({
          seq: ev.seq,
          claimedRole: ev.payload.claimedRole,
          claimedRoleLabel: ROLE_LABEL[ev.payload.claimedRole],
          isTruth: detail.trueRole === ev.payload.claimedRole,
        });
        break;
      }
      case 'speech': {
        const evalOut = lastEvalByPair.get(ev.payload.pairId);
        speeches.push({
          seq: ev.seq,
          day: ev.day,
          round: ev.payload.round,
          pairId: ev.payload.pairId,
          pairName: nameOf(ev.payload.pairId),
          text: ev.payload.text,
          reasonSummary: evalOut?.reasonSummary ?? null,
        });
        break;
      }
      case 'vote_detail': {
        const t = trialByDay.get(ev.day) ?? {
          day: ev.day,
          perPair: [],
          executionTargetId: null,
          tie: false,
        };
        t.perPair.push({
          pairId: ev.payload.pairId,
          pairName: nameOf(ev.payload.pairId),
          masterChoiceId: ev.payload.masterChoiceId,
          trustBonusApplied: ev.payload.trustBonusApplied,
          baseScores: ev.payload.baseScores,
          adjustedScores: ev.payload.adjustedScores,
          voteTargetId: null,
        });
        trialByDay.set(ev.day, t);
        break;
      }
      case 'vote_cast': {
        const t = trialByDay.get(ev.day);
        const p = t?.perPair.find((x) => x.pairId === ev.payload.pairId);
        if (p) p.voteTargetId = ev.payload.targetId;
        break;
      }
      case 'execution': {
        const t = trialByDay.get(ev.day);
        if (t) {
          t.executionTargetId = ev.payload.targetId;
          t.tie = ev.payload.tie;
        }
        break;
      }
      case 'divination_detail': {
        const n = nightByDay.get(ev.day) ?? { day: ev.day, divination: null, attack: null };
        n.divination = {
          seerPairId: ev.payload.seerPairId,
          targetId: '',
          isWolf: false,
          masterProposalId: ev.payload.masterProposalId,
          basePriorities: ev.payload.basePriorities,
          adjustedPriorities: ev.payload.adjustedPriorities,
        };
        nightByDay.set(ev.day, n);
        break;
      }
      case 'divination': {
        const n = nightByDay.get(ev.day) ?? { day: ev.day, divination: null, attack: null };
        if (n.divination) {
          n.divination.targetId = ev.payload.targetId;
          n.divination.isWolf = ev.payload.fact.isWolf;
        }
        nightByDay.set(ev.day, n);
        break;
      }
      case 'medium_result':
      case 'guard_detail': {
        // 霊媒・護衛だけが記録された夜も、試合後の分析で日付ごと欠落させない。
        const n = nightByDay.get(ev.day) ?? { day: ev.day, divination: null, attack: null };
        nightByDay.set(ev.day, n);
        break;
      }
      case 'attack_detail': {
        const n = nightByDay.get(ev.day) ?? { day: ev.day, divination: null, attack: null };
        n.attack = {
          perWolf: ev.payload.perWolf,
          integrated: ev.payload.integrated,
          targetId: ev.payload.targetId,
          tie: ev.payload.tie,
        };
        nightByDay.set(ev.day, n);
        break;
      }
      case 'rewound':
        // 巻き戻し後の再実行を区別できるよう、それまでの集計を保持したままにする
        lastEvalByPair = new Map(lastEvalByPair);
        break;
      default:
        break;
    }
  }

  return {
    matchId: state.matchId,
    seed: state.seed,
    winner: state.winner,
    finishReason: state.finishReason,
    roles: Object.fromEntries(
      state.pairs.map((p) => [
        p.pairId,
        { name: p.buddyName, role: p.role, roleLabel: ROLE_LABEL[p.role] },
      ]),
    ),
    evalTimeline,
    advices,
    roleClaimDetails: [...roleClaimByPairDay.values()].sort(
      (a, b) => a.day - b.day || a.pairId.localeCompare(b.pairId),
    ),
    trialDetails: [...trialByDay.values()].sort((a, b) => a.day - b.day),
    nightDetails: [...nightByDay.values()].sort((a, b) => a.day - b.day),
    speeches,
    events,
  };
}
