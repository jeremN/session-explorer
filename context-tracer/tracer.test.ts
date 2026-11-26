import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classify, commandClasses, configureKnowledge, summarize, traceSession, traceTasks } from './tracer.ts';

const CONFIG = {
	brain: {
		paths: ['team-brain[\\w-]*\\/wiki', 'notes\\/vault'],
		collections: ['brain', 'notes'],
		wikiDirectories: ['concepts', 'decisions', 'known-bugs', 'playbooks']
	},
	memory: { collections: ['memory-notes'] }
};
configureKnowledge(CONFIG);

const REPO = '/Users/dev/Documents/Code/Work/acme';
const WIKI = '/Users/dev/Documents/Code/Work/team-brain/wiki';
const MEMORY = '/Users/dev/.claude/projects/-Users-dev-Documents-Code-Work-acme/memory';

const at = (minute: number) => `2026-10-05T08:${String(minute).padStart(2, '0')}:00.000Z`;
const prompt = (minute: number, content = 'fix the bug') => ({ type: 'user', timestamp: at(minute), message: { content } });
const toolUse = (minute: number, name: string, input: Record<string, unknown>) => ({
	type: 'assistant',
	timestamp: at(minute),
	message: { content: [{ type: 'tool_use', name, input }] }
});
const repoEdit = (minute: number) => toolUse(minute, 'Edit', { file_path: `${REPO}/src/a.ts` });
const brainSearch = (minute: number) => toolUse(minute, 'mcp__plugin_qmd_qmd__query', { searches: [] });

test('qmd MCP query: brain unless every collection is outside the brain', () => {
	assert.equal(classify('mcp__plugin_qmd_qmd__query', { searches: [] }), 'brain');
	assert.equal(classify('mcp__plugin_qmd_qmd__query', { collections: ['memory-notes', 'brain'] }), 'brain');
	assert.equal(classify('mcp__plugin_qmd_qmd__get', { file: 'brain/playbooks/testing.md' }), 'brain');
	assert.equal(classify('mcp__plugin_qmd_qmd__get', { file: 'qmd://notes/3-Resources/a.md:20' }), 'brain');
	assert.equal(classify('mcp__plugin_qmd_qmd__get', { file: 'memory-notes/gotcha-stale-dist.md:1' }), 'memory');
	assert.equal(classify('mcp__plugin_qmd_qmd__get', { file: '#abc123' }), undefined);
	assert.equal(classify('mcp__plugin_qmd_qmd__multi_get', { pattern: 'known-bugs/*.md' }), 'brain');
	assert.equal(classify('mcp__plugin_qmd_qmd__multi_get', { pattern: 'playbooks/testing.md, concepts/bff.md' }), 'brain');
	assert.equal(classify('mcp__plugin_qmd_qmd__multi_get', { pattern: 'docs/AGENTS.md' }), undefined);
	assert.equal(classify('mcp__plugin_qmd_qmd__query', { collections: ['memory-notes', 'acme'] }), 'memory');
	assert.equal(classify('mcp__plugin_qmd_qmd__query', { collection: 'acme' }), undefined);
	assert.equal(classify('mcp__plugin_qmd_qmd__status', {}), undefined);
});

test('shell qmd: search commands count, admin commands do not', () => {
	assert.equal(classify('Bash', { command: 'qmd query "cache layer" -c brain' }), 'brain');
	assert.equal(classify('Bash', { command: 'cd ~/x && qmd search flaky' }), 'brain');
	assert.equal(classify('Bash', { command: 'qmd query "x" -c memory-notes' }), 'memory');
	assert.equal(classify('Bash', { command: 'qmd status | head' }), undefined);
	assert.equal(classify('Bash', { command: 'qmd embed > log.txt' }), undefined);
	assert.equal(classify('Bash', { command: 'grep -n "qmd query" README.md' }), undefined);
});

test('a brain page read with a file tool is a brain event', () => {
	assert.equal(classify('Read', { file_path: `${WIKI}/playbooks/testing.md` }), 'brain');
	assert.equal(classify('Grep', { pattern: 'x', path: '/Users/dev/notes/vault/3-Resources' }), 'brain');
	assert.equal(classify('Read', { file_path: `${REPO}/AGENTS.md` }), undefined);
});

test('shell grep on a brain path is a brain event', () => {
	assert.equal(classify('Bash', { command: 'grep -rn flaky ~/notes/vault/3-Resources | head' }), 'brain');
	assert.equal(classify('Bash', { command: 'grep -rn flaky ~/notes/vault 2>/dev/null' }), 'brain');
	assert.equal(classify('Bash', { command: `cat ${WIKI}/playbooks/testing.md` }), 'brain');
	assert.equal(classify('Bash', { command: `cd ${WIKI} && for k in auth billing; do rg -l "$k" .; done` }), 'brain');
});

