// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveBudget, utcMonth } from '../src/budget.js';
import { MONTH, assertInvariant, budget, harness } from '../test-support/harness.js';

test('D1 adapter binds parameters and implements first, all, and run', async (t) => {
  const { db } = await harness(t);
  const prepared = db.prepare('SELECT id FROM licenses WHERE id = ?');
  assert.equal((await prepared.bind('example-license').first())?.id, 'example-license');
  assert.equal(await prepared.bind('missing').first(), null);
  assert.equal((await prepared.bind('missing').all()).results.length, 0);
  assert.equal((await prepared.bind('example-license').all()).results.length, 1);
  const result = await db.prepare('UPDATE licenses SET revoked_at = ? WHERE id = ?')
    .bind('2042-03-18', 'missing').run();
  assert.deepEqual(result, { success: true, meta: { changes: 0 } });
});

test('reservation accepts exact headroom and refuses one unit beyond it', async (t) => {
  const { db } = await harness(t, { cap: 173 });
  db.onRun = () => assertInvariant(db);
  const first = await reserveBudget(db, 'example-license', MONTH, 173);
  assert.ok(first);
  assert.equal(await reserveBudget(db, 'example-license', MONTH, 1), null);
  await first.settle(73);
  const second = await reserveBudget(db, 'example-license', MONTH, 100);
  assert.ok(second);
  assert.equal(budget(db).spent + budget(db).reserved, 173);
  await second.release();
  assert.equal(budget(db).spent, 73);
  assert.equal(budget(db).reserved, 0);
});

test('settlement rejects negative, fractional, nonfinite, and excessive costs', async (t) => {
  const { db } = await harness(t);
  const hold = await reserveBudget(db, 'example-license', MONTH, 71);
  assert.ok(hold);
  for (const cost of [-1, 0.5, NaN, Infinity, 72]) {
    await assert.rejects(hold.settle(cost), /Settlement exceeds/);
    assert.equal(budget(db).reserved, 71);
  }
  await hold.settle(31);
  assert.equal(budget(db).spent, 31);
  assert.equal(budget(db).reserved, 0);
});

test('one reservation cannot be closed twice, including overlapping calls', async (t) => {
  const { db } = await harness(t);
  const hold = await reserveBudget(db, 'example-license', MONTH, 71);
  assert.ok(hold);
  const results = await Promise.allSettled([hold.settle(31), hold.release()]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  await assert.rejects(hold.settle(31), /already closed/);
  assert.equal(budget(db).spent, 31);
  assert.equal(budget(db).reserved, 0);
});

test('uncertain settlement keeps its reservation and prevents a later release', async (t) => {
  const { db } = await harness(t);
  const hold = await reserveBudget(db, 'example-license', MONTH, 71);
  assert.ok(hold);
  db.beforeRun = (sql) => {
    if (sql.includes('SET spent')) throw new Error('Simulated storage failure.');
  };
  await assert.rejects(hold.settle(31), /storage failure/);
  await assert.rejects(hold.release(), /already closed/);
  assert.equal(budget(db).reserved, 71);
  assert.equal(budget(db).spent, 0);
});

test('reservation rejects unsafe costs before creating a monthly row', async (t) => {
  const { db } = await harness(t);
  for (const cost of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(reserveBudget(db, 'example-license', MONTH, cost), /Invalid reservation/);
  }
  assert.equal(db.native.prepare('SELECT COUNT(*) AS count FROM monthly_budgets').get()?.count, 0);
});

test('month keys use UTC and a previous month keeps its cap snapshot', async (t) => {
  const { db } = await harness(t, { cap: 173 });
  assert.equal(utcMonth(new Date('2042-04-01T00:30:00+02:00')), MONTH);
  const old = await reserveBudget(db, 'example-license', MONTH, 71);
  assert.ok(old);
  await db.prepare('UPDATE licenses SET monthly_cap = ?').bind(257).run();
  const next = await reserveBudget(db, 'example-license', '2042-04', 71);
  assert.ok(next);
  await old.settle(31);
  assert.equal(budget(db).cap, 173);
  assert.equal(budget(db).spent, 31);
  assert.equal(budget(db).reserved, 0);
  assert.equal(budget(db, '2042-04').cap, 257);
  assert.equal(budget(db, '2042-04').reserved, 71);
  await next.release();
});

test('SQLite constraints reject broken counter invariants', async (t) => {
  const { db } = await harness(t, { cap: 173 });
  const hold = await reserveBudget(db, 'example-license', MONTH, 71);
  assert.ok(hold);
  await assert.rejects(db.prepare('UPDATE monthly_budgets SET spent = 174').run(), /CHECK constraint/);
  await assert.rejects(db.prepare('UPDATE monthly_budgets SET reserved = -1').run(), /CHECK constraint/);
  assertInvariant(db);
  await hold.release();
});
