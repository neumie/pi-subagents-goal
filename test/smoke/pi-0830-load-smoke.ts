import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createEventBus } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import { loadExtensions } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { GOAL_TOOL_NAMES } from "../../src/extension.ts";

const projectRoot = resolve(import.meta.dirname, "../..");
const piPackagePath = resolve(projectRoot, "node_modules/@earendil-works/pi-coding-agent/package.json");
const piPackage = JSON.parse(await readFile(piPackagePath, "utf8")) as { version?: unknown };
assert.equal(piPackage.version, "0.83.0", "Smoke must run against exact Pi 0.83.0");

const result = await loadExtensions([resolve(projectRoot, "index.ts")], projectRoot, createEventBus());
assert.deepEqual(result.errors, []);
assert.equal(result.extensions.length, 1);
const extension = result.extensions[0];
assert.ok(extension);
assert.deepEqual([...extension.tools.keys()].sort(), [...GOAL_TOOL_NAMES].sort());
assert.deepEqual([...extension.commands.keys()], ["goal"]);
assert.deepEqual(
	[...extension.handlers.keys()].sort(),
	[
		"agent_end",
		"agent_settled",
		"agent_start",
		"before_agent_start",
		"session_before_compact",
		"session_before_fork",
		"session_before_switch",
		"session_before_tree",
		"session_shutdown",
		"session_start",
		"tool_call",
		"tool_result",
		"turn_end",
	].sort(),
);

console.log(
	JSON.stringify({
		piVersion: piPackage.version,
		loaded: true,
		tools: [...extension.tools.keys()],
		commands: [...extension.commands.keys()],
		handlers: [...extension.handlers.keys()],
	}),
);
