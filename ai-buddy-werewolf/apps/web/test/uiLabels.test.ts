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
  roleLabel,
} from '../src/uiLabels.js';

describe('日本語UI表示名', () => {
  it('編集可能な設定ファイルを日本語名で案内する', () => {
    const files = [
      'presets/quick-test.json',
      'presets/pack-test.json',
      'presets/quick-info.json',
      'presets/standard-nine.json',
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
      'role.guardian.md',
      'role.medium.md',
      'role.werewolf.md',
      'version.json',
    ];
    expect(Object.keys(PROMPT_FILE_META)).toEqual(expect.arrayContaining(files));
    for (const file of files) expect(promptFileLabel(file)).not.toBe(file);
  });

  it('ホームと試合画面の内部値を日本語表示へ変換する', () => {
    expect(providerLabel('mock')).toContain('モックAI');
    expect(providerLabel('lab-live')).toContain('OpenRouter');
    expect(masterPolicyLabel('simple')).toContain('初日は棄権');
    expect(presetIdLabel('quick-info')).toBe('クイック情報戦');
    expect(presetIdLabel('standard-nine')).toBe('9人本格テスト');
    expect(roleLabel('seer')).toBe('占い師');
    expect(roleLabel('guardian')).toBe('騎士');
    expect(roleLabel('medium')).toBe('霊媒師');
    expect(roleLabel(null)).toBe('まだ名乗らない');
    expect(modeLabel('lab')).toBe('検証室');
    expect(phaseLabel('discussion')).toBe('討論');
  });
});
