// Price of one LLM request, in dollars. Rates are dollars for one million tokens.
export type Tokens = { fresh: number; cw5m: number; cw1h: number; out: number; cr: number };
// longContext: above `above` prompt tokens (fresh, cache writes and cache reads of one request), the input and output
// rates of that request are multiplied by `factor`.
export type Rate = { input: number; output: number; cacheRead?: number; longContext?: { above: number; factor: number } };

// Cache prices are multiples of the input rate: 5-minute write, 1-hour write, read.
// The read multiple is a default that a rate can override.
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const DEFAULT_CACHE_READ = 0.1;

// Keep in sync with the public Anthropic price list. A model that is absent gets no cost.
export const RATES: Record<string, Rate> = {
	'claude-haiku-4-5': { input: 1, output: 5 },
	// Above 100k prompt tokens, input and output cost five times more.
	'claude-haiku-5-5': { input: 0.1, output: 0.5, longContext: { above: 100_000, factor: 5 } },
	'claude-opus-4-7': { input: 5, output: 25 },
	'claude-opus-5': { input: 5, output: 25 },
	'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.05 },
	'claude-sonnet-5': { input: 2, output: 10 },
	'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.05 },
	'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.025 }
};

export function modelKey(model: string) {
	return model.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
}

export function costOf(model: string, tokens: Tokens, rates: Record<string, Rate> = RATES): number | null {
	const rate = rates[modelKey(model)];
	if (!rate) return null;
	const input = tokens.fresh + tokens.cw5m * CACHE_WRITE_5M + tokens.cw1h * CACHE_WRITE_1H + tokens.cr * (rate.cacheRead ?? DEFAULT_CACHE_READ);
	const prompt = tokens.fresh + tokens.cw5m + tokens.cw1h + tokens.cr;
	const factor = rate.longContext && prompt > rate.longContext.above ? rate.longContext.factor : 1;
	return ((input * rate.input + tokens.out * rate.output) * factor) / 1e6;
}
