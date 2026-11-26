// Render functions of the "Évaluations" view. Pure: they return HTML strings, so Node tests cover them.
// Every string that comes from a spec or a run goes through esc().
import { esc } from './adapt.mjs';
import { pill, stat } from './ui.mjs';

// [key, label, format, better]. better: 'low', 'high' or null (no best mark).
const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 1e5 ? 0 : 1) + 'k' : String(Math.round(n)));
const dec = (n) => String(Math.round(n * 100) / 100);
// A cheap model costs less than a cent per run: show four decimals there.
const money = (n) => (n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2));
const ROWS = [
	['cost', 'Coût ($)', money, 'low'],
	['billedTokens', 'Tokens facturés', kfmt, 'low'],
	['wallSec', 'Durée (s)', (n) => String(Math.round(n)), 'low'],
	['errors', 'Erreurs', dec, 'low'],
	['denials', 'Refus système', dec, 'low'],
	['outages', 'Pannes du classifieur', dec, null],
	['loops', 'Boucles', dec, 'low'],
	['retries', 'Relances', dec, 'low'],
	['subagentCost', 'Coût sous-agents', (n) => n.toFixed(2), 'low'],
	['skillLoads', 'Skills chargés', dec, null],
	['verified', 'Tâches vérifiées', dec, 'high'],
	['failed', 'Vérifs en échec', dec, 'low'],
	// The behavior metrics (session-explorer/behavior.ts). An eval of an older runner has none, so the rows stay hidden.
	['toolCalls', 'Appels d’outils', dec, 'low'],
	['explore', 'Explorations', dec, null],
	['edits', 'Éditions', dec, null],
	['testRuns', 'Tests lancés', dec, null],
	['testFailures', 'Tests en échec', dec, 'low'],
	['redGreenCycles', 'Cycles rouge-vert', dec, null],
	['typeChecks', 'Vérifs de types', dec, null],
	['lintRuns', 'Lints lancés', dec, null],
	['rereads', 'Relectures', dec, 'low'],
	['reruns', 'Vérifs répétées', dec, 'low'],
	['toolErrors', 'Erreurs d’outils', dec, 'low'],
	['firstContextTokens', 'Contexte initial', kfmt, 'low'],
	['lines', 'Lignes modifiées', (n) => String(Math.round(n)), null],
	['cacheReadShare', 'Lecture cache', (n) => Math.round(n * 100) + ' %', 'high']
];
const STATUS = {
	ok: ['ok', 'positive'],
	timeout: ['délai dépassé', 'warning'],
	budget: ['budget', 'warning'],
	error: ['erreur', 'negative'],
	skipped: ['ignoré', 'neutral'],
	interrupted: ['interrompu', 'warning']
};
// The classes of a step, in the order of the legend. A class outside this list is drawn as other.
const STEPS = {
	explore: 'exploration',
	edit: 'édition',
	test: 'test',
	'test-failed': 'test en échec',
	types: 'types',
	lint: 'lint',
	build: 'build',
	install: 'installation',
	git: 'git',
	other: 'autre'
};
const stepClass = (name) => (Object.hasOwn(STEPS, name) ? name : 'other');
const percent = (n) => Math.round(n * 100) + ' %';
const format = (key) => (key === 'testShare' ? percent : ROWS.find(([name]) => name === key)[2]);

/** Pass-rate pill: "k/n". positive when every run passed, negative when none did, warning between. */
export function passPill({ passed, n }) {
	const tone = n === 0 ? 'neutral' : passed === n ? 'positive' : passed === 0 ? 'negative' : 'warning';
	return pill(passed + '/' + n, tone);
}

