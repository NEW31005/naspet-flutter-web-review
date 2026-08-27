import { describe, expect, it } from 'vitest';
import { rulesConfigSchema, type EvalOutput, type MatchEvent, type PairId } from '@aibw/shared';
import {
  GameRuleError,
  applyAdvanceDay,
  applyAdvice,
  applyNight,
  applyNightProposal,
  applySpeech,
  applyStartDiscussionResponse,
  applyTrialChoice,
  applyVotes,
  buildBuddyContext,
  createMatch,
  getPendingTask,
  rebuildState,
  reduce,
  type MatchState,
} from '../src/index.js';
import { makeEval, makeRules, makeSnapshot } from './fixtures.js';

const NOW = 1_700_000_000_000;

function newMatch(seed = 'test-seed', rulesOverrides?: Parameters<typeof makeSnapshot>[0]) {
  const config = makeSnapshot(rulesOverrides);
  return createMatch({
    matchId: 'm-test',
    seed,
    mode: 'lab',
    provider: 'mock',
    humanPairIndex: null,
    config,
    now: NOW,
  });
}

function apply(state: MatchState, events: MatchEvent[]): MatchState {
  return events.reduce((s, e) => reduce(s, e), state);
}

/** 討論フェーズまで進め、全員分の発言を済ませて裁判へ */
function throughDiscussion(state: MatchState, evalFor?: (pairId: PairId) => EvalOutput): MatchState {
  state = apply(state, applyAdvanceDay(state, NOW));
  for (let guard = 0; guard < 50; guard++) {
    const task = getPendingTask(state);
    if (task.type !== 'ai_speech') break;
    const output =
      evalFor?.(task.pairId) ??
      makeEval(
        Object.fromEntries(
          state.pairs
            .filter((p) => p.alive && p.pairId !== task.pairId)
            .map((p) => [p.pairId, 50]),
        ),
      );
    state = apply(
      state,
      applySpeech(state, task.pairId, output, `call-${task.pairId}`, { text: 'テスト発言', accusesId: null }, NOW),
    );
  }
  return state;
}

function submitAllTrialChoices(state: MatchState, choice: (pairId: PairId) => PairId | null): MatchState {
  for (const p of state.pairs.filter((x) => x.alive)) {
    state = apply(state, applyTrialChoice(state, p.pairId, choice(p.pairId), NOW));
  }
  return state;
}

describe('役職配布', () => {
  it('設定通りの人数で配布される', () => {
    const { state } = newMatch();
    const roles = state.pairs.map((p) => p.role);
    expect(roles.filter((r) => r === 'werewolf')).toHaveLength(1);
    expect(roles.filter((r) => r === 'seer')).toHaveLength(1);
    expect(roles.filter((r) => r === 'villager')).toHaveLength(3);
  });

  it('同じシードなら同じ配布になる', () => {
    const a = newMatch('seedA').state.pairs.map((p) => p.role);
    const b = newMatch('seedA').state.pairs.map((p) => p.role);
    const c = newMatch('seedB').state.pairs.map((p) => p.role);
    expect(a).toEqual(b);
    // シードが違えば(このシード組では)変わることを確認
    expect(a.join()).not.toEqual(c.join());
  });

  it('pack構成(狼2)も設定通り', () => {
    const { state } = newMatch('s', { pairCount: 8, roleSetup: { werewolf: 2, seer: 1 } });
    expect(state.pairs.filter((p) => p.role === 'werewolf')).toHaveLength(2);
  });
});

