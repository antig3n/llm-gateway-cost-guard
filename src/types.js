/** @typedef {string | number | null} SqlValue */
/** @typedef {{ success: boolean, meta: { changes: number } }} RunResult */
/**
 * @typedef {object} Statement
 * @property {(...values: SqlValue[]) => Statement} bind
 * @property {() => Promise<RunResult>} run
 * @property {() => Promise<Record<string, unknown> | null>} first
 * @property {() => Promise<{results: Record<string, unknown>[], success: boolean}>} all
 */
/**
 * @typedef {object} Database
 * @property {(sql: string) => Statement} prepare
 */
/** @typedef {{ DB: Database }} Environment */
/** @typedef {{ waitUntil: (work: Promise<unknown>) => void }} ExecutionContext */
export {};
