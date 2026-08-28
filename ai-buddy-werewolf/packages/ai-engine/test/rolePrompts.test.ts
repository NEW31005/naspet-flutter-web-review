import { describe, expect, it } from 'vitest';
import { buildBuddyContext, createMatch } from '@aibw/game-core';
import { buildEvalPrompt, buildSpeechPrompt, renderPublicLog } from '../src/promptBuilder.js';
import { makeSnapshot, testPrompts } from './fixtures.js';

const roleTestPrompts = {
  ...testPrompts,
  evalTemplate: '{{factsBlock}}\n{{attackPrioritiesHint}}\n{{skillPrioritiesHint}}\n{{analysisLensBlock}}',
};

function contextFor(role: 'guardian' | 'medium' | 'werewolf') {
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
    const ctx = contextFor('guardian');
    ctx.matchInfo.phase = 'night';
    const prompt = buildEvalPrompt(ctx, roleTestPrompts);
    expect(prompt.system).toContain('guardian');
    expect(prompt.user).toContain('今夜護衛したい優先度');
    expect(prompt.user).toContain('自分自身');
  });

  it('討論中は夜専用の優先度配列を空にして出力量を抑える', () => {
    const prompt = buildEvalPrompt(contextFor('guardian'), roleTestPrompts);
    expect(prompt.user).toContain('討論・裁判では評価し直さず空配列');
    expect(prompt.user).not.toContain('今夜護衛したい優先度');
  });

  it('狼の裁判評価は、AI主人の夜提案に使う襲撃優先度を更新する', () => {
    const ctx = contextFor('werewolf');
    ctx.matchInfo.phase = 'trial';
    const prompt = buildEvalPrompt(ctx, roleTestPrompts);
    expect(prompt.user).toContain('次の夜に襲撃したい優先度');
    expect(prompt.user).toContain('討論・裁判でも更新');
  });

  it('夜評価へ討論の観察レンズを混ぜず、試合シードごとにレンズを回転する', () => {
    const night = contextFor('guardian');
    night.matchInfo.phase = 'night';
    expect(buildEvalPrompt(night, roleTestPrompts).user).toContain(
      '夜フェーズでは討論の観察担当を置かず',
    );

    const rotations = new Set<number>();
    for (const seed of Array.from({ length: 12 }, (_, index) => `lens-seed-${index}`)) {
      const config = makeSnapshot({
        pairCount: 9,
        roleSetup: { werewolf: 2, seer: 1, guardian: 1, medium: 1 },
      });
      const first = createMatch({
        matchId: `lens-${seed}`,
        seed,
        mode: 'lab',
        provider: 'mock',
        humanPairIndex: null,
        config,
        now: 1_700_000_000_000,
      }).state;
      const p1 = buildBuddyContext(first, 'p1');
      const p2 = buildBuddyContext(first, 'p2');
      expect(p1.matchInfo.analysisLensRotation).toBe(p2.matchInfo.analysisLensRotation);
      expect(buildBuddyContext(first, 'p1').matchInfo.analysisLensRotation).toBe(
        p1.matchInfo.analysisLensRotation,
      );
      rotations.add(p1.matchInfo.analysisLensRotation);
    }
    expect(rotations.size).toBeGreaterThan(1);
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

  it('発言プロンプトは質問テーマIDを自然な日本語へ変換する', () => {
    const ctx = contextFor('medium');
    ctx.questionThemes.push({ id: 'most_suspicious', label: '現在最も疑っている相手' });
    const target = ctx.candidates[0];
    if (!target) throw new Error('質問対象がいません');
    const prompts = {
      ...roleTestPrompts,
      speechTemplate: '{{questionPlan}}\n{{analysisLensBlock}}\n{{echoGuardBlock}}\n{{verbosityHint}}',
    };
    const speech = buildSpeechPrompt(ctx, {
      suspicions: {},
      primaryHypothesis: '短い仮説',
      altHypotheses: [],
      confidence: 40,
      toShare: [],
      toWithhold: [],
      questionTargetId: target.pairId,
      questionTheme: 'most_suspicious',
      voteCandidateId: target.pairId,
      reasonSummary: '理由',
    }, prompts);
    expect(speech.user).toContain('現在最も疑っている相手');
    expect(speech.user).not.toContain('most_suspicious');
    expect(speech.user).toMatch(/30〜65|45〜85|55〜95/);
  });
});