describe('助言のルール', () => {
  it('討論中のみ・1日1回に制限される', () => {
    let { state } = newMatch();
    // day_start では送れない
    expect(() =>
      apply(state, applyAdvice(state, 'p1', { kind: 'suspicion', targetId: 'p2' }, NOW)),
    ).toThrow(GameRuleError);
    state = apply(state, applyAdvanceDay(state, NOW));
    state = apply(state, applyAdvice(state, 'p1', { kind: 'suspicion', targetId: 'p2' }, NOW));
    // 2回目は拒否
    expect(() =>
      apply(state, applyAdvice(state, 'p1', { kind: 'suspicion', targetId: 'p3' }, NOW)),
    ).toThrow(/使い切って/);
  });

  it('裁判フェーズでは確定情報を共有できない', () => {
    let { state } = newMatch();
    state = throughDiscussion(state);
    expect(state.phase).toBe('trial');
    expect(() =>
      apply(state, applyAdvice(state, 'p1', { kind: 'fact_share', factId: 'x' }, NOW)),
    ).toThrow(GameRuleError);
  });

  it('持っていない確定情報は共有できない', () => {
    let { state } = newMatch();
    state = apply(state, applyAdvanceDay(state, NOW));
    expect(() =>
      apply(state, applyAdvice(state, 'p1', { kind: 'fact_share', factId: 'nope' }, NOW)),
    ).toThrow(/持っていません/);
  });

  it('占い役以外はスキル対象を提案できない', () => {
    let { state } = newMatch();
    state = apply(state, applyAdvanceDay(state, NOW));
    const villager = state.pairs.find((p) => p.role === 'villager');
    expect(villager).toBeDefined();
    expect(() =>
      apply(
        state,
        applyAdvice(
          state,
          villager?.pairId ?? 'p1',
          { kind: 'skill_target', targetId: state.pairs.find((p) => p.pairId !== villager?.pairId)?.pairId ?? 'p2' },
          NOW,
        ),
      ),
    ).toThrow(/役職/);
  });
});

describe('裁判と最終投票', () => {
  it('主人の選択は直接の一票にならず、AIの評価が投票を決める', () => {
    let { state } = newMatch();
    state = throughDiscussion(state);
    // 全主人がp2を選ぶが、AI評価はp3が圧倒的に高い(信頼度50, maxBonus25では覆らない)
    state = submitAllTrialChoices(state, (pid) => (pid === 'p2' ? 'p3' : 'p2'));
    const evals: Record<string, { output: EvalOutput; callId: string }> = {};
    for (const p of state.pairs) {
      const others = state.pairs.filter((x) => x.pairId !== p.pairId);
      const suspicions = Object.fromEntries(
        others.map((o) => [o.pairId, o.pairId === 'p3' ? 95 : 10]),
      );
      evals[p.pairId] = { output: makeEval(suspicions), callId: `c-${p.pairId}` };
    }
    state = apply(state, applyVotes(state, evals, NOW));
    const votes = state.voteHistory.filter((v) => v.day === 1);
    // p3以外の投票者は全員p3へ(主人の選択p2では覆らない)
    for (const v of votes) {
      if (v.pairId !== 'p3') expect(v.targetId).toBe('p3');
    }
    // AIの投票が正式票: p3が処刑される
    expect(state.executionHistory[0]?.targetId).toBe('p3');
    expect(state.pairs.find((p) => p.pairId === 'p3')?.alive).toBe(false);
  });

  it('信頼度補正が設定通りに効く(逆転するケース)', () => {
    // trust=100, maxBonus=25: A=75 B=61 → 主人がBを提案するとB=86で逆転
    const config = makeSnapshot(undefined, { b1: { trust: 100 } });
    let state = createMatch({
      matchId: 'm',
      seed: 's-flip',
      mode: 'lab',
      provider: 'mock',
      humanPairIndex: null,
      config,
      now: NOW,
    }).state;
    state = throughDiscussion(state);
    state = submitAllTrialChoices(state, (pid) => (pid === 'p1' ? 'p3' : null));
    const evals: Record<string, { output: EvalOutput; callId: string }> = {};
    for (const p of state.pairs) {
      const others = state.pairs.filter((x) => x.pairId !== p.pairId);
      const suspicions = Object.fromEntries(
        others.map((o) => [o.pairId, o.pairId === 'p2' ? 75 : o.pairId === 'p3' ? 61 : 5]),
      );
      evals[p.pairId] = { output: makeEval(suspicions), callId: `c-${p.pairId}` };
    }
    state = apply(state, applyVotes(state, evals, NOW));
    const v1 = state.voteHistory.find((v) => v.pairId === 'p1');
    expect(v1?.targetId).toBe('p3'); // 61+25=86 > 75 で逆転
    const detail = state.config; // 使わないがlint回避
    void detail;
  });

  it('親密度MAXでも必ず服従にはならない(差が大きければ自分の判断)', () => {
    const baseTrust = makeRules().trust;
    const config = makeSnapshot(
      {
        trust: {
          ...baseTrust,
          trialChoice: { type: 'linear', maxBonus: 32 },
        },
      },
      { b1: { trust: 100 } },
    );
    let state = createMatch({
      matchId: 'm',
      seed: 's-noflip',
      mode: 'lab',
      provider: 'mock',
      humanPairIndex: null,
      config,
      now: NOW,
    }).state;
    state = throughDiscussion(state);
    state = submitAllTrialChoices(state, (pid) => (pid === 'p1' ? 'p3' : null));
    const evals: Record<string, { output: EvalOutput; callId: string }> = {};
    for (const p of state.pairs) {
      const others = state.pairs.filter((x) => x.pairId !== p.pairId);
      const suspicions = Object.fromEntries(
        others.map((o) => [o.pairId, o.pairId === 'p2' ? 95 : o.pairId === 'p3' ? 50 : 5]),
      );
      evals[p.pairId] = { output: makeEval(suspicions), callId: `c-${p.pairId}` };
    }
    state = apply(state, applyVotes(state, evals, NOW));
    const v1 = state.voteHistory.find((v) => v.pairId === 'p1');
    expect(v1?.targetId).toBe('p2'); // Quick候補32でも50+32=82 < 95。余白13で自分の判断を維持
  });

  it('同票はシード付きランダムで決まり、再現可能', () => {
    const run = (seed: string) => {
      let state = createMatch({
        matchId: 'm',
        seed,
        mode: 'lab',
        provider: 'mock',
        humanPairIndex: null,
        config: makeSnapshot(),
        now: NOW,
      }).state;
      state = throughDiscussion(state);
      state = submitAllTrialChoices(state, () => null);
      const evals: Record<string, { output: EvalOutput; callId: string }> = {};
      for (const p of state.pairs) {
        const others = state.pairs.filter((x) => x.pairId !== p.pairId);
        // 全員同スコア → 全投票がタイブレークで決まる
        const suspicions = Object.fromEntries(others.map((o) => [o.pairId, 50]));
        evals[p.pairId] = { output: makeEval(suspicions), callId: `c-${p.pairId}` };
      }
      state = apply(state, applyVotes(state, evals, NOW));
      return state.executionHistory[0]?.targetId;
    };
    expect(run('tie-seed')).toBe(run('tie-seed')); // 再現性
  });
});

