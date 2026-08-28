import { describe, expect, it } from 'vitest';
import { describeAdvice } from '../src/screens/Result.js';

const nameOf = (id: string | null) => id ?? '—';

describe('役職を名乗る相談の日本語表示', () => {
  it('別役職として名乗る相談を専門用語なしで説明する', () => {
    expect(describeAdvice({ kind: 'role_claim', claimedRole: 'medium' }, nameOf)).toBe(
      '役職を名乗る相談 → 霊媒師として名乗ってほしい',
    );
  });

  it('今日は名乗らない相談を、相談なしと区別して説明する', () => {
    expect(describeAdvice({ kind: 'role_claim', claimedRole: null }, nameOf)).toBe(
      '役職を名乗る相談 → 今日はまだ名乗らないでほしい',
    );
  });

  it('役職を名乗る予定への質問で内部IDを見せない', () => {
    const text = describeAdvice(
      { kind: 'question', targetId: 'p2', themeId: 'co_plan' },
      nameOf,
    );
    expect(text).toContain('役職を名乗る予定があるか');
    expect(text).not.toContain('co_plan');
  });
});
