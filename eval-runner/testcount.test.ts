import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countTests } from './testcount.ts';

test('countTests reads the vitest summary, with or without failures, and through colors', () => {
	assert.deepEqual(countTests(' Test Files  1 failed (1)\n      Tests  4 failed | 17 passed (21)\n   Start at  10:00:00\n'), { passed: 17, total: 21 });
	assert.deepEqual(countTests('      Tests  54 passed (54)\n'), { passed: 54, total: 54 });
	assert.deepEqual(countTests('      Tests  3 failed | 1 skipped | 17 passed (21)\n'), { passed: 17, total: 21 });
	assert.deepEqual(countTests('\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m2 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m19 passed\u001b[39m\u001b[22m\u001b[90m (21)\u001b[39m\n'), { passed: 19, total: 21 });
	assert.deepEqual(countTests('      Tests  21 failed (21)\n'), { passed: 0, total: 21 });
});

test('countTests reads jest and node:test, and keeps the last summary', () => {
	assert.deepEqual(countTests('Tests:       1 failed, 5 passed, 6 total\n'), { passed: 5, total: 6 });
	assert.deepEqual(countTests('ℹ tests 266\nℹ suites 0\nℹ pass 265\nℹ fail 1\n'), { passed: 265, total: 266 });
	assert.deepEqual(countTests('# tests 2\n# suites 0\n# pass 2\n# fail 0\n'), { passed: 2, total: 2 });
	assert.deepEqual(countTests('      Tests  2 passed (2)\n...\n      Tests  1 failed | 4 passed (5)\n'), { passed: 4, total: 5 });
});

test('countTests gives nothing when there is no test summary', () => {
	assert.equal(countTests('exit codes: 56 6\n'), undefined);
	assert.equal(countTests(' Test Files  1 failed (1)\n      Tests  no tests\n'), undefined);
	assert.equal(countTests(''), undefined);
});
