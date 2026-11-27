import assert from 'node:assert/strict';
import { test } from 'node:test';

import { editsPaths, evalPath, metricCell, passPill, renderCampaign, renderCampaignList, renderEval, renderEvalOptions, renderRuns, renderWatch, testShares } from '../session-explorer/viewer/evals.mjs';

const spread = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return { n: values.length, median: sorted[sorted.length >> 1], min: sorted[0], max: sorted.at(-1), values };
};
const run = (id: string, config: string, extra: Record<string, unknown> = {}) => ({
	id,
	config,
	status: 'ok',
	sessionId: `sess-${id}`,
	wallSec: 120,
	acceptance: { passed: true },
	diff: { files: 1, added: 12, deleted: 3 },
	metrics: { cost: 0.5 },
	...extra
});
const sample = (name = 'baseline') => ({
	id: '20261113-142000-format-dollars',
	name: 'format-dollars',
	spent: 4.12,
	baseSha: '1a2b3c4d5e6f',
	spec: { task: { repo: '/home/me/repo' }, runs: 3 },
	configs: [
		{ name, model: 'sonnet', pass: { passed: 2, n: 3 }, metrics: { cost: spread([0.52, 0.94, 0.71]), errors: spread([0, 0, 0]), verified: spread([1, 0, 0]) } },
		{ name: 'terse', model: 'sonnet', pass: { passed: 3, n: 3 }, metrics: { cost: spread([0.4, 0.45, 0.61]), errors: spread([0, 0, 0]), verified: spread([1, 1, 1]) } }
	],
	runs: [run('baseline-1', name), run('terse-1', 'terse', { status: 'timeout', acceptance: { passed: false } }), run('baseline-2', name, { status: 'skipped', sessionId: undefined })]
});

test('a metric cell holds the median, the min-max text and one dot per counted run', () => {
	const html = metricCell(spread([0.52, 0.94, 0.71]), 'cost', { min: 0.4, max: 0.94 });
	assert.match(html, /0\.71/);
	assert.match(html, /0\.52–0\.94/);
	assert.equal(html.match(/<circle/g)?.length, 3);
	assert.equal(metricCell(spread([2, 2]), 'errors', { min: 2, max: 2 }).match(/<circle/g)?.length, 2);
});

test('the pass-rate pill is positive at 3/3, warning at 2/3, negative at 0/3', () => {
	assert.match(passPill({ passed: 3, n: 3 }), /data-tone="positive"[^>]*>3\/3</);
	assert.match(passPill({ passed: 2, n: 3 }), /data-tone="warning"[^>]*>2\/3</);
	assert.match(passPill({ passed: 0, n: 3 }), /data-tone="negative"[^>]*>0\/3</);
});

test('the best median of a row gets data-best, lower is better except for verified tasks', () => {
	const html = renderEval(sample());
	const cells = (label: string) => html.split(`<th scope="row">${label}</th>`)[1].split('</tr>')[0].split('<td');
	assert.match(cells('Coût ($)')[2], /data-best/);
	assert.doesNotMatch(cells('Coût ($)')[1], /data-best/);
	assert.match(cells('Tâches vérifiées')[2], /data-best/);
});

test('a metric row where every run has 0 is hidden', () => {
	const html = renderEval(sample());
	assert.doesNotMatch(html, /Erreurs/);
	assert.match(html, /Coût \(\$\)/);
});

test('the view is French, shows the totals and links a run to its session', () => {
	const html = renderEval(sample());
	assert.match(html, /format-dollars/);
	assert.match(html, /repo@1a2b3c4/);
	assert.match(html, /4\.12 \$ dépensés/);
	assert.match(html, /href="#sess-baseline-1"/);
	assert.match(html, /délai dépassé/);
	assert.match(html, /ignoré/);
	assert.doesNotMatch(html, /href="#undefined"/);
});

