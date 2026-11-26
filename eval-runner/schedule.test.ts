import assert from 'node:assert/strict';
import { test } from 'node:test';

import { schedule } from './schedule.ts';
import type { Attempt, Job } from './schedule.ts';

const wait = (ms: number) => new Promise((wake) => setTimeout(wake, ms));
const base = { concurrency: 1, budgetUsd: 100, retries: 0, backoffMs: 1 };

type Probe = { running: number; peak: number; started: string[] };
const probe = (): Probe => ({ running: 0, peak: 0, started: [] });

// A job that takes `ms` and then gives each attempt in `attempts`, in order.
const fake = (id: string, probeOf: Probe, attempts: Attempt[], { ms = 10, estimate = 1 }: { ms?: number; estimate?: number } = {}): Job => ({
	id,
	estimateUsd: () => estimate,
	run: async (signal) => {
		probeOf.started.push(id);
		probeOf.running += 1;
		probeOf.peak = Math.max(probeOf.peak, probeOf.running);
		try {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, ms);
				signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
			});
			if (signal.aborted) return { costUsd: 0, interrupted: true };
			return attempts.shift() ?? { costUsd: 1 };
		} finally {
			probeOf.running -= 1;
		}
	}
});

test('never runs more than the concurrency, and starts the jobs in order', async () => {
	const p = probe();
	const jobs = ['a', 'b', 'c', 'd', 'e'].map((id) => fake(id, p, [{ costUsd: 1 }], { ms: 20 }));
	const records = await schedule(jobs, { ...base, concurrency: 2 });
	assert.equal(p.peak, 2);
	assert.deepEqual(p.started, ['a', 'b', 'c', 'd', 'e']);
	assert.deepEqual(records.map((record) => [record.id, record.status]), ['a', 'b', 'c', 'd', 'e'].map((id) => [id, 'done']));
});

test('a reservation per running job keeps parallel jobs under the budget', async () => {
	const p = probe();
	const jobs = ['a', 'b', 'c'].map((id) => fake(id, p, [{ costUsd: 1 }], { ms: 30 }));
	const records = await schedule(jobs, { ...base, concurrency: 3, budgetUsd: 2.5 });
	assert.deepEqual(records.map((record) => record.status), ['done', 'done', 'budget']);
	assert.deepEqual(p.started, ['a', 'b']);
});

test('once a job stops on the budget, no later job starts', async () => {
	const p = probe();
	const jobs = [fake('a', p, [{ costUsd: 2 }]), fake('b', p, [{ costUsd: 2 }]), fake('cheap', p, [{ costUsd: 0.1 }], { estimate: 0.1 })];
	const records = await schedule(jobs, { ...base, budgetUsd: 3 });
	assert.deepEqual(records.map((record) => record.status), ['done', 'budget', 'budget']);
	assert.deepEqual(p.started, ['a']);
});

test('the estimate is read at the start of the job', async () => {
	const p = probe();
	let estimate = 3;
	const first = fake('a', p, [{ costUsd: 0.5 }]);
	const second = { ...fake('b', p, [{ costUsd: 0.5 }]), estimateUsd: () => estimate };
	first.run = ((run) => async (signal: AbortSignal, attempt: number) => {
		const result = await run(signal, attempt);
		estimate = 0.5;
		return result;
	})(first.run);
	const records = await schedule([first, second], { ...base, budgetUsd: 3.2 });
	assert.deepEqual(records.map((record) => record.status), ['done', 'done']);
});

test('a transient failure retries up to the limit, and every attempt counts its cost', async () => {
	const p = probe();
	const flaky = fake('flaky', p, [{ costUsd: 0.5, transient: true }, { costUsd: 0.5, transient: true }, { costUsd: 1 }]);
	const dead = fake('dead', p, [{ costUsd: 0.5, transient: true }, { costUsd: 0.5, transient: true }, { costUsd: 0.5, transient: true }, { costUsd: 9 }]);
	const records = await schedule([flaky, dead], { ...base, retries: 2 });
	assert.deepEqual(records.map((record) => [record.status, record.attempts, record.costUsd]), [['done', 3, 2], ['done', 3, 1.5]]);
});

test('a retry that does not fit in the budget does not start', async () => {
	const p = probe();
	const job = fake('a', p, [{ costUsd: 1.5, transient: true }, { costUsd: 1 }]);
	const records = await schedule([job], { ...base, retries: 2, budgetUsd: 2 });
	assert.deepEqual([records[0].status, records[0].attempts, records[0].costUsd], ['done', 1, 1.5]);
});

test('an abort leaves the queued jobs unstarted and the running jobs interrupted', async () => {
	const p = probe();
	const controller = new AbortController();
	const jobs = ['a', 'b', 'c', 'd'].map((id) => fake(id, p, [{ costUsd: 1 }], { ms: 1000 }));
	setTimeout(() => controller.abort(), 50);
	const records = await schedule(jobs, { ...base, concurrency: 2, signal: controller.signal });
	assert.deepEqual(p.started, ['a', 'b']);
	assert.deepEqual(records.map((record) => [record.status, record.attempts]), [['interrupted', 1], ['interrupted', 1], ['interrupted', 0], ['interrupted', 0]]);
});

test('a signal that is aborted before the start runs nothing', async () => {
	const p = probe();
	const controller = new AbortController();
	controller.abort();
	const records = await schedule([fake('a', p, [{ costUsd: 1 }])], { ...base, signal: controller.signal });
	assert.deepEqual(p.started, []);
	assert.equal(records[0].status, 'interrupted');
});

test('an abort during the wait before a retry ends the job without a new attempt', async () => {
	const p = probe();
	const controller = new AbortController();
	const job = fake('a', p, [{ costUsd: 0.5, transient: true }, { costUsd: 1 }], { ms: 5 });
	setTimeout(() => controller.abort(), 40);
	const started = Date.now();
	const records = await schedule([job], { ...base, retries: 2, backoffMs: 5000, signal: controller.signal });
	assert.ok(Date.now() - started < 2000);
	assert.deepEqual([records[0].status, records[0].attempts], ['interrupted', 1]);
});

test('onDone sees each record once, as it ends', async () => {
	const p = probe();
	const seen: string[] = [];
	await schedule(['a', 'b'].map((id) => fake(id, p, [{ costUsd: 1 }])), { ...base, onDone: (record) => void seen.push(`${record.id}:${record.status}`) });
	assert.deepEqual(seen, ['a:done', 'b:done']);
	await wait(1);
});
