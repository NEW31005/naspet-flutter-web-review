/**
 * 秘密情報分離のテスト。
 * AIコンテキスト(BuddyContext)と各視点ビューに、知ってはいけない情報が
 * 混入しないことを構造・文字列の両面で検証する。
 */
import { describe, expect, it } from 'vitest';
import type { EvalOutput, MatchEvent } from '@aibw/shared';
import {
  applyAdvanceDay,
  applyAdvice,
  applyNight,
  applyNightProposal,
  applySpeech,
  applyTrialChoice,
  applyVotes,
  buildBuddyContext,
  buildMasterView,
  canSeeEvent,
  createMatch,
  getPendingTask,
  reduce,
  type MatchState,
} from '../src/index.js';
import { makeEval, makeSnapshot } from './fixtures.js';

const NOW = 1_700_000_000_000;

function apply(state: MatchState, events: MatchEvent[]): MatchState {
  return events.reduce((s, e) => reduce(s, e), state);
}

/** 占い結果が1件確定し、p1へ主観助言が送られた状態まで進める */
function scenarioAfterFirstNight(seed = 'vis-seed') {
  const config = makeSnapshot({ maxDays: 5 });
  let state = createMatch({
    matchId: 'm-vis',
    seed,
    mode: 'lab',
    provider: 'mock',
    humanPairIndex: null,
    config,
    now: NOW,
  }).state;
  const allEvents: MatchEvent[] = [];
  const record = (evs: MatchEvent[]) => {
    allEvents.push(...evs);
    state = apply(state, evs);
  };
  record(applyAdvanceDay(state, NOW));
  record(applyAdvice(state, 'p1', { kind: 'suspicion', targetId: 'p2' }, NOW));
  for (let guard = 0; guard < 20; guard++) {
    const task = getPendingTask(state);
    if (task.type !== 'ai_speech') break;
    const others = state.pairs.filter((p) => p.alive && p.pairId !== task.pairId);
    record(
      applySpeech(
        state,
        task.pairId,
        makeEval(Object.fromEntries(others.map((o) => [o.pairId, 50]))),
        `call-${task.pairId}`,
        { text: '発言', accusesId: null },
        NOW,
      ),
    );
  }
  // 狼が処刑されないよう、市民の1人へ票を寄せる
  const wolf = state.pairs.find((p) => p.role === 'werewolf');
  const seer = state.pairs.find((p) => p.role === 'seer');
  const scapegoat = state.pairs.find((p) => p.role === 'villager');
  for (const p of state.pairs.filter((x) => x.alive)) {
    record(applyTrialChoice(state, p.pairId, null, NOW));
  }
  const evals: Record<string, { output: EvalOutput; callId: string }> = {};
  for (const p of state.pairs) {
    const others = state.pairs.filter((x) => x.pairId !== p.pairId);
    evals[p.pairId] = {
      output: makeEval(
        Object.fromEntries(
          others.map((o) => [o.pairId, o.pairId === scapegoat?.pairId ? 90 : 10]),
        ),
        { reasonSummary: `SECRET-EVAL-${p.pairId}` },
      ),
      callId: `c-${p.pairId}`,
    };
  }
  record(applyVotes(state, evals, NOW));
  // 夜: 狼の提案 + 占い(占い先を狼へ誘導して確定黒を作る)
  if (state.phase === 'night') {
    for (const w of state.pairs.filter((p) => p.alive && p.role === 'werewolf')) {
      record(applyNightProposal(state, w.pairId, null, NOW));
    }
    const nightEvals: Record<string, { output: EvalOutput; callId: string }> = {};
    const actors = state.pairs.filter(
      (p) => p.alive && (p.role === 'werewolf' || p.role === 'seer'),
    );
    for (const p of actors) {
      const others = state.pairs.filter((x) => x.alive && x.pairId !== p.pairId);
      // 襲撃先は市民(占い役以外)へ寄せ、占い役が生き残るシナリオにする
      const attackTarget = others.find((o) => o.role === 'villager');
      nightEvals[p.pairId] = {
        output: makeEval(Object.fromEntries(others.map((o) => [o.pairId, 50])), {
          attackPriorities: Object.fromEntries(
            others
              .filter((o) => o.role !== 'werewolf')
              .map((o) => [o.pairId, o.pairId === attackTarget?.pairId ? 99 : 1]),
          ),
          skillTargetPriorities: Object.fromEntries(
            others.map((o) => [o.pairId, o.pairId === wolf?.pairId ? 99 : 1]),
          ),
        }),
        callId: `c-${p.pairId}`,
      };
    }
    record(applyNight(state, nightEvals, NOW));
  }
  return { state, allEvents, wolf, seer };
}

