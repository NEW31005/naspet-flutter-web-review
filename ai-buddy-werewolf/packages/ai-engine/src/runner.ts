/**
 * MatchRunner: 1試合の進行を司る。
 * - engineに「次のタスク」を問い合わせ、AIコールを行い、結果をengineへ渡してイベント化する
 * - 人間以外の主人(ポリシー)の裁判選択・夜襲提案・助言を自動生成する
 * - UIから分離されており、CLI/バッチ実行からも同じコードで動く
 */
import type {
  Advice,
  AiCallRecord,
  EvalOutput,
  MasterPolicy,
  MatchEvent,
  MatchMetrics,
  MatchRecord,
  PairId,
  SpeechOutput,
} from '@aibw/shared';
import { pickOne, rand } from '@aibw/shared';
import {
  GameRuleError,
  alivePairs,
  applyAdvanceDay,
  applyAdvice,
  applyNight,
  applyNightProposal,
  applySpeech,
  applyTrialChoice,
  applyVotes,
  buildBuddyContext,
  getPendingTask,
  getPair,
  rebuildState,
  reduce,
  type MatchState,
  type PendingTask,
} from '@aibw/game-core';
import type { CallOpts } from './provider.js';

/** Node/ブラウザ双方のAI実行層が満たす最小契約。 */
export interface AiEngineLike {
  evaluate(
    providerName: string,
    pairId: PairId,
    ctx: ReturnType<typeof buildBuddyContext>,
    opts: CallOpts,
  ): Promise<{ output: EvalOutput; record: AiCallRecord }>;
  speak(
    providerName: string,
    pairId: PairId,
    ctx: ReturnType<typeof buildBuddyContext>,
    evalOutput: EvalOutput,
    opts: CallOpts,
  ): Promise<{ output: SpeechOutput; record: AiCallRecord }>;
}

export interface MatchStore {
  record: MatchRecord;
  state: MatchState;
}

export function appendEvents(store: MatchStore, events: MatchEvent[]): void {
  for (const ev of events) {
    store.record.events.push(ev);
    store.state = reduce(store.state, ev);
  }
}

export function rebuildStore(record: MatchRecord): MatchStore {
  return { record, state: rebuildState(record.events, record.configSnapshot) };
}

export function computeMetrics(record: MatchRecord): MatchMetrics {
  const calls = record.aiCalls;
  return {
    aiCallCount: calls.length,
    inputTokens: calls.reduce((a, c) => a + c.inputTokens, 0),
    outputTokens: calls.reduce((a, c) => a + c.outputTokens, 0),
    costUsd: Math.round(calls.reduce((a, c) => a + c.costUsd, 0) * 1e6) / 1e6,
    aiWaitMs: calls.reduce((a, c) => a + c.latencyMs, 0),
    wallClockMs:
      record.finishedAt && record.startedAt ? record.finishedAt - record.startedAt : null,
    errorCount: calls.filter((c) => !c.ok).length,
    retryCount: calls.reduce((a, c) => a + c.retries, 0),
    jsonErrorCount: calls.reduce((a, c) => a + c.jsonErrors, 0),
    fallbackCount: calls.filter((c) => c.usedFallback).length,
  };
}

export type AdvanceResult =
  | { status: 'progressed'; task: string }
  | { status: 'waiting'; missing: { pairId: PairId; input: string }[] }
  | { status: 'finished' };

export class MatchRunner {
  constructor(
    public store: MatchStore,
    private ai: AiEngineLike,
    private now: () => number = () => Date.now(),
  ) {}

  private get state(): MatchState {
    return this.store.state;
  }

  private isHuman(pairId: PairId): boolean {
    return this.state.humanPairId === pairId;
  }

  private callOpts(evalKind: CallOpts['evalKind'], stepLabel: string): CallOpts {
    return {
      seed: this.state.seed,
      nonce: this.state.rewindNonce,
      stepLabel,
      evalKind,
    };
  }

  private pushCall(record: AiCallRecord): void {
    this.store.record.aiCalls.push(record);
  }

  /**
   * 1ステップ進める。
   * - 人間の入力待ちなら waiting を返す(何も変更しない)
   * - AI処理1単位(1発言 or 投票一括 or 夜一括)を行ったら progressed
   */
  async advanceOnce(): Promise<AdvanceResult> {
    if (this.store.record.startedAt == null) {
      this.store.record.startedAt = this.now();
    }
    // 入力待ちのポリシー主人を自動解決してから本体タスクへ
    for (let guard = 0; guard < 4; guard++) {
      const task = getPendingTask(this.state);
      switch (task.type) {
        case 'finished': {
          if (this.store.record.finishedAt == null && this.state.winner) {
            this.store.record.finishedAt = this.now();
          }
          return { status: 'finished' };
        }
        case 'advance_day': {
          appendEvents(this.store, applyAdvanceDay(this.state, this.now()));
          this.injectPolicyAdvices();
          return { status: 'progressed', task: 'day_start' };
        }
        case 'wait_inputs': {
          const stillMissing = this.resolvePolicyInputs(task);
          if (stillMissing.length > 0) {
            return { status: 'waiting', missing: stillMissing };
          }
          continue; // 入力が揃ったので次のタスクへ
        }
        case 'ai_speech': {
          await this.doSpeech(task.pairId, task.round);
          return { status: 'progressed', task: `speech:${task.pairId}` };
        }
        case 'ai_votes': {
          await this.doVotes(task.pairIds);
          return { status: 'progressed', task: 'votes' };
        }
        case 'ai_night': {
          await this.doNight(task.wolfPairIds, task.seerPairId);
          return { status: 'progressed', task: 'night' };
        }
      }
    }
    throw new Error('advanceOnce: 進行できませんでした');
  }

