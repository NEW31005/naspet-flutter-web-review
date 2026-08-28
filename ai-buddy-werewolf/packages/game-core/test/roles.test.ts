import { describe, expect, it } from 'vitest';
import type { EvalOutput, MatchEvent, PairId } from '@aibw/shared';
import {
  GameRuleError,
  applyAdvanceDay,
  applyAdvice,
  applyNight,
  applyNightProposal,
  applySpeech,
  applyTrialChoice,
  applyVotes,
  buildBuddyContext,
  canSeeEvent,
  createMatch,
  getPendingTask,
  reduce,
  type MatchState,
} from '../src/index.js';
import { makeEval, makeSnapshot } from './fixtures.js';

const NOW = 1_700_000_000_000;

const roleRules = {
  pairCount: 9,
  roleSetup: { werewolf: 2, seer: 1, guardian: 1, medium: 1 },
  maxDays: 5,
  firstNightDivination: false as const,
};

function apply(state: MatchState, events: MatchEvent[]): MatchState {
  return events.reduce((current, event) => reduce(current, event), state);
}

function createRoleMatch(
  seed: string,
  rulesOverrides: Parameters<typeof makeSnapshot>[0] = roleRules,
): MatchState {
  return createMatch({
    matchId: `roles-${seed}`,
    seed,
    mode: 'lab',
    provider: 'mock',
    humanPairIndex: null,
    config: makeSnapshot(rulesOverrides),
    now: NOW,
  }).state;
}

function advanceToNight(
  seed: string,
  rulesOverrides: Parameters<typeof makeSnapshot>[0] = roleRules,
): { state: MatchState; executedId: PairId } {
  let state = createRoleMatch(seed, rulesOverrides);
  state = apply(state, applyAdvanceDay(state, NOW));
  for (let step = 0; step < 30; step++) {
    const task = getPendingTask(state);
    if (task.type !== 'ai_speech') break;
    const others = state.pairs.filter((pair) => pair.alive && pair.pairId !== task.pairId);
    state = apply(
      state,
      applySpeech(
        state,
        task.pairId,
        makeEval(Object.fromEntries(others.map((pair) => [pair.pairId, 50]))),
        `discussion-${task.pairId}`,
        { text: '役職テストの発言', accusesId: null, declaredRole: null },
        NOW,
      ),
    );
  }
  expect(state.phase).toBe('trial');
  const executed = state.pairs.find((pair) => pair.role === 'villager');
  if (!executed) throw new Error('処刑対象の市民がいません');
  for (const pair of state.pairs.filter((candidate) => candidate.alive)) {
    state = apply(state, applyTrialChoice(state, pair.pairId, null, NOW));
  }
  const voteEvals: Record<PairId, { output: EvalOutput; callId: string }> = {};
  for (const pair of state.pairs.filter((candidate) => candidate.alive)) {
    const others = state.pairs.filter(
      (candidate) => candidate.alive && candidate.pairId !== pair.pairId,
    );
    voteEvals[pair.pairId] = {
      output: makeEval(
        Object.fromEntries(
          others.map((candidate) => [
            candidate.pairId,
            candidate.pairId === executed.pairId ? 99 : 1,
          ]),
        ),
      ),
      callId: `vote-${pair.pairId}`,
    };
  }
  state = apply(state, applyVotes(state, voteEvals, NOW));
  expect(state.phase).toBe('night');
  return { state, executedId: executed.pairId };
}

function resolveNight(
  input: MatchState,
  attackTargetId: PairId,
  guardTargetId: PairId,
): { events: MatchEvent[]; state: MatchState } {
  let state = input;
  const wolves = state.pairs.filter((pair) => pair.alive && pair.role === 'werewolf');
  for (const wolf of wolves) {
    state = apply(state, applyNightProposal(state, wolf.pairId, null, NOW));
  }
  const actors = state.pairs.filter(
    (pair) => pair.alive && ['werewolf', 'seer', 'guardian'].includes(pair.role),
  );
  const evals: Record<PairId, { output: EvalOutput; callId: string }> = {};
  for (const actor of actors) {
    const others = state.pairs.filter(
      (candidate) => candidate.alive && candidate.pairId !== actor.pairId,
    );
    evals[actor.pairId] = {
      output: makeEval(Object.fromEntries(others.map((candidate) => [candidate.pairId, 50])), {
        attackPriorities:
          actor.role === 'werewolf'
            ? Object.fromEntries(
                others
                  .filter((candidate) => candidate.role !== 'werewolf')
                  .map((candidate) => [
                    candidate.pairId,
                    candidate.pairId === attackTargetId ? 100 : 1,
                  ]),
              )
            : undefined,
        skillTargetPriorities:
          actor.role === 'guardian'
            ? Object.fromEntries(
                others.map((candidate) => [
                  candidate.pairId,
                  candidate.pairId === guardTargetId ? 100 : 1,
                ]),
              )
            : actor.role === 'seer'
              ? Object.fromEntries(others.map((candidate) => [candidate.pairId, 50]))
              : undefined,
      }),
      callId: `night-${actor.pairId}`,
    };
  }
  const events = applyNight(state, evals, NOW);
  return { events, state: apply(state, events) };
}

