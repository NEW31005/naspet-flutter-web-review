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