  /** 終了(または人間の入力待ち)まで自動で進める */
  async advanceUntilBlocked(maxSteps = 500): Promise<AdvanceResult> {
    let last: AdvanceResult = { status: 'progressed', task: 'start' };
    for (let i = 0; i < maxSteps; i++) {
      last = await this.advanceOnce();
      if (last.status !== 'progressed') return last;
    }
    return last;
  }

  // -------------------------------------------------------------------------
  // AIステップ
  // -------------------------------------------------------------------------

  private async doSpeech(pairId: PairId, round: number): Promise<void> {
    const state = this.state;
    const ctx = buildBuddyContext(state, pairId);
    const label = `d${state.day}-r${round}-${pairId}-c${state.discussion?.cursor ?? 0}-n${state.rewindNonce}`;
    const evalRes = await this.ai.evaluate(
      state.provider,
      pairId,
      ctx,
      this.callOpts('discussion', label),
    );
    this.pushCall(evalRes.record);
    const speechRes = await this.ai.speak(
      state.provider,
      pairId,
      ctx,
      evalRes.output,
      this.callOpts('discussion', label),
    );
    this.pushCall(speechRes.record);
    appendEvents(
      this.store,
      applySpeech(state, pairId, evalRes.output, evalRes.record.id, speechRes.output, this.now()),
    );
  }

  private async doVotes(pairIds: PairId[]): Promise<void> {
    const state = this.state;
    // 評価コールは並列実行できる構造(spec 11.1)
    const results = await Promise.all(
      pairIds.map(async (pairId) => {
        const ctx = buildBuddyContext(state, pairId);
        const label = `d${state.day}-vote-${pairId}-n${state.rewindNonce}`;
        const res = await this.ai.evaluate(state.provider, pairId, ctx, this.callOpts('vote', label));
        return { pairId, res };
      }),
    );
    const evals: Record<PairId, { output: EvalOutput; callId: string }> = {};
    for (const { pairId, res } of results) {
      this.pushCall(res.record);
      evals[pairId] = { output: res.output, callId: res.record.id };
    }
    appendEvents(this.store, applyVotes(state, evals, this.now()));
  }

  private async doNight(wolfPairIds: PairId[], seerPairId: PairId | null): Promise<void> {
    const state = this.state;
    const targets = [...wolfPairIds, ...(seerPairId ? [seerPairId] : [])];
    const results = await Promise.all(
      targets.map(async (pairId) => {
        const ctx = buildBuddyContext(state, pairId);
        const label = `d${state.day}-night-${pairId}-n${state.rewindNonce}`;
        const res = await this.ai.evaluate(
          state.provider,
          pairId,
          ctx,
          this.callOpts('night', label),
        );
        return { pairId, res };
      }),
    );
    const evals: Record<PairId, { output: EvalOutput; callId: string }> = {};
    for (const { pairId, res } of results) {
      this.pushCall(res.record);
      evals[pairId] = { output: res.output, callId: res.record.id };
    }
    appendEvents(this.store, applyNight(state, evals, this.now()));
  }

  // -------------------------------------------------------------------------
  // ポリシー主人(人間以外)の自動入力
  // -------------------------------------------------------------------------

  private policyOf(pairId: PairId): MasterPolicy {
    if (this.isHuman(pairId)) return 'none'; // 人間は自動化しない
    return this.state.otherMastersPolicy;
  }

  private resolvePolicyInputs(
    task: Extract<PendingTask, { type: 'wait_inputs' }>,
  ): { pairId: PairId; input: string }[] {
    const stillMissing: { pairId: PairId; input: string }[] = [];
    for (const m of task.missing) {
      if (this.isHuman(m.pairId) && this.state.mode === 'play') {
        stillMissing.push(m);
        continue;
      }
      if (this.state.mode === 'lab' && this.state.humanPairId === m.pairId) {
        // labでも観察対象に人間を割り当てた場合は待つ
        stillMissing.push(m);
        continue;
      }
      const target =
        m.input === 'trial_choice'
          ? this.policyTrialChoice(m.pairId)
          : this.policyNightProposal(m.pairId);
      try {
        if (m.input === 'trial_choice') {
          appendEvents(this.store, applyTrialChoice(this.state, m.pairId, target, this.now()));
        } else {
          appendEvents(this.store, applyNightProposal(this.state, m.pairId, target, this.now()));
        }
      } catch (e) {
        if (e instanceof GameRuleError) {
          // 無効なポリシー入力は「提案なし」で確定させ、進行を止めない
          if (m.input === 'trial_choice') {
            appendEvents(this.store, applyTrialChoice(this.state, m.pairId, null, this.now()));
          } else {
            appendEvents(this.store, applyNightProposal(this.state, m.pairId, null, this.now()));
          }
        } else {
          throw e;
        }
      }
    }
    return stillMissing;
  }

