/**
 * Eldritch Footer — installable Pi package.
 *
 * Custom footer/statusline replacing the built-in one:
 *   Line 1: 📁 cwd (~shortened) │ 🌿 branch ●dirty/○clean ▸ahead │ 🏷️ session
 *   Line 2: 📊 context bar % / window │ 💰 cost │ ⬆️ input ⬇️ output │ 📦 cache (hit%) │ (provider) model • thinking
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
import {
	truncateToWidth,
	visibleWidth,
	type AutocompleteItem,
} from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const CONFIG_ENTRY_TYPE = "eldritch-footer-config";

export type FooterPreset = "minimal" | "compact" | "full";

export interface FooterConfig {
	enabled: boolean;
	preset: FooterPreset;
}

const GLOBAL_CONFIG_PATH = join(
	homedir(),
	".pi",
	"agent",
	"eldritch-footer.json",
);

const DEFAULT_CONFIG: FooterConfig = {
	enabled: true,
	preset: "compact",
};

let currentConfig: FooterConfig = { ...DEFAULT_CONFIG };

function loadGlobalConfig(): Partial<FooterConfig> {
	try {
		if (existsSync(GLOBAL_CONFIG_PATH)) {
			return JSON.parse(
				readFileSync(GLOBAL_CONFIG_PATH, "utf8"),
			) as Partial<FooterConfig>;
		}
	} catch {
		/* ignore */
	}
	return {};
}

function saveGlobalConfig(config: FooterConfig): void {
	try {
		mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
		writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
	} catch {
		/* ignore */
	}
}

function clearGlobalConfig(): void {
	try {
		if (existsSync(GLOBAL_CONFIG_PATH)) {
			writeFileSync(
				GLOBAL_CONFIG_PATH,
				JSON.stringify(DEFAULT_CONFIG, null, 2),
				"utf8",
			);
		}
	} catch {
		/* ignore */
	}
}

function extractConfig(ctx: ExtensionContext): FooterConfig {
	const globalCfg = loadGlobalConfig();
	let sessionCfg: Partial<FooterConfig> | null = null;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (
			entry.type === "custom" &&
			entry.customType === CONFIG_ENTRY_TYPE &&
			entry.data &&
			typeof entry.data === "object"
		) {
			sessionCfg = entry.data as Partial<FooterConfig>;
		}
	}
	return {
		enabled:
			typeof sessionCfg?.enabled === "boolean"
				? sessionCfg.enabled
				: typeof globalCfg.enabled === "boolean"
					? globalCfg.enabled
					: DEFAULT_CONFIG.enabled,
		preset:
			sessionCfg?.preset &&
			["minimal", "compact", "full"].includes(sessionCfg.preset)
				? sessionCfg.preset
				: globalCfg.preset &&
						["minimal", "compact", "full"].includes(globalCfg.preset)
					? globalCfg.preset
					: DEFAULT_CONFIG.preset,
	};
}

/** Git status cache — refreshed on turn_end and branch change. */
interface GitStatus {
	dirty: boolean;
	ahead: number;
	behind: number;
}
let cachedGitStatus: GitStatus = { dirty: false, ahead: 0, behind: 0 };

function refreshGitStatus(cwd: string): void {
	try {
		const s = execSync("git status --porcelain=v1 --branch", {
			cwd,
			timeout: 2000,
			stdio: ["pipe", "pipe", "pipe"],
		}).toString();
		const first = s.split("\n")[0] ?? "";
		const dirty = s
			.split("\n")
			.slice(1)
			.some((l) => l.length > 0);
		const aheadMatch = first.match(/\+(\d+)/);
		const behindMatch = first.match(/-(\d+)/);
		cachedGitStatus = {
			dirty,
			ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
			behind: behindMatch ? Number(behindMatch[1]) : 0,
		};
	} catch {
		cachedGitStatus = { dirty: false, ahead: 0, behind: 0 };
	}
}

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