test('vault upkeep and heredoc text are not brain events', () => {
	assert.equal(classify('Bash', { command: 'ls ~/notes/vault/4-Archive/old' }), undefined);
	assert.equal(classify('Bash', { command: 'head -30 ~/notes/vault/archive/README.md' }), undefined);
	assert.equal(classify('Bash', { command: `find ${WIKI} -name "*.md" | wc -l` }), undefined);
	assert.equal(classify('Bash', { command: `cat >> PLAN.md <<'EOF'\ngrep the pages under team-brain/wiki\nEOF` }), undefined);
	assert.equal(classify('Write', { file_path: '/Users/dev/notes/vault/0-Inbox/note.md' }), undefined);
	assert.equal(classify('Bash', { command: 'cat notes.txt >> ~/notes/vault/0-Inbox/note.md' }), undefined);
});

test('a memory file read is a memory event', () => {
	assert.equal(classify('Read', { file_path: `${MEMORY}/gotcha-stale-dist.md` }), 'memory');
	assert.equal(classify('Bash', { command: `grep -rn "1611" ${MEMORY}/` }), 'memory');
	assert.equal(classify('Bash', { command: `ls ${MEMORY} | wc -l` }), undefined);
});

test('an edit in a repository opens the task; plan, memory and temp files do not', () => {
	assert.equal(classify('Edit', { file_path: `${REPO}/a.ts` }), 'edit');
	assert.equal(classify('Edit', { file_path: `${REPO}/.claude/worktrees/feat-42/a.ts` }), 'edit');
	assert.equal(classify('Write', { file_path: '/Users/dev/.claude/handoffs/x/PLAN.md' }), undefined);
	assert.equal(classify('Write', { file_path: `${MEMORY}/MEMORY.md` }), undefined);
	assert.equal(classify('Write', { file_path: '/private/tmp/claude-1000/x/scratchpad/probe.mjs' }), undefined);
	assert.equal(classify('Edit', { file_path: `${WIKI}/playbooks/testing.md` }), undefined);
	// On Linux the clones of the eval runner sit under /tmp. They are repositories.
	assert.equal(classify('Write', { file_path: '/tmp/eval-runner/20261117-agents/codex-1/a.ts' }), 'edit');
	assert.equal(classify('Bash', { command: "sed -i 's/a/b/' /tmp/eval-runner/e/codex-1/a.ts" }), 'edit');
});

test('shell in-place edits open the task; a commit does not', () => {
	assert.equal(classify('Bash', { command: "sed -i '' 's/a/b/' src/a.ts" }), 'edit');
	assert.equal(classify('Bash', { command: "perl -0pi -e 's/a/b/' applications/bff/src/b.ts" }), 'edit');
	assert.equal(classify('Bash', { command: `perl -0pi -e 's/a/b/' ${MEMORY}/MEMORY.md` }), undefined);
	assert.equal(classify('Bash', { command: 'M="$HOME/.claude/projects/x/memory"; sed -i "" s/a/b/ "$M/a.md"' }), undefined);
	assert.equal(classify('Bash', { command: 'sed -n 1,20p src/a.ts' }), undefined);
	assert.equal(classify('Bash', { command: "sed -i '' '/x/d' ~/Documents/Code/Work/team-brain-wt-a/wiki/a.md" }), undefined);
	assert.equal(classify('Bash', { command: 'git commit -m "fix(web): a"' }), undefined);
});

test('search then edit under one prompt: one task, verdict before', () => {
	const { start, tasks } = traceSession([prompt(0), brainSearch(1), repoEdit(5)]);
	assert.equal(start, at(0));
	assert.deepEqual(tasks, [{ start: at(0), brain: 'before', memory: false }]);
});

test('a prompt without an edit merges into the next task', () => {
	const { tasks } = traceSession([prompt(0, 'what can be done?'), brainSearch(1), prompt(3, 'go'), repoEdit(5)]);
	assert.deepEqual(tasks, [{ start: at(0), brain: 'before', memory: false }]);
});

test('the prompt after an edit opens a new task with its own verdict', () => {
	const { tasks } = traceSession([prompt(0), brainSearch(1), repoEdit(5), prompt(10, 'now the other bug'), repoEdit(12)]);
	assert.deepEqual(tasks, [
		{ start: at(0), brain: 'before', memory: false },
		{ start: at(10), brain: 'never', memory: false }
	]);
});

