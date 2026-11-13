// Loads and validates an eval spec. Every error names the field and carries exit code 2.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class SpecError extends Error {
	exitCode = 2;
}

export const PERMISSION_MODES = ['acceptEdits', 'auto', 'dontAsk', 'plan'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type Config = {
	name: string;
	model?: string;
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
};
export type Spec = {
	name: string;
	dir: string;
	task: { repo: string; base: string; prompt?: string; promptFile?: string; timeoutSec: number; acceptance: { command: string; timeoutSec: number } };
	budget: { perRunUsd: number; perEvalUsd: number };
	runs: number;
	configs: Config[];
};

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

export function validateSpec(raw: unknown, dir: string): Spec {
	const spec = object(raw, 'spec', ['name', 'task', 'budget', 'runs', 'configs']);
	const name = string(spec.name, 'spec.name');
	if (!/^[a-z0-9-]+$/.test(name)) fail('spec.name', 'must match [a-z0-9-]+');

	const task = object(spec.task, 'spec.task', ['repo', 'base', 'prompt', 'promptFile', 'timeoutSec', 'acceptance']);
	const prompt = optional(task.prompt, 'spec.task.prompt', string);
	const promptFile = optional(task.promptFile, 'spec.task.promptFile', string);
	if ((prompt === undefined) === (promptFile === undefined)) fail('spec.task.prompt', 'set exactly one of prompt and promptFile');
	const acceptance = object(task.acceptance, 'spec.task.acceptance', ['command', 'timeoutSec']);

	const budget = object(spec.budget, 'spec.budget', ['perRunUsd', 'perEvalUsd']);
	const runs = optional(spec.runs, 'spec.runs', (value, field) => number(value, field, 1, 20, true)) ?? 3;

	if (!Array.isArray(spec.configs) || spec.configs.length < 1 || spec.configs.length > 8) fail('spec.configs', 'required array of 1 to 8 configs');
	const seen = new Set<string>();
	const configs = (spec.configs as unknown[]).map((entry, index) => {
		const at = `spec.configs[${index}]`;
		const config = object(entry, at, ['name', 'model', 'claudeMd', 'appendSystemPrompt', 'settings', 'skills', 'plugins', 'permissionMode', 'allowedTools', 'disallowedTools', 'mcpConfig', 'bare']);
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
		return result;
	});

	return {
		name,
		dir,
		task: {
			repo: resolve(dir, string(task.repo, 'spec.task.repo')),
			base: optional(task.base, 'spec.task.base', string) ?? 'HEAD',
			...(prompt === undefined ? {} : { prompt }),
			...(promptFile === undefined ? {} : { promptFile: resolve(dir, promptFile) }),
			timeoutSec: optional(task.timeoutSec, 'spec.task.timeoutSec', (value, field) => number(value, field, 1)) ?? 900,
			acceptance: {
				command: string(acceptance.command, 'spec.task.acceptance.command'),
				timeoutSec: optional(acceptance.timeoutSec, 'spec.task.acceptance.timeoutSec', (value, field) => number(value, field, 1)) ?? 300
			}
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
