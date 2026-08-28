import { describe, expect, it } from 'vitest';
import type { MatchEvent, Role } from '@aibw/shared';
import {
  GameRuleError,
  applyAdvanceDay,
  applyAdvice,
  applySpeech,
  buildBuddyContext,
  buildMasterView,
  buildReplayData,
  canSeeEvent,
  createMatch,
  getPendingTask,
  rebuildState,
  reduce,
  type MatchState,
} from '../src/index.js';
import { makeEval, makeSnapshot } from './fixtures.js';

const NOW = 1_700_000_000_000;

function apply(state: MatchState, events: MatchEvent[]): MatchState {
  return events.reduce((current, event) => reduce(current, event), state);
}

function discussion(seed = 'role-claim') {
  const config = makeSnapshot();
  const created = createMatch({
    matchId: `m-${seed}`,
    seed,
    mode: 'play',
    provider: 'mock',
    humanPairIndex: 0,
    config,
    now: NOW,
  });
  const advanceEvents = applyAdvanceDay(created.state, NOW + 1);
  const state = apply(created.state, advanceEvents);
  return { config, state, events: [...created.events, ...advanceEvents] };
}

describe('役職を名乗る相談', () => {
  it('本当の役職・別の役職・今日は名乗らないを構造化助言として受け取れる', () => {
    for (const mode of ['truth', 'false', 'wait'] as const) {
      const { state } = discussion(`choice-${mode}`);
      const actual = state.pairs[0]?.role ?? 'villager';
      const different = (['villager', 'seer', 'guardian', 'medium', 'werewolf'] as Role[])
        .find((role) => role !== actual) ?? 'villager';
      const claimedRole = mode === 'truth' ? actual : mode === 'false' ? different : null;
      const next = apply(
        state,
        applyAdvice(state, 'p1', { kind: 'role_claim', claimedRole }, NOW + 2),
      );
      expect(next.roleClaimProposal.p1).toEqual({ day: 1, claimedRole });
      expect(next.adviceUsedToday.p1).toBe(1);
    }
  });

  it('設定で選択肢にない役職は拒否する', () => {
    const config = makeSnapshot();
    config.advice.roleClaimOptions = config.advice.roleClaimOptions.filter(
      (option) => option.role !== 'guardian',
    );
    const created = createMatch({
      matchId: 'm-disabled-role-claim',
      seed: 'disabled-role-claim',
      mode: 'play',
      provider: 'mock',
      humanPairIndex: 0,
      config,
      now: NOW,
    });
    const state = apply(created.state, applyAdvanceDay(created.state, NOW + 1));
    expect(() =>
      applyAdvice(state, 'p1', { kind: 'role_claim', claimedRole: 'guardian' }, NOW + 2),
    ).toThrowError(GameRuleError);
  });

  it('主人の相談は秘密のまま、バディが実際に名乗った役職だけを公開する', () => {
    const setup = discussion('secrecy');
    let state = setup.state;
    const actual = state.pairs[0]?.role ?? 'villager';
    const claimedRole = (['villager', 'seer', 'guardian', 'medium', 'werewolf'] as Role[])
      .find((role) => role !== actual) ?? 'villager';

    const adviceEvents = applyAdvice(
      state,
      'p1',
      { kind: 'role_claim', claimedRole },
      NOW + 2,
    );
    expect(adviceEvents).toHaveLength(1);
    const adviceEvent = adviceEvents[0];
    expect(adviceEvent?.type).toBe('advice_given');
    if (!adviceEvent) return;
    expect(canSeeEvent(adviceEvent, { kind: 'public' })).toBe(false);
    expect(canSeeEvent(adviceEvent, { kind: 'buddy', pairId: 'p2' })).toBe(false);
    state = apply(state, adviceEvents);

    expect(buildBuddyContext(state, 'p1').roleClaimProposal?.claimedRole).toBe(claimedRole);
    expect(buildBuddyContext(state, 'p2').roleClaimProposal).toBeNull();
    expect(
      buildBuddyContext(state, 'p2').advices.some((item) => item.advice.kind === 'role_claim'),
    ).toBe(false);
    expect(buildMasterView(state, 'p1').me?.roleClaimProposal?.claimedRole).toBe(claimedRole);

    const task = getPendingTask(state);
    expect(task.type).toBe('ai_speech');
    if (task.type !== 'ai_speech') return;
    const candidates = state.pairs
      .filter((pair) => pair.alive && pair.pairId !== task.pairId)
      .map((pair) => pair.pairId);
    const speechEvents = applySpeech(
      state,
      task.pairId,
      makeEval(Object.fromEntries(candidates.map((pairId) => [pairId, 50]))),
      'call-role-claim',
      { text: `私は役職を名乗ります`, accusesId: null, declaredRole: claimedRole },
      NOW + 3,
    );
    const declaration = speechEvents.find((event) => event.type === 'role_declared');
    expect(declaration).toBeDefined();
    if (!declaration || declaration.type !== 'role_declared') return;
    expect(declaration.visibility).toEqual({ kind: 'public' });
    expect(declaration.payload).toEqual({ pairId: 'p1', claimedRole });
    expect(JSON.stringify(declaration)).not.toContain('isTruth');
    expect(JSON.stringify(declaration)).not.toContain('trueRole');

    state = apply(state, speechEvents);
    expect(state.publicRoleClaims.p1).toEqual({ day: 1, claimedRole });
    const publicContext = buildBuddyContext(state, 'p2');
    expect(publicContext.publicRoleClaims.p1).toEqual({ day: 1, claimedRole });
    expect(publicContext.roleClaimProposal).toBeNull();

    const allEvents = [...setup.events, ...adviceEvents, ...speechEvents];
    const replay = buildReplayData(state, allEvents);
    expect(replay.roleClaimDetails).toContainEqual({
      day: 1,
      pairId: 'p1',
      pairName: state.pairs[0]?.buddyName,
      trueRole: actual,
      trueRoleLabel: expect.any(String),
      masterProposalSet: true,
      masterProposal: claimedRole,
      publicClaims: [
        {
          seq: declaration.seq,
          claimedRole,
          claimedRoleLabel: expect.any(String),
          isTruth: false,
        },
      ],
    });
    expect(rebuildState(allEvents, setup.config).publicRoleClaims).toEqual(
      state.publicRoleClaims,
    );
  });
});