// One dot per run on a strip. Every cell of a row shares one scale, so the dots compare across configurations.
function dots(values, { min, max }) {
	const width = 88;
	const x = (value) => (max === min ? width / 2 : 4 + ((value - min) / (max - min)) * (width - 8));
	return (
		'<svg class="ev-dots" width="' + width + '" height="12" viewBox="0 0 ' + width + ' 12" aria-hidden="true">' +
		'<line x1="0" y1="6" x2="' + width + '" y2="6" stroke="var(--grid)"/>' +
		values.map((value) => '<circle cx="' + x(value).toFixed(1) + '" cy="6" r="2.5" fill="var(--s1)" fill-opacity=".8"/>').join('') +
		'</svg>'
	);
}

/** A metric cell: the median in mono, "min–max" in muted, one dot per counted run. */
export function metricCell(spread, key, scale, best = false) {
	const show = format(key);
	return (
		'<td' + (best ? ' data-best' : '') + '>' +
		'<span class="ev-med">' + esc(show(spread.median)) + '</span> ' +
		'<span class="ev-range">' + esc(show(spread.min) + '–' + show(spread.max)) + '</span>' +
		dots(spread.values, scale) +
		'</td>'
	);
}

function bestConfigs(configs, key, better) {
	const medians = configs.map((config) => config.metrics[key]?.median);
	const present = medians.filter((value) => value !== undefined);
	if (!better || present.length < 2 || present.every((value) => value === present[0])) return new Set();
	const target = better === 'low' ? Math.min(...present) : Math.max(...present);
	return new Set(medians.flatMap((value, index) => (value === target ? [index] : [])));
}

/** The "Comparaison" panel: one row per metric, one column per configuration. */
export function renderComparison(ev) {
	const head = '<tr><th scope="col">Métrique</th>' + ev.configs.map((config) => '<th scope="col">' + esc(config.name) + (config.agent && config.agent !== 'claude' ? ' <small>' + esc(config.agent) + '</small>' : '') + '</th>').join('') + '</tr>';
	const pass = '<tr><th scope="row">Réussite</th>' + ev.configs.map((config) => '<td>' + passPill(config.pass) + '</td>').join('') + '</tr>';
	// The share of tests tells a near miss (27/28) from a run that did nothing (0/28): the pass rate does not.
	const shares = testShares(ev);
	const present = shares.filter(Boolean);
	let tests = '';
	if (present.length) {
		const all = present.flatMap((spread) => spread.values);
		const scale = { min: Math.min(...all), max: Math.max(...all) };
		const medians = present.map((spread) => spread.median);
		const top = Math.max(...medians);
		const marked = present.length > 1 && !medians.every((value) => value === top);
		tests = '<tr><th scope="row">Tests passés</th>' + shares.map((spread) => (spread ? metricCell(spread, 'testShare', scale, marked && spread.median === top) : '<td>—</td>')).join('') + '</tr>';
	}
	// One row per grader: the runs with findings out of the graded runs. Fewer is better, so the tone of passPill is reversed.
	const graders = [...new Set(ev.configs.flatMap((config) => Object.keys(config.grades ?? {})))];
	const graded = graders.map((name) => {
		const cells = ev.configs.map((config) => {
			const stats = config.grades?.[name];
			if (!stats) return '<td>—</td>';
			const tone = stats.graded === 0 ? 'neutral' : stats.withFindings === 0 ? 'positive' : stats.withFindings === stats.graded ? 'negative' : 'warning';
			return '<td>' + pill(stats.withFindings + '/' + stats.graded, tone) + ' <span class="ev-range">' + stats.findings + ' constat' + (stats.findings === 1 ? '' : 's') + '</span></td>';
		});
		return '<tr><th scope="row">Constats ' + esc(name) + '</th>' + cells.join('') + '</tr>';
	});
	const rows = ROWS.flatMap(([key, label, , better]) => {
		const all = ev.configs.flatMap((config) => config.metrics[key]?.values ?? []);
		// A row where every run has 0 says nothing. Print and refusal counters stay at 0 in print mode.
		if (all.length === 0 || all.every((value) => value === 0)) return [];
		const scale = { min: Math.min(...all), max: Math.max(...all) };
		const best = bestConfigs(ev.configs, key, better);
		const cells = ev.configs.map((config, index) => (config.metrics[key] ? metricCell(config.metrics[key], key, scale, best.has(index)) : '<td>—</td>'));
		return ['<tr><th scope="row">' + esc(label) + '</th>' + cells.join('') + '</tr>'];
	});
	// A run lints only at the end when every lint comes after its last edit: k runs out of the runs that lint.
	const lintEnd = ev.configs.some((config) => config.metrics.lintOnlyAtEnd)
		? '<tr><th scope="row">Lint seulement à la fin</th>' +
			ev.configs
				.map((config) => {
					const values = config.metrics.lintOnlyAtEnd?.values;
					return values ? '<td>' + pill(values.filter((value) => value === 1).length + '/' + values.length, 'neutral') + ' <span class="ev-range">runs avec lint</span></td>' : '<td>—</td>';
				})
				.join('') +
			'</tr>'
		: '';
	return '<table class="ev-table"><thead>' + head + '</thead><tbody>' + pass + tests + graded.join('') + rows.join('') + lintEnd + '</tbody></table>';
}

