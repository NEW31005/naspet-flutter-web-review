/**
 * ゲーム全体で共有する型定義。
 * ここが唯一の「言葉の定義」置き場。game-core / ai-engine / server / web すべてがこれを使う。
 */

export type PairId = string; // "p1", "p2", ...
export type Role = 'villager' | 'seer' | 'guardian' | 'medium' | 'werewolf';
export type Team = 'citizens' | 'wolves';
export type Winner = Team | 'draw';

export type Phase =
  | 'day_start' // 朝: 前夜の結果発表
  | 'discussion' // 討論(時間制または従来の順番制で公開発言)
  | 'trial' // 裁判: 主人の意思表示を収集
  | 'night' // 夜: 占い/襲撃
  | 'finished';

export type MatchMode = 'play' | 'lab';

/**
 * 2幕討論の現在地。
 * timed は opening → awaiting_master_advice → response、従来turnsは advice を使う。
 */
export type DiscussionStage = 'opening' | 'advice' | 'awaiting_master_advice' | 'response';
export type DiscussionCloseReason = 'time_up' | 'message_limit';

/** 公開発言の会話上の役割。質問と回答を発言順でも明示する。 */
export type DiscussionTurnKind =
  | 'opening'
  | 'opening_defense'
  | 'opening_opinion'
  | 'question'
  | 'answer'
  | 'follow_up'
  | 'reaction';

export interface DiscussionQuestionRef {
  askerId: PairId;
  targetId: PairId;
  themeId: string;
}

export interface DiscussionTurn {
  pairId: PairId;
  round: number;
  kind: DiscussionTurnKind;
  question?: DiscussionQuestionRef;
  /** 名指し・疑いを受けて返答する場合の直前話者。 */
  replyToId?: PairId;
}

/** 他の主人(非人間)の助言ポリシー */
export type MasterPolicy = 'none' | 'random' | 'simple' | 'ai';

export const ROLE_TEAM: Record<Role, Team> = {
  villager: 'citizens',
  seer: 'citizens',
  guardian: 'citizens',
  medium: 'citizens',
  werewolf: 'wolves',
};

export const ROLE_LABEL: Record<Role, string> = {
  villager: '市民',
  seer: '占い師',
  guardian: '騎士',
  medium: '霊媒師',
  werewolf: '狼憑き',
};

// ---------------------------------------------------------------------------
// バディ(AI相棒)
// ---------------------------------------------------------------------------

/** 対戦能力(0-100)。人格とは独立に判断へ影響する。 */
export interface Abilities {
  reasoning: number; // 推論力
  deception: number; // 虚言力
  trust: number; // 信頼度(主人の主観情報をどれだけ重く扱うか)
}

/** 人格・口調(表現にのみ影響し、判断には影響させない) */
export interface Persona {
  name: string;
  firstPerson: string; // 一人称
  masterCall: string; // 主人の呼び方
  look: string; // 見た目の説明
  personality: string; // 性格
  speechStyle: string; // 話し方・口調
  verbosity: 'short' | 'medium' | 'long'; // 発言の長さ
  emotion: string; // 感情表現の傾向
  archetype: string; // ギャル/執事/クール など
  /** モックAIが語尾等に使う素材(LiveAIでは使わない) */
  mockFlavor: {
    endings: string[];
    exclamations: string[];
  };
}

export interface BuddyConfig {
  id: string;
  persona: Persona;
  abilities: Abilities;
}

export interface PairSetup {
  pairId: PairId;
  masterName: string;
  buddy: BuddyConfig;
}

// ---------------------------------------------------------------------------
// 助言(主人 → バディ)
// ---------------------------------------------------------------------------

export type AdviceKind =
  | 'suspicion' // 主観的な疑い
  | 'question' // 質問の指定
  | 'fact_share' // 確定情報の共有
  | 'skill_target' // 次回スキル対象の提案
  | 'role_claim' // 公開の役職宣言を提案
  | 'behavior'; // 立ち回りの提案

