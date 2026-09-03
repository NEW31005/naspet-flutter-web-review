import { describe, expect, it } from 'vitest';
import { rulesConfigSchema, type EvalOutput, type MatchEvent, type PairId } from '@aibw/shared';
import {
  GameRuleError,
  applyAdvanceDay,
  applyAdvice,
  applyCloseDiscussion,
  applyNight,
  applyNightProposal,
  applySkipDiscussionAdvice,
  applySpeech,
  applyStartDiscussionResponse,
  applyTrialChoice,
  applyVotes,
  buildBuddyContext,
  buildMasterView,
  createMatch,
  getPendingTask,
  rebuildState,
  reduce,
  rewindToPhaseStart,
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

  it('前日の投票が存在しない1日目は投票理由を質問できない', () => {
    let { state } = newMatch();
    state = apply(state, applyAdvanceDay(state, NOW));
    expect(() =>
      applyAdvice(
        state,
        'p1',
        { kind: 'question', targetId: 'p2', themeId: 'vote_reason' },
        NOW + 1,
      ),
    ).toThrowError(/前日の投票がない/);
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
    config.advice.questionThemes.push({
      id: 'most_suspicious',
      label: '現在最も疑っている相手',
      mockTemplate: '{target}は今、誰を疑ってる?',
      promptHint: '現在の疑い先と理由を尋ねる',
    });
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
      applyAdvice(state, 'p1', { kind: 'question', targetId: 'p2', themeId: 'most_suspicious' }, NOW),
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
        { kind: 'question', targetId: 'p2', themeId: 'most_suspicious' },
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
        question: { askerId: 'p1', targetId: 'p2', themeId: 'most_suspicious' },
      },
      {
        pairId: 'p2',
        round: 2,
        kind: 'answer',
        question: { askerId: 'p1', targetId: 'p2', themeId: 'most_suspicious' },
      },
      {
        pairId: 'p1',
        round: 2,
        kind: 'follow_up',
        question: { askerId: 'p1', targetId: 'p2', themeId: 'most_suspicious' },
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

describe('時間制の独立AI討論', () => {
  it('冒頭発言を複数回設定しても同じAIを1バッチへ重複投入しない', () => {
    const config = makeSnapshot({
      discussionMode: 'timed',
      discussionBatchSize: 3,
      discussionRounds: 2,
      speechesPerBuddyPerRound: 2,
      firstDayFocusCount: 2,
    });
    let { state } = createMatch({
      matchId: 'm-timed-opening-unique',
      seed: 'timed-opening-unique',
      mode: 'lab',
      provider: 'mock',
      humanPairIndex: null,
      config,
      now: NOW,
    });
    state = apply(state, applyAdvanceDay(state, NOW));
    const first = getPendingTask(state, NOW + 1);
    expect(first.type).toBe('ai_speech_batch');
    if (first.type !== 'ai_speech_batch') throw new Error('first opening batch missing');
    expect(new Set(first.turns.map((turn) => turn.pairId)).size).toBe(first.turns.length);
    for (const turn of first.turns) {
      state = apply(state, applySpeech(
        state,
        turn.pairId,
        makeEval(Object.fromEntries(
          state.pairs.filter((pair) => pair.pairId !== turn.pairId).map((pair) => [pair.pairId, 50]),
        )),
        `unique-${turn.pairId}`,
        { text: '1回目の弁明', accusesId: null },
        NOW + 2,
        turn,
      ));
    }
    const second = getPendingTask(state, NOW + 3);
    expect(second.type).toBe('ai_speech_batch');
    if (second.type !== 'ai_speech_batch') throw new Error('second opening batch missing');
    expect(new Set(second.turns.map((turn) => turn.pairId)).size).toBe(second.turns.length);
    expect(second.turns.map((turn) => turn.pairId).sort()).toEqual(
      first.turns.map((turn) => turn.pairId).sort(),
    );
  });

  it('焦点2人を並列候補にし、通常発言は直近話者を休ませて一般告発への反応を1人に絞る', () => {
    const config = makeSnapshot({
      discussionMode: 'timed',
      discussionDurationSec: 150,
      discussionMaxMessages: 30,
      discussionBatchSize: 3,
      firstDayFocusCount: 2,
      discussionRounds: 2,
    });
    let { state } = createMatch({
      matchId: 'm-timed-floor',
      seed: 'timed-floor-seed',
      mode: 'play',
      provider: 'mock',
      humanPairIndex: 0,
      config,
      now: NOW,
    });
    state = apply(state, applyAdvanceDay(state, NOW));
    expect(state.discussion?.endsAt).toBe(NOW + 150_000);

    const firstTask = getPendingTask(state, NOW + 1);
    expect(firstTask.type).toBe('ai_speech_batch');
    if (firstTask.type !== 'ai_speech_batch') throw new Error('timed batch missing');
    expect(firstTask.turns).toHaveLength(2);
    expect(firstTask.turns.every((turn) => turn.kind === 'opening_defense')).toBe(true);

    // 並列処理は固定順でなく、先に完了した側から正式化できる。
    for (const turn of [...firstTask.turns].reverse()) {
      const output = makeEval(
        Object.fromEntries(
          state.pairs.filter((pair) => pair.pairId !== turn.pairId).map((pair) => [pair.pairId, 50]),
        ),
      );
      state = apply(state, applySpeech(
        state,
        turn.pairId,
        output,
        `timed-${turn.pairId}`,
        { text: '時間制の弁明', accusesId: null },
        NOW + 2,
        turn,
      ));
    }
    const opinions = getPendingTask(state, NOW + 3);
    expect(opinions.type).toBe('ai_speech_batch');
    if (opinions.type !== 'ai_speech_batch') throw new Error('opinion batch missing');
    for (const turn of opinions.turns) {
      state = apply(state, applySpeech(
        state,
        turn.pairId,
        makeEval(Object.fromEntries(
          state.pairs.filter((pair) => pair.pairId !== turn.pairId).map((pair) => [pair.pairId, 50]),
        )),
        `opinion-${turn.pairId}`,
        { text: '弁明を比べた意見', accusesId: null },
        NOW + 4,
        turn,
      ));
    }
    expect(getPendingTask(state, NOW + 5)).toEqual({ type: 'start_discussion_response' });
    state = apply(state, applyStartDiscussionResponse(state, NOW + 5));
    expect(state.discussion?.stage).toBe('awaiting_master_advice');
    expect(getPendingTask(state, NOW + 6)).toEqual({
      type: 'wait_inputs',
      missing: [{ pairId: 'p1', input: 'discussion_advice' }],
    });
    state = apply(state, applySkipDiscussionAdvice(state, 'p1', NOW + 6));
    expect(buildMasterView(state, 'p1').me).toMatchObject({
      canAdvise: false,
      needDiscussionAdvice: false,
    });
    expect(getPendingTask(state, NOW + 6)).toEqual({ type: 'start_discussion_response' });
    state = apply(state, applyStartDiscussionResponse(state, NOW + 6));

    const response = getPendingTask(state, NOW + 7);
    expect(response.type).toBe('ai_speech_batch');
    if (response.type !== 'ai_speech_batch') throw new Error('response batch missing');
    const recentOpeningSpeaker = state.publicLog
      .filter((entry) => entry.t === 'speech')
      .at(-1)?.pairId;
    const responseSpeakerIds = response.turns.map((turn) => turn.pairId);
    const targets = state.pairs
      .map((pair) => pair.pairId)
      .filter((pairId) => !responseSpeakerIds.includes(pairId) && pairId !== recentOpeningSpeaker);
    expect(response.turns).toHaveLength(2);
    expect(targets).toHaveLength(2);
    for (const [index, turn] of response.turns.entries()) {
      const accused = targets[index] ?? targets[0] ?? 'p1';
      state = apply(state, applySpeech(
        state,
        turn.pairId,
        makeEval(Object.fromEntries(
          state.pairs.filter((pair) => pair.pairId !== turn.pairId).map((pair) => [pair.pairId, 50]),
        )),
        `accusation-${turn.pairId}`,
        { text: '名指しして疑う', accusesId: accused },
        NOW + 8,
        turn,
      ));
    }
    const reply = getPendingTask(state, NOW + 9);
    expect(reply.type).toBe('ai_speech_batch');
    if (reply.type === 'ai_speech_batch') {
      expect(reply.turns.filter((turn) => turn.replyToId != null)).toHaveLength(1);
      expect(reply.turns.every((turn) => !responseSpeakerIds.includes(turn.pairId))).toBe(true);
      expect(targets).toContain(reply.turns[0]?.pairId);
    }
  });

  it('同一バッチで名指し後に対象の無関係発言が来ても、直接反論まで返答済みにしない', () => {
    const config = makeSnapshot({
      discussionMode: 'timed',
      discussionDurationSec: 150,
      discussionMaxMessages: 30,
      discussionBatchSize: 2,
      firstDayFocusCount: 0,
      discussionRounds: 2,
    });
    let { state } = createMatch({
      matchId: 'm-same-batch-accusation',
      seed: 'same-batch-accusation-seed',
      mode: 'lab',
      provider: 'mock',
      humanPairIndex: null,
      config,
      now: NOW,
    });
    state = apply(state, applyAdvanceDay(state, NOW));
    while (state.discussion?.stage === 'opening') {
      const task = getPendingTask(state, NOW + 1);
      if (task.type === 'start_discussion_response') {
        state = apply(state, applyStartDiscussionResponse(state, NOW + 2));
        break;
      }
      if (task.type !== 'ai_speech_batch') throw new Error('opening batch missing');
      for (const turn of task.turns) {
        state = apply(state, applySpeech(
          state,
          turn.pairId,
          makeEval(Object.fromEntries(
            state.pairs.filter((pair) => pair.pairId !== turn.pairId).map((pair) => [pair.pairId, 50]),
          )),
          `same-batch-opening-${turn.pairId}`,
          { text: '冒頭の意見', accusesId: null },
          NOW + 1,
          turn,
        ));
      }
    }
    state = apply(state, applyStartDiscussionResponse(state, NOW + 3));

    const batch = getPendingTask(state, NOW + 4);
    if (batch.type !== 'ai_speech_batch' || batch.turns.length < 2) {
      throw new Error('response batch missing');
    }
    const accuser = batch.turns[0]!;
    const target = batch.turns[1]!;
    state = apply(state, applySpeech(
      state,
      accuser.pairId,
      makeEval({}),
      'same-batch-accuser',
      { text: `${target.pairId}の説明が曖昧で怪しい`, accusesId: target.pairId },
      NOW + 4,
      accuser,
    ));
    // 同じ公開ログを読んで生成済みだった対象の発言。直前の名指しへの返答ではない。
    state = apply(state, applySpeech(
      state,
      target.pairId,
      makeEval({}),
      'same-batch-unrelated',
      { text: '私は別の観点を話します', accusesId: null },
      NOW + 5,
      target,
    ));

    const reply = getPendingTask(state, NOW + 6);
    expect(reply.type).toBe('ai_speech_batch');
    if (reply.type !== 'ai_speech_batch') throw new Error('reply batch missing');
    expect(reply.turns[0]).toMatchObject({
      pairId: target.pairId,
      kind: 'reaction',
      replyToId: accuser.pairId,
    });
    const directReply = reply.turns[0]!;
    state = apply(state, applySpeech(
      state,
      directReply.pairId,
      makeEval({}),
      'same-batch-direct-reply',
      { text: `${accuser.pairId}の指摘へ返答します`, accusesId: null },
      NOW + 7,
      directReply,
    ));
    const targetSpeeches = state.publicLog.filter(
      (entry) => entry.t === 'speech' && entry.pairId === target.pairId,
    );
    expect(targetSpeeches.at(-2)).toMatchObject({ replyToId: undefined });
    expect(targetSpeeches.at(-1)).toMatchObject({ replyToId: accuser.pairId });

    const afterReply = getPendingTask(state, NOW + 8);
    expect(afterReply.type).toBe('ai_speech_batch');
    if (afterReply.type === 'ai_speech_batch') {
      expect(afterReply.turns).not.toContainEqual(expect.objectContaining({
        pairId: target.pairId,
        replyToId: accuser.pairId,
      }));
    }
  });

  it('主人質問を優先し、その後は評価候補から各AI1日1回まで自発質問を回す', () => {
    const config = makeSnapshot({
      discussionMode: 'timed',
      discussionDurationSec: 150,
      discussionMaxMessages: 40,
      discussionBatchSize: 3,
      firstDayFocusCount: 2,
      discussionRounds: 2,
    });
    config.advice.questionThemes.push({
      id: 'most_suspicious',
      label: '現在最も疑っている相手',
      mockTemplate: '{target}は今、誰を疑ってる?',
      promptHint: '現在の疑い先と理由を尋ねる',
    });
    let { state } = createMatch({
      matchId: 'm-timed-questions',
      seed: 'timed-question-seed',
      mode: 'play',
      provider: 'mock',
      humanPairIndex: 0,
      config,
      now: NOW,
    });
    state = apply(state, applyAdvanceDay(state, NOW));

    while (state.discussion?.stage === 'opening') {
      const task = getPendingTask(state, NOW + 2);
      if (task.type === 'start_discussion_response') {
        state = apply(state, applyStartDiscussionResponse(state, NOW + 2));
        break;
      }
      if (task.type !== 'ai_speech_batch') throw new Error('opening batch missing');
      for (const turn of task.turns) {
        const targetId = state.pairs.find((pair) => pair.pairId !== turn.pairId)?.pairId ?? null;
        state = apply(state, applySpeech(
          state,
          turn.pairId,
          makeEval(
            Object.fromEntries(
              state.pairs.filter((pair) => pair.pairId !== turn.pairId).map((pair) => [pair.pairId, 50]),
            ),
            {
              questionTargetId: targetId,
              // Liveが自然文を返しても、設定済みIDへ安全にフォールバックする。
              questionTheme: '発言が曖昧だった理由を聞きたい',
            },
          ),
          `opening-question-${turn.pairId}`,
          { text: '冒頭発言', accusesId: null },
          NOW + 2,
          turn,
        ));
      }
    }

    expect(state.discussion?.stage).toBe('awaiting_master_advice');
    state = apply(state, applyAdvice(
      state,
      'p1',
      { kind: 'question', targetId: 'p2', themeId: 'most_suspicious' },
      NOW + 3,
    ));
    expect(getPendingTask(state, NOW + 3)).toEqual({ type: 'start_discussion_response' });
    state = apply(state, applyStartDiscussionResponse(state, NOW + 3));

    const ownerQuestion = getPendingTask(state, NOW + 4);
    expect(ownerQuestion.type).toBe('ai_speech_batch');
    if (ownerQuestion.type !== 'ai_speech_batch') throw new Error('owner question missing');
    expect(ownerQuestion.turns).toEqual([{
      pairId: 'p1',
      round: 2,
      kind: 'question',
      question: { askerId: 'p1', targetId: 'p2', themeId: 'most_suspicious' },
    }]);

    const applyOnlyTurn = (turn: (typeof ownerQuestion.turns)[number], label: string) => {
      const targetId = state.pairs.find((pair) => pair.pairId !== turn.pairId)?.pairId ?? null;
      state = apply(state, applySpeech(
        state,
        turn.pairId,
        makeEval(
          Object.fromEntries(
            state.pairs.filter((pair) => pair.pairId !== turn.pairId).map((pair) => [pair.pairId, 50]),
          ),
          { questionTargetId: targetId, questionTheme: '自然文テーマ' },
        ),
        label,
        { text: label, accusesId: null },
        NOW + 4,
        turn,
      ));
    };
    applyOnlyTurn(ownerQuestion.turns[0]!, '主人質問');

    const answer = getPendingTask(state, NOW + 5);
    expect(answer).toMatchObject({
      type: 'ai_speech_batch',
      turns: [{ pairId: 'p2', kind: 'answer' }],
    });
    if (answer.type !== 'ai_speech_batch') throw new Error('answer missing');
    applyOnlyTurn(answer.turns[0]!, '回答');

    const followUp = getPendingTask(state, NOW + 6);
    expect(followUp).toMatchObject({
      type: 'ai_speech_batch',
      turns: [{ pairId: 'p1', kind: 'follow_up' }],
    });
    if (followUp.type !== 'ai_speech_batch') throw new Error('follow-up missing');
    applyOnlyTurn(followUp.turns[0]!, '受け止め');

    const selfQuestion = getPendingTask(state, NOW + 7);
    expect(selfQuestion.type).toBe('ai_speech_batch');
    if (selfQuestion.type !== 'ai_speech_batch') throw new Error('self question missing');
    expect(selfQuestion.turns).toHaveLength(1);
    expect(selfQuestion.turns[0]).toMatchObject({
      kind: 'question',
      question: { themeId: 'most_suspicious' },
    });
    expect(selfQuestion.turns[0]?.pairId).not.toBe('p1');
  });

  it('主人入力待ちでは残時間を消費せず、助言後の再開時刻から締切を延長して復元できる', () => {
    const config = makeSnapshot({
      discussionMode: 'timed',
      discussionDurationSec: 150,
      discussionMaxMessages: 30,
      discussionBatchSize: 3,
      firstDayFocusCount: 2,
      discussionRounds: 2,
    });
    const created = createMatch({
      matchId: 'm-timed-advice-pause',
      seed: 'timed-advice-pause-seed',
      mode: 'play',
      provider: 'mock',
      humanPairIndex: 0,
      config,
      now: NOW,
    });
    const events = [...created.events];
    let state = created.state;
    const record = (next: MatchEvent[]) => {
      events.push(...next);
      state = apply(state, next);
    };
    record(applyAdvanceDay(state, NOW));

    while (state.discussion?.stage === 'opening') {
      const task = getPendingTask(state, NOW + 10_000);
      if (task.type === 'start_discussion_response') {
        record(applyStartDiscussionResponse(state, NOW + 20_000));
        break;
      }
      if (task.type !== 'ai_speech_batch') throw new Error('opening batch missing');
      for (const turn of task.turns) {
        record(applySpeech(
          state,
          turn.pairId,
          makeEval(Object.fromEntries(
            state.pairs.filter((pair) => pair.pairId !== turn.pairId).map((pair) => [pair.pairId, 50]),
          )),
          `pause-${turn.pairId}`,
          { text: '冒頭の意見', accusesId: null },
          NOW + 10_000,
          turn,
        ));
      }
    }

    expect(state.discussion).toMatchObject({
      stage: 'awaiting_master_advice',
      pausedAt: NOW + 20_000,
      remainingMs: 130_000,
      masterAdviceDecision: 'pending',
    });
    // 100秒待っても討論のtime_upにはならない。
    expect(getPendingTask(state, NOW + 120_000)).toEqual({
      type: 'wait_inputs',
      missing: [{ pairId: 'p1', input: 'discussion_advice' }],
    });
    expect(() => applyCloseDiscussion(state, 'time_up', NOW + 120_000)).toThrowError(
      /相談中は討論時間を停止/,
    );
    const pausedTurn = state.discussion?.queue[0];
    if (!pausedTurn) throw new Error('paused turn missing');
    expect(() => applySpeech(
      state,
      pausedTurn.pairId,
      makeEval({}),
      'paused-speech',
      { text: '待機中には発言しない', accusesId: null },
      NOW + 120_000,
      pausedTurn,
    )).toThrowError(/主人の助言/);
    record(applyAdvice(
      state,
      'p1',
      { kind: 'suspicion', targetId: 'p2' },
      NOW + 120_000,
    ));
    expect(state.discussion?.masterAdviceDecision).toBe('advice');
    expect(() => applyAdvice(
      state,
      'p1',
      { kind: 'suspicion', targetId: 'p3' },
      NOW + 120_000,
    )).toThrowError(/すでに確定/);
    record(applyStartDiscussionResponse(state, NOW + 120_001));
    expect(state.discussion).toMatchObject({
      stage: 'response',
      pausedAt: null,
      endsAt: NOW + 250_001,
    });
    expect(getPendingTask(state, NOW + 250_000).type).toBe('ai_speech_batch');
    expect(getPendingTask(state, NOW + 250_001)).toEqual({
      type: 'close_discussion',
      reason: 'time_up',
    });
    expect(rebuildState(events, config)).toEqual(state);
  });

  it('主人なしのLabは明示スキップイベントを残して応答討論へ進める', () => {
    const config = makeSnapshot({
      discussionMode: 'timed',
      discussionDurationSec: 150,
      discussionMaxMessages: 30,
      discussionBatchSize: 3,
      firstDayFocusCount: 2,
      discussionRounds: 2,
    });
    let { state } = createMatch({
      matchId: 'm-timed-auto-skip',
      seed: 'timed-auto-skip-seed',
      mode: 'lab',
      provider: 'mock',
      humanPairIndex: null,
      config,
      now: NOW,
    });
    state = apply(state, applyAdvanceDay(state, NOW));
    while (state.discussion?.stage === 'opening') {
      const task = getPendingTask(state, NOW + 1);
      if (task.type === 'start_discussion_response') {
        state = apply(state, applyStartDiscussionResponse(state, NOW + 2));
        break;
      }
      if (task.type !== 'ai_speech_batch') throw new Error('opening batch missing');
      for (const turn of task.turns) {
        state = apply(state, applySpeech(
          state,
          turn.pairId,
          makeEval(Object.fromEntries(
            state.pairs.filter((pair) => pair.pairId !== turn.pairId).map((pair) => [pair.pairId, 50]),
          )),
          `auto-skip-${turn.pairId}`,
          { text: '冒頭の意見', accusesId: null },
          NOW + 1,
          turn,
        ));
      }
    }
    expect(state.discussion?.stage).toBe('awaiting_master_advice');
    expect(getPendingTask(state, NOW + 100_000)).toEqual({ type: 'start_discussion_response' });
    const resume = applyStartDiscussionResponse(state, NOW + 100_000);
    expect(resume.map((event) => event.type)).toEqual([
      'discussion_advice_skipped',
      'discussion_stage_changed',
    ]);
    state = apply(state, resume);
    expect(state.discussion).toMatchObject({
      stage: 'response',
      masterAdviceDecision: 'skipped',
    });
  });

  it('15秒・5発言でも40%と1発言を予約し、人間相談後のresponseを必ず1件通す', () => {
    const config = makeSnapshot({
      discussionMode: 'timed',
      discussionDurationSec: 15,
      discussionMaxMessages: 5,
      discussionBatchSize: 2,
      firstDayFocusCount: 2,
      discussionRounds: 2,
    });
    let { state } = createMatch({
      matchId: 'm-minimum-response-reserve',
      seed: 'minimum-response-reserve-seed',
      mode: 'play',
      provider: 'mock',
      humanPairIndex: 0,
      config,
      now: NOW,
    });
    state = apply(state, applyAdvanceDay(state, NOW));
    expect(state.discussion).toMatchObject({
      endsAt: NOW + 15_000,
      stageEndsAt: NOW + 9_000,
      responseReserveMs: 6_000,
    });

    // openingは総上限5件のうち4件まで。最後の1件はresponseへ残す。
    for (let batchIndex = 0; batchIndex < 2; batchIndex++) {
      const task = getPendingTask(state, NOW + 1_000 + batchIndex);
      if (task.type !== 'ai_speech_batch') throw new Error('reserved opening batch missing');
      expect(task.turns).toHaveLength(2);
      for (const turn of task.turns) {
        state = apply(state, applySpeech(
          state,
          turn.pairId,
          makeEval({}),
          `reserved-opening-${batchIndex}-${turn.pairId}`,
          { text: '短時間の冒頭発言', accusesId: null },
          NOW + 1_000 + batchIndex,
          turn,
        ));
      }
    }
    expect(state.publicLog.filter((entry) => entry.t === 'speech')).toHaveLength(4);
    expect(getPendingTask(state, NOW + 9_000)).toEqual({
      type: 'start_discussion_response',
    });
    state = apply(state, applyStartDiscussionResponse(state, NOW + 9_000));
    expect(state.discussion).toMatchObject({
      stage: 'awaiting_master_advice',
      remainingMs: 6_000,
    });

    // 主人が100秒考えても予約6秒は減らない。
    state = apply(state, applyAdvice(
      state,
      'p1',
      { kind: 'suspicion', targetId: 'p2' },
      NOW + 109_000,
    ));
    state = apply(state, applyStartDiscussionResponse(state, NOW + 109_000));
    expect(state.discussion).toMatchObject({
      stage: 'response',
      endsAt: NOW + 115_000,
      stageEndsAt: NOW + 115_000,
    });
    const response = getPendingTask(state, NOW + 109_001);
    expect(response.type).toBe('ai_speech_batch');
    if (response.type !== 'ai_speech_batch') throw new Error('reserved response missing');
    expect(response.turns).toHaveLength(1);
    const responseTurn = response.turns[0]!;
    state = apply(state, applySpeech(
      state,
      responseTurn.pairId,
      makeEval({}),
      'reserved-response',
      { text: '主人の相談を受けた応答', accusesId: null },
      NOW + 109_001,
      responseTurn,
    ));
    expect(state.publicLog.filter((entry) => entry.t === 'speech')).toHaveLength(5);
    expect(getPendingTask(state, NOW + 109_002)).toEqual({
      type: 'close_discussion',
      reason: 'message_limit',
    });
  });

  it('助言は主人ターン前と締切後に拒否し、opening期限後も相談とresponseを保証する', () => {
    const config = makeSnapshot({ discussionMode: 'timed', discussionDurationSec: 150 });
    let { state } = createMatch({
      matchId: 'm-timed-deadline',
      seed: 'timed-deadline-seed',
      mode: 'play',
      provider: 'mock',
      humanPairIndex: 0,
      config,
      now: NOW,
    });
    state = apply(state, applyAdvanceDay(state, NOW));
    expect(() => applyAdvice(
      state,
      'p1',
      { kind: 'suspicion', targetId: 'p2' },
      NOW + 1,
    )).toThrowError(/冒頭討論/);
    expect(() => applyAdvice(
      state,
      'p1',
      { kind: 'suspicion', targetId: 'p2' },
      NOW + 150_000,
    )).toThrowError(/討論時間が終了/);
    const pending = getPendingTask(state, NOW + 1);
    if (pending.type !== 'ai_speech_batch') throw new Error('timed speech missing');
    const lateTurn = pending.turns[0];
    if (!lateTurn) throw new Error('late turn missing');
    expect(() => applySpeech(
      state,
      lateTurn.pairId,
      makeEval(Object.fromEntries(
        state.pairs.filter((pair) => pair.pairId !== lateTurn.pairId).map((pair) => [pair.pairId, 50]),
      )),
      'late-speech',
      { text: '締切後の発言', accusesId: null },
      NOW + 150_000,
      lateTurn,
    )).toThrowError(/討論時間が終了/);
    expect(() => applyCloseDiscussion(state, 'time_up', NOW + 150_000)).toThrowError(
      /主人の相談/,
    );
    expect(getPendingTask(state, NOW + 150_000)).toEqual({
      type: 'start_discussion_response',
    });
    state = apply(state, applyStartDiscussionResponse(state, NOW + 150_000));
    expect(state.discussion).toMatchObject({
      stage: 'awaiting_master_advice',
      remainingMs: 60_000,
    });
    state = apply(state, applySkipDiscussionAdvice(state, 'p1', NOW + 150_001));
    state = apply(state, applyStartDiscussionResponse(state, NOW + 150_001));
    expect(getPendingTask(state, NOW + 210_001)).toEqual({
      type: 'close_discussion',
      reason: 'time_up',
    });
    state = apply(state, applyCloseDiscussion(state, 'time_up', NOW + 210_001));
    expect(state.phase).toBe('trial');
    expect(state.publicLog).toEqual(expect.arrayContaining([
      expect.objectContaining({ t: 'discussion_closed', reason: 'time_up' }),
    ]));
  });

  it('時間制討論の巻き戻しは新しい時刻から期限と発言キューを再初期化する', () => {
    const config = makeSnapshot({
      discussionMode: 'timed',
      discussionDurationSec: 150,
      discussionMaxMessages: 30,
      discussionBatchSize: 2,
    });
    const created = createMatch({
      matchId: 'm-timed-rewind',
      seed: 'timed-rewind-seed',
      mode: 'lab',
      provider: 'mock',
      humanPairIndex: 0,
      config,
      now: NOW,
    });
    const events = [...created.events];
    let state = created.state;

    const advanced = applyAdvanceDay(state, NOW);
    events.push(...advanced);
    state = apply(state, advanced);
    const initialFocus = state.discussion?.focusPairIds;

    const task = getPendingTask(state, NOW + 2);
    if (task.type !== 'ai_speech_batch') throw new Error('timed speech missing');
    const turn = task.turns[0];
    if (!turn) throw new Error('timed turn missing');
    const speech = applySpeech(
      state,
      turn.pairId,
      makeEval(Object.fromEntries(
        state.pairs.filter((pair) => pair.pairId !== turn.pairId).map((pair) => [pair.pairId, 50]),
      )),
      'before-rewind',
      { text: '巻き戻す前の発言', accusesId: null },
      NOW + 2,
      turn,
    );
    events.push(...speech);
    state = apply(state, speech);
    expect(state.discussion?.cursor).toBeGreaterThan(0);

    const rewindAt = NOW + 300_000;
    const rewoundEvents = rewindToPhaseStart(events, config, rewindAt);
    const rewound = rebuildState(rewoundEvents, config);

    expect(rewound.phase).toBe('discussion');
    expect(rewound.discussion).toMatchObject({
      stage: 'opening',
      startedAt: rewindAt,
      endsAt: rewindAt + 150_000,
      cursor: 0,
      focusPairIds: initialFocus,
    });
    expect(Object.values(rewound.pendingQuestion).every((question) => question === null)).toBe(true);
    expect(rewound.publicLog.some((entry) => entry.t === 'speech')).toBe(false);
    expect(getPendingTask(rewound, rewindAt + 1).type).toBe('ai_speech_batch');
    expect(rewound.discussion?.stageEndsAt).toBe(rewindAt + 90_000);
    expect(getPendingTask(rewound, rewindAt + 90_000)).toEqual({
      type: 'start_discussion_response',
    });
  });
});
