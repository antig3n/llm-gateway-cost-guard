// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashLicenseKey } from '../src/auth.js';
import { costUnits, MODELS } from '../src/models.js';
import { fakeProvider } from '../src/provider.js';
import { createWorker } from '../src/worker.js';
import { BODY, MONTH, assertInvariant, budget, deferred, harness, request } from '../test-support/harness.js';

test('valid license completes through the fake provider and pays actual cost', async (t) => {
  const { db, send, logs } = await harness(t);
  const response = await send();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body.usage, { input_tokens: 5, output_tokens: 13 });
  assert.equal(body.cost_units, 106);
  assert.equal(body.output, '.'.repeat(13));
  assert.equal(budget(db).spent, body.cost_units);
  assert.equal(budget(db).reserved, 0);
  assert.equal(logs[0].status, 200);
});

test('license storage contains only a SHA-256 digest and no plaintext column', async (t) => {
  assert.equal(await hashLicenseKey('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const { db, key } = await harness(t);
  const row = await db.prepare('SELECT * FROM licenses').first();
  assert.equal(row?.key_hash, await hashLicenseKey(key));
  assert.match(String(row?.key_hash), /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(row).includes(key), false);
  assert.deepEqual(Object.keys(row ?? {}).sort(), ['id', 'key_hash', 'monthly_cap', 'revoked_at']);
});

test('missing, malformed, and unknown license keys fail before the provider', async (t) => {
  let calls = 0;
  const provider = { ...fakeProvider, async complete(input) { calls++; return fakeProvider.complete(input); } };
  const h = await harness(t, { provider });
  for (const key of [null, 'short', crypto.randomUUID(), await hashLicenseKey(h.key)]) {
    const response = await h.worker.fetch(request(key), h.env);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'license_not_active' });
  }
  assert.equal(calls, 0);
  assert.equal(h.db.native.prepare('SELECT COUNT(*) AS count FROM monthly_budgets').get()?.count, 0);
});

test('revocation is observed on the next call without cached authorization', async (t) => {
  const h = await harness(t);
  assert.equal((await h.send()).status, 200);
  const spent = budget(h.db).spent;
  await h.db.prepare('UPDATE licenses SET revoked_at = ?').bind('2042-03-18').run();
  assert.equal((await h.send()).status, 401);
  assert.equal(budget(h.db).spent, spent);
});

test('revocation between authentication and reservation prevents admission', async (t) => {
  let calls = 0;
  const h = await harness(t, {
    provider: { ...fakeProvider, async complete(input) { calls++; return fakeProvider.complete(input); } },
  });
  h.db.beforeRun = (sql) => {
    if (sql.includes('SET reserved = reserved +')) {
      h.db.native.prepare('UPDATE licenses SET revoked_at = ?').run('2042-03-18');
    }
  };
  assert.equal((await h.send()).status, 429);
  assert.equal(calls, 0);
  assert.equal(budget(h.db).reserved, 0);
});

test('unlisted models and unknown request options are refused', async (t) => {
  const h = await harness(t);
  for (const body of [{ ...BODY, model: 'demo-unlisted' }, { ...BODY, tools: [] }, { ...BODY, stream: true }]) {
    assert.equal((await h.send(body)).status, 400);
  }
  assert.ok(h.logs.every((record) => record.model === null));
});

test('each allowed model accepts its own token limit and rejects larger values', async (t) => {
  const h = await harness(t, { cap: 20000 });
  for (const [model, policy] of Object.entries(MODELS)) {
    assert.equal((await h.send({ ...BODY, model, max_tokens: policy.maxTokens })).status, 200);
    assert.equal((await h.send({ ...BODY, model, max_tokens: policy.maxTokens + 1 })).status, 400);
  }
});

test('malformed bodies and invalid token or prompt values never call the provider', async (t) => {
  let calls = 0;
  const h = await harness(t, {
    provider: { ...fakeProvider, async complete(input) { calls++; return fakeProvider.complete(input); } },
  });
  const bodies = [null, [], 'text', {}, { ...BODY, prompt: '' }, { ...BODY, prompt: 17 },
    { ...BODY, prompt: 'x'.repeat(4097) }, ...[0, -1, 1.5, '32', null].map((max_tokens) => ({ ...BODY, max_tokens }))];
  for (const body of bodies) assert.equal((await h.send(body)).status, 400);
  assert.equal((await h.send(BODY, { raw: '{' })).status, 400);
  assert.equal((await h.send(BODY, { contentType: 'text/plain' })).status, 415);
  assert.equal(calls, 0);
});

