const ALLOWED_ORIGINS = new Set([
  'https://new31005.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

const ALLOWED_MODELS = new Set([
  'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-4.8',
  'anthropic/claude-haiku-4.5',
]);

const scoreEntry = {
  type: 'object',
  properties: {
    targetId: { type: 'string' },
    score: { type: 'number', minimum: 0, maximum: 100 },
  },
  required: ['targetId', 'score'],
  additionalProperties: false,
};

const evalSchema = {
  type: 'object',
  properties: {
    suspicions: { type: 'array', items: scoreEntry },
    attackPriorities: { type: 'array', items: scoreEntry },
    skillTargetPriorities: { type: 'array', items: scoreEntry },
    primaryHypothesis: { type: 'string' },
    altHypotheses: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    confidence: { type: 'number', minimum: 0, maximum: 100 },
    toShare: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    toWithhold: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    questionTargetId: { type: ['string', 'null'] },
    questionTheme: { type: ['string', 'null'] },
    voteCandidateId: { type: ['string', 'null'] },
    reasonSummary: { type: 'string' },
  },
  required: [
    'suspicions',
    'attackPriorities',
    'skillTargetPriorities',
    'primaryHypothesis',
    'altHypotheses',
    'confidence',
    'toShare',
    'toWithhold',
    'questionTargetId',
    'questionTheme',
    'voteCandidateId',
    'reasonSummary',
  ],
  additionalProperties: false,
};

const speechSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    accusesId: { type: ['string', 'null'] },
  },
  required: ['text', 'accusesId'],
  additionalProperties: false,
};

function cors(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.has(origin) ? origin : 'null',
    'Access-Control-Allow-Headers': 'content-type,x-lab-access',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    Vary: 'Origin',
  };
}

function json(
  body: unknown,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index++) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

async function authorized(request: Request): Promise<boolean> {
  const expected = Deno.env.get('AI_BUDDY_LAB_ACCESS_SHA256') ?? '';
  const supplied = (request.headers.get('X-Lab-Access') ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
  if (!expected || !supplied || supplied.length > 128) return false;
  return constantTimeEqual(await sha256(supplied), expected);
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function responseText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
    if (typeof record.message === 'string') return record.message;
    return null;
  }
  if (!Array.isArray(value)) return null;

  const parts = value.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (!part || typeof part !== 'object') return [];
    const record = part as Record<string, unknown>;
    if (typeof record.text === 'string') return [record.text];
    if (typeof record.content === 'string') return [record.content];
    return [];
  });
  return parts.length > 0 ? parts.join('') : null;
}

function parseStructuredOutput(value: unknown): unknown | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const rawText = responseText(value);
  if (!rawText) return null;

  const unfenced = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const candidates = [unfenced];
  const firstBrace = unfenced.indexOf('{');
  const lastBrace = unfenced.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(unfenced.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next safely bounded candidate.
    }
  }
  return null;
}

function scoreEntries(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, unknown>;
    return typeof record.targetId === 'string' &&
      typeof record.score === 'number' && record.score >= 0 && record.score <= 100;
  });
}

function stringArray(value: unknown, maxItems: number): boolean {
  return Array.isArray(value) && value.length <= maxItems &&
    value.every((entry) => typeof entry === 'string');
}

function validOutput(callType: 'eval' | 'speech', value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (callType === 'speech') {
    return typeof record.text === 'string' &&
      (record.accusesId === null || typeof record.accusesId === 'string');
  }
  return scoreEntries(record.suspicions) &&
    scoreEntries(record.attackPriorities) &&
    scoreEntries(record.skillTargetPriorities) &&
    typeof record.primaryHypothesis === 'string' &&
    stringArray(record.altHypotheses, 3) &&
    typeof record.confidence === 'number' && record.confidence >= 0 && record.confidence <= 100 &&
    stringArray(record.toShare, 5) &&
    stringArray(record.toWithhold, 5) &&
    (record.questionTargetId === null || typeof record.questionTargetId === 'string') &&
    (record.questionTheme === null || typeof record.questionTheme === 'string') &&
    (record.voteCandidateId === null || typeof record.voteCandidateId === 'string') &&
    typeof record.reasonSummary === 'string';
}

