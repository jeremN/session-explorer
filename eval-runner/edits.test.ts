import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { EditError, applyEdits, editsPatch, main, previewEdits } from './edits.ts';
import { realExec } from './exec.ts';
import type { Edit } from './spec.ts';

// The shape of the AGENTS.md that make-variants.py edits: a merge request section with a heading inside a fence,
// sections that end with a `---` rule, and the line of the frequent commands.
const GUIDE = [
	'# Guide',
	'',
	'Intro line.',
	'',
	'## For code-generation agents',
	'',
	'Agents read this.',
	'',
	'### Creating GitLab merge requests',
	'',
	'Run:',
	'',
	'```sh',
	'glab mr create --description "',
	'### Description',
	'"',
	'```',
	'',
	'---',
	'',
	'## Code Review Rules',
	'',
	'Review well.',
	'',
	'### Mission',
	'',
	'Find bugs.',
	'',
	'---',
	'',
	'## Cross-cutting coding rules',
	'',
	'Be careful.',
	'',
	'## Commands and references',
	'',
	'Frequent commands: `pnpm lint`, `pnpm test`.',
	''
].join('\n');
const lines = GUIDE.split('\n');
const at = (heading: string) => lines.indexOf(heading);
const MR = at('### Creating GitLab merge requests');
const REVIEW = at('## Code Review Rules');
const CROSS = at('## Cross-cutting coding rules');
const COMMANDS = at('## Commands and references');

// null: the file does not exist.
const edit = (edits: Edit[], text: string | null = GUIDE) => applyEdits(edits, (path) => (path === 'AGENTS.md' && text !== null ? text : undefined));
const result = (edits: Edit[], text?: string) => edit(edits, text)[0].after;
const fails = (edits: Edit[], reason: RegExp, text?: string | null) =>
	assert.throws(
		() => edit(edits, text),
		(error: unknown) => error instanceof EditError && reason.test(error.message)
	);

test('replace changes the one match, and with takes the groups of the pattern', () => {
	const out = result([{ file: 'AGENTS.md', replace: '^Frequent commands: (.*)$', flags: 'm', with: 'Run: $1' }]);
	assert.equal(out, GUIDE.replace('Frequent commands: `pnpm lint`', 'Run: `pnpm lint`'));
	assert.deepEqual(edit([{ file: 'AGENTS.md', replace: 'Intro', with: 'First' }]), [{ path: 'AGENTS.md', before: GUIDE, after: GUIDE.replace('Intro', 'First') }]);
});

test('replace fails when the pattern matches 0 times or more than count, and count allows n matches', () => {
	fails([{ file: 'AGENTS.md', replace: 'nowhere', with: 'x' }], /^edits\[0\] AGENTS\.md: the pattern matches 0 times, expected 1$/);
	fails([{ file: 'AGENTS.md', replace: '^---$', flags: 'm', with: '***' }], /matches 2 times, expected 1/);
	assert.equal(result([{ file: 'AGENTS.md', replace: '^---$', flags: 'm', with: '***', count: 2 }]), GUIDE.replaceAll('\n---\n', '\n***\n'));
	fails([{ file: 'AGENTS.md', replace: '^---$', flags: 'm', with: '***', count: 3 }], /matches 2 times, expected 3/);
});

test('the s flag lets a pattern cross lines, and with can be empty', () => {
	assert.equal(result([{ file: 'AGENTS.md', replace: 'Review well\\..*Find bugs\\.\\n\\n', flags: 's', with: '' }]), GUIDE.replace('Review well.\n\n### Mission\n\nFind bugs.\n\n', ''));
});

test('removeSection with a pointer puts the pointer in place of the section and keeps its trailing rule', () => {
	const out = result([{ file: 'AGENTS.md', removeSection: '### Creating GitLab merge requests', pointer: 'Read `docs/mr.md` first.' }]);
	assert.equal(out, [...lines.slice(0, MR), 'Read `docs/mr.md` first.', '', '---', '', ...lines.slice(REVIEW)].join('\n'));
});

