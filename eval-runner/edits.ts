// Pattern edits of the files of a clone: replace, moveSection, removeSection, append and prepend. An edit applies to
// the text of the base commit, so one config serves every base. An edit that does not apply is an error: a variant
// that is silently the same as the base would falsify the measure.
// Usage: node eval-runner/edits.ts <spec.json> [--config <name>] [--write <dir>]
// It prints the diff that the edits of each config give at the base of the spec. It starts no agent and spends nothing.
// Exit codes: 0 every edit applies, 1 an edit fails, 2 invalid spec or arguments.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { realExec } from './exec.ts';
import type { Exec } from './exec.ts';
import { SpecError, headingRegex, loadSpec } from './spec.ts';
import type { Config, Edit } from './spec.ts';
import { resolveBase } from './workspace.ts';

export class EditError extends Error {
	name = 'EditError';
}

// `before` is absent for a file that the edits create.
export type EditedFile = { path: string; before?: string; after: string };

type Heading = { index: number; level: number; text: string; line: string };
// A section starts at its heading and ends at the next heading of the same or a higher level. Its body stops before
// the blank lines and the `---` rule at its end, as make-variants.py trims a section.
type Section = { start: number; body: number; end: number };

const times = (count: number) => `${count} time${count === 1 ? '' : 's'}`;

// The Markdown headings outside the code fences. A `# comment` in a shell block is no heading.
function headingsOf(lines: string[]): Heading[] {
	const found: Heading[] = [];
	let fence: string | undefined;
	for (const [index, line] of lines.entries()) {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (marker) {
			if (fence === undefined) fence = marker[1];
			// A fence closes on a line of the same character, at least as long, with nothing after it.
			else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === '') fence = undefined;
			continue;
		}
		if (fence !== undefined) continue;
		const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t\r]*$/.exec(line);
		if (heading) found.push({ index, level: heading[1].length, text: (heading[2] ?? '').trim(), line });
	}
	return found;
}

// A heading matches by its text, by its full line, or by a /regex/ on its line. Exactly one heading must match.
function findHeading(headings: Heading[], query: string): Heading {
	const pattern = headingRegex(query);
	const wanted = query.trim();
	const matches = headings.filter((heading) => (pattern ? pattern.test(heading.line) : heading.line.trim() === wanted || heading.text === wanted));
	if (matches.length === 0) throw new EditError(`no heading matches "${query}"`);
	if (matches.length > 1) throw new EditError(`"${query}" matches ${matches.length} headings, lines ${matches.map((heading) => heading.index + 1).join(', ')}`);
	return matches[0];
}

function sectionOf(lines: string[], headings: Heading[], heading: Heading): Section {
	const next = headings.find((other) => other.index > heading.index && other.level <= heading.level);
	const end = next ? next.index : lines.length;
	let body = end;
	while (body > heading.index + 1 && ['', '---'].includes(lines[body - 1].trim())) body--;
	return { start: heading.index, body, end };
}

// The last newline of the file is no line of its own, so a section at the end keeps the newline of the file.
function linesOf(text: string) {
	const eol = text.endsWith('\n');
	return { eol, lines: (eol ? text.slice(0, -1) : text).split('\n') };
}
const textOf = (lines: string[], eol: boolean) => lines.join('\n') + (eol ? '\n' : '');

function replace(edit: Extract<Edit, { replace: string }>, text: string) {
	const pattern = new RegExp(edit.replace, `${edit.flags ?? ''}g`);
	const found = [...text.matchAll(pattern)].length;
	const expected = edit.count ?? 1;
	if (found !== expected) throw new EditError(`the pattern matches ${times(found)}, expected ${expected}`);
	return text.replace(pattern, edit.with);
}

// Without a pointer, the whole section goes, its trailing rule too. With a pointer, the pointer takes the place of the
// body and the trailing rule stays.
function removeSection(edit: Extract<Edit, { removeSection: string }>, text: string) {
	const { eol, lines } = linesOf(text);
	const headings = headingsOf(lines);
	const section = sectionOf(lines, headings, findHeading(headings, edit.removeSection));
	const kept = edit.pointer === undefined ? [] : [edit.pointer, ...lines.slice(section.body, section.end)];
	return textOf([...lines.slice(0, section.start), ...kept, ...lines.slice(section.end)], eol);
}

