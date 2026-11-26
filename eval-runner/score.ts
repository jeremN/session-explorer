// Scores the transcript of one run with the session-explorer pipeline. No metric is computed here.
import { join } from 'node:path';

import { configureKnowledge, listJsonl, loadConfig, mergeCommands, readLines, traceTasks } from '../context-tracer/tracer.ts';
import type { CommandPatterns } from '../context-tracer/tracer.ts';
import { behaviorOf } from '../session-explorer/behavior.ts';
import { priceEvents, readAgentMeta, summarizeSession } from '../session-explorer/build.ts';
import { createdMrs, mrMentions } from '../session-explorer/mr.ts';
import { parseSession } from '../session-explorer/parse.ts';
import type { AgentMeta } from '../session-explorer/parse.ts';
import { findWaste } from '../session-explorer/waste.ts';
import type { RunMetrics } from './stats.ts';

// Loads the user config, with the command patterns of the spec added to its own. The next call loads it again.
function configure(commands?: CommandPatterns) {
	const config = loadConfig();
	if (commands) configureKnowledge({ ...config, commands: mergeCommands(config.commands, commands) });
}

// `commands`: the command patterns of the spec (spec.commands).
export function scoreRun(entries: unknown[], subagentMeta: Record<string, AgentMeta>, sessionId: string, commands?: CommandPatterns) {
	configure(commands);
	const parsed = parseSession(entries, subagentMeta);
	if (!parsed) return undefined;
	parsed.events = priceEvents(parsed.events);
	const { tasks } = traceTasks(entries);
	const behavior = behaviorOf(entries);
	const summary = summarizeSession(sessionId, 'eval', parsed, tasks, behavior.metrics);
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
		subagentCost: Math.round(waste.subagents.reduce((total, run) => total + run.cost, 0) * 100) / 100,
		...skillLoads(entries),
		...behavior.metrics
	};
	return {
		metrics,
		steps: behavior.steps.map((step) => step.primary),
		summary,
		mrs,
		session: { id: sessionId, title: parsed.title, agents: parsed.agents, events: parsed.events, tasks }
	};
}

// A skill that never loads cannot help. The Skill tool calls of the session and of its subagents, per skill.
export function skillLoads(entries: unknown[]) {
	const skills: Record<string, number> = {};
	for (const entry of entries as Array<Record<string, any>>) {
		if (entry?.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
		for (const block of entry.message.content) {
			if (block?.type !== 'tool_use' || block.name !== 'Skill') continue;
			const name = typeof block.input?.skill === 'string' && block.input.skill ? block.input.skill : 'unknown';
			skills[name] = (skills[name] ?? 0) + 1;
		}
	}
	return { skillLoads: Object.values(skills).reduce((total, count) => total + count, 0), skills };
}

const readRun = (transcript: string) => {
	const subagentFiles = listJsonl(join(transcript.slice(0, -'.jsonl'.length), 'subagents'));
	return { subagentFiles, entries: [transcript, ...subagentFiles].flatMap(readLines) };
};

// Reads the transcript of a run and its subagent files, then scores them.
export function scoreFiles(transcript: string, sessionId: string, commands?: CommandPatterns) {
	const { subagentFiles, entries } = readRun(transcript);
	return scoreRun(entries, readAgentMeta(subagentFiles), sessionId, commands);
}

// Only the behavior counts and the steps of a saved run, for a run of an older eval or a run from the cache.
// The other metrics keep their values: a new price table or a new check rule must not change an old result.
export function behaviorFiles(transcript: string, commands?: CommandPatterns) {
	configure(commands);
	const { metrics, steps } = behaviorOf(readRun(transcript).entries);
	return { metrics, steps: steps.map((step) => step.primary) };
}