test('removeSection without a pointer deletes the section, its subsections and its trailing rule', () => {
	const out = result([{ file: 'AGENTS.md', removeSection: 'Code Review Rules' }]);
	assert.equal(out, [...lines.slice(0, REVIEW), ...lines.slice(CROSS)].join('\n'));
});

test('the short variant of make-variants.py is two removeSection edits', () => {
	const out = result([
		{ file: 'AGENTS.md', removeSection: '### Creating GitLab merge requests', pointer: 'To create a merge request, read the guide first.' },
		{ file: 'AGENTS.md', removeSection: '## Code Review Rules' }
	]);
	// make-variants.py: lines[:mr] + [pointer, '', '---', ''] + lines[cross:]
	assert.equal(out, [...lines.slice(0, MR), 'To create a merge request, read the guide first.', '', '---', '', ...lines.slice(CROSS)].join('\n'));
});

test('a heading inside a code fence is no heading', () => {
	fails([{ file: 'AGENTS.md', removeSection: 'Description' }], /^edits\[0\] AGENTS\.md: no heading matches "Description"$/);
});

test('moveSection moves the section with its trailing rule, after or before a target', () => {
	const review = lines.slice(REVIEW, CROSS);
	const moved = result([{ file: 'AGENTS.md', moveSection: 'Code Review Rules', after: 'Cross-cutting coding rules' }]);
	assert.equal(moved, [...lines.slice(0, REVIEW), ...lines.slice(CROSS, COMMANDS), ...review, ...lines.slice(COMMANDS)].join('\n'));
	const first = result([{ file: 'AGENTS.md', moveSection: 'Code Review Rules', before: '## For code-generation agents' }]);
	assert.equal(first, [...lines.slice(0, at('## For code-generation agents')), ...review, ...lines.slice(at('## For code-generation agents'), REVIEW), ...lines.slice(CROSS)].join('\n'));
});

test('moveSection leaves the pointer at the old place, and a section at the end gets a blank line', () => {
	const out = result([{ file: 'AGENTS.md', moveSection: 'Commands and references', before: 'Code Review Rules', pointer: 'See the commands above.' }]);
	assert.equal(out, [...lines.slice(0, REVIEW), '## Commands and references', '', 'Frequent commands: `pnpm lint`, `pnpm test`.', '', ...lines.slice(REVIEW, COMMANDS), 'See the commands above.', ''].join('\n'));
});

test('a regex heading matches the heading line', () => {
	assert.equal(result([{ file: 'AGENTS.md', removeSection: '/^## Code Review/' }]), result([{ file: 'AGENTS.md', removeSection: 'Code Review Rules' }]));
});

test('a missing or ambiguous heading, and a target inside the moved section, are errors', () => {
	fails([{ file: 'AGENTS.md', moveSection: 'Nowhere', after: 'Mission' }], /no heading matches "Nowhere"/);
	fails([{ file: 'AGENTS.md', moveSection: 'Mission', after: 'Gone' }], /no heading matches "Gone"/);
	fails([{ file: 'AGENTS.md', removeSection: '/^## /' }], /"\/\^## \/" matches 4 headings, lines 5, 21, 31, 35/);
	fails([{ file: 'AGENTS.md', moveSection: 'Code Review Rules', after: 'Mission' }], /the target heading "Mission" is inside the moved section/);
});

test('append and prepend add the text as is; a missing file is an error unless create is set', () => {
	assert.equal(result([{ file: 'AGENTS.md', append: 'Last.\n' }]), `${GUIDE}Last.\n`);
	assert.equal(result([{ file: 'AGENTS.md', prepend: 'First.\n' }]), `First.\n${GUIDE}`);
	fails([{ file: 'AGENTS.md', append: 'x' }], /^edits\[0\] AGENTS\.md: the file does not exist$/, null);
	fails([{ file: 'AGENTS.md', replace: 'x', with: 'y' }], /the file does not exist/, null);
	assert.deepEqual(edit([{ file: 'AGENTS.md', append: 'New.\n', create: true }], null), [{ path: 'AGENTS.md', after: 'New.\n' }]);
});

