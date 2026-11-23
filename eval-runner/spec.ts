// Loads and validates an eval spec. Every error names the field and carries exit code 2.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class SpecError extends Error {
	exitCode = 2;
}

export const PERMISSION_MODES = ['acceptEdits', 'auto', 'dontAsk', 'plan'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export const AGENT_NAMES = ['claude', 'codex', 'opencode'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
// These fields drive the Claude Code CLI. The other agents have no such option.
const CLAUDE_ONLY = ['appendSystemPrompt', 'settings', 'skills', 'plugins', 'permissionMode', 'allowedTools', 'disallowedTools', 'mcpConfig', 'bare'] as const;
export const EFFORTS = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['low', 'medium', 'high', 'xhigh'] } as const;
export type Effort = (typeof EFFORTS.claude)[number];

export type Config = {
	name: string;
	// Unset means claude. The runner leaves it unset, so the cache keys of the Claude configs stay the same.
	agent?: AgentName;
	// Dollars for one million tokens, for an agent that prints tokens but no cost (codex). cacheRead is a multiple of input.
	price?: { input: number; output: number; cacheRead?: number };
	// Run the agent in a Docker container (codex and opencode). See container.ts.
	container?: boolean;
	// Names of host environment variables passed into the container, for a login the auth file does not hold.
	containerEnv?: string[];
	// Hosts the container may reach besides the defaults of its agent (container/allow.json): a name, or *.domain.
	containerAllow?: string[];
	model?: string;
	// The reasoning effort. Unset: the default of the agent (Claude Code in print mode sends medium). opencode has no
	// flag: it names a variant in the model, provider/model#variant.
	effort?: Effort;
	claudeMd?: { text: string } | { file: string };
	appendSystemPrompt?: string;
	settings?: Record<string, unknown> | string;
	skills?: string[];
	plugins?: string[];
	permissionMode?: PermissionMode;
	allowedTools?: string[];
	disallowedTools?: string[];
	mcpConfig?: Record<string, unknown> | string;
	bare?: boolean;
	sandbox?: boolean;
};
export type Spec = {
	name: string;
	dir: string;
	// category: the kind of task, for the routing table (matrix.ts). Not part of the cache key.
	task: { repo: string; base: string; category?: string; prompt?: string; promptFile?: string; timeoutSec: number; setup?: { command: string; timeoutSec: number }; acceptance: { command: string; timeoutSec: number; infraExitCode?: number }; hiddenTests?: { commit: string; paths: string[] }; services?: Service[] };
	budget: { perRunUsd: number; perEvalUsd: number };
	runs: number;
	configs: Config[];
};

// A container that runs while the agent works, for example the database of the tests. `agentEnv` is the environment the
// agent gets: `${host}` and `${port}` name the service, as the agent reaches it. The acceptance check does not use it.
// The container has no capability but those of `capAdd`, and a read-only root: `tmpfs` lists where it writes.
export type Service = { name: string; image: string; port: number; env?: Record<string, string>; tmpfs?: string[]; capAdd?: string[]; ready: string[]; agentEnv: Record<string, string> };

type Obj = Record<string, unknown>;
const fail = (field: string, problem: string): never => {
	throw new SpecError(`${field}: ${problem}`);
};
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

function object(value: unknown, field: string, known: string[]): Obj {
	if (!isObject(value)) return fail(field, 'required object');
	for (const key of Object.keys(value)) if (!known.includes(key)) fail(`${field}.${key}`, 'unknown field');
	return value;
}
function string(value: unknown, field: string): string {
	return typeof value === 'string' && value !== '' ? value : fail(field, 'required string');
}
function optional<T>(value: unknown, field: string, read: (value: unknown, field: string) => T): T | undefined {
	return value === undefined || value === null ? undefined : read(value, field);
}
function number(value: unknown, field: string, min: number, max = Infinity, integer = false): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
		return fail(field, `required ${integer ? 'integer' : 'number'}${max === Infinity ? ` above ${min}` : ` from ${min} to ${max}`}`);
	}
	return value;
}
function strings(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) return fail(field, 'required array of strings');
	return value.map((item, index) => string(item, `${field}[${index}]`));
}

