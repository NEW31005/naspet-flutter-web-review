/** APIクライアント。型はゲームコア/共有パッケージから型のみimportする。 */
import type { MasterView, ReplayData } from '@aibw/game-core';
import type {
  Advice,
  AdviceConfig,
  AiCallRecord,
  BuddiesConfig,
  MatchMetrics,
  MatchRecord,
} from '@aibw/shared';

export interface ViewResponse {
  view: MasterView;
  busy: boolean;
  metrics: MatchMetrics;
  gm?: unknown;
}

export interface MatchSummary {
  matchId: string;
  createdAt: number;
  finishedAt: number | null;
  mode: string;
  provider: string;
  presetId: string;
  seed: string;
  day: number;
  phase: string;
  winner: string | null;
  humanPairId: string | null;
  costUsd: number;
}

export interface ConfigResponse {
  presets: {
    presetId: string;
    label: string;
    version: string;
    pairCount: number;
    roleSetup: { werewolf: number; seer: number };
    maxDays: number;
    advicePerDay: number;
    otherMastersPolicy: string;
  }[];
  advice: AdviceConfig;
  buddies: BuddiesConfig;
  models: {
    version: string;
    defaultProvider: string;
    providers: Record<string, { type: string; model?: string; apiKeyEnv?: string; hasKey?: boolean }>;
  };
  promptVersion: string;
  editable: { config: string[]; prompts: string[] };
}

export interface AdvanceResponse {
  status: 'progressed' | 'waiting' | 'finished';
  task?: string;
  missing?: { pairId: string; input: string }[];
  busy?: boolean;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}

export const api = {
  config: () => req<ConfigResponse>('GET', '/api/config'),
  readFile: (kind: 'config' | 'prompt', name: string) =>
    req<{ text: string }>('GET', `/api/config/file?kind=${kind}&name=${encodeURIComponent(name)}`),
  writeFile: (kind: 'config' | 'prompt', name: string, text: string) =>
    req<{ ok: true }>('PUT', `/api/config/file?kind=${kind}&name=${encodeURIComponent(name)}`, {
      text,
    }),
  matches: () => req<MatchSummary[]>('GET', '/api/matches'),
  createMatch: (params: {
    presetId: string;
    mode: string;
    provider?: string;
    seed?: string;
    humanPairIndex?: number | null;
    rematchOf?: string;
    sameSeed?: boolean;
  }) => req<MatchSummary>('POST', '/api/matches', params),
  view: (id: string, as: string | null) =>
    req<ViewResponse>('GET', `/api/matches/${id}/view${as ? `?as=${as}` : ''}`),
  advance: (id: string) => req<AdvanceResponse>('POST', `/api/matches/${id}/advance`),
  advice: (id: string, pairId: string, advice: Advice) =>
    req<{ ok: true }>('POST', `/api/matches/${id}/advice`, { pairId, advice }),
  trialChoice: (id: string, pairId: string, targetId: string | null) =>
    req<{ ok: true }>('POST', `/api/matches/${id}/trial-choice`, { pairId, targetId }),
  nightProposal: (id: string, pairId: string, targetId: string | null) =>
    req<{ ok: true }>('POST', `/api/matches/${id}/night-proposal`, { pairId, targetId }),
  rewind: (id: string) => req<{ ok: true }>('POST', `/api/matches/${id}/rewind`),
  reloadAi: (id: string) => req<{ ok: true }>('POST', `/api/matches/${id}/reload-ai`),
  deleteMatch: (id: string) => req<{ ok: true }>('DELETE', `/api/matches/${id}`),
  replay: (id: string, lab: boolean) =>
    req<ReplayData>('GET', `/api/matches/${id}/replay${lab ? '?lab=1' : ''}`),
  calls: (id: string) => req<AiCallRecord[]>('GET', `/api/matches/${id}/calls`),
  exportRecord: (id: string) => req<MatchRecord>('GET', `/api/matches/${id}/export`),
};

export type { MasterView, ReplayData, Advice, AiCallRecord, MatchRecord, MatchMetrics };