// The check of one run: the verdict, the share of its tests, and a mark when the check ran again on the saved diff.
// An infra failure (the database did not start, for example) says nothing about the agent: it is not an "échec".
function checkCell(run) {
	const check = run.acceptance;
	const verdict = check.infra ? pill('infra', 'warning') : check.passed ? pill('passe', 'positive') : pill('échec', 'negative');
	const tests = check.tests ? ' <span class="ev-range">' + check.tests.passed + '/' + check.tests.total + '</span>' : '';
	const before = run.rechecked?.previous;
	const title = before ? 'avant : ' + (before.passed ? 'passe' : 'échec') + (before.tests ? ' ' + before.tests.passed + '/' + before.tests.total : '') : '';
	const recheck = run.rechecked ? ' <small class="ev-range"' + (title ? ' title="' + esc(title) + '"' : '') + '>revérifié</small>' : '';
	return verdict + tests + recheck;
}

/** The share of the tests that passed, per configuration, from the runs that report a test count. */
export function testShares(ev) {
	return ev.configs.map((config) => {
		const values = ev.runs.filter((run) => run.config === config.name && run.acceptance?.tests?.total > 0 && !run.acceptance.infra).map((run) => run.acceptance.tests.passed / run.acceptance.tests.total);
		if (!values.length) return undefined;
		const sorted = [...values].sort((a, b) => a - b);
		return { n: values.length, median: sorted[(sorted.length - 1) >> 1], min: sorted[0], max: sorted.at(-1), values };
	});
}

// One cell per tool call of the run, coloured by its first class.
function band(steps) {
	const cells = steps.map((name) => '<i data-step="' + stepClass(name) + '" title="' + STEPS[stepClass(name)] + '"></i>').join('');
	return '<span class="ev-band" role="img" aria-label="' + steps.length + ' étapes">' + cells + '</span>';
}

function legend(classes) {
	const items = Object.keys(STEPS)
		.filter((name) => classes.has(name))
		.map((name) => '<span><i data-step="' + name + '"></i>' + STEPS[name] + '</span>');
	return '<p class="ev-legend">' + items.join('') + '</p>';
}

