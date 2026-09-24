import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FooterConfig } from "./types.js";

export const CONFIG_ENTRY_TYPE = "eldritch-footer-config";

export const GLOBAL_CONFIG_PATH = join(
	homedir(),
	".pi",
	"agent",
	"eldritch-footer.json",
);

export const DEFAULT_CONFIG: FooterConfig = {
	enabled: true,
	preset: "compact",
};

export function loadGlobalConfig(): Partial<FooterConfig> {
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

export function saveGlobalConfig(config: FooterConfig): void {
	try {
		mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
		writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
	} catch {
		/* ignore */
	}
}

export function clearGlobalConfig(): void {
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

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "eldritch-footer.json");
}

export function loadProjectConfig(cwd: string): Partial<FooterConfig> {
	try {
		const projFile = projectConfigPath(cwd);
		if (existsSync(projFile)) {
			return JSON.parse(readFileSync(projFile, "utf8")) as Partial<FooterConfig>;
		}
	} catch {
		/* ignore */
	}
	return {};
}

export function saveProjectConfig(cwd: string, config: FooterConfig): void {
	try {
		const projFile = projectConfigPath(cwd);
		mkdirSync(dirname(projFile), { recursive: true });
		writeFileSync(projFile, JSON.stringify(config, null, 2), "utf8");
	} catch {
		/* ignore */
	}
}

export function extractConfig(ctx: ExtensionContext): FooterConfig {
	const globalCfg = loadGlobalConfig();
	const projectCfg = ctx.cwd ? loadProjectConfig(ctx.cwd) : {};
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
	const merged = { ...DEFAULT_CONFIG, ...globalCfg, ...projectCfg, ...(sessionCfg ?? {}) };
	return {
		enabled:
			typeof merged.enabled === "boolean"
				? merged.enabled
				: DEFAULT_CONFIG.enabled,
		preset:
			merged.preset &&
			["minimal", "compact", "full"].includes(merged.preset)
				? merged.preset
				: DEFAULT_CONFIG.preset,
	};
}
