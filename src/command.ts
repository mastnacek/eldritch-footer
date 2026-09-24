import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	clearGlobalConfig,
	GLOBAL_CONFIG_PATH,
	loadGlobalConfig,
} from "./config.js";
import { isAutoCompactEnabled } from "./formatters.js";
import { readKimiApiKey, readZaiApiKey } from "./quota.js";
import type { FooterConfig, FooterPreset } from "./types.js";

export const FOOTER_DOCS: Record<string, string> = {
	"--global": "uložit následující nastavení trvale (~/.pi/agent/)",
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

export interface FooterCommandDeps {
	getConfig: () => FooterConfig;
	saveConfig: (ctx: ExtensionCommandContext, next: Partial<FooterConfig>, isGlobal: boolean) => void;
	refreshQuotas: (force: boolean) => Promise<void>;
	statusText: () => string;
}

export function registerFooterCommand(
	pi: ExtensionAPI,
	deps: FooterCommandDeps,
): void {
	pi.registerCommand("footer", {
		description:
			"eldritch-footer: custom statusline (minimal, compact, full), kvóty a kontextový pruh",
		getArgumentCompletions: async (
			prefix: string,
		): Promise<AutocompleteItem[] | null> => {
			const trimmed = prefix.trimStart();

			const getCompletionsClean = async (
				cleanPrefix: string,
			): Promise<AutocompleteItem[] | null> => {
				const tokens = cleanPrefix.split(/\s+/).filter(Boolean);
				const trailingSpace = /\s$/.test(cleanPrefix);
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
				const NON_TERMINAL = new Set(["--global", "preset", "global"]);
				const items: AutocompleteItem[] = [];
				for (const [key, description] of Object.entries(FOOTER_DOCS)) {
					if (key.toLowerCase().startsWith(typed)) {
						items.push({
							value: NON_TERMINAL.has(key) ? `${key} ` : key,
							label: key,
							description,
						});
					}
				}

				return items.length > 0 ? items : null;
			};

			if (trimmed.startsWith("--global")) {
				const afterGlobal = trimmed.slice(8).trimStart();
				const hasTrailingSpace = trimmed.length > 8 || /\s$/.test(prefix);

				if (!hasTrailingSpace && afterGlobal === "") {
					return [
						{
							value: "--global ",
							label: "--global",
							description: FOOTER_DOCS["--global"] ?? "uložit trvale",
						},
					];
				}

				const subCompletions = await getCompletionsClean(afterGlobal);
				if (!subCompletions) return null;

				return subCompletions
					.filter((item) => item.label !== "--global")
					.map((item) => ({
						value: `--global ${item.value}`,
						label: item.label,
						description: item.description,
					}));
			}

			return getCompletionsClean(trimmed);
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const isGlobal = tokens.some((t) => t.toLowerCase() === "--global");
			const cleanTokens = tokens.filter((t) => t.toLowerCase() !== "--global");

			const subcommand = (cleanTokens[0] ?? "").toLowerCase();
			const param = (cleanTokens[1] ?? "").toLowerCase();
			const currentConfig = deps.getConfig();

			if (subcommand === "status") {
				ctx.ui.notify(deps.statusText(), "info");
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
				deps.saveConfig(
					ctx,
					{ enabled: true, preset: subcommand as FooterPreset },
					isGlobal,
				);
				ctx.ui.notify(
					`Eldritch footer: nastaven režim "${subcommand}"${isGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
					"info",
				);
				return;
			}

			if (subcommand === "preset") {
				if (["minimal", "compact", "full"].includes(param)) {
					deps.saveConfig(
						ctx,
						{ enabled: true, preset: param as FooterPreset },
						isGlobal,
					);
					ctx.ui.notify(
						`Eldritch footer: nastaven režim "${param}"${isGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
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
				deps.saveConfig(ctx, { enabled: true }, isGlobal);
				ctx.ui.notify(
					`Eldritch footer zapnut (${currentConfig.preset})${isGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
					"info",
				);
				return;
			}

			if (subcommand === "off" || subcommand === "disable") {
				deps.saveConfig(ctx, { enabled: false }, isGlobal);
				ctx.ui.notify(
					`Eldritch footer vypnut (výchozí footer obnoven)${isGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
					"info",
				);
				return;
			}

			if (subcommand === "toggle") {
				const next = !currentConfig.enabled;
				deps.saveConfig(ctx, { enabled: next }, isGlobal);
				ctx.ui.notify(
					`Eldritch footer: ${next ? `zapnut (${currentConfig.preset})` : "vypnut"}${isGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
					"info",
				);
				return;
			}

			if (subcommand === "refresh") {
				ctx.ui.notify("Vynucuji obnovení kvót Kimi & Z.ai...", "info");
				await deps.refreshQuotas(true);
				ctx.ui.notify(deps.statusText(), "info");
				return;
			}

			if (subcommand === "global") {
				if (param === "show") {
					const cfg = loadGlobalConfig();
					ctx.ui.notify(
						`Globální konfigurace (${GLOBAL_CONFIG_PATH}):\n${JSON.stringify(cfg, null, 2)}`,
						"info",
					);
					return;
				}
				if (param === "clear") {
					clearGlobalConfig();
					deps.saveConfig(ctx, { preset: "compact" }, false);
					ctx.ui.notify(
						"Globální konfigurace resetována na výchozí.",
						"info",
					);
					return;
				}
				ctx.ui.notify(
					"Použití: /footer global show | /footer global clear",
					"warning",
				);
				return;
			}

			ctx.ui.notify(
				`Neznámý příkaz "/footer ${subcommand}". Použijte: /footer help`,
				"warning",
			);
		},
	});
}
