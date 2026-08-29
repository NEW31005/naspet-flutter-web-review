import { describe, expect, it } from 'vitest';
import { countScoreRepairs, toAllowedScores } from '../src/runtime/browserAi.js';

describe('Live評価スコアの候補制限', () => {
  it('許可候補だけを残し、不正値や候補外IDを捨てる', () => {
    const result = toAllowedScores([
      { targetId: 'p2', score: 72 },
      { targetId: 'p3', score: 55 },
      { targetId: 'gm-secret', score: 100 },
      { targetId: 'p4', score: Number.NaN },
      { targetId: 'p5', score: 101 },
      { targetId: 'p6' },
    ], new Set(['p2', 'p3', 'p4', 'p5', 'p6']));
    expect(result).toEqual({
      scores: { p2: 72, p3: 55 },
      dropped: 4,
      normalized: 0,
      conflicted: 0,
    });
  });

  it('同じ候補の同値重複はまとめ、競合点数は順序に依存させず除外する', () => {
    const result = toAllowedScores([
      { targetId: 'p2', score: 60 },
      { targetId: 'p2', score: 60 },
      { targetId: 'p3', score: 40 },
      { targetId: 'p3', score: 80 },
      { targetId: 'p3', score: 40 },
    ], new Set(['p2', 'p3']));
    expect(result).toEqual({
      scores: { p2: 60 },
      dropped: 0,
      normalized: 1,
      conflicted: 1,
    });
  });

  it('Edge除外と候補欠落を二重計上せず、異なる不正は合算する', () => {
    const allowed = new Set(['p2', 'p3', 'p4']);
    const oneMissing = toAllowedScores([
      { targetId: 'p2', score: 72 },
      { targetId: 'p3', score: 55 },
    ], allowed);
    expect(countScoreRepairs(oneMissing, 1, 0, allowed)).toBe(1);

    const outsiderAndMissing = toAllowedScores([
      { targetId: 'p2', score: 72 },
      { targetId: 'p3', score: 55 },
      { targetId: 'gm-secret', score: 100 },
    ], allowed);
    expect(countScoreRepairs(outsiderAndMissing, 0, 0, allowed)).toBe(1);
    expect(countScoreRepairs(outsiderAndMissing, 0, 1, allowed)).toBe(2);
  });

  it('複数候補の欠落と全空を補修上限超過として数えられる', () => {
    const allowed = new Set(['p2', 'p3', 'p4']);
    const oneScore = toAllowedScores([{ targetId: 'p2', score: 72 }], allowed);
    const noScores = toAllowedScores([], allowed);
    expect(countScoreRepairs(oneScore, 0, 0, allowed)).toBe(2);
    expect(countScoreRepairs(noScores, 0, 0, allowed)).toBe(3);
  });
});
