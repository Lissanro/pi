/**
 * Sleep(1)-style duration parsing shared by /schedule, /heartbeat, and the
 * time-awareness threshold: whitespace-separated tokens like "30m", "1h 30m",
 * "5.5m"; units s/m/h/d, summed. Returns the total in milliseconds, or
 * undefined when any token is invalid or the total is not positive.
 */
export function parseSleeptimeMs(spec: string): number | undefined {
	let totalMs = 0;
	for (const token of spec.trim().split(/\s+/)) {
		const match = token.match(/^(\d+(?:\.\d+)?)([smhd])$/);
		if (!match) return undefined;
		const value = Number.parseFloat(match[1]);
		const unit = match[2];
		totalMs += value * (unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
	}
	return totalMs > 0 ? totalMs : undefined;
}
