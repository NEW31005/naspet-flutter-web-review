/** 画面には内部IDではなく、検証者が迷わない日本語名を表示する。 */
export const CONFIG_FILE_META: Record<string, { label: string; description: string }> = {
  'presets/quick-test.json': {
    label: 'クイックテストの全ルール',
    description: '5組で短く試すプリセットの詳細JSONです。',
  },
  'presets/pack-test.json': {
    label: '群れテストの全ルール',
    description: '2組の狼憑きによる夜襲統合を試すプリセットの詳細JSONです。',
  },
  'advice.json': {
    label: '助言メニュー・質問内容',
    description: '主人からバディへ送れる助言と選択肢の詳細JSONです。',
  },
  'abilities.json': {
    label: '推論力・虚言力の成長表',
    description: '能力値によって解放される考え方や嘘の技術です。',
  },
  'models.json': {
    label: 'AIモデル・原価・待ち時間',
    description: 'AI接続先、モデル、上限、単価などの詳細JSONです。',
  },
  'buddies.json': {
    label: '全バディの人格・能力',
    description: 'バディ設定画面で編集できる内容を含む詳細JSONです。',
  },
};

export const PROMPT_FILE_META: Record<string, { label: string; description: string }> = {
  'system.base.md': {
    label: '全バディ共通のルール',
    description: '世界観、勝敗条件、主人との関係、秘密を守る原則を伝えます。',
  },
  'eval.md': {
    label: '推理・内部評価の指示',
    description: '怪しさ、仮説、質問先、投票候補などをAIに整理させます。',
  },
  'speech.md': {
    label: '円卓での発言の指示',
    description: '内部評価を、各バディの人格と口調で公開発言に変えます。',
  },
  'role.villager.md': {
    label: '市民の考え方',
    description: '市民として情報を集め、狼憑きを探すための追加指示です。',
  },
  'role.seer.md': {
    label: '占い役の考え方',
    description: '占い結果の扱い方と、次に占う相手を決める追加指示です。',
  },
  'role.werewolf.md': {
    label: '狼憑きの嘘・判断',
    description: '正体を隠し、仲間と生き残るための追加指示です。',
  },
  'version.json': {
    label: 'プロンプトの版番号',
    description: 'どの指示文で試したかを試合記録へ残す番号です。',
  },
};

export function configFileLabel(name: string): string {
  return CONFIG_FILE_META[name]?.label ?? name;
}

export function promptFileLabel(name: string): string {
  return PROMPT_FILE_META[name]?.label ?? name;
}

export function masterPolicyLabel(policy: string): string {
  switch (policy) {
    case 'none':
      return '助言しない';
    case 'random':
      return 'ランダムに助言する';
    case 'simple':
      return '簡単な自動判断で助言する';
    case 'ai':
      return 'AIが主人役として助言する';
    default:
      return policy;
  }
}

export function providerLabel(name: string, type?: string): string {
  if (name === 'mock' || type === 'mock') return 'モックAI（無料・動作確認向け）';
  if (name === 'lab-live' || type === 'labProxy') return 'Claude Live（実際の会話を検証）';
  if (name === 'anthropic' || type === 'anthropic') return 'Claude Live（ローカル開発用）';
  return name;
}

export function modelLabel(model: string): string {
  const short = model.replace(/^anthropic\//, '');
  const labels: Record<string, string> = {
    'claude-sonnet-5': 'Claude Sonnet 5',
    'claude-opus-5': 'Claude Opus 5',
    'claude-opus-4.8': 'Claude Opus 4.8',
    'claude-haiku-4-5': 'Claude Haiku 4.5',
    'claude-haiku-4.5': 'Claude Haiku 4.5',
    'claude-fable-5': 'Claude Fable 5',
  };
  return labels[short] ?? model;
}

export function modeLabel(mode: string): string {
  return mode === 'play' ? 'プレイテスト' : mode === 'lab' ? '検証室' : mode;
}

export function presetIdLabel(presetId: string): string {
  return presetId === 'quick-test'
    ? 'クイックテスト'
    : presetId === 'pack-test'
      ? '群れテスト'
      : presetId;
}

export function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    setup: '準備',
    day_start: '朝',
    discussion: '討論',
    trial: '裁判',
    night: '夜',
    finished: '終了',
  };
  return labels[phase] ?? phase;
}

export function configVersionLabel(key: string): string {
  const labels: Record<string, string> = {
    rules: 'ルール',
    advice: '助言',
    abilities: '能力',
    models: 'AIモデル',
    buddies: 'バディ',
    prompts: 'プロンプト',
  };
  return labels[key] ?? key;
}

export function pendingLabel(pending: string): string {
  const labels: Record<string, string> = {
    ready: '進行可能',
    wait_inputs: '主人の入力待ち',
    busy: 'AI処理中',
    finished: '試合終了',
  };
  return labels[pending] ?? pending;
}