describe('AIコンテキストの秘密分離', () => {
  it('占い結果は共有するまでバディのコンテキストに入らない', () => {
    const { state, seer, wolf } = scenarioAfterFirstNight();
    expect(seer && wolf).toBeTruthy();
    if (!seer || !wolf) return;
    // 主人は結果を持っている
    const fact = state.facts[seer.pairId]?.[0];
    expect(fact).toBeDefined();
    // 占い役バディのコンテキストには入らない(未共有)
    const ctx = buildBuddyContext(state, seer.pairId);
    expect(ctx.sharedFacts).toHaveLength(0);
    const json = JSON.stringify(ctx);
    expect(json).not.toContain(fact?.id ?? 'fact-');
    expect(json).not.toContain('isWolf');
    // 共有後は事実として入る
    let s2 = state;
    if (s2.phase === 'day_start') s2 = apply(s2, applyAdvanceDay(s2, NOW));
    s2 = apply(s2, applyAdvice(s2, seer.pairId, { kind: 'fact_share', factId: fact?.id ?? '' }, NOW));
    const ctx2 = buildBuddyContext(s2, seer.pairId);
    expect(ctx2.sharedFacts).toHaveLength(1);
    expect(ctx2.sharedFacts[0]?.targetId).toBe(fact?.targetId);
  });

  it('他組の役職・占い結果・助言・内部評価がコンテキストへ漏れない', () => {
    const { state, seer, wolf } = scenarioAfterFirstNight();
    if (!seer || !wolf) return;
    const factId = state.facts[seer.pairId]?.[0]?.id ?? '';
    for (const p of state.pairs.filter((x) => x.alive)) {
      const ctx = buildBuddyContext(state, p.pairId);
      const json = JSON.stringify(ctx);
      // 役職テーブル: participantsにroleフィールドがない
      for (const participant of ctx.participants) {
        expect(participant).not.toHaveProperty('role');
      }
      // 自分以外の役職名(英語キー)が含まれない(自分の役職とwolfPartnersは許可)
      if (p.role !== 'werewolf') {
        expect(ctx.wolfPartners).toHaveLength(0);
        expect(json).not.toContain('"werewolf"');
      }
      if (p.role !== 'seer') {
        expect(json).not.toContain('"seer"');
        // 他人の占い結果IDが含まれない
        expect(json).not.toContain(factId);
      }
      // 他の主人の助言: p1の主観助言(→p2)はp1にのみ入る
      if (p.pairId !== 'p1') {
        expect(ctx.advices.filter((a) => a.advice.kind === 'suspicion')).toHaveLength(0);
      }
      // 他AIの内部評価が含まれない(自分のpreviousEvalのみ許可)
      for (const other of state.pairs.filter((x) => x.pairId !== p.pairId)) {
        expect(json).not.toContain(`SECRET-EVAL-${other.pairId}`);
      }
      // シード(将来の乱数結果の材料)が含まれない
      expect(json).not.toContain(state.seed);
    }
  });

  it('狼同士だけが仲間を知る', () => {
    const config = makeSnapshot({ pairCount: 8, roleSetup: { werewolf: 2, seer: 1 } });
    const state = createMatch({
      matchId: 'm-wolves',
      seed: 'wolves-seed',
      mode: 'lab',
      provider: 'mock',
      humanPairIndex: null,
      config,
      now: NOW,
    }).state;
    const wolves = state.pairs.filter((p) => p.role === 'werewolf');
    expect(wolves).toHaveLength(2);
    const [w1, w2] = wolves;
    const ctx1 = buildBuddyContext(state, w1?.pairId ?? '');
    expect(ctx1.wolfPartners.map((w) => w.pairId)).toEqual([w2?.pairId]);
    for (const p of state.pairs.filter((x) => x.role !== 'werewolf')) {
      expect(buildBuddyContext(state, p.pairId).wolfPartners).toHaveLength(0);
    }
  });
});

describe('イベント可視性と主人ビュー', () => {
  it('占い結果イベントは主人だけが見える(バディ・公開・他組は不可視)', () => {
    const { allEvents, seer } = scenarioAfterFirstNight();
    if (!seer) return;
    const divination = allEvents.find((e) => e.type === 'divination');
    expect(divination).toBeDefined();
    if (!divination) return;
    expect(canSeeEvent(divination, { kind: 'master', pairId: seer.pairId })).toBe(true);
    expect(canSeeEvent(divination, { kind: 'buddy', pairId: seer.pairId })).toBe(false);
    expect(canSeeEvent(divination, { kind: 'public' })).toBe(false);
    expect(canSeeEvent(divination, { kind: 'master', pairId: 'p1' })).toBe(
      seer.pairId === 'p1',
    );
    expect(canSeeEvent(divination, { kind: 'gm' })).toBe(true);
  });

  it('主人ビューに内部スコアが含まれない(試合中)', () => {
    const { state } = scenarioAfterFirstNight();
    const view = buildMasterView(state, 'p1');
    const json = JSON.stringify(view);
    expect(json).not.toContain('suspicions');
    expect(json).not.toContain('attackPriorities');
    expect(json).not.toContain('primaryHypothesis');
    // 自分の役職は見える
    expect(view.me?.roleLabel).toBeTruthy();
    // 他組の役職は含まれない(終了前)
    expect(view.finalRoles).toBeNull();
  });

  it('roles_assignedイベントはGM専用', () => {
    const config = makeSnapshot();
    const { events } = createMatch({
      matchId: 'm',
      seed: 's',
      mode: 'lab',
      provider: 'mock',
      humanPairIndex: null,
      config,
      now: NOW,
    });
    const roles = events.find((e) => e.type === 'roles_assigned');
    expect(roles).toBeDefined();
    if (!roles) return;
    expect(canSeeEvent(roles, { kind: 'public' })).toBe(false);
    expect(canSeeEvent(roles, { kind: 'master', pairId: 'p1' })).toBe(false);
    expect(canSeeEvent(roles, { kind: 'buddy', pairId: 'p1' })).toBe(false);
    expect(canSeeEvent(roles, { kind: 'gm' })).toBe(true);
  });
});
