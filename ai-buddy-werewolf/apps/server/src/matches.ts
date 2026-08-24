/**
 * 試合の管理(作成・進行・永続化・エクスポート)。
 * 永続化は data/matches/{id}.json への素朴なJSON保存(明示スキーマ = MatchRecord)。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Advice, MatchMode, MatchRecord, PairId } from '@aibw/shared';
import {
  buildMasterView,
  buildReplayData,
  createMatch,
  rewindToPhaseStart,
  type MasterView,
  type ReplayData,
} from '@aibw/game-core';
import {
  AiEngine,
  MatchRunner,
  computeMetrics,
  rebuildStore,
  type AdvanceResult,
  type MatchStore,
} from '@aibw/ai-engine';
import { buildSnapshot, loadConfig, type LoadedConfig } from './configLoader.js';

export interface MatchSummary {
  matchId: string;
  createdAt: number;
  finishedAt: number | null;
  mode: MatchMode;
  provider: string;
  presetId: string;
  seed: string;
  day: number;
  phase: string;
  winner: string | null;
  humanPairId: PairId | null;
  costUsd: number;
}

interface Session {
  runner: MatchRunner;
  busy: boolean;
  saveChain: Promise<void>;
}

export class MatchManager {
  private sessions = new Map<string, Session>();
  constructor(
    private rootDir: string,
    private now: () => number = () => Date.now(),
    private dataDir?: string,
  ) {
    fs.mkdirSync(this.matchesDir, { recursive: true });
  }

  private get matchesDir(): string {
    return path.join(this.dataDir ?? path.join(this.rootDir, 'data'), 'matches');
  }
  private fileOf(id: string): string {
    return path.join(this.matchesDir, `${id}.json`);
  }

  loadConfigFresh(): LoadedConfig {
    return loadConfig(this.rootDir);
  }

  createMatch(params: {
    presetId: string;
    mode: MatchMode;
    provider?: string;
    seed?: string;
    humanPairIndex?: number | null;
    rematchOf?: string;
    sameSeed?: boolean;
  }): MatchSummary {
    const loaded = this.loadConfigFresh();
    const now = this.now();
    const matchId = `m${now.toString(36)}${Math.floor(Math.random() * 1296)
      .toString(36)
      .padStart(2, '0')}`;

    let presetId = params.presetId;
    let mode = params.mode;
    let provider = params.provider ?? loaded.models.defaultProvider;
    let humanPairIndex = params.humanPairIndex ?? (params.mode === 'play' ? 0 : null);
    let seed = params.seed?.trim() || matchId;

    if (params.rematchOf) {
      const prev = this.getSession(params.rematchOf).runner.store.record;
      presetId = prev.configSnapshot.rules.presetId;
      mode = params.mode ?? prev.mode;
      provider = params.provider ?? prev.provider;
      humanPairIndex =
        params.humanPairIndex ??
        (prev.humanPairId ? Number(prev.humanPairId.slice(1)) - 1 : null);
      seed = params.sameSeed ? prev.seed : seed;
    }

    if (!loaded.models.providers[provider]) {
      throw new Error(`不明なプロバイダー: ${provider}`);
    }
    const snapshot = buildSnapshot(loaded, presetId);
    const { events } = createMatch({
      matchId,
      seed,
      mode,
      provider,
      humanPairIndex,
      config: snapshot,
      now,
    });
    const record: MatchRecord = {
      schemaVersion: 1,
      matchId,
      seed,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      mode,
      provider,
      humanPairId:
        events[0]?.type === 'match_created' ? events[0].payload.humanPairId : null,
      configSnapshot: snapshot,
      events: [],
      aiCalls: [],
    };
    const store = rebuildStoreFromScratch(record, events);
    const session = this.registerSession(store, loaded);
    this.persist(session);
    return this.summarize(session.runner.store);
  }

  private registerSession(store: MatchStore, loaded: LoadedConfig): Session {
    const ai = new AiEngine({
      models: store.record.configSnapshot.models,
      prompts: loaded.prompts,
      now: this.now,
    });
    const runner = new MatchRunner(store, ai, this.now);
    const session: Session = { runner, busy: false, saveChain: Promise.resolve() };
    this.sessions.set(store.record.matchId, session);
    return session;
  }

  /** プロンプト/モデル設定をディスクから読み直してAIエンジンを再生成(Lab用) */
  reloadAi(matchId: string): void {
    const session = this.getSession(matchId);
    const loaded = this.loadConfigFresh();
    const store = session.runner.store;
    // ルール等のスナップショットは維持し、モデル設定とプロンプトのみ更新
    store.record.configSnapshot.models = loaded.models;
    const ai = new AiEngine({ models: loaded.models, prompts: loaded.prompts, now: this.now });
    session.runner = new MatchRunner(store, ai, this.now);
    this.persist(session);
  }

  getSession(matchId: string): Session {
    let session = this.sessions.get(matchId);
    if (!session) {
      const file = this.fileOf(matchId);
      if (!fs.existsSync(file)) throw new NotFoundError(`試合が見つかりません: ${matchId}`);
      const record = JSON.parse(fs.readFileSync(file, 'utf-8')) as MatchRecord;
      const store = rebuildStore(record);
      session = this.registerSession(store, this.loadConfigFresh());
    }
    return session;
  }

  listMatches(): MatchSummary[] {
    const out: MatchSummary[] = [];
    for (const file of fs.readdirSync(this.matchesDir)) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -5);
      try {
        const session = this.getSession(id);
        out.push(this.summarize(session.runner.store));
      } catch {
        // 壊れたファイルは一覧から除外
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  private summarize(store: MatchStore): MatchSummary {
    const r = store.record;
    const metrics = computeMetrics(r);
    return {
      matchId: r.matchId,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      mode: r.mode,
      provider: r.provider,
      presetId: r.configSnapshot.rules.presetId,
      seed: r.seed,
      day: store.state.day,
      phase: store.state.phase,
      winner: store.state.winner,
      humanPairId: r.humanPairId,
      costUsd: metrics.costUsd,
    };
  }

  async advance(matchId: string): Promise<AdvanceResult & { busy?: boolean }> {
    const session = this.getSession(matchId);
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

  submitAdvice(matchId: string, pairId: PairId, advice: Advice): void {
    const session = this.getSession(matchId);
    session.runner.submitAdvice(pairId, advice);
    this.persist(session);
  }
  submitTrialChoice(matchId: string, pairId: PairId, targetId: PairId | null): void {
    const session = this.getSession(matchId);
    session.runner.submitTrialChoice(pairId, targetId);
    this.persist(session);
  }
  submitNightProposal(matchId: string, pairId: PairId, targetId: PairId | null): void {
    const session = this.getSession(matchId);
    session.runner.submitNightProposal(pairId, targetId);
    this.persist(session);
  }

  /** 現在フェーズの先頭まで巻き戻す(Lab用) */
  rewind(matchId: string): void {
    const session = this.getSession(matchId);
    if (session.busy) throw new Error('進行中は巻き戻せません');
    const store = session.runner.store;
    const truncated = rewindToPhaseStart(
      store.record.events,
      store.record.configSnapshot,
      this.now(),
    );
    store.record.events = truncated;
    store.record.finishedAt = null;
    const rebuilt = rebuildStore(store.record);
    store.state = rebuilt.state;
    this.persist(session);
  }

  deleteMatch(matchId: string): void {
    this.sessions.delete(matchId);
    const file = this.fileOf(matchId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  getMasterView(
    matchId: string,
    as: PairId | 'gm' | null,
  ): { view: MasterView; busy: boolean; metrics: ReturnType<typeof computeMetrics> } {
    const session = this.getSession(matchId);
    const store = session.runner.store;
    const pairId = as && as !== 'gm' ? as : null;
    const view = buildMasterView(store.state, pairId);
    return { view, busy: session.busy, metrics: computeMetrics(store.record) };
  }

  /** 試合後(またはLab)の内部データ */
  getReplay(matchId: string, lab: boolean): ReplayData {
    const session = this.getSession(matchId);
    const store = session.runner.store;
    if (!store.state.winner && !lab) {
      throw new Error('内部スコアは試合終了まで公開されません(Labモードを除く)');
    }
    return buildReplayData(store.state, store.record.events);
  }

  getRecord(matchId: string): MatchRecord {
    return this.getSession(matchId).runner.store.record;
  }

  getFullState(matchId: string): unknown {
    const session = this.getSession(matchId);
    return {
      state: session.runner.store.state,
      metrics: computeMetrics(session.runner.store.record),
      busy: session.busy,
    };
  }

  private persist(session: Session): void {
    const record = session.runner.store.record;
    const file = this.fileOf(record.matchId);
    session.saveChain = session.saveChain.then(async () => {
      const tmp = `${file}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      try {
        await fs.promises.writeFile(tmp, JSON.stringify(record), 'utf-8');
        await fs.promises.rename(tmp, file);
      } catch (e) {
        // 保存失敗で進行を止めない(次のpersistで再保存される)
        console.warn(`[aibw] 保存に失敗: ${record.matchId}`, e);
      }
    });
  }

  async flush(matchId: string): Promise<void> {
    const session = this.sessions.get(matchId);
    if (session) await session.saveChain;
  }
}

export class NotFoundError extends Error {}

function rebuildStoreFromScratch(
  record: MatchRecord,
  events: MatchRecord['events'],
): MatchStore {
  record.events = events;
  return rebuildStore(record);
}