test('the edits apply in order: each one sees the text of the one before, and the index names the failing edit', () => {
	const out = result([
		{ file: 'AGENTS.md', replace: 'Intro line\\.', with: '## Intro' },
		{ file: 'AGENTS.md', removeSection: 'Intro' }
	]);
	assert.equal(out, ['# Guide', '', ...lines.slice(at('## For code-generation agents'))].join('\n'));
	fails([{ file: 'AGENTS.md', append: 'x' }, { file: 'AGENTS.md', replace: 'nowhere', with: '' }], /^edits\[1\] AGENTS\.md: /);
});

test('an edit that changes nothing is an error: the variant would be the base under another name', () => {
	fails([{ file: 'AGENTS.md', replace: 'Intro line', with: 'Intro line' }], /^edits\[0\] AGENTS\.md: the edit changes nothing$/);
	fails([{ file: 'AGENTS.md', moveSection: 'Code Review Rules', after: '### Creating GitLab merge requests' }], /^edits\[0\] AGENTS\.md: the edit changes nothing$/);
});

test('a read error names the edit and the file', () => {
	assert.throws(
		() => applyEdits([{ file: 'AGENTS.md', append: 'x' }], () => {
			throw new Error('the file is a symlink');
		}),
		(error: unknown) => error instanceof EditError && error.message === 'edits[0] AGENTS.md: the file is a symlink'
	);
});

