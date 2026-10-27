// @ts-check
import assert from 'node:assert/strict';
import { hashLicenseKey } from '../src/auth.js';
import { createWorker } from '../src/worker.js';
import { D1Adapter } from './d1.js';

export const MONTH = '2042-03';
export const BODY = Object.freeze({ model: 'demo-basic', prompt: 'input', max_tokens: 32 });

/**
 * @param {import('node:test').TestContext} t
 * @param {import('../src/worker.js').Options & {cap?: number}} [options]
 */
export async function harness(t, options = {}) {
  const db = new D1Adapter();
  t.after(() => db.close());
  const key = crypto.randomUUID();
  await db.prepare('INSERT INTO licenses (id, key_hash, monthly_cap) VALUES (?, ?, ?)')
    .bind('example-license', await hashLicenseKey(key), options.cap ?? 6000).run();
  /** @type {Readonly<import('../src/worker.js').Metadata>[]} */
  const logs = [];
  const worker = createWorker({
    now: () => new Date(`${MONTH}-18T12:00:00Z`),
    logger: (record) => logs.push(record),
    ...options,
  });
  const env = { DB: db };
  return {
    db, key, logs, worker, env,
    /** @param {unknown} [body] @param {Parameters<typeof request>[2]} [options] */
    send: (body = BODY, options = {}) => worker.fetch(request(key, body, options), env),
  };
}

/**
 * @param {string | null} key
 * @param {unknown} [body]
 * @param {{path?: string, method?: string, raw?: string, contentType?: string}} [options]
 */
export function request(key, body = BODY, {
  path = '/v1/completions', method = 'POST', raw, contentType = 'application/json',
} = {}) {
  const headers = new Headers({ 'content-type': contentType });
  if (key !== null) headers.set('authorization', `Bearer ${key}`);
  return new Request(`https://example.invalid${path}`, {
    method, headers, body: method === 'POST' ? (raw ?? JSON.stringify(body)) : undefined,
  });
}

/** @param {D1Adapter} db @param {string} [month] */
export function budget(db, month = MONTH) {
  const row = db.native.prepare('SELECT * FROM monthly_budgets WHERE license_id = ? AND month = ?')
    .get('example-license', month);
  assert.ok(row);
  return /** @type {{license_id: string, month: string, cap: number, spent: number, reserved: number}} */ ({ ...row });
}

/** @param {D1Adapter} db */
export function assertInvariant(db) {
  const rows = db.native.prepare('SELECT * FROM monthly_budgets').all();
  for (const row of rows) {
    const { spent, reserved, cap } = /** @type {{spent: number, reserved: number, cap: number}} */ (row);
    assert.ok(Number.isSafeInteger(spent) && spent >= 0);
    assert.ok(Number.isSafeInteger(reserved) && reserved >= 0);
    assert.ok(spent + reserved <= cap);
  }
}

export function deferred() {
  /** @type {() => void} */
  let resolve = () => {};
  const promise = new Promise((done) => { resolve = () => done(undefined); });
  return { promise, resolve };
}