Deno.serve(async (request) => {
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (request.method !== 'POST') return json({ error: 'POSTのみ利用できます' }, 405, origin);
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: '許可されていないOriginです' }, 403, origin);
  if (!(await authorized(request))) {
    return json({ error: '愛言葉が違うみたいです。アクセス情報をもう一度確認してね' }, 401, origin);
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: 'JSON本文が必要です' }, 400, origin);
  if (body.action === 'auth') return json({ ok: true }, 200, origin);
  if (body.action !== 'generate') return json({ error: '不明な操作です' }, 400, origin);

  const callType = body.callType === 'speech' ? 'speech' : body.callType === 'eval' ? 'eval' : null;
  const model = text(body.model, 100);
  const system = text(body.system, 20_000);
  const user = text(body.user, 80_000);
  const requestId = text(body.requestId, 200) ?? crypto.randomUUID();
  if (!callType || !model || !ALLOWED_MODELS.has(model) || !system || !user) {
    return json({ error: '生成条件が不正です' }, 400, origin);
  }

  const maxTokensRaw = typeof body.maxTokens === 'number' ? body.maxTokens : 800;
  const maxTokens = Math.max(128, Math.min(3000, Math.floor(maxTokensRaw)));
  const effort = body.effort === 'high' || body.effort === 'medium' ? body.effort : 'low';
  const apiKey = Deno.env.get('OPENROUTER_API_KEY');
  if (!apiKey) return json({ error: 'Live AIがサーバー側で設定されていません' }, 503, origin);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const selectedSchema = callType === 'eval' ? evalSchema : speechSchema;
    const schemaInstruction = [
      '# 必須の出力形式',
      '説明文、Markdown、コードフェンスを付けず、次のJSON Schemaに厳密一致するJSONオブジェクトだけを返してください。',
      JSON.stringify(selectedSchema),
    ].join('\n');
    const requestBody: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `${user}\n\n${schemaInstruction}` },
      ],
      max_tokens: maxTokens,
      reasoning: { effort, exclude: true },
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: callType === 'eval' ? 'buddy_evaluation' : 'buddy_speech',
          strict: true,
          schema: selectedSchema,
        },
      },
      plugins: [{ id: 'response-healing' }],
      provider: {
        zdr: true,
        data_collection: 'deny',
        allow_fallbacks: true,
        require_parameters: true,
      },
      user: `ai-buddy-lab:${requestId.slice(0, 160)}`,
    };
    if (typeof body.temperature === 'number' && model !== 'anthropic/claude-sonnet-5') {
      requestBody.temperature = Math.max(0, Math.min(1, body.temperature));
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://new31005.github.io/naspet-flutter-web-review/ai-buddy-lab/',
        'X-Title': 'AI Buddy Werewolf Phase0 Lab',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !payload) {
      const error = payload?.error as { message?: unknown } | undefined;
      const message = typeof error?.message === 'string' ? error.message.slice(0, 400) : `OpenRouter HTTP ${response.status}`;
      return json({ error: message }, response.status >= 500 ? 502 : 422, origin);
    }

    const choices = payload.choices as { finish_reason?: unknown; message?: { content?: unknown } }[] | undefined;
    const raw = choices?.[0]?.message?.content;
    const output = parseStructuredOutput(raw);
    if (!validOutput(callType, output)) {
      const preview = responseText(raw)?.slice(0, 240) ?? '';
      return json({
        error: '構造化出力が指定スキーマに一致しませんでした',
        detail: {
          finishReason: choices?.[0]?.finish_reason ?? null,
          contentType: Array.isArray(raw) ? 'array' : typeof raw,
          preview,
        },
      }, 422, origin);
    }
    const usage = payload.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
    return json({
      output,
      model: typeof payload.model === 'string' ? payload.model : model,
      usage: {
        inputTokens: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
        outputTokens: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0,
      },
    }, 200, origin);
  } catch (error) {
    const message = error instanceof DOMException && error.name === 'AbortError'
      ? 'Live AIがタイムアウトしました'
      : 'Live AI中継でエラーが発生しました';
    return json({ error: message }, 504, origin);
  } finally {
    clearTimeout(timer);
  }
});
