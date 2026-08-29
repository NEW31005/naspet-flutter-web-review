/**
 * LLMプロバイダー抽象化。
 * ゲームロジックは LlmProvider インターフェースのみに依存し、
 * 特定のモデル・提供会社(Anthropic等)の仕様はプロバイダー実装内に閉じ込める。
 */
import type { EvalKind, EvalOutput, SpeechOutput } from '@aibw/shared';
import type { BuddyContext } from '@aibw/game-core';

export interface CallOpts {
  /** 決定論的モック用のシードとラベル(LiveAIは無視してよい) */
  seed: string;
  nonce: number;
  /** このコールを一意に識別するラベル(例: d1-discussion-p2-3) */
  stepLabel: string;
  evalKind: EvalKind;
  /** 時間制討論の絶対締切。プロバイダーは可能なら通信を中断する。 */
  deadlineAt?: number;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResult<T> {
  output: T;
  model: string;
  usage: ProviderUsage;
  /** JSON検証失敗などプロバイダー内部での再試行回数 */
  jsonRetries: number;
  /** 有料再試行とは別に、許可された狭い範囲で正規化した構造要素数。 */
  validationRepairs?: number;
  validationRepairDetail?: unknown;
  rawRequest?: unknown;
  rawResponse?: unknown;
}

export interface LlmProvider {
  readonly name: string;
  evaluate(ctx: BuddyContext, opts: CallOpts): Promise<ProviderResult<EvalOutput>>;
  speak(
    ctx: BuddyContext,
    evalOutput: EvalOutput,
    opts: CallOpts,
  ): Promise<ProviderResult<SpeechOutput>>;
}

/** プロンプトテンプレート一式(ファイルの読み込みはserver/cli側の責務) */
export interface PromptSet {
  version: string;
  systemBase: string;
  evalTemplate: string;
  speechTemplate: string;
  roleVillager: string;
  roleSeer: string;
  /** 旧static bundleとの互換のため、新役職プロンプトは省略時fallbackを使う。 */
  roleGuardian?: string;
  roleMedium?: string;
  roleWerewolf: string;
}
