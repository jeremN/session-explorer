import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createdMrs, mrMentions } from './mr.ts';

const URL_101 = 'https://gitlab.example.com/acme/web/-/merge_requests/101';
const at = (second: number) => new Date(Date.UTC(2026, 9, 15, 8, 0, second)).toISOString();
const bash = (second: number, id: string, command: string) => ({
	type: 'assistant',
	timestamp: at(second),
	message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] }
});
const result = (second: number, id: string, content: string) => ({
	type: 'user',
	timestamp: at(second),
	message: { content: [{ type: 'tool_result', tool_use_id: id, content }] }
});
const said = (second: number, text: string) => ({ type: 'assistant', timestamp: at(second), message: { content: [{ type: 'text', text }] } });
const PUSH_OUTPUT = `remote: \nremote: View merge request for feat-123/fix:        \nremote:   ${URL_101}        \nremote: \n`;
const CREATE = 'git push --set-upstream -o merge_request.create -o "merge_request.title=fix" origin feat-123/fix';

// A pushed mention takes the time of the push call: the merge request exists from that call on.
test('the push that creates a merge request prints its URL on a remote line: a pushed mention at the push time', () => {
	assert.deepEqual(mrMentions([bash(0, 'p', CREATE), result(5, 'p', PUSH_OUTPUT)]), [{ key: 'acme/web!101', t: at(0), pushed: true }]);
});

test('the pr-link row Claude Code writes before the push result does not hide the creation', () => {
	const prLink = { type: 'pr-link', timestamp: at(4), prNumber: 101, prUrl: URL_101, prRepository: 'acme/web' };
	const mentions = mrMentions([bash(0, 'p', CREATE), prLink, result(5, 'p', PUSH_OUTPUT)]);
	assert.deepEqual(createdMrs([{ session: 's1', mentions }]), { s1: ['acme/web!101'] });
});

test('a URL the agent only reads or writes is a plain mention', () => {
	assert.deepEqual(mrMentions([said(0, `Voir ${URL_101}.`)]), [{ key: 'acme/web!101', t: at(0), pushed: false }]);
});

test('a push in the background prints its URL later, in the result of another call', () => {
	const entries = [bash(0, 'p', CREATE), result(1, 'p', 'Command running in background with ID: b1'), bash(30, 'r', 'cat /tmp/b1.output'), result(31, 'r', PUSH_OUTPUT)];
	assert.deepEqual(
		mrMentions(entries).filter((mention) => mention.pushed),
		[{ key: 'acme/web!101', t: at(0), pushed: true }]
	);
});

test('a remote line without a creating push in the session is a plain mention', () => {
	assert.deepEqual(mrMentions([bash(0, 'p', 'git push'), result(5, 'p', PUSH_OUTPUT)]), [{ key: 'acme/web!101', t: at(5), pushed: false }]);
});

test('the repository path is part of the key: two projects can share a number', () => {
	const brain = 'https://gitlab.example.com/acme/team-brain/-/merge_requests/7';
	assert.deepEqual(
		mrMentions([said(0, `${brain} et ${URL_101}`)]).map((mention) => mention.key),
		['acme/team-brain!7', 'acme/web!101']
	);
});

test('a merge request belongs to the session whose pushed mention is its first mention', () => {
	const key = 'acme/web!101';
	const created = createdMrs([
		{ session: 's2', mentions: [{ key, t: at(50), pushed: true }] },
		{ session: 's1', mentions: [{ key, t: at(10), pushed: true }] }
	]);
	assert.deepEqual(created, { s1: [key] });
});

test('a merge request mentioned before its first push already existed', () => {
	const key = 'acme/web!101';
	const created = createdMrs([
		{ session: 's0', mentions: [{ key, t: at(1), pushed: false }] },
		{ session: 's1', mentions: [{ key, t: at(10), pushed: true }] }
	]);
	assert.deepEqual(created, {});
});

test('a remote line quoted inside another output, such as a grep hit, is a plain mention', () => {
	const entries = [bash(0, 'p', CREATE), result(1, 'p', 'Everything up-to-date'), bash(2, 'g', 'grep -rn remote: notes'), result(3, 'g', `notes.md:3:remote:   ${URL_101}`)];
	assert.deepEqual(
		mrMentions(entries).map((mention) => mention.pushed),
		[false]
	);
});

test('a background push output read with the Read tool keeps its line numbers', () => {
	const numbered = PUSH_OUTPUT.split('\n').map((line, n) => `${n + 1}\t${line}`).join('\n');
	const entries = [bash(0, 'p', CREATE), result(1, 'p', 'Command running in background with ID: b1'), result(30, 'r', numbered)];
	assert.deepEqual(
		mrMentions(entries).map((mention) => mention.pushed),
		[true]
	);
});

test('a row without a timestamp gives no mention: it cannot come first', () => {
	assert.deepEqual(mrMentions([{ type: 'last-prompt', lastPrompt: URL_101 }]), []);
});

const failed = (second: number, id: string, content: string) => ({
	type: 'user',
	timestamp: at(second),
	message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: true }] }
});

test('gh pr create prints the URL of the new pull request on its own line', () => {
	const entries = [bash(0, 'c', 'gh pr create --title "Fix" --body "x"'), result(4, 'c', 'Creating pull request for feat into main in acme/web\n\nhttps://github.com/acme/web/pull/498\n')];
	assert.deepEqual(mrMentions(entries), [{ key: 'acme/web#498', t: at(0), pushed: true }]);
});

test('the compare link a git push prints on GitHub is not a pull request', () => {
	const output = "remote: Create a pull request for 'feat' on GitHub by visiting:\nremote:      https://github.com/acme/web/pull/new/feat\n";
	assert.deepEqual(mrMentions([bash(0, 'p', 'git push -u origin feat'), result(3, 'p', output)]), []);
});

test('a failed creation prints the URL of the pull request that already exists: a plain mention', () => {
	const output = 'a pull request for branch "feat" into branch "main" already exists:\nhttps://github.com/acme/web/pull/7';
	assert.deepEqual(mrMentions([bash(0, 'c', 'gh pr create --fill'), failed(2, 'c', output)]), [{ key: 'acme/web#7', t: at(2), pushed: false }]);
});

test('a push that GitLab answered created the merge request, even when a later command of the same call failed', () => {
	const entries = [bash(0, 'p', `${CREATE} && missing-command`), failed(5, 'p', `Exit code 1\n${PUSH_OUTPUT}(eval):1: command not found: missing-command`)];
	assert.deepEqual(mrMentions(entries), [{ key: 'acme/web!101', t: at(0), pushed: true }]);
});