describe('騎士・霊媒師の役職配布', () => {
  it('9組を狼2・占い1・騎士1・霊媒1・市民4で配布する', () => {
    const state = createRoleMatch('standard-nine-roles');
    const count = (role: MatchState['pairs'][number]['role']) =>
      state.pairs.filter((pair) => pair.role === role).length;
    expect(count('werewolf')).toBe(2);
    expect(count('seer')).toBe(1);
    expect(count('guardian')).toBe(1);
    expect(count('medium')).toBe(1);
    expect(count('villager')).toBe(4);
  });
});

describe('騎士', () => {
  it('自己護衛と前夜と同じ対象への連続護衛提案を拒否する', () => {
    let state = createRoleMatch('guardian-advice');
    state = apply(state, applyAdvanceDay(state, NOW));
    const guardian = state.pairs.find((pair) => pair.role === 'guardian');
    const previousTarget = state.pairs.find(
      (pair) => pair.alive && pair.pairId !== guardian?.pairId,
    );
    if (!guardian || !previousTarget) throw new Error('騎士のテスト対象がいません');

    expect(() =>
      applyAdvice(
        state,
        guardian.pairId,
        { kind: 'skill_target', targetId: guardian.pairId },
        NOW,
      ),
    ).toThrow(GameRuleError);

    state = reduce(state, {
      seq: state.nextSeq,
      ts: NOW - 1,
      day: 0,
      phase: 'night',
      visibility: { kind: 'pairs', pairIds: [guardian.pairId], part: 'both' },
      type: 'guard_resolved',
      payload: {
        guardianPairId: guardian.pairId,
        targetId: previousTarget.pairId,
        masterProposalId: previousTarget.pairId,
      },
    });
    expect(state.guardHistory.at(-1)?.masterProposalId).toBe(previousTarget.pairId);
    expect(() =>
      applyAdvice(
        state,
        guardian.pairId,
        { kind: 'skill_target', targetId: previousTarget.pairId },
        NOW,
      ),
    ).toThrow(/続けて護衛/);
  });

  it('AI評価が前夜の対象を最高点にしても連続護衛しない', () => {
    let { state } = advanceToNight('guardian-no-repeat');
    const guardian = state.pairs.find((pair) => pair.alive && pair.role === 'guardian');
    const candidates = state.pairs.filter(
      (pair) => pair.alive && pair.pairId !== guardian?.pairId && pair.role !== 'werewolf',
    );
    const previousTarget = candidates[0];
    const alternate = candidates[1];
    if (!guardian || !previousTarget || !alternate) throw new Error('護衛候補が不足しています');
    state = reduce(state, {
      seq: state.nextSeq,
      ts: NOW - 1,
      day: 0,
      phase: 'night',
      visibility: { kind: 'pairs', pairIds: [guardian.pairId], part: 'both' },
      type: 'guard_resolved',
      payload: {
        guardianPairId: guardian.pairId,
        targetId: previousTarget.pairId,
        masterProposalId: null,
      },
    });
    const { events } = resolveNight(state, alternate.pairId, previousTarget.pairId);
    const guard = events.find((event) => event.type === 'guard_resolved');
    expect(guard?.type).toBe('guard_resolved');
    if (guard?.type === 'guard_resolved') {
      expect(guard.payload.targetId).not.toBe(previousTarget.pairId);
    }
  });

  it('護衛成功時は襲撃死を防ぎ、公開情報には犠牲者なしだけが残る', () => {
    const { state } = advanceToNight('guardian-block');
    const guardian = state.pairs.find((pair) => pair.alive && pair.role === 'guardian');
    const victim = state.pairs.find(
      (pair) => pair.alive && pair.role !== 'werewolf' && pair.pairId !== guardian?.pairId,
    );
    if (!guardian || !victim) throw new Error('騎士または襲撃対象がいません');
    const resolved = resolveNight(state, victim.pairId, victim.pairId);
    const detail = resolved.events.find((event) => event.type === 'guard_detail');
    const attack = resolved.events.find((event) => event.type === 'attack_resolved');
    const morning = resolved.events.find((event) => event.type === 'day_started');
    expect(detail?.type === 'guard_detail' && detail.payload.blockedAttack).toBe(true);
    expect(attack?.type === 'attack_resolved' ? attack.payload.targetId : 'missing').toBeNull();
    expect(morning?.type === 'day_started' ? morning.payload.deaths : null).toEqual([]);
    expect(resolved.state.pairs.find((pair) => pair.pairId === victim.pairId)?.alive).toBe(true);
    for (const event of resolved.events.filter(
      (candidate) => candidate.type === 'guard_resolved' || candidate.type === 'guard_detail',
    )) {
      expect(canSeeEvent(event, { kind: 'public' })).toBe(false);
    }
    const publicJson = JSON.stringify(
      resolved.events.filter((event) => canSeeEvent(event, { kind: 'public' })),
    );
    expect(publicJson).not.toContain('guard');
    expect(publicJson).not.toContain(victim.pairId);
  });

  it('騎士自身が同夜に襲撃されても、その夜の護衛行動を先に成立させる', () => {
    const { state } = advanceToNight('guardian-dies-after-guard');
    const guardian = state.pairs.find((pair) => pair.alive && pair.role === 'guardian');
    const protectedPair = state.pairs.find(
      (pair) => pair.alive && pair.role !== 'werewolf' && pair.pairId !== guardian?.pairId,
    );
    if (!guardian || !protectedPair) throw new Error('騎士または護衛対象がいません');
    const resolved = resolveNight(state, guardian.pairId, protectedPair.pairId);
    const guardIndex = resolved.events.findIndex((event) => event.type === 'guard_resolved');
    const attackIndex = resolved.events.findIndex((event) => event.type === 'attack_resolved');
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(attackIndex).toBeGreaterThan(guardIndex);
    expect(resolved.state.guardHistory.at(-1)).toMatchObject({
      guardianPairId: guardian.pairId,
      targetId: protectedPair.pairId,
    });
    expect(resolved.state.pairs.find((pair) => pair.pairId === guardian.pairId)?.alive).toBe(false);
  });
});

