// Statistics for a campaign: exact Fisher test, stratified permutation test, stratified bootstrap, power by simulation.
// No dependency. Every random draw comes from a seeded generator, so the same input gives the same output.

// A small, fast generator with a 32-bit state. The seed makes the draws repeatable.
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const logFactorials: number[] = [0];
function logFactorial(n: number): number {
	for (let k = logFactorials.length; k <= n; k++) logFactorials.push(logFactorials[k - 1] + Math.log(k));
	return logFactorials[n];
}
const logChoose = (n: number, k: number) => logFactorial(n) - logFactorial(k) - logFactorial(n - k);

// Fisher exact test of the 2x2 table [[a, b], [c, d]], two-sided. The margins stay fixed, and the count `a` follows the
// hypergeometric law. The p-value adds the probability of every table that is not more likely than the observed one.
// A relative tolerance keeps tables with an equal probability in the sum despite the rounding of the logarithms.
export function fisherExact(a: number, b: number, c: number, d: number): number {
	const row = a + b;
	const column = a + c;
	const total = a + b + c + d;
	if (total === 0) return 1;
	const low = Math.max(0, row + column - total);
	const high = Math.min(row, column);
	const probability = (x: number) => Math.exp(logChoose(column, x) + logChoose(total - column, row - x) - logChoose(total, row));
	const observed = probability(a);
	let p = 0;
	for (let x = low; x <= high; x++) {
		const here = probability(x);
		if (here <= observed * (1 + 1e-7)) p += here;
	}
	return Math.min(1, p);
}

// One stratum is the data of one spec: the values of the config (a) and of the reference (b).
export type Stratum = { a: number[]; b: number[] };
export type Stat = 'mean' | 'median';
export type Draws = { stat: Stat; resamples: number; seed: number };

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
function median(values: number[]) {
	const sorted = [...values].sort((x, y) => x - y);
	const middle = sorted.length >> 1;
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// The difference a minus b, by stratum, then the weighted average. The weight of a stratum is na * nb / (na + nb): a
// stratum with more runs counts more. With equal sizes it is the plain average. A stratum with an empty arm has no
// difference and drops out. Undefined when no stratum is left.
export function effect(strata: Stratum[], stat: Stat): number | undefined {
	const summary = stat === 'mean' ? mean : median;
	let weighted = 0;
	let weights = 0;
	for (const { a, b } of strata) {
		if (a.length === 0 || b.length === 0) continue;
		const weight = (a.length * b.length) / (a.length + b.length);
		weighted += weight * (summary(a) - summary(b));
		weights += weight;
	}
	return weights === 0 ? undefined : weighted / weights;
}

function shuffle<T>(items: T[], rand: () => number): T[] {
	const copy = [...items];
	for (let index = copy.length - 1; index > 0; index--) {
		const other = Math.floor(rand() * (index + 1));
		[copy[index], copy[other]] = [copy[other], copy[index]];
	}
	return copy;
}

// Shuffles the config labels inside each stratum. A value never leaves its stratum.
export function permuteStrata(strata: Stratum[], rand: () => number): Stratum[] {
	return strata.map(({ a, b }) => {
		const pool = shuffle([...a, ...b], rand);
		return { a: pool.slice(0, a.length), b: pool.slice(a.length) };
	});
}

// Draws with replacement inside each arm of each stratum.
export function resampleStrata(strata: Stratum[], rand: () => number): Stratum[] {
	const draw = (values: number[]) => values.map(() => values[Math.floor(rand() * values.length)]);
	return strata.map(({ a, b }) => ({ a: draw(a), b: draw(b) }));
}

// Two-sided. The p-value is the share of shuffles whose absolute difference reaches the observed one, and the observed
// arrangement counts as one shuffle, so p is never 0. A small tolerance absorbs the rounding of the averages.
export function permutationTest(strata: Stratum[], { stat, resamples, seed }: Draws): { diff: number; p: number } {
	const diff = effect(strata, stat);
	if (diff === undefined) return { diff: NaN, p: NaN };
	const rand = mulberry32(seed);
	let reached = 0;
	for (let round = 0; round < resamples; round++) {
		const shuffled = effect(permuteStrata(strata, rand), stat)!;
		if (Math.abs(shuffled) >= Math.abs(diff) - 1e-9) reached += 1;
	}
	return { diff, p: (reached + 1) / (resamples + 1) };
}

// Percentile bootstrap. The interval always holds the point estimate: with a handful of runs the percentiles can miss it.
export function bootstrapCI(strata: Stratum[], { stat, resamples, seed }: Draws, level = 0.95): { diff: number; low: number; high: number } {
	const diff = effect(strata, stat);
	if (diff === undefined) return { diff: NaN, low: NaN, high: NaN };
	const rand = mulberry32(seed);
	const draws: number[] = [];
	for (let round = 0; round < resamples; round++) draws.push(effect(resampleStrata(strata, rand), stat)!);
	draws.sort((x, y) => x - y);
	const at = (share: number) => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(share * draws.length)))];
	return { diff, low: Math.min(diff, at((1 - level) / 2)), high: Math.max(diff, at(1 - (1 - level) / 2)) };
}

export type PowerOptions = { alpha?: number; power?: number; simulations?: number; maxRuns?: number; seed: number };

// The runs per config that give the wanted power (default 80 %) at the level alpha (default 0.05) for a Fisher test, if
// the true rates are p1 and p2. By simulation: for each n from 2 up, draw `simulations` pairs of binomial counts with a
// generator seeded from the seed and n, and count the pairs where Fisher gives p below alpha. The first n that reaches
// the power wins. Undefined when the rates are equal, or when no n up to `maxRuns` reaches the power.
export function powerRuns(p1: number, p2: number, { alpha = 0.05, power = 0.8, simulations = 2000, maxRuns = 200, seed }: PowerOptions): number | undefined {
	if (p1 === p2) return undefined;
	const memo = new Map<number, number>();
	const pValue = (n: number, x: number, y: number) => {
		const key = (n * 1000 + x) * 1000 + y;
		let p = memo.get(key);
		if (p === undefined) memo.set(key, (p = fisherExact(x, n - x, y, n - y)));
		return p;
	};
	for (let n = 2; n <= maxRuns; n++) {
		const rand = mulberry32(seed + n * 7919);
		let hits = 0;
		for (let round = 0; round < simulations; round++) {
			let x = 0;
			let y = 0;
			for (let run = 0; run < n; run++) {
				if (rand() < p1) x += 1;
				if (rand() < p2) y += 1;
			}
			if (pValue(n, x, y) < alpha) hits += 1;
		}
		if (hits / simulations >= power) return n;
	}
	return undefined;
}