export type Advice =
  | { kind: 'suspicion'; targetId: PairId }
  | { kind: 'question'; targetId: PairId; themeId: string }
  | { kind: 'fact_share'; factId: string }
  | { kind: 'skill_target'; targetId: PairId }
  | { kind: 'role_claim'; claimedRole: Role | null }
  | { kind: 'behavior'; directiveId: string };

export interface RoleClaimOption {
  role: Role;
  label: string;
  description: string;
  dangerous: boolean;
}

/** 占い・霊媒で得た確定情報。主人にのみ届き、共有した場合のみバディが知る。 */
export interface Fact {
  id: string;
  day: number; // 判明した日(夜)
  targetId: PairId;
  isWolf: boolean;
  source: 'divination' | 'medium';
}

// ---------------------------------------------------------------------------
// AI評価コールの構造化出力
// ---------------------------------------------------------------------------

/**
 * 評価コールの返却値。自然文のChain of Thoughtは保持しない。
 * スコアはすべて 0-100。キーは対象のPairId。
 */
export interface EvalOutput {
  suspicions: Record<PairId, number>; // 怪しい度
  attackPriorities?: Record<PairId, number>; // 襲撃優先度(狼のみ)
  skillTargetPriorities?: Record<PairId, number>; // 占い先優先度(占い役のみ)
  primaryHypothesis: string; // 主要仮説(短文)
  altHypotheses: string[]; // 別の可能性(0-3件)
  confidence: number; // 確信度 0-100
  toShare: string[]; // 公開すべきと考えている情報
  toWithhold: string[]; // 伏せるべきと考えている情報
  questionTargetId: PairId | null; // 次に質問したい相手
  questionTheme: string | null; // 質問したいテーマ
  voteCandidateId: PairId | null; // 現時点の投票候補
  reasonSummary: string; // 短い判断理由(ゲーム調整用)
}

export interface SpeechOutput {
  text: string;
  accusesId: PairId | null; // 発言中で主に疑いを向けた相手(いなければnull)
  /** 発言内で公開宣言した役職。宣言しない場合はnull。旧保存データでは省略される。 */
  declaredRole?: Role | null;
}

/** 公開討論で許可するAI発言の最大文字数。短いラリーを全プロバイダーで揃える。 */
export const MAX_PUBLIC_SPEECH_CHARS = 120;

export type EvalKind = 'discussion' | 'vote' | 'night';

// ---------------------------------------------------------------------------
// イベント(イベントソーシング)
// ---------------------------------------------------------------------------

/**
 * 可視範囲。
 * - public: 全員(円卓公開情報)
 * - gm: ゲームマスターのみ(試合後リプレイ/Lab専用)
 * - pairs: 指定した組のみ。part で主人側/バディ側/両方を区別する。
 *   例: 占い結果は part='master'(主人のみ)。バディへは自動共有されない。
 */
export type Visibility =
  | { kind: 'public' }
  | { kind: 'gm' }
  | { kind: 'pairs'; pairIds: PairId[]; part: 'master' | 'buddy' | 'both' };

export interface MatchEventBase {
  seq: number;
  ts: number;
  day: number;
  phase: Phase;
  visibility: Visibility;
}

