/**
 * Eldritch Footer — installable Pi package.
 *
 * Custom footer/statusline replacing the built-in one:
 *   Line 1: 📁 cwd (~shortened) │ 🌿 git branch │ 🏷️ session ...... (provider) model • thinking
 *   Line 2: 📊 context bar % / window │ 💰 cost │ ⬆️ input ⬇️ output │ 📦 cache (hit%)
 *   Line 3: Kimi quota (týden · 5h okno)           — when provider is kimi-coding
 *           Z.ai/GLM quota (5h okno · týden · hledání) — when provider is zai-coding(-cn)
 *   Line 4: extension statuses (from ctx.ui.setStatus)
 *
 * Quota meters are polled from the providers' internal usage endpoints:
 *   - Kimi:  GET https://api.kimi.com/coding/v1/usages
 *   - Z.ai:  GET {host}/api/monitor/usage/quota/limit   (bigmodel.cn CN / api.z.ai global)
 *
 * Toggle via /footer on|off|status|help.
 * The on/off state persists across /reload and model swaps within a session.
 *
 * Auth keys are read from ~/.pi/agent/auth.json (providers "kimi-coding" and
 * "zai-coding-cn" / "zai-coding"). If a key is missing, that meter is simply absent.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const CONFIG_ENTRY_TYPE = "eldritch-footer-config";

/** Kimi Code quota (subscription usage) — polled from the usages endpoint. */
interface KimiUsageEntry {
	limit?: string;
	used?: string;
	remaining?: string;
	resetTime?: string;
}
interface KimiUsages {
	usage?: KimiUsageEntry;
	limits?: Array<{
		window?: { duration?: number; timeUnit?: string };
		detail?: KimiUsageEntry;
	}>;
}
let kimiUsages: KimiUsages | null = null;

const BASE_QUOTA_TTL_MS = 60_000;
const MAX_QUOTA_TTL_MS = 600_000;

interface ProviderPollState {
	fetchedAt: number;
	inFlight: boolean;
	consecutiveErrors: number;
	lastLatencyMs: number;
	currentTtlMs: number;
}

const kimiPollState: ProviderPollState = {
	fetchedAt: 0,
	inFlight: false,
	consecutiveErrors: 0,
	lastLatencyMs: 0,
	currentTtlMs: BASE_QUOTA_TTL_MS,
};

const zaiPollState: ProviderPollState = {
	fetchedAt: 0,
	inFlight: false,
	consecutiveErrors: 0,
	lastLatencyMs: 0,
	currentTtlMs: BASE_QUOTA_TTL_MS,
};

function computeBackoffTtl(state: ProviderPollState, isExhausted: boolean): number {
	if (state.consecutiveErrors > 0) {
		return Math.min(
			MAX_QUOTA_TTL_MS,
			BASE_QUOTA_TTL_MS * Math.pow(2, Math.min(state.consecutiveErrors, 4)),
		);
	}
	if (isExhausted) {
		return Math.min(MAX_QUOTA_TTL_MS, BASE_QUOTA_TTL_MS * 3);
	}
	if (state.lastLatencyMs > 4000) {
		return Math.min(MAX_QUOTA_TTL_MS, BASE_QUOTA_TTL_MS * 2);
	}
	return BASE_QUOTA_TTL_MS;
}