// A command that prepares the clone before the agent starts, for example `pnpm install --frozen-lockfile`.
function setupOf(value: unknown) {
	const setup = object(value, 'spec.task.setup', ['command', 'timeoutSec']);
	return { command: string(setup.command, 'spec.task.setup.command'), timeoutSec: optional(setup.timeoutSec, 'spec.task.setup.timeoutSec', (entry, field) => number(entry, field, 1)) ?? 600 };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The runner sets these for the agent: a service must not replace them.
const RESERVED_ENV = new Set(['PATH', 'HOME', 'PWD', 'USER', 'TMPDIR', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy']);

function envOf(value: unknown, field: string, reserved: boolean): Record<string, string> {
	const entries = Object.entries(object(value, field, Object.keys(isObject(value) ? value : {})));
	for (const [key, entry] of entries) {
		if (!ENV_NAME.test(key)) fail(`${field}.${key}`, 'must be a variable name');
		if (reserved && RESERVED_ENV.has(key)) fail(`${field}.${key}`, 'the runner sets this variable');
		if (typeof entry !== 'string') fail(`${field}.${key}`, 'required string');
	}
	return Object.fromEntries(entries) as Record<string, string>;
}

function servicesOf(value: unknown): Service[] {
	if (!Array.isArray(value) || value.length === 0) return fail('spec.task.services', 'required non-empty array');
	const names = new Set<string>();
	return value.map((raw, index) => {
		const field = `spec.task.services[${index}]`;
		const service = object(raw, field, ['name', 'image', 'port', 'env', 'tmpfs', 'capAdd', 'ready', 'agentEnv']);
		const name = string(service.name, `${field}.name`);
		// The name is the network alias of the service in a container run: one DNS label.
		if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) fail(`${field}.name`, 'must match [a-z][a-z0-9-]{0,30}');
		if (name === 'eval-proxy' || names.has(name)) fail(`${field}.name`, `${name} is taken`);
		names.add(name);
		const ready = strings(service.ready, `${field}.ready`);
		if (ready.length === 0) fail(`${field}.ready`, 'required non-empty array: the command that succeeds once the service answers');
		const agentEnv = envOf(service.agentEnv, `${field}.agentEnv`, true);
		if (Object.keys(agentEnv).length === 0) fail(`${field}.agentEnv`, 'required non-empty object');
		const tmpfs = optional(service.tmpfs, `${field}.tmpfs`, strings);
		for (const path of tmpfs ?? []) if (!path.startsWith('/')) fail(`${field}.tmpfs`, `${path} must be an absolute path`);
		const env = optional(service.env, `${field}.env`, (entry, at) => envOf(entry, at, false));
		const capAdd = optional(service.capAdd, `${field}.capAdd`, strings);
		for (const cap of capAdd ?? []) if (!/^[A-Z_]+$/.test(cap) || cap === 'ALL' || cap === 'SYS_ADMIN' || cap === 'NET_ADMIN') fail(`${field}.capAdd`, `${cap}: name one capability, not ALL, SYS_ADMIN or NET_ADMIN`);
		return { name, image: string(service.image, `${field}.image`), port: number(service.port, `${field}.port`, 1, 65535, true), ...(env ? { env } : {}), ...(tmpfs ? { tmpfs } : {}), ...(capAdd ? { capAdd } : {}), ready, agentEnv };
	});
}

// The exit code by which the acceptance command says that it failed before it judged the agent. 0 and 1 are taken.
function infraExitCodeOf(value: unknown): { infraExitCode?: number } {
	if (value === undefined || value === null) return {};
	if (!Number.isInteger(value) || (value as number) < 2 || (value as number) > 255) fail('spec.task.acceptance.infraExitCode', 'an integer from 2 to 255');
	return { infraExitCode: value as number };
}

export function validateSpec(raw: unknown, dir: string): Spec {
	const spec = object(raw, 'spec', ['name', 'task', 'budget', 'runs', 'configs']);
	const name = string(spec.name, 'spec.name');
	if (!/^[a-z0-9-]+$/.test(name)) fail('spec.name', 'must match [a-z0-9-]+');

	const task = object(spec.task, 'spec.task', ['repo', 'base', 'category', 'prompt', 'promptFile', 'timeoutSec', 'setup', 'acceptance', 'hiddenTests', 'services']);
	const prompt = optional(task.prompt, 'spec.task.prompt', string);
	const promptFile = optional(task.promptFile, 'spec.task.promptFile', string);
	if ((prompt === undefined) === (promptFile === undefined)) fail('spec.task.prompt', 'set exactly one of prompt and promptFile');
	const acceptance = object(task.acceptance, 'spec.task.acceptance', ['command', 'timeoutSec', 'infraExitCode']);
	let hiddenTests: { commit: string; paths: string[] } | undefined;
	if (task.hiddenTests !== undefined && task.hiddenTests !== null) {
		const hidden = object(task.hiddenTests, 'spec.task.hiddenTests', ['commit', 'paths']);
		const paths = strings(hidden.paths, 'spec.task.hiddenTests.paths');
		if (paths.length === 0) fail('spec.task.hiddenTests.paths', 'required non-empty array');
		// A hidden test is written into the clone: it must stay inside it, and out of the git dir.
		for (const path of paths) {
			const parts = path.split('/');
			if (path.startsWith('/') || parts.includes('..') || parts.includes('') || parts[0] === '.git') fail('spec.task.hiddenTests.paths', `${path} must be a relative path inside the clone, outside .git`);
		}
		hiddenTests = { commit: string(hidden.commit, 'spec.task.hiddenTests.commit'), paths };
	}

	const budget = object(spec.budget, 'spec.budget', ['perRunUsd', 'perEvalUsd']);
	const runs = optional(spec.runs, 'spec.runs', (value, field) => number(value, field, 1, 20, true)) ?? 3;

	if (!Array.isArray(spec.configs) || spec.configs.length < 1 || spec.configs.length > 8) fail('spec.configs', 'required array of 1 to 8 configs');
	const seen = new Set<string>();
	const configs = (spec.configs as unknown[]).map((entry, index) => {
		const at = `spec.configs[${index}]`;
		const config = object(entry, at, ['name', 'model', 'effort', 'claudeMd', 'appendSystemPrompt', 'settings', 'skills', 'plugins', 'permissionMode', 'allowedTools', 'disallowedTools', 'mcpConfig', 'bare', 'sandbox', 'agent', 'price', 'container', 'containerEnv', 'containerAllow']);
		const configName = string(config.name, `${at}.name`);
		if (!/^[a-z0-9-]+$/.test(configName)) fail(`${at}.name`, 'must match [a-z0-9-]+');
		if (seen.has(configName)) fail(`${at}.name`, `duplicate config name "${configName}"`);
		seen.add(configName);
		const result: Config = { name: configName };
		const model = optional(config.model, `${at}.model`, string);
		if (model !== undefined) result.model = model;
		if (config.claudeMd !== undefined && config.claudeMd !== null) {
			const md = object(config.claudeMd, `${at}.claudeMd`, ['text', 'file']);
			if ((md.text === undefined) === (md.file === undefined)) fail(`${at}.claudeMd`, 'set exactly one of text and file');
			result.claudeMd = md.text !== undefined ? { text: string(md.text, `${at}.claudeMd.text`) } : { file: resolve(dir, string(md.file, `${at}.claudeMd.file`)) };
		}
		const append = optional(config.appendSystemPrompt, `${at}.appendSystemPrompt`, string);
		if (append !== undefined) result.appendSystemPrompt = append;
		for (const key of ['settings', 'mcpConfig'] as const) {
			const value = config[key];
			if (value === undefined || value === null) continue;
			result[key] = typeof value === 'string' ? resolve(dir, string(value, `${at}.${key}`)) : isObject(value) ? value : fail(`${at}.${key}`, 'required object or file path');
		}
		for (const key of ['skills', 'plugins'] as const) {
			const value = optional(config[key], `${at}.${key}`, strings);
			if (value) result[key] = value.map((path) => resolve(dir, path));
		}
		for (const key of ['allowedTools', 'disallowedTools'] as const) {
			const value = optional(config[key], `${at}.${key}`, strings);
			if (value) result[key] = value;
		}
		if (config.permissionMode !== undefined && config.permissionMode !== null) {
			if (!(PERMISSION_MODES as readonly unknown[]).includes(config.permissionMode)) fail(`${at}.permissionMode`, `must be one of ${PERMISSION_MODES.join(', ')}`);
			result.permissionMode = config.permissionMode as PermissionMode;
		}
		if (config.bare !== undefined && config.bare !== null) {
			if (typeof config.bare !== 'boolean') fail(`${at}.bare`, 'required boolean');
			result.bare = config.bare as boolean;
		}
		if (config.sandbox !== undefined && config.sandbox !== null) {
			if (typeof config.sandbox !== 'boolean') fail(`${at}.sandbox`, 'required boolean');
			result.sandbox = config.sandbox as boolean;
		}
		if (config.agent !== undefined && config.agent !== null) {
			if (!(AGENT_NAMES as readonly unknown[]).includes(config.agent)) fail(`${at}.agent`, `must be one of ${AGENT_NAMES.join(', ')}`);
			if (config.agent !== 'claude') result.agent = config.agent as AgentName;
		}
		if (config.price !== undefined && config.price !== null) {
			const price = object(config.price, `${at}.price`, ['input', 'output', 'cacheRead']);
			result.price = { input: number(price.input, `${at}.price.input`, 0), output: number(price.output, `${at}.price.output`, 0) };
			const cacheRead = optional(price.cacheRead, `${at}.price.cacheRead`, (value, field) => number(value, field, 0, 1));
			if (cacheRead !== undefined) result.price.cacheRead = cacheRead;
		}
		if (config.container !== undefined && config.container !== null) {
			if (typeof config.container !== 'boolean') fail(`${at}.container`, 'required boolean');
			if (config.container) result.container = true;
		}
		const containerEnv = optional(config.containerEnv, `${at}.containerEnv`, strings);
		if (containerEnv) {
			if (!result.container) fail(`${at}.containerEnv`, 'only for a config with container: true');
			for (const name of containerEnv) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(`${at}.containerEnv`, `${name} is not a variable name`);
			result.containerEnv = containerEnv;
		}
		const containerAllow = optional(config.containerAllow, `${at}.containerAllow`, strings);
		if (containerAllow) {
			if (!result.container) fail(`${at}.containerAllow`, 'only for a config with container: true');
			for (const host of containerAllow) if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) fail(`${at}.containerAllow`, `${host} is not a host name or *.domain`);
			result.containerAllow = containerAllow;
		}
		if (config.effort !== undefined && config.effort !== null) {
			const agent = result.agent ?? 'claude';
			if (agent === 'opencode') fail(`${at}.effort`, 'opencode has no effort flag: name a variant in the model, provider/model#variant');
			const levels: readonly string[] = EFFORTS[agent];
			if (!levels.includes(config.effort as string)) fail(`${at}.effort`, `must be one of ${levels.join(', ')} for ${agent}`);
			result.effort = config.effort as Effort;
		}
		if (result.container && !result.agent) fail(`${at}.container`, 'only codex and opencode run in a container. Claude Code has its own sandbox (sandbox: true)');
		if (result.price && result.agent !== 'codex') fail(`${at}.price`, 'only codex needs a price: the other agents give their cost');
		if (result.agent) {
			for (const key of CLAUDE_ONLY) if (result[key] !== undefined) fail(`${at}.${key}`, `a Claude Code option: agent ${result.agent} has none`);
			// Codex always runs its shell in its workspace-write sandbox. opencode has no sandbox: the spec must say it knows.
			if (result.agent === 'codex' && result.sandbox === false) fail(`${at}.sandbox`, 'codex always runs in its workspace-write sandbox');
			if (result.agent === 'opencode' && !result.container && result.sandbox !== false) fail(`${at}.sandbox`, 'opencode has no sandbox: its shell runs on this machine, outside the clone. Set container: true, or sandbox: false to accept that');
			// Without a model, opencode takes the last model of the user (~/.local/state/opencode/model.json).
			if (result.agent === 'opencode' && !result.model) fail(`${at}.model`, 'opencode needs a model, as provider/model');
		}
		return result;
	});

	return {
		name,
		dir,
		task: {
			repo: resolve(dir, string(task.repo, 'spec.task.repo')),
			base: optional(task.base, 'spec.task.base', string) ?? 'HEAD',
			...(task.category === undefined || task.category === null ? {} : { category: string(task.category, 'spec.task.category') }),
			...(prompt === undefined ? {} : { prompt }),
			...(promptFile === undefined ? {} : { promptFile: resolve(dir, promptFile) }),
			timeoutSec: optional(task.timeoutSec, 'spec.task.timeoutSec', (value, field) => number(value, field, 1)) ?? 900,
			...(task.setup === undefined || task.setup === null ? {} : { setup: setupOf(task.setup) }),
			acceptance: {
				command: string(acceptance.command, 'spec.task.acceptance.command'),
				timeoutSec: optional(acceptance.timeoutSec, 'spec.task.acceptance.timeoutSec', (value, field) => number(value, field, 1)) ?? 300,
				...infraExitCodeOf(acceptance.infraExitCode)
			},
			...(hiddenTests === undefined ? {} : { hiddenTests }),
			...(task.services === undefined || task.services === null ? {} : { services: servicesOf(task.services) })
		},
		budget: {
			perRunUsd: number(budget.perRunUsd, 'spec.budget.perRunUsd', 0.000001),
			perEvalUsd: number(budget.perEvalUsd, 'spec.budget.perEvalUsd', 0.000001)
		},
		runs,
		configs
	};
}

// Reads the file, validates it and loads the prompt text. The prompt is then always in `task.prompt`.
export function loadSpec(path: string): Spec {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		throw new SpecError(`${path}: ${code ? `cannot read the file (${code})` : 'not valid JSON'}`);
	}
	const spec = validateSpec(raw, dirname(resolve(path)));
	if (spec.task.promptFile !== undefined) {
		try {
			spec.task.prompt = readFileSync(spec.task.promptFile, 'utf8');
		} catch {
			throw new SpecError(`spec.task.promptFile: cannot read ${spec.task.promptFile}`);
		}
	}
	return spec;
}
