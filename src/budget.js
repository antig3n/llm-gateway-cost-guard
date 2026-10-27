// @ts-check

/**
 * @typedef {object} Reservation
 * @property {number} amount
 * @property {string} month
 * @property {(actual: number) => Promise<void>} settle
 * @property {() => Promise<void>} release
 */

/** @param {Date} date @returns {string} */
export function utcMonth(date) {
  return date.toISOString().slice(0, 7);
}

/**
 * Reserve without a preceding balance read. A read followed by a write lets
 * concurrent requests all observe the same headroom and collectively overspend.
 * SQLite serializes this single conditional UPDATE, including its predicate.
 * @param {import('./types.js').Database} db
 * @param {string} licenseId
 * @param {string} month
 * @param {number} maximumCost
 * @returns {Promise<Reservation | null>}
 */
export async function reserveBudget(db, licenseId, month, maximumCost) {
  if (!Number.isSafeInteger(maximumCost) || maximumCost <= 0) throw new Error('Invalid reservation cost.');
  await db.prepare(`
    INSERT INTO monthly_budgets (license_id, month, cap)
    SELECT id, ?, monthly_cap FROM licenses WHERE id = ? AND revoked_at IS NULL
    ON CONFLICT (license_id, month) DO NOTHING
  `).bind(month, licenseId).run();

  const result = await db.prepare(`
    UPDATE monthly_budgets SET reserved = reserved + ?
    WHERE license_id = ? AND month = ? AND spent + reserved + ? <= cap
      AND EXISTS (
        SELECT 1 FROM licenses
        WHERE id = monthly_budgets.license_id AND revoked_at IS NULL
      )
  `).bind(maximumCost, licenseId, month, maximumCost).run();
  if (result.meta.changes !== 1) return null;

  // One owner closes each handle once. An uncertain database write is never retried
  // or released: outstanding holds stay counted, including across month changes.
  let closed = false;
  /** @param {number} actual @returns {Promise<void>} */
  async function close(actual) {
    if (!Number.isSafeInteger(actual) || actual < 0 || actual > maximumCost) {
      throw new Error('Settlement exceeds its reservation.');
    }
    if (closed) throw new Error('Reservation is already closed.');
    closed = true;
    const settled = await db.prepare(`
      UPDATE monthly_budgets SET spent = spent + ?, reserved = reserved - ?
      WHERE license_id = ? AND month = ? AND reserved >= ?
    `).bind(actual, maximumCost, licenseId, month, maximumCost).run();
    if (settled.meta.changes !== 1) throw new Error('Reservation could not be closed.');
  }
  return Object.freeze({ amount: maximumCost, month, settle: close, release: () => close(0) });
}
