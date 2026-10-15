// Price of one LLM request, in dollars. Rates are dollars for one million tokens.
export type Tokens = { fresh: number; cw5m: number; cw1h: number; out: number; cr: number };
export type Rate = { input: number; output: number; cacheRead?: number };

// Cache prices are multiples of the input rate: 5-minute write, 1-hour write, read.
// The read multiple is a default that a rate can override.
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const DEFAULT_CACHE_READ = 0.1;

// Keep in sync with the public Anthropic price list. A model that is absent gets no cost.
export const RATES: Record<string, Rate> = {
	'claude-haiku-4-5': { input: 1, output: 5 },
	'claude-opus-4-7': { input: 5, output: 25 },
	'claude-opus-5': { input: 5, output: 25 },
	'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.05 },
	'claude-sonnet-5': { input: 2, output: 10 },
	'claude-sonnet-5-5': { input: 2, output: 10 },
	'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.025 }
};

export function modelKey(model: string) {
	return model.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
}

export function costOf(model: string, tokens: Tokens, rates: Record<string, Rate> = RATES): number | null {
	const rate = rates[modelKey(model)];
	if (!rate) return null;
	const input = tokens.fresh + tokens.cw5m * CACHE_WRITE_5M + tokens.cw1h * CACHE_WRITE_1H + tokens.cr * (rate.cacheRead ?? DEFAULT_CACHE_READ);
	return (input * rate.input + tokens.out * rate.output) / 1e6;
}
