// Acceptance check of format-dollars.json. It runs in the clone of the run and imports the code that the agent wrote.
import { join } from 'node:path';

const price = await import(join(process.cwd(), 'session-explorer', 'price.ts'));
const cases: Array<[number, string]> = [
	[1.5, '1.50 $'],
	[0, '0.00 $'],
	[12.345, '12.35 $']
];
if (typeof price.formatDollars !== 'function') {
	console.error('formatDollars is not exported by session-explorer/price.ts');
	process.exit(1);
}
for (const [value, expected] of cases) {
	const actual = price.formatDollars(value);
	if (actual !== expected) {
		console.error(`formatDollars(${value}) returned ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
		process.exit(1);
	}
}
console.log('formatDollars: all cases passed');
