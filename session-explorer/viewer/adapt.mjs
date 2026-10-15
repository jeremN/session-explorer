// Turns one index row and one session file into the shape the drawing code reads.
// Loaded by the page and by the Node tests.
const IDLE_GAP_SECONDS = 300;
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash'];
const HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

export const esc = (value) => String(value).replace(/[&<>"]/g, (character) => HTML[character]);

// Greedy first fit over spans sorted by start. Returns the lane of each span.
export function packLanes(spans) {
	const ends = [];
	return spans.map(({ t0, t1 }) => {
		let lane = ends.findIndex((end) => end <= t0);
		if (lane === -1) lane = ends.length;
		ends[lane] = t1;
		return lane;
	});
}

export function adapt(row, data) {
	const ev = data.events.map((event, i) => ({
		...event,
		i,
		wall: event.t,
		t: event.ta,
		node: event.node ?? null,
		tool: event.tool ?? '',
		target: event.target ?? '',
		tok: event.tok && { ...event.tok, cw: event.tok.cw5m + event.tok.cw1h }
	}));
	const last = ev.at(-1);

	const llms = ev.filter((event) => event.kind === 'llm');
	let cum = 0;
	llms.forEach((event, index) => {
		cum += event.cost ?? 0;
		event.cum = cum;
		event.n = index + 1;
	});
	const tot = { cost: cum, fresh: 0, cw: 0, out: 0, cr: 0 };
	for (const event of llms) for (const key of ['fresh', 'cw', 'out', 'cr']) tot[key] += event.tok[key];

	const subs = data.agents.map((agent, index) => {
		const own = ev.filter((event) => event.agent === index + 1);
		return { name: agent.name, description: agent.description ?? '', agent: index + 1, t0: own[0]?.t ?? 0, t1: own.at(-1)?.t ?? 0 };
	});
	const byStart = subs.slice().sort((a, b) => a.t0 - b.t0);
	packLanes(byStart).forEach((lane, index) => {
		byStart[index].lane = lane;
	});
	const nLanes = subs.reduce((most, sub) => Math.max(most, sub.lane + 1), 0);

	const nodesOf = (event) => {
		const ids = [];
		if (event.node) ids.push(event.node);
		if (event.mark) ids.push(`know:${event.mark}`);
		if (event.agent > 0) ids.push(`sub:${subs[event.agent - 1].name}`);
		return ids;
	};
	const counts = {};
	const first = {};
	for (const event of ev) {
		for (const id of nodesOf(event)) {
			counts[id] = (counts[id] || 0) + 1;
			first[id] ??= event.i;
		}
	}

	const groups = new Map();
	for (const event of ev) {
		if (event.kind !== 'error') continue;
		const key = `${event.tool}\n${event.msg}`;
		const group = groups.get(key) ?? { msg: event.msg, tool: event.tool, n: 0, first: event.i, t0: event.t, t1: event.t };
		groups.set(key, group);
		group.n += 1;
		group.t1 = event.t;
	}
	const errors = [...groups.values()].sort((a, b) => b.n - a.n);

	const breaks = [];
	for (let index = 1; index < ev.length; index++) {
		const gap = (Date.parse(ev[index].wall) - Date.parse(ev[index - 1].wall)) / 1000;
		if (gap > IDLE_GAP_SECONDS) breaks.push((ev[index - 1].t + ev[index].t) / 2);
	}

	const firstAt = (iso) => ev.find((event) => event.wall >= iso) ?? last;
	const tasks = data.tasks.map((task, index) => {
		const iEdit = ev.find((event) => event.wall === task.editAt && EDIT_TOOLS.includes(event.tool))?.i;
		// "Plan, then go" is one task: the prompts before the first edit all belong to it.
		const asked = ev.filter((event) => event.kind === 'prompt' && event.wall >= task.start && event.wall <= task.editAt);
		return {
			...task,
			n: index + 1,
			t0: firstAt(task.start).t,
			t1: firstAt(task.end).t,
			i0: firstAt(task.start).i,
			iEdit,
			ask: asked[0]?.msg ?? '',
			prompts: asked.length,
			file: iEdit === undefined ? '' : ev[iEdit].target
		};
	});
	const taskOf = (event) => tasks.findLast((task) => event.wall >= task.start && event.wall <= task.end);

	const dur = last.t || 1;
	const worktree = row.project.includes('--') ? row.project.split('--').pop() : undefined;
	return {
		cfg: { title: data.title, date: row.start, durMin: dur / 60, tags: [row.branch, worktree].filter(Boolean) },
		ev,
		llms,
		subs,
		nLanes,
		counts,
		first,
		tot,
		errors,
		breaks,
		tasks,
		dur,
		unpriced: row.unpricedRequests,
		nodesOf,
		taskOf
	};
}
