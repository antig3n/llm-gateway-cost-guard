// @ts-check
import { authenticate } from './auth.js';
import { reserveBudget, utcMonth } from './budget.js';
import { costUnits, validateRequest } from './models.js';
import { fakeProvider } from './provider.js';

/**
 * @typedef {object} Metadata
 * @property {string | null} license_id
 * @property {string | null} model
 * @property {number | null} input_tokens
 * @property {number | null} output_tokens
 * @property {number | null} cost_units
 * @property {number} duration_ms
 * @property {number} status
 */
/**
 * @typedef {object} Options
 * @property {import('./provider.js').Provider} [provider]
 * @property {(metadata: Readonly<Metadata>) => void} [logger]
 * @property {() => Date} [now]
 */

/** @param {unknown} body @param {number} status @returns {Response} */
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** @param {Options} [options] */
export function createWorker({
  provider = fakeProvider,
  logger = (metadata) => console.log(JSON.stringify(metadata)),
  now = () => new Date(),
} = {}) {
  return {
    /**
     * @param {Request} request
     * @param {import('./types.js').Environment} env
     * @param {import('./types.js').ExecutionContext} [ctx]
     * @returns {Promise<Response>}
     */
    fetch(request, env, ctx) {
      const work = handle(request, env);
      // Register the whole operation before awaiting I/O, so accounting can finish
      // after client disconnect. A terminated runtime leaves its hold counted.
      ctx?.waitUntil(work.then(() => undefined));
      return work;
    },
  };

  /**
   * @param {Request} request
   * @param {import('./types.js').Environment} env
   * @returns {Promise<Response>}
   */
  async function handle(request, env) {
    const started = performance.now();
    /** @type {Metadata} */
    const metadata = {
      license_id: null, model: null, input_tokens: null, output_tokens: null,
      cost_units: null, duration_ms: 0, status: 500,
    };
    /** @param {number} status @param {string} code */
    const fail = (status, code) => {
      metadata.status = status;
      return json({ error: code }, status);
    };
    try {
      if (new URL(request.url).pathname !== '/v1/completions') return fail(404, 'route_not_found');
      if (request.method !== 'POST') return fail(405, 'method_not_allowed');
      const license = await authenticate(env.DB, request);
      if (!license) return fail(401, 'license_not_active');
      metadata.license_id = license.id;
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return fail(415, 'json_required');
      }
      let input;
      try {
        input = validateRequest(await request.json());
      } catch {
        return fail(400, 'invalid_request');
      }
      metadata.model = input.model;
      const inputBound = provider.maxInputTokens(input);
      const maximum = costUnits(input.model, { input_tokens: inputBound, output_tokens: input.max_tokens });
      const hold = await reserveBudget(env.DB, license.id, utcMonth(now()), maximum);
      if (!hold) return fail(429, 'budget_unavailable');

      let result;
      try {
        result = await provider.complete(input);
      } catch {
        await hold.release();
        metadata.cost_units = 0;
        return fail(502, 'provider_failed');
      }

      // A successful call with unusable accounting is charged at its maximum.
      // Never free a hold after billable work with unknown or invalid usage.
      let actual;
      try {
        if (typeof result?.text !== 'string' || !result.usage
            || result.usage.input_tokens > inputBound || result.usage.output_tokens > input.max_tokens) {
          throw new Error('Provider contract violated.');
        }
        actual = costUnits(input.model, result.usage);
      } catch {
        await hold.settle(maximum);
        metadata.cost_units = maximum;
        return fail(502, 'invalid_provider_result');
      }
      metadata.input_tokens = result.usage.input_tokens;
      metadata.output_tokens = result.usage.output_tokens;
      metadata.cost_units = actual;
      await hold.settle(actual);
      metadata.status = 200;
      return json({
        model: input.model, output: result.text,
        usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
        cost_units: actual,
      }, 200);
    } catch {
      return fail(500, 'gateway_unavailable');
    } finally {
      metadata.duration_ms = Math.max(0, Math.round(performance.now() - started));
      // The logger receives only this allowlisted record, never an error object.
      try { logger(Object.freeze({ ...metadata })); } catch { /* Accounting is independent of telemetry. */ }
    }
  }
}

export default createWorker();