  private aliveOthers(pairId: PairId): PairId[] {
    return alivePairs(this.state)
      .filter((p) => p.pairId !== pairId)
      .map((p) => p.pairId);
  }

  private policyTrialChoice(pairId: PairId): PairId | null {
    const policy = this.policyOf(pairId);
    const others = this.aliveOthers(pairId);
    if (others.length === 0) return null;
    const labels = ['policy-trial', this.state.day, pairId, this.state.rewindNonce];
    switch (policy) {
      case 'none':
        return null;
      case 'random':
        return pickOne(others, this.state.seed, ...labels);
      case 'simple': {
        // 前日の投票の最多対象(生存者)へ乗る。なければランダム。
        const prev = this.state.voteHistory.filter((v) => v.day === this.state.day - 1);
        const tally = new Map<PairId, number>();
        for (const v of prev) {
          if (others.includes(v.targetId)) tally.set(v.targetId, (tally.get(v.targetId) ?? 0) + 1);
        }
        const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
        return top ? top[0] : pickOne(others, this.state.seed, ...labels);
      }
      case 'ai': {
        const ev = this.state.latestEvals[pairId];
        const scores = ev?.suspicions ?? {};
        const best = others
          .map((id) => [id, scores[id] ?? 50] as const)
          .sort((a, b) => b[1] - a[1])[0];
        return best ? best[0] : pickOne(others, this.state.seed, ...labels);
      }
    }
  }

  private policyNightProposal(pairId: PairId): PairId | null {
    const policy = this.policyOf(pairId);
    const candidates = alivePairs(this.state)
      .filter((p) => p.role !== 'werewolf')
      .map((p) => p.pairId);
    if (candidates.length === 0) return null;
    const labels = ['policy-night', this.state.day, pairId, this.state.rewindNonce];
    switch (policy) {
      case 'none':
        return null;
      case 'random':
      case 'simple':
        return pickOne(candidates, this.state.seed, ...labels);
      case 'ai': {
        const ev = this.state.latestEvals[pairId];
        const scores = ev?.attackPriorities ?? {};
        const best = candidates
          .map((id) => [id, scores[id] ?? 30] as const)
          .sort((a, b) => b[1] - a[1])[0];
        return best ? best[0] : pickOne(candidates, this.state.seed, ...labels);
      }
    }
  }

  /** 討論開始時にポリシー主人の助言を注入する */
  private injectPolicyAdvices(): void {
    for (const pair of alivePairs(this.state)) {
      const pairId = pair.pairId;
      if (this.isHuman(pairId)) continue;
      const policy = this.policyOf(pairId);
      if (policy === 'none') continue;
      const others = this.aliveOthers(pairId);
      if (others.length === 0) continue;
      const labels = ['policy-advice', this.state.day, pairId, this.state.rewindNonce];
      let advice: Advice | null = null;
      if (policy === 'random') {
        if (rand(this.state.seed, ...labels) < 0.5) {
          advice = { kind: 'suspicion', targetId: pickOne(others, this.state.seed, ...labels, 't') };
        }
      } else if (policy === 'simple') {
        const prev = this.state.voteHistory.filter((v) => v.day === this.state.day - 1);
        const tally = new Map<PairId, number>();
        for (const v of prev) {
          if (others.includes(v.targetId)) tally.set(v.targetId, (tally.get(v.targetId) ?? 0) + 1);
        }
        const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
        if (top) advice = { kind: 'suspicion', targetId: top[0] };
      } else if (policy === 'ai') {
        const ev = this.state.latestEvals[pairId];
        if (ev) {
          const best = others
            .map((id) => [id, ev.suspicions[id] ?? 50] as const)
            .sort((a, b) => b[1] - a[1])[0];
          if (best) advice = { kind: 'suspicion', targetId: best[0] };
        }
      }
      if (advice) {
        try {
          appendEvents(this.store, applyAdvice(this.state, pairId, advice, this.now()));
        } catch (e) {
          if (!(e instanceof GameRuleError)) throw e;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 人間操作の受け付け(serverから呼ぶ)
  // -------------------------------------------------------------------------

  submitAdvice(pairId: PairId, advice: Advice): void {
    appendEvents(this.store, applyAdvice(this.state, pairId, advice, this.now()));
  }

  submitTrialChoice(pairId: PairId, targetId: PairId | null): void {
    appendEvents(this.store, applyTrialChoice(this.state, pairId, targetId, this.now()));
  }

  submitNightProposal(pairId: PairId, targetId: PairId | null): void {
    appendEvents(this.store, applyNightProposal(this.state, pairId, targetId, this.now()));
  }
}

export { getPair };
