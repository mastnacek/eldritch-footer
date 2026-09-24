import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getCachedGitStatus } from "./git.js";
import { getKimiUsages, getZaiQuota } from "./quota.js";
import {
	contextBar,
	formatCost,
	formatCwd,
	formatEpochResetTime,
	formatResetTime,
	formatTokens,
	isAutoCompactEnabled,
	THINKING_EMOJI,
	THINKING_TOKEN,
} from "./formatters.js";
import type { FooterConfig, FooterData, KimiUsageDetail, Theme, ZaiLimit } from "./types.js";

export function renderFooter(
	ctx: ExtensionContext,
	config: FooterConfig,
	theme: Theme,
	footerData: FooterData,
	width: number,
	getThinkingLevel: () => string,
): string[] {
	const model = ctx.model;
	const sm = ctx.sessionManager;

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
			latestCacheHitRate = prompt > 0 ? (u.cacheRead / prompt) * 100 : undefined;
		} else if (e.type === "message" && e.message.role === "toolResult" && e.message.usage) {
			const u = e.message.usage;
			input += u.input;
			output += u.output;
			cacheRead += u.cacheRead;
			cacheWrite += u.cacheWrite;
			cost += u.cost?.total ?? 0;
		} else if ((e.type === "branch_summary" || e.type === "compaction") && e.usage) {
			const u = e.usage;
			input += u.input;
			output += u.output;
			cacheRead += u.cacheRead;
			cacheWrite += u.cacheWrite;
			cost += u.cost?.total ?? 0;
		}
	}

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

	const fitLR = (left: string, right: string): string => {
		const lw = visibleWidth(left);
		const rw = visibleWidth(right);
		const gap = 4;
		if (rw >= width) return truncateToWidth(right, width, theme.fg("dim", "…"));
		if (lw + gap + rw <= width) return left + " ".repeat(width - lw - rw) + right;
		const avail = width - rw - gap;
		if (avail > 16) {
			const tl = truncateToWidth(left, avail, theme.fg("dim", "…"));
			return tl + " ".repeat(width - visibleWidth(tl) - rw) + right;
		}
		return truncateToWidth(left, width, theme.fg("dim", "…"));
	};

	const statuses = footerData.getExtensionStatuses();
	const clean = (t: string) => t.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
	const cachedGitStatus = getCachedGitStatus();

	// Preset: minimal
	if (config.preset === "minimal") {
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
		const rightParts: string[] = [];

		const barW = Math.max(6, Math.min(8, Math.floor(width * 0.08)));
		const bar = theme.fg(ctxColor, contextBar(percentValue, barW));
		const pct = percentValue === null ? "?" : `${percentValue.toFixed(0)}%`;
		rightParts.push(dim("📊 ") + bar + " " + theme.fg(ctxColor, `${pct}/${formatTokens(contextWindow)}`));

		let modelStr = theme.fg("accent", model?.id || "no-model");
		if (model?.reasoning) {
			const level = getThinkingLevel() || "off";
			const emoji = THINKING_EMOJI[level] ?? "🧠";
			const token = THINKING_TOKEN[level] ?? "thinkingOff";
			modelStr += dim(` • ${emoji} `) + theme.fg(token, level === "off" ? "off" : level);
		}
		if (model && footerData.getAvailableProviderCount() > 1) {
			modelStr = dim(`(${model.provider}) `) + modelStr;
		}
		rightParts.push(modelStr);

		const subagentKey = ["pi-subagents", "subagent", "fusion", "apple-rada", "pi-council"].find(
			(k) => statuses.has(k) && Boolean(statuses.get(k)),
		);
		const rawSubagent = subagentKey ? statuses.get(subagentKey) : undefined;
		if (rawSubagent) rightParts.push(theme.fg("accent", `🤖 ${clean(rawSubagent)}`));

		const spai = statuses.get("pi-spai");
		if (spai) rightParts.push(clean(spai));

		const adr = statuses.get("pi-solo-radar");
		if (adr) rightParts.push(clean(adr));

		const lspKey = ["lsp", "pi-lsp", "lotusscript_lsp"].find(
			(k) => statuses.has(k) && Boolean(statuses.get(k)),
		);
		const rawLsp = lspKey ? statuses.get(lspKey) : undefined;
		if (rawLsp) {
			const lspVal = clean(rawLsp);
			if (!/inactive/i.test(lspVal)) rightParts.push(lspVal);
		}

		return ["", fitLR(left, rightParts.join(sep))];
	}

	// Preset: compact
	if (config.preset === "compact") {
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
			const level = getThinkingLevel() || "off";
			const emoji = THINKING_EMOJI[level] ?? "🧠";
			const token = THINKING_TOKEN[level] ?? "thinkingOff";
			modelStr += dim(` • ${emoji} `) + theme.fg(token, level === "off" ? "off" : level);
		}
		if (model && footerData.getAvailableProviderCount() > 1) {
			modelStr = dim(`(${model.provider}) `) + modelStr;
		}
		const line1 = fitLR(left1, modelStr);

		const barW = Math.max(8, Math.min(16, Math.floor(width * 0.16)));
		const bar = theme.fg(ctxColor, contextBar(percentValue, barW));
		const pct = percentValue === null ? "?" : `${percentValue.toFixed(1)}%`;
		const autoStr = isAutoCompactEnabled(ctx.cwd) ? dim(" (auto)") : "";

		const line2Parts: string[] = [
			dim("📊 ") + bar + " " + theme.fg(ctxColor, `${pct}/${formatTokens(contextWindow)}`) + autoStr,
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
			if (!/inactive/i.test(lspVal)) line2Parts.push(lspVal);
		}

		return ["", line1, truncateToWidth(line2Parts.join(sep), width, theme.fg("dim", "…"))];
	}

	// Preset: full
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
	if (sessionName) locParts.push(theme.fg("customMessageLabel", `🏷️ ${sessionName}`));
	const lineA = fitLR(locParts.join(sep), "");

	const barW = Math.max(10, Math.min(22, Math.floor(width * 0.22)));
	const bar = theme.fg(ctxColor, contextBar(percentValue, barW));
	const pct = percentValue === null ? "?" : `${percentValue.toFixed(1)}%`;
	const autoStr = isAutoCompactEnabled(ctx.cwd) ? dim(" (auto)") : "";
	const usingSubscription = model?.provider === "kimi-coding";

	const statsParts: string[] = [
		dim("📊 ") + bar + " " + theme.fg(ctxColor, `${pct}/${formatTokens(contextWindow)}`) + autoStr,
		theme.fg("warning", `💰 $${formatCost(cost)}`) + (usingSubscription ? dim(" (sub)") : ""),
		theme.fg("mdLink", `⬆️ ${formatTokens(input)}`),
		theme.fg("success", `⬇️ ${formatTokens(output)}`),
	];

	if (cacheRead || cacheWrite) {
		let cacheStr = `📦 ${formatTokens(cacheRead)}`;
		if (cacheWrite) cacheStr += ` (w:${formatTokens(cacheWrite)})`;
		if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) {
			cacheStr += ` 🎯${latestCacheHitRate.toFixed(0)}%`;
		}
		statsParts.push(theme.fg("muted", cacheStr));
	}

	let modelStr = theme.fg("accent", model?.id || "no-model");
	if (model?.reasoning) {
		const level = getThinkingLevel() || "off";
		const token = THINKING_TOKEN[level] ?? "thinkingOff";
		const emoji = THINKING_EMOJI[level] ?? "🧠";
		modelStr += dim(` • ${emoji} `) + theme.fg(token, level === "off" ? "thinking off" : level);
	}
	if (model && footerData.getAvailableProviderCount() > 1) {
		modelStr = dim(`(${model.provider}) `) + modelStr;
	}
	statsParts.push(modelStr);

	const lineStats = truncateToWidth(statsParts.join(dim(" │ ")), width, dim("…"));
	const lines = ["", lineA, lineStats];

	let quotaLine: string | undefined;
	const kimiUsages = getKimiUsages();
	if (model?.provider === "kimi-coding" && kimiUsages?.usage) {
		const quotaColor = (used: number, limit: number): ThemeColor =>
			limit > 0 && (used / limit) * 100 > 90
				? "error"
				: limit > 0 && (used / limit) * 100 > 70
					? "warning"
					: "success";
		const seg = (label: string, e: KimiUsageDetail) => {
			const used = Number(e.used ?? 0);
			const limit = Number(e.limit ?? 0);
			const color = quotaColor(used, limit);
			return (
				dim(`${label} `) +
				theme.fg(color, contextBar(limit > 0 ? (used / limit) * 100 : null)) +
				theme.fg(color, ` ${e.used ?? "?"}/${e.limit ?? "?"}`) +
				dim(` rst ${formatResetTime(e.reset_time)}`)
			);
		};
		const kimiBg = theme.bg ? (theme.bg as (color: string, text: string) => string)("customMessageBg", theme.fg("accent", " kimi ")) : theme.fg("accent", " kimi ");
		const kimiParts = [
			kimiBg,
			seg("týden", kimiUsages.usage),
		];
		const win = kimiUsages.limits?.[0]?.detail ?? kimiUsages.usages?.[0]?.detail;
		if (win) kimiParts.push(seg("5h", win));
		quotaLine = truncateToWidth(kimiParts.join(dim(" │ ")), width, theme.fg("dim", "…"));
	}

	const zaiQuota = getZaiQuota();
	const zaiProviders = ["zai-coding-cn", "zai-coding"];
	if (!quotaLine && zaiProviders.includes(model?.provider ?? "") && zaiQuota?.limits?.length) {
		const pctColor = (p?: number): ThemeColor =>
			p === undefined ? "muted" : p > 90 ? "error" : p > 70 ? "warning" : "success";
		const tokensSeg = (label: string, lim: ZaiLimit) => {
			const p = lim.percentage ?? 0;
			const color = pctColor(p);
			return (
				dim(`${label} `) +
				theme.fg(color, contextBar(p)) +
				theme.fg(color, ` ${p}%`) +
				dim(` rst ${formatEpochResetTime(lim.nextResetTime)}`)
			);
		};
		const zaiLimits = zaiQuota.limits.filter((l) => l.type === "TOKENS_LIMIT");
		const fiveHour = zaiLimits.find((l) => l.unit === 3) ?? zaiLimits[0];
		const weekly = zaiLimits.find((l) => l.unit === 6) ?? zaiLimits[1];
		const zaiBg = theme.bg ? (theme.bg as (color: string, text: string) => string)("customMessageBg", theme.fg("accent", " z.ai ")) : theme.fg("accent", " z.ai ");
		const zaiParts = [
			zaiBg,
		];
		if (fiveHour) zaiParts.push(tokensSeg("5h okno", fiveHour));
		if (weekly) zaiParts.push(tokensSeg("týden", weekly));
		const search = zaiQuota.limits.find((l) => l.type === "TIME_LIMIT");
		if (search && typeof search.number === "number") {
			zaiParts.push(dim("hledání ") + theme.fg("muted", `${search.percentage ?? 0}/${search.number}`));
		}
		quotaLine = truncateToWidth(zaiParts.join(dim(" │ ")), width, theme.fg("dim", "…"));
	}
	if (quotaLine) lines.push(quotaLine);

	const translate = statuses.get("prompt-translate-state");
	if (translate) lines.push(truncateToWidth(clean(translate), width, theme.fg("dim", "…")));

	const rest = Array.from(statuses.entries()).filter(([k]) => k !== "prompt-translate-state");
	if (rest.length > 0) {
		const extParts = rest.map(([k, v]) => {
			const val = clean(v);
			return val ? theme.fg("muted", `${k}: `) + val : theme.fg("dim", k);
		});
		lines.push(truncateToWidth(extParts.join(dim(" │ ")), width, theme.fg("dim", "…")));
	}

	return lines;
}
