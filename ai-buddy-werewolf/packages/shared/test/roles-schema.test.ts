import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  adviceConfigSchema,
  adviceSchema,
  rulesConfigSchema,
  speechOutputSchema,
} from '../src/index.js';

const readJson = (path: string): unknown => JSON.parse(fs.readFileSync(path, 'utf-8'));

describe('追加役職の設定schema', () => {
  it('旧presetは騎士・霊媒師を0として後方互換で読み込む', () => {
    const parsed = rulesConfigSchema.parse(readJson('config/presets/quick-test.json'));
    expect(parsed.roleSetup.guardian).toBe(0);
    expect(parsed.roleSetup.medium).toBe(0);
  });

  it('standard-nineは9組の役職合計を検証して読み込む', () => {
    const parsed = rulesConfigSchema.parse(readJson('config/presets/standard-nine.json'));
    expect(parsed.pairCount).toBe(9);
    expect(parsed.roleSetup).toEqual({ werewolf: 2, seer: 1, guardian: 1, medium: 1 });
    const fixedRoles = Object.values(parsed.roleSetup).reduce((sum, count) => sum + count, 0);
    expect(parsed.pairCount - fixedRoles).toBe(4);
  });
});
describe('役職宣言のshared契約', () => {
  it('旧SpeechOutputへdeclaredRole=nullを補完する', () => {
    expect(speechOutputSchema.parse({ text: '発言', accusesId: null })).toEqual({
      text: '発言',
      accusesId: null,
      declaredRole: null,
    });
  });

  it('role_claim助言と設定候補を検証する', () => {
    expect(adviceSchema.parse({ kind: 'role_claim', claimedRole: 'guardian' })).toEqual({
      kind: 'role_claim',
      claimedRole: 'guardian',
    });
    const config = adviceConfigSchema.parse(readJson('config/advice.json'));
    expect(config.roleClaimOptions.map((option) => option.role)).toEqual(
      expect.arrayContaining(['villager', 'seer', 'guardian', 'medium', 'werewolf']),
    );
  });
});
