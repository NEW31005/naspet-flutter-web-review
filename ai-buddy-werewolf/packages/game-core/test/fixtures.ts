/** テスト用の設定スナップショット生成 */
import type {
  AbilitiesConfig,
  Abilities,
  AdviceConfig,
  BuddyConfig,
  ConfigSnapshot,
  EvalOutput,
  ModelsConfig,
  RulesConfig,
} from '@aibw/shared';

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

export function makeRules(overrides?: Partial<RulesConfig>): RulesConfig {
  return {
    version: 'test',
    presetId: 'test',
    label: 'test',
    pairCount: 5,
    roleSetup: { werewolf: 1, seer: 1 },
    maxDays: 3,
    firstNightDivination: false,
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
    otherMastersPolicy: 'none',
    ...overrides,
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
    { at: 10, id: 'vote_consistency', label: '投票整合', promptHint: '' },
    { at: 20, id: 'bandwagon_detect', label: '便乗検知', promptHint: '' },
    { at: 30, id: 'multi_hypothesis', label: '複数仮説', promptHint: '' },
  ],
  deceptionUnlocks: [
    { at: 0, id: 'plain_denial', label: '否定', promptHint: '' },
    { at: 30, id: 'plausible_reason', label: '理由付け', promptHint: '' },
    { at: 70, id: 'misdirection', label: '誘導', promptHint: '' },
  ],
};

const models: ModelsConfig = {
  version: 'test',
  defaultProvider: 'mock',
  providers: { mock: { type: 'mock', simulatedLatencyMs: 0 } },
};

export function makeSnapshot(
  rulesOverrides?: Partial<RulesConfig>,
  buddyAbilities?: Record<string, Partial<Abilities>>,
): ConfigSnapshot {
  const rules = makeRules(rulesOverrides);
  const buddies = Array.from({ length: rules.pairCount }, (_, i) =>
    makeBuddy(`b${i + 1}`, buddyAbilities?.[`b${i + 1}`]),
  );
  return {
    rules,
    advice,
    abilities: abilitiesConfig,
    models,
    buddies,
    promptVersion: 'test',
    versions: { rules: 'test' },
  };
}

/** 全候補へ同一スコアの評価出力 */
export function makeEval(
  suspicions: Record<string, number>,
  extra?: Partial<EvalOutput>,
): EvalOutput {
  return {
    suspicions,
    primaryHypothesis: 'テスト仮説',
    altHypotheses: [],
    confidence: 50,
    toShare: [],
    toWithhold: [],
    questionTargetId: null,
    questionTheme: null,
    voteCandidateId: null,
    reasonSummary: 'テスト',
    ...extra,
  };
}
