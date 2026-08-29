import type { MatchRecord } from '@aibw/shared';
import { buildReplayData, rebuildState } from '@aibw/game-core';

const esc = (value: unknown): string => {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const rowsToCsv = (rows: unknown[][]): string =>
  `${rows.map((row) => row.map(esc).join(',')).join('\n')}\n`;

export function evalsCsv(record: MatchRecord): string {
  const state = rebuildState(record.events, record.configSnapshot);
  const replay = buildReplayData(state, record.events);
  const rows: unknown[][] = [[
    'matchId', 'seq', 'day', 'phase', 'kind', 'pairId', 'pairName', 'targetId',
    'suspicion', 'attackPriority', 'skillPriority', 'confidence',
  ]];
  for (const item of replay.evalTimeline) {
    const targets = new Set([
      ...Object.keys(item.output.suspicions),
      ...Object.keys(item.output.attackPriorities ?? {}),
      ...Object.keys(item.output.skillTargetPriorities ?? {}),
    ]);
    for (const target of targets) {
      rows.push([
        record.matchId, item.seq, item.day, item.phase, item.kind, item.pairId,
        item.pairName, target, item.output.suspicions[target] ?? '',
        item.output.attackPriorities?.[target] ?? '',
        item.output.skillTargetPriorities?.[target] ?? '', item.output.confidence,
      ]);
    }
  }
  return rowsToCsv(rows);
}

export function callsCsv(record: MatchRecord): string {
  const rows: unknown[][] = [[
    'matchId', 'id', 'ts', 'pairId', 'callType', 'evalKind', 'provider', 'model',
    'latencyMs', 'inputTokens', 'outputTokens', 'costUsd', 'retries', 'jsonErrors',
    'validationRepairs', 'ok', 'usedFallback', 'error',
  ]];
  for (const call of record.aiCalls) {
    rows.push([
      record.matchId, call.id, call.ts, call.pairId, call.callType, call.evalKind ?? '',
      call.provider, call.model, call.latencyMs, call.inputTokens, call.outputTokens,
      call.costUsd, call.retries, call.jsonErrors, call.validationRepairs ?? 0,
      call.ok, call.usedFallback,
      call.error ?? '',
    ]);
  }
  return rowsToCsv(rows);
}
