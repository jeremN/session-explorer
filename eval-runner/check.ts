// The acceptance check of a run: the hidden tests enter the clone, then the acceptance command runs there. Used by the
// runner after the agent, and by recheck.ts on a saved diff.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Exec } from './exec.ts';
import type { Spec } from './spec.ts';
import type { RunRecord } from './stats.ts';
import { countTests } from './testcount.ts';
import { placeHiddenTests } from './workspace.ts';

export async function runCheck(exec: Exec, task: Spec['task'], specDir: string, clone: string, runDir: string): Promise<NonNullable<RunRecord['acceptance']>> {
	// The hidden tests enter after the diff, so they never count as agent work.
	const hidden = task.hiddenTests;
	if (hidden) await placeHiddenTests(exec, { repo: task.repo, commit: hidden.commit, paths: hidden.paths, dir: clone });
	const started = Date.now();
	const check = await exec('sh', ['-c', task.acceptance.command], { cwd: clone, env: { EVAL_SPEC_DIR: specDir }, timeoutMs: task.acceptance.timeoutSec * 1000 });
	writeFileSync(join(runDir, 'acceptance.log'), (check.stdout + check.stderr).slice(-64 * 1024));
	const tests = countTests(check.stdout + check.stderr);
	// The check itself failed (a database that did not start, a port in use): the run says nothing about the agent.
	const infra = task.acceptance.infraExitCode !== undefined && check.code === task.acceptance.infraExitCode;
	return { exitCode: check.code, passed: check.code === 0 && !check.timedOut, timedOut: check.timedOut, durationMs: Date.now() - started, ...(tests ? { tests } : {}), ...(infra ? { infra } : {}) };
}
