import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export const THINKING_TOKEN: Record<string, ThemeColor> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

export const THINKING_EMOJI: Record<string, string> = {
	off: "💤",
	minimal: "🔹",
	low: "🧊",
	medium: "⚡",
	high: "🧠",
	xhigh: "🔥",
	max: "🌋",
};

export function formatResetTime(iso?: string): string {
	if (!iso) return "?";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "?";
	return `${d.getDate()}.${d.getMonth() + 1}. ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatEpochResetTime(ms?: number): string {
	return formatResetTime(
		typeof ms === "number" ? new Date(ms).toISOString() : undefined,
	);
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCost(cost: number): string {
	if (cost === 0) return "0.000";
	if (cost < 0.01) return cost.toFixed(4);
	if (cost < 1) return cost.toFixed(3);
	return cost.toFixed(2);
}

export function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const rCwd = resolve(cwd);
	const rHome = resolve(home);
	if (rCwd === rHome) return "~";
	if (rCwd.startsWith(rHome + sep))
		return `~${sep}${rCwd.slice(rHome.length + 1)}`;
	return cwd;
}

export function isAutoCompactEnabled(cwd: string): boolean {
	const files = [
		join(homedir(), ".pi", "agent", "settings.json"),
		join(cwd, ".pi", "settings.json"),
	];
	let enabled = true;
	for (const f of files) {
		try {
			if (!existsSync(f)) continue;
			const s = JSON.parse(readFileSync(f, "utf8"));
			if (s?.compaction && typeof s.compaction.enabled === "boolean")
				enabled = s.compaction.enabled;
		} catch {
			/* ignore malformed settings */
		}
	}
	return enabled;
}

export function contextBar(percent: number | null, width = 10): string {
	if (percent === null) return "░".repeat(width);
	const filled = Math.round((Math.min(percent, 100) / 100) * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}
