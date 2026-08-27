/** ai-engineテスト用フィクスチャ(game-coreテストと同等の最小設定) */
import type {
  Abilities,
  AbilitiesConfig,
  AdviceConfig,
  BuddyConfig,
  ConfigSnapshot,
  MatchRecord,
  ModelsConfig,
  RulesConfig,
} from '@aibw/shared';
import { createMatch } from '@aibw/game-core';
import { rebuildStore, type MatchStore } from '../src/runner.js';
import type { PromptSet } from '../src/provider.js';

export function makeBuddy(id: string, abilities?: Partial<Abilities>): BuddyConfig {
  return {
    id,
    persona: {
      name: id.toUpperCase(),
      firstPerson: '私',
      masterCall: '主人',
      look: '',
      personality: 'テスト',
      speechStyle: '標準',
      verbosity: 'short',
      emotion: '控えめ',
      archetype: 'テスト',
      mockFlavor: { endings: ['です'], exclamations: [] },
    },
    abilities: { reasoning: 50, deception: 50, trust: 50, ...abilities },
  };
}

const advice: AdviceConfig = {
  version: 'test',
  menu: [
    { kind: 'suspicion', label: '疑い', description: '', enabled: true },
    { kind: 'question', label: '質問', description: '', enabled: true },
    { kind: 'fact_share', label: '確定情報', description: '', enabled: true },
    { kind: 'skill_target', label: 'スキル対象', description: '', enabled: true },
    { kind: 'behavior', label: '立ち回り', description: '', enabled: true },
  ],
  questionThemes: [
    { id: 'vote_reason', label: '投票理由', mockTemplate: '{target}、理由は?', promptHint: '' },
  ],
  behaviorDirectives: [{ id: 'low_profile', label: '目立たない', promptHint: '' }],
};

const abilitiesConfig: AbilitiesConfig = {
  version: 'test',
  reasoningUnlocks: [
    { at: 0, id: 'face_value', label: '額面', promptHint: '' },
    { at: 30, id: 'multi_hypothesis', label: '複数仮説', promptHint: '' },
  ],
  deceptionUnlocks: [
    { at: 0, id: 'plain_denial', label: '否定', promptHint: '' },
    { at: 70, id: 'misdirection', label: '誘導', promptHint: '' },
  ],
};

export const testModels: ModelsConfig = {
  version: 'test',
  defaultProvider: 'mock',
  providers: { mock: { type: 'mock', simulatedLatencyMs: 0 } },
};

export const testPrompts: PromptSet = {
  version: 'test',
  systemBase: 'base {{buddyName}}',
  evalTemplate: 'eval {{day}}',
  speechTemplate: 'speech {{buddyName}}',
  roleVillager: 'villager',
  roleSeer: 'seer',
  roleWerewolf: 'werewolf {{wolfPartners}}',
};

export function makeSnapshot(
  rulesOverrides?: Partial<RulesConfig>,
  buddyAbilities?: Record<string, Partial<Abilities>>,
): ConfigSnapshot {
  const rules: RulesConfig = {
    version: 'test',
    presetId: 'test',
    label: 'test',
    pairCount: 5,
    roleSetup: { werewolf: 1, seer: 1 },
    maxDays: 3,
    firstNightDivination: false,
    firstDayFocusCount: 0,
    discussionRounds: 1,
    speechesPerBuddyPerRound: 1,
    advicePerDay: 1,
    tieBreak: 'random',
    revealRoleOnDeath: false,
    wolfAttackIntegration: { method: 'sumNormalized', tieBreak: 'random' },
    trust: {
      trialChoice: { type: 'linear', maxBonus: 25 },
      nightProposal: { type: 'linear', maxBonus: 25 },
      skillProposal: { type: 'linear', maxBonus: 30 },
      subjectiveAdvice: { type: 'linear', maxBonus: 20 },
    },
    otherMastersPolicy: 'random',
    ...rulesOverrides,
  };
  const buddies = Array.from({ length: rules.pairCount }, (_, i) =>
    makeBuddy(`b${i + 1}`, buddyAbilities?.[`b${i + 1}`]),
  );
  return {
    rules,
    advice,
    abilities: abilitiesConfig,
    models: testModels,
    buddies,
    promptVersion: 'test',
    versions: { rules: 'test' },
  };
}

export function makeStore(
  seed: string,
  rulesOverrides?: Partial<RulesConfig>,
  now = 1_700_000_000_000,
): MatchStore {
  const config = makeSnapshot(rulesOverrides);
  const { events } = createMatch({
    matchId: `m-${seed}`,
    seed,
    mode: 'lab',
    provider: 'mock',
    humanPairIndex: null,
    config,
    now,
  });
  const record: MatchRecord = {
    schemaVersion: 1,
    matchId: `m-${seed}`,
    seed,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    mode: 'lab',
    provider: 'mock',
    humanPairId: null,
    configSnapshot: config,
    events,
    aiCalls: [],
  };
  return rebuildStore(record);
}