// The section moves with its trailing blank lines and rule, to the start of the `before` section or to the end of the
// `after` section (after its subsections).
function moveSection(edit: Extract<Edit, { moveSection: string }>, text: string) {
	const { eol, lines } = linesOf(text);
	const headings = headingsOf(lines);
	const moved = sectionOf(lines, headings, findHeading(headings, edit.moveSection));
	const query = edit.after ?? edit.before!;
	const target = findHeading(headings, query);
	if (target.index >= moved.start && target.index < moved.end) throw new EditError(`the target heading "${query}" is inside the moved section`);
	const place = edit.after !== undefined ? sectionOf(lines, headings, target).end : target.index;
	const old = edit.pointer === undefined ? [] : [edit.pointer, ...lines.slice(moved.body, moved.end)];
	let block = lines.slice(moved.start, moved.end);
	const [head, tail] =
		place <= moved.start
			? [lines.slice(0, place), [...lines.slice(place, moved.start), ...old, ...lines.slice(moved.end)]]
			: [[...lines.slice(0, moved.start), ...old, ...lines.slice(moved.end, place)], lines.slice(place)];
	// A section that was last has no blank line after it; a section that becomes last needs one before it.
	if (tail.length === 0) {
		if (head.length > 0 && head.at(-1)!.trim() !== '') block = ['', ...block];
	} else if (moved.body === moved.end) block = [...block, ''];
	return textOf([...head, ...block, ...tail], eol);
}

function applyOne(edit: Edit, text: string | undefined): string {
	const creates = ('append' in edit || 'prepend' in edit) && edit.create === true;
	if (text === undefined && !creates) throw new EditError('the file does not exist');
	const current = text ?? '';
	if ('replace' in edit) return replace(edit, current);
	if ('removeSection' in edit) return removeSection(edit, current);
	if ('moveSection' in edit) return moveSection(edit, current);
	// The text goes in as it is: start it with a newline when the file needs one.
	return 'append' in edit ? current + edit.append : edit.prepend + current;
}

// Applies the edits in order. `read` gives the text of a file before the edits, or undefined when the file does not
// exist. Each later edit of a file sees the text of the edit before. The error names the edit and the file.
export function applyEdits(edits: Edit[], read: (path: string) => string | undefined): EditedFile[] {
	const files = new Map<string, { before?: string; text?: string }>();
	for (const [index, edit] of edits.entries()) {
		try {
			if (!files.has(edit.file)) {
				const before = read(edit.file);
				files.set(edit.file, { before, text: before });
			}
			const file = files.get(edit.file)!;
			file.text = applyOne(edit, file.text);
		} catch (error) {
			throw new EditError(`edits[${index}] ${edit.file}: ${(error as Error).message}`);
		}
	}
	return [...files].map(([path, { before, text }]) => ({ path, ...(before === undefined ? {} : { before }), after: text! }));
}

// No user or system git config: it could change the paths or the colors of the diff.
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

// The text of a file in the clone before the edits: the base commit, then `remove`, then `files`, as createWorkspace
// does. It reads the source repository with `ls-tree` and `cat-file`, which change nothing.
async function baseText(exec: Exec, repo: string, baseSha: string, config: Config, path: string): Promise<string | undefined> {
	const written = config.files?.[path];
	if (written) return 'text' in written ? written.text : readFileSync(written.file, 'utf8');
	if (config.remove?.some((removed) => path === removed || path.startsWith(`${removed}/`))) return undefined;
	const listed = await exec('git', ['ls-tree', '-z', '--full-tree', baseSha, '--', path], { cwd: repo, env: GIT_ENV });
	if (listed.code !== 0) throw new Error(`git ls-tree failed: ${listed.stderr.trim()}`);
	if (!listed.stdout) return undefined;
	const [mode, type, object] = listed.stdout.split('\t')[0].split(' ');
	if (mode === '120000') throw new Error('the file is a symlink');
	if (type !== 'blob') throw new Error('not a file at the base commit');
	const shown = await exec('git', ['cat-file', 'blob', object], { cwd: repo, env: GIT_ENV });
	if (shown.code !== 0) throw new Error(`git cat-file failed: ${shown.stderr.trim()}`);
	return shown.stdout;
}

