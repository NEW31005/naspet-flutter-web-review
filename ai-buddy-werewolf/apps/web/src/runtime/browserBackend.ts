import type { Advice, MatchMode, MatchRecord, PairId } from '@aibw/shared';
import {
  buildMasterView,
  buildReplayData,
  createMatch,
  rebuildState,
  rewindToPhaseStart,
} from '@aibw/game-core';
import {
  MatchRunner,
  computeMetrics,
  rebuildStore,
  type MatchStore,
} from '@aibw/ai-engine/browser';
import type {
  AdvanceResponse,
  ConfigResponse,
  MatchSummary,
  ViewResponse,
} from '../api.js';
import { BrowserAiEngine } from './browserAi.js';
import {
  buildStaticSnapshot,
  editableFiles,
  loadStaticConfig,
  readStaticFile,
  writeStaticFile,
  type EditableKind,
  type LoadedStaticConfig,
} from './staticConfig.js';

const INDEX_KEY = 'aibw.lab.matches.v1';
const recordKey = (id: string) => `aibw.lab.match.v1:${id}`;

interface Session {
  runner: MatchRunner;
  busy: boolean;
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `m${Date.now().toString(36)}${[...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

function readIndex(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeIndex(ids: string[]): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify([...new Set(ids)]));
}

function saveRecord(record: MatchRecord): void {
  localStorage.setItem(recordKey(record.matchId), JSON.stringify(record));
  writeIndex([record.matchId, ...readIndex()]);
}

function loadRecord(id: string): MatchRecord {
  const text = localStorage.getItem(recordKey(id));
  if (!text) throw new Error(`試合が見つかりません: ${id}`);
  return JSON.parse(text) as MatchRecord;
}

function summaryOf(store: MatchStore): MatchSummary {
  const record = store.record;
  return {
    matchId: record.matchId,
    createdAt: record.createdAt,
    finishedAt: record.finishedAt,
    mode: record.mode,
    provider: record.provider,
    presetId: record.configSnapshot.rules.presetId,
    seed: record.seed,
    day: store.state.day,
    phase: store.state.phase,
    winner: store.state.winner,
    humanPairId: record.humanPairId,
    costUsd: computeMetrics(record).costUsd,
  };
}

export class BrowserBackend {
  private sessions = new Map<string, Session>();

  config(): ConfigResponse {
    const loaded = loadStaticConfig();
    const providers = Object.fromEntries(
      Object.entries(loaded.models.providers)
        .filter(([, value]) => value.type === 'mock' || value.type === 'labProxy')
        .map(([name, value]) => [
          name,
          value.type === 'labProxy'
            ? { type: value.type, model: value.model, hasKey: true }
            : { type: value.type },
        ]),
    );
    return {
      presets: Object.values(loaded.rules).map((rules) => ({
        presetId: rules.presetId,
        label: rules.label,
        version: rules.version,
        pairCount: rules.pairCount,
        roleSetup: rules.roleSetup,
        maxDays: rules.maxDays,
        discussionRounds: rules.discussionRounds,
        advicePerDay: rules.advicePerDay,
        otherMastersPolicy: rules.otherMastersPolicy,
      })),
      advice: loaded.advice,
      buddies: loaded.buddies,
      models: {
        version: loaded.models.version,
        defaultProvider: loaded.models.defaultProvider,
        providers,
      },
      promptVersion: loaded.prompts.version,
      editable: editableFiles(),
    };
  }

  readFile(kind: EditableKind, name: string): { text: string } {
    return { text: readStaticFile(kind, name) };
  }

  writeFile(kind: EditableKind, name: string, text: string): { ok: true } {
    writeStaticFile(kind, name, text);
    return { ok: true };
  }

  matches(): MatchSummary[] {
    const summaries: MatchSummary[] = [];
    for (const id of readIndex()) {
      try {
        summaries.push(summaryOf(this.getSession(id).runner.store));
      } catch {
        // 壊れた/古いレコードは一覧から除外する。
      }
    }
    return summaries.sort((a, b) => b.createdAt - a.createdAt);
  }

  create(params: {
    presetId: string;
    mode: string;
    provider?: string;
    seed?: string;
    humanPairIndex?: number | null;
    rematchOf?: string;
    sameSeed?: boolean;
  }): MatchSummary {
    const loaded = loadStaticConfig();
    const now = Date.now();
    const matchId = randomId();
    let presetId = params.presetId || 'quick-test';
    let mode: MatchMode = params.mode === 'lab' ? 'lab' : 'play';
    let provider = params.provider ?? loaded.models.defaultProvider;
    let humanPairIndex = params.humanPairIndex ?? (mode === 'play' ? 0 : null);
    let seed = params.seed?.trim() || matchId;

    if (params.rematchOf) {
      const previous = this.getSession(params.rematchOf).runner.store.record;
      presetId = previous.configSnapshot.rules.presetId;
      mode = params.mode === 'lab' || params.mode === 'play' ? params.mode : previous.mode;
      provider = params.provider ?? previous.provider;
      humanPairIndex =
        params.humanPairIndex ??
        (previous.humanPairId ? Number(previous.humanPairId.slice(1)) - 1 : null);
      if (params.sameSeed) seed = previous.seed;
    }

    const providerConfig = loaded.models.providers[provider];
    if (!providerConfig || (providerConfig.type !== 'mock' && providerConfig.type !== 'labProxy')) {
      throw new Error(`公開Web Labで使用できないプロバイダーです: ${provider}`);
    }
    const snapshot = buildStaticSnapshot(loaded, presetId);
    const created = createMatch({
      matchId,
      seed,
      mode,
      provider,
      humanPairIndex,
      config: snapshot,
      now,
    });
    const first = created.events[0];
    const record: MatchRecord = {
      schemaVersion: 1,
      matchId,
      seed,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      mode,
      provider,
      humanPairId: first?.type === 'match_created' ? first.payload.humanPairId : null,
      configSnapshot: snapshot,
      events: created.events,
      aiCalls: [],
    };
    const store = rebuildStore(record);
    const session = this.register(store, loaded);
    this.persist(session);
    return summaryOf(store);
  }

  async advance(id: string): Promise<AdvanceResponse> {
    const session = this.getSession(id);
    if (session.busy) return { status: 'waiting', missing: [], busy: true };
    session.busy = true;
    try {
      const result = await session.runner.advanceOnce();
      this.persist(session);
      return result;
    } finally {
      session.busy = false;
    }
  }

  view(id: string, as: string | null): ViewResponse {
    const session = this.getSession(id);
    const store = session.runner.store;
    const pairId = as && as !== 'gm' ? as : null;
    const response: ViewResponse = {
      view: buildMasterView(store.state, pairId),
      busy: session.busy,
      metrics: computeMetrics(store.record),
    };
    if (as === 'gm') {
      response.gm = { state: store.state, metrics: response.metrics, busy: session.busy };
    }
    return response;
  }

  submitAdvice(id: string, pairId: PairId, advice: Advice): void {
    const session = this.getSession(id);
    session.runner.submitAdvice(pairId, advice);
    this.persist(session);
  }

  submitTrialChoice(id: string, pairId: PairId, targetId: PairId | null): void {
    const session = this.getSession(id);
    session.runner.submitTrialChoice(pairId, targetId);
    this.persist(session);
  }

  submitNightProposal(id: string, pairId: PairId, targetId: PairId | null): void {
    const session = this.getSession(id);
    session.runner.submitNightProposal(pairId, targetId);
    this.persist(session);
  }

  rewind(id: string): void {
    const session = this.getSession(id);
    if (session.busy) throw new Error('進行中は巻き戻せません');
    const store = session.runner.store;
    store.record.events = rewindToPhaseStart(
      store.record.events,
      store.record.configSnapshot,
      Date.now(),
    );
    store.record.finishedAt = null;
    store.state = rebuildState(store.record.events, store.record.configSnapshot);
    this.persist(session);
  }

  reloadAi(id: string): void {
    const session = this.getSession(id);
    const loaded = loadStaticConfig();
    const store = session.runner.store;
    store.record.configSnapshot.models = loaded.models;
    store.record.configSnapshot.promptVersion = loaded.prompts.version;
    store.record.configSnapshot.versions.models = loaded.models.version;
    store.record.configSnapshot.versions.prompts = loaded.prompts.version;
    session.runner = new MatchRunner(
      store,
      new BrowserAiEngine(loaded.models, loaded.prompts),
    );
    this.persist(session);
  }

  delete(id: string): void {
    this.sessions.delete(id);
    localStorage.removeItem(recordKey(id));
    writeIndex(readIndex().filter((value) => value !== id));
  }

  replay(id: string, lab: boolean) {
    const store = this.getSession(id).runner.store;
    if (!store.state.winner && !lab) {
      throw new Error('内部スコアは試合終了まで公開されません(Labモードを除く)');
    }
    return buildReplayData(store.state, store.record.events);
  }

  record(id: string): MatchRecord {
    return this.getSession(id).runner.store.record;
  }

  private getSession(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      const record = loadRecord(id);
      session = this.register(rebuildStore(record), loadStaticConfig());
    }
    return session;
  }

  private register(store: MatchStore, loaded: LoadedStaticConfig): Session {
    const session: Session = {
      runner: new MatchRunner(store, new BrowserAiEngine(store.record.configSnapshot.models, loaded.prompts)),
      busy: false,
    };
    this.sessions.set(store.record.matchId, session);
    return session;
  }

  private persist(session: Session): void {
    try {
      saveRecord(session.runner.store.record);
    } catch (error) {
      throw new Error(`ブラウザ保存に失敗しました。古い試合を削除してください: ${String(error)}`);
    }
  }
}