let root: string;
let repo: string;
let base: string;
const git = async (cwd: string, ...args: string[]) => {
	const run = await realExec('git', args, { cwd });
	assert.equal(run.code, 0, run.stderr);
	return run.stdout.trim();
};
before(async () => {
	root = mkdtempSync(join(tmpdir(), 'eval-edits-'));
	repo = join(root, 'repo');
	mkdirSync(join(repo, 'docs'), { recursive: true });
	await git(repo, 'init', '-q', '-b', 'main');
	await git(repo, 'config', 'user.email', 'test@localhost');
	await git(repo, 'config', 'user.name', 'test');
	writeFileSync(join(repo, 'AGENTS.md'), GUIDE);
	writeFileSync(join(repo, 'docs', 'AGENTS.md'), 'docs rules\n');
	writeFileSync(join(repo, 'CLAUDE.md'), 'claude rules\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'init');
	base = await git(repo, 'rev-parse', 'HEAD');
	// A change after the base commit: the preview must read the base, not the working tree.
	writeFileSync(join(repo, 'AGENTS.md'), 'not committed\n');
});
after(() => rmSync(root, { recursive: true, force: true }));

test('the preview reads the base commit, after remove and files, and gives a patch per file', async () => {
	const config = {
		name: 'v',
		remove: ['docs'],
		files: { 'CLAUDE.md': { text: 'new claude rules\n' } },
		edits: [
			{ file: 'AGENTS.md', replace: '^Intro line\\.$', flags: 'm', with: 'Intro.' },
			{ file: 'CLAUDE.md', append: 'more\n' },
			{ file: 'docs/AGENTS.md', append: 'fresh\n', create: true }
		] as Edit[]
	};
	const files = await previewEdits(realExec, { repo, baseSha: base, config });
	assert.deepEqual(files, [
		{ path: 'AGENTS.md', before: GUIDE, after: GUIDE.replace('Intro line.', 'Intro.') },
		{ path: 'CLAUDE.md', before: 'new claude rules\n', after: 'new claude rules\nmore\n' },
		{ path: 'docs/AGENTS.md', after: 'fresh\n' }
	]);
	const patch = await editsPatch(realExec, files);
	assert.match(patch, /^diff --git a\/AGENTS\.md b\/AGENTS\.md\n/);
	assert.match(patch, /\n-Intro line\.\n\+Intro\.\n/);
	assert.match(patch, /\ndiff --git a\/CLAUDE\.md b\/CLAUDE\.md\n[^]*\n\+more\n/);
	assert.match(patch, /\ndiff --git a\/docs\/AGENTS\.md b\/docs\/AGENTS\.md\nnew file mode 100644\n[^]*--- \/dev\/null\n\+\+\+ b\/docs\/AGENTS\.md\n@@ -0,0 \+1 @@\n\+fresh\n/);
	// git apply takes the patch.
	const clone = join(root, 'apply');
	await git(root, 'clone', '-q', repo, clone);
	writeFileSync(join(clone, 'CLAUDE.md'), 'new claude rules\n');
	rmSync(join(clone, 'docs'), { recursive: true });
	writeFileSync(join(root, 'edits.patch'), patch);
	await git(clone, 'apply', join(root, 'edits.patch'));
});

test('the preview fails with the edit index when a file is missing at the base', async () => {
	await assert.rejects(previewEdits(realExec, { repo, baseSha: base, config: { name: 'v', edits: [{ file: 'GHOST.md', append: 'x' }] } }), (error: unknown) => error instanceof EditError && error.message === 'edits[0] GHOST.md: the file does not exist');
	await assert.rejects(previewEdits(realExec, { repo, baseSha: base, config: { name: 'v', edits: [{ file: 'docs', append: 'x' }] } }), /edits\[0\] docs: not a file at the base commit/);
});

async function quiet(run: () => Promise<number>) {
	const out: string[] = [];
	const { log, error } = console;
	console.log = (line: string) => out.push(String(line));
	console.error = (line: string) => out.push(String(line));
	try {
		return { code: await run(), out: out.join('\n') };
	} finally {
		Object.assign(console, { log, error });
	}
}

test('eval:edits prints the patch of each config with edits, starts no agent, and fails on an edit error', async () => {
	const spec = join(root, 'spec.json');
	writeFileSync(
		spec,
		JSON.stringify({
			name: 'variants',
			task: { repo: 'repo', base: 'main', prompt: 'x', acceptance: { command: 'true' } },
			budget: { perRunUsd: 1, perEvalUsd: 6 },
			configs: [{ name: 'plain' }, { name: 'intro', edits: [{ file: 'AGENTS.md', replace: 'Intro line', with: 'Intro' }] }, { name: 'broken', edits: [{ file: 'AGENTS.md', replace: 'nowhere', with: '' }] }]
		})
	);
	const calls: string[][] = [];
	const exec: typeof realExec = (command, args, options) => {
		calls.push([command, ...args]);
		return realExec(command, args, options);
	};
	const all = await quiet(() => main([spec], exec));
	assert.equal(all.code, 1);
	assert.match(all.out, /== intro ==\ndiff --git a\/AGENTS\.md b\/AGENTS\.md\n/);
	assert.match(all.out, /== broken ==\nedits\[0\] AGENTS\.md: the pattern matches 0 times, expected 1/);
	assert.doesNotMatch(all.out, /== plain ==/);
	assert.ok(calls.every(([command]) => command === 'git'));
	const one = await quiet(() => main([spec, '--config', 'intro', '--write', join(root, 'written')], realExec));
	assert.equal(one.code, 0);
	assert.doesNotMatch(one.out, /broken/);
	assert.equal(readFileSync(join(root, 'written', 'intro', 'AGENTS.md'), 'utf8'), GUIDE.replace('Intro line', 'Intro'));
	assert.equal((await quiet(() => main([spec, '--config', 'ghost']))).code, 2);
	assert.equal((await quiet(() => main([spec, '--config', 'plain']))).code, 2);
});
