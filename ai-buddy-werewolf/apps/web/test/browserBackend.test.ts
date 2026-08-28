import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MOBILE_HANDOFF_FILE_PATHS,
  MOBILE_HANDOFF_V1_FILE_PATHS,
  canonicalizeMobileHandoffFiles,
  type MatchRecord,
} from '@aibw/shared';
import { BrowserBackend } from '../src/runtime/browserBackend.js';
import {
  encodeLabAccessHeader,
  normalizeLabAccessCode,
} from '../src/runtime/access.js';
import {
  createMobileHandoffBundle,
  createMobileHandoffBundleFromFiles,
  importMobileHandoffBundle,
  readStaticFile,
  resetStaticFiles,
  validateMobileHandoffBundle,
} from '../src/runtime/staticConfig.js';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('公開Web Labブラウザ内バックエンド', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('モック試合を完走して別インスタンスから復元できる', async () => {
    const backend = new BrowserBackend();
    const created = backend.create({
      presetId: 'quick-test',
      mode: 'lab',
      provider: 'mock',
      seed: 'browser-backend-test',
      humanPairIndex: null,
    });

    let finished = false;
    for (let step = 0; step < 200; step += 1) {
      const result = await backend.advance(created.matchId);
      if (result.status === 'waiting') throw new Error('Labモードが入力待ちになりました');
      if (result.status === 'finished') {
        finished = true;
        break;
      }
    }

    expect(finished).toBe(true);
    expect(backend.record(created.matchId).events.length).toBeGreaterThan(1);

    const persisted = JSON.parse(
      localStorage.getItem(`aibw.lab.match.v1:${created.matchId}`) ?? '{}',
    ) as { aiCalls?: { rawRequest?: unknown; rawResponse?: unknown }[] };
    expect(persisted.aiCalls?.length).toBeGreaterThan(30);
    expect(persisted.aiCalls?.slice(0, -30).every(
      (call) => call.rawRequest === undefined && call.rawResponse === undefined,
    )).toBe(true);
    expect(persisted.aiCalls?.slice(-30).some((call) => call.rawRequest !== undefined)).toBe(true);

    const restored = new BrowserBackend();
    const summary = restored.matches().find((match) => match.matchId === created.matchId);
    expect(summary?.winner).toMatch(/citizens|wolves|draw/);
    expect(restored.view(created.matchId, 'gm').view.phase).toBe('finished');
  });

  it('現在の設定を固定bundleへ書き出し自己検証できる', async () => {
    const standard = new BrowserBackend().config().presets.find(
      (preset) => preset.presetId === 'standard-nine',
    );
    expect(standard).toMatchObject({
      pairCount: 9,
      roleSetup: { werewolf: 2, seer: 1, guardian: 1, medium: 1 },
    });

    const bundle = await createMobileHandoffBundle();
    const validated = await validateMobileHandoffBundle(bundle);
    expect(validated.schemaVersion).toBe(2);
    expect(Object.keys(validated.files).sort()).toEqual([...MOBILE_HANDOFF_FILE_PATHS].sort());
    expect(validated.files).toHaveProperty('config/presets/standard-nine.json');
    expect(validated.files).toHaveProperty('prompts/role.guardian.md');
    expect(validated.files).toHaveProperty('prompts/role.medium.md');
    expect(validated.integrity.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(validated.implementationContract.secretsIncluded).toBe(false);
  });

  it('Node版の追加編集ファイルをv2固定16ファイルから除外する', async () => {
    const current = await createMobileHandoffBundle();
    const bundle = await createMobileHandoffBundleFromFiles({
      ...current.files,
      'config/presets/quick-info.json': '{"version":"extra-not-in-contract"}',
    });

    expect(bundle.schemaVersion).toBe(2);
    expect(Object.keys(bundle.files).sort()).toEqual([...MOBILE_HANDOFF_FILE_PATHS].sort());
    expect(bundle.files).not.toHaveProperty('config/presets/quick-info.json');
    await expect(validateMobileHandoffBundle(bundle)).resolves.toMatchObject({ schemaVersion: 2 });
  });

  it('v1の13ファイルbundleを読み込み、新しいv2ファイルは既存値を維持する', async () => {
    const current = await createMobileHandoffBundle();
    const files = Object.fromEntries(
      MOBILE_HANDOFF_V1_FILE_PATHS.map((path) => [path, current.files[path] ?? '']),
    );
    const legacyAdvice = JSON.parse(files['config/advice.json'] ?? '{}') as {
      menu?: { kind: string }[];
      roleClaimOptions?: unknown;
    };
    legacyAdvice.menu = legacyAdvice.menu?.filter((item) => item.kind !== 'role_claim');
    delete legacyAdvice.roleClaimOptions;
    files['config/advice.json'] = JSON.stringify(legacyAdvice);
    const digestBytes = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(canonicalizeMobileHandoffFiles(files)),
    );
    const digest = [...new Uint8Array(digestBytes)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    localStorage.setItem('aibw.lab.file.v1:prompts/role.guardian.md', '騎士の既存調整');

    await importMobileHandoffBundle({
      ...current,
      schemaVersion: 1,
      files,
      integrity: { algorithm: 'SHA-256', digest },
    });

    expect(readStaticFile('prompt', 'role.guardian.md')).toBe('騎士の既存調整');
    const importedAdvice = JSON.parse(readStaticFile('config', 'advice.json')) as {
      menu: { kind: string }[];
      roleClaimOptions: unknown[];
    };
    expect(importedAdvice.menu.some((item) => item.kind === 'role_claim')).toBe(true);
    expect(importedAdvice.roleClaimOptions).toHaveLength(5);
  });

  it('時間制討論の主人相談をスキップし、ブラウザ内でも討論を再開できる', async () => {
    const backend = new BrowserBackend();
    const created = backend.create({
      presetId: 'quick-test',
      mode: 'play',
      provider: 'mock',
      seed: 'browser-skip-advice',
      humanPairIndex: 0,
    });

    let view = backend.view(created.matchId, created.humanPairId);
    for (let step = 0; step < 30 && !view.view.me?.needDiscussionAdvice; step += 1) {
      await backend.advance(created.matchId);
      view = backend.view(created.matchId, created.humanPairId);
    }
    expect(view.view.discussionPaused).toBe(true);
    expect(view.view.me?.needDiscussionAdvice).toBe(true);

    backend.skipDiscussionAdvice(created.matchId, created.humanPairId ?? '');
    expect(backend.view(created.matchId, created.humanPairId).view.me?.needDiscussionAdvice).toBe(
      false,
    );
    await backend.advance(created.matchId);
    expect(backend.view(created.matchId, created.humanPairId).view.discussionStage).toBe('response');
  });

  it('進行中Play Testはlab指定でも内部リプレイを開けず、凍結した助言設定を返す', async () => {
    const backend = new BrowserBackend();
    const created = backend.create({
      presetId: 'quick-test',
      mode: 'play',
      provider: 'mock',
      seed: 'browser-replay-boundary',
      humanPairIndex: 0,
    });
    await backend.advance(created.matchId);
    expect(() => backend.replay(created.matchId, true)).toThrow(/公開されません/);
    expect(backend.view(created.matchId, created.humanPairId).view.adviceConfig).toEqual(
      backend.record(created.matchId).configSnapshot.advice,
    );
  });

  it('旧試合の再開画面は現在設定ではなく、その試合に凍結された助言だけを返す', () => {
    const backend = new BrowserBackend();
    const created = backend.create({
      presetId: 'quick-test',
      mode: 'play',
      provider: 'mock',
      seed: 'browser-frozen-advice',
      humanPairIndex: 0,
    });
    const key = `aibw.lab.match.v1:${created.matchId}`;
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}') as MatchRecord;
    saved.configSnapshot.advice.menu = saved.configSnapshot.advice.menu.filter(
      (item) => item.kind !== 'role_claim',
    );
    localStorage.setItem(key, JSON.stringify(saved));

    const restored = new BrowserBackend();
    const menu = restored.view(created.matchId, created.humanPairId).view.adviceConfig.menu;
    expect(menu.some((item) => item.kind === 'role_claim')).toBe(false);
  });

  it('進行中Labは明示したlab指定で内部リプレイを開ける', async () => {
    const backend = new BrowserBackend();
    const created = backend.create({
      presetId: 'quick-test',
      mode: 'lab',
      provider: 'mock',
      seed: 'browser-lab-replay',
      humanPairIndex: null,
    });
    await backend.advance(created.matchId);
    expect(backend.replay(created.matchId, true)).toBeTruthy();
    expect(() => backend.replay(created.matchId, false)).toThrow(/公開されません/);
  });

  it('愛言葉の全角英字・大文字小文字・前後空白を吸収する', () => {
    expect(normalizeLabAccessCode('  ＴＥＳＴ－ＰＡＳＳ  ')).toBe('test-pass');
  });

  it('日本語の愛言葉をHTTPヘッダーへ安全に載せられるASCIIへ変換する', () => {
    expect(encodeLabAccessHeader('  日本語  ')).toBe(
      '%E6%97%A5%E6%9C%AC%E8%AA%9E',
    );
    expect(encodeLabAccessHeader('  ＴＥＳＴ－ＰＡＳＳ  ')).toBe('test-pass');
  });

  it('保存済みの旧Quick Testを版番号だけで自動上書きしない', () => {
    const saved = {
      version: '0.3.0-joint.1',
      discussionRounds: 1,
      discussionDurationSec: 210,
      customMarker: 'keep-me',
    };
    localStorage.setItem(
      'aibw.lab.file.v1:config/presets/quick-test.json',
      JSON.stringify(saved),
    );
    expect(JSON.parse(readStaticFile('config', 'presets/quick-test.json'))).toEqual(saved);
  });

  it('保存済みの旧プロンプト本文も利用者の調整結果として保持する', () => {
    localStorage.setItem('aibw.lab.file.v1:prompts/system.base.md', '旧版の順番制指示');
    localStorage.setItem(
      'aibw.lab.file.v1:prompts/version.json',
      JSON.stringify({ version: '0.6.0-timed.1' }),
    );

    expect(JSON.parse(readStaticFile('prompt', 'version.json'))).toEqual({ version: '0.6.0-timed.1' });
    expect(readStaticFile('prompt', 'system.base.md')).toBe('旧版の順番制指示');
  });

  it('保存済みの旧助言設定へ役職を名乗る選択肢だけを安全に補う', () => {
    const current = JSON.parse(readStaticFile('config', 'advice.json')) as {
      version: string;
      menu: { kind: string; label: string }[];
      roleClaimOptions?: unknown;
    };
    const legacy = {
      ...current,
      version: '0.1.0-user-tuned',
      menu: current.menu
        .filter((item) => item.kind !== 'role_claim')
        .map((item, index) => index === 0 ? { ...item, label: '利用者が変えた文言' } : item),
    };
    delete legacy.roleClaimOptions;
    localStorage.setItem('aibw.lab.file.v1:config/advice.json', JSON.stringify(legacy));

    const migrated = JSON.parse(readStaticFile('config', 'advice.json')) as {
      version: string;
      menu: { kind: string; label: string }[];
      roleClaimOptions: { role: string }[];
    };
    expect(migrated.menu[0]?.label).toBe('利用者が変えた文言');
    expect(migrated.menu.filter((item) => item.kind === 'role_claim')).toHaveLength(1);
    expect(migrated.roleClaimOptions.map((option) => option.role)).toEqual([
      'villager',
      'seer',
      'guardian',
      'medium',
      'werewolf',
    ]);
    expect(migrated.version).toBe('0.1.0-user-tuned+role-claim-compat.1');
  });

  it('明示操作なら過去試合を消さず、設定とプロンプトだけを現在の推奨値へ戻す', () => {
    localStorage.setItem('aibw.lab.file.v1:config/presets/quick-test.json', JSON.stringify({
      version: 'old-custom',
    }));
    localStorage.setItem('aibw.lab.file.v1:prompts/version.json', JSON.stringify({
      version: 'old-prompt',
    }));
    localStorage.setItem('aibw.lab.matches.v1', JSON.stringify(['keep-this-match']));

    resetStaticFiles();

    expect(JSON.parse(readStaticFile('config', 'presets/quick-test.json'))).toMatchObject({
      version: '0.8.1-short-rally.1',
      discussionDurationSec: 150,
      discussionMaxMessages: 30,
      discussionBatchSize: 2,
      firstNightDivination: 'white',
    });
    expect(JSON.parse(readStaticFile('prompt', 'version.json'))).toEqual({
      version: '1.0.0-short-rally-diverse-angles.1',
    });
    expect(localStorage.getItem('aibw.lab.matches.v1')).toBe(JSON.stringify(['keep-this-match']));
  });
});
