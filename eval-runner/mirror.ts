// A bare mirror of the source repository, in the cache. The source is a working checkout: the user edits it, and git
// maintenance rewrites its object store while a run clones from it. A run clones from the mirror instead. Only the
// runner writes the mirror, so it stays still while the runs read it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { Exec } from './exec.ts';
import { ENV } from './workspace.ts';

// A lock that a live process holds is never stale. The wait ends with an error after this time.
const LOCK_WAIT_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 100;

const sleep = (ms: number) => new Promise((wake) => setTimeout(wake, ms));

// The mirror of a repository: a folder named by a hash of the resolved path of the repository.
export function mirrorPath(cacheDir: string, repo: string): string {
	let resolved = resolve(repo);
	try {
		resolved = realpathSync(resolved);
	} catch {
		// A missing repository gets a path anyway. The clone then fails with its own message.
	}
	return join(cacheDir, 'mirrors', createHash('sha256').update(resolved).digest('hex').slice(0, 16));
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
};

// The lock is a file that holds the pid of its owner. `wx` fails when the file exists, so one process wins. A lock of a
// process that is gone is removed.
async function withLock<T>(lock: string, work: () => Promise<T>): Promise<T> {
	mkdirSync(dirname(lock), { recursive: true });
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			writeFileSync(lock, String(process.pid), { flag: 'wx' });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
		let owner = '';
		try {
			owner = readFileSync(lock, 'utf8').trim();
		} catch {
			continue;
		}
		// An empty file is a lock that its owner is still writing.
		if (/^\d+$/.test(owner) && !alive(Number(owner))) {
			// Another waiter may have replaced the lock since the read: remove it only if it is still the same.
			if (readFileSync(lock, 'utf8').trim() === owner) rmSync(lock, { force: true });
			continue;
		}
		if (Date.now() > deadline) throw new Error(`the mirror lock ${lock} is held by process ${owner || '?'}. Delete it if that process is gone.`);
		await sleep(LOCK_POLL_MS);
	}
	try {
		return await work();
	} finally {
		rmSync(lock, { force: true });
	}
}

async function git(exec: Exec, cwd: string, args: string[]) {
	return exec('git', args, { cwd, env: ENV });
}

// Creates the mirror on the first call and fetches into it on later calls. It returns the path of the mirror, which
// holds `baseSha`. The commit may sit under no ref of the source (a detached HEAD), so the call fetches it by its id.
export async function prepareMirror(exec: Exec, { repo, baseSha, cacheDir }: { repo: string; baseSha: string; cacheDir: string }): Promise<string> {
	const mirror = mirrorPath(cacheDir, repo);
	return withLock(`${mirror}.lock`, async () => {
		let fetchError = '';
		if (existsSync(join(mirror, 'HEAD'))) {
			// A mirror clone has the refspec `+refs/*:refs/*`, so this takes every ref and drops the refs that the source dropped.
			const fetched = await git(exec, mirror, ['fetch', '-q', '--prune', '--no-tags', 'origin']);
			if (fetched.code !== 0) fetchError = fetched.stderr.trim() || fetched.stdout.trim();
		} else {
			const partial = `${mirror}.tmp-${process.pid}`;
			rmSync(partial, { recursive: true, force: true });
			const cloned = await git(exec, dirname(mirror), ['clone', '-q', '--mirror', repo, partial]);
			if (cloned.code !== 0) {
				rmSync(partial, { recursive: true, force: true });
				throw new Error(`cannot create the mirror of ${repo}: ${cloned.stderr.trim() || cloned.stdout.trim()}`);
			}
			// The rename makes the mirror appear whole, so a crash never leaves half of one.
			renameSync(partial, mirror);
		}
		if ((await git(exec, mirror, ['cat-file', '-e', `${baseSha}^{commit}`])).code !== 0) {
			const fetched = await git(exec, mirror, ['fetch', '-q', '--no-tags', repo, baseSha]);
			if (fetched.code !== 0) throw new Error(`cannot put ${baseSha} in the mirror ${mirror}: ${fetched.stderr.trim() || fetchError || fetched.stdout.trim()}`);
		}
		return mirror;
	});
}
