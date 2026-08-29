import type {
  AiCallRecord,
  EvalOutput,
  LabProxyProviderConfig,
  ModelsConfig,
  PairId,
  SpeechOutput,
} from '@aibw/shared';
import { evalOutputSchema, MAX_PUBLIC_SPEECH_CHARS, speechOutputSchema } from '@aibw/shared';
import type { BuddyContext } from '@aibw/game-core';
import {
  MockProvider,
  buildEvalPrompt,
  buildSpeechPrompt,
  type AiEngineLike,
  type CallOpts,
  type PromptSet,
  type ProviderResult,
} from '@aibw/ai-engine/browser';
import { encodeLabAccessHeader, getLabAccessCode } from './access.js';

interface ScoreEntry {
  targetId: string;
  score: number;
}

type ScoreField = 'suspicions' | 'attackPriorities' | 'skillTargetPriorities';

interface AllowedScoresResult {
  scores: Record<PairId, number>;
  dropped: number;
  normalized: number;
  conflicted: number;
}

interface ProxyEvalOutput {
  suspicions: ScoreEntry[];
  attackPriorities: ScoreEntry[];
  skillTargetPriorities: ScoreEntry[];
  primaryHypothesis: string;
  altHypotheses: string[];
  confidence: number;
  toShare: string[];
  toWithhold: string[];
  questionTargetId: string | null;
  questionTheme: string | null;
  voteCandidateId: string | null;
  reasonSummary: string;
}

interface ProxyResponse {
  output: unknown;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  repair?: {
    scoreEntriesDropped?: number;
    scoreEntriesNormalized?: number;
    scoreEntriesDroppedByField?: Partial<Record<ScoreField, number>>;
    scoreEntriesNormalizedByField?: Partial<Record<ScoreField, number>>;
  };
}

class JsonValidationError extends Error {
  constructor(
    message: string,
    readonly billable?: {
      model: string;
      usage: { inputTokens: number; outputTokens: number };
      retries: number;
      rawResponses: unknown[];
    },
  ) {
    super(message);
    this.name = 'JsonValidationError';
  }
}

/**
 * Edge通過後もBuddyContextの生存候補だけへ絞る最後の防壁。
 * 同一IDに異なる点数が来た場合は、順序依存のlast-winsにせず候補ごと除外する。
 */
export function toAllowedScores(
  entries: unknown[],
  allowedIds: ReadonlySet<string>,
): AllowedScoresResult {
  const scores: Record<PairId, number> = {};
  const conflicted = new Set<string>();
  let dropped = 0;
  let normalized = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      dropped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const targetId = record.targetId;
    const score = record.score;
    if (
      typeof targetId !== 'string' ||
      !allowedIds.has(targetId) ||
      typeof score !== 'number' ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 100
    ) {
      dropped += 1;
      continue;
    }
    if (conflicted.has(targetId)) continue;
    const previous = scores[targetId];
    if (previous !== undefined && previous !== score) {
      delete scores[targetId];
      conflicted.add(targetId);
      continue;
    }
    if (previous === score) {
      normalized += 1;
      continue;
    }
    scores[targetId] = score;
  }
  return { scores, dropped, normalized, conflicted: conflicted.size };
}

/** 欠落と除外が同じ1件を指す場合は二重計上せず、異なる補修は合算する。 */
export function countScoreRepairs(
  filtered: AllowedScoresResult,
  edgeDropped = 0,
  edgeNormalized = 0,
  requiredIds?: ReadonlySet<string>,
): number {
  const knownDrops = edgeDropped + filtered.dropped + filtered.conflicted;
  const missing = requiredIds
    ? [...requiredIds].filter((id) => filtered.scores[id] === undefined).length
    : 0;
  return Math.max(knownDrops, missing) + edgeNormalized + filtered.normalized;
}

class LabProxyProvider {
  readonly name = 'lab-live';
  constructor(
    private config: LabProxyProviderConfig,
    private prompts: PromptSet,
  ) {}

