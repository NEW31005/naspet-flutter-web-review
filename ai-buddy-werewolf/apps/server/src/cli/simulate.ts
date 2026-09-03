/**
 * CLIシミュレーター: UIなしで複数試合を連続実行する(Lab Simulationの入口)。
 *
 * 使い方:
 *   npm run simulate -- --preset quick-test --matches 3 --seed exp1 --provider mock
 *
 * 各試合は data/matches/ へ保存され、Web UIの過去試合一覧からも確認できる。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMetrics } from '@aibw/ai-engine';
import { MatchManager } from '../matches.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..', '..', '..', '..');

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const preset = args.preset ?? 'quick-test';
  const matches = Number(args.matches ?? '1');
  const provider = args.provider ?? 'mock';
  const baseSeed = args.seed;

  console.log(`[simulate] preset=${preset} matches=${matches} provider=${provider}`);
  const manager = new MatchManager(rootDir);

  const results: {
    matchId: string;
    winner: string;
    days: number;
    calls: number;
    costUsd: number;
    aiWaitMs: number;
    wallClockMs: number | null;
  }[] = [];

  for (let i = 0; i < matches; i++) {
    const seed = baseSeed ? `${baseSeed}-${i + 1}` : undefined;
    const summary = manager.createMatch({ presetId: preset, mode: 'lab', provider, seed });
    // manager.advance を使うことで各ステップが永続化される
    let result: Awaited<ReturnType<typeof manager.advance>> = {
      status: 'progressed',
      task: 'start',
    };
    for (let step = 0; step < 1000 && result.status === 'progressed'; step++) {
      result = await manager.advance(summary.matchId);
    }
    await manager.flush(summary.matchId);
    if (result.status !== 'finished') {
      console.warn(`[simulate] ${summary.matchId}: 完走できませんでした (${result.status})`);
    }
    const session = manager.getSession(summary.matchId);
    const store = session.runner.store;
    const metrics = computeMetrics(store.record);
    results.push({
      matchId: summary.matchId,
      winner: store.state.winner ?? '(未決着)',
      days: store.state.day,
      calls: metrics.aiCallCount,
      costUsd: metrics.costUsd,
      aiWaitMs: metrics.aiWaitMs,
      wallClockMs: metrics.wallClockMs,
    });
    console.log(
      `[simulate] ${i + 1}/${matches} ${summary.matchId} seed=${store.state.seed} → ${store.state.winner ?? '?'} (${store.state.day}日目, calls=${metrics.aiCallCount}, $${metrics.costUsd})`,
    );
  }

  console.log('\n== サマリー ==');
  const wins = { citizens: 0, wolves: 0, draw: 0 } as Record<string, number>;
  for (const r of results) wins[r.winner] = (wins[r.winner] ?? 0) + 1;
  console.log(`市民勝利: ${wins.citizens ?? 0} / 狼勝利: ${wins.wolves ?? 0} / 引分: ${wins.draw ?? 0}`);
  console.log(
    `総コール: ${results.reduce((a, r) => a + r.calls, 0)}, 総原価: $${results
      .reduce((a, r) => a + r.costUsd, 0)
      .toFixed(4)}, AI待機合計: ${(results.reduce((a, r) => a + r.aiWaitMs, 0) / 1000).toFixed(1)}s`,
  );
  console.log(`保存先: ${path.join(rootDir, 'data', 'matches')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
