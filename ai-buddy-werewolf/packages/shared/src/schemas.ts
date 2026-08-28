/**
 * Zodスキーマ。
 * - AI構造化出力(評価/発言)の検証
 * - 外部設定ファイルの検証
 */
import { z } from 'zod';
import { MOBILE_HANDOFF_FILE_PATHS, MOBILE_HANDOFF_V1_FILE_PATHS } from './types.js';

const score = z.number().min(0).max(100);
const roleSchema = z.enum(['villager', 'seer', 'guardian', 'medium', 'werewolf']);

export const evalOutputSchema = z.object({
  suspicions: z.record(z.string(), score),
  attackPriorities: z.record(z.string(), score).optional(),
  skillTargetPriorities: z.record(z.string(), score).optional(),
  primaryHypothesis: z.string().max(400),
  altHypotheses: z.array(z.string().max(400)).max(3),
  confidence: score,
  toShare: z.array(z.string().max(200)).max(5),
  toWithhold: z.array(z.string().max(200)).max(5),
  questionTargetId: z.string().nullable(),
  questionTheme: z.string().nullable(),
  voteCandidateId: z.string().nullable(),
  reasonSummary: z.string().max(500),
});

export const speechOutputSchema = z.object({
  text: z.string().min(1).max(1200),
  accusesId: z.string().nullable(),
  declaredRole: roleSchema.nullable().default(null),
});

// ---------------------------------------------------------------------------
// 設定ファイル
// ---------------------------------------------------------------------------

export const abilitiesSchema = z.object({
  reasoning: score,
  deception: score,
  trust: score,
});

export const personaSchema = z.object({
  name: z.string().min(1),
  firstPerson: z.string().min(1),
  masterCall: z.string().min(1),
  look: z.string(),
  personality: z.string(),
  speechStyle: z.string(),
  verbosity: z.enum(['short', 'medium', 'long']),
  emotion: z.string(),
  archetype: z.string(),
  mockFlavor: z.object({
    endings: z.array(z.string()),
    exclamations: z.array(z.string()),
  }),
});

export const buddyConfigSchema = z.object({
  id: z.string().min(1),
  persona: personaSchema,
  abilities: abilitiesSchema,
});

export const buddiesConfigSchema = z.object({
  version: z.string(),
  roster: z.array(buddyConfigSchema).min(1),
});

export const trustFnSchema = z.object({
  type: z.enum(['linear', 'quadratic', 'none']),
  maxBonus: z.number().min(0).max(100),
});

export const rulesConfigSchema = z
  .object({
    version: z.string(),
    presetId: z.string(),
    label: z.string(),
    pairCount: z.number().int().min(3).max(20),
    roleSetup: z.object({
      werewolf: z.number().int().min(1),
      seer: z.number().int().min(0),
      guardian: z.number().int().min(0).default(0),
      medium: z.number().int().min(0).default(0),
    }),
    maxDays: z.number().int().min(1).max(20),
    firstNightDivination: z.union([z.boolean(), z.literal('white')]).default(false),
    firstDayFocusCount: z.number().int().min(0).max(4).default(2),
    discussionMode: z.enum(['timed', 'turns']).default('turns'),
    discussionDurationSec: z.number().int().min(15).max(600).default(150),
    discussionMaxMessages: z.number().int().min(5).max(100).default(30),
    discussionBatchSize: z.number().int().min(1).max(8).default(3),
    discussionAdviceIntervalMessages: z.number().int().min(1).max(20).default(3),
    discussionRounds: z.number().int().min(1).max(10),
    speechesPerBuddyPerRound: z.number().int().min(1).max(3),
    advicePerDay: z.number().int().min(0).max(10),
    tieBreak: z.literal('random'),
    revealRoleOnDeath: z.boolean(),
    wolfAttackIntegration: z.object({
      method: z.literal('sumNormalized'),
      tieBreak: z.literal('random'),
    }),
    trust: z.object({
      trialChoice: trustFnSchema,
      nightProposal: trustFnSchema,
      skillProposal: trustFnSchema,
      subjectiveAdvice: trustFnSchema,
    }),
    otherMastersPolicy: z.enum(['none', 'random', 'simple', 'ai']),
  })
  .refine((c) =>
    c.roleSetup.werewolf + c.roleSetup.seer +
      c.roleSetup.guardian + c.roleSetup.medium <= c.pairCount, {
    message: '役職数が組数を超えています',
  })
  .refine(
    (c) =>
      c.firstNightDivination !== 'white' ||
      c.roleSetup.seer === 0 ||
      c.pairCount - c.roleSetup.werewolf >= 2,
    {
      message: '初日白通知には、占い師本人以外の市民陣営が1組以上必要です',
      path: ['firstNightDivination'],
    },
  )
  .refine((c) => c.discussionMode !== 'timed' || c.advicePerDay <= 3, {
    message: '時間制討論の主人相談は1日3回までです',
    path: ['advicePerDay'],
  })
  .refine((c) => c.discussionMode !== 'timed' || c.discussionMaxMessages >= 2, {
    message: '時間制討論は相談前後に最低1発言ずつ必要です',
    path: ['discussionMaxMessages'],
  });

