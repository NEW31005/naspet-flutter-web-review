import { describe, expect, it } from 'vitest';
import {
  nextPlayPace,
  normalizePlayPace,
  playPaceDelay,
  playPaceLabel,
  timedMockBatchDelay,
} from '../src/playPace.js';

describe('試合の再生速度', () => {
  it('未設定や不正値は読みやすい標準速度にする', () => {
    expect(normalizePlayPace(null)).toBe('standard');
    expect(normalizePlayPace('unknown')).toBe('standard');
    expect(normalizePlayPace('fast')).toBe('fast');
  });

  it('速い・標準・ゆっくり・手動を順に切り替える', () => {
    expect(nextPlayPace('fast')).toBe('standard');
    expect(nextPlayPace('standard')).toBe('relaxed');
    expect(nextPlayPace('relaxed')).toBe('manual');
    expect(nextPlayPace('manual')).toBe('fast');
  });

  it('AI発言だけを選択速度で待ち、手動では自動進行しない', () => {
    expect(playPaceDelay('fast', true)).toBe(450);
    expect(playPaceDelay('standard', true)).toBe(1_800);
    expect(playPaceDelay('relaxed', true)).toBe(3_200);
    expect(playPaceDelay('relaxed', false)).toBe(450);
    expect(playPaceDelay('manual', true)).toBeNull();
  });

  it('内部値ではなく日本語表示名を返す', () => {
    expect(playPaceLabel('standard')).toBe('標準');
    expect(playPaceLabel('manual')).toBe('手動');
  });

  it('生成が一瞬のモック自由討論は150秒を読める間隔で刻む', () => {
    expect(timedMockBatchDelay('fast')).toBe(2_000);
    expect(timedMockBatchDelay('standard')).toBe(6_500);
    expect(timedMockBatchDelay('relaxed')).toBe(10_000);
    expect(timedMockBatchDelay('manual')).toBeNull();
  });
});
