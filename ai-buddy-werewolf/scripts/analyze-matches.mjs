#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function usage() {
  return [
    'Usage: node scripts/analyze-matches.mjs [options]',
    '',
    'Options:',
    '  --seed-prefix <prefix>  乱数シードの前方一致で絞り込む',
    '  --preset <presetId>     rules.presetId の完全一致で絞り込む',
    '  --format <text|json>    出力形式（既定: text）',
    '  --json                  --format json の短縮形',
    '  --data-dir <path>       試合JSONの保存先（既定: data/matches）',
    '  --help                  この説明を表示する',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    dataDir: path.resolve('data', 'matches'),
    format: 'text',
    preset: undefined,
    seedPrefix: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      options.help = true;
    } else if (arg === '--json') {
      options.format = 'json';
    } else if (arg === '--seed-prefix' || arg === '--preset' || arg === '--format' || arg === '--data-dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} には値が必要です`);
      }
      index += 1;
      if (arg === '--seed-prefix') options.seedPrefix = value;
      if (arg === '--preset') options.preset = value;
      if (arg === '--format') options.format = value;
      if (arg === '--data-dir') options.dataDir = path.resolve(value);
    } else {
      throw new Error(`不明な引数です: ${arg}`);
    }
  }

  if (options.format !== 'text' && options.format !== 'json') {
    throw new Error('--format は text または json を指定してください');
  }
  return options;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function percentage(numerator, denominator) {
  return denominator === 0 ? null : round((numerator / denominator) * 100, 1);
}

function average(total, count) {
  return count === 0 ? 0 : round(total / count, 2);
}

function eventPayload(event) {
  return isObject(event) && isObject(event.payload) ? event.payload : {};
}

function analyze(records, filters, source) {
  const wins = { citizens: 0, wolves: 0, draw: 0, unknown: 0 };
  const turnKinds = new Map();
  const uniqueTexts = new Set();
  let totalDays = 0;
  let totalSpeeches = 0;
  let structuredAccusations = 0;
  let totalAiCalls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let focusExecutionMatches = 0;
  let focusExecutionEligibleMatches = 0;
  let factShareAdviceCount = 0;
  let factSharedCount = 0;

  for (const record of records) {
    const events = Array.isArray(record.events) ? record.events : [];
    const calls = Array.isArray(record.aiCalls) ? record.aiCalls : [];
    const finishEvent = [...events].reverse().find((event) => event?.type === 'match_finished');
    const winner = eventPayload(finishEvent).winner;
    if (winner === 'citizens' || winner === 'wolves' || winner === 'draw') {
      wins[winner] += 1;
    } else {
      wins.unknown += 1;
    }

    const finishedDay = Number(finishEvent?.day);
    if (Number.isFinite(finishedDay)) {
      totalDays += finishedDay;
    } else {
      totalDays += events.reduce((maxDay, event) => {
        const day = Number(event?.day);
        return Number.isFinite(day) ? Math.max(maxDay, day) : maxDay;
      }, 0);
    }

    const focusPairIds = new Set();
    let dayOneExecutionTarget;
    for (const event of events) {
      const payload = eventPayload(event);
      if (event?.type === 'speech') {
        totalSpeeches += 1;
        const turnKind = typeof payload.turnKind === 'string' ? payload.turnKind : 'unknown';
        turnKinds.set(turnKind, (turnKinds.get(turnKind) ?? 0) + 1);
        if (typeof payload.accusesId === 'string' && payload.accusesId.length > 0) {
          structuredAccusations += 1;
        }
        if (typeof payload.text === 'string') uniqueTexts.add(payload.text.trim());
        if (event.day === 1 && turnKind === 'opening_defense' && typeof payload.pairId === 'string') {
          focusPairIds.add(payload.pairId);
        }
      }
      if (event?.type === 'execution' && event.day === 1 && dayOneExecutionTarget === undefined) {
        dayOneExecutionTarget = payload.targetId;
      }
      if (event?.type === 'advice_given' && isObject(payload.advice) && payload.advice.kind === 'fact_share') {
        factShareAdviceCount += 1;
      }
      if (event?.type === 'fact_shared') factSharedCount += 1;
    }

    if (focusPairIds.size > 0 && typeof dayOneExecutionTarget === 'string') {
      focusExecutionEligibleMatches += 1;
      if (focusPairIds.has(dayOneExecutionTarget)) focusExecutionMatches += 1;
    }

    totalAiCalls += calls.length;
    for (const call of calls) {
      totalInputTokens += Number(call?.inputTokens) || 0;
      totalOutputTokens += Number(call?.outputTokens) || 0;
      totalCostUsd += Number(call?.costUsd) || 0;
    }
  }

  const matchCount = records.length;
  return {
    schemaVersion: 1,
    filters: {
      seedPrefix: filters.seedPrefix ?? null,
      preset: filters.preset ?? null,
    },
    source: {
      dataDir: source.dataDir,
      jsonFilesRead: source.jsonFilesRead,
      invalidJsonFiles: source.invalidJsonFiles,
    },
    matches: matchCount,
    wins: {
      ...wins,
      citizensPercent: percentage(wins.citizens, matchCount),
      wolvesPercent: percentage(wins.wolves, matchCount),
      drawPercent: percentage(wins.draw, matchCount),
    },
    averages: {
      days: average(totalDays, matchCount),
      speechesPerMatch: average(totalSpeeches, matchCount),
      aiCallsPerMatch: average(totalAiCalls, matchCount),
      estimatedCostUsdPerMatch: matchCount === 0 ? 0 : round(totalCostUsd / matchCount, 6),
    },
    totals: {
      speeches: totalSpeeches,
      aiCalls: totalAiCalls,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      estimatedCostUsd: round(totalCostUsd, 6),
    },
    turnKinds: Object.fromEntries([...turnKinds.entries()].sort(([a], [b]) => a.localeCompare(b))),
    structuredAccusations: {
      count: structuredAccusations,
      denominator: totalSpeeches,
      percent: percentage(structuredAccusations, totalSpeeches),
    },
    exactTextUniqueness: {
      uniqueCount: uniqueTexts.size,
      denominator: totalSpeeches,
      percent: percentage(uniqueTexts.size, totalSpeeches),
      note: '前後空白を除いた発言全文の完全一致で集計',
    },
    firstDayFocusExecution: {
      matches: focusExecutionMatches,
      eligibleMatches: focusExecutionEligibleMatches,
      percent: percentage(focusExecutionMatches, focusExecutionEligibleMatches),
      note: '初日のopening_defense話者をfocus対象として復元',
    },
    facts: {
      factShareAdvice: factShareAdviceCount,
      factShared: factSharedCount,
    },
  };
}

