// Session Explorer build: writes one index and one event file per Claude Code session.
// Usage: node build.ts [--days 30] [--projects <regex>] [--waste] [--serve] [--port 4173]
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';

import { listJsonl, loadConfig, readLines, traceTasks } from '../context-tracer/tracer.ts';
import type { TaskSpan } from '../context-tracer/tracer.ts';
import { parseSession } from './parse.ts';
import type { AgentMeta, ParsedSession, SessionEvent } from './parse.ts';
import { RATES, costOf, modelKey } from './price.ts';
import type { Rate } from './price.ts';
import { createdMrs, mrMentions } from './mr.ts';
import type { MrMention } from './mr.ts';
import { findWaste, flattenFindings, totalsOf } from './waste.ts';
import type { SessionWaste } from './waste.ts';

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8'
};

export function priceEvents(events: SessionEvent[], rates: Record<string, Rate> = RATES): SessionEvent[] {
	return events.map((event) => (event.kind === 'llm' && event.tok ? { ...event, cost: costOf(event.model ?? '', event.tok, rates) } : event));
}

export function summarizeSession(id: string, project: string, parsed: ParsedSession, tasks: Array<Pick<TaskSpan, 'brain'>>) {
	const requests = parsed.events.filter((event) => event.kind === 'llm' && event.tok);
	const sum = (pick: (event: SessionEvent) => number) => requests.reduce((total, event) => total + pick(event), 0);
	const fresh = sum((event) => event.tok!.fresh);
	const written = sum((event) => event.tok!.cw5m + event.tok!.cw1h);
	const read = sum((event) => event.tok!.cr);
	const output = sum((event) => event.tok!.out);
	const input = fresh + written + read;
	const verdicts = (verdict: TaskSpan['brain']) => tasks.filter((task) => task.brain === verdict).length;
	return {
		id,
		project,
		branch: parsed.branch,
		title: parsed.title,
		start: parsed.start,
		activeSec: Math.round(parsed.events.at(-1)!.ta),
		events: parsed.events.length,
		llmRequests: requests.length,
		cost: Math.round(sum((event) => event.cost ?? 0) * 100) / 100,
		unpricedRequests: requests.filter((event) => event.cost == null).length,
		billedTokens: fresh + written + output,
		cacheReadShare: input === 0 ? 0 : Math.round((read / input) * 100) / 100,
		errors: parsed.events.filter((event) => event.kind === 'error').length,
		subagents: parsed.agents.length,
		tasks: { before: verdicts('before'), after: verdicts('after'), never: verdicts('never') },
		mrs: [] as string[]
	};
}

// `/data/...` is read in `outDir`, everything else in `viewerDir`. A path that leaves its root is refused.
export function resolveRequest(url: string, viewerDir: string, outDir: string): string | undefined {
	let path: string;
	try {
		path = decodeURIComponent(new URL(url, 'http://localhost').pathname);
	} catch {
		return undefined;
	}
	const [root, relative] = path.startsWith('/data/') ? [outDir, path.slice('/data/'.length)] : [viewerDir, path === '/' ? 'index.html' : path.slice(1)];
	const file = resolve(root, relative);
	return file.startsWith(resolve(root) + sep) ? file : undefined;
}

