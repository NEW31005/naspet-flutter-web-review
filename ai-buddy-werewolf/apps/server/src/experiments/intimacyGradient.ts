import { decideWithTrust } from '@aibw/game-core';
import type { MatchRecord, PairId } from '@aibw/shared';

export const PROPOSAL_MODES = ['second', 'third', 'middle', 'last'] as const;

export type ProposalMode = (typeof PROPOSAL_MODES)[number];

export interface IntimacyScenarioSource {
  presetId: string;
  matchIndex: number;
  record: MatchRecord;
}

export interface IntimacyScenario {
  id: string;
  presetId: string;
  matchIndex: number;
  seed: string;
  day: number;
  eventSeq: number;
  pairId: PairId;
  baseScores: Record<PairId, number>;
}

export interface RankedProposal {
  proposalId: PairId;
  proposalScore: number;
  topId: PairId;
  topScore: number;
  baseGap: number;
}

export interface IntimacyGradientCell {
  mode: ProposalMode;
  maxBonus: number;
  intimacy: number;
  effectiveBonus: number;
  trials: number;
  reflectedCount: number;
  reflectedRate: number;
  reversalCount: number;
  reversalRate: number;
  nonObedienceCount: number;
  nonObedienceRate: number;
  averageBaseGap: number;
}

export interface IntimacyGradientGap {
  mode: ProposalMode;
  maxBonus: number;
  lowerIntimacy: number;
  upperIntimacy: number;
  reflectedRateLower: number;
  reflectedRateUpper: number;
  intimacyGapPoints: number;
  nonObedienceRateUpper: number;
}

export interface IntimacyGradientAnalysis {
  cells: IntimacyGradientCell[];
  gaps: IntimacyGradientGap[];
  usableScenariosByMode: Record<ProposalMode, number>;
}

const round = (value: number, digits = 6): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function rankedCandidates(
  scores: Record<PairId, number>,
): { pairId: PairId; score: number }[] {
  return Object.entries(scores)
    .map(([pairId, score]) => ({ pairId, score }))
    .sort((a, b) => b.score - a.score || a.pairId.localeCompare(b.pairId));
}

/**
 * AI自身の1位とは明確に点差がある候補だけを主人案にする。
 * 同点1位を「相違」と数えて親密度の効果を水増ししない。
 */
export function selectRankedProposal(
  scores: Record<PairId, number>,
  mode: ProposalMode,
): RankedProposal | null {
  const ranked = rankedCandidates(scores);
  const top = ranked[0];
  if (!top || ranked.length < 2) return null;

  const proposalIndex =
    mode === 'second'
      ? 1
      : mode === 'third'
        ? 2
        : mode === 'middle'
          ? Math.floor(ranked.length / 2)
          : ranked.length - 1;
  const proposal = ranked[proposalIndex];
  if (!proposal || proposal.score >= top.score) return null;

  return {
    proposalId: proposal.pairId,
    proposalScore: proposal.score,
    topId: top.pairId,
    topScore: top.score,
    baseGap: top.score - proposal.score,
  };
}

/** 試合イベントから、裁判時に実際に使われたAI基礎評価だけを抽出する。 */
export function extractIntimacyScenarios(
  sources: IntimacyScenarioSource[],
): IntimacyScenario[] {
  const scenarios: IntimacyScenario[] = [];
  for (const source of sources) {
    for (const event of source.record.events) {
      if (event.type !== 'vote_detail') continue;
      if (Object.keys(event.payload.baseScores).length < 2) continue;
      scenarios.push({
        id: `${source.presetId}:${source.matchIndex}:${source.record.seed}:d${event.day}:q${event.seq}:${event.payload.pairId}`,
        presetId: source.presetId,
        matchIndex: source.matchIndex,
        seed: source.record.seed,
        day: event.day,
        eventSeq: event.seq,
        pairId: event.payload.pairId,
        baseScores: { ...event.payload.baseScores },
      });
    }
  }
  return scenarios;
}