test('edit then search under one prompt: verdict after', () => {
	const { tasks } = traceSession([prompt(0), repoEdit(1), brainSearch(5)]);
	assert.deepEqual(tasks, [{ start: at(0), brain: 'after', memory: false }]);
});

test('a session without an edit has no task', () => {
	assert.deepEqual(traceSession([prompt(0), brainSearch(1)]).tasks, []);
});

test('tool results, meta entries, commands and subagent prompts do not open a task', () => {
	const { tasks } = traceSession([
		prompt(0),
		repoEdit(1),
		{ type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', content: 'ok' }] } },
		{ ...prompt(3, 'caveat'), isMeta: true },
		prompt(4, '<command-name>/clear</command-name>'),
		{ ...prompt(4, 'This session is being continued from a previous conversation.'), isCompactSummary: true },
		{ ...prompt(5, 'subagent brief'), isSidechain: true },
		repoEdit(6)
	]);
	assert.equal(tasks.length, 1);
});

test('a subagent search counts by its timestamp, whatever the line order', () => {
	const { tasks } = traceSession([repoEdit(10), prompt(0), { ...brainSearch(2), isSidechain: true }]);
	assert.deepEqual(tasks, [{ start: at(0), brain: 'before', memory: false }]);
});

test('a memory read before the edit is recorded apart from the brain verdict', () => {
	const { tasks } = traceSession([prompt(0), toolUse(1, 'Read', { file_path: `${MEMORY}/gotcha-stale-dist.md` }), repoEdit(5)]);
	assert.deepEqual(tasks, [{ start: at(0), brain: 'never', memory: true }]);
});

test('a memory read after the edit does not count', () => {
	const { tasks } = traceSession([prompt(0), repoEdit(1), toolUse(5, 'Read', { file_path: `${MEMORY}/gotcha-stale-dist.md` })]);
	assert.deepEqual(tasks, [{ start: at(0), brain: 'never', memory: false }]);
});

test('summarize groups the tasks by ISO week of their start', () => {
	const summary = summarize([
		{ start: '2026-09-28T09:00:00.000Z', brain: 'never', memory: true },
		{ start: '2026-10-02T09:00:00.000Z', brain: 'before', memory: true },
		{ start: '2026-10-05T09:00:00.000Z', brain: 'after', memory: false },
		{ start: '2026-10-05T10:00:00.000Z', brain: 'never', memory: false }
	]);
	assert.deepEqual(summary.weeks, [
		{ week: '2026-W40', tasks: 2, before: 1, after: 0, never: 1, memory: 2 },
		{ week: '2026-W41', tasks: 2, before: 0, after: 1, never: 1, memory: 0 }
	]);
	assert.deepEqual(summary.total, { tasks: 4, before: 1, after: 1, never: 2, memory: 2 });
	assert.equal(summary.brainBeforeShare, 0.25);
	assert.equal(summary.memoryBeforeShare, 0.5);
});

test('traceTasks: a task carries its end and the time of each first event', () => {
	const { tasks } = traceTasks([
		prompt(0),
		toolUse(1, 'Read', { file_path: `${MEMORY}/gotcha-stale-dist.md` }),
		brainSearch(2),
		repoEdit(5),
		prompt(10, 'now the other bug'),
		repoEdit(12),
		toolUse(14, 'Read', { file_path: `${REPO}/src/b.ts` })
	]);
	assert.deepEqual(tasks, [
		{ start: at(0), end: at(10), brain: 'before', memory: true, editAt: at(5), brainAt: at(2), memoryAt: at(1), verified: false },
		{ start: at(10), end: at(14), brain: 'never', memory: false, editAt: at(12), verified: false }
	]);
});

test('without a config, no path is a brain path and an unscoped qmd search still counts', () => {
	configureKnowledge({});
	try {
		assert.equal(classify('Read', { file_path: `${WIKI}/concepts/a.md` }), undefined);
		assert.equal(classify('Edit', { file_path: `${WIKI}/concepts/a.md` }), 'edit');
		assert.equal(classify('mcp__plugin_qmd_qmd__query', { searches: [] }), 'brain');
	} finally {
		configureKnowledge(CONFIG);
	}
});

test('an edit anywhere in a brain repository is not a task; a read outside its search paths is not a search', () => {
	configureKnowledge({ ...CONFIG, brain: { ...CONFIG.brain, repositories: ['\\/team-brain'] } });
	try {
		assert.equal(classify('Edit', { file_path: '/Users/dev/Documents/Code/Work/team-brain/log.md' }), undefined);
		assert.equal(classify('Bash', { command: "sed -i '' 's/a/b/' ~/Documents/Code/Work/team-brain/log.md" }), undefined);
		assert.equal(classify('Read', { file_path: '/Users/dev/Documents/Code/Work/team-brain/log.md' }), undefined);
	} finally {
		configureKnowledge(CONFIG);
	}
});

test('a test, build, lint or typecheck command is a verify event', () => {
	for (const command of ['npm test', 'pnpm run build', 'yarn lint', 'npx tsc --noEmit', 'node --test', 'pnpm vitest run src/a.test.ts', 'cd app && npm run typecheck', 'pytest -q', 'cargo test', 'go test ./...', 'npx svelte-check', 'npx playwright test'])
		assert.equal(classify('Bash', { command }), 'verify', command);
	for (const command of ['git status', 'npm install', 'cat package.json', 'echo test', 'grep -rn test src'])
		assert.equal(classify('Bash', { command }), undefined, command);
});

test('traceTasks: a task is verified when a check runs after its last edit', () => {
	const check = (minute: number) => toolUse(minute, 'Bash', { command: 'npm test' });
	const { tasks } = traceTasks([
		prompt(0), repoEdit(1), check(2),
		prompt(10, 'next'), repoEdit(11), check(12), repoEdit(13),
		prompt(20, 'last'), repoEdit(21)
	]);
	assert.deepEqual(tasks.map(({ verified, verifiedAt }) => ({ verified, verifiedAt })), [
		{ verified: true, verifiedAt: at(2) },
		{ verified: false, verifiedAt: undefined },
		{ verified: false, verifiedAt: undefined }
	]);
});

test('traceTasks: the result of the last check gives passed, failed or unknown', () => {
	const run = (minute: number, id: string, command = 'pnpm test') => ({
		type: 'assistant',
		timestamp: at(minute),
		message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] }
	});
	const output = (minute: number, id: string, content: unknown, isError = false) => ({
		type: 'user',
		timestamp: at(minute),
		message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] }
	});
	const { tasks } = traceTasks([
		prompt(0), repoEdit(1), run(2, 'a'), output(3, 'a', 'Exit code 1\nFAIL src/a.test.ts', true),
		prompt(10, 'b'), repoEdit(11), run(12, 'b'), output(13, 'b', 'Exit code 1', true), run(14, 'c'), output(15, 'c', 'Tests 12 passed (12)'),
		prompt(20, 'c'), repoEdit(21), run(22, 'd', 'pnpm test | tail -5'), output(23, 'd', [{ type: 'text', text: ' Tests  2 failed | 10 passed (12)' }]),
		prompt(30, 'd'), repoEdit(31), run(32, 'e', 'npx tsc --noEmit'), output(33, 'e', 'src/a.ts(3,1): error TS2304: Cannot find name x.'),
		prompt(40, 'e'), repoEdit(41), run(42, 'f'),
		prompt(45, 'lint'), repoEdit(46), run(47, 'g', 'npx eslint src'), output(48, 'g', '\n✖ 12 problems (0 errors, 12 warnings)\n'),
		prompt(50, 'f'), repoEdit(51)
	]);
	assert.deepEqual(tasks.map((task) => task.check), ['failed', 'passed', 'failed', 'failed', 'unknown', 'passed', undefined]);
});