export type MatchEvent = MatchEventBase &
  (
    | {
        type: 'match_created';
        payload: {
          matchId: string;
          seed: string;
          mode: MatchMode;
          provider: string;
          humanPairId: PairId | null;
          otherMastersPolicy: MasterPolicy;
          pairs: PairSetup[];
          configVersions: Record<string, string>;
        };
      }
    | { type: 'roles_assigned'; payload: { roles: Record<PairId, Role> } }
    | { type: 'phase_changed'; payload: { day: number; phase: Phase } }
    | { type: 'discussion_stage_changed'; payload: { stage: DiscussionStage } }
    | { type: 'discussion_advice_skipped'; payload: { pairId: PairId | null } }
    | { type: 'discussion_closed'; payload: { reason: DiscussionCloseReason } }
    | {
        type: 'day_started';
        payload: { day: number; deaths: { pairId: PairId; cause: 'attack' }[] };
      }
    | {
        type: 'speech';
        payload: {
          pairId: PairId;
          round: number;
          turnKind: DiscussionTurnKind;
          question?: DiscussionQuestionRef;
          /** 名指しへの直接返答なら、その発言者。旧イベントとの互換のためoptional。 */
          replyToId?: PairId;
          text: string;
          accusesId: PairId | null;
        };
      }
    | {
        type: 'eval_recorded';
        payload: { pairId: PairId; kind: EvalKind; callId: string; output: EvalOutput };
      }
    | { type: 'advice_given'; payload: { pairId: PairId; advice: Advice } }
    | { type: 'fact_shared'; payload: { pairId: PairId; fact: Fact } }
    | { type: 'role_declared'; payload: { pairId: PairId; claimedRole: Role } }
    | { type: 'trial_choice'; payload: { pairId: PairId; targetId: PairId | null } }
    | {
        type: 'vote_cast';
        payload: {
          pairId: PairId;
          targetId: PairId;
          /** 補正後スコア(gmイベントではないがスコア自体はgm扱いのため別イベントに分離しない) */
        };
      }
    | {
        type: 'vote_detail';
        payload: {
          pairId: PairId;
          baseScores: Record<PairId, number>;
          adjustedScores: Record<PairId, number>;
          masterChoiceId: PairId | null;
          trustBonusApplied: number;
        };
      }
    | {
        type: 'execution';
        payload: { targetId: PairId | null; tally: Record<PairId, number>; tie: boolean };
      }
    | { type: 'night_proposal'; payload: { pairId: PairId; targetId: PairId | null } }
    | {
        type: 'divination';
        payload: { seerPairId: PairId; targetId: PairId; fact: Fact };
      }
    | {
        type: 'divination_detail';
        payload: {
          seerPairId: PairId;
          basePriorities: Record<PairId, number>;
          adjustedPriorities: Record<PairId, number>;
          masterProposalId: PairId | null;
        };
      }
    | {
        type: 'medium_result';
        payload: { mediumPairId: PairId; targetId: PairId; fact: Fact };
      }
    | {
        type: 'guard_resolved';
        payload: {
          guardianPairId: PairId;
          targetId: PairId | null;
          masterProposalId: PairId | null;
        };
      }
    | {
        type: 'guard_detail';
        payload: {
          guardianPairId: PairId;
          basePriorities: Record<PairId, number>;
          adjustedPriorities: Record<PairId, number>;
          masterProposalId: PairId | null;
          targetId: PairId | null;
          attackTargetId: PairId | null;
          blockedAttack: boolean;
        };
      }
    | {
        type: 'attack_detail';
        payload: {
          perWolf: {
            pairId: PairId;
            masterProposalId: PairId | null;
            basePriorities: Record<PairId, number>;
            adjustedPriorities: Record<PairId, number>;
            topCandidateId: PairId | null;
          }[];
          integrated: Record<PairId, number>;
          method: string;
          targetId: PairId | null;
          tie: boolean;
        };
      }
    | {
        type: 'wolf_night_report';
        payload: {
          pairId: PairId; // 狼の組(主人向け表示用)
          masterProposalId: PairId | null;
          buddyTopId: PairId | null;
          finalTargetId: PairId | null;
        };
      }
    | { type: 'attack_resolved'; payload: { targetId: PairId | null } }
    | {
        type: 'match_finished';
        payload: { winner: Winner; roles: Record<PairId, Role>; reason: string };
      }
    | { type: 'rewound'; payload: { toSeq: number; nonce: number } }
    | { type: 'note'; payload: { message: string } }
  );

export type MatchEventType = MatchEvent['type'];

// ---------------------------------------------------------------------------
// AIコール記録(コスト・レイテンシー・生データ)
// ---------------------------------------------------------------------------

export interface AiCallRecord {
  id: string;
  ts: number;
  pairId: PairId;
  callType: 'eval' | 'speech';
  evalKind?: EvalKind;
  provider: string;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  retries: number;
  jsonErrors: number;
  ok: boolean;
  usedFallback: boolean;
  error?: string;
  /** Lab用の生リクエスト/レスポンス(モックは要約のみ) */
  rawRequest?: unknown;
  rawResponse?: unknown;
}

