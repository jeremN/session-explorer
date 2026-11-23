// eval watch: which watched instruction files (a CLAUDE.md, an AGENTS.md, a skill directory) changed since their last
// measure, and the measure of each change on demand. It works outside git too (~/.claude is no repository): the
// version before a change is the copy that the last measure kept, not HEAD.
// Usage: node eval-runner/watch.ts [--run] [--only <name>[,<name>]] [--status-line] [--watch <watch.json>] [--claude <path>] [--out <dir>]
// Without --run it spends nothing: it lists the changes and the most that their measure can cost.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { main as diffMain } from './diff.ts';
import { loadSpec } from './spec.ts';

const USAGE = `Usage: node eval-runner/watch.ts [--run] [--only <name>[,<name>]] [--status-line] [--watch <watch.json>] [--claude <path>] [--out <dir>]

  (no option)    list the watched files that changed since their last measure, and the most each measure can cost
  --run          measure each change with eval:diff, then keep the new version as the next "before"; a file never
                 measured gets its first copy, with no measure and no spend
  --only N       only these watched files (by the name in the list)
  --status-line  print one line when a watched file changed, and nothing otherwise (for a SessionStart hook)
  --watch P      the list of watched files (default eval-runner/out/watch.json)
  --out D        where eval:diff writes its evals (default: the folder of the list)

watch.json: { "watch": [{ "file": "~/.claude/skills/tidy", "spec": "suites/tidy.json", "config": "sonnet", "runs": 3, "maxRuns": 6 }] }
  file   a CLAUDE.md, an AGENTS.md or a skill directory; ~ is your home
  spec   the task that measures it (relative to watch.json); config, runs and maxRuns go to eval:diff
`;

export type Entry = { file: string; spec: string; config?: string; runs: number; maxRuns: number };
type Saved = { hash: string; at: string; verdict?: string; evalDir?: string };
export type Status = 'missing' | 'new' | 'changed' | 'same';

// The content of a file, or of every file of a directory with its relative path, in a stable order. `.git` is skipped.
export function fingerprint(path: string): string {
	const hash = createHash('sha256');
	const walk = (current: string) => {
		if (statSync(current).isDirectory()) {
			for (const name of readdirSync(current).sort()) if (name !== '.git' && name !== '.DS_Store') walk(join(current, name));
			return;
		}
		hash.update(relative(path, current)).update('\0').update(readFileSync(current)).update('\0');
	};
	walk(path);
	return hash.digest('hex');
}

const expand = (path: string, base: string) => (path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : isAbsolute(path) ? path : resolve(base, path));

export function loadWatch(file: string): Entry[] {
	const raw = JSON.parse(readFileSync(file, 'utf8')) as { watch?: unknown };
	if (!Array.isArray(raw.watch)) throw new Error(`${file}: "watch" must be an array`);
	const base = dirname(file);
	const count = (value: unknown, field: string, fallback: number) => {
		if (value === undefined) return fallback;
		if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 20) throw new Error(`${file}: ${field} must be an integer from 1 to 20`);
		return value as number;
	};
	return raw.watch.map((item, index) => {
		const entry = item as Record<string, unknown>;
		const at = `watch[${index}]`;
		if (typeof entry.file !== 'string' || typeof entry.spec !== 'string') throw new Error(`${file}: ${at} needs "file" and "spec"`);
		if (entry.config !== undefined && typeof entry.config !== 'string') throw new Error(`${file}: ${at}.config must be a string`);
		const runs = count(entry.runs, `${at}.runs`, 3);
		const maxRuns = count(entry.maxRuns, `${at}.maxRuns`, 10);
		if (maxRuns < runs) throw new Error(`${file}: ${at}.maxRuns must be at least runs`);
		return { file: expand(entry.file, base), spec: expand(entry.spec, base), ...(entry.config ? { config: entry.config } : {}), runs, maxRuns };
	});
}

// The name of an entry in the list and on disk: the file name, and a short hash of the file and the spec. One file can
// have two entries, one per task: each keeps its own copy and its own verdict.
export const nameOf = (entry: Entry) => `${basename(entry.file)}-${createHash('sha256').update(`${entry.file}\0${entry.spec}`).digest('hex').slice(0, 6)}`;

export function statusOf(entry: Entry, saved: Saved | undefined): Status {
	if (!existsSync(entry.file)) return 'missing';
	if (!saved) return 'new';
	return fingerprint(entry.file) === saved.hash ? 'same' : 'changed';
}

// The most a measure can spend: every run of both sides, at the cap of a run. The cache pays each run once.
export function maxCost(entry: Entry) {
	return 2 * entry.maxRuns * loadSpec(entry.spec).budget.perRunUsd;
}

// The newest eval of the derived spec of eval:diff that holds a report written after `since`.
function reportAfter(out: string, specName: string, since: number) {
	const dirs = existsSync(out) ? readdirSync(out).filter((name) => name.endsWith(`-${specName}-diff`) && existsSync(join(out, name, 'diff.json'))) : [];
	const fresh = dirs.map((name) => join(out, name)).filter((dir) => statSync(join(dir, 'diff.json')).mtimeMs >= since);
	const dir = fresh.sort().pop();
	return dir ? { dir, report: JSON.parse(readFileSync(join(dir, 'diff.json'), 'utf8')) as { verdict: string } } : undefined;
}

