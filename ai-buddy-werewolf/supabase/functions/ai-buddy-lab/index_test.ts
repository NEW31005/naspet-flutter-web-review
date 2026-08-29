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
    choices: [{
      message: {
        content: JSON.stringify({ text: '発言', accusesId: null, declaredRole: null }),
      },
    }],
  });
}

function evalOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

function openRouterEval(output: Record<string, unknown> = evalOutput()): Response {
  return Response.json({
    model: 'anthropic/claude-sonnet-5',
    usage: { prompt_tokens: 20, completion_tokens: 10 },
    choices: [{
      message: {
        content: JSON.stringify(output),
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

Deno.test('speech longer than 120 characters is rejected at the Edge boundary', async () => {
  const handler = createHandler({
    envGet: await env(),
    now: () => 1_000,
    state: state(),
    fetch: (async () => Response.json({
      model: 'anthropic/claude-sonnet-5',
      usage: { prompt_tokens: 10, completion_tokens: 80 },
      choices: [{
        message: {
          content: JSON.stringify({
            text: '長'.repeat(121),
            accusesId: null,
            declaredRole: null,
          }),
        },
      }],
    })) as typeof fetch,
  });

  const response = await handler(request(speechBody()));
  assertEquals(response.status, 422);
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

Deno.test('one malformed evaluation score entry is dropped and reported without a retry', async () => {
  const handler = createHandler({
    envGet: await env(),
    state: state(),
    fetch: (async () => openRouterEval(evalOutput({
      suspicions: [
        { targetId: 'p2', score: 72 },
        { targetId: 'p3' },
      ],
    }))) as typeof fetch,
  });
  const response = await handler(request(speechBody({ callType: 'eval' })));
  const body = await response.json() as Record<string, unknown>;
  assertEquals(response.status, 200);
  assertEquals((body.output as Record<string, unknown>).suspicions, [
    { targetId: 'p2', score: 72 },
  ]);
  assertEquals(body.repair, {
    scoreEntriesDropped: 1,
    scoreEntriesNormalized: 0,
    scoreEntriesDroppedByField: {
      suspicions: 1,
      attackPriorities: 0,
      skillTargetPriorities: 0,
    },
    scoreEntriesNormalizedByField: {
      suspicions: 0,
      attackPriorities: 0,
      skillTargetPriorities: 0,
    },
  });
  assertEquals(body.usage, { inputTokens: 20, outputTokens: 10 });
});

Deno.test('extra evaluation score fields are canonicalized and reported', async () => {
  const handler = createHandler({
    envGet: await env(),
    state: state(),
    fetch: (async () => openRouterEval(evalOutput({
      suspicions: [{ targetId: 'p2', score: 64, note: 'remove-me' }],
    }))) as typeof fetch,
  });
  const response = await handler(request(speechBody({ callType: 'eval' })));
  const body = await response.json() as Record<string, unknown>;
  assertEquals(response.status, 200);
  assertEquals((body.output as Record<string, unknown>).suspicions, [
    { targetId: 'p2', score: 64 },
  ]);
  assertEquals(body.repair, {
    scoreEntriesDropped: 0,
    scoreEntriesNormalized: 1,
    scoreEntriesDroppedByField: {
      suspicions: 0,
      attackPriorities: 0,
      skillTargetPriorities: 0,
    },
    scoreEntriesNormalizedByField: {
      suspicions: 1,
      attackPriorities: 0,
      skillTargetPriorities: 0,
    },
  });
});

Deno.test('multiple malformed scores and non-score failures remain rejected', async () => {
  const twoMalformed = createHandler({
    envGet: await env(),
    state: state(),
    fetch: (async () => openRouterEval(evalOutput({
      suspicions: [{ targetId: 'p2' }, { targetId: 'p3', score: 'high' }],
    }))) as typeof fetch,
  });
  assertEquals(
    (await twoMalformed(request(speechBody({ callType: 'eval' })))).status,
    422,
  );

  const twoNormalizations = createHandler({
    envGet: await env(),
    state: state(),
    fetch: (async () => openRouterEval(evalOutput({
      suspicions: [
        { targetId: 'p2', score: 60, note: 'remove-me' },
        { targetId: 'p3', score: 40, note: 'remove-me-too' },
      ],
    }))) as typeof fetch,
  });
  assertEquals(
    (await twoNormalizations(request(speechBody({ callType: 'eval' })))).status,
    422,
  );

  const invalidConfidence = createHandler({
    envGet: await env(),
    state: state(),
    fetch: (async () => openRouterEval(evalOutput({ confidence: 'high' }))) as typeof fetch,
  });
  assertEquals(
    (await invalidConfidence(request(speechBody({ callType: 'eval' })))).status,
    422,
  );
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

Deno.test('speech accepts only supported declared roles', async () => {
  const missing = createHandler({
    envGet: await env(),
    state: state(),
    fetch: (async () => Response.json({
      model: 'anthropic/claude-sonnet-5',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [{
        message: { content: JSON.stringify({ text: '発言', accusesId: null }) },
      }],
    })) as typeof fetch,
  });
  const missingResponse = await missing(request(speechBody()));
  assertEquals(missingResponse.status, 422);

  const invalid = createHandler({
    envGet: await env(),
    state: state(),
    fetch: (async () => Response.json({
      model: 'anthropic/claude-sonnet-5',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [{
        message: {
          content: JSON.stringify({ text: '私は狩人です', accusesId: null, declaredRole: 'hunter' }),
        },
      }],
    })) as typeof fetch,
  });
  const invalidResponse = await invalid(request(speechBody()));
  assertEquals(invalidResponse.status, 422);

  const valid = createHandler({
    envGet: await env(),
    state: state(),
    fetch: (async () => Response.json({
      model: 'anthropic/claude-sonnet-5',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [{
        message: {
          content: JSON.stringify({ text: '私は騎士です', accusesId: null, declaredRole: 'guardian' }),
        },
      }],
    })) as typeof fetch,
  });
  const validResponse = await valid(request(speechBody()));
  assertEquals(validResponse.status, 200);
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
