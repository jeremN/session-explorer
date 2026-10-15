// Does the next prompt of a session meet a cold cache? Pure, no file access.
import { RATES, costOf } from '../session-explorer/price.ts';
import type { Rate } from '../session-explorer/price.ts';

// Under this context, a fresh session costs about the same as the cold request. A choice, not a measured optimum.
const LARGE_CONTEXT_TOKENS = 100_000;
const LIFETIME_1H_SECONDS = 3600;
const LIFETIME_5M_SECONDS = 300;

type Usage = {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
};
export type Row = {
	type?: string;
	subtype?: string;
	timestamp?: string;
	isSidechain?: boolean;
	message?: { id?: string; model?: string; usage?: Usage };
};
// `lastRequest` names the pause: two prompts after the same request meet the same cold cache.
export type ColdCache = { lastRequest: string; pauseSec: number; contextTokens: number; ttlSec: number; model: string; overWarm: number | null };

export function decide(rows: Row[], nowMs: number, rates: Record<string, Rate> = RATES): ColdCache | null {
	let last: { time: number; model: string; context: number } | null = null;
	// A request that only reads the cache keeps the lifetime that the last write set.
	let ttlSec = LIFETIME_1H_SECONDS;
	for (const row of rows) {
		if (row.type === 'system' && row.subtype === 'compact_boundary') {
			last = null;
			continue;
		}
		const usage = row.message?.usage;
		const model = row.message?.model ?? '';
		if (row.type !== 'assistant' || !usage || row.isSidechain || model === '<synthetic>') continue;
		const time = Date.parse(row.timestamp ?? '');
		if (Number.isNaN(time)) continue;
		// The rows of one response share one usage, and the last row holds the full output count.
		const context =
			(usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
		last = { time, model, context };
		if ((usage.cache_creation_input_tokens ?? 0) > 0)
			ttlSec = (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0 ? LIFETIME_1H_SECONDS : LIFETIME_5M_SECONDS;
	}
	if (!last || last.context < LARGE_CONTEXT_TOKENS) return null;
	const pauseSec = Math.round((nowMs - last.time) / 1000);
	if (pauseSec < ttlSec) return null;

	const none = { fresh: 0, cw5m: 0, cw1h: 0, out: 0, cr: 0 };
	const cold = costOf(last.model, { ...none, [ttlSec === LIFETIME_1H_SECONDS ? 'cw1h' : 'cw5m']: last.context }, rates);
	const warm = costOf(last.model, { ...none, cr: last.context }, rates);
	return {
		lastRequest: new Date(last.time).toISOString(),
		pauseSec,
		contextTokens: last.context,
		ttlSec,
		model: last.model,
		overWarm: cold === null || warm === null ? null : cold - warm
	};
}
