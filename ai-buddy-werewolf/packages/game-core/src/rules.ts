/**
 * 純粋なルール計算。
 * - 信頼度補正関数(登録制。設定で type を切り替え、コードで関数を追加できる)
 * - 最終投票の決定(AIの評価 + 主人の意思表示の補正)
 * - 狼襲撃候補の統合
 * - 同票処理・勝敗判定
 */
import type { PairId, TrustFnConfig, Winner } from '@aibw/shared';
import { pickOne } from '@aibw/shared';
import { aliveCitizens, aliveWolves, type MatchState } from './state.js';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type TrustFn = (trust: number, cfg: TrustFnConfig) => number;

/**
 * 信頼度補正関数の登録簿。
 * 新しい補正方式を足すときはここへ追加し、設定ファイルの type で選ぶ。
 */
const TRUST_FUNCTIONS: Record<TrustFnConfig['type'], TrustFn> = {
  none: () => 0,
  linear: (trust, cfg) => cfg.maxBonus * (clamp(trust, 0, 100) / 100),
  quadratic: (trust, cfg) => cfg.maxBonus * (clamp(trust, 0, 100) / 100) ** 2,
};

/**
 * 主人の提案に対する加算ボーナスを返す。
 * 信頼度100でも maxBonus までしか加算されない = 100%服従にはならない。
 * 確定情報はこの関数を通さない(事実として扱う)。
 */
export function trustBonus(trust: number, cfg: TrustFnConfig): number {
  const fn = TRUST_FUNCTIONS[cfg.type];
  if (!fn) throw new Error(`unknown trust function: ${cfg.type}`);
  return fn(trust, cfg);
}

export interface ScoredDecision {
  targetId: PairId | null;
  baseScores: Record<PairId, number>;
  adjustedScores: Record<PairId, number>;
  bonusApplied: number;
  tie: boolean;
}

/** スコア最大の候補を選ぶ。同点はシード付きランダム。 */
export function argmaxWithTie(
  scores: Record<PairId, number>,
  seed: string,
  labels: (string | number)[],
): { targetId: PairId | null; tie: boolean } {
  const entries = Object.entries(scores);
  if (entries.length === 0) return { targetId: null, tie: false };
  const max = Math.max(...entries.map(([, v]) => v));
  const top = entries
    .filter(([, v]) => v === max)
    .map(([k]) => k)
    .sort();
  if (top.length === 1) return { targetId: top[0] ?? null, tie: false };
  return { targetId: pickOne(top, seed, ...labels), tie: true };
}

/**
 * AIの基礎スコアに主人の提案(1件)の信頼度補正を加えて対象を決める。
 * 裁判投票・夜襲の第一候補・占い先の決定で共通利用。
 */
export function decideWithTrust(params: {
  candidates: PairId[];
  baseScores: Record<PairId, number>;
  defaultScore: number;
  masterProposalId: PairId | null;
  trust: number;
  trustCfg: TrustFnConfig;
  seed: string;
  rngLabels: (string | number)[];
}): ScoredDecision {
  const base: Record<PairId, number> = {};
  for (const c of params.candidates) {
    base[c] = clamp(params.baseScores[c] ?? params.defaultScore, 0, 100);
  }
  const adjusted: Record<PairId, number> = { ...base };
  let bonus = 0;
  if (
    params.masterProposalId &&
    Object.prototype.hasOwnProperty.call(adjusted, params.masterProposalId)
  ) {
    bonus = trustBonus(params.trust, params.trustCfg);
    adjusted[params.masterProposalId] = (adjusted[params.masterProposalId] ?? 0) + bonus;
  }
  const { targetId, tie } = argmaxWithTie(adjusted, params.seed, params.rngLabels);
  return { targetId, baseScores: base, adjustedScores: adjusted, bonusApplied: bonus, tie };
}

/** 投票集計。過半数ではなく最多得票(同数はシード付きランダム)。 */
export function tallyVotes(
  votes: { pairId: PairId; targetId: PairId }[],
  seed: string,
  labels: (string | number)[],
): { targetId: PairId | null; tally: Record<PairId, number>; tie: boolean } {
  const tally: Record<PairId, number> = {};
  for (const v of votes) tally[v.targetId] = (tally[v.targetId] ?? 0) + 1;
  const { targetId, tie } = argmaxWithTie(tally, seed, labels);
  return { targetId, tally, tie };
}

/**
 * 複数狼の襲撃候補統合。
 * sumNormalized: 各狼の補正後優先度を正規化(合計1)して候補ごとに合算し、最大を選ぶ。
 */
export function integrateAttack(params: {
  method: 'sumNormalized';
  candidates: PairId[];
  perWolf: { pairId: PairId; adjustedScores: Record<PairId, number> }[];
  seed: string;
  rngLabels: (string | number)[];
}): { targetId: PairId | null; integrated: Record<PairId, number>; tie: boolean } {
  const integrated: Record<PairId, number> = {};
  for (const c of params.candidates) integrated[c] = 0;
  for (const wolf of params.perWolf) {
    const sum = params.candidates.reduce((acc, c) => acc + (wolf.adjustedScores[c] ?? 0), 0);
    for (const c of params.candidates) {
      const raw = wolf.adjustedScores[c] ?? 0;
      const normalized = sum > 0 ? raw / sum : 1 / params.candidates.length;
      integrated[c] = (integrated[c] ?? 0) + normalized;
    }
  }
  // 浮動小数の誤差で同点判定が壊れないよう丸める
  for (const c of params.candidates) {
    integrated[c] = Math.round((integrated[c] ?? 0) * 1e9) / 1e9;
  }
  const { targetId, tie } = argmaxWithTie(integrated, params.seed, params.rngLabels);
  return { targetId, integrated, tie };
}

/** 勝敗判定。市民=狼全滅で勝利、狼=狼数が市民側人数以上で勝利。 */
export function checkWin(state: MatchState): { winner: Winner; reason: string } | null {
  const wolves = aliveWolves(state).length;
  const citizens = aliveCitizens(state).length;
  if (wolves === 0) {
    return { winner: 'citizens', reason: '狼憑きが全滅した' };
  }
  if (wolves >= citizens) {
    return { winner: 'wolves', reason: '狼の数が市民側の人数以上になった' };
  }
  return null;
}
