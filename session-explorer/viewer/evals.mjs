// Render functions of the "Évaluations" view. Pure: they return HTML strings, so Node tests cover them.
// Every string that comes from a spec or a run goes through esc().
import { esc } from './adapt.mjs';
import { pill, stat } from './ui.mjs';

// [key, label, format, better]. better: 'low', 'high' or null (no best mark).
const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 1e5 ? 0 : 1) + 'k' : String(Math.round(n)));
const dec = (n) => String(Math.round(n * 100) / 100);
const ROWS = [
	['cost', 'Coût ($)', (n) => n.toFixed(2), 'low'],
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
	['lines', 'Lignes modifiées', (n) => String(Math.round(n)), null],
	['cacheReadShare', 'Lecture cache', (n) => Math.round(n * 100) + ' %', 'high']
];
const STATUS = {
	ok: ['ok', 'positive'],
	timeout: ['délai dépassé', 'warning'],
	budget: ['budget', 'warning'],
	error: ['erreur', 'negative'],
	skipped: ['ignoré', 'neutral']
};
const format = (key) => ROWS.find(([name]) => name === key)[2];

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
	const head = '<tr><th scope="col">Métrique</th>' + ev.configs.map((config) => '<th scope="col">' + esc(config.name) + '</th>').join('') + '</tr>';
	const pass = '<tr><th scope="row">Réussite</th>' + ev.configs.map((config) => '<td>' + passPill(config.pass) + '</td>').join('') + '</tr>';
	const rows = ROWS.flatMap(([key, label, , better]) => {
		const all = ev.configs.flatMap((config) => config.metrics[key]?.values ?? []);
		// A row where every run has 0 says nothing. Print and refusal counters stay at 0 in print mode.
		if (all.length === 0 || all.every((value) => value === 0)) return [];
		const scale = { min: Math.min(...all), max: Math.max(...all) };
		const best = bestConfigs(ev.configs, key, better);
		const cells = ev.configs.map((config, index) => (config.metrics[key] ? metricCell(config.metrics[key], key, scale, best.has(index)) : '<td>—</td>'));
		return ['<tr><th scope="row">' + esc(label) + '</th>' + cells.join('') + '</tr>'];
	});
	return '<table class="ev-table"><thead>' + head + '</thead><tbody>' + pass + rows.join('') + '</tbody></table>';
}

/** The "Runs" panel: one row per planned run. */
export function renderRuns(ev) {
	const head = '<tr><th scope="col">Run</th><th scope="col">Config</th><th scope="col">Statut</th><th scope="col">Vérif</th><th scope="col">Coût</th><th scope="col">Durée</th><th scope="col">Diff</th><th scope="col"></th></tr>';
	const rows = ev.runs.map((run) => {
		const [label, tone] = STATUS[run.status] ?? [run.status, 'neutral'];
		const check = run.acceptance ? (run.acceptance.passed ? pill('passe', 'positive') : pill('échec', 'negative')) : '—';
		const cost = run.metrics ? run.metrics.cost.toFixed(2) + ' $' : '—';
		const wall = run.wallSec === undefined ? '—' : Math.round(run.wallSec) + ' s';
		const diff = run.diff ? '+' + run.diff.added + '−' + run.diff.deleted : '—';
		const link = run.sessionId && run.status !== 'skipped' ? '<a href="#' + esc(run.sessionId) + '">→ session</a>' : '';
		return '<tr><td>' + esc(run.id) + '</td><td>' + esc(run.config) + '</td><td>' + pill(label, tone) + '</td><td>' + check + '</td><td>' + cost + '</td><td>' + wall + '</td><td>' + diff + '</td><td>' + link + '</td></tr>';
	});
	return '<table class="ev-table ev-runs"><thead>' + head + '</thead><tbody>' + rows.join('') + '</tbody></table>';
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

/** The whole view for one eval: header panel, comparison panel, runs panel. */
export function renderEval(ev) {
	const started = ev.runs.filter((run) => run.status !== 'skipped');
	const passed = started.filter((run) => run.acceptance?.passed).length;
	const seconds = started.reduce((total, run) => total + (run.wallSec ?? 0), 0);
	const repo = String(ev.spec?.task?.repo ?? '').split('/').filter(Boolean).at(-1) ?? '';
	const line = esc(ev.name) + ' · ' + esc(repo) + '@' + esc(String(ev.baseSha).slice(0, 7)) + ' · ' + started.length + ' runs × ' + ev.configs.length + ' configs · ' + ev.spent.toFixed(2) + ' $ dépensés';
	const stats =
		stat('Runs', String(started.length)) +
		stat('Réussite', passed + '/' + started.length) +
		stat('Coût total', ev.spent.toFixed(2) + ' $') +
		stat('Durée', Math.round(seconds / 60) + ' min');
	return (
		'<section class="panel"><p class="ev-line">' + line + '</p><dl class="stat-grid">' + stats + '</dl></section>' +
		'<section class="panel"><h3>Comparaison</h3><div class="ev-scroll">' + renderComparison(ev) + '</div></section>' +
		'<section class="panel"><h3>Runs</h3><div class="ev-scroll">' + renderRuns(ev) + '</div></section>'
	);
}