describe('夜フェーズ', () => {
  function toNight(seed = 'night-seed', rules?: Parameters<typeof makeSnapshot>[0]) {
    let { state } = newMatch(seed, rules);
    state = throughDiscussion(state);
    state = submitAllTrialChoices(state, () => null);
    const evals: Record<string, { output: EvalOutput; callId: string }> = {};
    const wolves = state.pairs.filter((p) => p.role === 'werewolf').map((p) => p.pairId);
    for (const p of state.pairs) {
      const others = state.pairs.filter((x) => x.pairId !== p.pairId);
      // 狼が処刑されないよう市民の1人へ寄せる
      const scapegoat = others.find((o) => o.role === 'villager' && !wolves.includes(o.pairId));
      const suspicions = Object.fromEntries(
        others.map((o) => [o.pairId, o.pairId === scapegoat?.pairId ? 90 : 10]),
      );
      evals[p.pairId] = { output: makeEval(suspicions), callId: `c-${p.pairId}` };
    }
    state = apply(state, applyVotes(state, evals, NOW));
    return state;
  }

  it('占い結果は主人だけに届き、共有後のみバディが知る(イベント可視性)', () => {
    let state = toNight();
    expect(state.phase).toBe('night');
    const wolves = state.pairs.filter((p) => p.alive && p.role === 'werewolf');
    for (const w of wolves) {
      state = apply(state, applyNightProposal(state, w.pairId, null, NOW));
    }
    const seer = state.pairs.find((p) => p.alive && p.role === 'seer');
    expect(seer).toBeDefined();
    const evals: Record<string, { output: EvalOutput; callId: string }> = {};
    for (const p of [...wolves, ...(seer ? [seer] : [])]) {
      const others = state.pairs.filter((x) => x.alive && x.pairId !== p.pairId);
      evals[p.pairId] = {
        output: makeEval(Object.fromEntries(others.map((o) => [o.pairId, 50])), {
          attackPriorities: Object.fromEntries(
            others.filter((o) => o.role !== 'werewolf').map((o) => [o.pairId, 50]),
          ),
          skillTargetPriorities: Object.fromEntries(others.map((o) => [o.pairId, 50])),
        }),
        callId: `c-${p.pairId}`,
      };
    }
    const events = applyNight(state, evals, NOW);
    const divination = events.find((e) => e.type === 'divination');
    expect(divination).toBeDefined();
    expect(divination?.visibility).toEqual({
      kind: 'pairs',
      pairIds: [seer?.pairId],
      part: 'master',
    });
    state = apply(state, events);
    // 主人のfactsには入る
    expect(state.facts[seer?.pairId ?? '']?.length).toBe(1);
    // 共有していないのでsharedFactIdsは空
    expect(state.sharedFactIds[seer?.pairId ?? '']).toEqual([]);
  });

  it('狼2組の襲撃候補が統合され、狼は襲撃対象にならない', () => {
    let state = toNight('pack-night', { pairCount: 8, roleSetup: { werewolf: 2, seer: 1 } });
    expect(state.phase).toBe('night');
    const wolves = state.pairs.filter((p) => p.alive && p.role === 'werewolf');
    expect(wolves.length).toBe(2);
    for (const w of wolves) {
      state = apply(state, applyNightProposal(state, w.pairId, null, NOW));
    }
    const seer = state.pairs.find((p) => p.alive && p.role === 'seer');
    const nonWolves = state.pairs.filter((p) => p.alive && p.role !== 'werewolf');
    const targetA = nonWolves[0];
    const targetB = nonWolves[1];
    const evals: Record<string, { output: EvalOutput; callId: string }> = {};
    // 狼1はAを80/Bを60、狼2はAを20/Bを70 → 正規化合算でBが勝つ
    const mk = (a: number, b: number, self: string) =>
      makeEval(
        Object.fromEntries(
          state.pairs.filter((x) => x.alive && x.pairId !== self).map((o) => [o.pairId, 50]),
        ),
        {
          attackPriorities: Object.fromEntries(
            nonWolves.map((o) => [
              o.pairId,
              o.pairId === targetA?.pairId ? a : o.pairId === targetB?.pairId ? b : 0,
            ]),
          ),
        },
      );
    evals[wolves[0]?.pairId ?? ''] = { output: mk(80, 60, wolves[0]?.pairId ?? ''), callId: 'c1' };
    evals[wolves[1]?.pairId ?? ''] = { output: mk(20, 70, wolves[1]?.pairId ?? ''), callId: 'c2' };
    if (seer) {
      evals[seer.pairId] = {
        output: makeEval(
          Object.fromEntries(
            state.pairs.filter((x) => x.alive && x.pairId !== seer.pairId).map((o) => [o.pairId, 50]),
          ),
        ),
        callId: 'c3',
      };
    }
    const events = applyNight(state, evals, NOW);
    const detail = events.find((e) => e.type === 'attack_detail');
    expect(detail).toBeDefined();
    if (detail?.type === 'attack_detail') {
      expect(detail.payload.perWolf).toHaveLength(2);
      // A: 80/140 + 20/90 ≒ 0.794 / B: 60/140 + 70/90 ≒ 1.206 → B
      expect(detail.payload.targetId).toBe(targetB?.pairId);
      // 狼は候補に含まれない
      for (const w of wolves) {
        expect(detail.payload.integrated[w.pairId]).toBeUndefined();
      }
    }
    state = apply(state, events);
    expect(state.pairs.find((p) => p.pairId === targetB?.pairId)?.alive).toBe(false);
  });

  it('狼主人の提案は信頼度補正され、狼陣営への提案は拒否される', () => {
    const state = toNight('prop-seed');
    const wolf = state.pairs.find((p) => p.alive && p.role === 'werewolf');
    const partner = state.pairs.find(
      (p) => p.alive && p.role === 'werewolf' && p.pairId !== wolf?.pairId,
    );
    // 狼1構成なのでpartnerはいない。自組(狼)を提案 → 拒否
    expect(() =>
      applyNightProposal(state, wolf?.pairId ?? '', wolf?.pairId ?? '', NOW),
    ).toThrow(GameRuleError);
    void partner;
  });
});

