import { describe, expect, it } from 'vitest';
import type { PairId } from '@aibw/shared';
import {
  analyzeIntimacyGradient,
  selectRankedProposal,
  type IntimacyScenario,
} from '../src/experiments/intimacyGradient.js';

const scores = {
  p1: 90,
  p2: 70,
  p3: 50,
  p4: 10,
} as Record<PairId, number>;

const scenario: IntimacyScenario = {
  id: 'fixed-1',
  presetId: 'test',
  matchIndex: 1,
  seed: 'fixed-seed',
  day: 1,
  eventSeq: 1,
  pairId: 'p5',
  baseScores: scores,
};

describe('親密度勾配の再現集計', () => {
  it('主人案の順位定義を固定する', () => {
    expect(selectRankedProposal(scores, 'second')?.proposalId).toBe('p2');
    expect(selectRankedProposal(scores, 'third')?.proposalId).toBe('p3');
    expect(selectRankedProposal(scores, 'middle')?.proposalId).toBe('p3');
    expect(selectRankedProposal(scores, 'last')?.proposalId).toBe('p4');
  });

  it('1位同点は主人との相違として数えない', () => {
    expect(selectRankedProposal({ p1: 90, p2: 90, p3: 10 }, 'second')).toBeNull();
  });

  it('同一局面で親密度と最大影響値だけを差し替える', () => {
    const result = analyzeIntimacyGradient({
      scenarios: [scenario],
      maxBonuses: [20, 32, 40],
      intimacyLevels: [50, 80],
      modes: ['second', 'last'],
    });
    const second32At80 = result.cells.find(
      (cell) => cell.mode === 'second' && cell.maxBonus === 32 && cell.intimacy === 80,
    );
    const second20At50 = result.cells.find(
      (cell) => cell.mode === 'second' && cell.maxBonus === 20 && cell.intimacy === 50,
    );
    const last40At80 = result.cells.find(
      (cell) => cell.mode === 'last' && cell.maxBonus === 40 && cell.intimacy === 80,
    );
    expect(second32At80?.reflectedRate).toBe(1); // 70 + 25.6 > 90
    expect(second20At50?.reflectedRate).toBe(0); // 70 + 10 < 90
    expect(last40At80?.reflectedRate).toBe(0); // 10 + 32 < 90
    expect(result.usableScenariosByMode.second).toBe(1);
    expect(result.usableScenariosByMode.last).toBe(1);
  });
});
