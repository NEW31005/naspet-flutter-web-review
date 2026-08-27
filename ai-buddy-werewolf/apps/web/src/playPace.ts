export const PLAY_PACES = ['fast', 'standard', 'relaxed', 'manual'] as const;

export type PlayPace = (typeof PLAY_PACES)[number];

const PACE_LABEL: Record<PlayPace, string> = {
  fast: '速い',
  standard: '標準',
  relaxed: 'ゆっくり',
  manual: '手動',
};

const SPEECH_DELAY_MS: Record<Exclude<PlayPace, 'manual'>, number> = {
  fast: 450,
  standard: 1_800,
  relaxed: 3_200,
};

// モックは生成が一瞬なので、そのままだと150秒枠を数十秒で使い切ってしまう。
// 自由討論だけは人が読める発言間隔を作り、Liveは実通信の待ち時間をそのまま使う。
const TIMED_MOCK_BATCH_DELAY_MS: Record<Exclude<PlayPace, 'manual'>, number> = {
  fast: 2_000,
  standard: 6_500,
  relaxed: 10_000,
};

export function normalizePlayPace(value: string | null | undefined): PlayPace {
  return PLAY_PACES.includes(value as PlayPace) ? (value as PlayPace) : 'standard';
}

export function nextPlayPace(current: PlayPace): PlayPace {
  const index = PLAY_PACES.indexOf(current);
  return PLAY_PACES[(index + 1) % PLAY_PACES.length] ?? 'standard';
}

export function playPaceLabel(pace: PlayPace): string {
  return PACE_LABEL[pace];
}

/** 手動時はnull。発言以外の短いフェーズ遷移は共通で450ms待つ。 */
export function playPaceDelay(pace: PlayPace, isSpeechStep: boolean): number | null {
  if (pace === 'manual') return null;
  return isSpeechStep ? SPEECH_DELAY_MS[pace] : 450;
}

export function timedMockBatchDelay(pace: PlayPace): number | null {
  if (pace === 'manual') return null;
  return TIMED_MOCK_BATCH_DELAY_MS[pace];
}
