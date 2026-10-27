// @ts-check

/** @param {string} key @returns {Promise<string>} */
export async function hashLicenseKey(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {import('./types.js').Database} db
 * @param {Request} request
 * @returns {Promise<{id: string} | null>}
 */
export async function authenticate(db, request) {
  const match = /^Bearer ([^\s]{12,160})$/i.exec(request.headers.get('authorization') ?? '');
  if (!match) return null;
  const row = await db.prepare(`
    SELECT id FROM licenses WHERE key_hash = ? AND revoked_at IS NULL
  `).bind(await hashLicenseKey(match[1])).first();
  return row && typeof row.id === 'string' ? { id: row.id } : null;
}