export function analyzeIntimacyGradient(params: {
  scenarios: IntimacyScenario[];
  maxBonuses: number[];
  intimacyLevels: number[];
  modes: ProposalMode[];
}): IntimacyGradientAnalysis {
  const maxBonuses = [...new Set(params.maxBonuses)].sort((a, b) => a - b);
  const intimacyLevels = [...new Set(params.intimacyLevels)].sort((a, b) => a - b);
  if (maxBonuses.length === 0) throw new Error('最大影響値が指定されていません');
  if (intimacyLevels.length < 2) throw new Error('親密度は2段階以上指定してください');
  if (maxBonuses.some((value) => value < 0 || value > 100)) {
    throw new Error('最大影響値は0〜100で指定してください');
  }
  if (intimacyLevels.some((value) => value < 0 || value > 100)) {
    throw new Error('親密度は0〜100で指定してください');
  }

  const cells: IntimacyGradientCell[] = [];
  const usableScenariosByMode = Object.fromEntries(
    PROPOSAL_MODES.map((mode) => [mode, 0]),
  ) as Record<ProposalMode, number>;

  for (const mode of params.modes) {
    const usable = params.scenarios.flatMap((scenario) => {
      const proposal = selectRankedProposal(scenario.baseScores, mode);
      return proposal ? [{ scenario, proposal }] : [];
    });
    usableScenariosByMode[mode] = usable.length;

    for (const maxBonus of maxBonuses) {
      for (const intimacy of intimacyLevels) {
        let reflectedCount = 0;
        let reversalCount = 0;
        let gapTotal = 0;

        for (const { scenario, proposal } of usable) {
          const candidates = Object.keys(scenario.baseScores);
          const rngLabels = ['intimacy-gradient', scenario.id, mode];
          const baseDecision = decideWithTrust({
            candidates,
            baseScores: scenario.baseScores,
            defaultScore: 50,
            masterProposalId: null,
            trust: intimacy,
            trustCfg: { type: 'linear', maxBonus },
            seed: scenario.seed,
            rngLabels,
          });
          const adjustedDecision = decideWithTrust({
            candidates,
            baseScores: scenario.baseScores,
            defaultScore: 50,
            masterProposalId: proposal.proposalId,
            trust: intimacy,
            trustCfg: { type: 'linear', maxBonus },
            seed: scenario.seed,
            rngLabels,
          });
          if (adjustedDecision.targetId === proposal.proposalId) reflectedCount++;
          if (adjustedDecision.targetId !== baseDecision.targetId) reversalCount++;
          gapTotal += proposal.baseGap;
        }

        const trials = usable.length;
        const reflectedRate = trials > 0 ? reflectedCount / trials : 0;
        const reversalRate = trials > 0 ? reversalCount / trials : 0;
        cells.push({
          mode,
          maxBonus,
          intimacy,
          effectiveBonus: round(maxBonus * (intimacy / 100), 4),
          trials,
          reflectedCount,
          reflectedRate: round(reflectedRate),
          reversalCount,
          reversalRate: round(reversalRate),
          nonObedienceCount: trials - reflectedCount,
          nonObedienceRate: round(1 - reflectedRate),
          averageBaseGap: trials > 0 ? round(gapTotal / trials, 3) : 0,
        });
      }
    }
  }

  const lowerIntimacy = intimacyLevels[0];
  const upperIntimacy = intimacyLevels.at(-1);
  if (lowerIntimacy == null || upperIntimacy == null) {
    throw new Error('親密度の比較範囲を決定できません');
  }
  const gaps: IntimacyGradientGap[] = [];
  for (const mode of params.modes) {
    for (const maxBonus of maxBonuses) {
      const lower = cells.find(
        (cell) =>
          cell.mode === mode &&
          cell.maxBonus === maxBonus &&
          cell.intimacy === lowerIntimacy,
      );
      const upper = cells.find(
        (cell) =>
          cell.mode === mode &&
          cell.maxBonus === maxBonus &&
          cell.intimacy === upperIntimacy,
      );
      if (!lower || !upper) throw new Error(`集計セルが不足しています: ${mode}/${maxBonus}`);
      gaps.push({
        mode,
        maxBonus,
        lowerIntimacy,
        upperIntimacy,
        reflectedRateLower: lower.reflectedRate,
        reflectedRateUpper: upper.reflectedRate,
        intimacyGapPoints: round((upper.reflectedRate - lower.reflectedRate) * 100, 1),
        nonObedienceRateUpper: upper.nonObedienceRate,
      });
    }
  }

  return { cells, gaps, usableScenariosByMode };
}