test('traceTasks: a check blocked by a classifier outage never ran, so it proves nothing', () => {
	const run = (minute: number, id: string) => ({
		type: 'assistant',
		timestamp: at(minute),
		message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'node --test a.test.ts' } }] }
	});
	const output = (minute: number, id: string, content: string, isError = false) => ({
		type: 'user',
		timestamp: at(minute),
		message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] }
	});
	const outage = 'The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash. This is a transient failure of the check, not a judgment about the action.';
	const { tasks } = traceTasks([
		prompt(0), repoEdit(1), run(2, 'a'), output(3, 'a', 'ℹ pass 3\nℹ fail 0'), run(4, 'b'), output(5, 'b', outage, true),
		prompt(10, 'b'), repoEdit(11), run(12, 'c'), output(13, 'c', outage, true)
	]);
	assert.deepEqual(tasks.map(({ verified, verifiedAt, check }) => ({ verified, verifiedAt, check })), [
		{ verified: true, verifiedAt: at(2), check: 'passed' },
		{ verified: false, verifiedAt: undefined, check: undefined }
	]);
});

test('commandClasses: package scripts, flags and binaries give test, types, lint and build', () => {
	const cases: Array<[string, string[]]> = [
		['pnpm --dir applications/web test:unit src/a.test.ts', ['test']],
		['pnpm -C web check:types', ['types']],
		['pnpm exec eslint src/a.ts', ['lint']],
		['pnpm --filter web lint', ['lint']],
		['pnpm -r build', ['build']],
		['npm run typecheck', ['types']],
		['yarn workspace web test', ['test']],
		['npx vitest run a.test.ts', ['test']],
		['npx playwright test', ['test']],
		['./node_modules/.bin/tsc --noEmit', ['types']],
		['CI=1 timeout 120 pnpm test', ['test']],
		['node --experimental-strip-types --test a.test.ts', ['test']],
		['npx prettier --check .', ['lint']],
		['cargo clippy', ['lint']],
		['go vet ./...', ['lint']],
		['python -m pytest -q', ['test']],
		['mypy src', ['types']]
	];
	for (const [command, expected] of cases) assert.deepEqual(commandClasses(command), expected, command);
});

