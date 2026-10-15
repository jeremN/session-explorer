// Merge requests (GitLab) and pull requests (GitHub) a session created. Pure, no file access.
// GitLab: `git push -o merge_request.create` answers with a `remote:` line that holds the URL, but prints the same line
// for a merge request that already exists. GitHub: `gh pr create` prints the URL of the new pull request on its own line.
// So the session that created a merge request is the one whose creating command shows it first.
// A GitLab key is `group/project!N`, a GitHub key is `owner/repo#N`.

export type MrMention = { key: string; t: string; pushed: boolean };

const MR_URL = /https?:\/\/[A-Za-z0-9.-]*gitlab[A-Za-z0-9.-]*\/([A-Za-z0-9_./-]+?)\/-\/merge_requests\/(\d+)/g;
const PR_URL = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g;
// The Read tool prefixes each line with its number and a tab.
const REMOTE_LINE = /^(?:\s*\d+\t)?remote:\s+(\S+)/gm;
const URL_LINE = /^(?:\s*\d+\t)?(https:\/\/github\.com\/\S+)/gm;
const CREATE_COMMAND = /\bgit\b.*\bpush\b.*merge_request\.create|\bgh\s+pr\s+create\b/s;

const keysIn = (text: string) => [
	...[...text.matchAll(MR_URL)].map(([, repo, number]) => `${repo}!${number}`),
	...[...text.matchAll(PR_URL)].map(([, repo, number]) => `${repo}#${number}`)
];

function resultText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) return content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n');
	return '';
}

export function mrMentions(entries: unknown[]): MrMention[] {
	const mentions: MrMention[] = [];
	// A command in the background prints its URL in the result of a later call, so one creating command covers the rest of the session.
	// A pushed mention takes the time of that command: Claude Code writes a `pr-link` row between the call and its result.
	let pushAt: string | undefined;
	for (const entry of entries as any[]) {
		if (typeof entry?.timestamp !== 'string' || entry.timestamp === '') continue;
		const content = Array.isArray(entry?.message?.content) ? entry.message.content : [];
		const pushed = new Set<string>();
		for (const block of content) {
			if (block?.type === 'tool_use' && CREATE_COMMAND.test(String(block.input?.command ?? ''))) pushAt = entry.timestamp;
			// A failed command prints the URL of a merge request that already exists.
			if (block?.type !== 'tool_result' || block.is_error || pushAt === undefined) continue;
			const output = resultText(block.content);
			for (const [, url] of [...output.matchAll(REMOTE_LINE), ...output.matchAll(URL_LINE)]) for (const key of keysIn(url)) pushed.add(key);
		}
		for (const key of new Set(keysIn(JSON.stringify(entry)))) {
			mentions.push(pushed.has(key) ? { key, t: pushAt!, pushed: true } : { key, t: entry.timestamp, pushed: false });
		}
	}
	return mentions;
}

export function createdMrs(sessions: Array<{ session: string; mentions: MrMention[] }>): Record<string, string[]> {
	const first = new Map<string, { session: string; mention: MrMention }>();
	for (const { session, mentions } of sessions) {
		for (const mention of mentions) {
			const known = first.get(mention.key);
			if (!known || mention.t < known.mention.t) first.set(mention.key, { session, mention });
		}
	}
	const created: Record<string, string[]> = {};
	for (const [key, { session, mention }] of first) if (mention.pushed) (created[session] ??= []).push(key);
	return created;
}