describe('霊媒師', () => {
  it('処刑結果を主人だけへ届け、共有後にだけバディが確定情報として知る', () => {
    const { state, executedId } = advanceToNight('medium-result');
    const medium = state.pairs.find((pair) => pair.alive && pair.role === 'medium');
    const guardian = state.pairs.find((pair) => pair.alive && pair.role === 'guardian');
    const attackTarget = state.pairs.find(
      (pair) =>
        pair.alive &&
        pair.role !== 'werewolf' &&
        pair.pairId !== medium?.pairId &&
        pair.pairId !== guardian?.pairId,
    );
    const guardTarget = state.pairs.find(
      (pair) => pair.alive && pair.pairId !== guardian?.pairId && pair.pairId !== attackTarget?.pairId,
    );
    if (!medium || !attackTarget || !guardTarget) throw new Error('霊媒テスト対象が不足しています');
    const resolved = resolveNight(state, attackTarget.pairId, guardTarget.pairId);
    const result = resolved.events.find((event) => event.type === 'medium_result');
    expect(result?.type).toBe('medium_result');
    if (result?.type !== 'medium_result') throw new Error('霊媒結果がありません');
    expect(result.payload.targetId).toBe(executedId);
    expect(result.payload.fact.source).toBe('medium');
    expect(result.visibility).toEqual({
      kind: 'pairs',
      pairIds: [medium.pairId],
      part: 'master',
    });
    expect(canSeeEvent(result, { kind: 'master', pairId: medium.pairId })).toBe(true);
    expect(canSeeEvent(result, { kind: 'buddy', pairId: medium.pairId })).toBe(false);
    expect(canSeeEvent(result, { kind: 'public' })).toBe(false);
    expect(buildBuddyContext(resolved.state, medium.pairId).sharedFacts).toEqual([]);

    let next = apply(resolved.state, applyAdvanceDay(resolved.state, NOW + 1));
    next = apply(
      next,
      applyAdvice(
        next,
        medium.pairId,
        { kind: 'fact_share', factId: result.payload.fact.id },
        NOW + 1,
      ),
    );
    expect(buildBuddyContext(next, medium.pairId).sharedFacts).toContainEqual(
      result.payload.fact,
    );
    const other = next.pairs.find((pair) => pair.pairId !== medium.pairId);
    expect(JSON.stringify(buildBuddyContext(next, other?.pairId ?? ''))).not.toContain(
      result.payload.fact.id,
    );
  });
});