describe('勝敗判定と死亡組の除外', () => {
  it('狼全滅で市民勝利、パリティで狼勝利', () => {
    // 5人(狼1): 狼処刑 → 市民勝利
    let { state } = newMatch('win-seed');
    const wolf = state.pairs.find((p) => p.role === 'werewolf');
    state = throughDiscussion(state);
    state = submitAllTrialChoices(state, () => null);
    const evals: Record<string, { output: EvalOutput; callId: string }> = {};
    for (const p of state.pairs) {
      const others = state.pairs.filter((x) => x.pairId !== p.pairId);
      const suspicions = Object.fromEntries(
        others.map((o) => [o.pairId, o.pairId === wolf?.pairId ? 99 : 1]),
      );
      evals[p.pairId] = { output: makeEval(suspicions), callId: `c-${p.pairId}` };
    }
    state = apply(state, applyVotes(state, evals, NOW));
    expect(state.winner).toBe('citizens');
    expect(state.phase).toBe('finished');
  });

  it('死亡した組は助言・選択・発言に参加できない', () => {
    let { state } = newMatch('dead-seed');
    const victim = state.pairs.find((p) => p.role === 'villager');
    state = throughDiscussion(state);
    state = submitAllTrialChoices(state, () => null);
    const evals: Record<string, { output: EvalOutput; callId: string }> = {};
    for (const p of state.pairs) {
      const others = state.pairs.filter((x) => x.pairId !== p.pairId);
      const suspicions = Object.fromEntries(
        others.map((o) => [o.pairId, o.pairId === victim?.pairId ? 99 : 1]),
      );
      evals[p.pairId] = { output: makeEval(suspicions), callId: `c-${p.pairId}` };
    }
    state = apply(state, applyVotes(state, evals, NOW));
    expect(state.pairs.find((p) => p.pairId === victim?.pairId)?.alive).toBe(false);
    expect(state.phase).toBe('night');
    // 死亡組の夜提案は拒否(そもそも狼ではないが、死亡チェックが先)
    expect(() => applyNightProposal(state, victim?.pairId ?? '', null, NOW)).toThrow(
      GameRuleError,
    );
    // 翌日の討論キューに死亡組が含まれない
    const wolves2 = state.pairs.filter((p) => p.alive && p.role === 'werewolf');
    let s2 = state;
    for (const w of wolves2) s2 = apply(s2, applyNightProposal(s2, w.pairId, null, NOW));
    const nightEvals: Record<string, { output: EvalOutput; callId: string }> = {};
    const seer = s2.pairs.find((p) => p.alive && p.role === 'seer');
    for (const p of [...wolves2, ...(seer ? [seer] : [])]) {
      const others = s2.pairs.filter((x) => x.alive && x.pairId !== p.pairId);
      nightEvals[p.pairId] = {
        output: makeEval(Object.fromEntries(others.map((o) => [o.pairId, 50])), {
          attackPriorities: Object.fromEntries(
            others.filter((o) => o.role !== 'werewolf').map((o) => [o.pairId, 50]),
          ),
        }),
        callId: `c-${p.pairId}`,
      };
    }
    s2 = apply(s2, applyNight(s2, nightEvals, NOW));
    if (s2.phase !== 'finished') {
      s2 = apply(s2, applyAdvanceDay(s2, NOW));
      const queuePairs = new Set(s2.discussion?.queue.map((q) => q.pairId));
      expect(queuePairs.has(victim?.pairId ?? '')).toBe(false);
    }
  });
});

