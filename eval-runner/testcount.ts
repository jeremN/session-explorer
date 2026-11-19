// How many tests the acceptance command passed, from the summary of its test runner. A binary pass hides how close a
// run came: 19 tests of 21 and 10 of 21 are both a failure. Reads vitest, node:test (spec and TAP reporters) and jest.
// Returns undefined when no summary is found: a check that is not a test run, or a test file that did not load.
export type TestCount = { passed: number; total: number };

// Colors and cursor moves of a terminal reporter.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function countTests(output: string): TestCount | undefined {
	const text = output.replace(ANSI, '');
	let found: TestCount | undefined;
	const keep = (passed: number, total: number) => {
		if (total > 0 && passed <= total) found = { passed, total };
	};
	// vitest: "Tests  4 failed | 17 passed (21)". The last summary wins: a command can run several suites.
	for (const match of text.matchAll(/^\s*Tests\s+([^\n(]*?)\s*\((\d+)\)\s*$/gm)) {
		const passed = /(\d+) passed/.exec(match[1]);
		keep(passed ? Number(passed[1]) : 0, Number(match[2]));
	}
	if (found) return found;
	// jest: "Tests:       1 failed, 5 passed, 6 total".
	for (const match of text.matchAll(/^\s*Tests:\s+([^\n]*?)(\d+) total\s*$/gm)) {
		const passed = /(\d+) passed/.exec(match[1]);
		keep(passed ? Number(passed[1]) : 0, Number(match[2]));
	}
	if (found) return found;
	// node:test: "ℹ tests 21" then "ℹ pass 19" (spec reporter), or "# tests 21" and "# pass 19" (TAP).
	for (const match of text.matchAll(/^[ℹ#] tests (\d+)\s*\n(?:[ℹ#] \w+ \d+\s*\n)*?[ℹ#] pass (\d+)\s*$/gm)) keep(Number(match[2]), Number(match[1]));
	return found;
}