describe('複数の特殊役職', () => {
  const multipleRoleRules = {
    pairCount: 12,
    roleSetup: { werewolf: 2, seer: 2, guardian: 2, medium: 2 },
    maxDays: 5,
    firstNightDivination: false as const,
  };

  function runMultipleRoleNight(seed: string) {
    const { state, executedId } = advanceToNight(seed, multipleRoleRules);
    const guardians = state.pairs.filter(
      (pair) => pair.alive && pair.role === 'guardian',
    );
    const attackTarget = state.pairs.find(
      (pair) =>
        pair.alive &&
        pair.role !== 'werewolf' &&
        !guardians.some((guardian) => guardian.pairId === pair.pairId),
    );
    if (!attackTarget) throw new Error('複数役職テストの襲撃対象がいません');
    return {
      executedId,
      guardians,
      ...resolveNight(state, attackTarget.pairId, attackTarget.pairId),
    };
  }

  it('生存する占い役全員が独立して占い結果を得る', () => {
    const resolved = runMultipleRoleNight('multiple-seers');
    const seers = resolved.state.pairs.filter((pair) => pair.role === 'seer');
    const divinations = resolved.events.filter((event) => event.type === 'divination');
    expect(seers).toHaveLength(2);
    expect(divinations).toHaveLength(2);
    expect(
      new Set(
        divinations.map((event) =>
          event.type === 'divination' ? event.payload.seerPairId : '',
        ),
      ),
    ).toEqual(new Set(seers.map((seer) => seer.pairId)));
    for (const seer of seers) {
      expect(resolved.state.facts[seer.pairId]?.some((fact) => fact.source === 'divination')).toBe(
        true,
      );
    }
  });

  it('初日白通知も複数の占い役それぞれの主人へ届く', () => {
    const config = makeSnapshot({
      ...multipleRoleRules,
      firstNightDivination: 'white',
    });
    const created = createMatch({
      matchId: 'multiple-first-divination',
      seed: 'multiple-first-divination',
      mode: 'lab',
      provider: 'mock',
      humanPairIndex: null,
      config,
      now: NOW,
    });
    const seerIds = created.state.pairs
      .filter((pair) => pair.role === 'seer')
      .map((pair) => pair.pairId);
    const results = created.events.filter((event) => event.type === 'divination');
    expect(results).toHaveLength(2);
    expect(
      new Set(
        results.map((event) =>
          event.type === 'divination' ? event.payload.seerPairId : '',
        ),
      ),
    ).toEqual(new Set(seerIds));
    expect(
      results.every(
        (event) => event.type === 'divination' && event.payload.fact.isWolf === false,
      ),
    ).toBe(true);
  });

  it('生存する騎士全員が独立して護衛し、いずれかの護衛成功で襲撃を防ぐ', () => {
    const resolved = runMultipleRoleNight('multiple-guardians');
    const guards = resolved.events.filter((event) => event.type === 'guard_resolved');
    const details = resolved.events.filter((event) => event.type === 'guard_detail');
    expect(resolved.guardians).toHaveLength(2);
    expect(guards).toHaveLength(2);
    expect(details).toHaveLength(2);
    expect(details.every((event) => event.type === 'guard_detail' && event.payload.blockedAttack)).toBe(
      true,
    );
    expect(resolved.state.guardHistory.filter((entry) => entry.day === 1)).toHaveLength(2);
    expect(resolved.state.attackHistory.at(-1)?.targetId).toBeNull();
  });

  it('生存する霊媒師全員へ同じ処刑結果を主人限定で届ける', () => {
    const resolved = runMultipleRoleNight('multiple-mediums');
    const mediums = resolved.state.pairs.filter((pair) => pair.role === 'medium');
    const results = resolved.events.filter((event) => event.type === 'medium_result');
    expect(mediums).toHaveLength(2);
    expect(results).toHaveLength(2);
    for (const medium of mediums) {
      const result = results.find(
        (event) => event.type === 'medium_result' && event.payload.mediumPairId === medium.pairId,
      );
      expect(result?.type === 'medium_result' ? result.payload.targetId : null).toBe(
        resolved.executedId,
      );
      expect(result?.visibility).toEqual({
        kind: 'pairs',
        pairIds: [medium.pairId],
        part: 'master',
      });
      expect(resolved.state.facts[medium.pairId]?.some((fact) => fact.source === 'medium')).toBe(
        true,
      );
    }
  });

  it('同じシードなら複数役職の夜イベントも同一になる', () => {
    const summarize = () =>
      runMultipleRoleNight('multiple-role-determinism').events
        .filter((event) =>
          ['divination', 'medium_result', 'guard_resolved', 'attack_resolved'].includes(
            event.type,
          ),
        )
        .map((event) => ({
          type: event.type,
          visibility: event.visibility,
          payload: event.payload,
        }));
    expect(summarize()).toEqual(summarize());
  });
});
