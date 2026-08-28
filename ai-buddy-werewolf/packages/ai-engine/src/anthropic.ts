/**
 * Anthropic (Claude) プロバイダー。
 * - APIキーはサーバー側の環境変数のみから解決する(クライアントへ渡さない)
 * - 評価コールは構造化出力(JSON Schema検証)を使用
 * - JSON検証失敗時は再試行し、上限を超えたら例外(呼び出し側がモックへフォールバック)
 *
 * モデル名・単価・温度・トークン上限などは config/models.json で変更する。
 * ここ以外のコードに Anthropic API の仕様を書かないこと。
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
// SDKのzodヘルパーは zod/v4 API を要求する(zod 3.25+ が同梱するサブパス)
import { z } from 'zod/v4';
import type { AnthropicProviderConfig, EvalOutput, PairId, SpeechOutput } from '@aibw/shared';
import { evalOutputSchema } from '@aibw/shared';
import type { BuddyContext } from '@aibw/game-core';
import { buildEvalPrompt, buildSpeechPrompt } from './promptBuilder.js';
import type { CallOpts, LlmProvider, PromptSet, ProviderResult } from './provider.js';

// 構造化出力用スキーマ。
// Recordは厳密スキーマと相性が悪いため、API層では配列で受けて内部型へ変換する。
const scoreEntry = z.object({
  targetId: z.string(),
  score: z.number().min(0).max(100),
});
const evalApiSchema = z.object({
  suspicions: z.array(scoreEntry),
  attackPriorities: z.array(scoreEntry),
  skillTargetPriorities: z.array(scoreEntry),
  primaryHypothesis: z.string(),
  altHypotheses: z.array(z.string()),
  confidence: z.number().min(0).max(100),
  toShare: z.array(z.string()),
  toWithhold: z.array(z.string()),
  questionTargetId: z.string().nullable(),
  questionTheme: z.string().nullable(),
  voteCandidateId: z.string().nullable(),
  reasonSummary: z.string(),
});
const speechApiSchema = z.object({
  text: z.string(),
  accusesId: z.string().nullable(),
  declaredRole: z.enum(['villager', 'seer', 'guardian', 'medium', 'werewolf']).nullable(),
});

function toRecord(entries: { targetId: string; score: number }[]): Record<PairId, number> {
  const out: Record<PairId, number> = {};
  for (const e of entries) out[e.targetId] = e.score;
  return out;
}

export class JsonValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonValidationError';
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly name: string;
  private client: Anthropic;
  constructor(
    name: string,
    private config: AnthropicProviderConfig,
    private prompts: PromptSet,
    env: Record<string, string | undefined> = process.env,
  ) {
    this.name = name;
    this.client = new Anthropic({
      apiKey: env[config.apiKeyEnv],
      timeout: config.timeoutMs,
      maxRetries: config.maxRetries,
    });
  }

  async evaluate(ctx: BuddyContext, opts: CallOpts): Promise<ProviderResult<EvalOutput>> {
    const prompts = this.requirePrompts();
    const { system, user } = buildEvalPrompt(ctx, prompts);
    const { parsed, usage, jsonRetries, raw } = await this.callStructured(
      system,
      user,
      evalApiSchema,
      this.config.maxTokensEval,
      `eval-${opts.stepLabel}`,
    );
    const mapped: EvalOutput = {
      suspicions: toRecord(parsed.suspicions),
      attackPriorities:
        parsed.attackPriorities.length > 0 ? toRecord(parsed.attackPriorities) : undefined,
      skillTargetPriorities:
        parsed.skillTargetPriorities.length > 0
          ? toRecord(parsed.skillTargetPriorities)
          : undefined,
      primaryHypothesis: parsed.primaryHypothesis.slice(0, 400),
      altHypotheses: parsed.altHypotheses.slice(0, 3).map((s) => s.slice(0, 400)),
      confidence: parsed.confidence,
      toShare: parsed.toShare.slice(0, 5).map((s) => s.slice(0, 200)),
      toWithhold: parsed.toWithhold.slice(0, 5).map((s) => s.slice(0, 200)),
      questionTargetId: parsed.questionTargetId,
      questionTheme: parsed.questionTheme,
      voteCandidateId: parsed.voteCandidateId,
      reasonSummary: parsed.reasonSummary.slice(0, 500),
    };
    const checked = evalOutputSchema.safeParse(mapped);
    if (!checked.success) {
      throw new JsonValidationError(`評価出力の検証に失敗: ${checked.error.message}`);
    }
    return {
      output: checked.data,
      model: this.config.model,
      usage,
      jsonRetries,
      rawRequest: { system, user, model: this.config.model },
      rawResponse: raw,
    };
  }

  async speak(
    ctx: BuddyContext,
    evalOutput: EvalOutput,
    opts: CallOpts,
  ): Promise<ProviderResult<SpeechOutput>> {
    const prompts = this.requirePrompts();
    const { system, user } = buildSpeechPrompt(ctx, evalOutput, prompts);
    const { parsed, usage, jsonRetries, raw } = await this.callStructured(
      system,
      user,
      speechApiSchema,
      this.config.maxTokensSpeech,
      `speech-${opts.stepLabel}`,
    );
    return {
      output: {
        text: parsed.text.slice(0, 1200),
        accusesId: parsed.accusesId,
        declaredRole: parsed.declaredRole,
      },
      model: this.config.model,
      usage,
      jsonRetries,
      rawRequest: { system, user, model: this.config.model },
      rawResponse: raw,
    };
  }

  private requirePrompts(): PromptSet {
    return this.prompts;
  }

  private async callStructured<T>(
    system: string,
    user: string,
    schema: z.ZodType<T>,
    maxTokens: number,
    _label: string,
  ): Promise<{
    parsed: T;
    usage: { inputTokens: number; outputTokens: number };
    jsonRetries: number;
    raw: unknown;
  }> {
    let inputTokens = 0;
    let outputTokens = 0;
    let lastError: unknown = null;
    const attempts = this.config.jsonRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const params: Parameters<typeof this.client.messages.parse>[0] = {
        model: this.config.model,
        max_tokens: maxTokens,
        system,
        messages: [
          {
            role: 'user',
            content:
              attempt === 0
                ? user
                : `${user}\n\n(前回の出力はスキーマ検証に失敗しました。指定された構造に厳密に従ってください)`,
          },
        ],
        output_config: {
          format: zodOutputFormat(schema),
          effort: this.config.effort,
        },
      };
      if (this.config.temperature != null) {
        params.temperature = this.config.temperature;
      }
      const response = await this.client.messages.parse(params);
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      if (response.parsed_output != null) {
        return {
          parsed: response.parsed_output,
          usage: { inputTokens, outputTokens },
          jsonRetries: attempt,
          raw: response.parsed_output,
        };
      }
      lastError = new JsonValidationError(
        `構造化出力の解析に失敗 (stop_reason=${response.stop_reason})`,
      );
    }
    throw lastError ?? new JsonValidationError('構造化出力の解析に失敗');
  }
}
