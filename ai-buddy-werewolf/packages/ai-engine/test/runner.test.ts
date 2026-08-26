/** モックAIでの完走・決定論・フォールバック・信頼度と事実の扱いのテスト */
import { describe, expect, it } from 'vitest';
import type { EvalOutput, SpeechOutput } from '@aibw/shared';
import { buildBuddyContext, type BuddyContext } from '@aibw/game-core';
import { AiEngine } from '../src/calls.js';
import { mockEvaluate } from '../src/mock.js';
import { MatchRunner, computeMetrics, rebuildStore } from '../src/runner.js';
import type { CallOpts, LlmProvider, ProviderResult } from '../src/provider.js';
import { makeStore, testModels, testPrompts } from './fixtures.js';

function makeRunner(seed: string, rules?: Parameters<typeof makeStore>[1]) {
  let t = 1_700_000_000_000;
  const now = () => (t += 10);
  const store = makeStore(seed, rules, 1_700_000_000_000);
  const ai = new AiEngine({ models: testModels, prompts: testPrompts, now });
  return { runner: new MatchRunner(store, ai, now), store };
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
});
