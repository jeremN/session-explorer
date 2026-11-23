// Turns one configuration into the argv of `claude` and the files that go with it. Pure, except the optional file read.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Config } from './spec.ts';

export type Context = { sessionId: string; perRunUsd: number; runDir: string };
export type GeneratedFile = { path: string; content: string };

const EMPTY_MCP = '{"mcpServers":{}}';
// The agent has no remote in its clone. This ban is a second barrier.
const ALWAYS_DISALLOWED = 'Bash(git push:*)';
// The deny rule is a prefix rule: `git -C . push` or `env git push` bypass it. This environment turns off every git
// transport for the agent, a local path included. An agent with a shell can still unset it, so the clone stays the main guard.
// The Bash sandbox of Claude Code: commands and their children write only in the clone, with no network.
// The runner locks these keys: no start without the sandbox, no retry of a blocked command outside it, and no command
// that runs outside it. The empty `excludedCommands` here also keeps out an exclusion from the settings of the clone.
// Read, Edit and Write are not sandboxed; the permission rules guard them.
const SANDBOX = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, excludedCommands: [] as string[] };

export const AGENT_ENV: Record<string, string> = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.allow', GIT_CONFIG_VALUE_0: 'never' };

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
	if (config.effort) args.push('--effort', config.effort);
	if (config.appendSystemPrompt) args.push('--append-system-prompt', config.appendSystemPrompt);
	if (config.sandbox) args.push('--settings', generated('settings.json', withSandbox(config.settings, readText)));
	else if (config.settings !== undefined) args.push('--settings', generated('settings.json', config.settings));
	for (const plugin of config.plugins ?? []) args.push('--plugin-dir', plugin);
	// The user MCP servers would leak into every configuration, so the config is always strict.
	args.push('--mcp-config', generated('mcp.json', config.mcpConfig, EMPTY_MCP), '--strict-mcp-config');
	if (config.allowedTools?.length) args.push('--allowedTools', ...config.allowedTools);
	args.push('--disallowedTools', ALWAYS_DISALLOWED, ...(config.disallowedTools ?? []));
	return { args, files, env: AGENT_ENV };
}

function withSandbox(settings: Config['settings'], readText: (path: string) => string) {
	let base: unknown = settings ?? {};
	if (typeof settings === 'string') {
		try {
			base = JSON.parse(readText(settings));
		} catch {
			base = undefined;
		}
	}
	const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
	if (!isObject(base)) throw new Error(`${typeof settings === 'string' ? settings : 'settings'}: a sandbox config needs settings that are a JSON object`);
	const own = isObject(base.sandbox) ? base.sandbox : {};
	return { ...base, sandbox: { ...own, ...SANDBOX } };
}

// What the runner writes into the clone before the setup commit.
export function setupFiles(config: Config) {
	// codex and opencode read AGENTS.md. Claude Code reads CLAUDE.md, the default of the workspace.
	return { claudeMd: config.claudeMd, skills: config.skills ?? [], ...(config.agent ? { instructionFile: 'AGENTS.md' } : {}) };
}