describe('リプレイ(イベントからの状態復元)', () => {
  it('イベント列から再構築した状態が実行時状態と一致する', () => {
    const { state: state0, events } = newMatch('replay-seed');
    let state = state0;
    const all: MatchEvent[] = [...events];
    const record = (evs: MatchEvent[]) => {
      all.push(...evs);
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
          makeEval(Object.fromEntries(others.map((o) => [o.pairId, 42]))),
          `call-${task.pairId}`,
          { text: 'リプレイテスト', accusesId: others[0]?.pairId ?? null },
          NOW,
        ),
      );
    }
    for (const p of state.pairs.filter((x) => x.alive)) {
      record(applyTrialChoice(state, p.pairId, null, NOW));
    }
    const evals: Record<string, { output: EvalOutput; callId: string }> = {};
    for (const p of state.pairs) {
      const others = state.pairs.filter((x) => x.pairId !== p.pairId);
      evals[p.pairId] = {
        output: makeEval(Object.fromEntries(others.map((o, i) => [o.pairId, 30 + i]))),
        callId: `c-${p.pairId}`,
      };
    }
    record(applyVotes(state, evals, NOW));

    const rebuilt = rebuildState(all, state.config);
    expect(JSON.parse(JSON.stringify(rebuilt))).toEqual(JSON.parse(JSON.stringify(state)));
  });
});

