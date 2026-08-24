/** 実際の設定ファイル・プロンプトの検証と、MatchManager経由の完走テスト */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildSnapshot, loadConfig } from '../src/configLoader.js';
import { MatchManager } from '../src/matches.js';
import { evalsCsv, callsCsv } from '../src/csv.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..', '..', '..');
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'aibw-test-'));

afterAll(() => {
  fs.rmSync(tmpData, { recursive: true, force: true });
});

describe('実際の設定ファイル', () => {
  it('config/とprompts/がスキーマ検証を通る', () => {
    const loaded = loadConfig(rootDir);
    expect(Object.keys(loaded.rules)).toContain('quick-test');
    expect(Object.keys(loaded.rules)).toContain('pack-test');
    expect(loaded.buddies.roster.length).toBeGreaterThanOrEqual(8);
    expect(loaded.prompts.systemBase).toContain('{{buddyName}}');
    expect(loaded.models.providers['anthropic']).toBeDefined();
  });

  it('スナップショットに設定バージョンが記録される', () => {
    const loaded = loadConfig(rootDir);
    const snap = buildSnapshot(loaded, 'quick-test');
    expect(snap.versions['rules']).toBeTruthy();
    expect(snap.versions['prompts']).toBeTruthy();
    expect(snap.promptVersion).toBe(loaded.prompts.version);
  });
});

describe('MatchManager(実設定・モックAI)', () => {
  it('作成→完走→永続化→エクスポートが動く', async () => {
    const manager = new MatchManager(rootDir, () => Date.now(), tmpData);
    const summary = manager.createMatch({
      presetId: 'quick-test',
      mode: 'lab',
      provider: 'mock',
      seed: 'server-test',
    });
    let result: Awaited<ReturnType<typeof manager.advance>> = {
      status: 'progressed',
      task: '',
    };
    for (let i = 0; i < 300 && result.status === 'progressed'; i++) {
      result = await manager.advance(summary.matchId);
    }
    expect(result.status).toBe('finished');
    await manager.flush(summary.matchId);

    const record = manager.getRecord(summary.matchId);
    expect(record.configSnapshot.versions['rules']).toBeTruthy();
    // 永続化ファイルから復元できる
    const file = path.join(tmpData, 'matches', `${summary.matchId}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const manager2 = new MatchManager(rootDir, () => Date.now(), tmpData);
    const view = manager2.getMasterView(summary.matchId, null);
    expect(view.view.winner).not.toBeNull();
    // CSV
    expect(evalsCsv(record).split('\n').length).toBeGreaterThan(2);
    expect(callsCsv(record).split('\n').length).toBeGreaterThan(2);
    // リプレイは終了後に取得できる
    const replay = manager2.getReplay(summary.matchId, false);
    expect(replay.evalTimeline.length).toBeGreaterThan(0);
  });

  it('進行中の内部データはlabフラグなしでは見られない', async () => {
    const manager = new MatchManager(rootDir, () => Date.now(), tmpData);
    const summary = manager.createMatch({
      presetId: 'quick-test',
      mode: 'play',
      provider: 'mock',
      seed: 'server-test-2',
      humanPairIndex: 0,
    });
    await manager.advance(summary.matchId);
    expect(() => manager.getReplay(summary.matchId, false)).toThrow(/公開されません/);
    expect(manager.getReplay(summary.matchId, true)).toBeTruthy();
    await manager.flush(summary.matchId);
  });
});
