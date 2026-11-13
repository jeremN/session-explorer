// Turns one configuration into the argv of `claude` and the files that go with it. Pure, except the optional file read.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Config } from './spec.ts';

export type Context = { sessionId: string; perRunUsd: number; runDir: string };
export type GeneratedFile = { path: string; content: string };

const EMPTY_MCP = '{"mcpServers":{}}';
// The agent has no remote in its clone. This ban is a second barrier.
const ALWAYS_DISALLOWED = 'Bash(git push:*)';

export function buildCommand(config: Config, context: Context, readText: (path: string) => string = (path) => readFileSync(path, 'utf8')) {
	const files: GeneratedFile[] = [];
	// A file or an object becomes a file of the run directory, so the result keeps what the agent really got.
	const generated = (name: string, value: Config['settings'], fallback?: string) => {
		const path = join(context.runDir, name);
		const content = typeof value === 'string' ? readText(value) : value === undefined ? fallback : JSON.stringify(value);
		if (content !== undefined) files.push({ path, content });
		return path;
	};

	// `--setting-sources project,local` keeps the user hooks and plugins out. `settings` and `plugins` add them back.
	const args = ['-p', '--output-format', 'json', '--session-id', context.sessionId, '--max-budget-usd', String(context.perRunUsd), '--permission-prompts', 'none', '--setting-sources', 'project,local'];
	args.push('--permission-mode', config.permissionMode ?? 'auto');
	if (config.bare) args.push('--bare');
	if (config.model) args.push('--model', config.model);
	if (config.appendSystemPrompt) args.push('--append-system-prompt', config.appendSystemPrompt);
	if (config.settings !== undefined) args.push('--settings', generated('settings.json', config.settings));
	for (const plugin of config.plugins ?? []) args.push('--plugin-dir', plugin);
	// The user MCP servers would leak into every configuration, so the config is always strict.
	args.push('--mcp-config', generated('mcp.json', config.mcpConfig, EMPTY_MCP), '--strict-mcp-config');
	if (config.allowedTools?.length) args.push('--allowedTools', ...config.allowedTools);
	args.push('--disallowedTools', ALWAYS_DISALLOWED, ...(config.disallowedTools ?? []));
	return { args, files };
}

// What the runner writes into the clone before the setup commit.
export function setupFiles(config: Config) {
	return { claudeMd: config.claudeMd, skills: config.skills ?? [] };
}
