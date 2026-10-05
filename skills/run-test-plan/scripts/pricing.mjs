// List prices in USD per million tokens, from Anthropic's published API pricing as of the date
// below. Costs computed from them are API list-price equivalents: a subscription or enterprise
// agreement bills differently, so treat them as a consistent yardstick, not an invoice.
// Override or extend per project in .qa/config.json → pricing.
import { CONFIG } from './lib.mjs';

export const PRICING_AS_OF = '2026-09-25';

// Cache writes are priced as a multiple of input: 1.25x for the 5-minute TTL, 2x for 1 hour.
// When a model's cache-read price is not published separately it is 0.1x input.
const BASE = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
// Model aliases an orchestrator passes to an agent ("sonnet") resolve to the current generation.
const ALIASES = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-4-5', fable: 'claude-fable-5-1' };

export function priceFor(model) {
  const id = ALIASES[model] || String(model || '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
  const base = { ...BASE[id], ...CONFIG.pricing?.[id] };
  if (base.input === undefined || base.output === undefined) return null;
  return {
    id,
    input: base.input,
    output: base.output,
    cacheRead: base.cacheRead ?? base.input * 0.1,
    cacheWrite5m: base.cacheWrite5m ?? base.input * 1.25,
    cacheWrite1h: base.cacheWrite1h ?? base.input * 2,
  };
}

export function costOf(model, tokens) {
  const price = priceFor(model);
  if (!price) return null;
  return (
    (tokens.input * price.input +
      tokens.cacheWrite5m * price.cacheWrite5m +
      tokens.cacheWrite1h * price.cacheWrite1h +
      tokens.cacheRead * price.cacheRead +
      tokens.output * price.output) /
    1e6
  );
}