// The files that the edits of a config give at the base commit, without a clone. The run cache, edits.patch and the
// dry run read this text. The clone applies the same edits to its files (createWorkspace).
export async function previewEdits(exec: Exec, { repo, baseSha, config }: { repo: string; baseSha: string; config: Config }): Promise<EditedFile[]> {
	const edits = config.edits ?? [];
	const texts = new Map<string, string | undefined>();
	const errors = new Map<string, Error>();
	for (const path of new Set(edits.map((edit) => edit.file))) {
		try {
			texts.set(path, await baseText(exec, repo, baseSha, config, path));
		} catch (error) {
			errors.set(path, error as Error);
		}
	}
	return applyEdits(edits, (path) => {
		if (errors.has(path)) throw errors.get(path);
		return texts.get(path);
	});
}

// One git diff per file, from the text before the edits to the text after. `git apply` takes the result.
export async function editsPatch(exec: Exec, files: EditedFile[]): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), 'eval-edits-'));
	try {
		let patch = '';
		for (const { path, before, after } of files) {
			for (const [side, text] of [['a', before], ['b', after]] as const) {
				if (text === undefined) continue;
				mkdirSync(dirname(join(dir, side, path)), { recursive: true });
				writeFileSync(join(dir, side, path), text);
			}
			const diff = await exec('git', ['diff', '--no-index', '--no-prefix', '--no-color', '--no-ext-diff', '--no-textconv', before === undefined ? '/dev/null' : `a/${path}`, `b/${path}`], { cwd: dir, env: GIT_ENV });
			// Exit code 1 means that the files differ.
			if (diff.code !== 0 && diff.code !== 1) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
			// For a new file, git names the second path on both sides of the first line.
			patch += before === undefined ? diff.stdout.replace(/^diff --git [^\n]*/, `diff --git a/${path} b/${path}`) : diff.stdout;
		}
		return patch;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const USAGE = `Usage: node eval-runner/edits.ts <spec.json> [--config <name>] [--write <dir>]

  <spec.json>   the eval spec. The edits apply to the files of task.base in task.repo.
  --config N    only this configuration
  --write DIR   also write each edited file to DIR/<config>/<path>

It prints the diff of the edits of each configuration. It starts no agent and spends nothing.
`;

export async function main(argv: string[], exec: Exec = realExec): Promise<number> {
	let specPath: string | undefined;
	let only: string | undefined;
	let write: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === '--help' || flag === '-h') {
			console.log(USAGE);
			return 0;
		} else if (flag === '--config') only = argv[++index];
		else if (flag === '--write') write = argv[++index] && resolve(argv[index]);
		else if (!flag.startsWith('-') && !specPath) specPath = flag;
		else {
			console.error(`${flag}: unknown option\n\n${USAGE}`);
			return 2;
		}
	}
	let configs: Config[];
	let spec: ReturnType<typeof loadSpec>;
	try {
		if (!specPath) throw new SpecError('<spec.json>: required');
		spec = loadSpec(specPath);
		if (only !== undefined && !spec.configs.some((config) => config.name === only)) throw new SpecError(`--config: unknown config ${only}`);
		configs = spec.configs.filter((config) => config.edits && (only === undefined || config.name === only));
		if (configs.length === 0) throw new SpecError(only === undefined ? 'no config of the spec has edits' : `--config: ${only} has no edits`);
	} catch (error) {
		if (!(error instanceof SpecError)) throw error;
		console.error(`${error.message}\n\n${USAGE}`);
		return 2;
	}
	let baseSha: string;
	try {
		baseSha = await resolveBase(exec, spec.task.repo, spec.task.base);
	} catch (error) {
		console.error((error as Error).message);
		return 2;
	}
	console.log(`Edits at ${baseSha.slice(0, 7)} of ${spec.task.repo}`);
	let failed = false;
	for (const config of configs) {
		console.log(`== ${config.name} ==`);
		try {
			const files = await previewEdits(exec, { repo: spec.task.repo, baseSha, config });
			console.log((await editsPatch(exec, files)).trimEnd() || '(the edits change nothing)');
			for (const file of files) {
				if (!write) continue;
				mkdirSync(dirname(join(write, config.name, file.path)), { recursive: true });
				writeFileSync(join(write, config.name, file.path), file.after);
			}
		} catch (error) {
			console.error((error as Error).message);
			failed = true;
		}
	}
	return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
