import { describe, expect, it } from 'vitest';
import {
  CONFIG_FILE_META,
  PROMPT_FILE_META,
  configFileLabel,
  masterPolicyLabel,
  modeLabel,
  phaseLabel,
  presetIdLabel,
  promptFileLabel,
  providerLabel,
} from '../src/uiLabels.js';

describe('日本語UI表示名', () => {
  it('編集可能な設定ファイルを日本語名で案内する', () => {
    const files = [
      'presets/quick-test.json',
      'presets/pack-test.json',
      'presets/quick-info.json',
      'advice.json',
      'abilities.json',
      'models.json',
      'buddies.json',
    ];
    expect(Object.keys(CONFIG_FILE_META)).toEqual(expect.arrayContaining(files));
    for (const file of files) expect(configFileLabel(file)).not.toBe(file);
  });

  it('全プロンプトを役割が分かる日本語名で案内する', () => {
    const files = [
      'system.base.md',
      'eval.md',
      'speech.md',
      'role.villager.md',
      'role.seer.md',
      'role.werewolf.md',
      'version.json',
    ];
    expect(Object.keys(PROMPT_FILE_META)).toEqual(expect.arrayContaining(files));
    for (const file of files) expect(promptFileLabel(file)).not.toBe(file);
  });

  it('ホームと試合画面の内部値を日本語表示へ変換する', () => {
    expect(providerLabel('mock')).toContain('モックAI');
    expect(providerLabel('lab-live')).toContain('実際の会話');
    expect(masterPolicyLabel('simple')).toContain('初日は棄権');
    expect(presetIdLabel('quick-info')).toBe('クイック情報戦');
    expect(modeLabel('lab')).toBe('検証室');
    expect(phaseLabel('discussion')).toBe('討論');
  });
});
