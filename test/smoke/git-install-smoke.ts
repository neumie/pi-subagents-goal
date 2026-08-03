import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DefaultResourceLoader } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js";
import { SettingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js";
import { GOAL_TOOL_NAMES } from "../../src/extension.ts";

const execFileAsync = promisify(execFile);
const repo = process.env.PI_GOAL_GIT_SMOKE_REPOSITORY;
const ref = process.env.PI_GOAL_GIT_SMOKE_REF;
assert.ok(
	repo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo),
	"PI_GOAL_GIT_SMOKE_REPOSITORY must be owner/repository",
);
assert.ok(ref && /^[a-f0-9]{40}$/u.test(ref), "PI_GOAL_GIT_SMOKE_REF must be an immutable 40-character SHA");

const root = await mkdtemp(join(tmpdir(), "pi-subagents-goal-git-smoke-"));
const agentDir = join(root, "agent");
const pi = resolve(import.meta.dirname, "../../node_modules/.bin/pi");
const environment = { ...process.env, PI_CODING_AGENT_DIR: agentDir };

async function walk(directory: string): Promise<string[]> {
	const entries = await readdir(directory);
	const found: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry);
		if ((await stat(path)).isDirectory()) found.push(path, ...(await walk(path)));
	}
	return found;
}

try {
	await execFileAsync(pi, ["install", `git:github.com/${repo}@${ref}`], {
		cwd: root,
		env: environment,
		timeout: 120_000,
	});
	const settings = await readFile(join(agentDir, "settings.json"), "utf8");
	assert.ok(
		settings.includes(`git:github.com/${repo}@${ref}`),
		"Pi settings omit the immutable Git specifier",
	);
	const directories = await walk(agentDir);
	const managed = directories.filter((path) => path.endsWith(".git"));
	assert.ok(managed.length > 0, "Pi did not create a managed Git checkout");
	const checkout = managed[0]?.slice(0, -"/.git".length);
	assert.ok(checkout);
	const { stdout } = await execFileAsync("git", ["-C", checkout, "rev-parse", "HEAD"], { env: environment });
	assert.equal(stdout.trim(), ref);
	const settingsManager = SettingsManager.create(root, agentDir);
	await settingsManager.reload();
	const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager });
	await loader.reload();
	const extensions = loader.getExtensions();
	assert.deepEqual(extensions.errors, []);
	assert.equal(extensions.extensions.length, 1);
	const extension = extensions.extensions[0];
	assert.ok(extension);
	assert.deepEqual([...extension.tools.keys()].sort(), [...GOAL_TOOL_NAMES].sort());
	assert.deepEqual([...extension.commands.keys()], ["goal"]);
	assert.equal(extension.handlers.has("tool_call"), false);
	console.log(JSON.stringify({ repo, ref, settings: true, managedHead: stdout.trim(), loaded: true }));
} finally {
	await rm(root, { recursive: true, force: true });
}