function computeBackoffTtl(
	state: ProviderPollState,
	isExhausted: boolean,
): number {
	if (state.consecutiveErrors > 0) {
		return Math.min(
			MAX_QUOTA_TTL_MS,
			BASE_QUOTA_TTL_MS * 2 ** Math.min(state.consecutiveErrors, 4),
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

const THINKING_EMOJI: Record<string, string> = {
	off: "💤",
	minimal: "🔹",
	low: "🧊",
	medium: "⚡",
	high: "🧠",
	xhigh: "🔥",
	max: "🌋",
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

export default function (pi: ExtensionAPI) {
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
		} else if (
			Date.now() - kimiPollState.fetchedAt <
			kimiPollState.currentTtlMs
		) {
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

	// Refresh git status cache on every turn and on branch changes
	pi.on("turn_end", (_event, ctx) => refreshGitStatus(ctx.cwd));

	function apply(ctx: ExtensionContext) {
		if (!currentConfig.enabled || ctx.mode !== "tui") {
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
			(globalThis as any).__pi_footer_data = footerData;
			requestRender = () => tui.requestRender();
			const unsubBranch = footerData.onBranchChange(() => {
				refreshGitStatus(ctx.cwd);
				tui.requestRender();
			});

			return {
				dispose: () => {
					unsubBranch();
					requestRender = undefined;
				},
				invalidate() {},

				render(width: number): string[] {
					const model = ctx.model;
					const sm = ctx.sessionManager;

					// ---- aggregate usage ----
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
					const isImminentCompaction = percentValue !== null && percentValue >= 90;

					const ctxColor: ThemeColor = isImminentCompaction
						? "error"
						: isNearCompaction
							? "warning"
							: percentValue !== null && percentValue > 60
								? "accent"
								: "success";

					const dim = (s: string) => theme.fg("dim", s);
					const sep = dim(" │ ");

					/** Fit left + right text on one line */
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

					const statuses = footerData.getExtensionStatuses() as Map<string, string>;
					const clean = (t: string) =>
						t
							.replace(/[\r\n\t]+/g, " ")
							.replace(/ +/g, " ")
							.trim();

					// -------------------------------------------------------------
					// Preset 1: "minimal" (1 single line with full path, git & essential data)
					// -------------------------------------------------------------
					if (currentConfig.preset === "minimal") {
						// Left side: full path + git branch & status
						const loc = formatCwd(sm.getCwd());
						const branch = footerData.getGitBranch();
						let locStr = `📁 ${loc}`;
						if (branch) {
							const gs = cachedGitStatus;
							const dirtyIcon = gs.dirty ? "●" : "○";
							const dirtyColor: ThemeColor = gs.dirty ? "warning" : "success";
							locStr += ` 🌿 ${branch} ${theme.fg(dirtyColor, dirtyIcon)}`;
							if (gs.ahead > 0) locStr += dim(` ▸${gs.ahead}`);
							if (gs.behind > 0) locStr += dim(` ◂${gs.behind}`);
						}
						const left = theme.fg("muted", locStr);

						// Right side: context meter, model, subagents, SPAI, ADR, active LSP
						const rightParts: string[] = [];

						// 1. Context meter & progress bar
						const barW = Math.max(6, Math.min(8, Math.floor(width * 0.08)));
						const bar = theme.fg(ctxColor, contextBar(percentValue, barW));
						const pct = percentValue === null ? "?" : `${percentValue.toFixed(0)}%`;
						rightParts.push(
							dim("📊 ") +
								bar +
								" " +
								theme.fg(ctxColor, `${pct}/${formatTokens(contextWindow)}`),
						);

						// 2. Active model & thinking
						let modelStr = theme.fg("accent", model?.id || "no-model");
						if (model?.reasoning) {
							const level = pi.getThinkingLevel() || "off";
							const emoji = THINKING_EMOJI[level] ?? "🧠";
							const token = THINKING_TOKEN[level] ?? "thinkingOff";
							modelStr +=
								dim(` • ${emoji} `) + theme.fg(token, level === "off" ? "off" : level);
						}
						if (model && footerData.getAvailableProviderCount() > 1) {
							modelStr = dim(`(${model.provider}) `) + modelStr;
						}
						rightParts.push(modelStr);

						// 3. Subagent activity (if active)
						const subagentKey = [
							"pi-subagents",
							"subagent",
							"fusion",
							"apple-rada",
							"pi-council",
						].find((k) => statuses.has(k) && Boolean(statuses.get(k)));
						const rawSubagent = subagentKey ? statuses.get(subagentKey) : undefined;
						if (rawSubagent) {
							rightParts.push(theme.fg("accent", `🤖 ${clean(rawSubagent)}`));
						}

						// 4. SPAI task ledger
						const spai = statuses.get("pi-spai");
						if (spai) {
							rightParts.push(clean(spai));
						}

						// 5. ADR doctrine
						const adr = statuses.get("pi-solo-radar");
						if (adr) {
							rightParts.push(clean(adr));
						}

						// 6. LSP (auto-shows when active and not "LSP Inactive")
						const lspKey = ["lsp", "pi-lsp", "lotusscript_lsp"].find(
							(k) => statuses.has(k) && Boolean(statuses.get(k)),
						);
						const rawLsp = lspKey ? statuses.get(lspKey) : undefined;
						if (rawLsp) {
							const lspVal = clean(rawLsp);
							if (!/inactive/i.test(lspVal)) {
								rightParts.push(lspVal);
							}
						}

						const right = rightParts.join(sep);
						const singleLine = fitLR(left, right);
						return ["", singleLine];
					}

					// -------------------------------------------------------------
					// Preset 2: "compact" (2 balanced lines)
					// -------------------------------------------------------------
					if (currentConfig.preset === "compact") {
						// Line 1: location + git + model + thinking
						const locParts = [theme.fg("muted", `📁 ${formatCwd(sm.getCwd())}`)];
						const branch = footerData.getGitBranch();
						if (branch) {
							const gs = cachedGitStatus;
							const dirtyIcon = gs.dirty ? "●" : "○";
							const dirtyColor: ThemeColor = gs.dirty ? "warning" : "success";
							const dirtyLabel = gs.dirty ? "dirty" : "clean";
							let branchStr = `🌿 ${branch} ${theme.fg(dirtyColor, `${dirtyIcon} ${dim(dirtyLabel)}`)}`;
							if (gs.ahead > 0) branchStr += dim(` ▸${gs.ahead}`);
							if (gs.behind > 0) branchStr += dim(` ◂${gs.behind}`);
							locParts.push(theme.fg("success", branchStr));
						}
						const left1 = locParts.join(sep);

						let modelStr = theme.fg("accent", model?.id || "no-model");
						if (model?.reasoning) {
							const level = pi.getThinkingLevel() || "off";
							const emoji = THINKING_EMOJI[level] ?? "🧠";
							const token = THINKING_TOKEN[level] ?? "thinkingOff";
							modelStr +=
								dim(` • ${emoji} `) + theme.fg(token, level === "off" ? "off" : level);
						}
						if (model && footerData.getAvailableProviderCount() > 1) {
							modelStr = dim(`(${model.provider}) `) + modelStr;
						}
						const line1 = fitLR(left1, modelStr);

						// Line 2: context bar + cost + SPAI + ADR + LSP
						const barW = Math.max(8, Math.min(16, Math.floor(width * 0.16)));
						const bar = theme.fg(ctxColor, contextBar(percentValue, barW));
						const pct = percentValue === null ? "?" : `${percentValue.toFixed(1)}%`;
						const autoStr = isAutoCompactEnabled(ctx.cwd) ? dim(" (auto)") : "";

						const line2Parts: string[] = [
							dim("📊 ") +
								bar +
								" " +
								theme.fg(ctxColor, `${pct}/${formatTokens(contextWindow)}`) +
								autoStr,
							theme.fg("warning", `💰 $${formatCost(cost)}`),
						];

						const spai = statuses.get("pi-spai");
						if (spai) line2Parts.push(clean(spai));

						const adr = statuses.get("pi-solo-radar");
						if (adr) line2Parts.push(clean(adr));

						const lspKey = ["lsp", "pi-lsp", "lotusscript_lsp"].find(
							(k) => statuses.has(k) && Boolean(statuses.get(k)),
						);
						const rawLsp = lspKey ? statuses.get(lspKey) : undefined;
						if (rawLsp) {
							const lspVal = clean(rawLsp);
							if (!/inactive/i.test(lspVal)) {
								line2Parts.push(lspVal);
							}
						}

						const line2 = truncateToWidth(
							line2Parts.join(sep),
							width,
							theme.fg("dim", "…"),
						);
						return ["", line1, line2];
					}

					// -------------------------------------------------------------
					// Preset 3: "full" (multi-line layout)
					// -------------------------------------------------------------
					// ---- line A: location only (left-aligned) ----
					const locParts = [theme.fg("muted", `📁 ${formatCwd(sm.getCwd())}`)];
					const branch = footerData.getGitBranch();
					if (branch) {
						const gs = cachedGitStatus;
						const dirtyIcon = gs.dirty ? "●" : "○";
						const dirtyColor: ThemeColor = gs.dirty ? "warning" : "success";
						const dirtyLabel = gs.dirty ? "dirty" : "clean";
						let branchStr = `🌿 ${branch} ${theme.fg(dirtyColor, `${dirtyIcon} ${dim(dirtyLabel)}`)}`;
						if (gs.ahead > 0) branchStr += dim(` ▸${gs.ahead} ahead`);
						if (gs.behind > 0) branchStr += dim(` ◂${gs.behind} behind`);
						locParts.push(theme.fg("success", branchStr));
					}
					const sessionName = sm.getSessionName();
					if (sessionName)
						locParts.push(theme.fg("customMessageLabel", `🏷️ ${sessionName}`));
					const locLeft = locParts.join(sep);

					const lineA = fitLR(locLeft, "");

					// ---- line BC: context + cost + usage stats (single line) ----
					const barW = Math.max(10, Math.min(22, Math.floor(width * 0.22)));
					const bar = theme.fg(ctxColor, contextBar(percentValue, barW));
					const pct = percentValue === null ? "?" : `${percentValue.toFixed(1)}%`;
					const autoStr = isAutoCompactEnabled(ctx.cwd) ? dim(" (auto)") : "";

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

					// 💻 model segment (moved from line A)
					let modelStr = theme.fg("accent", model?.id || "no-model");
					if (model?.reasoning) {
						const level = pi.getThinkingLevel() || "off";
						const token = THINKING_TOKEN[level] ?? "thinkingOff";
						const emoji = THINKING_EMOJI[level] ?? "🧠";
						modelStr +=
							dim(` • ${emoji} `) +
							theme.fg(token, level === "off" ? "thinking off" : level);
					}
					if (model && footerData.getAvailableProviderCount() > 1) {
						modelStr = dim(`(${model.provider}) `) + modelStr;
					}
					statsParts.push(modelStr);

					const lineStats = truncateToWidth(
						statsParts.join(dim(" │ ")),
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
					const TRANSLATE_KEY = "prompt-translate-state";
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
						// Wrap extension statuses across multiple lines
						const sepExt = theme.fg("dim", " │ ");
						let currentLine = "";
						for (const s of rest) {
							const candidate = currentLine ? currentLine + sepExt + s : s;
							if (visibleWidth(candidate) <= width) {
								currentLine = candidate;
							} else {
								if (currentLine) lines.push(currentLine);
								currentLine = truncateToWidth(s, width, theme.fg("dim", "…"));
							}
						}
						if (currentLine) lines.push(currentLine);
					}

					return lines;
				},
			};
		});
	}

	function statusText(): string {
		const kimi = readKimiApiKey() ? "key" : "no-key";
		const zai = readZaiApiKey() ? "key" : "no-key";
		const globalActive = existsSync(GLOBAL_CONFIG_PATH) ? "aktivní" : "výchozí";
		return `eldritch-footer: ${currentConfig.enabled ? "on" : "off"} · preset ${currentConfig.preset} · global ${globalActive} · kimi ${kimi} · z.ai ${zai}`;
	}

	function saveConfig(
		ctx: ExtensionContext,
		next: Partial<FooterConfig>,
		persistGlobal = false,
	) {
		currentConfig = { ...currentConfig, ...next };
		pi.appendEntry(CONFIG_ENTRY_TYPE, currentConfig);
		if (persistGlobal) {
			saveGlobalConfig(currentConfig);
		}
		apply(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		currentConfig = extractConfig(ctx);
		apply(ctx);
	});

	const FOOTER_DOCS: Record<string, string> = {
		minimal: "přepne do 1-řádkového minimalistického režimu",
		compact: "přepne do 2-řádkového kompaktního režimu",
		full: "přepne do plného víceřádkového režimu",
		preset: "přepne režim zobrazení (minimal | compact | full)",
		on: "zapne vlastní statusline / footer",
		off: "vypne vlastní statusline a vrátí výchozí footer",
		toggle: "přepne stav zapnuto / vypnuto",
		status: "zobrazí aktuální konfiguraci a stav kvót",
		refresh: "vynutí okamžitou aktualizaci kvót Kimi a Z.ai",
		global: "správa globální konfigurace (show | clear)",
		help: "zobrazí podrobnou nápovědu",
	};

	pi.registerCommand("footer", {
		description:
			"eldritch-footer: custom statusline (minimal, compact, full), kvóty a kontextový pruh",
		getArgumentCompletions: async (
			prefix: string,
		): Promise<AutocompleteItem[] | null> => {
			const tokens = prefix.split(/\s+/).filter(Boolean);
			const trailingSpace = /\s$/.test(prefix);
			const normalizedPrefix = tokens.join(" ").toLowerCase();

			// 2nd-level contextual argument completion
			if (tokens.length > 1 || (trailingSpace && tokens.length === 1)) {
				const cmd = tokens[0]?.toLowerCase();

				if (cmd === "preset") {
					const presets: AutocompleteItem[] = [
						{
							value: "preset minimal",
							label: "preset minimal",
							description:
								"1-řádkový minimalistický režim (kontext, model, SPAI, ADR, LSP)",
						},
						{
							value: "preset compact",
							label: "preset compact",
							description:
								"2-řádkový vyvážený režim (větev, model, pruh, cena, tasky)",
						},
						{
							value: "preset full",
							label: "preset full",
							description: "Plný víceřádkový detailní režim (kvóty, tokeny, cache)",
						},
					];
					const filtered = presets.filter((i) =>
						i.value.toLowerCase().startsWith(normalizedPrefix),
					);
					return filtered.length > 0 ? filtered : null;
				}

				if (cmd === "global") {
					const globalItems: AutocompleteItem[] = [
						{
							value: "global show",
							label: "global show",
							description: "zobrazit obsah ~/.pi/agent/eldritch-footer.json",
						},
						{
							value: "global clear",
							label: "global clear",
							description: "resetovat globální konfiguraci na výchozí",
						},
					];
					const filtered = globalItems.filter((i) =>
						i.value.toLowerCase().startsWith(normalizedPrefix),
					);
					return filtered.length > 0 ? filtered : null;
				}

				return null;
			}

			// 1st-level subcommand completion
			const typed = (tokens[0] ?? "").toLowerCase();
			const items: AutocompleteItem[] = Object.entries(FOOTER_DOCS)
				.filter(([key]) => key.toLowerCase().startsWith(typed))
				.map(([value, description]) => ({ value, label: value, description }));

			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const isGlobal = tokens.some((t) => t.toLowerCase() === "--global");
			const cleanTokens = tokens.filter((t) => t.toLowerCase() !== "--global");

			const subcommand = (cleanTokens[0] ?? "").toLowerCase();
			const param = (cleanTokens[1] ?? "").toLowerCase();

			if (subcommand === "status") {
				ctx.ui.notify(statusText(), "info");
				return;
			}

			if (
				!subcommand ||
				subcommand === "help" ||
				subcommand === "-h" ||
				subcommand === "--help"
			) {
				const kimi = readKimiApiKey() ? "nastaven (API klíč / OAuth)" : "nenalezen";
				const zai = readZaiApiKey() ? "nastaven (API klíč)" : "nenalezen";
				const helpText = [
					`# eldritch-footer — stav: ${currentConfig.enabled ? "ZAPNUTO (ON)" : "VYPNUTO (OFF)"} | režim: ${currentConfig.preset.toUpperCase()}`,
					"Vlastní přizpůsobitelný statusline pro Pi coding agent s podporou minimalistického i detailního zobrazení.",
					"",
					"### Příkazy:",
					"  /footer minimal           — přepne do 1-řádkového minimalistického režimu",
					"  /footer compact           — přepne do 2-řádkového kompaktního režimu",
					"  /footer full              — přepne do plného víceřádkového režimu",
					"  /footer preset <preset>   — volba režimu (minimal | compact | full)",
					"  /footer on | off | toggle — zapnutí / vypnutí vlastního footeru",
					"  /footer refresh           — okamžité obnovení kvót Kimi / Z.ai",
					"  /footer status            — diagnostika a aktuální stav",
					"  /footer global show|clear — správa globální konfigurace",
					"",
					`Kimi kvóta API klíč: ${kimi}`,
					`Z.ai kvóta API klíč: ${zai}`,
					`Auto-compaction detekce: ${isAutoCompactEnabled(ctx.cwd) ? "aktivní" : "vypnuto"}`,
					`Globální konfigurace: ${existsSync(GLOBAL_CONFIG_PATH) ? GLOBAL_CONFIG_PATH : "nenastavena (výchozí)"}`,
					"",
					"Tip: Přidejte `--global` k libovolnému příkazu pro trvalé uložení do ~/.pi/agent/eldritch-footer.json",
				].join("\n");
				ctx.ui.notify(helpText, "info");
				return;
			}

			if (["minimal", "compact", "full"].includes(subcommand)) {
				saveConfig(
					ctx,
					{ enabled: true, preset: subcommand as FooterPreset },
					isGlobal,
				);
				ctx.ui.notify(
					`Eldritch footer: nastaven režim "${subcommand}"${isGlobal ? " (uloženo globálně)" : ""}`,
					"info",
				);
				return;
			}

			if (subcommand === "preset") {
				if (["minimal", "compact", "full"].includes(param)) {
					saveConfig(
						ctx,
						{ enabled: true, preset: param as FooterPreset },
						isGlobal,
					);
					ctx.ui.notify(
						`Eldritch footer: nastaven režim "${param}"${isGlobal ? " (uloženo globálně)" : ""}`,
						"info",
					);
					return;
				}
				ctx.ui.notify(
					"Použití: /footer preset minimal|compact|full [--global]",
					"warning",
				);
				return;
			}

			if (subcommand === "on" || subcommand === "enable") {
				saveConfig(ctx, { enabled: true }, isGlobal);
				ctx.ui.notify(
					`Eldritch footer zapnut (${currentConfig.preset})${isGlobal ? " (uloženo globálně)" : ""}`,
					"info",
				);
				return;
			}

			if (subcommand === "off" || subcommand === "disable") {
				saveConfig(ctx, { enabled: false }, isGlobal);
				ctx.ui.notify(
					`Eldritch footer vypnut (výchozí footer obnoven)${isGlobal ? " (uloženo globálně)" : ""}`,
					"info",
				);
				return;
			}

			if (subcommand === "toggle") {
				saveConfig(ctx, { enabled: !currentConfig.enabled }, isGlobal);
				ctx.ui.notify(
					`Eldritch footer: ${currentConfig.enabled ? "ON" : "OFF"}${isGlobal ? " (uloženo globálně)" : ""}`,
					"info",
				);
				return;
			}

			if (subcommand === "refresh") {
				void refreshKimiQuota(true);
				void refreshZaiQuota(true);
				ctx.ui.notify("Eldritch footer: kvóty obnoveny", "info");
				return;
			}

			if (subcommand === "global") {
				if (param === "clear" || param === "reset") {
					clearGlobalConfig();
					ctx.ui.notify(
						"Globální konfigurace eldritch-footer resetována na výchozí.",
						"info",
					);
					return;
				}
				if (!param || param === "show") {
					ctx.ui.notify(
						existsSync(GLOBAL_CONFIG_PATH)
							? `Globální konfigurace (${GLOBAL_CONFIG_PATH}):\n${readFileSync(GLOBAL_CONFIG_PATH, "utf8")}`
							: "Globální konfigurace dosud nevytvořena (používají se výchozí hodnoty).",
						"info",
					);
					return;
				}
				ctx.ui.notify("Použití: /footer global show|clear", "warning");
				return;
			}

			ctx.ui.notify(
				`Neznámý příkaz "${subcommand}". Použijte: /footer help`,
				"warning",
			);
		},
	});
}
