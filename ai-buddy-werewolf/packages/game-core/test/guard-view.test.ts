import { describe, expect, it } from 'vitest';
import type { MatchEvent } from '@aibw/shared';
import { buildMasterView, createMatch, reduce } from '../src/index.js';
import { makeSnapshot } from './fixtures.js';

const NOW = 1_700_000_000_000;

describe('騎士の主人向け個別結果', () => {
  it('主人の提案とバディの最終護衛先を、本人の画面だけへ返す', () => {
    let state = createMatch({
      matchId: 'guard-master-view',
      seed: 'guard-master-view',
      mode: 'play',
      provider: 'mock',
      humanPairIndex: 0,
      config: makeSnapshot({
        pairCount: 5,
        roleSetup: { werewolf: 1, seer: 0, guardian: 1, medium: 0 },
      }),
      now: NOW,
    }).state;
    const guardian = state.pairs.find((pair) => pair.role === 'guardian');
    if (!guardian) throw new Error('騎士が配役されていません');
    const [proposal, final] = state.pairs.filter(
      (pair) => pair.pairId !== guardian.pairId,
    );
    if (!proposal || !final) throw new Error('護衛候補が不足しています');

    const event: MatchEvent = {
      seq: state.nextSeq,
      ts: NOW,
      day: 1,
      phase: 'night',
      visibility: { kind: 'pairs', pairIds: [guardian.pairId], part: 'both' },
      type: 'guard_resolved',
      payload: {
        guardianPairId: guardian.pairId,
        masterProposalId: proposal.pairId,
        targetId: final.pairId,
      },
    };
    state = reduce(state, event);

    expect(buildMasterView(state, guardian.pairId).me?.guardReports).toEqual([
      {
        day: 1,
        proposalName: proposal.buddyName,
        finalName: final.buddyName,
      },
    ]);
    expect(buildMasterView(state, proposal.pairId).me?.guardReports).toEqual([]);
  });
});