test('unknown routes and unsupported methods are handled without accounting', async (t) => {
  const h = await harness(t);
  assert.equal((await h.send(BODY, { path: '/missing' })).status, 404);
  assert.equal((await h.send(BODY, { method: 'GET' })).status, 405);
  assert.equal(h.db.native.prepare('SELECT COUNT(*) AS count FROM monthly_budgets').get()?.count, 0);
});

test('zero cap and insufficient headroom prevent provider work', async (t) => {
  let calls = 0;
  const provider = { ...fakeProvider, async complete(input) { calls++; return fakeProvider.complete(input); } };
  for (const cap of [0, 238]) {
    const h = await harness(t, { cap, provider });
    assert.equal((await h.send()).status, 429);
    assert.equal(budget(h.db).spent + budget(h.db).reserved, 0);
  }
  assert.equal(calls, 0);
});

test('25 simultaneous requests never exceed cap, even while responses are held', { timeout: 4000 }, async (t) => {
  const maximum = costUnits(BODY.model, { input_tokens: 5, output_tokens: BODY.max_tokens });
  const cap = maximum * 4;
  const release = deferred();
  const admitted = deferred();
  let attempts = 0;
  let calls = 0;
  let observedWrites = 0;
  const h = await harness(t, {
    cap,
    provider: {
      ...fakeProvider,
      async complete(input) {
        calls++;
        await release.promise;
        return { text: '.'.repeat(input.max_tokens), usage: { input_tokens: 5, output_tokens: input.max_tokens } };
      },
    },
  });
  h.db.onRun = (sql) => {
    observedWrites++;
    assertInvariant(h.db);
    if (sql.includes('SET reserved = reserved +') && ++attempts === 25) admitted.resolve();
  };
  const pending = Array.from({ length: 25 }, () => h.send());
  try {
    await admitted.promise;
    assert.equal(calls, 4);
    assert.equal(budget(h.db).spent, 0);
    assert.equal(budget(h.db).reserved, cap);
    assert.ok(maximum * 25 > cap);
  } finally {
    release.resolve();
  }
  const responses = await Promise.all(pending);
  assert.equal(responses.filter((response) => response.status === 200).length, 4);
  assert.equal(responses.filter((response) => response.status === 429).length, 21);
  assert.equal(attempts, 25);
  assert.equal(observedWrites, 54);
  assert.equal(budget(h.db).spent, cap);
  assert.equal(budget(h.db).reserved, 0);
  assertInvariant(h.db);
});

test('provider rejection releases the entire hold and permits a later request', async (t) => {
  let shouldFail = true;
  const h = await harness(t, {
    cap: 239,
    provider: {
      ...fakeProvider,
      async complete(input) {
        if (shouldFail) throw new Error('Synthetic failure.');
        return fakeProvider.complete(input);
      },
    },
  });
  assert.equal((await h.send()).status, 502);
  assert.equal(budget(h.db).spent, 0);
  assert.equal(budget(h.db).reserved, 0);
  shouldFail = false;
  assert.equal((await h.send()).status, 200);
  assert.equal(budget(h.db).spent, 106);
});

test('unusable provider accounting consumes the maximum instead of freeing a billed hold', async (t) => {
  const results = [
    { text: 'Synthetic output.', usage: { input_tokens: 5, output_tokens: 33 } },
    { text: 'Synthetic output.', usage: { input_tokens: -1, output_tokens: 1 } },
    { text: 'Synthetic output.', usage: { input_tokens: 6, output_tokens: 1 } },
    { text: 'Synthetic output.', usage: { input_tokens: NaN, output_tokens: 1 } },
    { text: 'Synthetic output.' },
  ];
  let index = 0;
  const h = await harness(t, {
    provider: { ...fakeProvider, async complete() { return results[index++]; } },
  });
  for (let i = 0; i < results.length; i++) assert.equal((await h.send()).status, 502);
  assert.equal(budget(h.db).spent, 239 * results.length);
  assert.equal(budget(h.db).reserved, 0);
});

test('database failure after provider success keeps the hold counted', async (t) => {
  const h = await harness(t);
  h.db.beforeRun = (sql) => {
    if (sql.includes('SET spent')) throw new Error('Synthetic database outage.');
  };
  assert.equal((await h.send()).status, 500);
  assert.equal(budget(h.db).spent, 0);
  assert.equal(budget(h.db).reserved, 239);
});

