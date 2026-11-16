// Scores the transcript of one run with the session-explorer pipeline. No metric is computed here.
import { join } from 'node:path';

import { listJsonl, loadConfig, readLines, traceTasks } from '../context-tracer/tracer.ts';
import { priceEvents, readAgentMeta, summarizeSession } from '../session-explorer/build.ts';
import { createdMrs, mrMentions } from '../session-explorer/mr.ts';
import { parseSession } from '../session-explorer/parse.ts';
import type { AgentMeta } from '../session-explorer/parse.ts';
import { findWaste } from '../session-explorer/waste.ts';
import type { RunMetrics } from './stats.ts';

export function scoreRun(entries: unknown[], subagentMeta: Record<string, AgentMeta>, sessionId: string) {
	loadConfig();
	const parsed = parseSession(entries, subagentMeta);
	if (!parsed) return undefined;
	parsed.events = priceEvents(parsed.events);
	const { tasks } = traceTasks(entries);
	const summary = summarizeSession(sessionId, 'eval', parsed, tasks);
	const waste = findWaste(parsed.events, parsed.agents);
	const mrs = createdMrs([{ session: sessionId, mentions: mrMentions(entries) }])[sessionId] ?? [];
	const metrics: RunMetrics = {
		cost: summary.cost,
		billedTokens: summary.billedTokens,
		cacheReadShare: summary.cacheReadShare,
		errors: summary.errors,
		denials: summary.denials,
		outages: summary.outages,
		verified: summary.tasks.verified,
		failed: summary.tasks.failed,
		loops: waste.loops.length,
		retries: waste.retries.length,
		subagentCost: Math.round(waste.subagents.reduce((total, run) => total + run.cost, 0) * 100) / 100
	};
	return {
		metrics,
		summary,
		mrs,
		session: { id: sessionId, title: parsed.title, agents: parsed.agents, events: parsed.events, tasks }
	};
}

// Reads the transcript of a run and its subagent files, then scores them.
export function scoreFiles(transcript: string, sessionId: string) {
	const subagentFiles = listJsonl(join(transcript.slice(0, -'.jsonl'.length), 'subagents'));
	const entries = [transcript, ...subagentFiles].flatMap(readLines);
	return scoreRun(entries, readAgentMeta(subagentFiles), sessionId);
}