export interface MatchMetrics {
  aiCallCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  aiWaitMs: number; // 純粋なAI待機時間(コールのレイテンシー合計)
  wallClockMs: number | null; // 総試合時間(開始→終了)
  errorCount: number;
  retryCount: number;
  jsonErrorCount: number;
  fallbackCount: number;
}

// ---------------------------------------------------------------------------
// 保存レコード(JSONエクスポートの明示スキーマ)
// ---------------------------------------------------------------------------

export interface MatchRecord {
  schemaVersion: 1;
  matchId: string;
  seed: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  mode: MatchMode;
  provider: string;
  humanPairId: PairId | null;
  configSnapshot: ConfigSnapshot;
  events: MatchEvent[];
  aiCalls: AiCallRecord[];
}

// ---------------------------------------------------------------------------
// 設定(外部ファイル)
// ---------------------------------------------------------------------------

export interface TrustFnConfig {
  type: 'linear' | 'quadratic' | 'none';
  /** 信頼度100のときに加算される最大ボーナス(0-100スケール上) */
  maxBonus: number;
}

export interface RulesConfig {
  version: string;
  presetId: string;
  label: string;
  pairCount: number;
  roleSetup: {
    werewolf: number;
    seer: number;
    /** 旧presetでは省略可(0として扱う)。 */
    guardian?: number;
    /** 旧presetでは省略可(0として扱う)。 */
    medium?: number;
  }; // 残りは市民
  maxDays: number;
  /** 初日の朝に占い役へ0日目占い結果を1件配る。true=ランダム対象 / 'white'=白確定のみ(古典の初日白通知) */
  firstNightDivination: boolean | 'white';
  /** 初日に抽選で討論の焦点へ置く人数。0なら通常の冒頭討論。 */
  firstDayFocusCount: number;
  /** timed=制限時間内に各AIが独立して発言 / turns=従来の固定順。 */
  discussionMode: 'timed' | 'turns';
  /** 時間制討論の制限時間(秒)。 */
  discussionDurationSec: number;
  /** 暴走と原価超過を防ぐ1日あたりの公開発言上限。 */
  discussionMaxMessages: number;
  /** 同じ公開ログを読んで並列に考えるAIの最大数。 */
  discussionBatchSize: number;
  /** 時間制討論で、追加相談の区切りを入れるまでに必要な応答発言数。旧設定は3。 */
  discussionAdviceIntervalMessages?: number;
  discussionRounds: number; // 1日の討論周回数
  speechesPerBuddyPerRound: number; // 周回ごとの各バディ発言回数
  advicePerDay: number; // 主人の討論中助言回数
  tieBreak: 'random'; // 同票処理(現状seed付きランダムのみ)
  revealRoleOnDeath: boolean;
  wolfAttackIntegration: { method: 'sumNormalized'; tieBreak: 'random' };
  trust: {
    trialChoice: TrustFnConfig; // 裁判時の主人選択の補正
    nightProposal: TrustFnConfig; // 夜襲提案の補正
    skillProposal: TrustFnConfig; // スキル対象提案の補正
    subjectiveAdvice: TrustFnConfig; // 主観的な疑い助言の補正(評価時)
  };
  otherMastersPolicy: MasterPolicy;
}

export interface QuestionTheme {
  id: string;
  label: string;
  /** モックAIが使う質問文テンプレート({target}が対象名に置換される) */
  mockTemplate: string;
  /** LiveAIプロンプトに渡す説明 */
  promptHint: string;
}

export interface BehaviorDirective {
  id: string;
  label: string;
  promptHint: string;
}

export interface AdviceMenuItem {
  kind: AdviceKind;
  label: string;
  description: string;
  enabled: boolean;
}

export interface AdviceConfig {
  version: string;
  menu: AdviceMenuItem[];
  questionThemes: QuestionTheme[];
  behaviorDirectives: BehaviorDirective[];
  roleClaimOptions: RoleClaimOption[];
}

export interface AbilityUnlock {
  at: number; // このポイント以上でアンロック
  id: string;
  label: string;
  promptHint: string; // LiveAIプロンプトへ入る説明
}

