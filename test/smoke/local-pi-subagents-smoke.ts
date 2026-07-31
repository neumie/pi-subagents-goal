import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import { loadExtensions } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { SessionManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { SubagentBridge } from "../../src/subagents-bridge.ts";

const EXPECTED_LOCAL_VERSION = "0.38.1";
const EXPECTED_LOCAL_COMMIT = "886bbad929134d7954a4fb34e532d82ac21e33e8";
const projectRoot = resolve(import.meta.dirname, "../..");
const localRoot = resolve(process.env.PI_SUBAGENTS_LOCAL_PATH ?? resolve(projectRoot, "../pi-subagents"));
const localEntry = resolve(localRoot, "index.ts");
const packageJson = JSON.parse(await readFile(resolve(localRoot, "package.json"), "utf8")) as {
	version?: unknown;
};
assert.equal(packageJson.version, EXPECTED_LOCAL_VERSION);
const commit = execFileSync("git", ["-C", localRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(commit, EXPECTED_LOCAL_COMMIT);
const localStatus = execFileSync("git", ["-C", localRoot, "status", "--porcelain"], {
	encoding: "utf8",
}).trim();
assert.equal(localStatus, "", "Local pi-subagents worktree must be clean for reproducible smoke evidence");

// The smoke validates the root extension surface even when invoked from a reviewer child process.
delete process.env.PI_SUBAGENT_CHILD;
const eventBus = createEventBus();
const loaded = await loadExtensions([localEntry], projectRoot, eventBus);
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const extension = loaded.extensions[0];
assert.ok(extension);
assert.ok(extension.tools.has("subagent"));

const noOp = () => undefined;
loaded.runtime.sendMessage = noOp;
loaded.runtime.sendUserMessage = noOp;
loaded.runtime.appendEntry = noOp;
loaded.runtime.setSessionName = noOp;
loaded.runtime.getSessionName = () => undefined;
loaded.runtime.setLabel = noOp;
loaded.runtime.getActiveTools = () => [];
loaded.runtime.getAllTools = () => [];
loaded.runtime.setActiveTools = noOp;
loaded.runtime.refreshTools = noOp;
loaded.runtime.getCommands = () => [];
loaded.runtime.setModel = async () => false;
loaded.runtime.getThinkingLevel = () => "off";
loaded.runtime.setThinkingLevel = noOp;

const sessionManager = SessionManager.inMemory(projectRoot);
const ui = new Proxy({}, { get: () => noOp });
const context = {
	cwd: projectRoot,
	hasUI: false,
	ui,
	sessionManager,
	isIdle: () => true,
	isProjectTrusted: () => true,
	abort: noOp,
	getSignal: () => undefined,
	waitForIdle: async () => undefined,
	hasPendingMessages: () => false,
	shutdown: noOp,
	getContextUsage: () => undefined,
	compact: noOp,
	getModel: () => undefined,
	getThinkingLevel: () => "off",
	getSystemPrompt: () => "",
	getSystemPromptOptions: () => ({}),
} as unknown as ExtensionContext;

const bridge = new SubagentBridge(eventBus);
let started = false;
try {
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "startup" }, context);
	}
	const expectedSession = { sessionId: sessionManager.getSessionId(), sessionFile: null };
	const compatibility = await bridge.probe(expectedSession, 1_000);
	assert.equal(compatibility.available, true);
	assert.equal(compatibility.sessionMatches, true);
	assert.equal(compatibility.protocolVersion, 1);
	assert.equal(compatibility.goalCoordination, undefined);
	assert.ok(compatibility.methods.includes("spawn"));

	const terminal = await bridge.runForeground(
		{
			ownerRunId: "goal-smoke-owner",
			nodeId: "goal-smoke-node",
			agent: "__missing_goal_smoke_agent__",
			task: "This request must fail before model execution.",
			context: "fresh",
			cwd: projectRoot,
			timeoutMs: 1_000,
			turnBudget: { maxTurns: 1, graceTurns: 1 },
			result: { kind: "text" },
		},
		undefined,
		{
			onStarted: () => {
				started = true;
			},
		},
	);
	assert.equal(started, true);
	assert.equal(terminal.ownerRunId, "goal-smoke-owner");
	assert.equal(terminal.nodeId, "goal-smoke-node");
	assert.equal(terminal.status, "failed");
	assert.match(terminal.error ?? "", /Unknown agent/u);

	await assert.rejects(
		() =>
			bridge.spawnCoordinated(compatibility, {
				owner: {
					...expectedSession,
					lineageId: "lineage-smoke",
					goalId: "goal-smoke",
					epoch: 1,
				},
				itemId: "detached-smoke",
				attempt: 1,
				params: { agent: "worker", task: "detached" },
			}),
		/(?:does not advertise|not advertised)/u,
	);

	console.log(
		JSON.stringify({
			piSubagentsVersion: packageJson.version,
			piSubagentsCommit: commit,
			localWorktreeClean: true,
			rpcSessionMatched: true,
			delegationV2TupleMatched: true,
			foregroundTerminal: terminal.status,
			detachedGoalCoordinationAdvertised: false,
		}),
	);
} finally {
	for (const handler of extension.handlers.get("session_shutdown") ?? []) {
		await handler({ type: "session_shutdown", reason: "quit" }, context);
	}
	bridge.dispose();
}
