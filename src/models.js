// @ts-check

/** @typedef {{maxTokens: number, inputRate: number, outputRate: number}} ModelPolicy */
/** @typedef {{model: string, prompt: string, max_tokens: number}} CompletionRequest */
/** @typedef {{input_tokens: number, output_tokens: number}} Usage */

/** Fictional prices in integer cost units per token; no real model pricing. */
export const MODELS = Object.freeze({
  'demo-basic': Object.freeze({ maxTokens: 96, inputRate: 3, outputRate: 7 }),
  'demo-extended': Object.freeze({ maxTokens: 384, inputRate: 11, outputRate: 17 }),
});

export class InvalidRequest extends Error {
  constructor() { super('Request validation failed.'); }
}

/** @param {string} model @returns {ModelPolicy} */
export function modelPolicy(model) {
  if (!Object.hasOwn(MODELS, model)) throw new InvalidRequest();
  return MODELS[/** @type {keyof typeof MODELS} */ (model)];
}

/** @param {unknown} body @returns {CompletionRequest} */
export function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InvalidRequest();
  const value = /** @type {Record<string, unknown>} */ (body);
  const allowed = ['model', 'prompt', 'max_tokens'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new InvalidRequest();
  if (typeof value.model !== 'string' || typeof value.prompt !== 'string') throw new InvalidRequest();
  const policy = modelPolicy(value.model);
  if (!value.prompt.length || Array.from(value.prompt).length > 4096) throw new InvalidRequest();
  if (typeof value.max_tokens !== 'number' || !Number.isSafeInteger(value.max_tokens)
      || value.max_tokens < 1 || value.max_tokens > policy.maxTokens) throw new InvalidRequest();
  return { model: value.model, prompt: value.prompt, max_tokens: value.max_tokens };
}

/** @param {string} model @param {Usage} usage @returns {number} */
export function costUnits(model, usage) {
  const policy = modelPolicy(model);
  if (![usage.input_tokens, usage.output_tokens].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error('Invalid token counts.');
  }
  const cost = usage.input_tokens * policy.inputRate + usage.output_tokens * policy.outputRate;
  if (!Number.isSafeInteger(cost)) throw new Error('Cost is outside the supported range.');
  return cost;
}
