/** モックAIでの完走・決定論・フォールバック・信頼度と事実の扱いのテスト */
import { describe, expect, it } from 'vitest';
import {
  ROLE_LABEL,
  type AiCallRecord,
  type EvalOutput,
  type MatchRecord,
  type PairId,
  type Role,
  type SpeechOutput,
} from '@aibw/shared';
import {
  buildBuddyContext,
  canSeeEvent,
  createMatch,
  getPendingTask,
  type BuddyContext,
} from '@aibw/game-core';
import { AiEngine } from '../src/calls.js';
import { mockEvaluate, mockSpeak } from '../src/mock.js';
import { MatchRunner, computeMetrics, rebuildStore } from '../src/runner.js';
import type { AiEngineLike } from '../src/runner.js';
import type { CallOpts, LlmProvider, ProviderResult } from '../src/provider.js';
import { makeSnapshot, makeStore, testModels, testPrompts } from './fixtures.js';

function makeRunner(seed: string, rules?: Parameters<typeof makeStore>[1]) {
  let t = 1_700_000_000_000;
  const now = () => (t += 10);
  const store = makeStore(seed, rules, 1_700_000_000_000);
  const ai = new AiEngine({ models: testModels, prompts: testPrompts, now });
  return { runner: new MatchRunner(store, ai, now), store };
}