type Deps = { diff: (argv: string[]) => Promise<number>; now: () => Date };

export async function main(argv: string[], deps: Deps = { diff: (args) => diffMain(args), now: () => new Date() }): Promise<number> {
	const options = { run: false, only: undefined as string[] | undefined, statusLine: false, watch: join(import.meta.dirname, 'out', 'watch.json'), claude: undefined as string | undefined, out: undefined as string | undefined };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === '--run') options.run = true;
		else if (flag === '--status-line') options.statusLine = true;
		else if (flag === '--only') options.only = argv[++index]?.split(',');
		else if (flag === '--watch') options.watch = resolve(argv[++index] ?? '');
		else if (flag === '--claude') options.claude = argv[++index];
		else if (flag === '--out') options.out = resolve(argv[++index] ?? '');
		else if (flag === '--help' || flag === '-h') {
			console.log(USAGE);
			return 0;
		} else {
			console.error(`${flag}: unknown option\n\n${USAGE}`);
			return 2;
		}
	}
	// The evals of eval:diff go next to the list, unless --out names another folder.
	const out = options.out ?? dirname(options.watch);
	// A SessionStart hook must never stop a session: the status line says nothing on an error.
	if (options.statusLine) {
		try {
			if (!existsSync(options.watch)) return 0;
			const state = readState(options.watch);
			const changed = [...new Set(loadWatch(options.watch).filter((entry) => statusOf(entry, state[nameOf(entry)]) === 'changed').map((entry) => basename(entry.file)))];
			if (changed.length) console.log(`eval:watch: ${changed.length} watched file(s) changed since their last measure (${changed.join(', ')}). See pnpm eval:watch.`);
		} catch {}
		return 0;
	}
	if (!existsSync(options.watch)) {
		console.error(`No list of watched files at ${options.watch}.\n\n${USAGE}`);
		return 2;
	}
	let entries: Entry[];
	try {
		entries = loadWatch(options.watch);
	} catch (error) {
		console.error((error as Error).message);
		return 2;
	}
	if (options.only) {
		const unknown = options.only.filter((name) => !entries.some((entry) => nameOf(entry) === name));
		if (unknown.length) {
			console.error(`--only: unknown name ${unknown.join(', ')}. Names: ${entries.map(nameOf).join(', ')}`);
			return 2;
		}
		entries = entries.filter((entry) => options.only!.includes(nameOf(entry)));
	}
	const state = readState(options.watch);
	const store = join(dirname(options.watch), 'watch');
	let failed = 0;
	let total = 0;
	for (const entry of entries) {
		const name = nameOf(entry);
		const status = statusOf(entry, state[name]);
		const last = state[name]?.verdict ? `, last measure: ${state[name].verdict} (${state[name].at.slice(0, 10)})` : '';
		let cost = 0;
		try {
			cost = status === 'changed' ? maxCost(entry) : 0;
		} catch (error) {
			console.error(`${name}: ${entry.spec}: ${(error as Error).message}`);
			failed++;
			continue;
		}
		total += cost;
		console.log(`${name}: ${status === 'new' ? 'never measured' : status === 'same' ? 'unchanged' : status}${status === 'changed' ? `, at most ${cost} $ to measure` : ''}${last}`);
		if (!options.run || status === 'same' || status === 'missing') continue;
		const copy = join(store, name, basename(entry.file));
		const keep = (verdict?: string, evalDir?: string) => {
			rmSync(join(store, name), { recursive: true, force: true });
			mkdirSync(join(store, name), { recursive: true });
			cpSync(entry.file, copy, { recursive: true });
			state[name] = { hash: fingerprint(copy), at: deps.now().toISOString(), ...(verdict ? { verdict } : {}), ...(evalDir ? { evalDir } : {}) };
			writeState(options.watch, state);
		};
		if (status === 'new') {
			keep();
			console.log(`${name}: first copy kept. The next change is measured against it.`);
			continue;
		}
		const since = deps.now().getTime();
		const code = await deps.diff([entry.spec, '--file', entry.file, '--before', copy, '--runs', String(entry.runs), '--max-runs', String(entry.maxRuns), '--out', out, ...(entry.config ? ['--config', entry.config] : []), ...(options.claude ? ['--claude', options.claude] : [])]);
		const found = reportAfter(out, loadSpec(entry.spec).name, since - 1000);
		// A measure that did not finish keeps the old copy: the change stays to measure.
		if (code !== 0 || !found) {
			console.error(`${name}: the measure did not finish (exit code ${code}). The old copy stays.`);
			failed++;
			continue;
		}
		keep(found.report.verdict, found.dir);
		console.log(`${name}: ${found.report.verdict}. Report: ${join(found.dir, 'diff.json')}`);
	}
	if (!options.run && total > 0) console.log(`\nMeasuring every change costs at most ${total} $. Run again with --run.`);
	return failed ? 1 : 0;
}

const stateFile = (watch: string) => join(dirname(watch), 'watch', 'state.json');
function readState(watch: string): Record<string, Saved> {
	const file = stateFile(watch);
	return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Saved>) : {};
}
function writeState(watch: string, state: Record<string, Saved>) {
	mkdirSync(dirname(stateFile(watch)), { recursive: true });
	writeFileSync(stateFile(watch), JSON.stringify(state, null, '\t'));
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
