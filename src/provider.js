// @ts-check

/** @typedef {import('./models.js').CompletionRequest} CompletionRequest */
/** @typedef {{text: string, usage: import('./models.js').Usage}} CompletionResult */
/**
 * A trusted adapter must bound every billable input token before admission,
 * enforce max_tokens, and use only the two configured token rates. Rejection
 * means no billable work occurred. Ambiguous failures need reconciliation.
 * @typedef {object} Provider
 * @property {(request: CompletionRequest) => number} maxInputTokens
 * @property {(request: CompletionRequest) => Promise<CompletionResult>} complete
 */

/**
 * Synthetic tokenizer: one Unicode scalar per token, with no hidden overhead.
 * This bound is specific to this fake; a real adapter needs its own bound.
 * @type {Provider}
 */
export const fakeProvider = Object.freeze({
  maxInputTokens(request) {
    return Array.from(request.prompt).length;
  },
  async complete(request) {
    const text = '.'.repeat(Math.min(13, request.max_tokens));
    return {
      text,
      usage: { input_tokens: Array.from(request.prompt).length, output_tokens: text.length },
    };
  },
});
