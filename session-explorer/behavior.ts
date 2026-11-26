// Behavior of one session: the sequence of its tool calls as steps, and the counts derived from it.
// The rows of a session and of its subagents count together. A transcript can hold the same tool_use block twice
// (streaming): a call counts once, by its id.
import { FAILURE, OUTAGE, commandClasses, isVerifyClass, resultText } from '../context-tracer/tracer.ts';
import type { CommandClass } from '../context-tracer/tracer.ts';

export type StepClass = CommandClass | 'test-failed';
// The band of a step shows its first class in this order.
export const STEP_ORDER: readonly StepClass[] = ['test-failed', 'test', 'types', 'lint', 'build', 'edit', 'install', 'git', 'explore', 'other'];
export type Step = { tool: string; primary: StepClass; classes: StepClass[] };
// See the README, "Behavior metrics", for the definition of each count. lintOnlyAtEnd is absent when no step lints.
export type BehaviorMetrics = {
	toolCalls: number;
	explore: number;
	edits: number;
	testRuns: number;
	testFailures: number;
	redGreenCycles: number;
	typeChecks: number;
	lintRuns: number;
	lintOnlyAtEnd?: 0 | 1;
	rereads: number;
	reruns: number;
	toolErrors: number;
	firstContextTokens: number;
};

const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const text = (value: unknown) => (typeof value === 'string' ? value : '');

type Use = { id: string; name: string; input: Record<string, any> };
type Result = { error: boolean; output: string };

function classesOf(use: Use, result: Result | undefined): StepClass[] {
	if (EXPLORE_TOOLS.has(use.name)) return ['explore'];
	if (EDIT_TOOLS.has(use.name)) return ['edit'];
	if (use.name !== 'Bash') return ['other'];
	const classes: StepClass[] = commandClasses(text(use.input.command));
	if (classes.includes('test') && result && (result.error || FAILURE.test(result.output))) classes.push('test-failed');
	return classes;
}

export function behaviorOf(entries: unknown[]): { steps: Step[]; metrics: BehaviorMetrics } {
	const rows = (entries as Array<Record<string, any>>)
		.filter((entry) => typeof entry === 'object' && entry !== null && text(entry.timestamp))
		.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
	const uses = new Map<string, Use>();
	const results = new Map<string, Result>();
	const usage = new Map<string, Record<string, number>>();
	let firstRequest: string | undefined;
	for (const row of rows) {
		const content = row.message?.content;
		if (row.type === 'assistant') {
			// One API response is written as several rows. The last row holds the final token counts.
			const messageId = text(row.message?.id);
			if (row.message?.usage && row.message.model !== '<synthetic>' && !row.isSidechain && messageId) {
				firstRequest ??= messageId;
				usage.set(messageId, row.message.usage);
			}
			for (const block of Array.isArray(content) ? content : []) {
				if (block?.type !== 'tool_use') continue;
				const id = text(block.id) || `row-${uses.size}`;
				if (!uses.has(id)) uses.set(id, { id, name: text(block.name), input: block.input ?? {} });
			}
		} else if (row.type === 'user' && Array.isArray(content)) {
			for (const block of content) {
				if (block?.type !== 'tool_result' || results.has(text(block.tool_use_id))) continue;
				results.set(text(block.tool_use_id), { error: block.is_error === true, output: resultText(block.content) });
			}
		}
	}

	const steps: Step[] = [];
	let toolErrors = 0;
	let rereads = 0;
	let reruns = 0;
	let redGreenCycles = 0;
	let red = false;
	let lastEdit = -1;
	const lints: number[] = [];
	const read = new Set<string>();
	const checked = new Set<string>();
	for (const use of uses.values()) {
		const result = results.get(use.id);
		// The classifier outage blocked the call: it never ran.
		if (result?.error && OUTAGE.test(result.output)) continue;
		const classes = classesOf(use, result);
		const index = steps.push({ tool: use.name, primary: STEP_ORDER.find((name) => classes.includes(name)) ?? 'other', classes }) - 1;
		if (result?.error) toolErrors++;
		if (use.name === 'Read') {
			const path = text(use.input.file_path);
			if (read.has(path)) rereads++;
			read.add(path);
		}
		if (classes.some(isVerifyClass)) {
			const command = text(use.input.command).replace(/\s+/g, ' ').trim();
			if (checked.has(command)) reruns++;
			checked.add(command);
		}
		if (classes.includes('test')) {
			if (classes.includes('test-failed')) red = true;
			else if (red) {
				redGreenCycles++;
				red = false;
			}
		}
		if (classes.includes('lint')) lints.push(index);
		if (classes.includes('edit')) {
			lastEdit = index;
			checked.clear();
			// A shell edit names no file that this parser trusts: every file counts as changed.
			if (EDIT_TOOLS.has(use.name)) read.delete(text(use.input.file_path) || text(use.input.notebook_path));
			else read.clear();
		}
	}

	const count = (name: StepClass) => steps.filter((step) => step.classes.includes(name)).length;
	const first = firstRequest === undefined ? undefined : usage.get(firstRequest);
	const metrics: BehaviorMetrics = {
		toolCalls: steps.length,
		explore: count('explore'),
		edits: count('edit'),
		testRuns: count('test'),
		testFailures: count('test-failed'),
		redGreenCycles,
		typeChecks: count('types'),
		lintRuns: count('lint'),
		...(lints.length ? { lintOnlyAtEnd: lints.every((index) => index >= lastEdit) ? (1 as const) : (0 as const) } : {}),
		rereads,
		reruns,
		toolErrors,
		firstContextTokens: first ? (first.input_tokens ?? 0) + (first.cache_creation_input_tokens ?? 0) + (first.cache_read_input_tokens ?? 0) : 0
	};
	return { steps, metrics };
}
