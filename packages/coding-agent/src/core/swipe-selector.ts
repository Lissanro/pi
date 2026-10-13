/**
 * Swipe selector parsing shared by /swipe list/search, /edit swipe,
 * /delete swipe, and /restore swipe.
 *
 * A selector is a comma-separated list of tokens:
 * - integer: that 1-based index (`3` = the third item);
 * - range `a-b`: every index from a to b inclusive (`3-8`, also `8-3`);
 * - `-N`: the last N items (`-2` = the last two).
 *
 * Indices are resolved against a list of `count` items and returned as
 * sorted unique 1-based indices. Throws on malformed tokens and on indices
 * outside 1..count.
 */
export function parseSwipeSelector(spec: string, count: number): number[] {
	const indices = new Set<number>();
	const tokens = spec
		.split(",")
		.map((token) => token.trim())
		.filter((token) => token !== "");
	if (tokens.length === 0) {
		throw new Error("Empty swipe selector");
	}
	for (const token of tokens) {
		const lastN = /^-(\d+)$/.exec(token);
		if (lastN) {
			const n = Number.parseInt(lastN[1], 10);
			if (n < 1 || n > count) {
				throw new Error(`Swipe selector -${n} is out of range (have ${count})`);
			}
			for (let i = count - n + 1; i <= count; i++) {
				indices.add(i);
			}
			continue;
		}
		const range = /^(\d+)-(\d+)$/.exec(token);
		if (range) {
			let a = Number.parseInt(range[1], 10);
			let b = Number.parseInt(range[2], 10);
			if (a < 1 || a > count || b < 1 || b > count) {
				throw new Error(`Swipe range ${token} is out of range (have ${count})`);
			}
			if (a > b) {
				const tmp = a;
				a = b;
				b = tmp;
			}
			for (let i = a; i <= b; i++) {
				indices.add(i);
			}
			continue;
		}
		if (/^\d+$/.test(token)) {
			const index = Number.parseInt(token, 10);
			if (index < 1 || index > count) {
				throw new Error(`Swipe ${index} is out of range (have ${count})`);
			}
			indices.add(index);
			continue;
		}
		throw new Error(`Invalid swipe selector: ${token}`);
	}
	return [...indices].sort((a, b) => a - b);
}
