/** Node APIと公開Web Labのブラウザ内バックエンドを同じ契約で扱う。 */
import type { MasterView, ReplayData } from '@aibw/game-core';
import type {
  Advice,
  AdviceConfig,
  AiCallRecord,
  BuddiesConfig,
  MatchMetrics,
  MatchRecord,
  MobileHandoffBundle,
} from '@aibw/shared';
import { BrowserBackend } from './runtime/browserBackend.js';
import { isStaticLab } from './runtime/access.js';
import { callsCsv, evalsCsv } from './runtime/csv.js';
import {
  createMobileHandoffBundle,
  createMobileHandoffBundleFromFiles,
  importMobileHandoffBundle,
  validateMobileHandoffBundle,
} from './runtime/staticConfig.js';

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
    providers: Record<
      string,
      { type: string; model?: string; apiKeyEnv?: string; hasKey?: boolean }
    >;
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

interface CreateParams {
  presetId: string;
  mode: string;
  provider?: string;
  seed?: string;
  humanPairIndex?: number | null;
  rematchOf?: string;
  sameSeed?: boolean;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

function resolved<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function download(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function serverEffectiveFiles(): Promise<Record<string, string>> {
  const config = await req<ConfigResponse>('GET', '/api/config');
  const entries = await Promise.all([
    ...config.editable.config.map(async (name) => [
      `config/${name}`,
      (await req<{ text: string }>(
        'GET',
        `/api/config/file?kind=config&name=${encodeURIComponent(name)}`,
      )).text,
    ] as const),
    ...config.editable.prompts.map(async (name) => [
      `prompts/${name}`,
      (await req<{ text: string }>(
        'GET',
        `/api/config/file?kind=prompt&name=${encodeURIComponent(name)}`,
      )).text,
    ] as const),
  ]);
  return Object.fromEntries(entries);
}

async function serverImportBundle(value: unknown): Promise<void> {
  const bundle = await validateMobileHandoffBundle(value);
  for (const [path, text] of Object.entries(bundle.files)) {
    const kind = path.startsWith('config/') ? 'config' : 'prompt';
    const name = path.replace(/^config\//, '').replace(/^prompts\//, '');
    await req(
      'PUT',
      `/api/config/file?kind=${kind}&name=${encodeURIComponent(name)}`,
      { text },
    );
  }
}

export interface ApiClient {
  config(): Promise<ConfigResponse>;
  readFile(kind: 'config' | 'prompt', name: string): Promise<{ text: string }>;
  writeFile(kind: 'config' | 'prompt', name: string, text: string): Promise<{ ok: true }>;
  matches(): Promise<MatchSummary[]>;
  createMatch(params: CreateParams): Promise<MatchSummary>;
  view(id: string, as: string | null): Promise<ViewResponse>;
  advance(id: string): Promise<AdvanceResponse>;
  advice(id: string, pairId: string, advice: Advice): Promise<{ ok: true }>;
  trialChoice(id: string, pairId: string, targetId: string | null): Promise<{ ok: true }>;
  nightProposal(id: string, pairId: string, targetId: string | null): Promise<{ ok: true }>;
  rewind(id: string): Promise<{ ok: true }>;
  reloadAi(id: string): Promise<{ ok: true }>;
  deleteMatch(id: string): Promise<{ ok: true }>;
  replay(id: string, lab: boolean): Promise<ReplayData>;
  calls(id: string): Promise<AiCallRecord[]>;
  exportRecord(id: string): Promise<MatchRecord>;
  downloadRecord(id: string): Promise<void>;
  downloadCsv(id: string, type: 'evals' | 'calls'): Promise<void>;
  exportMobileBundle(): Promise<MobileHandoffBundle>;
  importMobileBundle(bundle: unknown): Promise<void>;
}

const serverApi: ApiClient = {
  config: () => req('GET', '/api/config'),
  readFile: (kind, name) =>
    req('GET', `/api/config/file?kind=${kind}&name=${encodeURIComponent(name)}`),
  writeFile: (kind, name, text) =>
    req('PUT', `/api/config/file?kind=${kind}&name=${encodeURIComponent(name)}`, { text }),
  matches: () => req('GET', '/api/matches'),
  createMatch: (params) => req('POST', '/api/matches', params),
  view: (id, as) => req('GET', `/api/matches/${id}/view${as ? `?as=${as}` : ''}`),
  advance: (id) => req('POST', `/api/matches/${id}/advance`),
  advice: (id, pairId, advice) => req('POST', `/api/matches/${id}/advice`, { pairId, advice }),
  trialChoice: (id, pairId, targetId) =>
    req('POST', `/api/matches/${id}/trial-choice`, { pairId, targetId }),
  nightProposal: (id, pairId, targetId) =>
    req('POST', `/api/matches/${id}/night-proposal`, { pairId, targetId }),
  rewind: (id) => req('POST', `/api/matches/${id}/rewind`),
  reloadAi: (id) => req('POST', `/api/matches/${id}/reload-ai`),
  deleteMatch: (id) => req('DELETE', `/api/matches/${id}`),
  replay: (id, lab) => req('GET', `/api/matches/${id}/replay${lab ? '?lab=1' : ''}`),
  calls: (id) => req('GET', `/api/matches/${id}/calls`),
  exportRecord: (id) => req('GET', `/api/matches/${id}/export`),
  downloadRecord: async (id) => {
    window.open(`/api/matches/${id}/export`, '_blank');
  },
  downloadCsv: async (id, type) => {
    window.open(`/api/matches/${id}/export.csv?type=${type}`, '_blank');
  },
  exportMobileBundle: async () => createMobileHandoffBundleFromFiles(await serverEffectiveFiles()),
  importMobileBundle: serverImportBundle,
};

const backend = isStaticLab ? new BrowserBackend() : null;
const local = (): BrowserBackend => {
  if (!backend) throw new Error('ブラウザ内バックエンドが有効ではありません');
  return backend;
};

const browserApi: ApiClient = {
  config: () => resolved(() => local().config()),
  readFile: (kind, name) => resolved(() => local().readFile(kind, name)),
  writeFile: (kind, name, text) => resolved(() => local().writeFile(kind, name, text)),
  matches: () => resolved(() => local().matches()),
  createMatch: (params) => resolved(() => local().create(params)),
  view: (id, as) => resolved(() => local().view(id, as)),
  advance: (id) => local().advance(id),
  advice: (id, pairId, advice) =>
    resolved(() => (local().submitAdvice(id, pairId, advice), { ok: true as const })),
  trialChoice: (id, pairId, targetId) =>
    resolved(() => (local().submitTrialChoice(id, pairId, targetId), { ok: true as const })),
  nightProposal: (id, pairId, targetId) =>
    resolved(() => (local().submitNightProposal(id, pairId, targetId), { ok: true as const })),
  rewind: (id) => resolved(() => (local().rewind(id), { ok: true as const })),
  reloadAi: (id) => resolved(() => (local().reloadAi(id), { ok: true as const })),
  deleteMatch: (id) => resolved(() => (local().delete(id), { ok: true as const })),
  replay: (id, lab) => resolved(() => local().replay(id, lab)),
  calls: (id) => resolved(() => local().record(id).aiCalls),
  exportRecord: (id) => resolved(() => local().record(id)),
  downloadRecord: (id) =>
    resolved(() => {
      const record = local().record(id);
      download(`${id}.json`, JSON.stringify(record, null, 2), 'application/json');
    }),
  downloadCsv: (id, type) =>
    resolved(() => {
      const record = local().record(id);
      const csv = type === 'calls' ? callsCsv(record) : evalsCsv(record);
      download(`${id}-${type}.csv`, csv, 'text/csv;charset=utf-8');
    }),
  exportMobileBundle: createMobileHandoffBundle,
  importMobileBundle: importMobileHandoffBundle,
};

export const api: ApiClient = isStaticLab ? browserApi : serverApi;

export type {
  MasterView,
  ReplayData,
  Advice,
  AiCallRecord,
  MatchRecord,
  MatchMetrics,
  MobileHandoffBundle,
};
