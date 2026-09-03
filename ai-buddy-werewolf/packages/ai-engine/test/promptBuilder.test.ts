import { describe, expect, it } from 'vitest';
import type { PublicLogEntry } from '@aibw/game-core';
import { renderEvalPublicLog, renderQuestionThemes } from '../src/promptBuilder.js';

describe('renderEvalPublicLog', () => {
  it('恒久的な公開事実を残し、発言だけを直近24件へ圧縮する', () => {
    const oldVote: PublicLogEntry = {
      seq: 1,
      day: 1,
      t: 'vote',
      pairId: 'p1',
      name: 'ミナ',
      targetId: 'p2',
      targetName: 'レン',
    };
    const speeches: PublicLogEntry[] = Array.from({ length: 30 }, (_, index) => ({
      seq: index + 2,
      day: 2,
      t: 'speech' as const,
      round: 2,
      turnKind: 'reaction' as const,
      pairId: `p${index % 5 + 1}`,
      name: `話者${index + 1}`,
      text: `発言${index + 1}`,
      accusesId: null,
    }));

    const rendered = renderEvalPublicLog([oldVote, ...speeches]);

    expect(rendered).toContain('[投票] ミナ → レン');
    expect(rendered).not.toContain('話者6: 発言6');
    expect(rendered).toContain('話者7: 発言7');
    expect(rendered).toContain('話者30: 発言30');
  });
});

describe('renderQuestionThemes', () => {
  it('外部設定から渡されたテーマだけをプロンプト用に列挙する', () => {
    expect(renderQuestionThemes([
      { id: 'custom_reason', label: '独自の理由を聞く' },
      { id: 'most_suspicious', label: '現在最も疑っている相手' },
    ])).toBe('- custom_reason: 独自の理由を聞く\n- most_suspicious: 現在最も疑っている相手');
  });
});