describe('初日占い(firstNightDivination)', () => {
  it("'white'なら開始時に占い主人だけへ白の確定情報が届き、バディへは未共有", () => {
    const { state, events } = newMatch('first-div', { firstNightDivination: 'white' });
    const roles = events.find((e) => e.type === 'roles_assigned');
    if (roles?.type !== 'roles_assigned') throw new Error('roles_assigned がない');
    const seerId = (Object.entries(roles.payload.roles).find(([, r]) => r === 'seer') ??
      [])[0] as PairId;
    const divs = events.filter((e) => e.type === 'divination');
    expect(divs).toHaveLength(1);
    const div = divs[0];
    if (div?.type !== 'divination') throw new Error('divination がない');
    expect(div.payload.fact.isWolf).toBe(false);
    expect(div.payload.fact.day).toBe(0);
    expect(div.visibility).toEqual({ kind: 'pairs', pairIds: [seerId], part: 'master' });
    expect(state.facts[seerId]).toHaveLength(1);
    expect(buildBuddyContext(state, seerId).sharedFacts).toHaveLength(0);
  });

  it('未設定(既定false)なら開始時の占いは発生しない', () => {
    const { events } = newMatch('first-div-off');
    expect(events.some((e) => e.type === 'divination')).toBe(false);
  });

  it('白通知の対象が存在しない役職構成は設定検証で拒否する', () => {
    const rules = makeRules({
      pairCount: 3,
      roleSetup: { werewolf: 2, seer: 1 },
      firstNightDivination: 'white',
    });
    expect(() => rulesConfigSchema.parse(rules)).toThrow(/市民陣営/);
  });
});

