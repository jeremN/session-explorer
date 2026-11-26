// The scheduler of a campaign: at most `concurrency` jobs at once, one shared budget, retries of transient failures,
// and an AbortSignal for Ctrl-C. It knows nothing about runs: a job is a function that reports its cost.

// `transient`: the attempt failed for a reason that a new attempt can fix. `interrupted`: the signal stopped the attempt.
export type Attempt = { costUsd: number; transient?: boolean; interrupted?: boolean };
// `estimateUsd` is read at each start. It gives the cost that the job reserves while it runs.
export type Job = { id: string; estimateUsd: () => number; run: (signal: AbortSignal, attempt: number) => Promise<Attempt> };
// `budget`: the job never started, or a retry never started, because the budget would pass.
// `interrupted`: the signal stopped the job, or the job never started because the signal came first.
export type JobRecord = { id: string; status: 'done' | 'budget' | 'interrupted'; costUsd: number; attempts: number };
export type ScheduleOptions = { concurrency: number; budgetUsd: number; retries: number; backoffMs: number; signal?: AbortSignal; onDone?: (record: JobRecord, index: number) => void };

const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((wake) => {
		const timer = setTimeout(wake, ms);
		signal.addEventListener('abort', () => (clearTimeout(timer), wake()), { once: true });
	});

export async function schedule(jobs: Job[], { concurrency, budgetUsd, retries, backoffMs, signal = new AbortController().signal, onDone }: ScheduleOptions): Promise<JobRecord[]> {
	const records: JobRecord[] = jobs.map((job) => ({ id: job.id, status: 'interrupted', costUsd: 0, attempts: 0 }));
	let spent = 0;
	let reserved = 0;
	let next = 0;
	// Once one start does not fit, no later start does: the campaign stops spending and the samples stay balanced.
	let overBudget = false;

	const runOne = async (index: number) => {
		const job = jobs[index];
		const record = records[index];
		while (!signal.aborted) {
			const estimate = job.estimateUsd();
			// Each attempt reserves its estimate, so parallel jobs cannot overrun the budget together.
			if (overBudget || spent + reserved + estimate > budgetUsd) {
				overBudget = true;
				// A job that failed once keeps its result. Only a job with no attempt stops on the budget.
				if (record.attempts === 0) record.status = 'budget';
				else record.status = 'done';
				return;
			}
			reserved += estimate;
			record.attempts += 1;
			let attempt: Attempt;
			try {
				attempt = await job.run(signal, record.attempts);
			} catch {
				attempt = { costUsd: 0 };
			} finally {
				reserved -= estimate;
			}
			spent += attempt.costUsd;
			record.costUsd += attempt.costUsd;
			if (attempt.interrupted) return void (record.status = 'interrupted');
			record.status = 'done';
			if (!attempt.transient || record.attempts > retries) return;
			await sleep(backoffMs * 2 ** (record.attempts - 1), signal);
			// The abort came during the wait: the job stops before a new attempt.
			if (signal.aborted) return void (record.status = 'interrupted');
		}
	};

	const worker = async () => {
		while (!signal.aborted && next < jobs.length) {
			const index = next++;
			await runOne(index);
			onDone?.(records[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
	return records;
}