function readKimiApiKey(): string | undefined {
	try {
		const auth = JSON.parse(
			readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"),
		);
		const entry = auth?.["kimi-coding"];
		// API-key auth stores `key`; OAuth (/login) stores `access` + `expires`.
		// Accept both, but reject an expired OAuth token (pi refreshes it on next
		// model use; the meter simply stays absent until then).
		if (typeof entry?.key === "string" && entry.key.length > 0) return entry.key;
		if (
			typeof entry?.access === "string" &&
			entry.access.length > 0 &&
			(typeof entry.expires !== "number" || entry.expires > Date.now())
		) {
			return entry.access;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function formatResetTime(iso?: string): string {
	if (!iso) return "?";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "?";
	return `${d.getDate()}.${d.getMonth() + 1}. ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatEpochResetTime(ms?: number): string {
	return formatResetTime(
		typeof ms === "number" ? new Date(ms).toISOString() : undefined,
	);
}

/** Z.ai (GLM Coding Plan) quota — polled from the monitor endpoint. */
interface ZaiLimit {
	type: string; // "TOKENS_LIMIT" | "TIME_LIMIT"
	unit?: number; // 3 = hodiny (5h okno), 6 = dny (týden), 5 = měsíc
	number?: number;
	percentage?: number; // 0-100 využito
	usage?: number;
	currentValue?: number;
	remaining?: number;
	nextResetTime?: number; // epoch ms
}
interface ZaiQuota {
	limits?: ZaiLimit[];
	level?: string; // plán (pro, max, ...)
}
let zaiQuota: ZaiQuota | null = null;

function readZaiApiKey(): { key: string; host: string } | undefined {
	try {
		const auth = JSON.parse(
			readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"),
		);
		const key = auth?.["zai-coding-cn"]?.key ?? auth?.["zai-coding"]?.key;
		if (typeof key !== "string" || !key) return undefined;
		let host = "https://api.z.ai";
		try {
			const store = JSON.parse(
				readFileSync(join(homedir(), ".pi", "agent", "models-store.json"), "utf8"),
			);
			const model = (store?.["zai-coding-cn"] ?? store?.["zai-coding"])
				?.models?.[0];
			const baseUrl: string | undefined = model?.baseUrl;
			// odvození hostitele: bigmodel.cn (CN) vs api.z.ai (global)
			if (baseUrl?.includes("bigmodel")) host = "https://open.bigmodel.cn";
		} catch {
			/* models-store optional */
		}
		return { key, host };
	} catch {
		return undefined;
	}
}

type Theme = Parameters<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>[1];
type FooterData = Parameters<
	Parameters<ExtensionContext["ui"]["setFooter"]>[0]
>[2];

const THINKING_TOKEN: Record<string, ThemeColor> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCost(cost: number): string {
	if (cost === 0) return "0.000";
	if (cost < 0.01) return cost.toFixed(4);
	if (cost < 1) return cost.toFixed(3);
	return cost.toFixed(2);
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const rCwd = resolve(cwd);
	const rHome = resolve(home);
	if (rCwd === rHome) return "~";
	if (rCwd.startsWith(rHome + sep))
		return `~${sep}${rCwd.slice(rHome.length + 1)}`;
	return cwd;
}

/** Auto-compaction flag: compaction.enabled in settings (default true). */
function isAutoCompactEnabled(cwd: string): boolean {
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

function contextBar(percent: number | null, width = 10): string {
	if (percent === null) return "░".repeat(width);
	const filled = Math.round((Math.min(percent, 100) / 100) * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Read the latest persisted enabled flag from the session log. Defaults to true. */
function extractEnabled(ctx: ExtensionContext): boolean {
	let latest = true;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (
			entry.type === "custom" &&
			entry.customType === CONFIG_ENTRY_TYPE &&
			entry.data &&
			typeof entry.data === "object"
		) {
			const v = (entry.data as { enabled?: boolean }).enabled;
			if (typeof v === "boolean") latest = v;
		}
	}
	return latest;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let requestRender: (() => void) | undefined;

	const rerender = () => requestRender?.();

	// Re-render when footer-relevant state changes
	pi.on("thinking_level_select", rerender);
	pi.on("model_select", rerender);
	pi.on("turn_end", rerender);
	pi.on("session_compact", rerender);
	pi.on("session_info_changed", rerender);
	// Live updates: redraw on every message/tool boundary so the running
	// session usage & cost stay current DURING a turn, not just after it.
	pi.on("message_start", rerender);
	pi.on("message_end", rerender);
	pi.on("tool_execution_start", rerender);
	pi.on("tool_execution_end", rerender);

	async function refreshKimiQuota(force = false): Promise<void> {
		if (kimiPollState.inFlight) return;
		if (force) {
			kimiPollState.consecutiveErrors = 0;
			kimiPollState.currentTtlMs = BASE_QUOTA_TTL_MS;
		} else if (Date.now() - kimiPollState.fetchedAt < kimiPollState.currentTtlMs) {
			return;
		}
		const key = readKimiApiKey();
		if (!key) return;
		kimiPollState.inFlight = true;
		const t0 = Date.now();
		try {
			const res = await fetch("https://api.kimi.com/coding/v1/usages", {
				headers: { authorization: `Bearer ${key}` },
				signal: AbortSignal.timeout(8000),
			});
			kimiPollState.lastLatencyMs = Date.now() - t0;
			if (res.ok) {
				kimiUsages = (await res.json()) as KimiUsages;
				kimiPollState.fetchedAt = Date.now();
				kimiPollState.consecutiveErrors = 0;
				const used = Number(kimiUsages.usage?.used ?? 0);
				const limit = Number(kimiUsages.usage?.limit ?? 0);
				const isExhausted = limit > 0 && used >= limit;
				kimiPollState.currentTtlMs = computeBackoffTtl(kimiPollState, isExhausted);
				rerender();
			} else {
				kimiPollState.consecutiveErrors++;
				kimiPollState.currentTtlMs = computeBackoffTtl(kimiPollState, false);
			}
		} catch {
			/* network/auth failure: exponential backoff */
			kimiPollState.consecutiveErrors++;
			kimiPollState.lastLatencyMs = Date.now() - t0;
			kimiPollState.currentTtlMs = computeBackoffTtl(kimiPollState, false);
		} finally {
			kimiPollState.inFlight = false;
		}
	}

	pi.on("turn_end", () => void refreshKimiQuota());

	async function refreshZaiQuota(force = false): Promise<void> {
		if (zaiPollState.inFlight) return;
		if (force) {
			zaiPollState.consecutiveErrors = 0;
			zaiPollState.currentTtlMs = BASE_QUOTA_TTL_MS;
		} else if (Date.now() - zaiPollState.fetchedAt < zaiPollState.currentTtlMs) {
			return;
		}
		const creds = readZaiApiKey();
		if (!creds) return;
		zaiPollState.inFlight = true;
		const t0 = Date.now();
		try {
			const res = await fetch(`${creds.host}/api/monitor/usage/quota/limit`, {
				headers: {
					authorization: `Bearer ${creds.key}`,
					accept: "application/json",
				},
				signal: AbortSignal.timeout(8000),
			});
			zaiPollState.lastLatencyMs = Date.now() - t0;
			if (res.ok) {
				const body = (await res.json()) as { data?: ZaiQuota };
				zaiQuota = body?.data ?? null;
				zaiPollState.fetchedAt = Date.now();
				zaiPollState.consecutiveErrors = 0;
				const isExhausted = Boolean(
					zaiQuota?.limits?.some((l) => (l.percentage ?? 0) >= 100),
				);
				zaiPollState.currentTtlMs = computeBackoffTtl(zaiPollState, isExhausted);
				rerender();
			} else {
				zaiPollState.consecutiveErrors++;
				zaiPollState.currentTtlMs = computeBackoffTtl(zaiPollState, false);
			}
		} catch {
			/* network/auth failure: exponential backoff */
			zaiPollState.consecutiveErrors++;
			zaiPollState.lastLatencyMs = Date.now() - t0;
			zaiPollState.currentTtlMs = computeBackoffTtl(zaiPollState, false);
		} finally {
			zaiPollState.inFlight = false;
		}
	}

	pi.on("turn_end", () => void refreshZaiQuota());

	function apply(ctx: ExtensionContext) {
		if (!enabled || ctx.mode !== "tui") {
			ctx.ui.setFooter(undefined);
			return;
		}
		if (ctx.model?.provider === "kimi-coding") void refreshKimiQuota();
		if (
			ctx.model?.provider === "zai-coding-cn" ||
			ctx.model?.provider === "zai-coding"
		)
			void refreshZaiQuota();

		ctx.ui.setFooter((tui, theme: Theme, footerData: FooterData) => {
			requestRender = () => tui.requestRender();
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: () => {
					unsubBranch();
					requestRender = undefined;
				},
				invalidate() {},

				render(width: number): string[] {
					const model = ctx.model;
					const sm = ctx.sessionManager;

					// ---- aggregate usage (mirrors built-in footer semantics) ----
					let input = 0,
						output = 0,
						cacheRead = 0,
						cacheWrite = 0,
						cost = 0;
					let latestCacheHitRate: number | undefined;
					for (const e of sm.getEntries()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const u = (e.message as AssistantMessage).usage;
							input += u.input;
							output += u.output;
							cacheRead += u.cacheRead;
							cacheWrite += u.cacheWrite;
							cost += u.cost?.total ?? 0;
							const prompt = u.input + u.cacheRead + u.cacheWrite;
							latestCacheHitRate =
								prompt > 0 ? (u.cacheRead / prompt) * 100 : undefined;
						} else if (
							e.type === "message" &&
							e.message.role === "toolResult" &&
							e.message.usage
						) {
							const u = e.message.usage;
							input += u.input;
							output += u.output;
							cacheRead += u.cacheRead;
							cacheWrite += u.cacheWrite;
							cost += u.cost?.total ?? 0;
						} else if (
							(e.type === "branch_summary" || e.type === "compaction") &&
							e.usage
						) {
							const u = e.usage;
							input += u.input;
							output += u.output;
							cacheRead += u.cacheRead;
							cacheWrite += u.cacheWrite;
							cost += u.cost?.total ?? 0;
						}
					}

					// ---- context usage ----
					const usage = ctx.getContextUsage();
					const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
					const percentValue = usage?.percent ?? null;
					const isNearCompaction = percentValue !== null && percentValue >= 80;
					const isImminentCompaction =
						percentValue !== null && percentValue >= 90;

					const ctxColor: ThemeColor = isImminentCompaction
						? "error"
						: isNearCompaction
							? "warning"
							: percentValue !== null && percentValue > 60
								? "accent"
								: "success";

					const dim = (s: string) => theme.fg("dim", s);
					const sep = dim(" │ ");

					/** Fit left + right text on one line: pad with gap, else trim left (keeps right whole). */
					const fitLR = (left: string, right: string): string => {
						const lw = visibleWidth(left);
						const rw = visibleWidth(right);
						const gap = 4;
						if (rw >= width)
							return truncateToWidth(right, width, theme.fg("dim", "…"));
						if (lw + gap + rw <= width)
							return left + " ".repeat(width - lw - rw) + right;
						const avail = width - rw - gap;
						if (avail > 16) {
							const tl = truncateToWidth(left, avail, theme.fg("dim", "…"));
							return tl + " ".repeat(width - visibleWidth(tl) - rw) + right;
						}
						return truncateToWidth(left, width, theme.fg("dim", "…"));
					};

					// ---- line A: location (left) + (provider) model • thinking (right) ----
					const locParts = [theme.fg("accent", `📁 ${formatCwd(sm.getCwd())}`)];
					const branch = footerData.getGitBranch();
					if (branch) locParts.push(theme.fg("success", `🌿 ${branch}`));
					const sessionName = sm.getSessionName();
					if (sessionName)
						locParts.push(theme.fg("customMessageLabel", `🏷️ ${sessionName}`));
					const locLeft = locParts.join(sep);

					let right = `${theme.fg("accent", model?.id || "no-model")}`;
					if (model?.reasoning) {
						const level = pi.getThinkingLevel() || "off";
						const token = THINKING_TOKEN[level] ?? "thinkingOff";
						right +=
							dim(" • ") + theme.fg(token, level === "off" ? "thinking off" : level);
					}
					if (model && footerData.getAvailableProviderCount() > 1) {
						right = dim(`(${model.provider}) `) + right;
					}
					const lineA = fitLR(locLeft, right);

					// ---- line BC: context + cost + usage stats (single line) ----
					const barW = Math.max(10, Math.min(22, Math.floor(width * 0.22)));
					const bar = theme.fg(ctxColor, contextBar(percentValue, barW));
					const pct = percentValue === null ? "?" : `${percentValue.toFixed(1)}%`;
					const autoStr = isAutoCompactEnabled(ctx.cwd) ? dim(" (auto)") : "";
					let compactionWarning = "";
					if (isImminentCompaction) {
						compactionWarning = " " + theme.fg("error", "⚠️ [KOMPAKCE BLÍZKO]");
					} else if (isNearCompaction) {
						compactionWarning = " " + theme.fg("warning", "⚡ [80%+ zaplnění]");
					}

					// kimi-coding is subscription-backed
					const usingSubscription = model?.provider === "kimi-coding";

					const statsParts: string[] = [];
					// 📊 context segment
					statsParts.push(
						dim("📊 ") +
							bar +
							" " +
							theme.fg(ctxColor, `${pct}/${formatTokens(contextWindow)}`) +
							autoStr,
					);
					// 💰 cost segment
					statsParts.push(
						theme.fg("warning", `💰 $${formatCost(cost)}`) +
							(usingSubscription ? dim(" (sub)") : ""),
					);
					// ⬆️⬇️ token stats
					statsParts.push(theme.fg("mdLink", `⬆️ ${formatTokens(input)}`));
					statsParts.push(theme.fg("success", `⬇️ ${formatTokens(output)}`));
					// 📦 cache segment
					if (cacheRead || cacheWrite) {
						let cacheStr = `📦 ${formatTokens(cacheRead)}`;
						if (cacheWrite) cacheStr += ` (w:${formatTokens(cacheWrite)})`;
						if (
							(cacheRead > 0 || cacheWrite > 0) &&
							latestCacheHitRate !== undefined
						) {
							cacheStr += ` 🎯${latestCacheHitRate.toFixed(0)}%`;
						}
						statsParts.push(theme.fg("muted", cacheStr));
					}

					const lineStats = truncateToWidth(
						statsParts.join(dim(" │ ")) + compactionWarning,
						width,
						dim("…"),
					);

					const lines = ["", lineA, lineStats];

					// ---- line D: vendor quota meter ----
					let quotaLine: string | undefined;

					// kimi (subscription usage)
					if (model?.provider === "kimi-coding" && kimiUsages?.usage) {
						const quotaColor = (used: number, limit: number): ThemeColor =>
							limit > 0 && (used / limit) * 100 > 90
								? "error"
								: limit > 0 && (used / limit) * 100 > 70
									? "warning"
									: "success";
						const seg = (label: string, e: KimiUsageEntry) => {
							const used = Number(e.used ?? 0);
							const limit = Number(e.limit ?? 0);
							const pct = limit > 0 ? (used / limit) * 100 : null;
							const color = quotaColor(used, limit);
							return (
								dim(`${label} `) +
								theme.fg(color, contextBar(pct)) +
								theme.fg(color, ` ${e.used ?? "?"}/${e.limit ?? "?"}`) +
								dim(` rst ${formatResetTime(e.resetTime)}`)
							);
						};
						const kimiParts = [
							theme.bg("customMessageBg", theme.fg("accent", " kimi ")),
							seg("týden", kimiUsages.usage),
						];
						const win = kimiUsages.limits?.[0]?.detail;
						if (win) kimiParts.push(seg("5h", win));
						quotaLine = truncateToWidth(
							kimiParts.join(dim(" │ ")),
							width,
							theme.fg("dim", "…"),
						);
					}

					// z.ai (GLM Coding Plan)
					const zaiProviders = ["zai-coding-cn", "zai-coding"];
					if (
						!quotaLine &&
						zaiProviders.includes(model?.provider ?? "") &&
						zaiQuota?.limits?.length
					) {
						const pctColor = (pct?: number): ThemeColor =>
							pct === undefined
								? "muted"
								: pct > 90
									? "error"
									: pct > 70
										? "warning"
										: "success";
						const tokensSeg = (label: string, lim: ZaiLimit) => {
							const pct = lim.percentage ?? 0;
							const color = pctColor(pct);
							return (
								dim(`${label} `) +
								theme.fg(color, contextBar(pct)) +
								theme.fg(color, ` ${pct}%`) +
								dim(` rst ${formatEpochResetTime(lim.nextResetTime)}`)
							);
						};
						const zaiLimits = zaiQuota.limits.filter(
							(l) => l.type === "TOKENS_LIMIT",
						);
						// unit=3 (hodiny) = 5h okno, unit=6 (dny) = týden
						const fiveHour = zaiLimits.find((l) => l.unit === 3) ?? zaiLimits[0];
						const weekly = zaiLimits.find((l) => l.unit === 6) ?? zaiLimits[1];
						const zaiParts = [
							theme.bg("customMessageBg", theme.fg("accent", " z.ai ")),
						];
						if (fiveHour) zaiParts.push(tokensSeg("5h okno", fiveHour));
						if (weekly) zaiParts.push(tokensSeg("týden", weekly));
						// měsíční web-search (TIME_LIMIT)
						const search = zaiQuota.limits.find((l) => l.type === "TIME_LIMIT");
						if (search && typeof search.usage === "number") {
							zaiParts.push(
								dim("hledání ") +
									theme.fg("muted", `${search.currentValue ?? 0}/${search.usage}`),
							);
						}
						quotaLine = truncateToWidth(
							zaiParts.join(dim(" │ ")),
							width,
							theme.fg("dim", "…"),
						);
					}
					if (quotaLine) lines.push(quotaLine);

					// ---- line E: translation plugin status (dedicated, unmissable) ----
					// Surfacing the pi-prompt-translate segment (“⇄ lang • think • model • $cost • OR bal”)
					// on its own line instead of burying it in the generic statuses dump below.
					const statuses = footerData.getExtensionStatuses();
					const TRANSLATE_KEY = "prompt-translate-state";
					const clean = (t: string) =>
						t
							.replace(/[\r\n\t]+/g, " ")
							.replace(/ +/g, " ")
							.trim();
					const translate = statuses.get(TRANSLATE_KEY);
					if (translate) {
						lines.push(
							truncateToWidth(clean(translate), width, theme.fg("dim", "…")),
						);
					}

					// ---- remaining extension statuses (anything but translate) ----
					const rest = Array.from(statuses.entries())
						.filter(([k]) => k !== TRANSLATE_KEY)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, t]) => clean(t))
						.filter(Boolean);
					if (rest.length > 0) {
						// greedy fit: přidávej statusy dokud se vejdou, zbytek jako "+N more"
						const sepExt = theme.fg("dim", " │ ");
						let acc = "";
						let used = 0;
						for (const s of rest) {
							const candidate = acc ? acc + sepExt + s : s;
							if (visibleWidth(candidate) <= width) {
								acc = candidate;
								used++;
							} else break;
						}
						if (used === 0) {
							acc = truncateToWidth(rest[0], width, theme.fg("dim", "…"));
							used = 1;
						}
						if (used < rest.length) {
							acc += sepExt + dim(`+${rest.length - used} more`);
							if (visibleWidth(acc) > width)
								acc = truncateToWidth(acc, width, theme.fg("dim", "…"));
						}
						lines.push(acc);
					}

					return lines;
				},
			};
		});
	}

	function statusText(): string {
		const kimi = readKimiApiKey() ? "key" : "no-key";
		const zai = readZaiApiKey() ? "key" : "no-key";
		return `eldritch-footer: ${enabled ? "on" : "off"} · kimi ${kimi} · z.ai ${zai}`;
	}

	function setEnabled(ctx: ExtensionContext, value: boolean) {
		enabled = value;
		pi.appendEntry(CONFIG_ENTRY_TYPE, { enabled });
		apply(ctx);
		ctx.ui.notify(
			enabled ? "Eldritch footer enabled" : "Default footer restored",
			"info",
		);
	}

	pi.on("session_start", async (_event, ctx) => {
		enabled = extractEnabled(ctx);
		apply(ctx);
	});

	const FOOTER_DOCS: Record<string, string> = {
		on: "zapne vlastní statusline / footer",
		off: "vypne vlastní statusline a vrátí výchozí footer",
		toggle: "přepne footer (zapnuto / vypnuto)",
		status: "zobrazí aktuální stav a přehled kvót",
		refresh: "vynutí okamžitou aktualizaci kvót Kimi a Z.ai",
		help: "zobrazí podrobnou nápovědu",
	};

	pi.registerCommand("footer", {
		description:
			"eldritch-footer: custom statusline s kvótami Kimi/Z.ai, kontextovým pruhem a barvami thinkingu",
		getArgumentCompletions: (prefix: string) => {
			const tokens = prefix.split(/\s+/).filter(Boolean);
			const typed = tokens[0] ?? "";
			const SUBS: Array<[string, string]> = Object.entries(FOOTER_DOCS);
			const items = SUBS.filter(([s]) => s.startsWith(typed.toLowerCase())).map(
				([value, description]) => ({ value, label: value, description }),
			);
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [subRaw] = args.trim().split(/\s+/).filter(Boolean);
			const sub = subRaw?.toLowerCase();
			if (sub === "status") {
				ctx.ui.notify(statusText(), "info");
				return;
			}
			if (!sub || sub === "help") {
				const kimi = readKimiApiKey() ? "nastaven (API klíč / OAuth)" : "nenalezen";
				const zai = readZaiApiKey() ? "nastaven (API klíč)" : "nenalezen";
				ctx.ui.notify(
					[
						`eldritch-footer — stav: ${enabled ? "ZAPNUTO (ON)" : "VYPNUTO (OFF)"}`,
						"Vlastní víceřádkový footer / statusline s měřiči kvót Kimi / Z.ai, pruhem kontextu a barvami thinkingu.",
						"",
						"Příkazy:",
						"/footer             — tato nápověda + stav",
						"/footer on          — zapne vlastní statusline",
						"/footer off         — vypne vlastní statusline (vrátí default footer)",
						"/footer toggle      — přepne stav zapnuto/vypnuto",
						"/footer refresh     — okamžitě znovu načte kvóty Kimi a Z.ai",
						"/footer status      — zobrazí jednořádkový stav",
						"",
						`Kimi kvóta API klíč: ${kimi}`,
						`Z.ai kvóta API klíč: ${zai}`,
						`Auto-compaction detekce: ${isAutoCompactEnabled(ctx.cwd) ? "aktivní" : "vypnuto"}`,
						"Stav se ukládá do session — přežije /reload i restart.",
					].join("\n"),
					"info",
				);
				return;
			}
			if (sub === "on" || sub === "enable") {
				setEnabled(ctx, true);
				return;
			}
			if (sub === "off" || sub === "disable") {
				setEnabled(ctx, false);
				return;
			}
			if (sub === "toggle") {
				setEnabled(ctx, !enabled);
				return;
			}
			if (sub === "refresh") {
				void refreshKimiQuota(true);
				void refreshZaiQuota(true);
				ctx.ui.notify("Eldritch footer: kvóty obnoveny", "info");
				return;
			}
			ctx.ui.notify(
				"Neznámý příkaz. Použijte: /footer [on|off|toggle|status|refresh|help]",
				"warning",
			);
		},
	});
}
