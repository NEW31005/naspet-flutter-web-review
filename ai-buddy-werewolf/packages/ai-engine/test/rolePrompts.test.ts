import { describe, expect, it } from 'vitest';
import { buildBuddyContext, createMatch } from '@aibw/game-core';
import { buildEvalPrompt, renderPublicLog } from '../src/promptBuilder.js';
import { makeSnapshot, testPrompts } from './fixtures.js';

const roleTestPrompts = {
  ...testPrompts,
  evalTemplate: '{{factsBlock}}\n{{skillPrioritiesHint}}',
};

function contextFor(role: 'guardian' | 'medium') {
  const config = makeSnapshot({
    pairCount: 9,
    roleSetup: { werewolf: 2, seer: 1, guardian: 1, medium: 1 },
  });
  const { state } = createMatch({
    matchId: `prompt-${role}`,
    seed: `prompt-${role}`,
    mode: 'lab',
    provider: 'mock',
    humanPairIndex: null,
    config,
    now: 1_700_000_000_000,
  });
  const pair = state.pairs.find((candidate) => candidate.role === role);
  if (!pair) throw new Error(`${role}が配布されていません`);
  return buildBuddyContext(state, pair.pairId);
}

describe('追加役職のプロンプト', () => {
  it('騎士へ護衛優先度と自己・連続護衛禁止を伝える', () => {
    const prompt = buildEvalPrompt(contextFor('guardian'), roleTestPrompts);
    expect(prompt.system).toContain('guardian');
    expect(prompt.user).toContain('今夜護衛したい優先度');
    expect(prompt.user).toContain('自分自身');
  });

  it('霊媒の共有済みFactを占いではなく霊媒結果と明示する', () => {
    const ctx = contextFor('medium');
    const target = ctx.candidates[0];
    if (!target) throw new Error('霊媒結果の対象がいません');
    ctx.sharedFacts.push({
      id: 'medium-fact',
      day: 1,
      targetId: target.pairId,
      isWolf: false,
      source: 'medium',
    });
    const prompt = buildEvalPrompt(ctx, roleTestPrompts);
    expect(prompt.system).toContain('medium');
    expect(prompt.user).toContain('1日目の霊媒');
  });

  it('護衛成功を明かさず、公開ログには犠牲者なしだけを表現する', () => {
    const rendered = renderPublicLog([
      { seq: 1, day: 2, t: 'day_start', deaths: [] },
    ]);
    expect(rendered).toContain('昨夜の犠牲者はいなかった');
    expect(rendered).not.toContain('護衛');
    expect(rendered).not.toContain('騎士');
  });
});