/** The "Runs" panel: one row per planned run, and the legend of the step bands. */
export function renderRuns(ev) {
	const head = '<tr><th scope="col">Run</th><th scope="col">Config</th><th scope="col">Statut</th><th scope="col">Vérif</th><th scope="col">Coût</th><th scope="col">Durée</th><th scope="col">Diff</th><th scope="col">Étapes</th><th scope="col"></th></tr>';
	const seen = new Set(ev.runs.flatMap((run) => (Array.isArray(run.steps) ? run.steps.map(stepClass) : [])));
	const rows = ev.runs.map((run) => {
		const [label, tone] = STATUS[run.status] ?? [run.status, 'neutral'];
		const check = run.acceptance ? checkCell(run) : '—';
		// A codex run with no price in its config has no cost.
		const cost = typeof run.metrics?.cost === 'number' ? money(run.metrics.cost) + ' $' : '—';
		const wall = run.wallSec === undefined ? '—' : Math.round(run.wallSec) + ' s';
		const diff = run.diff ? '+' + run.diff.added + '−' + run.diff.deleted : '—';
		const link = run.sessionId && run.status !== 'skipped' ? '<a href="#' + esc(run.sessionId) + '">→ session</a>' : '';
		const hosts = run.blockedHosts?.length ? ' <small class="ev-range" title="' + esc(run.blockedHosts.join(', ')) + '">' + run.blockedHosts.length + ' hôte' + (run.blockedHosts.length > 1 ? 's' : '') + ' bloqué' + (run.blockedHosts.length > 1 ? 's' : '') + '</small>' : '';
		const steps = Array.isArray(run.steps) && run.steps.length ? band(run.steps) : '—';
		return '<tr><td>' + esc(run.id) + '</td><td>' + esc(run.config) + '</td><td>' + pill(label, tone) + hosts + '</td><td>' + check + '</td><td>' + cost + '</td><td>' + wall + '</td><td>' + diff + '</td><td>' + steps + '</td><td>' + link + '</td></tr>';
	});
	return '<table class="ev-table ev-runs"><thead>' + head + '</thead><tbody>' + rows.join('') + '</tbody></table>' + (seen.size ? legend(seen) : '');
}

/** The options of the eval picker. */
export function renderEvalOptions(evals, selectedId) {
	return evals
		.map((item) => {
			const day = new Date(item.generatedAt).toLocaleDateString('fr-FR');
			return '<option value="' + esc(item.id) + '"' + (item.id === selectedId ? ' selected' : '') + '>' + esc(item.name) + ' · ' + esc(day) + '</option>';
		})
		.join('');
}

/** The path of the edits.patch of each config with edits, by config name. The view reads them before it renders. */
export function editsPaths(ev) {
	return Object.fromEntries(ev.configs.filter((config) => typeof config.editsPatch === 'string').map((config) => [config.name, config.editsPatch]));
}

const patchLine = (line) => (line.startsWith('+') && !line.startsWith('+++') ? '<ins>' + esc(line) + '</ins>' : line.startsWith('-') && !line.startsWith('---') ? '<del>' + esc(line) + '</del>' : esc(line));

/** The "Variantes" panel: for each config with edits, the diff of its edited files against the base. */
export function renderEdits(ev, patches = {}) {
	const blocks = Object.entries(editsPaths(ev)).map(([name, path]) => {
		const text = patches[name];
		const body = typeof text === 'string' ? text.split('\n').map(patchLine).join('\n') : 'diff illisible : ' + esc(path);
		return '<details class="ev-edits"><summary>' + esc(name) + ' · ' + esc(path) + '</summary><pre class="ev-patch">' + body + '</pre></details>';
	});
	return blocks.length ? '<section class="panel"><h3>Variantes</h3>' + blocks.join('') + '</section>' : '';
}

/** The whole view for one eval: header panel, comparison panel, variants panel, runs panel. `patches`: the text of
 * each edits.patch, by config name. */
