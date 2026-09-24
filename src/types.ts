import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type FooterPreset = "minimal" | "compact" | "full";

export interface FooterConfig {
	enabled: boolean;
	preset: FooterPreset;
}

export interface GitStatus {
	dirty: boolean;
	ahead: number;
	behind: number;
}

export interface KimiUsageDetail {
	used?: number;
	limit?: number;
	reset_time?: string;
}

export interface KimiUsageEntry {
	detail?: KimiUsageDetail;
}

export interface KimiUsages {
	usage?: KimiUsageDetail;
	limits?: Array<{
		window?: { duration?: number; timeUnit?: string };
		detail?: KimiUsageDetail;
	}>;
	usages?: KimiUsageEntry[];
}

export interface ProviderPollState {
	fetchedAt: number;
	inFlight: boolean;
	consecutiveErrors: number;
	lastLatencyMs: number;
	currentTtlMs: number;
}

export interface ZaiLimit {
	type: string;
	unit?: number;
	number?: number;
	percentage?: number;
	usage?: number;
	currentValue?: number;
	remaining?: number;
	nextResetTime?: number;
}

export interface ZaiQuota {
	limits?: ZaiLimit[];
	level?: string;
}

export type Theme = Parameters<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>[1];
export type FooterData = Parameters<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>[2];
