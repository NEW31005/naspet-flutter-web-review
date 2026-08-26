import { describe, expect, it } from 'vitest';
import { isCompletedVoteMismatch } from '../src/voteComparison.js';

describe('主人選択とバディ投票の比較表示', () => {
  it('バディの投票が未確定の間は不一致と表示しない', () => {
    expect(isCompletedVoteMismatch('p2', undefined)).toBe(false);
    expect(isCompletedVoteMismatch('p2', null)).toBe(false);
  });

  it('投票確定後だけ一致・不一致を判定する', () => {
    expect(isCompletedVoteMismatch('p2', 'p2')).toBe(false);
    expect(isCompletedVoteMismatch('p2', 'p3')).toBe(true);
  });
});