export function renderEval(ev, patches = {}) {
	const started = ev.runs.filter((run) => run.status !== 'skipped' && run.status !== 'interrupted');
	const passed = started.filter((run) => run.acceptance?.passed).length;
	const seconds = started.reduce((total, run) => total + (run.wallSec ?? 0), 0);
	const tested = started.filter((run) => run.acceptance?.tests?.total > 0 && !run.acceptance.infra);
	const infra = started.filter((run) => run.acceptance?.infra).length;
	const repo = String(ev.spec?.task?.repo ?? '').split('/').filter(Boolean).at(-1) ?? '';
	const line = esc(ev.name) + ' · ' + esc(repo) + '@' + esc(String(ev.baseSha).slice(0, 7)) + ' · ' + started.length + ' runs × ' + ev.configs.length + ' configs · ' + ev.spent.toFixed(2) + ' $ dépensés';
	const stats =
		stat('Runs', String(started.length)) +
		stat('Réussite', passed + '/' + started.length) +
		(tested.length ? stat('Tests passés', percent(tested.reduce((sum, run) => sum + run.acceptance.tests.passed, 0) / tested.reduce((sum, run) => sum + run.acceptance.tests.total, 0))) : '') +
		(infra ? stat('Échecs infra', String(infra)) : '') +
		stat('Coût total', ev.spent.toFixed(2) + ' $') +
		stat('Durée', Math.round(seconds / 60) + ' min');
	return (
		'<section class="panel"><p class="ev-line">' + line + '</p><dl class="stat-grid">' + stats + '</dl></section>' +
		'<section class="panel"><h3>Comparaison</h3><div class="ev-scroll">' + renderComparison(ev) + '</div></section>' +
		renderEdits(ev, patches) +
		'<section class="panel"><h3>Runs</h3><div class="ev-scroll">' + renderRuns(ev) + '</div></section>'
	);
}

const VERDICT = {
	better: ['mieux', 'positive'],
	worse: ['moins bien', 'negative'],
	same: ['pareil', 'neutral'],
	borderline: ['indécis', 'warning']
};

/** The "Fichiers surveillés" panel, from eval-runner/out/watch/state.json: the last measure of each watched file. */
export function renderWatch(state) {
	const entries = Object.entries(state ?? {});
	if (!entries.length) return '';
	const rows = entries.map(([name, saved]) => {
		const [label, tone] = saved.verdict ? (VERDICT[saved.verdict] ?? [saved.verdict, 'neutral']) : ['copie seule', 'neutral'];
		const id = saved.evalDir ? String(saved.evalDir).split('/').filter(Boolean).at(-1) : '';
		const link = id ? '<a href="#evals/' + esc(id) + '">→ mesure</a>' : '';
		const day = saved.at ? new Date(saved.at).toLocaleDateString('fr-FR') : '—';
		return '<tr><td>' + esc(saved.label ?? name) + '</td><td>' + pill(label, tone) + '</td><td>' + esc(day) + '</td><td>' + link + '</td></tr>';
	});
	return '<section class="panel"><h3>Fichiers surveillés</h3><div class="ev-scroll"><table class="ev-table"><thead><tr><th scope="col">Fichier</th><th scope="col">Dernière mesure</th><th scope="col">Date</th><th scope="col"></th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div></section>';
}

/** The path of an eval folder under `evals/`. An id of a campaign eval holds slashes: each segment is encoded, not the slashes. */
export const evalPath = (id) => String(id).split('/').map(encodeURIComponent).join('/');

const CAMPAIGN_STATUS = {
	done: ['terminée', 'positive'],
	interrupted: ['interrompue', 'warning'],
	running: ['en cours', 'info']
};

/** The "Campagnes" panel, from evals/campaigns/index.json. */
export function renderCampaignList(campaigns) {
	if (!campaigns?.length) return '';
	const rows = campaigns.map((item) => {
		const [label, tone] = CAMPAIGN_STATUS[item.status] ?? [item.status, 'neutral'];
		const day = new Date(item.generatedAt).toLocaleDateString('fr-FR');
		return (
			'<tr><td>' + esc(item.name) + '</td><td>' + pill(label, tone) + '</td><td>' + esc(day) + '</td><td>' + item.specs.length + ' specs × ' + item.configs.length + ' configs</td><td>' + item.runs + ' runs</td><td>' + Number(item.cost).toFixed(2) + ' $</td>' +
			'<td><a href="#evals/campaigns/' + esc(encodeURIComponent(item.id)) + '">→ campagne</a></td></tr>'
		);
	});
	return '<section class="panel"><h3>Campagnes</h3><div class="ev-scroll"><table class="ev-table"><thead><tr><th scope="col">Campagne</th><th scope="col">Statut</th><th scope="col">Date</th><th scope="col">Plan</th><th scope="col">Runs</th><th scope="col">Coût</th><th scope="col"></th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div></section>';
}

