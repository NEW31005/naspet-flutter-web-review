import type {
  AiCallRecord,
  EvalOutput,
  LabProxyProviderConfig,
  ModelsConfig,
  PairId,
  SpeechOutput,
} from '@aibw/shared';
import { evalOutputSchema, speechOutputSchema } from '@aibw/shared';
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
}

class JsonValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonValidationError';
  }
}

function toScores(entries: ScoreEntry[]): Record<PairId, number> {
  return Object.fromEntries(entries.map((entry) => [entry.targetId, entry.score]));
}

class LabProxyProvider {
  readonly name = 'lab-live';
  constructor(
    private config: LabProxyProviderConfig,
    private prompts: PromptSet,
  ) {}

  async evaluate(ctx: BuddyContext, opts: CallOpts): Promise<ProviderResult<EvalOutput>> {
    const prompts = buildEvalPrompt(ctx, this.prompts);
    const result = await this.callWithValidation<EvalOutput>('eval', prompts, opts, (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new JsonValidationError('評価出力がオブジェクトではありません');
      }
      const raw = value as ProxyEvalOutput;
      if (!Array.isArray(raw.suspicions) || !Array.isArray(raw.attackPriorities) ||
          !Array.isArray(raw.skillTargetPriorities)) {
        throw new JsonValidationError('評価スコア配列が不足しています');
      }
      const mapped = {
        suspicions: toScores(raw.suspicions),
        attackPriorities:
          raw.attackPriorities.length > 0 ? toScores(raw.attackPriorities) : undefined,
        skillTargetPriorities:
          raw.skillTargetPriorities.length > 0 ? toScores(raw.skillTargetPriorities) : undefined,
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
      return checked.data;
    });
    return {
      output: result.value,
      model: result.response.model,
      usage: result.response.usage,
      jsonRetries: result.retries,
      rawRequest: { ...prompts, model: this.config.model, evalKind: opts.evalKind },
      rawResponse: result.response.output,
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
      return checked.data;
    });
    return {
      output: result.value,
      model: result.response.model,
      usage: result.response.usage,
      jsonRetries: result.retries,
      rawRequest: { ...prompts, model: this.config.model },
      rawResponse: result.response.output,
    };
  }

  private async callWithValidation<T>(
    callType: 'eval' | 'speech',
    prompts: { system: string; user: string },
    opts: CallOpts,
    validate: (value: unknown) => T,
  ): Promise<{ value: T; response: ProxyResponse; retries: number }> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.config.jsonRetries; attempt++) {
      try {
        const response = await this.call(callType, prompts, opts, attempt);
        return { value: validate(response.output), response, retries: attempt };
      } catch (error) {
        lastError = error;
        if (!(error instanceof JsonValidationError) || attempt === this.config.jsonRetries) throw error;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
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
        | (ProxyResponse & { error?: string })
        | null;
      if (!response.ok || !body) {
        const message = body?.error ?? `Live AI中継 HTTP ${response.status}`;
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
      error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      usedFallback = true;
      ok = false;
      result = await fallback();
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
      jsonErrors: result.jsonRetries + (usedFallback && error?.includes('JsonValidation') ? 1 : 0),
      ok,
      usedFallback,
      error,
      rawRequest: result.rawRequest,
      rawResponse: result.rawResponse,
    };
    return { output: result.output, record };
  }
}
