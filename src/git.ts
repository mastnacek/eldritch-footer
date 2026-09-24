import { execSync } from "node:child_process";
import type { GitStatus } from "./types.js";

let cachedGitStatus: GitStatus = { dirty: false, ahead: 0, behind: 0 };

export function getCachedGitStatus(): GitStatus {
	return cachedGitStatus;
}

export function resetGitStatus(): void {
	cachedGitStatus = { dirty: false, ahead: 0, behind: 0 };
}

export function refreshGitStatus(cwd: string): GitStatus {
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
	return cachedGitStatus;
}