test('database failure before admission never starts provider work', async (t) => {
  let calls = 0;
  const h = await harness(t, {
    provider: { ...fakeProvider, async complete(input) { calls++; return fakeProvider.complete(input); } },
  });
  h.db.beforeRun = () => { throw new Error('Synthetic database outage.'); };
  assert.equal((await h.send()).status, 500);
  assert.equal(calls, 0);
});

test('month rollover during provider work settles the original month', async (t) => {
  let current = new Date(`${MONTH}-31T23:59:59Z`);
  const h = await harness(t, {
    now: () => current,
    provider: {
      ...fakeProvider,
      async complete(input) {
        current = new Date('2042-04-01T00:00:01Z');
        return fakeProvider.complete(input);
      },
    },
  });
  assert.equal((await h.send()).status, 200);
  assert.equal(budget(h.db).spent, 106);
  assert.equal(budget(h.db).reserved, 0);
  assert.equal((await h.send()).status, 200);
  assert.equal(budget(h.db, '2042-04').spent, 106);
  assert.equal(budget(h.db).spent, 106);
});

test('logs exclude request bodies, response bodies, credentials, and provider exceptions', async (t) => {
  const prompt = 'PRIVATE_REQUEST_SENTINEL';
  const output = 'PRIVATE_RESPONSE_SENTINEL';
  const failure = 'PRIVATE_EXCEPTION_SENTINEL';
  let shouldFail = false;
  const h = await harness(t, {
    provider: {
      ...fakeProvider,
      async complete(input) {
        if (shouldFail) throw new Error(`${failure} ${input.prompt}`);
        return { text: output, usage: { input_tokens: 1, output_tokens: 1 }, extra: prompt };
      },
    },
  });
  assert.equal((await h.send({ ...BODY, prompt })).status, 200);
  shouldFail = true;
  const response = await h.send({ ...BODY, prompt });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'provider_failed' });
  await h.send({ ...BODY, model: prompt });
  const serialized = JSON.stringify(h.logs);
  for (const forbidden of [prompt, output, failure, h.key, await hashLicenseKey(h.key)]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  const fields = ['license_id', 'model', 'input_tokens', 'output_tokens', 'cost_units', 'duration_ms', 'status'].sort();
  for (const record of h.logs) {
    assert.deepEqual(Object.keys(record).sort(), fields);
    assert.ok(record.duration_ms >= 0 && Number.isInteger(record.duration_ms));
  }
});

test('default logger writes only the allowlisted metadata record', async (t) => {
  const h = await harness(t);
  const worker = createWorker();
  const prompt = 'DEFAULT_LOG_PRIVACY_SENTINEL';
  const entries = [];
  const original = console.log;
  console.log = (...values) => entries.push(values);
  try {
    assert.equal((await worker.fetch(request(h.key, { ...BODY, prompt }), h.env)).status, 200);
  } finally {
    console.log = original;
  }
  assert.equal(entries.length, 1);
  assert.equal(entries[0].length, 1);
  const record = JSON.parse(entries[0][0]);
  assert.equal(record.model, BODY.model);
  assert.equal(record.status, 200);
  assert.equal(Object.keys(record).length, 7);
  assert.equal(JSON.stringify(entries).includes(prompt), false);
});

test('logger failure leaves successful accounting intact', async (t) => {
  const h = await harness(t, { logger() { throw new Error('Synthetic telemetry outage.'); } });
  assert.equal((await h.send()).status, 200);
  assert.equal(budget(h.db).spent, 106);
  assert.equal(budget(h.db).reserved, 0);
});

test('execution context retains the operation until settlement completes', async (t) => {
  const h = await harness(t);
  const retained = [];
  const work = h.worker.fetch(request(h.key), h.env, { waitUntil(promise) { retained.push(promise); } });
  assert.equal(retained.length, 1);
  await Promise.all(retained);
  assert.equal((await work).status, 200);
  assert.equal(budget(h.db).spent, 106);
  assert.equal(budget(h.db).reserved, 0);
});

test('fake tokenizer handles Unicode and minimum output limits deterministically', async (t) => {
  const h = await harness(t);
  const response = await h.send({ ...BODY, prompt: '\u{1F680}\u00E9', max_tokens: 1 });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).usage, { input_tokens: 2, output_tokens: 1 });
  assert.equal(budget(h.db).spent, 13);
});
