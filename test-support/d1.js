// @ts-check
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';

/** Minimal D1 surface backed by real SQLite, with a yield on every operation. */
export class D1Adapter {
  native = new DatabaseSync(':memory:');
  /** @type {(sql: string) => void} */
  beforeRun = () => {};
  /** @type {(sql: string, changes: number) => void} */
  onRun = () => {};

  constructor() {
    this.native.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  }

  /** @param {string} sql @returns {import('../src/types.js').Statement} */
  prepare(sql) {
    return new BoundStatement(this, sql, []);
  }

  close() { this.native.close(); }
}

class BoundStatement {
  /**
   * @param {D1Adapter} db
   * @param {string} sql
   * @param {import('../src/types.js').SqlValue[]} values
   */
  constructor(db, sql, values) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }

  /** @param {...import('../src/types.js').SqlValue} values */
  bind(...values) { return new BoundStatement(this.db, this.sql, values); }

  async run() {
    await setImmediate();
    this.db.beforeRun(this.sql);
    const result = this.db.native.prepare(this.sql).run(...this.values);
    const changes = Number(result.changes);
    this.db.onRun(this.sql, changes);
    return { success: true, meta: { changes } };
  }

  async first() {
    await setImmediate();
    return this.db.native.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    await setImmediate();
    return { success: true, results: this.db.native.prepare(this.sql).all(...this.values) };
  }
}