test('a config name, an eval name and a run id with markup are escaped', () => {
	const evil = '<script>alert(1)</script>';
	const data = sample(evil);
	data.name = evil;
	data.runs[0].id = evil;
	const html = renderEval(data) + renderRuns(data) + renderEvalOptions([{ id: 'x', name: evil, generatedAt: '2026-11-13T14:20:00Z' }], 'x');
	assert.doesNotMatch(html, /<script>/);
	assert.match(html, /&lt;script&gt;/);
});

test('the option list marks the selected eval', () => {
	const html = renderEvalOptions([{ id: 'a', name: 'one', generatedAt: '2026-11-13T14:20:00Z' }, { id: 'b', name: 'two', generatedAt: '2026-11-12T14:20:00Z' }], 'b');
	assert.match(html, /<option value="b" selected>/);
	assert.doesNotMatch(html, /<option value="a" selected>/);
});

test('the eval view names a non-Claude agent, shows a cost under a cent, and a run with no cost', async () => {
	const { renderEval } = await import('../session-explorer/viewer/evals.mjs');
	const spread = (values: number[]) => ({ n: values.length, median: values[0], min: Math.min(...values), max: Math.max(...values), values });
	const html = renderEval({
		id: 'e', name: 'n', generatedAt: '2026-11-17T10:00:00Z', spent: 0, cliVersion: 'x', baseSha: 'abc', spec: { task: { prompt: 'p' } },
		configs: [{ name: 'cheap', agent: 'opencode', model: null, pass: { passed: 1, n: 1 }, metrics: { cost: spread([0.0025]) } }],
		runs: [{ id: 'cheap-1', config: 'cheap', status: 'ok', metrics: { errors: 0 } }]
	});
	assert.match(html, /cheap <small>opencode<\/small>/);
	assert.match(html, /0\.0025/);
	assert.match(html, /—/);
});

test('the test share shows per run, per config and in the header; an infra failure is neither a pass nor a test count', () => {
	const data = sample();
	data.runs = [
		run('baseline-1', 'baseline', { acceptance: { passed: false, tests: { passed: 27, total: 28 } } }),
		run('baseline-2', 'baseline', { acceptance: { passed: false, exitCode: 3, infra: true, tests: { passed: 0, total: 28 } } }),
		run('terse-1', 'terse', { acceptance: { passed: false, tests: { passed: 14, total: 28 } } })
	];
	const shares = testShares(data);
	assert.deepEqual(shares.map((spread) => spread?.values), [[27 / 28], [0.5]]);
	const html = renderEval(data);
	const row = html.split('<th scope="row">Tests passés</th>')[1].split('</tr>')[0].split('<td');
	assert.match(row[1], /data-best[^>]*><span class="ev-med">96 %/);
	assert.match(row[2], /50 %/);
	// 41 of 56 tests, the infra run left out.
	assert.match(html, /Tests passés<\/dt><dd[^>]*>73 %/);
	assert.match(html, /Échecs infra<\/dt><dd[^>]*>1</);
	assert.match(html, /data-tone="warning"[^>]*>infra</);
	assert.match(html, /27\/28/);
});

test('a rechecked run shows its earlier verdict, and a run with blocked hosts names them', () => {
	const html = renderRuns({
		runs: [run('a-1', 'a', { acceptance: { passed: true, tests: { passed: 28, total: 28 } }, rechecked: { at: '2026-11-22T10:00:00Z', previous: { passed: false, tests: { passed: 0, total: 28 } } }, blockedHosts: ['ab.chatgpt.com:443', '<x>:443'] })]
	});
	assert.match(html, /title="avant : échec 0\/28">revérifié</);
	assert.match(html, /2 hôtes bloqués/);
	assert.match(html, /title="ab\.chatgpt\.com:443, &lt;x&gt;:443"/);
});