function formatPercent(value) {
  return value === null ? '対象なし' : `${value.toFixed(1)}%`;
}

function formatText(result) {
  const lines = [
    'AIバディ人狼 試合集計',
    `対象: ${result.matches}試合（seed前方一致: ${result.filters.seedPrefix ?? '指定なし'} / preset: ${result.filters.preset ?? '指定なし'}）`,
    `勝敗: 市民 ${result.wins.citizens} (${formatPercent(result.wins.citizensPercent)}) / 狼 ${result.wins.wolves} (${formatPercent(result.wins.wolvesPercent)}) / 引分 ${result.wins.draw} (${formatPercent(result.wins.drawPercent)})${result.wins.unknown > 0 ? ` / 不明 ${result.wins.unknown}` : ''}`,
    `平均: ${result.averages.days.toFixed(2)}日 / 発言 ${result.averages.speechesPerMatch.toFixed(2)}件 / AIコール ${result.averages.aiCallsPerMatch.toFixed(2)}件`,
    `推定原価: 合計 $${result.totals.estimatedCostUsd.toFixed(6)} / 1試合平均 $${result.averages.estimatedCostUsdPerMatch.toFixed(6)}`,
    `トークン: 入力 ${result.totals.inputTokens.toLocaleString('ja-JP')} / 出力 ${result.totals.outputTokens.toLocaleString('ja-JP')}`,
    `構造化告発: ${result.structuredAccusations.count}/${result.structuredAccusations.denominator} (${formatPercent(result.structuredAccusations.percent)})`,
    `完全一致文面ユニーク率: ${result.exactTextUniqueness.uniqueCount}/${result.exactTextUniqueness.denominator} (${formatPercent(result.exactTextUniqueness.percent)})`,
    `初日focus対象処刑: ${result.firstDayFocusExecution.matches}/${result.firstDayFocusExecution.eligibleMatches}試合 (${formatPercent(result.firstDayFocusExecution.percent)})`,
    `確定情報: fact_share助言 ${result.facts.factShareAdvice}件 / fact_shared成立 ${result.facts.factShared}件`,
    '発言種別:',
  ];
  for (const [kind, count] of Object.entries(result.turnKinds)) {
    lines.push(`  - ${kind}: ${count}`);
  }
  if (result.source.invalidJsonFiles.length > 0) {
    lines.push(`注意: 読み込めなかったJSON ${result.source.invalidJsonFiles.length}件`);
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const names = (await readdir(options.dataDir)).filter((name) => name.endsWith('.json')).sort();
  const records = [];
  const invalidJsonFiles = [];
  for (const name of names) {
    try {
      const record = JSON.parse(await readFile(path.join(options.dataDir, name), 'utf8'));
      if (!isObject(record)) continue;
      if (options.seedPrefix && (typeof record.seed !== 'string' || !record.seed.startsWith(options.seedPrefix))) continue;
      const presetId = record.configSnapshot?.rules?.presetId;
      if (options.preset && presetId !== options.preset) continue;
      records.push(record);
    } catch (error) {
      invalidJsonFiles.push({
        file: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (records.length === 0) {
    throw new Error('指定した条件に一致する試合JSONがありません');
  }

  const result = analyze(records, options, {
    dataDir: options.dataDir,
    jsonFilesRead: names.length,
    invalidJsonFiles,
  });
  const output = options.format === 'json' ? JSON.stringify(result, null, 2) : formatText(result);
  process.stdout.write(`${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`分析に失敗しました: ${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 1;
});