const sign = (value) => (value < 0 ? '−' : '+');
const points = (value) => sign(value) + Math.round(Math.abs(value) * 100) + ' pts';
const dollars = (value) => sign(value) + Math.abs(value).toFixed(2) + ' $';
// An interval that leaves 0 gives a tone. `lowIsGood`: a drop is the better result (the cost).
const toneOf = ([low, high], lowIsGood) => (low > 0 ? (lowIsGood ? 'negative' : 'positive') : high < 0 ? (lowIsGood ? 'positive' : 'negative') : 'neutral');

// One cell of the campaign table: the pass rate difference and the cost difference, each with its interval.
function campaignCell(cell) {
	if (!cell) return '<td>—</td>';
	const pass = cell.pass;
	let html = pill(points(pass.diff), toneOf(pass.ci, false)) + ' <span class="ev-range">[' + points(pass.ci[0]).replace(' pts', '') + ', ' + points(pass.ci[1]).replace(' pts', '') + ']</span>';
	const cost = cell.metrics?.cost;
	if (cost) html += '<br>' + pill(dollars(cost.diff), toneOf(cost.ci, true)) + ' <span class="ev-range">[' + dollars(cost.ci[0]).replace(' $', '') + ', ' + dollars(cost.ci[1]).replace(' $', '') + ']</span>';
	html += '<br><span class="ev-range">' + pass.config.passed + '/' + pass.config.n + ' contre ' + pass.reference.passed + '/' + pass.reference.n + '</span>';
	return '<td>' + html + '</td>';
}

/** The view of one campaign: a row per config, a column per spec and a pooled column. Each cell is the difference to the
 * reference with its 95 % interval. A spec heading links to the eval view of that spec. */
export function renderCampaign(campaign) {
	const statuses = {};
	for (const result of campaign.results ?? []) statuses[result.status] = (statuses[result.status] ?? 0) + 1;
	const counts = Object.entries(statuses).map(([name, count]) => count + ' ' + name).join(', ');
	const line = esc(campaign.name) + ' · réf. ' + esc(campaign.reference) + ' · ' + (campaign.results?.length ?? 0) + ' runs (' + esc(counts) + ') · ' + Number(campaign.spent ?? 0).toFixed(2) + ' $ dépensés';
	const intro = '<section class="panel"><p class="ev-line">' + line + '</p></section>';
	const report = campaign.report;
	if (!report?.configs?.length) return intro + '<section class="panel"><p class="wsum">Pas de rapport : aucun run terminé pour comparer.</p></section>';
	const specs = campaign.specs ?? [];
	const head =
		'<tr><th scope="col">Config</th>' +
		specs.map((spec) => '<th scope="col"><a href="#evals/campaigns/' + esc(encodeURIComponent(campaign.id)) + '/' + esc(encodeURIComponent(spec.name)) + '">' + esc(spec.name) + '</a></th>').join('') +
		'<th scope="col">Cumul</th></tr>';
	const rows = report.configs.map((config) => '<tr><th scope="row">' + esc(config.name) + '</th>' + specs.map((spec) => campaignCell(config.perSpec[spec.name])).join('') + campaignCell(config.pooled) + '</tr>');
	const note = 'Écart au regard de la config de référence (' + esc(report.reference) + '), intervalle à 95 % par rééchantillonnage (' + report.resamples + ' tirages). Taux de réussite en points, coût médian en dollars.';
	return intro + '<section class="panel"><h3>Comparaison à la référence</h3><div class="ev-scroll"><table class="ev-table"><thead>' + head + '</thead><tbody>' + rows.join('') + '</tbody></table></div><p class="ev-legend">' + note + '</p></section>';
}
