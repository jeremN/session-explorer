// Waste finder: the costly patterns of one session. Pure, no file access.
import type { ParsedSession, SessionEvent } from './parse.ts';
import { RATES, costOf } from './price.ts';
import type { Rate } from './price.ts';

// The thresholds are choices, not measured optimums.
const LARGE_CONTEXT_TOKENS = 20_000;
const REWRITE_SHARE = 0.5;
const COLD_PAUSE_SECONDS = 300;
const LOOP_OCCURRENCES = 3;
// A call repeated after a failure, within the last calls of the same agent. Same window as agentplay.
const RETRY_WINDOW = 8;
const CALL_KINDS = new Set(['tool', 'edit', 'error', 'subagent']);
// A shell failure often says nothing but its exit code. Two different commands then share one message.
const BARE_EXIT_CODE = /^Exit code \d+$/;
// Closed list of error classes, first match wins. Idea from agentplay `classify_tool_error` (Apache-2.0);
// the patterns come from the messages of our own transcripts, where harness refusals dominate.
const ERROR_CLASSES: Array<[string, RegExp]> = [
	['exit_code', /^Exit code \d+/],
	['blocked', /^<tool_use_error>Blocked|changes directory before running a version-control command/],
	['permission', /requires? approval|requested permissions|has been denied|auto mode classifier|doesn't want to proceed/],
	['stale_file', /File has not been read yet|has been modified since read/],
	['not_found', /does not exist|No such file|ENOENT/],
	['timeout', /timed out/i]
];

// `t` and `agentId` locate the event in the transcript: a timestamp, and the subagent file ('' for the main agent).
type Located = { index: number; t: string; agent: number; agentId: string };
export type ColdResume = Located & {
	kind: 'cold' | 'invalidation';
	pauseSec: number;
	afterPrompt: boolean;
	contextTokens: number;
	writeTokens: number;
	cost: number | null;
	overWarm: number | null;
};
export type Loop = Located & { tool: string; msg: string; cls: string; count: number; costAtLeast: number };
export type Retry = Located & { tool: string; target: string; attempts: number; fixed: boolean; costAtLeast: number };
export type SubagentRun = Located & { name: string; description: string; requests: number; cost: number };
export type Waste = { coldResumes: ColdResume[]; loops: Loop[]; retries: Retry[]; subagents: SubagentRun[] };
type Agents = ParsedSession['agents'];

export const errorClass = (msg: string) => ERROR_CLASSES.find(([, pattern]) => pattern.test(msg))?.[0] ?? 'other';

const idOf = (agents: Agents, agent: number) => (agent > 0 ? (agents[agent - 1]?.id ?? '') : '');

function coldResumes(events: SessionEvent[], agents: Agents, rates: Record<string, Rate>): ColdResume[] {
	const found: ColdResume[] = [];
	const previous = new Map<number, { context: number; output: number; time: number; index: number }>();
	events.forEach((event, index) => {
		if (event.kind !== 'llm' || !event.tok) return;
		const { tok } = event;
		const written = tok.cw5m + tok.cw1h;
		const time = Date.parse(event.t);
		const before = previous.get(event.agent);
		previous.set(event.agent, { context: tok.fresh + written + tok.cr, output: tok.out, time, index });
		if (!before || before.context <= LARGE_CONTEXT_TOKENS) return;
		if (tok.cr >= before.context * REWRITE_SHARE || written <= before.context * REWRITE_SHARE) return;

		const pauseSec = Math.round((time - before.time) / 1000);
		const model = event.model ?? '';
		// A warm cache serves what the previous request left. The request writes the rest in both cases.
		const rewritten = Math.min(written, Math.max(0, before.context + before.output - tok.cr));
		const kept = written === 0 ? 0 : (written - rewritten) / written;
		const warm = { ...tok, cw5m: tok.cw5m * kept, cw1h: tok.cw1h * kept, cr: tok.cr + rewritten };
		const real = costOf(model, tok, rates);
		const cached = costOf(model, warm, rates);
		found.push({
			index,
			t: event.t,
			agent: event.agent,
			agentId: idOf(agents, event.agent),
			kind: pauseSec >= COLD_PAUSE_SECONDS ? 'cold' : 'invalidation',
			pauseSec,
			afterPrompt: events.slice(before.index, index).some((between) => between.kind === 'prompt'),
			contextTokens: before.context,
			writeTokens: written,
			cost: event.cost ?? null,
			overWarm: real === null || cached === null ? null : real - cached
		});
	});
	return found;
}

function loops(events: SessionEvent[], agents: Agents): Loop[] {
	const groups = new Map<string, number[]>();
	events.forEach((event, index) => {
		if (event.kind !== 'error') return;
		const command = BARE_EXIT_CODE.test(event.msg ?? '') ? event.target : '';
		const key = `${event.agent}\n${event.tool}\n${event.msg}\n${command}`;
		groups.set(key, [...(groups.get(key) ?? []), index]);
	});
	const found: Loop[] = [];
	for (const indexes of groups.values()) {
		if (indexes.length < LOOP_OCCURRENCES) continue;
		const first = events[indexes[0]];
		// The first failure is legitimate. Each repeat costs at least the request that launched it.
		const launchers = new Set<number>();
		for (const errorIndex of indexes.slice(1)) {
			const launcher = events.findLastIndex((event, index) => index < errorIndex && event.kind === 'llm' && event.agent === first.agent);
			if (launcher !== -1) launchers.add(launcher);
		}
		const costAtLeast = [...launchers].reduce((total, index) => total + (events[index].cost ?? 0), 0);
		found.push({
			index: indexes[0],
			t: first.t,
			agent: first.agent,
			agentId: idOf(agents, first.agent),
			tool: first.tool ?? '',
			msg: first.msg ?? '',
			cls: errorClass(first.msg ?? ''),
			count: indexes.length,
			costAtLeast
		});
	}
	return found.sort((a, b) => b.costAtLeast - a.costAtLeast || b.count - a.count);
}

function retries(events: SessionEvent[], agents: Agents): Retry[] {
	const keyOf = (event: SessionEvent) => `${event.tool}\n${event.target}`;
	const recent = new Map<number, number[]>();
	const streakOf = new Map<number, Retry>();
	const found: Retry[] = [];
	events.forEach((event, index) => {
		if (!CALL_KINDS.has(event.kind)) return;
		const window = recent.get(event.agent) ?? [];
		recent.set(event.agent, [...window, index].slice(-RETRY_WINDOW));
		const previous = window.findLast((candidate) => keyOf(events[candidate]) === keyOf(event));
		if (previous === undefined || events[previous].kind !== 'error') return;

		let streak = streakOf.get(previous);
		if (!streak) {
			const first = events[previous];
			streak = { index: previous, t: first.t, agent: first.agent, agentId: idOf(agents, first.agent), tool: first.tool ?? '', target: first.target ?? '', attempts: 1, fixed: false, costAtLeast: 0 };
			found.push(streak);
		}
		const launcher = events.findLastIndex((candidate, at) => at < index && candidate.kind === 'llm' && candidate.agent === event.agent);
		streak.attempts += 1;
		streak.fixed = event.kind !== 'error';
		streak.costAtLeast += launcher > previous ? (events[launcher].cost ?? 0) : 0;
		streakOf.set(index, streak);
	});
	return found.sort((a, b) => b.costAtLeast - a.costAtLeast || b.attempts - a.attempts);
}

function subagents(events: SessionEvent[], agents: Agents): SubagentRun[] {
	return agents
		.map((meta, position) => {
			const agent = position + 1;
			const index = events.findIndex((event) => event.agent === agent);
			const requests = events.filter((event) => event.kind === 'llm' && event.agent === agent);
			return {
				index,
				t: events[index]?.t ?? '',
				agent,
				agentId: meta.id,
				name: meta.name,
				description: meta.description ?? '',
				requests: requests.length,
				cost: requests.reduce((total, event) => total + (event.cost ?? 0), 0)
			};
		})
		.filter((run) => run.index !== -1)
		.sort((a, b) => b.cost - a.cost);
}

// `events` carry their cost already. `rates` gives the price of the same request with a warm cache.
export function findWaste(events: SessionEvent[], agents: Agents, rates: Record<string, Rate> = RATES): Waste {
	return { coldResumes: coldResumes(events, agents, rates), loops: loops(events, agents), retries: retries(events, agents), subagents: subagents(events, agents) };
}

export type SessionWaste = Waste & { session: string; project: string; title: string; start: string };

export function totalsOf(sessions: SessionWaste[]) {
	const resumes = sessions.flatMap((session) => session.coldResumes);
	const sumOf = (matching: ColdResume[]) => ({ count: matching.length, overWarm: matching.reduce((total, resume) => total + (resume.overWarm ?? 0), 0) });
	const cold = resumes.filter((resume) => resume.kind === 'cold');
	const allLoops = sessions.flatMap((session) => session.loops);
	const allRetries = sessions.flatMap((session) => session.retries);
	const runs = sessions.flatMap((session) => session.subagents);
	const byClass: Record<string, { count: number; costAtLeast: number }> = {};
	for (const found of allLoops) {
		const total = (byClass[found.cls] ??= { count: 0, costAtLeast: 0 });
		total.count += 1;
		total.costAtLeast += found.costAtLeast;
	}
	return {
		// Only a resume that follows a user prompt is in reach of a hook on the prompt.
		coldResumes: { ...sumOf(cold), afterPrompt: sumOf(cold.filter((resume) => resume.afterPrompt)) },
		invalidations: sumOf(resumes.filter((resume) => resume.kind === 'invalidation')),
		loops: {
			count: allLoops.length,
			sessions: sessions.filter((session) => session.loops.length > 0).length,
			errors: allLoops.reduce((total, found) => total + found.count, 0),
			costAtLeast: allLoops.reduce((total, found) => total + found.costAtLeast, 0),
			byClass
		},
		retries: {
			count: allRetries.length,
			sessions: sessions.filter((session) => session.retries.length > 0).length,
			attempts: allRetries.reduce((total, found) => total + found.attempts, 0),
			fixed: allRetries.filter((found) => found.fixed).length,
			costAtLeast: allRetries.reduce((total, found) => total + found.costAtLeast, 0)
		},
		subagents: { runs: runs.length, cost: runs.reduce((total, found) => total + found.cost, 0) }
	};
}

export function flattenFindings(sessions: SessionWaste[]) {
	const flat = <Finding>(pick: (found: Waste) => Finding[]) =>
		sessions.flatMap(({ session, project, title, start, ...found }) => pick(found).map((finding) => ({ session, project, title, start, ...finding })));
	return {
		coldResumes: flat((found) => found.coldResumes).sort((a, b) => (b.overWarm ?? -1) - (a.overWarm ?? -1)),
		loops: flat((found) => found.loops).sort((a, b) => b.costAtLeast - a.costAtLeast || b.count - a.count),
		retries: flat((found) => found.retries).sort((a, b) => b.costAtLeast - a.costAtLeast || b.attempts - a.attempts),
		subagents: flat((found) => found.subagents).sort((a, b) => b.cost - a.cost)
	};
}