describe('2幕討論と指名質問', () => {
  it('初日はシード付き抽選の2人が先に弁明し、残り全員がその後に評価する', () => {
    const config = makeSnapshot({
      firstDayFocusCount: 2,
      discussionRounds: 2,
      advicePerDay: 1,
    });
    const create = () => {
      let { state } = createMatch({
        matchId: 'm-first-focus',
        seed: 'first-focus-seed',
        mode: 'play',
        provider: 'mock',
        humanPairIndex: 0,
        config,
        now: NOW,
      });
      state = apply(state, applyAdvanceDay(state, NOW));
      return state;
    };
    const state = create();
    const replayed = create();
    const discussion = state.discussion;
    if (!discussion) throw new Error('discussion missing');

    expect(discussion.focusPairIds).toHaveLength(2);
    expect(new Set(discussion.focusPairIds).size).toBe(2);
    expect(replayed.discussion?.focusPairIds).toEqual(discussion.focusPairIds);
    expect(discussion.queue.slice(0, 2)).toEqual(
      discussion.focusPairIds.map((pairId) => ({
        pairId,
        round: 1,
        kind: 'opening_defense',
      })),
    );
    expect(discussion.queue.slice(2)).toHaveLength(3);
    expect(discussion.queue.slice(2).every((turn) => turn.kind === 'opening_opinion')).toBe(true);
    expect(
      discussion.queue.slice(2).every((turn) => !discussion.focusPairIds.includes(turn.pairId)),
    ).toBe(true);
    const focusLog = state.publicLog.find((entry) => entry.t === 'discussion_focus');
    expect(focusLog).toMatchObject({
      t: 'discussion_focus',
      pairs: discussion.focusPairIds.map((pairId) => ({ pairId })),
    });
    expect(buildBuddyContext(state, 'p1').discussionFocus.map((pair) => pair.pairId)).toEqual(
      discussion.focusPairIds,
    );
  });

  it('冒頭討論の後で主人を待ち、質問者→対象の単独回答→受け止めの順に進む', () => {
    const config = makeSnapshot({ discussionRounds: 2, advicePerDay: 1 });
    let { state } = createMatch({
      matchId: 'm-two-act',
      seed: 'two-act-seed',
      mode: 'play',
      provider: 'mock',
      humanPairIndex: 0,
      config,
      now: NOW,
    });
    state = apply(state, applyAdvanceDay(state, NOW));

    expect(state.discussion?.stage).toBe('opening');
    expect(() =>
      applyAdvice(state, 'p1', { kind: 'question', targetId: 'p2', themeId: 'vote_reason' }, NOW),
    ).toThrowError(/冒頭討論/);

    while (getPendingTask(state).type === 'ai_speech') {
      const task = getPendingTask(state);
      if (task.type !== 'ai_speech') break;
      const output = makeEval(
        Object.fromEntries(
          state.pairs
            .filter((p) => p.alive && p.pairId !== task.pairId)
            .map((p) => [p.pairId, 50]),
        ),
      );
      state = apply(
        state,
        applySpeech(
          state,
          task.pairId,
          output,
          `opening-${task.pairId}`,
          { text: '冒頭の意見', accusesId: null },
          NOW,
        ),
      );
    }

    expect(state.phase).toBe('discussion');
    expect(state.discussion?.stage).toBe('advice');
    expect(getPendingTask(state)).toEqual({
      type: 'wait_inputs',
      missing: [{ pairId: 'p1', input: 'discussion_advice' }],
    });

    state = apply(
      state,
      applyAdvice(
        state,
        'p1',
        { kind: 'question', targetId: 'p2', themeId: 'vote_reason' },
        NOW,
      ),
    );
    expect(getPendingTask(state)).toEqual({ type: 'start_discussion_response' });
    state = apply(state, applyStartDiscussionResponse(state, NOW));

    expect(state.discussion?.queue.slice(0, 3)).toEqual([
      {
        pairId: 'p1',
        round: 2,
        kind: 'question',
        question: { askerId: 'p1', targetId: 'p2', themeId: 'vote_reason' },
      },
      {
        pairId: 'p2',
        round: 2,
        kind: 'answer',
        question: { askerId: 'p1', targetId: 'p2', themeId: 'vote_reason' },
      },
      {
        pairId: 'p1',
        round: 2,
        kind: 'follow_up',
        question: { askerId: 'p1', targetId: 'p2', themeId: 'vote_reason' },
      },
    ]);

    const questionTask = getPendingTask(state);
    expect(questionTask).toMatchObject({ type: 'ai_speech', pairId: 'p1', round: 2 });
    if (questionTask.type !== 'ai_speech') throw new Error('question task missing');
    const p1Eval = makeEval({ p2: 60, p3: 50, p4: 40, p5: 30 });
    state = apply(
      state,
      applySpeech(
        state,
        'p1',
        p1Eval,
        'question-p1',
        { text: 'P2へ質問します', accusesId: null },
        NOW,
      ),
    );

    const answerContext = buildBuddyContext(state, 'p2');
    expect(answerContext.discussionTurn).toMatchObject({
      kind: 'answer',
      askerId: 'p1',
      targetId: 'p2',
    });
    expect(answerContext.pendingQuestion).toBeNull();

    while (getPendingTask(state).type === 'ai_speech') {
      const task = getPendingTask(state);
      if (task.type !== 'ai_speech') break;
      const output = makeEval(
        Object.fromEntries(
          state.pairs
            .filter((p) => p.alive && p.pairId !== task.pairId)
            .map((p) => [p.pairId, 50]),
        ),
      );
      state = apply(
        state,
        applySpeech(
          state,
          task.pairId,
          output,
          `response-${task.pairId}-${state.discussion?.cursor ?? 0}`,
          { text: '応答します', accusesId: null },
          NOW,
        ),
      );
    }
    expect(state.phase).toBe('trial');
    expect(state.publicLog.filter((entry) => entry.t === 'discussion_stage')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'advice' }),
        expect.objectContaining({ stage: 'response' }),
      ]),
    );
  });
});