test('the watch panel lists each watched file with its last verdict and a link to the measure', () => {
	assert.equal(renderWatch({}), '');
	const html = renderWatch({
		'CLAUDE.md-1': { hash: 'h', at: '2026-11-22T10:00:00Z', label: '~/repo/CLAUDE.md on task/sonnet', verdict: 'worse', evalDir: '/x/out/20261122-100000-task-diff' },
		'AGENTS.md-2': { hash: 'h', at: '2026-11-22T10:00:00Z' }
	});
	assert.match(html, /~\/repo\/CLAUDE\.md on task\/sonnet/);
	assert.match(html, /data-tone="negative"[^>]*>moins bien</);
	assert.match(html, /href="#evals\/20261122-100000-task-diff"/);
	// A file with a first copy and no measure yet: its name, no link.
	assert.match(html, /AGENTS\.md-2.*copie seule/);
});

test('the comparison has one row per grader: the runs with findings out of the graded runs', () => {
	const data = sample();
	assert.doesNotMatch(renderEval(data), /Constats/);
	Object.assign(data.configs[0], { grades: { review: { graded: 3, withFindings: 1, findings: 2, bySeverity: { minor: 2 } }, '<b>': { graded: 2, withFindings: 2, findings: 4, bySeverity: {} } } });
	Object.assign(data.configs[1], { grades: { review: { graded: 3, withFindings: 0, findings: 0, bySeverity: {} } } });
	const html = renderEval(data);
	const row = html.split('<th scope="row">Constats review</th>')[1].split('</tr>')[0].split('<td');
	assert.match(row[1], /data-tone="warning"[^>]*>1\/3</);
	assert.match(row[2], /data-tone="positive"[^>]*>0\/3</);
	const other = html.split('<th scope="row">Constats &lt;b&gt;</th>')[1].split('</tr>')[0].split('<td');
	assert.match(other[1], /data-tone="negative"[^>]*>2\/2</);
	assert.match(other[2], /—/);
});

