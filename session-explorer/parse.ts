// Turns the rows of one Claude Code session, subagents included, into a flat event list.
import { classify, isUserPrompt } from '../context-tracer/tracer.ts';
import type { Tokens } from './price.ts';

export type Kind = 'prompt' | 'llm' | 'tool' | 'edit' | 'error' | 'subagent';
export type SessionEvent = {
	t: string;
	ta: number;
	kind: Kind;
	agent: number;
	tool?: string;
	target?: string;
	node?: string;
	mark?: 'brain' | 'memory';
	msg?: string;
	model?: string;
	tok?: Tokens;
	cost?: number | null;
};
export type AgentMeta = { agentType?: string; description?: string };
export type ParsedSession = {
	title: string;
	start: string;
	branch?: string;
	agents: Array<{ id: string; name: string; description?: string }>;
	events: SessionEvent[];
};
type Call = Pick<SessionEvent, 'kind' | 'tool' | 'target' | 'node'>;
type Draft = Omit<SessionEvent, 'ta'>;

// A session stays idle for hours. A long gap counts as a short fixed one on the active-time axis.
const IDLE_GAP_SECONDS = 300;
const COLLAPSED_GAP_SECONDS = 20;
const TEXT_LIMIT = 200;
const TITLE_LIMIT = 80;
const PROMPT_LIMIT = 500;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

const text = (value: unknown) => (typeof value === 'string' ? value : '');
export const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function describeCall(name: string, input: Record<string, unknown>, cwd: string): Call {
	if (name === 'Read' || EDIT_TOOLS.has(name)) {
		const path = text(input.file_path) || text(input.notebook_path);
		const target = cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
		return { kind: EDIT_TOOLS.has(name) ? 'edit' : 'tool', tool: name, target, node: `file:${target}` };
	}
	if (name === 'Bash') return { kind: 'tool', tool: name, target: clip(text(input.command), TEXT_LIMIT), node: 'tool:Bash' };
	if (name === 'Grep' || name === 'Glob') return { kind: 'tool', tool: name, target: clip(text(input.pattern), TEXT_LIMIT), node: `tool:${name}` };
	if (name === 'Skill') return { kind: 'tool', tool: name, target: text(input.skill), node: `skill:${text(input.skill)}` };
	if (name === 'Agent' || name === 'Task') {
		const type = text(input.subagent_type) || 'general-purpose';
		return { kind: 'subagent', tool: name, target: type, node: `sub:${type}` };
	}
	if (name.startsWith('mcp__')) {
		const [, server, ...tool] = name.split('__');
		const target = `${server} · ${tool.join('__')}`;
		return { kind: 'tool', tool: 'MCP', target, node: `mcp:${target}` };
	}
	return { kind: 'tool', tool: name, target: '', node: `tool:${name}` };
}

function firstLine(content: unknown) {
	const body = typeof content === 'string' ? content : Array.isArray(content) ? content.map((block) => text(block?.text)).join('\n') : '';
	const line = body.split('\n').find((candidate) => candidate.trim()) ?? '';
	return clip(line.trim(), TEXT_LIMIT);
}

function tokens(usage: Record<string, any>): Tokens {
	const split = usage.cache_creation;
	return {
		fresh: usage.input_tokens ?? 0,
		cw5m: split ? (split.ephemeral_5m_input_tokens ?? 0) : (usage.cache_creation_input_tokens ?? 0),
		cw1h: split?.ephemeral_1h_input_tokens ?? 0,
		out: usage.output_tokens ?? 0,
		cr: usage.cache_read_input_tokens ?? 0
	};
}

export function parseSession(entries: unknown[], subagents: Record<string, AgentMeta> = {}): ParsedSession | undefined {
	const all = entries.filter((entry): entry is Record<string, any> => typeof entry === 'object' && entry !== null);
	const rows = all.filter((entry) => text(entry.timestamp)).sort((a, b) => a.timestamp.localeCompare(b.timestamp));

	const agents: ParsedSession['agents'] = [];
	const agentNumber = (id: string) => {
		if (!id) return 0;
		let index = agents.findIndex((agent) => agent.id === id);
		if (index === -1) {
			const description = subagents[id]?.description;
			index = agents.push({ id, name: subagents[id]?.agentType ?? 'subagent', ...(description ? { description } : {}) }) - 1;
		}
		return index + 1;
	};

	const drafts: Draft[] = [];
	const callById = new Map<string, Draft>();
	const llmByMessage = new Map<string, Draft>();
	let firstPrompt = '';
	let branch: string | undefined;

	for (const entry of rows) {
		const t: string = entry.timestamp;
		const agent = agentNumber(text(entry.agentId));
		branch ??= text(entry.gitBranch) || undefined;
		if (isUserPrompt(entry)) {
			firstPrompt ||= entry.message.content;
			drafts.push({ t, kind: 'prompt', agent: 0, msg: clip(entry.message.content.replace(/\s+/g, ' ').trim(), PROMPT_LIMIT) });
			continue;
		}
		const content = entry.message?.content;
		if (!Array.isArray(content)) continue;
		if (entry.type === 'assistant') {
			// One API response is written as several rows, one per content block. The last row holds the final token counts.
			const messageId = text(entry.message.id);
			const known = messageId ? llmByMessage.get(messageId) : undefined;
			if (known) {
				if (entry.message.usage) known.tok = tokens(entry.message.usage);
			} else if (entry.message.usage && entry.message.model !== '<synthetic>') {
				const draft: Draft = { t, kind: 'llm', agent, model: text(entry.message.model), tok: tokens(entry.message.usage) };
				if (messageId) llmByMessage.set(messageId, draft);
				drafts.push(draft);
			}
			for (const block of content) {
				if (block?.type !== 'tool_use') continue;
				const input = block.input ?? {};
				const mark = classify(text(block.name), input);
				const draft: Draft = {
					t,
					agent,
					...describeCall(text(block.name), input, text(entry.cwd)),
					...(mark === 'brain' || mark === 'memory' ? { mark } : {})
				};
				drafts.push(draft);
				callById.set(text(block.id), draft);
			}
		} else if (entry.type === 'user') {
			for (const block of content) {
				if (block?.type !== 'tool_result' || !block.is_error) continue;
				const failed = callById.get(text(block.tool_use_id));
				if (!failed) continue;
				failed.kind = 'error';
				failed.msg = firstLine(block.content);
			}
		}
	}
	if (drafts.length === 0) return undefined;

	let ta = 0;
	let previous = Date.parse(drafts[0].t);
	const events = drafts.map((draft) => {
		const now = Date.parse(draft.t);
		const gap = (now - previous) / 1000;
		previous = now;
		ta += gap > IDLE_GAP_SECONDS ? COLLAPSED_GAP_SECONDS : gap;
		return { ...draft, ta };
	});

	const title =
		text(all.findLast((entry) => entry.type === 'custom-title')?.customTitle) ||
		text(all.findLast((entry) => entry.type === 'ai-title')?.aiTitle) ||
		firstPrompt.split('\n')[0] ||
		'Session sans titre';
	return { title: clip(title, TITLE_LIMIT), start: drafts[0].t, ...(branch ? { branch } : {}), agents, events };
}
