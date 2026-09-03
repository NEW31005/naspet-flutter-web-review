/**
 * AIコール実行層。
 * - プロバイダー呼び出しのレイテンシー/トークン/原価/リトライを記録
 * - 失敗時はモックAIによる決定論的フォールバック
 */
import type {
  AiCallRecord,
  EvalOutput,
  ModelsConfig,
  PairId,
  ProviderConfig,
  SpeechOutput,
} from '@aibw/shared';
import type { BuddyContext } from '@aibw/game-core';
import { AnthropicProvider } from './anthropic.js';
import { MockProvider } from './mock.js';
import type { CallOpts, LlmProvider, PromptSet, ProviderResult } from './provider.js';

export function createProvider(
  name: string,
  config: ProviderConfig,
  prompts: PromptSet,
  env: Record<string, string | undefined> = process.env,
): LlmProvider {
  switch (config.type) {
    case 'mock':
      return new MockProvider(config.simulatedLatencyMs);
    case 'anthropic':
      return new AnthropicProvider(name, config, prompts, env);
    case 'labProxy':
      throw new Error('labProxyは公開Web Lab専用です');
  }
}

export function estimateCostUsd(
  models: ModelsConfig,
  providerName: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const provider = models.providers[providerName];
  if (!provider || (provider.type !== 'anthropic' && provider.type !== 'labProxy')) return 0;
  const price = provider.prices[model];
  if (!price) return 0;
  return (
    (inputTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok
  );
}

export interface AiEngineOptions {
  models: ModelsConfig;
  prompts: PromptSet;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export class AiEngine {
  private providers = new Map<string, LlmProvider>();
  private fallback: MockProvider;
  private now: () => number;
  constructor(private options: AiEngineOptions) {
    this.fallback = new MockProvider(0);
    this.now = options.now ?? (() => Date.now());
  }

  getProvider(name: string): LlmProvider {
    let p = this.providers.get(name);
    if (!p) {
      const config = this.options.models.providers[name];
      if (!config) throw new Error(`不明なプロバイダー: ${name}`);
      p = createProvider(name, config, this.options.prompts, this.options.env ?? process.env);
      this.providers.set(name, p);
    }
    return p;
  }

  async evaluate(
    providerName: string,
    pairId: PairId,
    ctx: BuddyContext,
    opts: CallOpts,
  ): Promise<{ output: EvalOutput; record: AiCallRecord }> {
    return this.run<EvalOutput>(
      providerName,
      pairId,
      'eval',
      opts,
      (p) => p.evaluate(ctx, opts),
      () => this.fallback.evaluate(ctx, opts),
    );
  }

  async speak(
    providerName: string,
    pairId: PairId,
    ctx: BuddyContext,
    evalOutput: EvalOutput,
    opts: CallOpts,
  ): Promise<{ output: SpeechOutput; record: AiCallRecord }> {
    return this.run<SpeechOutput>(
      providerName,
      pairId,
      'speech',
      opts,
      (p) => p.speak(ctx, evalOutput, opts),
      () => this.fallback.speak(ctx, evalOutput, opts),
    );
  }

  private async run<T>(
    providerName: string,
    pairId: PairId,
    callType: 'eval' | 'speech',
    opts: CallOpts,
    exec: (p: LlmProvider) => Promise<ProviderResult<T>>,
    execFallback: () => Promise<ProviderResult<T>>,
  ): Promise<{ output: T; record: AiCallRecord }> {
    const start = this.now();
    const id = `call-${opts.stepLabel}-${callType}`;
    let result: ProviderResult<T>;
    let error: string | undefined;
    let usedFallback = false;
    let ok = true;
    try {
      result = await exec(this.getProvider(providerName));
    } catch (e) {
      if (opts.deadlineAt != null && this.now() >= opts.deadlineAt) throw e;
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      usedFallback = true;
      ok = false;
      result = await execFallback();
    }
    const latencyMs = this.now() - start;
    const record: AiCallRecord = {
      id,
      ts: start,
      pairId,
      callType,
      evalKind: callType === 'eval' ? opts.evalKind : undefined,
      provider: providerName,
      model: result.model,
      latencyMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: estimateCostUsd(
        this.options.models,
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