export interface AbilitiesConfig {
  version: string;
  reasoningUnlocks: AbilityUnlock[];
  deceptionUnlocks: AbilityUnlock[];
}

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface AnthropicProviderConfig {
  type: 'anthropic';
  apiKeyEnv: string;
  model: string;
  /** Claude 5系モデルはtemperature非対応のためnull推奨(nullなら送信しない) */
  temperature: number | null;
  maxTokensEval: number;
  maxTokensSpeech: number;
  effort: 'low' | 'medium' | 'high';
  timeoutMs: number;
  maxRetries: number; // SDKレベルの通信リトライ
  jsonRetries: number; // JSON検証失敗時の再試行回数
  prices: Record<string, ModelPrice>;
}

export interface MockProviderConfig {
  type: 'mock';
  /** モックの擬似レイテンシー(ms)。0で即時。 */
  simulatedLatencyMs: number;
}

/**
 * 公開Web Lab専用の安全なLLM中継。
 * APIキーはSupabase Edge Function側だけに置き、ブラウザは合言葉と
 * 生成条件だけを送る。endpoint自体は秘密情報ではない。
 */
export interface LabProxyProviderConfig {
  type: 'labProxy';
  endpoint: string;
  model: string;
  temperature: number | null;
  maxTokensEval: number;
  maxTokensSpeech: number;
  effort: 'low' | 'medium' | 'high';
  timeoutMs: number;
  jsonRetries: number;
  prices: Record<string, ModelPrice>;
}

export type ProviderConfig = AnthropicProviderConfig | MockProviderConfig | LabProxyProviderConfig;

export interface ModelsConfig {
  version: string;
  defaultProvider: string;
  providers: Record<string, ProviderConfig>;
}

/** v1互換: 旧13ファイル構成。 */
export const MOBILE_HANDOFF_V1_FILE_PATHS = [
  'config/presets/quick-test.json',
  'config/presets/pack-test.json',
  'config/advice.json',
  'config/abilities.json',
  'config/models.json',
  'config/buddies.json',
  'prompts/system.base.md',
  'prompts/eval.md',
  'prompts/speech.md',
  'prompts/role.villager.md',
  'prompts/role.seer.md',
  'prompts/role.werewolf.md',
  'prompts/version.json',
] as const;

/** v2/current: 9組プリセットと騎士・霊媒プロンプトを追加した16ファイル構成。 */
export const MOBILE_HANDOFF_FILE_PATHS = [
  'config/presets/quick-test.json',
  'config/presets/pack-test.json',
  'config/presets/standard-nine.json',
  'config/advice.json',
  'config/abilities.json',
  'config/models.json',
  'config/buddies.json',
  'prompts/system.base.md',
  'prompts/eval.md',
  'prompts/speech.md',
  'prompts/role.villager.md',
  'prompts/role.seer.md',
  'prompts/role.guardian.md',
  'prompts/role.medium.md',
  'prompts/role.werewolf.md',
  'prompts/version.json',
] as const;

export interface BuddiesConfig {
  version: string;
  roster: BuddyConfig[];
}

export interface MobileHandoffBundle {
  schemaVersion: 1 | 2;
  kind: 'ai-buddy-werewolf-mobile-handoff';
  exportedAt: string;
  source: {
    app: 'ai-buddy-werewolf-phase0-web-lab';
    configVersions: Record<string, string>;
  };
  files: Record<string, string>;
  integrity: { algorithm: 'SHA-256'; digest: string };
  implementationContract: {
    gameCore: 'authoritative-event-engine';
    prompts: 'server-side-only';
    secretsIncluded: false;
    mobileTransport: 'server-api' | 'supabase-edge-function';
  };
}

/** 試合作成時に確定する設定スナップショット(この内容で1試合が動く) */
export interface ConfigSnapshot {
  rules: RulesConfig;
  advice: AdviceConfig;
  abilities: AbilitiesConfig;
  models: ModelsConfig;
  buddies: BuddyConfig[]; // この試合で使うロスター(pair順)
  promptVersion: string;
  versions: Record<string, string>;
}
