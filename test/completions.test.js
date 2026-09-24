import test from "node:test";
import assert from "node:assert/strict";
import { registerFooterCommand } from "../src/command.js";

test("footer completions include --global and preserve --global prefix", async () => {
	let cmdDef = null;
	const mockPi = {
		registerCommand(name, def) {
			if (name === "footer") cmdDef = def;
		},
	};
	registerFooterCommand(mockPi, {
		getConfig: () => ({ enabled: true, preset: "compact" }),
		saveConfig: () => {},
		refreshQuotas: async () => {},
		statusText: () => "status",
	});
	assert.ok(cmdDef);

	const root = await cmdDef.getArgumentCompletions("");
	assert.ok(root && root.some((c) => c.value === "--global "));
	assert.ok(root && root.some((c) => c.value === "preset "));

	const globalComps = await cmdDef.getArgumentCompletions("--global ");
	assert.ok(globalComps && globalComps.some((c) => c.value === "--global preset "));
	assert.ok(globalComps && globalComps.some((c) => c.value === "--global minimal"));

	const globalPresetComps = await cmdDef.getArgumentCompletions("--global preset ");
	assert.ok(globalPresetComps && globalPresetComps.some((c) => c.value === "--global preset minimal"));
	assert.ok(globalPresetComps && globalPresetComps.some((c) => c.value === "--global preset full"));
});