test('commandClasses: one call counts in every class of its segments', () => {
	assert.deepEqual(commandClasses('pnpm test && pnpm check:types; pnpm lint'), ['test', 'types', 'lint']);
	assert.deepEqual(commandClasses('cd web && pnpm test 2>&1 | tail -30'), ['test']);
	assert.deepEqual(commandClasses('(cd web && pnpm build) || echo no'), ['build']);
	assert.deepEqual(commandClasses('for f in a b; do pnpm test $f; done'), ['test']);
});

test('commandClasses: git, install, explore and other', () => {
	assert.deepEqual(commandClasses('git -C repo status && git diff'), ['git']);
	assert.deepEqual(commandClasses('pnpm install --frozen-lockfile'), ['install']);
	assert.deepEqual(commandClasses('npm ci'), ['install']);
	assert.deepEqual(commandClasses('ls src && cat a.ts'), ['explore']);
	assert.deepEqual(commandClasses("sed -n '1,20p' a.ts"), ['explore']);
	assert.deepEqual(commandClasses('find . -name "*.ts" | xargs grep -l x | wc -l'), ['explore']);
	assert.deepEqual(commandClasses('echo test'), ['other']);
	assert.deepEqual(commandClasses('cd web'), ['other']);
	assert.deepEqual(commandClasses('test -f a.ts && echo yes'), ['other']);
});

test('commandClasses: a pipe filter is not an exploration, and quotes do not split', () => {
	assert.deepEqual(commandClasses('git log --oneline | head -5'), ['git']);
	assert.deepEqual(commandClasses('grep -E "a|b;c" src/a.ts'), ['explore']);
	assert.deepEqual(commandClasses("git commit -m 'fix; pnpm test && done'"), ['git']);
	assert.deepEqual(commandClasses('echo "pnpm test"'), ['other']);
});

test('commandClasses: in-place edits and writes to a source file are edits; a log file is not', () => {
	assert.deepEqual(commandClasses("sed -i '' 's/a/b/' src/a.ts && pnpm test"), ['edit', 'test']);
	assert.deepEqual(commandClasses("cat > src/a.ts <<'EOF'\npnpm test | grep x\nEOF"), ['edit']);
	assert.deepEqual(commandClasses('echo x | tee src/b.svelte'), ['edit']);
	assert.deepEqual(commandClasses('pnpm lint > /tmp/lint.log 2>&1'), ['lint']);
	assert.deepEqual(commandClasses('pnpm test 2>/dev/null'), ['test']);
	assert.deepEqual(commandClasses('pnpm test > out.txt'), ['test']);
});

test('commandClasses: extra patterns from the config add to the defaults', () => {
	configureKnowledge({ ...CONFIG, commands: { test: ['^make check\\b'], lint: ['\\bstylelint\\b'] } });
	try {
		assert.deepEqual(commandClasses('make check && npx stylelint a.css'), ['test', 'lint']);
		assert.deepEqual(commandClasses('pnpm test'), ['test']);
		assert.equal(classify('Bash', { command: 'make check' }), 'verify');
	} finally {
		configureKnowledge(CONFIG);
	}
	assert.deepEqual(commandClasses('make check'), ['other']);
});

test('a script run with pnpm flags or a check:types script is a verify event', () => {
	for (const command of ['pnpm --dir web test:unit a.test.ts', 'pnpm -r check:types', 'pnpm exec eslint .'])
		assert.equal(classify('Bash', { command }), 'verify', command);
});