test('a run with steps shows one band cell per step, by its class, and the panel has one legend', () => {
	const html = renderRuns({
		runs: [run('a-1', 'a', { steps: ['explore', 'edit', 'test-failed', 'edit', 'test'] }), run('a-2', 'a', { steps: ['lint', '<script>'] }), run('a-3', 'a')]
	});
	const band = html.split('<span class="ev-band"')[1].split('</span>')[0];
	assert.deepEqual([...band.matchAll(/data-step="([^"]+)"/g)].map((match) => match[1]), ['explore', 'edit', 'test-failed', 'edit', 'test']);
	assert.match(html, /aria-label="5 étapes"/);
	// An unknown class is drawn as other, never as markup.
	assert.doesNotMatch(html, /<script>/);
	assert.match(html.split('<span class="ev-band"')[2], /data-step="lint".*data-step="other"/);
	// The legend names the classes of the panel, once.
	assert.equal(html.match(/class="ev-legend"/g)?.length, 1);
	for (const label of ['exploration', 'édition', 'test en échec', 'lint', 'autre']) assert.match(html.split('class="ev-legend"')[1], new RegExp(label));
	assert.doesNotMatch(html.split('class="ev-legend"')[1], /installation/);
	// A run of an older eval has no steps.
	assert.match(html.split('<td>a-3</td>')[1].split('</tr>')[0], /<td>—<\/td>/);
	assert.doesNotMatch(renderRuns({ runs: [run('b-1', 'b')] }), /ev-legend/);
});

test('the comparison shows the medians of the behavior metrics and the runs that lint only at the end', () => {
	const data = sample();
	Object.assign(data.configs[0].metrics, { toolCalls: spread([6, 7, 9]), testFailures: spread([0, 1, 0]), firstContextTokens: spread([22000, 23000, 24000]), lintOnlyAtEnd: spread([1, 0]) });
	Object.assign(data.configs[1].metrics, { toolCalls: spread([10, 11, 12]), testFailures: spread([1, 1, 2]), firstContextTokens: spread([32000, 32000, 33000]), lintOnlyAtEnd: spread([1, 1, 1]) });
	const html = renderEval(data);
	const cells = (label: string) => html.split(`<th scope="row">${label}</th>`)[1].split('</tr>')[0].split('<td');
	assert.match(cells('Appels d’outils')[1], /data-best[^>]*><span class="ev-med">7</);
	assert.match(cells('Tests en échec')[1], /data-best/);
	assert.match(cells('Contexte initial')[2], /32\.0k/);
	assert.match(cells('Lint seulement à la fin')[1], />1\/2</);
	assert.match(cells('Lint seulement à la fin')[2], />3\/3</);
	// An eval without the behavior metrics has none of these rows.
	assert.doesNotMatch(renderEval(sample()), /Appels d’outils|Lint seulement/);
});

test('a config with edits shows the diff it measured in a collapsible block, escaped', () => {
	const data = sample();
	(data.configs[1] as Record<string, unknown>).editsPatch = 'configs/terse/1a2b3c4/edits.patch';
	const html = renderEval(data, { terse: 'diff --git a/AGENTS.md b/AGENTS.md\n-<b>old</b>\n+new\n' });
	const block = html.split('<details class="ev-edits"')[1].split('</details>')[0];
	assert.match(block, /<summary>terse · configs\/terse\/1a2b3c4\/edits\.patch<\/summary>/);
	assert.match(block, /<pre class="ev-patch">diff --git a\/AGENTS\.md b\/AGENTS\.md\n<del>-&lt;b&gt;old&lt;\/b&gt;<\/del>\n<ins>\+new<\/ins>\n<\/pre>/);
	assert.equal(html.match(/<details class="ev-edits"/g)?.length, 1);
	// A patch the viewer could not read says so.
	assert.match(renderEval(data), /<pre class="ev-patch">diff illisible : configs\/terse\/1a2b3c4\/edits\.patch<\/pre>/);
	// An eval without edits has no such panel.
	assert.doesNotMatch(renderEval(sample()), /ev-edits|Variantes/);
	assert.deepEqual(editsPaths(data), { terse: 'configs/terse/1a2b3c4/edits.patch' });
});


const cell = (diff: number, ci: [number, number], cost: number, costCi: [number, number]) => ({ n: { config: 6, reference: 6 }, pass: { config: { passed: 5, n: 6 }, reference: { passed: 3, n: 6 }, diff, p: 0.2, ci, power: 40 }, metrics: { cost: { config: 1, reference: 2, n: { config: 6, reference: 6 }, diff: cost, p: 0.03, ci: costCi } }, graders: {} });
const campaign = () => ({
	id: '20261126-100000-cmp',
	name: 'cmp',
	status: 'done',
	reference: 'base',
	spent: 12.5,
	configs: ['base', 'tested'],
	specs: [
		{ name: 'alpha', evalId: '20261126-100000-cmp-alpha' },
		{ name: '<b>beta', evalId: 'x' }
	],
	results: [{ spec: 'alpha', id: 'base-1', config: 'base', status: 'ok', attempts: 1, costUsd: 1 }],
	report: {
		reference: 'base',
		resamples: 1000,
		seed: 1,
		specs: ['alpha', '<b>beta'],
		configs: [{ name: 'tested', perSpec: { alpha: cell(0.33, [0.1, 0.5], -1, [-1.2, -0.8]), '<b>beta': cell(-0.16, [-0.4, 0.1], 0.5, [-0.1, 0.9]) }, pooled: cell(0.2, [0.05, 0.35], -0.4, [-0.6, -0.2]) }]
	}
});

test('an eval path keeps its slashes and encodes each segment', () => {
	assert.equal(evalPath('20261126-100000-task'), '20261126-100000-task');
	assert.equal(evalPath('campaigns/20261126-100000-cmp/a b'), 'campaigns/20261126-100000-cmp/a%20b');
});

test('the campaign view has one row per config, a column per spec and a pooled column', () => {
	const html = renderCampaign(campaign());
	assert.equal(html.match(/<tbody>[\s\S]*<\/tbody>/)![0].match(/<tr>/g)?.length, 1);
	const head = html.split('<thead>')[1].split('</thead>')[0];
	assert.match(head, />alpha</);
	assert.match(head, /&lt;b&gt;beta/);
	assert.match(head, /Cumul/);
	assert.doesNotMatch(html, /<b>beta/);
	assert.match(html, /tested/);
	// A cell: the pass rate difference with its interval, and the cost difference with its interval.
	assert.match(html, /\+33 pts/);
	assert.match(html, /\[\+10, \+50\]/);
	assert.match(html, /−1\.00 \$/);
	// Each spec column links to the eval view of its folder.
	assert.match(html, /href="#evals\/campaigns\/20261126-100000-cmp\/alpha"/);
	assert.match(html, /réf\. base/);
});

test('a difference whose interval leaves zero has a tone, and one that holds zero has none', () => {
	const html = renderCampaign(campaign());
	// Pass rate up with an interval above 0: positive. Cost down with an interval below 0: positive too.
	const alpha = html.split('<tbody>')[1].split('<td')[1];
	assert.match(alpha, /data-tone="positive"[^>]*>\+33 pts/);
	assert.match(alpha, /data-tone="positive"[^>]*>−1\.00 \$/);
	const beta = html.split('<tbody>')[1].split('<td')[2];
	assert.match(beta, /data-tone="neutral"[^>]*>−16 pts/);
});

test('a campaign cell names each line, gives its p-value, adds tool calls, and never prints a negative zero', () => {
	const data = campaign();
	const pooled = data.report.configs[0].pooled as ReturnType<typeof cell> & { metrics: Record<string, unknown> };
	pooled.metrics.toolCalls = { config: 6.5, reference: 6, n: { config: 6, reference: 6 }, diff: 0.33, p: 0.7046, ci: [-1.17, 1.83] };
	pooled.metrics.cost = { config: 0.265, reference: 0.26, n: { config: 6, reference: 6 }, diff: -0.001, p: 0.2012, ci: [-0.02, 0.01] };
	const html = renderCampaign(data);
	const cumul = html.split('<tbody>')[1].split('<td').at(-1)!.split('</td>')[0];
	assert.match(cumul, /réussite/);
	assert.match(cumul, /coût/);
	assert.match(cumul, /appels/);
	assert.match(cumul, /p 0\.20/);
	assert.match(cumul, /p 0\.70/);
	assert.match(cumul, /\+0\.3/);
	assert.match(cumul, /\[−1\.2, \+1\.8\]/);
	// A difference that rounds to zero has no minus sign.
	assert.doesNotMatch(cumul, /−0\.00/);
	assert.match(cumul, /\+0\.00 \$/);
	// A spec cell without tool calls has no "appels" line.
	assert.doesNotMatch(html.split('<tbody>')[1].split('<td')[1], /appels/);
});

test('a campaign with no report says so, and the list links each campaign', () => {
	const bare = campaign();
	delete (bare as { report?: unknown }).report;
	assert.match(renderCampaign(bare), /Pas de rapport/);
	assert.equal(renderCampaignList([]), '');
	const list = renderCampaignList([{ id: '20261126-100000-cmp', name: 'c<mp', generatedAt: '2026-11-26T10:00:00Z', status: 'interrupted', specs: ['a', 'b'], configs: ['base', 'tested'], reference: 'base', runs: 8, cost: 3.2 }]);
	assert.match(list, /href="#evals\/campaigns\/20261126-100000-cmp"/);
	assert.match(list, /c&lt;mp/);
	assert.match(list, /interrompue/);
});

test('the runs panel shows an interrupted run with its own label', () => {
	const data = sample();
	data.runs.push(run('terse-2', 'terse', { status: 'interrupted', sessionId: undefined }));
	assert.match(renderRuns(data), /interrompu/);
});
