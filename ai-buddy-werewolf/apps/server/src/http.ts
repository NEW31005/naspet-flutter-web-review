/**
 * HTTPサーバー(依存ゼロの素朴なルーター)。
 * /api/* がJSON API、それ以外は apps/web/dist の静的配信(SPA fallback)。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { adviceSchema } from '@aibw/shared';
import { GameRuleError } from '@aibw/game-core';
import { MatchManager, NotFoundError } from './matches.js';
import { listEditableFiles, readEditableFile, writeEditableFile } from './configLoader.js';
import { callsCsv, evalsCsv } from './csv.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

type Handler = (req: {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function compile(pathPattern: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const regex = pathPattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { pattern: new RegExp(`^${regex}$`), keys };
}

export function createServer(rootDir: string, manager: MatchManager): http.Server {
  const routes: Route[] = [];
  const on = (method: string, pathPattern: string, handler: Handler) => {
    const { pattern, keys } = compile(pathPattern);
    routes.push({ method, pattern, keys, handler });
  };

  // ---- 基本 ----
  on('GET', '/api/health', () => ({ ok: true }));

  // ---- 設定 ----
  on('GET', '/api/config', () => {
    const loaded = manager.loadConfigFresh();
    return {
      presets: Object.values(loaded.rules).map((r) => ({
        presetId: r.presetId,
        label: r.label,
        version: r.version,
        pairCount: r.pairCount,
        roleSetup: r.roleSetup,
        maxDays: r.maxDays,
        discussionMode: r.discussionMode,
        discussionDurationSec: r.discussionDurationSec,
        discussionBatchSize: r.discussionBatchSize,
        discussionAdviceIntervalMessages: r.discussionAdviceIntervalMessages ?? 3,
        discussionRounds: r.discussionRounds,
        advicePerDay: r.advicePerDay,
        otherMastersPolicy: r.otherMastersPolicy,
      })),
      advice: loaded.advice,
      abilities: loaded.abilities,
      buddies: loaded.buddies,
      models: {
        version: loaded.models.version,
        defaultProvider: loaded.models.defaultProvider,
        providers: Object.fromEntries(
          Object.entries(loaded.models.providers).map(([k, v]) => [
            k,
            v.type === 'anthropic'
              ? { type: v.type, model: v.model, apiKeyEnv: v.apiKeyEnv, hasKey: !!process.env[v.apiKeyEnv] }
              : v.type === 'labProxy'
                ? { type: v.type, model: v.model, hasKey: true }
              : { type: v.type },
          ]),
        ),
      },
      promptVersion: loaded.prompts.version,
      editable: listEditableFiles(),
    };
  });
  on('GET', '/api/config/file', ({ query }) => {
    const kind = query.get('kind') === 'prompt' ? 'prompt' : 'config';
    const name = query.get('name') ?? '';
    return { name, kind, text: readEditableFile(rootDir, kind, name) };
  });
  on('PUT', '/api/config/file', ({ query, body }) => {
    const kind = query.get('kind') === 'prompt' ? 'prompt' : 'config';
    const name = query.get('name') ?? '';
    const text = (body as { text?: string })?.text;
    if (typeof text !== 'string') throw new BadRequest('textが必要です');
    writeEditableFile(rootDir, kind, name, text);
    return { ok: true };
  });

  // ---- 試合 ----
  on('GET', '/api/matches', () => manager.listMatches());
  on('POST', '/api/matches', ({ body }) => {
    const b = body as {
      presetId?: string;
      mode?: string;
      provider?: string;
      seed?: string;
      humanPairIndex?: number | null;
      rematchOf?: string;
      sameSeed?: boolean;
    };
    const mode = b.mode === 'lab' ? 'lab' : 'play';
    return manager.createMatch({
      presetId: b.presetId ?? 'quick-test',
      mode,
      provider: b.provider,
      seed: b.seed,
      humanPairIndex: b.humanPairIndex,
      rematchOf: b.rematchOf,
      sameSeed: b.sameSeed,
    });
  });
  on('GET', '/api/matches/:id/view', ({ params, query }) => {
    const as = query.get('as');
    const id = params.id ?? '';
    if (as === 'gm') {
      return { gm: manager.getFullState(id), ...manager.getMasterView(id, null) };
    }
    return manager.getMasterView(id, as || null);
  });
  on('POST', '/api/matches/:id/advance', async ({ params }) => {
    return manager.advance(params.id ?? '');
  });
  on('POST', '/api/matches/:id/advice', ({ params, body }) => {
    const b = body as { pairId?: string; advice?: unknown };
    if (!b.pairId) throw new BadRequest('pairIdが必要です');
    const advice = adviceSchema.parse(b.advice);
    manager.submitAdvice(params.id ?? '', b.pairId, advice);
    return { ok: true };
  });
  on('POST', '/api/matches/:id/skip-discussion-advice', ({ params, body }) => {
    const b = body as { pairId?: string };
    if (!b.pairId) throw new BadRequest('pairIdが必要です');
    manager.skipDiscussionAdvice(params.id ?? '', b.pairId);
    return { ok: true };
  });
  on('POST', '/api/matches/:id/trial-choice', ({ params, body }) => {
    const b = body as { pairId?: string; targetId?: string | null };
    if (!b.pairId) throw new BadRequest('pairIdが必要です');
    manager.submitTrialChoice(params.id ?? '', b.pairId, b.targetId ?? null);
    return { ok: true };
  });
  on('POST', '/api/matches/:id/night-proposal', ({ params, body }) => {
    const b = body as { pairId?: string; targetId?: string | null };
    if (!b.pairId) throw new BadRequest('pairIdが必要です');
    manager.submitNightProposal(params.id ?? '', b.pairId, b.targetId ?? null);
    return { ok: true };
  });
  on('POST', '/api/matches/:id/rewind', ({ params }) => {
    manager.rewind(params.id ?? '');
    return { ok: true };
  });
  on('POST', '/api/matches/:id/reload-ai', ({ params }) => {
    manager.reloadAi(params.id ?? '');
    return { ok: true };
  });
  on('DELETE', '/api/matches/:id', ({ params }) => {
    manager.deleteMatch(params.id ?? '');
    return { ok: true };
  });
  on('GET', '/api/matches/:id/replay', ({ params, query }) => {
    return manager.getReplay(params.id ?? '', query.get('lab') === '1');
  });
  on('GET', '/api/matches/:id/calls', ({ params }) => {
    return manager.getRecord(params.id ?? '').aiCalls;
  });
  on('GET', '/api/matches/:id/export', ({ params }) => {
    return manager.getRecord(params.id ?? '');
  });

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // CSVエクスポート(テキスト応答)
    const csvMatch = pathname.match(/^\/api\/matches\/([^/]+)\/export\.csv$/);
    if (csvMatch && req.method === 'GET') {
      try {
        const record = manager.getRecord(csvMatch[1] ?? '');
        const type = url.searchParams.get('type') === 'calls' ? 'calls' : 'evals';
        const csv = type === 'calls' ? callsCsv(record) : evalsCsv(record);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${record.matchId}-${type}.csv"`,
        });
        res.end(csv);
      } catch (e) {
        sendError(res, e);
      }
      return;
    }

    if (pathname.startsWith('/api/')) {
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = pathname.match(route.pattern);
        if (!m) continue;
        const params: Record<string, string> = {};
        route.keys.forEach((k, i) => {
          params[k] = m[i + 1] ?? '';
        });
        try {
          const body = await readBody(req);
          const result = await route.handler({ params, query: url.searchParams, body });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result ?? null));
        } catch (e) {
          sendError(res, e);
        }
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    // 静的配信(ビルド済みWeb)
    serveStatic(rootDir, pathname, res);
  }

  return server;
}

class BadRequest extends Error {}

function sendError(res: http.ServerResponse, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  let status = 500;
  if (e instanceof GameRuleError || e instanceof BadRequest) status = 400;
  else if (e instanceof NotFoundError) status = 404;
  const code = e instanceof GameRuleError ? e.code : undefined;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: message, code }));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'DELETE') return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 2 * 1024 * 1024) throw new BadRequest('リクエストが大きすぎます');
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString('utf-8');
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest('JSONの解析に失敗しました');
  }
}

function serveStatic(rootDir: string, pathname: string, res: http.ServerResponse): void {
  const distDir = path.join(rootDir, 'apps', 'web', 'dist');
  let filePath = path.join(distDir, pathname === '/' ? 'index.html' : pathname.slice(1));
  if (!filePath.startsWith(distDir)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, 'index.html'); // SPA fallback
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<meta charset="utf-8"><p>Webがビルドされていません。<code>npm run build</code> を実行するか、開発時は <code>npm run dev</code> でViteを使ってください。APIは <code>/api/health</code> で確認できます。</p>',
    );
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}