// A web page can point its own domain at 127.0.0.1 (DNS rebinding). The Host header then names that domain.
export function allowedHost(host: string | undefined, port: number) {
	return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function readAgentMeta(subagentFiles: string[]) {
	const meta: Record<string, AgentMeta> = {};
	for (const file of subagentFiles) {
		try {
			const { agentType, description } = JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
			meta[basename(file, '.jsonl').replace(/^agent-/, '')] = { agentType, description };
		} catch {
			// An old subagent transcript has no meta file. The parser then names it "subagent".
		}
	}
	return meta;
}

function serve(viewerDir: string, outDir: string, port: number) {
	const server = createServer((request, response) => {
		if (!allowedHost(request.headers.host, port)) {
			response.writeHead(403).end('Forbidden');
			return;
		}
		const file = resolveRequest(request.url ?? '/', viewerDir, outDir);
		const type = file && MIME[extname(file)];
		if (!file || !type || !existsSync(file)) {
			response.writeHead(404).end('Not found');
			return;
		}
		response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
		createReadStream(file).pipe(response);
	});
	server.on('error', (error: NodeJS.ErrnoException) => {
		// No fallback to another port: a silent port change hides which server answers.
		console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Stop the other server or pass --port.` : error.message);
		process.exit(1);
	});
	server.listen(port, '127.0.0.1', () => console.log(`Session Explorer: http://127.0.0.1:${port}`));
}

function main() {
	const argument = (flag: string) => {
		const index = process.argv.indexOf(flag);
		return index === -1 ? undefined : process.argv[index + 1];
	};
	const days = Number(argument('--days') ?? 30);
	const config = loadConfig();
	const projects = new RegExp(argument('--projects') ?? config.projects ?? '.');
	const port = Number(argument('--port') ?? 4173);
	const outDir = join(import.meta.dirname, 'out');
	const viewerDir = join(import.meta.dirname, 'viewer');
	const root = join(homedir(), '.claude', 'projects');
	const cutoffMs = Date.now() - days * 86_400_000;
	const cutoff = new Date(cutoffMs).toISOString();

	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(join(outDir, 'sessions'), { recursive: true });

	const rows: Array<ReturnType<typeof summarizeSession>> = [];
	const unpriced = new Set<string>();
	const wasted: SessionWaste[] = [];
	const mentions: Array<{ session: string; mentions: MrMention[] }> = [];
	for (const project of readdirSync(root).filter((name) => projects.test(name))) {
		for (const file of listJsonl(join(root, project))) {
			// A session that started inside the window was written inside the window.
			if (statSync(file).mtimeMs < cutoffMs) continue;
			const subagentFiles = listJsonl(join(file.slice(0, -'.jsonl'.length), 'subagents'));
			const entries = [file, ...subagentFiles].flatMap(readLines);
			const parsed = parseSession(entries, readAgentMeta(subagentFiles));
			if (!parsed || parsed.start < cutoff) continue;
			parsed.events = priceEvents(parsed.events);
			for (const event of parsed.events) if (event.kind === 'llm' && event.cost === null) unpriced.add(modelKey(event.model ?? ''));
			const { tasks } = traceTasks(entries);
			const id = basename(file, '.jsonl');
			rows.push(summarizeSession(id, project, parsed, tasks));
			mentions.push({ session: id, mentions: mrMentions(entries) });
			wasted.push({ session: id, project, title: parsed.title, start: parsed.start, ...findWaste(parsed.events, parsed.agents) });
			writeFileSync(join(outDir, 'sessions', `${id}.json`), JSON.stringify({ id, title: parsed.title, agents: parsed.agents, events: parsed.events, tasks }));
		}
	}
	rows.sort((a, b) => b.start.localeCompare(a.start));
	const created = createdMrs(mentions);
	for (const row of rows) row.mrs = created[row.id] ?? [];
	const generatedAt = new Date().toISOString();
	const dollars = (value: number) => Math.round(value * 100) / 100;
	const inDollars = ({ count, overWarm }: { count: number; overWarm: number }) => ({ count, overWarm: dollars(overWarm) });
	const totals = totalsOf(wasted);
	const waste = {
		coldResumes: { ...inDollars(totals.coldResumes), afterPrompt: inDollars(totals.coldResumes.afterPrompt) },
		invalidations: inDollars(totals.invalidations),
		loops: { ...totals.loops, costAtLeast: dollars(totals.loops.costAtLeast) },
		retries: { ...totals.retries, costAtLeast: dollars(totals.retries.costAtLeast) },
		subagents: { runs: totals.subagents.runs, cost: dollars(totals.subagents.cost) }
	};
	const index = { schema: 'harness/v1', tool: 'session-explorer', generatedAt, days, waste, sessions: rows };
	writeFileSync(join(outDir, 'index.json'), JSON.stringify(index));

	// Private file: it holds error messages. Only the totals above follow the harness/v1 contract.
	const totalCost = dollars(rows.reduce((total, row) => total + row.cost, 0));
	writeFileSync(join(outDir, 'waste.json'), JSON.stringify({ generatedAt, days, totalCost, ...flattenFindings(wasted) }));

	console.log(`${rows.length} sessions written to ${outDir}`);
	if (unpriced.size > 0) console.log(`Models without a price (cost not counted): ${[...unpriced].join(', ')}`);
	if (process.argv.includes('--waste')) {
		const share = (value: number) => (totalCost === 0 ? '0 %' : `${Math.round((value / totalCost) * 100)} %`);
		console.log(`Waste in the last ${days} days, total cost ${totalCost} dollars`);
		const cold = waste.coldResumes;
		console.table([
			{ signal: 'cold resume: cost over a warm cache (upper limit)', count: cold.count, dollars: cold.overWarm, share: share(cold.overWarm) },
			{ signal: '  of which after a user prompt (reach of a prompt hook)', count: cold.afterPrompt.count, dollars: cold.afterPrompt.overWarm, share: share(cold.afterPrompt.overWarm) },
			{ signal: 'cache invalidation (pause under 5 min)', count: waste.invalidations.count, dollars: waste.invalidations.overWarm, share: share(waste.invalidations.overWarm) },
			{ signal: `error loop, at least (${waste.loops.sessions} sessions, ${waste.loops.errors} errors)`, count: waste.loops.count, dollars: waste.loops.costAtLeast, share: share(waste.loops.costAtLeast) },
			...Object.entries(waste.loops.byClass)
				.sort(([, a], [, b]) => b.costAtLeast - a.costAtLeast)
				.map(([cls, found]) => ({ signal: `  of which ${cls}`, count: found.count, dollars: dollars(found.costAtLeast), share: share(found.costAtLeast) })),
			{ signal: `retry streak, at least (${waste.retries.sessions} sessions, ${waste.retries.attempts} attempts, ${waste.retries.fixed} fixed; overlaps loops)`, count: waste.retries.count, dollars: waste.retries.costAtLeast, share: share(waste.retries.costAtLeast) },
			{ signal: 'subagent runs, raw cost, no verdict', count: waste.subagents.runs, dollars: waste.subagents.cost, share: share(waste.subagents.cost) }
		]);
		const delivering = rows.filter((row) => row.mrs.length > 0);
		const mrCount = delivering.reduce((total, row) => total + row.mrs.length, 0);
		const deliveringCost = dollars(delivering.reduce((total, row) => total + row.cost, 0));
		console.log(`Merge requests created: ${mrCount} in ${delivering.length} sessions. These sessions cost ${deliveringCost} dollars (${share(deliveringCost)} of the total).`);
	}
	if (process.argv.includes('--serve')) serve(viewerDir, outDir, port);
}

if (import.meta.main) main();
