import { COST_GUARD, createHandler, type GuardState } from './index.ts';

function assert(condition: unknown, message = 'assertion failed'): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message = 'values differ'): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const ACCESS = 'local-test-code';

function state(now = 1_000): GuardState {
  return { active: 0, windowStartedAt: now, callsInWindow: 0 };
}

async function env(overrides: Record<string, string> = {}): Promise<(name: string) => string | undefined> {
  const values: Record<string, string> = {
    AI_BUDDY_LAB_ACCESS_SHA256: await sha256(ACCESS),
    OPENROUTER_API_KEY: 'test-key-not-a-secret',
    ...overrides,
  };
  return (name) => values[name];
}

function request(body: Record<string, unknown>): Request {
  return new Request('https://example.invalid/functions/v1/ai-buddy-lab', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Lab-Access': ACCESS,
      Origin: 'https://new31005.github.io',
    },
    body: JSON.stringify(body),
  });
}

function speechBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'generate',
    callType: 'speech',
    model: 'anthropic/claude-sonnet-5',
    system: 'system',
    user: 'user',
    maxTokens: 9_999,
    effort: 'high',
    requestId: 'test-request',
    ...overrides,
  };
}

function openRouterSpeech(): Response {
  return Response.json({
    model: 'anthropic/claude-sonnet-5',
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    choices: [{ message: { content: JSON.stringify({ text: '発言', accusesId: null }) } }],
  });
}

function openRouterEval(): Response {
  return Response.json({
    model: 'anthropic/claude-sonnet-5',
    usage: { prompt_tokens: 20, completion_tokens: 10 },
    choices: [{
      message: {
        content: JSON.stringify({
          suspicions: [],
          attackPriorities: [],
          skillTargetPriorities: [],
          primaryHypothesis: '仮説',
          altHypotheses: [],
          confidence: 10,
          toShare: [],
          toWithhold: [],
          questionTargetId: null,
          questionTheme: null,
          voteCandidateId: null,
          reasonSummary: '理由',
        }),
      },
    }],
  });
}

Deno.test('output tokens and reasoning effort are capped at the Edge boundary', async () => {
  const forwardedBodies: Record<string, unknown>[] = [];
  const handler = createHandler({
    envGet: await env(),
    now: () => 1_000,
    state: state(),
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwardedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return openRouterSpeech();
    }) as typeof fetch,
  });

  const response = await handler(request(speechBody()));
  assertEquals(response.status, 200);
  const forwarded = forwardedBodies[0];
  assert(forwarded);
  assertEquals(forwarded.max_tokens, COST_GUARD.maxOutputTokens.speech);
  assertEquals(forwarded.reasoning, { effort: 'low', exclude: true });
  assertEquals(response.headers.get('X-AIBW-Budget-Remaining'), '319');
});

Deno.test('evaluation output uses its separate token cap', async () => {
  const forwardedBodies: Record<string, unknown>[] = [];
  const handler = createHandler({
    envGet: await env(),
    now: () => 1_000,
    state: state(),
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwardedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return openRouterEval();
    }) as typeof fetch,
  });
  const response = await handler(request(speechBody({ callType: 'eval' })));
  assertEquals(response.status, 200);
  const forwarded = forwardedBodies[0];
  assert(forwarded);
  assertEquals(forwarded.max_tokens, COST_GUARD.maxOutputTokens.eval);
});

Deno.test('invalid structured output still returns billable usage for cost accounting', async () => {
  const handler = createHandler({
    envGet: await env(),
    state: state(),
    fetch: (async () => Response.json({
      model: 'anthropic/claude-sonnet-5',
      usage: { prompt_tokens: 123, completion_tokens: 45 },
      choices: [{ message: { content: '{"unexpected":true}' } }],
    })) as typeof fetch,
  });
  const response = await handler(request(speechBody()));
  const body = await response.json() as {
    model?: string;
    usage?: { inputTokens?: number; outputTokens?: number };
  };
  assertEquals(response.status, 422);
  assertEquals(body.model, 'anthropic/claude-sonnet-5');
  assertEquals(body.usage, { inputTokens: 123, outputTokens: 45 });
});

Deno.test('oversized request bodies are rejected before OpenRouter', async () => {
  let fetchCount = 0;
  const handler = createHandler({
    envGet: await env(),
    state: state(),
    fetch: (async () => {
      fetchCount += 1;
      return openRouterSpeech();
    }) as typeof fetch,
  });
  const response = await handler(request({ action: 'auth', padding: 'x'.repeat(COST_GUARD.maxBodyBytes) }));
  assertEquals(response.status, 413);
  assertEquals(fetchCount, 0);
});

Deno.test('prompt character limits are enforced at the Edge boundary', async () => {
  let fetchCount = 0;
  const handler = createHandler({
    envGet: await env(),
    state: state(),
    fetch: (async () => {
      fetchCount += 1;
      return openRouterSpeech();
    }) as typeof fetch,
  });
  const response = await handler(request(speechBody({ user: 'x'.repeat(COST_GUARD.maxUserChars + 1) })));
  assertEquals(response.status, 400);
  assertEquals(fetchCount, 0);
});

Deno.test('kill switch stops generation while keeping auth available', async () => {
  let fetchCount = 0;
  const handler = createHandler({
    envGet: await env({ AI_BUDDY_LAB_LIVE_DISABLED: 'true' }),
    state: state(),
    fetch: (async () => {
      fetchCount += 1;
      return openRouterSpeech();
    }) as typeof fetch,
  });
  const authResponse = await handler(request({ action: 'auth' }));
  const generateResponse = await handler(request(speechBody()));
  assertEquals(authResponse.status, 200);
  assertEquals(generateResponse.status, 503);
  assertEquals(fetchCount, 0);
});

Deno.test('per-isolate rolling call budget rejects excess generation', async () => {
  const handler = createHandler({
    envGet: await env({ AI_BUDDY_LAB_MAX_CALLS_PER_WINDOW: '1' }),
    now: () => 1_000,
    state: state(),
    fetch: (async () => openRouterSpeech()) as typeof fetch,
  });
  const first = await handler(request(speechBody({ requestId: 'first' })));
  const second = await handler(request(speechBody({ requestId: 'second' })));
  assertEquals(first.status, 200);
  assertEquals(second.status, 429);
  assertEquals(second.headers.get('X-AIBW-Budget-Remaining'), '0');
  assert(Number(second.headers.get('Retry-After')) > 0);
});

Deno.test('per-isolate concurrent generation limit rejects overflow', async () => {
  let releaseFetch: () => void = () => undefined;
  let markEntered: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const handler = createHandler({
    envGet: await env({ AI_BUDDY_LAB_MAX_CONCURRENT: '1' }),
    now: () => 1_000,
    state: state(),
    fetch: (async () => {
      markEntered();
      await blocked;
      return openRouterSpeech();
    }) as typeof fetch,
  });

  const firstPromise = handler(request(speechBody({ requestId: 'first' })));
  await entered;
  const second = await handler(request(speechBody({ requestId: 'second' })));
  assertEquals(second.status, 429);
  assertEquals(second.headers.get('Retry-After'), '2');
  releaseFetch();
  const first = await firstPromise;
  assertEquals(first.status, 200);
});