export const adviceConfigSchema = z.object({
  version: z.string(),
  menu: z.array(
    z.object({
      kind: z.enum([
        'suspicion',
        'question',
        'fact_share',
        'skill_target',
        'role_claim',
        'behavior',
      ]),
      label: z.string(),
      description: z.string(),
      enabled: z.boolean(),
    }),
  ),
  questionThemes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      mockTemplate: z.string(),
      promptHint: z.string(),
    }),
  ),
  behaviorDirectives: z.array(
    z.object({ id: z.string(), label: z.string(), promptHint: z.string() }),
  ),
  roleClaimOptions: z
    .array(
      z.object({
        role: roleSchema,
        label: z.string(),
        description: z.string(),
        dangerous: z.boolean(),
      }),
    )
    .default([]),
});

export const abilitiesConfigSchema = z.object({
  version: z.string(),
  reasoningUnlocks: z.array(
    z.object({
      at: z.number().min(0).max(100),
      id: z.string(),
      label: z.string(),
      promptHint: z.string(),
    }),
  ),
  deceptionUnlocks: z.array(
    z.object({
      at: z.number().min(0).max(100),
      id: z.string(),
      label: z.string(),
      promptHint: z.string(),
    }),
  ),
});

export const modelsConfigSchema = z.object({
  version: z.string(),
  defaultProvider: z.string(),
  providers: z.record(
    z.string(),
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('mock'),
        simulatedLatencyMs: z.number().min(0),
      }),
      z.object({
        type: z.literal('anthropic'),
        apiKeyEnv: z.string(),
        model: z.string(),
        temperature: z.number().min(0).max(1).nullable(),
        maxTokensEval: z.number().int().min(256),
        maxTokensSpeech: z.number().int().min(128),
        effort: z.enum(['low', 'medium', 'high']),
        timeoutMs: z.number().int().min(1000),
        maxRetries: z.number().int().min(0).max(5),
        jsonRetries: z.number().int().min(0).max(5),
        prices: z.record(
          z.string(),
          z.object({ inputPerMTok: z.number(), outputPerMTok: z.number() }),
        ),
      }),
      z.object({
        type: z.literal('labProxy'),
        endpoint: z.string().url(),
        model: z.string().min(1),
        temperature: z.number().min(0).max(1).nullable(),
        maxTokensEval: z.number().int().min(256),
        maxTokensSpeech: z.number().int().min(128),
        effort: z.enum(['low', 'medium', 'high']),
        timeoutMs: z.number().int().min(1000),
        jsonRetries: z.number().int().min(0).max(5),
        prices: z.record(
          z.string(),
          z.object({ inputPerMTok: z.number(), outputPerMTok: z.number() }),
        ),
      }),
    ]),
  ),
});

export const adviceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('suspicion'), targetId: z.string() }),
  z.object({ kind: z.literal('question'), targetId: z.string(), themeId: z.string() }),
  z.object({ kind: z.literal('fact_share'), factId: z.string() }),
  z.object({ kind: z.literal('skill_target'), targetId: z.string() }),
  z.object({ kind: z.literal('role_claim'), claimedRole: roleSchema.nullable() }),
  z.object({ kind: z.literal('behavior'), directiveId: z.string() }),
]);

/** Web Labで調整した内容を本番モバイル側へ渡す固定フォーマット。 */
const mobileHandoffFilesSchema = z.record(z.string(), z.string().max(100_000));

export const mobileHandoffBundleSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  kind: z.literal('ai-buddy-werewolf-mobile-handoff'),
  exportedAt: z.string().datetime(),
  source: z.object({
    app: z.literal('ai-buddy-werewolf-phase0-web-lab'),
    configVersions: z.record(z.string(), z.string()),
  }),
  files: mobileHandoffFilesSchema,
  integrity: z.object({
    algorithm: z.literal('SHA-256'),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  implementationContract: z.object({
    gameCore: z.literal('authoritative-event-engine'),
    prompts: z.literal('server-side-only'),
    secretsIncluded: z.literal(false),
    mobileTransport: z.enum(['server-api', 'supabase-edge-function']),
  }),
}).superRefine((bundle, context) => {
  const actual = Object.keys(bundle.files).sort();
  const expected = [
    ...(bundle.schemaVersion === 1
      ? MOBILE_HANDOFF_V1_FILE_PATHS
      : MOBILE_HANDOFF_FILE_PATHS),
  ].sort();
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['files'],
      message: `モバイル引継ぎv${bundle.schemaVersion}のファイル構成が固定契約と一致しません`,
    });
  }
});
