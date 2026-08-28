import { describe, expect, it } from 'vitest';
import type { ConfigResponse } from '../src/api.js';
import {
  DEFAULT_PRESET_ID,
  preferredInitialProvider,
} from '../src/screens/Home.js';

function configWithProviders(
  providers: ConfigResponse['models']['providers'],
  defaultProvider = 'mock',
): ConfigResponse {
  return {
    presets: [],
    advice: {
      version: 'test',
      menu: [],
      questionThemes: [],
      behaviorDirectives: [],
      roleClaimOptions: [],
    },
    buddies: { version: 'test', roster: [] },
    models: {
      version: 'test',
      defaultProvider,
      providers,
    },
    promptVersion: 'test',
    editable: { config: [], prompts: [] },
  };
}

describe('新規試合の初期選択', () => {
  const providers: ConfigResponse['models']['providers'] = {
    mock: { type: 'mock' },
    anthropic: { type: 'anthropic', model: 'claude-opus-5' },
    'lab-live': { type: 'labProxy', model: 'anthropic/claude-sonnet-5' },
  };

  it('本格9組テストを既定プリセットにする', () => {
    expect(DEFAULT_PRESET_ID).toBe('standard-nine');
  });

  it('公開LabではLive AI中継を既定にする', () => {
    expect(preferredInitialProvider(configWithProviders(providers), true)).toBe('lab-live');
  });

  it('ローカル開発ではAnthropic APIを既定にする', () => {
    expect(preferredInitialProvider(configWithProviders(providers), false)).toBe('anthropic');
  });

  it('優先プロバイダーが無い場合もモックより別のLive AIを選ぶ', () => {
    const fallback = configWithProviders({
      mock: { type: 'mock' },
      customLive: { type: 'labProxy', model: 'custom/model' },
    });
    expect(preferredInitialProvider(fallback, false)).toBe('customLive');
  });
});
