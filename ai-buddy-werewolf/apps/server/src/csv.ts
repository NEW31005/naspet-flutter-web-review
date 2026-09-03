/** 主要指標のCSV書き出し(解析ツール向け) */
import type { MatchRecord } from '@aibw/shared';
import { buildReplayData, rebuildState } from '@aibw/game-core';

function esc(v: unknown): string {
  const s = v == null ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
}

/** 評価スナップショットの時系列(怪しい度・襲撃優先度の推移) */
export function evalsCsv(record: MatchRecord): string {
  const state = rebuildState(record.events, record.configSnapshot);
  const replay = buildReplayData(state, record.events);
  const rows: unknown[][] = [
    [
      'matchId',
      'seq',
      'day',
      'phase',
      'kind',
      'pairId',
      'pairName',
      'targetId',
      'suspicion',
      'attackPriority',
      'skillPriority',
      'confidence',
    ],
  ];
  for (const e of replay.evalTimeline) {
    const targets = new Set([
      ...Object.keys(e.output.suspicions),
      ...Object.keys(e.output.attackPriorities ?? {}),
      ...Object.keys(e.output.skillTargetPriorities ?? {}),
    ]);
    for (const t of targets) {
      rows.push([
        record.matchId,
        e.seq,
        e.day,
        e.phase,
        e.kind,
        e.pairId,
        e.pairName,
        t,
        e.output.suspicions[t] ?? '',
        e.output.attackPriorities?.[t] ?? '',
        e.output.skillTargetPriorities?.[t] ?? '',
        e.output.confidence,
      ]);
    }
  }
  return toCsv(rows);
}

/** AIコールの原価・レイテンシー一覧 */
export function callsCsv(record: MatchRecord): string {
  const rows: unknown[][] = [
    [
      'matchId',
      'id',
      'ts',
      'pairId',
      'callType',
      'evalKind',
      'provider',
      'model',
      'latencyMs',
      'inputTokens',
      'outputTokens',
      'costUsd',
      'retries',
      'jsonErrors',
      'ok',
      'usedFallback',
      'error',
    ],
  ];
  for (const c of record.aiCalls) {
    rows.push([
      record.matchId,
      c.id,
      c.ts,
      c.pairId,
      c.callType,
      c.evalKind ?? '',
      c.provider,
      c.model,
      c.latencyMs,
      c.inputTokens,
      c.outputTokens,
      c.costUsd,
      c.retries,
      c.jsonErrors,
      c.ok,
      c.usedFallback,
      c.error ?? '',
    ]);
  }
  return toCsv(rows);
}
