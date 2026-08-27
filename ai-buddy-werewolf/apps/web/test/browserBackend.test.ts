import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserBackend } from '../src/runtime/browserBackend.js';
import {
  encodeLabAccessHeader,
  normalizeLabAccessCode,
} from '../src/runtime/access.js';
import {
  createMobileHandoffBundle,
  readStaticFile,
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
    const bundle = await createMobileHandoffBundle();
    const validated = await validateMobileHandoffBundle(bundle);
    expect(validated.integrity.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(validated.implementationContract.secretsIncluded).toBe(false);
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
});
