/**
 * Eldritch Footer — installable Pi package.
 *
 * Custom footer/statusline replacing the built-in one:
 *   - minimal (1 line)
 *   - compact (2 balanced lines)
 *   - full (multi-line layout with token counters and vendor quota meters)
 */

import { existsSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	CONFIG_ENTRY_TYPE,
	DEFAULT_CONFIG,
	extractConfig,
	GLOBAL_CONFIG_PATH,
	saveGlobalConfig,
	saveProjectConfig,
} from "./src/config.js";
import { refreshGitStatus, resetGitStatus } from "./src/git.js";
import {
	readKimiApiKey,
	readZaiApiKey,
	refreshKimiQuota,
	refreshZaiQuota,
	resetQuotaState,
} from "./src/quota.js";
import { renderFooter } from "./src/renderers.js";
import { registerFooterCommand } from "./src/command.js";
import type { FooterConfig, FooterData, Theme } from "./src/types.js";

export type { FooterConfig, FooterPreset } from "./src/types.js";

let currentConfig: FooterConfig = { ...DEFAULT_CONFIG };

export default function (pi: ExtensionAPI) {
	const unsubscribers: Array<() => void> = [];

	const track = (result: unknown): void => {
		if (typeof result === "function") unsubscribers.push(result as () => void);
	};

	let requestRender: (() => void) | undefined;
	const rerender = () => requestRender?.();

	track(pi.on("thinking_level_select", rerender));
	track(pi.on("model_select", rerender));
	track(pi.on("turn_end", rerender));
	track(pi.on("session_compact", rerender));
	track(pi.on("session_info_changed", rerender));
	track(pi.on("message_start", rerender));
	track(pi.on("message_end", rerender));
	track(pi.on("tool_execution_start", rerender));
	track(pi.on("tool_execution_end", rerender));

	track(pi.on("turn_end", async () => {
		await refreshZaiQuota(false, rerender);
	}));
	track(pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		refreshGitStatus(ctx.cwd);
	}));

	function apply(ctx: ExtensionContext) {
		if (!currentConfig.enabled || !ctx.hasUI || ctx.mode !== "tui") {
			ctx.ui.setFooter(undefined);
			return;
		}
		if (ctx.model?.provider === "kimi-coding") void refreshKimiQuota(false, rerender);
		if (
			ctx.model?.provider === "zai-coding-cn" ||
			ctx.model?.provider === "zai-coding"
		) {
			void refreshZaiQuota(false, rerender);
		}

		ctx.ui.setFooter((tui, theme: Theme, footerData: FooterData) => {
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
					return renderFooter(
						ctx,
						currentConfig,
						theme,
						footerData,
						width,
						() => pi.getThinkingLevel() || "off",
					);
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
		} else if (ctx.cwd) {
			saveProjectConfig(ctx.cwd, currentConfig);
		}
		apply(ctx);
	}

	track(pi.on("session_start", async (_event, ctx) => {
		currentConfig = extractConfig(ctx);
		apply(ctx);
	}));

	pi.on("session_shutdown", () => {
		while (unsubscribers.length > 0) unsubscribers.pop()?.();
		currentConfig = { ...DEFAULT_CONFIG };
		resetGitStatus();
		resetQuotaState();
	});

	registerFooterCommand(pi, {
		getConfig: () => currentConfig,
		saveConfig,
		refreshQuotas: async (force: boolean) => {
			await Promise.all([
				refreshKimiQuota(force, rerender),
				refreshZaiQuota(force, rerender),
			]);
		},
		statusText,
	});
}