function makePlayRunner(
  seed: string,
  abilities: { trust: number; deception: number },
) {
  let t = 1_700_000_000_000;
  const now = () => (t += 10);
  const config = makeSnapshot(
    {
      discussionMode: 'turns',
      discussionRounds: 2,
      firstDayFocusCount: 2,
      otherMastersPolicy: 'none',
    },
    { b1: abilities },
  );
  const created = createMatch({
    matchId: `m-${seed}`,
    seed,
    mode: 'play',
    provider: 'mock',
    humanPairIndex: 0,
    config,
    now: t,
  });
  const record: MatchRecord = {
    schemaVersion: 1,
    matchId: `m-${seed}`,
    seed,
    createdAt: t,
    startedAt: null,
    finishedAt: null,
    mode: 'play',
    provider: 'mock',
    humanPairId: 'p1',
    configSnapshot: config,
    events: created.events,
    aiCalls: [],
  };
  const store = rebuildStore(record);
  const ai = new AiEngine({ models: testModels, prompts: testPrompts, now });
  return { runner: new MatchRunner(store, ai, now), store };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

function controlledEval(pairId: PairId): EvalOutput {
  return {
    suspicions: {},
    primaryHypothesis: `${pairId}の仮説`,
    altHypotheses: [],
    confidence: 50,
    toShare: [],
    toWithhold: [],
    questionTargetId: null,
    questionTheme: null,
    voteCandidateId: null,
    reasonSummary: `${pairId}の判断`,
  };
}

function controlledCall(pairId: PairId, callType: 'eval' | 'speech'): AiCallRecord {
  return {
    id: `${callType}-${pairId}`,
    ts: 1_700_000_000_000,
    pairId,
    callType,
    evalKind: 'discussion',
    provider: 'controlled',
    model: 'test',
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    retries: 0,
    jsonErrors: 0,
    ok: true,
    usedFallback: false,
  };
}

class ControlledAi implements AiEngineLike {
  readonly evalOpts = new Map<PairId, CallOpts>();
  readonly pendingEvals = new Map<
    PairId,
    Deferred<{ output: EvalOutput; record: AiCallRecord }>
  >();
  readonly pendingSpeeches = new Map<
    PairId,
    Deferred<{ output: SpeechOutput; record: AiCallRecord }>
  >();

  evaluate(
    _providerName: string,
    pairId: PairId,
    _ctx: BuddyContext,
    opts: CallOpts,
  ): Promise<{ output: EvalOutput; record: AiCallRecord }> {
    this.evalOpts.set(pairId, opts);
    const pending = deferred<{ output: EvalOutput; record: AiCallRecord }>();
    this.pendingEvals.set(pairId, pending);
    return pending.promise;
  }

  speak(
    _providerName: string,
    pairId: PairId,
    _ctx: BuddyContext,
    _evalOutput: EvalOutput,
    _opts: CallOpts,
  ): Promise<{ output: SpeechOutput; record: AiCallRecord }> {
    const pending = deferred<{ output: SpeechOutput; record: AiCallRecord }>();
    this.pendingSpeeches.set(pairId, pending);
    return pending.promise;
  }

  resolveEval(pairId: PairId): void {
    const pending = this.pendingEvals.get(pairId);
    if (!pending) throw new Error(`評価待ちがありません: ${pairId}`);
    pending.resolve({ output: controlledEval(pairId), record: controlledCall(pairId, 'eval') });
  }

  rejectEval(pairId: PairId, reason: unknown): void {
    const pending = this.pendingEvals.get(pairId);
    if (!pending) throw new Error(`評価待ちがありません: ${pairId}`);
    pending.reject(reason);
  }

  resolveSpeech(pairId: PairId): void {
    const pending = this.pendingSpeeches.get(pairId);
    if (!pending) throw new Error(`発言待ちがありません: ${pairId}`);
    pending.resolve({
      output: { text: `${pairId}の発言`, accusesId: null },
      record: controlledCall(pairId, 'speech'),
    });
  }
}

describe('モックAIでの一試合完走', () => {
  it('quick構成で最後まで完走し、勝敗が決まる', async () => {
    const { runner, store } = makeRunner('full-run');
    const result = await runner.advanceUntilBlocked(500);
    expect(result.status).toBe('finished');
    expect(store.state.winner).not.toBeNull();
    expect(store.record.events.some((e) => e.type === 'match_finished')).toBe(true);
    expect(store.record.aiCalls.length).toBeGreaterThan(0);
    const metrics = computeMetrics(store.record);
    expect(metrics.aiCallCount).toBe(store.record.aiCalls.length);
    expect(metrics.errorCount).toBe(0);
  });

  it('勝敗を生んだAIステップの完了時点でfinishedAtを記録する', async () => {
    const { runner, store } = makeRunner('finish-timestamp');
    let foundWinningStep = false;
    for (let guard = 0; guard < 500; guard++) {
      const result = await runner.advanceOnce();
      if (store.state.winner) {
        foundWinningStep = true;
        expect(result.status).toBe('progressed');
        expect(store.record.finishedAt).not.toBeNull();
        expect(computeMetrics(store.record).wallClockMs).not.toBeNull();
        break;
      }
      if (result.status === 'finished') break;
    }
    expect(foundWinningStep).toBe(true);
  });

  it('同じシードなら同じ結末を再現する(モックの決定論)', async () => {
    const run = async () => {
      const { runner, store } = makeRunner('determinism');
      await runner.advanceUntilBlocked(500);
      return {
        winner: store.state.winner,
        types: store.record.events.map((e) => e.type).join(','),
        speeches: store.record.events
          .filter((e) => e.type === 'speech')
          .map((e) => (e.type === 'speech' ? e.payload.text : ''))
          .join('|'),
      };
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
  });

  it('pack構成(狼2)で襲撃統合イベントが発生して完走する', async () => {
    const { runner, store } = makeRunner('pack-run', {
      pairCount: 8,
      roleSetup: { werewolf: 2, seer: 1 },
      maxDays: 4,
    });
    const result = await runner.advanceUntilBlocked(800);
    expect(result.status).toBe('finished');
    const details = store.record.events.filter((e) => e.type === 'attack_detail');
    expect(details.length).toBeGreaterThan(0);
    const first = details[0];
    if (first?.type === 'attack_detail') {
      expect(first.payload.perWolf.length).toBe(2);
      expect(first.payload.method).toBe('sumNormalized');
    }
  });

  it('リプレイ: 保存イベントから状態を復元しても完走後状態と一致する', async () => {
    const { runner, store } = makeRunner('rebuild-run');
    await runner.advanceUntilBlocked(500);
    const rebuilt = rebuildStore(JSON.parse(JSON.stringify(store.record)));
    expect(JSON.parse(JSON.stringify(rebuilt.state))).toEqual(
      JSON.parse(JSON.stringify(store.state)),
    );
  });
});

describe('プロバイダー失敗時のフォールバック', () => {
  class FailingProvider implements LlmProvider {
    readonly name = 'failing';
    async evaluate(): Promise<ProviderResult<EvalOutput>> {
      throw new Error('JsonValidationError: 模擬失敗');
    }
    async speak(): Promise<ProviderResult<SpeechOutput>> {
      throw new Error('APIConnectionError: 模擬失敗');
    }
  }

  it('例外時はモックの決定論的フォールバックへ切り替わり、記録が残る', async () => {
    const store = makeStore('fallback');
    const ai = new AiEngine({ models: testModels, prompts: testPrompts });
    // failingプロバイダーを注入
    (ai as unknown as { providers: Map<string, LlmProvider> }).providers.set(
      'failing',
      new FailingProvider(),
    );
    const ctx = buildBuddyContext(store.state, 'p1');
    const opts: CallOpts = { seed: 's', nonce: 0, stepLabel: 'test', evalKind: 'discussion' };
    const { output, record } = await ai.evaluate('failing', 'p1', ctx, opts);
    expect(record.usedFallback).toBe(true);
    expect(record.ok).toBe(false);
    expect(record.error).toContain('模擬失敗');
    expect(Object.keys(output.suspicions).length).toBeGreaterThan(0);
  });
});

describe('モック評価の信頼度・確定情報の扱い', () => {
  function ctxWith(
    trust: number,
    mutate?: (ctx: BuddyContext) => void,
  ): BuddyContext {
    const store = makeStore('mock-eval');
    const ctx = buildBuddyContext(store.state, 'p1');
    ctx.self.abilities = { ...ctx.self.abilities, trust };
    mutate?.(ctx);
    return ctx;
  }
  const opts: CallOpts = { seed: 's', nonce: 0, stepLabel: 'L', evalKind: 'discussion' };

  it('主観助言は信頼度に応じて重みが変わる(0なら影響なし)', () => {
    const base = mockEvaluate(ctxWith(0), opts).suspicions['p2'] ?? 0;
    const withAdviceNoTrust = mockEvaluate(
      ctxWith(0, (c) => {
        c.advices.push({ day: 1, advice: { kind: 'suspicion', targetId: 'p2' } });
      }),
      opts,
    ).suspicions['p2'];
    const withAdviceFullTrust = mockEvaluate(
      ctxWith(100, (c) => {
        c.advices.push({ day: 1, advice: { kind: 'suspicion', targetId: 'p2' } });
      }),
      opts,
    ).suspicions['p2'];
    expect(withAdviceNoTrust).toBeCloseTo(base, 5);
    expect((withAdviceFullTrust ?? 0) - base).toBeCloseTo(20, 0); // maxBonus=20
  });

  it('確定情報は信頼度0でも事実として最優先される(主観と別扱い)', () => {
    const withFact = mockEvaluate(
      ctxWith(0, (c) => {
        c.sharedFacts.push({
          id: 'f1',
          day: 1,
          targetId: 'p3',
          isWolf: true,
          source: 'divination',
        });
      }),
      opts,
    );
    expect(withFact.suspicions['p3']).toBeGreaterThanOrEqual(95);
    const withHumanFact = mockEvaluate(
      ctxWith(0, (c) => {
        c.sharedFacts.push({
          id: 'f2',
          day: 1,
          targetId: 'p3',
          isWolf: false,
          source: 'divination',
        });
      }),
      opts,
    );
    expect(withHumanFact.suspicions['p3']).toBeLessThanOrEqual(10);
  });

  it('狼ではない確定情報を人格語尾で曖昧にしない', () => {
    const ctx = ctxWith(0, (c) => {
      c.sharedFacts.push({
        id: 'f-white-speech',
        day: 1,
        targetId: 'p3',
        isWolf: false,
        source: 'divination',
      });
    });
    const speeches = Array.from({ length: 20 }, (_, index) => {
      const callOpts = { ...opts, stepLabel: `white-fact-${index}` };
      return mockSpeak(ctx, mockEvaluate(ctx, callOpts), callOpts).text;
    });
    const factSpeech = speeches.find((text) => text.includes('狼ではないと確定している'));
    expect(factSpeech).toBeDefined();
    expect(factSpeech).not.toMatch(/かも|かな|じゃないかな|だと思う/);
  });
});

describe('モックの役職を名乗る相談', () => {
  it('高親密度では別役職の提案も採用し得るが、偽の能力結果は作らない', () => {
    const store = makeStore('mock-role-claim');
    const ctx = buildBuddyContext(store.state, 'p1');
    ctx.self.abilities = { ...ctx.self.abilities, trust: 100, deception: 100 };
    const claimedRole = ctx.self.role === 'seer' ? 'medium' : 'seer';
    ctx.roleClaimProposal = { day: 1, claimedRole };
    ctx.advices.push({ day: 1, advice: { kind: 'role_claim', claimedRole } });

    const declarations = Array.from({ length: 20 }, (_, index) => {
      const opts: CallOpts = {
        seed: 'role-claim-seed',
        nonce: 0,
        stepLabel: `role-claim-${index}`,
        evalKind: 'discussion',
      };
      return mockSpeak(ctx, mockEvaluate(ctx, opts), opts);
    }).filter((speech) => speech.declaredRole === claimedRole);

    expect(declarations.length).toBeGreaterThan(0);
    for (const speech of declarations) {
      expect(speech.text).toContain(ROLE_LABEL[claimedRole]);
      expect(speech.text).not.toMatch(/占いで分か|霊媒で分か|護衛.*成功/);
    }
  });

  it('今日は名乗らない提案なら公開宣言を返さない', () => {
    const store = makeStore('mock-role-wait');
    const ctx = buildBuddyContext(store.state, 'p1');
    ctx.roleClaimProposal = { day: 1, claimedRole: null };
    const opts: CallOpts = {
      seed: 'role-wait-seed',
      nonce: 0,
      stepLabel: 'role-wait',
      evalKind: 'discussion',
    };
    expect(mockSpeak(ctx, mockEvaluate(ctx, opts), opts).declaredRole).toBeNull();
  });
});

describe('役職を名乗る相談の進行統合', () => {
  const roles: Role[] = ['villager', 'seer', 'guardian', 'medium', 'werewolf'];

  async function reachOwnerAdvice(
    runner: MatchRunner,
    store: ReturnType<typeof makePlayRunner>['store'],
  ): Promise<void> {
    const waiting = await runner.advanceUntilBlocked(100);
    expect(waiting).toEqual({
      status: 'waiting',
      missing: [{ pairId: 'p1', input: 'discussion_advice' }],
    });
    expect(store.state.discussion?.stage).toBe('advice');
  }

  it('主人の秘密相談を第2幕のモック発言へ渡し、実際に名乗った内容だけを公開する', async () => {
    const { runner, store } = makePlayRunner(
      'role-claim-e2e-adopts',
      { trust: 100, deception: 100 },
    );
    await reachOwnerAdvice(runner, store);

    const actualRole = store.state.pairs.find((pair) => pair.pairId === 'p1')?.role;
    if (!actualRole) throw new Error('p1の役職がありません');
    const claimedRole = roles.find((role) => role !== actualRole);
    if (!claimedRole) throw new Error('別の役職がありません');
    expect(
      store.record.events.some(
        (event) => event.type === 'role_declared' && event.payload.pairId === 'p1',
      ),
    ).toBe(false);

    runner.submitAdvice('p1', { kind: 'role_claim', claimedRole });
    const adviceEvent = store.record.events.at(-1);
    expect(adviceEvent?.type).toBe('advice_given');
    if (!adviceEvent) throw new Error('相談イベントがありません');
    expect(canSeeEvent(adviceEvent, { kind: 'public' })).toBe(false);

    const afterResponse = await runner.advanceUntilBlocked(100);
    expect(afterResponse).toMatchObject({ status: 'waiting' });
    expect(
      store.record.events.some(
        (event) =>
          event.type === 'speech' &&
          event.payload.pairId === 'p1' &&
          event.payload.round === 2,
      ),
    ).toBe(true);

    const declarations = store.record.events.filter(
      (event) => event.type === 'role_declared' && event.payload.pairId === 'p1',
    );
    expect(declarations).toHaveLength(1);
    const declaration = declarations[0];
    if (!declaration || declaration.type !== 'role_declared') {
      throw new Error('公開された役職宣言がありません');
    }
    expect(declaration.visibility).toEqual({ kind: 'public' });
    expect(declaration.payload).toEqual({ pairId: 'p1', claimedRole });
    expect(Object.keys(declaration.payload).sort()).toEqual(['claimedRole', 'pairId']);
    expect(JSON.stringify(declaration)).not.toMatch(/trueRole|isTruth/);
  });

  it('同じ秘密相談でも低い親密度では採用しない場合があり、相談を命令にしない', async () => {
    const { runner, store } = makePlayRunner(
      'role-claim-e2e-refuses',
      { trust: 0, deception: 0 },
    );
    await reachOwnerAdvice(runner, store);

    const actualRole = store.state.pairs.find((pair) => pair.pairId === 'p1')?.role;
    if (!actualRole) throw new Error('p1の役職がありません');
    const claimedRole = roles.find((role) => role !== actualRole);
    if (!claimedRole) throw new Error('別の役職がありません');

    runner.submitAdvice('p1', { kind: 'role_claim', claimedRole });
    await runner.advanceUntilBlocked(100);

    expect(
      store.record.events.some(
        (event) =>
          event.type === 'speech' &&
          event.payload.pairId === 'p1' &&
          event.payload.round === 2,
      ),
    ).toBe(true);
    expect(
      store.record.events.some(
        (event) => event.type === 'role_declared' && event.payload.pairId === 'p1',
      ),
    ).toBe(false);
    expect(store.state.roleClaimProposal.p1).toEqual({ day: 1, claimedRole });
    expect(store.state.publicRoleClaims).not.toHaveProperty('p1');
  });
});

describe('ポリシー主人の確定情報共有', () => {
  it('simpleポリシーの占い主人は初日白通知を1日目に共有し、バディへ白情報が届く', async () => {
    const { runner, store } = makeRunner('policy-fact-share', {
      firstNightDivination: 'white',
      otherMastersPolicy: 'simple',
    });
    await runner.advanceUntilBlocked(500);
    const shares = store.record.events.filter((e) => e.type === 'fact_shared');
    expect(shares.length).toBeGreaterThanOrEqual(1);
    const first = shares[0];
    if (first?.type !== 'fact_shared') throw new Error('fact_shared がない');
    expect(first.day).toBe(1);
    expect(first.payload.fact.isWolf).toBe(false);
  });

  it('simpleポリシーは前日票のない1日目の裁判でランダム選択せず棄権する', async () => {
    const { runner, store } = makeRunner('policy-simple-abstains', {
      otherMastersPolicy: 'simple',
    });
    await runner.advanceUntilBlocked(500);
    const dayOneChoices = store.record.events.filter(
      (event) => event.type === 'trial_choice' && event.day === 1,
    );
    expect(dayOneChoices.length).toBeGreaterThan(0);
    expect(
      dayOneChoices.every(
        (event) => event.type === 'trial_choice' && event.payload.targetId === null,
      ),
    ).toBe(true);
  });

  it('aiポリシーの狼主人は夜評価より前に、直前の襲撃優先度から提案する', async () => {
    const { runner, store } = makeRunner('policy-ai-night-proposal-order', {
      pairCount: 8,
      roleSetup: { werewolf: 2, seer: 1 },
      maxDays: 4,
      otherMastersPolicy: 'ai',
    });

    let checked = false;
    for (let guard = 0; guard < 500 && !store.state.winner; guard++) {
      const eventCount = store.record.events.length;
      await runner.advanceOnce();
      const added = store.record.events.slice(eventCount);
      const proposal = added.find((event) => event.type === 'night_proposal');
      if (!proposal || proposal.type !== 'night_proposal') continue;

      const previousEval = [...store.record.events]
        .reverse()
        .find(
          (event) =>
            event.seq < proposal.seq &&
            event.type === 'eval_recorded' &&
            event.payload.pairId === proposal.payload.pairId,
        );
      if (!previousEval || previousEval.type !== 'eval_recorded') {
        throw new Error('狼の直前評価がありません');
      }
      expect(previousEval.payload.kind).toBe('vote');
      const beforeProposal = rebuildStore({
        ...store.record,
        events: store.record.events.filter((event) => event.seq < proposal.seq),
      }).state;
      const validTargets = new Set(
        beforeProposal.pairs
          .filter((pair) => pair.alive && pair.role !== 'werewolf')
          .map((pair) => pair.pairId),
      );
      const expectedTarget = Object.entries(previousEval.payload.output.attackPriorities ?? {})
        .filter(([pairId]) => validTargets.has(pairId))
        .sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
      expect(expectedTarget).not.toBeNull();
      expect(proposal.payload.targetId).toBe(expectedTarget);

      const nightEval = added.find(
        (event) =>
          event.type === 'eval_recorded' &&
          event.payload.kind === 'night' &&
          event.payload.pairId === proposal.payload.pairId,
      );
      expect(nightEval?.seq).toBeGreaterThan(proposal.seq);
      checked = true;
    }
    expect(checked).toBe(true);
  });
});

describe('2幕討論のモック発言', () => {
  const opts: CallOpts = {
    seed: 'dialogue-test',
    nonce: 0,
    stepLabel: 'direct-question',
    evalKind: 'discussion',
  };

  it('初日の抽選対象は先に弁明し、他のバディは2人の弁明を比較する', () => {
    const store = makeStore('focus-mock');
    const defenseCtx = buildBuddyContext(store.state, 'p1');
    defenseCtx.discussionFocus = [
      { pairId: 'p1', name: defenseCtx.self.buddyName },
      { pairId: 'p2', name: 'B2' },
    ];
    defenseCtx.discussionTurn = {
      round: 1,
      kind: 'opening_defense',
      askerId: null,
      askerName: null,
      targetId: null,
      targetName: null,
      theme: null,
    };
    const defense = mockSpeak(defenseCtx, mockEvaluate(defenseCtx, opts), opts);
    expect(defense.text).toMatch(/狼憑き(じゃ|では)ない/);
    expect(defense.accusesId).toBeNull();

    const opinionCtx = buildBuddyContext(store.state, 'p3');
    opinionCtx.discussionFocus = [
      { pairId: 'p1', name: 'B1' },
      { pairId: 'p2', name: 'B2' },
    ];
    opinionCtx.discussionTurn = {
      round: 1,
      kind: 'opening_opinion',
      askerId: null,
      askerName: null,
      targetId: null,
      targetName: null,
      theme: null,
    };
    const opinion = mockSpeak(opinionCtx, mockEvaluate(opinionCtx, opts), opts);
    expect(opinion.accusesId).toBeNull();
    expect(opinion.text).toMatch(/弁明|抽選|説明/);
  });

  it('通常リアクションは疑い返しを固定せず、説明・保留として返す', () => {
    const store = makeStore('reaction-mock');
    const ctx = buildBuddyContext(store.state, 'p1');
    ctx.publicLog = [{
      seq: 10,
      day: 1,
      t: 'speech',
      round: 2,
      turnKind: 'reaction',
      pairId: 'p2',
      name: 'B2',
      text: 'B1の具体性が足りないと思う',
      accusesId: 'p1',
    }];
    ctx.discussionTurn = {
      round: 2,
      kind: 'reaction',
      askerId: null,
      askerName: null,
      targetId: null,
      targetName: null,
      replyToId: 'p2',
      replyToName: 'B2',
      theme: null,
    };
    const reaction = mockSpeak(ctx, mockEvaluate(ctx, opts), opts);
    expect(reaction.accusesId).toBeNull();
    expect(reaction.text).toMatch(/指摘|見方|疑われ|疑い/);
  });

  it('指名質問は対象へ一問だけ送り、回答ターンは質問への返答だけを生成する', () => {
    const store = makeStore('dialogue-mock');
    const questionCtx = buildBuddyContext(store.state, 'p1');
    const theme = {
      id: 'most_suspicious',
      label: '現在最も疑っている相手',
      mockTemplate: '{target}は今、誰が一番怪しいと思ってる?',
      promptHint: '相手と理由を尋ねる',
    };
    questionCtx.discussionTurn = {
      round: 2,
      kind: 'question',
      askerId: 'p1',
      askerName: questionCtx.self.buddyName,
      targetId: 'p2',
      targetName: 'B2',
      theme,
    };
    const questionEval = mockEvaluate(questionCtx, opts);
    const question = mockSpeak(questionCtx, questionEval, opts);
    expect(question.text).toBe('B2は今、誰が一番怪しいと思ってる?');

    const answerCtx = buildBuddyContext(store.state, 'p2');
    answerCtx.discussionTurn = {
      round: 2,
      kind: 'answer',
      askerId: 'p1',
      askerName: 'B1',
      targetId: 'p2',
      targetName: answerCtx.self.buddyName,
      theme,
    };
    const answerEval = mockEvaluate(answerCtx, opts);
    const answer = mockSpeak(answerCtx, answerEval, opts);
    expect(answer.text).toContain('今いちばん疑っているのは');
    expect(answer.text).not.toMatch(/^B1への答え/);
    expect(answer.text).not.toContain('?');
  });

  it('セバスは長い前置きを足さず、最後の一箇所だけ執事口調を残す', () => {
    const store = makeStore('sebas-brief-style');
    const ctx = buildBuddyContext(store.state, 'p3');
    ctx.self.buddyId = 'sebas';
    ctx.discussionFocus = [
      { pairId: 'p3', name: ctx.self.buddyName },
      { pairId: 'p2', name: 'レン' },
    ];
    ctx.discussionTurn = {
      round: 1,
      kind: 'opening_defense',
      askerId: null,
      askerName: null,
      targetId: null,
      targetName: null,
      theme: null,
    };
    const defense = mockSpeak(ctx, mockEvaluate(ctx, opts), opts);
    expect(defense.text).toMatch(/ございません|ください|ですな|存じます/);
    expect([...defense.text].length).toBeLessThanOrEqual(60);

    const theme = {
      id: 'most_suspicious',
      label: '現在最も疑っている相手',
      mockTemplate: '{target}は今、誰が一番怪しいと思ってる?',
      promptHint: '相手と理由を尋ねる',
    };
    ctx.discussionTurn = {
      round: 2,
      kind: 'question',
      askerId: 'p3',
      askerName: ctx.self.buddyName,
      targetId: 'p2',
      targetName: 'レン',
      theme,
    };
    const question = mockSpeak(ctx, mockEvaluate(ctx, opts), opts);
    expect(question.text).toBe('レンは今、誰を一番疑っておりますか');
  });

  it('感嘆符や疑問符の直後へ句点を重ねない', () => {
    const store = makeStore('mock-punctuation');
    const ctx = buildBuddyContext(store.state, 'p1');
    ctx.self.role = 'werewolf';
    ctx.self.unlockedDeception = [];
    ctx.self.persona = {
      ...ctx.self.persona,
      mockFlavor: { endings: ['ですからね!'], exclamations: [] },
    };
    const output = mockSpeak(ctx, mockEvaluate(ctx, opts), opts);
    expect(output.text).not.toMatch(/[!?！？]。/u);
  });
});

describe('時間制討論の並列バッチ', () => {
  const startedAt = 1_700_000_000_000;
  const timedRules = {
    discussionMode: 'timed' as const,
    discussionDurationSec: 150,
    discussionBatchSize: 2,
    discussionMaxMessages: 10,
    firstDayFocusCount: 0,
    otherMastersPolicy: 'none' as const,
  };

  it('速いAIの発言を、遅いAIの完了を待たずにイベントへ反映する', async () => {
    let currentTime = startedAt;
    const store = makeStore('timed-streaming', timedRules, startedAt);
    const ai = new ControlledAi();
    const runner = new MatchRunner(store, ai, () => currentTime);

    await runner.advanceOnce(); // day_start -> discussion
    const runningBatch = runner.advanceOnce();
    await flushMicrotasks();

    ai.resolveEval('p1');
    await flushMicrotasks();
    ai.resolveSpeech('p1');
    await flushMicrotasks();

    expect(
      store.record.events.filter((event) => event.type === 'speech').map((event) =>
        event.type === 'speech' ? event.payload.pairId : null),
    ).toEqual(['p1']);
    expect(ai.pendingEvals.has('p2')).toBe(true);

    currentTime += 1;
    ai.resolveEval('p2');
    await flushMicrotasks();
    ai.resolveSpeech('p2');
    await runningBatch;

    expect(
      store.record.events.filter((event) => event.type === 'speech').map((event) =>
        event.type === 'speech' ? event.payload.pairId : null),
    ).toEqual(['p1', 'p2']);
  });

  it('締切後に完成した発言はイベントへ反映しない', async () => {
    let currentTime = startedAt;
    const store = makeStore(
      'timed-late-output',
      { ...timedRules, discussionBatchSize: 1 },
      startedAt,
    );
    const ai = new ControlledAi();
    const runner = new MatchRunner(store, ai, () => currentTime);

    await runner.advanceOnce();
    const runningBatch = runner.advanceOnce();
    await flushMicrotasks();
    ai.resolveEval('p1');
    await flushMicrotasks();
    expect(ai.evalOpts.get('p1')?.deadlineAt).toBe(startedAt + 90_000);

    currentTime = startedAt + 90_000;
    ai.resolveSpeech('p1');
    await runningBatch;

    expect(store.record.events.filter((event) => event.type === 'speech')).toHaveLength(0);
    expect(store.record.aiCalls.map((call) => call.callType)).toEqual(['eval', 'speech']);
  });

  it('1件が失敗しても、他の成功発言を残してバッチを完了する', async () => {
    const store = makeStore('timed-partial-failure', timedRules, startedAt);
    const ai = new ControlledAi();
    const runner = new MatchRunner(store, ai, () => startedAt);

    await runner.advanceOnce();
    const runningBatch = runner.advanceOnce();
    await flushMicrotasks();

    ai.rejectEval('p1', new Error('p1 evaluation failed'));
    ai.resolveEval('p2');
    await flushMicrotasks();
    ai.resolveSpeech('p2');

    await expect(runningBatch).resolves.toEqual({ status: 'progressed', task: 'speech_batch:2' });
    const speeches = store.record.events.filter((event) => event.type === 'speech');
    expect(speeches).toHaveLength(1);
    expect(speeches[0]?.type === 'speech' ? speeches[0].payload.pairId : null).toBe('p2');
  });

  it('指名質問への単独回答は直前評価を再利用し、発言コール1回で返す', async () => {
    let nowValue = 1_700_000_000_000;
    const now = () => (nowValue += 10);
    const config = makeSnapshot({
      discussionMode: 'timed',
      discussionDurationSec: 150,
      discussionBatchSize: 2,
      discussionMaxMessages: 30,
      firstDayFocusCount: 0,
      advicePerDay: 0,
      otherMastersPolicy: 'none',
    });
    config.advice.questionThemes.push({
      id: 'most_suspicious',
      label: '現在最も疑っている相手',
      mockTemplate: '{target}は今、誰が一番怪しいと思ってる?',
      promptHint: '現在の疑い先と理由を尋ねる',
    });
    const created = createMatch({
      matchId: 'm-timed-reuse-direct-answer',
      seed: 'timed-reuse-direct-answer',
      mode: 'lab',
      provider: 'mock',
      humanPairIndex: null,
      config,
      now: nowValue,
    });
    const record: MatchRecord = {
      schemaVersion: 1,
      matchId: 'm-timed-reuse-direct-answer',
      seed: 'timed-reuse-direct-answer',
      createdAt: nowValue,
      startedAt: null,
      finishedAt: null,
      mode: 'lab',
      provider: 'mock',
      humanPairId: null,
      configSnapshot: config,
      events: created.events,
      aiCalls: [],
    };
    const store = rebuildStore(record);
    const ai = new AiEngine({ models: testModels, prompts: testPrompts, now });
    const runner = new MatchRunner(store, ai, now);

    let answerObserved = false;
    for (
      let step = 0;
      step < 80 && (store.state.phase === 'day_start' || store.state.phase === 'discussion');
      step++
    ) {
      const eventCount = store.record.events.length;
      const callCount = store.record.aiCalls.length;
      await runner.advanceOnce();
      const answer = store.record.events.slice(eventCount).find(
        (event) => event.type === 'speech' && event.payload.turnKind === 'answer',
      );
      if (!answer) continue;
      const addedCalls = store.record.aiCalls.slice(callCount);
      expect(addedCalls.map((call) => call.callType)).toEqual(['speech']);
      expect(
        store.record.events.slice(eventCount).some((event) => event.type === 'eval_recorded'),
      ).toBe(false);
      answerObserved = true;
      break;
    }
    expect(answerObserved).toBe(true);
  });

  it('前日評価または主人入力で無効化された評価は、単独回答でも再評価する', async () => {
    for (const freshness of ['previous-day', 'invalidated'] as const) {
      let nowValue = 1_700_000_000_000;
      const now = () => (nowValue += 10);
      const config = makeSnapshot({
        discussionMode: 'timed',
        discussionDurationSec: 150,
        discussionBatchSize: 2,
        discussionMaxMessages: 30,
        firstDayFocusCount: 0,
        advicePerDay: 0,
        otherMastersPolicy: 'none',
      });
      config.advice.questionThemes.push({
        id: 'most_suspicious',
        label: '現在最も疑っている相手',
        mockTemplate: '{target}は今、誰が一番怪しいと思ってる?',
        promptHint: '現在の疑い先と理由を尋ねる',
      });
      const matchId = `m-timed-${freshness}-answer`;
      const created = createMatch({
        matchId,
        seed: `timed-${freshness}-answer`,
        mode: 'lab',
        provider: 'mock',
        humanPairIndex: null,
        config,
        now: nowValue,
      });
      const record: MatchRecord = {
        schemaVersion: 1,
        matchId,
        seed: `timed-${freshness}-answer`,
        createdAt: nowValue,
        startedAt: null,
        finishedAt: null,
        mode: 'lab',
        provider: 'mock',
        humanPairId: null,
        configSnapshot: config,
        events: created.events,
        aiCalls: [],
      };
      const store = rebuildStore(record);
      const ai = new AiEngine({ models: testModels, prompts: testPrompts, now });
      const runner = new MatchRunner(store, ai, now);

      let answerPairId: PairId | null = null;
      for (let step = 0; step < 80; step++) {
        const task = getPendingTask(store.state, nowValue);
        if (task.type === 'ai_speech_batch' && task.turns[0]?.kind === 'answer') {
          answerPairId = task.turns[0].pairId;
          break;
        }
        await runner.advanceOnce();
      }
      if (!answerPairId) throw new Error(`answer task missing: ${freshness}`);
      const meta = store.state.latestEvalMeta[answerPairId];
      expect(meta?.kind).toBe('discussion');
      store.state.latestEvalMeta[answerPairId] = freshness === 'previous-day' && meta
        ? { ...meta, day: store.state.day - 1 }
        : null;

      const eventCount = store.record.events.length;
      const callCount = store.record.aiCalls.length;
      await runner.advanceOnce();
      expect(store.record.aiCalls.slice(callCount).map((call) => call.callType)).toEqual([
        'eval',
        'speech',
      ]);
      expect(
        store.record.events.slice(eventCount).some((event) => event.type === 'eval_recorded'),
      ).toBe(true);
    }
  });
});
