/**
 * 親密度勾配の再現実験。
 * モック試合の実AI裁判評価を固定し、主人案・親密度・最大影響値だけを差し替える。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MatchRecord } from '@aibw/shared';
import {
  PROPOSAL_MODES,
  analyzeIntimacyGradient,
  extractIntimacyScenarios,
  type IntimacyScenarioSource,
  type ProposalMode,
} from '../experiments/intimacyGradient.js';
import { loadConfig } from '../configLoader.js';
import { MatchManager } from '../matches.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..', '..', '..', '..');

interface PresetPlan {
  presetId: string;
  matches: number;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function parseNumberList(value: string, label: string): number[] {
  const numbers = value.split(',').map((part) => Number(part.trim()));
  if (numbers.length === 0 || numbers.some((number) => !Number.isFinite(number))) {
    throw new Error(`${label}はカンマ区切りの数値で指定してください`);
  }
  return numbers;
}

function parsePlan(value: string): PresetPlan[] {
  return value.split(',').map((entry) => {
    const [presetId, matchesText] = entry.split(':');
    const matches = Number(matchesText);
    if (!presetId || !Number.isInteger(matches) || matches < 1) {
      throw new Error(`試合計画が不正です: ${entry}`);
    }
    return { presetId, matches };
  });
}

function parseModes(value: string): ProposalMode[] {
  const modes = value.split(',').map((entry) => {
    const mode = entry.trim();
    if (!PROPOSAL_MODES.some((candidate) => candidate === mode)) {
      throw new Error(`主人案モードが不正です: ${mode}`);
    }
    return mode as ProposalMode;
  });
  return [...new Set(modes)];
}

async function runMockSources(params: {
  plan: PresetPlan[];
  baseSeed: string;
  tempDataDir: string;
}): Promise<{ sources: IntimacyScenarioSource[]; totalCalls: number }> {
  let clock = 1_700_000_000_000;
  const manager = new MatchManager(rootDir, () => clock++, params.tempDataDir);
  const sources: IntimacyScenarioSource[] = [];
  let totalCalls = 0;

  for (const item of params.plan) {
    for (let matchIndex = 1; matchIndex <= item.matches; matchIndex++) {
      const seed = `${params.baseSeed}:${item.presetId}:${matchIndex}`;
      const summary = manager.createMatch({
        presetId: item.presetId,
        mode: 'lab',
        provider: 'mock',
        seed,
      });
      let result: Awaited<ReturnType<typeof manager.advance>> = {
        status: 'progressed',
        task: 'start',
      };
      for (let step = 0; step < 1000 && result.status === 'progressed'; step++) {
        result = await manager.advance(summary.matchId);
      }
      await manager.flush(summary.matchId);
      if (result.status !== 'finished') {
        throw new Error(`${item.presetId} #${matchIndex} が完走しませんでした: ${result.status}`);
      }
      const record: MatchRecord = structuredClone(manager.getRecord(summary.matchId));
      totalCalls += record.aiCalls.length;
      sources.push({ presetId: item.presetId, matchIndex, record });
      manager.deleteMatch(summary.matchId);
      console.log(
        `[intimacy] ${item.presetId} ${matchIndex}/${item.matches} 完走 (${record.aiCalls.length} calls)`,
      );
    }
  }

  return { sources, totalCalls };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const plan = parsePlan(args.plan ?? 'quick-test:12,quick-info:20,pack-test:10');
  const baseSeed = args.seed ?? 'intimacy-gradient-v1';
  const maxBonuses = parseNumberList(args['max-bonuses'] ?? '20,25,32,40', '最大影響値');
  const intimacyLevels = parseNumberList(args.intimacies ?? '50,80', '親密度');
  const modes = parseModes(args.modes ?? PROPOSAL_MODES.join(','));
  const outputArg = args.output ?? 'docs/experiments/intimacy-gradient-v1.json';
  const outputPath = outputArg === 'none' ? null : path.resolve(rootDir, outputArg);
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aibw-intimacy-'));

  try {
    const loaded = loadConfig(rootDir);
    for (const item of plan) {
      if (!loaded.rules[item.presetId]) throw new Error(`不明なプリセット: ${item.presetId}`);
    }
    const { sources, totalCalls } = await runMockSources({ plan, baseSeed, tempDataDir });
    const scenarios = extractIntimacyScenarios(sources);
    const analysis = analyzeIntimacyGradient({
      scenarios,
      maxBonuses,
      intimacyLevels,
      modes,
    });
    const scenariosByPreset = Object.fromEntries(
      plan.map((item) => [
        item.presetId,
        scenarios.filter((scenario) => scenario.presetId === item.presetId).length,
      ]),
    );
    const report = {
      schemaVersion: 1,
      experiment: 'ai-buddy-intimacy-gradient',
      generator: 'apps/server/src/cli/analyzeIntimacy.ts',
      baseSeed,
      provider: 'mock',
      plan: plan.map((item) => ({
        ...item,
        rulesVersion: loaded.rules[item.presetId]?.version ?? 'unknown',
      })),
      maxBonuses,
      intimacyLevels,
      modes,
      totalMatches: plan.reduce((sum, item) => sum + item.matches, 0),
      totalCalls,
      scenarioCount: scenarios.length,
      scenariosByPreset,
      modeDefinitions: {
        second: 'AI基礎評価の2位。1位と同点なら除外',
        third: 'AI基礎評価の3位。候補不足または1位と同点なら除外',
        middle: '順位中央の候補。1位と同点なら除外',
        last: 'AI基礎評価の最下位。1位と同点なら除外',
      },
      ...analysis,
      scenarios,
    };

    console.log(`\n[intimacy] ${report.totalMatches}試合 / ${totalCalls} calls / ${scenarios.length}裁判評価`);
    for (const mode of modes) {
      console.log(`\n== ${mode} (usable=${analysis.usableScenariosByMode[mode]}) ==`);
      for (const gap of analysis.gaps.filter((entry) => entry.mode === mode)) {
        console.log(
          `max=${gap.maxBonus}: 反映 ${(gap.reflectedRateLower * 100).toFixed(1)}% → ${(gap.reflectedRateUpper * 100).toFixed(1)}% / 差 ${gap.intimacyGapPoints.toFixed(1)}pt / 高親密度の非服従 ${(gap.nonObedienceRateUpper * 100).toFixed(1)}%`,
        );
      }
    }

    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
      console.log(`\n保存先: ${outputPath}`);
    }
  } finally {
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