  async evaluate(ctx: BuddyContext, opts: CallOpts): Promise<ProviderResult<EvalOutput>> {
    const prompts = buildEvalPrompt(ctx, this.prompts);
    const result = await this.callWithValidation<{
      output: EvalOutput;
      validationRepairs: number;
      validationRepairDetail?: unknown;
    }>('eval', prompts, opts, (value, response) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new JsonValidationError('評価出力がオブジェクトではありません');
      }
      const raw = value as ProxyEvalOutput;
      if (!Array.isArray(raw.suspicions) || !Array.isArray(raw.attackPriorities) ||
          !Array.isArray(raw.skillTargetPriorities)) {
        throw new JsonValidationError('評価スコア配列が不足しています');
      }
      const candidateIds = new Set(ctx.candidates.map((candidate) => candidate.pairId));
      const wolfPartnerIds = new Set(ctx.wolfPartners.map((partner) => partner.pairId));
      const attackCandidateIds = new Set(
        ctx.candidates
          .filter((candidate) => !wolfPartnerIds.has(candidate.pairId))
          .map((candidate) => candidate.pairId),
      );
      const suspicionScores = toAllowedScores(raw.suspicions, candidateIds);
      const attackScores = toAllowedScores(raw.attackPriorities, attackCandidateIds);
      const skillScores = toAllowedScores(raw.skillTargetPriorities, candidateIds);
      const edgeDropped = response.repair?.scoreEntriesDroppedByField ?? {};
      const edgeNormalized = response.repair?.scoreEntriesNormalizedByField ?? {};
      const repairsByField = {
        suspicions: countScoreRepairs(
          suspicionScores,
          edgeDropped.suspicions,
          edgeNormalized.suspicions,
          candidateIds,
        ),
        attackPriorities: countScoreRepairs(
          attackScores,
          edgeDropped.attackPriorities,
          edgeNormalized.attackPriorities,
        ),
        skillTargetPriorities: countScoreRepairs(
          skillScores,
          edgeDropped.skillTargetPriorities,
          edgeNormalized.skillTargetPriorities,
        ),
      };
      const validationRepairs = Object.values(repairsByField)
        .reduce((sum, count) => sum + count, 0);
      if (candidateIds.size > 0 && Object.keys(suspicionScores.scores).length === 0) {
        throw new JsonValidationError('怪しい度が許可候補について1件もありません');
      }
      if (validationRepairs > 1) {
        throw new JsonValidationError('評価スコアの補修が許可上限1件を超えました');
      }
      const mapped = {
        suspicions: suspicionScores.scores,
        attackPriorities:
          raw.attackPriorities.length > 0
            ? attackScores.scores
            : undefined,
        skillTargetPriorities:
          raw.skillTargetPriorities.length > 0
            ? skillScores.scores
            : undefined,
        primaryHypothesis: raw.primaryHypothesis,
        altHypotheses: raw.altHypotheses,
        confidence: raw.confidence,
        toShare: raw.toShare,
        toWithhold: raw.toWithhold,
        questionTargetId: raw.questionTargetId,
        questionTheme: raw.questionTheme,
        voteCandidateId: raw.voteCandidateId,
        reasonSummary: raw.reasonSummary,
      };
      const checked = evalOutputSchema.safeParse(mapped);
      if (!checked.success) throw new JsonValidationError(checked.error.message);
      return {
        output: checked.data,
        validationRepairs,
        validationRepairDetail: validationRepairs > 0
          ? { edge: response.repair, browser: repairsByField, total: validationRepairs }
          : undefined,
      };
    });
    return {
      output: result.value.output,
      model: result.response.model,
      usage: result.response.usage,
      jsonRetries: result.retries,
      validationRepairs: result.value.validationRepairs,
      validationRepairDetail: result.value.validationRepairDetail,
      rawRequest: { ...prompts, model: this.config.model, evalKind: opts.evalKind },
      rawResponse: result.value.validationRepairDetail
        ? {
            output: result.rawResponses.length === 1
              ? result.rawResponses[0]
              : result.rawResponses,
            repair: result.value.validationRepairDetail,
          }
        : result.rawResponses.length === 1 ? result.rawResponses[0] : result.rawResponses,
    };
  }

  async speak(
    ctx: BuddyContext,
    evalOutput: EvalOutput,
    opts: CallOpts,
  ): Promise<ProviderResult<SpeechOutput>> {
    const prompts = buildSpeechPrompt(ctx, evalOutput, this.prompts);
    const result = await this.callWithValidation<SpeechOutput>('speech', prompts, opts, (value) => {
      const checked = speechOutputSchema.safeParse(value);
      if (!checked.success) throw new JsonValidationError(checked.error.message);
      if ([...checked.data.text.trim()].length > MAX_PUBLIC_SPEECH_CHARS) {
        throw new JsonValidationError(
          `発言が${MAX_PUBLIC_SPEECH_CHARS}文字を超えています`,
        );
      }
      return checked.data;
    });
    return {
      output: result.value,
      model: result.response.model,
      usage: result.response.usage,
      jsonRetries: result.retries,
      rawRequest: { ...prompts, model: this.config.model },
      rawResponse: result.rawResponses.length === 1 ? result.rawResponses[0] : result.rawResponses,
    };
  }

  private async callWithValidation<T>(
    callType: 'eval' | 'speech',
    prompts: { system: string; user: string },
    opts: CallOpts,
    validate: (value: unknown, response: ProxyResponse) => T,
  ): Promise<{
    value: T;
    response: ProxyResponse;
    retries: number;
    rawResponses: unknown[];
  }> {
    let lastError: unknown = null;
    let inputTokens = 0;
    let outputTokens = 0;
    const rawResponses: unknown[] = [];
    for (let attempt = 0; attempt <= this.config.jsonRetries; attempt++) {
      try {
        const response = await this.call(callType, prompts, opts, attempt);
        inputTokens += response.usage.inputTokens;
        outputTokens += response.usage.outputTokens;
        rawResponses.push(response.output);
        return {
          value: validate(response.output, response),
          response: {
            ...response,
            // JSON再試行も実際の有料コールなので、成功試行だけでなく合算する。
            usage: { inputTokens, outputTokens },
          },
          retries: attempt,
          rawResponses,
        };
      } catch (error) {
        lastError = error;
        if (!(error instanceof JsonValidationError)) throw error;
        if (error.billable) {
          inputTokens += error.billable.usage.inputTokens;
          outputTokens += error.billable.usage.outputTokens;
          rawResponses.push(...error.billable.rawResponses);
        }
        if (attempt === this.config.jsonRetries) {
          throw new JsonValidationError(error.message, {
            model: error.billable?.model ?? this.config.model,
            usage: { inputTokens, outputTokens },
            retries: attempt,
            rawResponses,
          });
        }
      }
    }
    throw lastError ?? new JsonValidationError('構造化出力を取得できませんでした');
  }

  private async call(
    callType: 'eval' | 'speech',
    prompts: { system: string; user: string },
    opts: CallOpts,
    attempt: number,
  ): Promise<ProxyResponse> {
    const accessCode = getLabAccessCode();
    if (!accessCode) throw new Error('愛言葉のセッションがありません。再ログインしてください');
    if (opts.deadlineAt != null && Date.now() >= opts.deadlineAt) {
      throw new DOMException('討論時間が終了しました', 'AbortError');
    }
    const controller = new AbortController();
    const deadlineRemaining = opts.deadlineAt == null
      ? this.config.timeoutMs
      : Math.max(1, opts.deadlineAt - Date.now());
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(this.config.timeoutMs, deadlineRemaining),
    );
    try {
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Lab-Access': encodeLabAccessHeader(accessCode),
        },
        signal: controller.signal,
        body: JSON.stringify({
          action: 'generate',
          callType,
          model: this.config.model,
          system: prompts.system,
          user:
            attempt === 0
              ? prompts.user
              : `${prompts.user}\n\n前回は構造検証に失敗しました。指定スキーマへ厳密に従ってください。`,
          maxTokens:
            callType === 'eval' ? this.config.maxTokensEval : this.config.maxTokensSpeech,
          temperature: this.config.temperature,
          effort: this.config.effort,
          requestId: opts.stepLabel,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | (ProxyResponse & { error?: string; detail?: unknown })
        | null;
      if (!response.ok || !body) {
        const message = body?.error ?? `Live AI中継 HTTP ${response.status}`;
        if (
          response.status === 422 &&
          body &&
          typeof body.model === 'string' &&
          typeof body.usage?.inputTokens === 'number' &&
          typeof body.usage?.outputTokens === 'number'
        ) {
          throw new JsonValidationError(message, {
            model: body.model,
            usage: body.usage,
            retries: 0,
            rawResponses: [body.detail ?? body.output ?? null],
          });
        }
        if (response.status === 422) throw new JsonValidationError(message);
        throw new Error(message);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}

function estimateCost(
  models: ModelsConfig,
  providerName: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const provider = models.providers[providerName];
  if (!provider || (provider.type !== 'labProxy' && provider.type !== 'anthropic')) return 0;
  const price = provider.prices[model];
  if (!price) return 0;
  return (
    (inputTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok
  );
}

export class BrowserAiEngine implements AiEngineLike {
  private mock = new MockProvider(0);
  private live: LabProxyProvider | null = null;
  constructor(
    private models: ModelsConfig,
    private prompts: PromptSet,
    private now: () => number = () => Date.now(),
  ) {}

  evaluate(providerName: string, pairId: PairId, ctx: BuddyContext, opts: CallOpts) {
    return this.run<EvalOutput>(providerName, pairId, 'eval', opts, (provider) =>
      provider.evaluate(ctx, opts), () => this.mock.evaluate(ctx, opts));
  }

  speak(
    providerName: string,
    pairId: PairId,
    ctx: BuddyContext,
    evalOutput: EvalOutput,
    opts: CallOpts,
  ) {
    return this.run<SpeechOutput>(providerName, pairId, 'speech', opts, (provider) =>
      provider.speak(ctx, evalOutput, opts), () => this.mock.speak(ctx, evalOutput, opts));
  }

  private provider(name: string): MockProvider | LabProxyProvider {
    const config = this.models.providers[name];
    if (!config) throw new Error(`不明なプロバイダー: ${name}`);
    if (config.type === 'mock') return this.mock;
    if (config.type !== 'labProxy') throw new Error(`${name}は公開Web Labでは使用できません`);
    this.live ??= new LabProxyProvider(config, this.prompts);
    return this.live;
  }

  private async run<T>(
    providerName: string,
    pairId: PairId,
    callType: 'eval' | 'speech',
    opts: CallOpts,
    execute: (provider: MockProvider | LabProxyProvider) => Promise<ProviderResult<T>>,
    fallback: () => Promise<ProviderResult<T>>,
  ): Promise<{ output: T; record: AiCallRecord }> {
    const started = this.now();
    let result: ProviderResult<T>;
    let error: string | undefined;
    let usedFallback = false;
    let ok = true;
    try {
      result = await execute(this.provider(providerName));
    } catch (cause) {
      if (opts.deadlineAt != null && this.now() >= opts.deadlineAt) throw cause;
      error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      usedFallback = true;
      ok = false;
      const fallbackResult = await fallback();
      result = cause instanceof JsonValidationError && cause.billable
        ? {
            ...fallbackResult,
            model: cause.billable.model,
            usage: cause.billable.usage,
            jsonRetries: cause.billable.retries,
            rawResponse: cause.billable.rawResponses,
          }
        : fallbackResult;
    }
    const record: AiCallRecord = {
      id: `call-${opts.stepLabel}-${callType}`,
      ts: started,
      pairId,
      callType,
      evalKind: callType === 'eval' ? opts.evalKind : undefined,
      provider: providerName,
      model: result.model,
      latencyMs: this.now() - started,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: estimateCost(
        this.models,
        providerName,
        result.model,
        result.usage.inputTokens,
        result.usage.outputTokens,
      ),
      retries: result.jsonRetries,
      jsonErrors:
        result.jsonRetries +
        (result.validationRepairs ?? 0) +
        (usedFallback && error?.includes('JsonValidation') ? 1 : 0),
      validationRepairs: result.validationRepairs,
      ok,
      usedFallback,
      error,
      rawRequest: result.rawRequest,
      rawResponse: result.rawResponse,
    };
    return { output: result.output, record };
  }
}
