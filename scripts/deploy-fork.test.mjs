// Offline fixtures for scripts/deploy-fork.mjs, scripts/build-subagents.mjs and the fork's build
// verifier.
//
// Everything runs in a private scratch directory: fake fork sources, a fake `dist-pkg` build
// stamped with the real fingerprint and artifact hashes, and a fake installed npm package (real
// directory or pnpm-style package-root symlink). No live agent directory, network, package
// manager or real artifact is involved.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	assertInputsUnchanged,
	buildSubagents,
	describeInputChanges,
	parseForkArgument,
} from "./build-subagents.mjs";
import { applyForkDeploy, parseForksFile, planForkDeploy, runForkCommand } from "./deploy-fork.mjs";
import {
	BUILD_STAMP_FILE,
	collectSourceInputs,
	digestInputs,
	REQUIRED_ROOT_MODULES,
	stampBuild,
	verifyBuiltArtifact,
} from "../forks/pi-subagents/scripts/verify-build.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realForksFile = path.join(repoRoot, "forks.txt");
const deployScript = path.join(repoRoot, "scripts", "deploy-fork.mjs");
const realVerifyScript = path.join(repoRoot, "forks", "pi-subagents", "scripts", "verify-build.mjs");
const packageName = "pi-subagents";
const scratchBase = process.env.PI_SANDBOX_SCRATCH ?? fs.mkdtempSync(path.join(os.tmpdir(), "adripi-deploy-"));

let caseCounter = 0;

function makeCase() {
	caseCounter += 1;
	const directory = fs.mkdtempSync(path.join(scratchBase, `deploy-fork-${caseCounter}-`));
	return { directory, forksFile: path.join(directory, "forks.txt"), npmRoot: path.join(directory, "npm", "node_modules") };
}

function removeCase(directory) {
	fs.rmSync(directory, { recursive: true, force: true });
}

function writeFiles(root, files) {
	for (const [relativePath, content] of Object.entries(files)) {
		const absolutePath = path.join(root, ...relativePath.split("/"));
		fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
		fs.writeFileSync(absolutePath, content);
	}
}

function json(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

/** Records files by content, directories, and symlinks by target, so any mutation is visible. */
function snapshotTree(root) {
	const snapshot = new Map();
	if (!fs.existsSync(root) && !isSymlink(root)) return snapshot;
	const pending = [""];
	while (pending.length > 0) {
		const current = pending.pop();
		const directory = current ? path.join(root, ...current.split("/")) : root;
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const relativePath = current ? `${current}/${entry.name}` : entry.name;
			const absolutePath = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) {
				snapshot.set(relativePath, `symlink:${fs.readlinkSync(absolutePath)}`);
				continue;
			}
			if (entry.isDirectory()) {
				snapshot.set(`${relativePath}/`, "directory");
				pending.push(relativePath);
				continue;
			}
			snapshot.set(relativePath, sha256(fs.readFileSync(absolutePath)));
		}
	}
	return snapshot;
}

function isSymlink(absolutePath) {
	try {
		return fs.lstatSync(absolutePath).isSymbolicLink();
	} catch {
		return false;
	}
}

function assertTreeUnchanged(root, before) {
	assert.deepEqual([...snapshotTree(root)].sort(), [...before].sort());
}

function packageManifests({ version = "0.81.0", dependencies = { acorn: "8.18.0" }, extraExports = {} } = {}) {
	const peerDependencies = { "@earendil-works/pi-ai": ">=1.2.0" };
	const peerDependenciesMeta = { "@earendil-works/pi-ai": { optional: true } };
	const sourceExports = { ".": "./index.ts", "./agents": "./src/api/agents.ts", ...extraExports };
	const bundleExports = Object.fromEntries(
		Object.entries(sourceExports).map(([name, target]) => {
			const bundleName = name === "." ? "index" : name.slice(2);
			return [name, { types: `${target.slice(0, -3)}.d.ts`, default: `./bundle/${bundleName}.js` }];
		}),
	);
	const installedExports = Object.fromEntries(
		Object.entries(bundleExports).filter(([name]) => !(name in extraExports)),
	);
	const shared = {
		type: "module",
		name: packageName,
		version,
		description: "fixture package",
		bin: { "pi-subagents": "install.mjs" },
		dependencies,
		peerDependencies,
		peerDependenciesMeta,
		pi: { extensions: ["./bundle/index.js"], skills: ["./skills"], prompts: ["./prompts"] },
	};
	const source = {
		...shared,
		private: true,
		bin: shared.bin,
		exports: sourceExports,
		pi: { extensions: ["./index.ts"], skills: ["./skills"], prompts: ["./prompts"] },
	};
	const built = { ...shared, types: "./index.d.ts", exports: bundleExports };
	const installed = {
		...shared,
		keywords: ["pi-package", "fixture"],
		homepage: "https://example.invalid/pi-subagents",
		repository: { type: "git", url: "git+https://example.invalid/pi-subagents.git" },
		types: "./index.d.ts",
		exports: installedExports,
	};
	return { source, built, installed };
}

/** Creates `<root>/forks/<name>` with every input the build fingerprint requires. */
function createForkFixture(root, options = {}) {
	const forkRoot = path.join(root, "forks", packageName);
	const { source } = packageManifests(options);
	writeFiles(forkRoot, {
		"package.json": json(source),
		"package-lock.json": json({ lockfileVersion: 3, name: packageName, version: options.version ?? "0.81.0" }),
		"tsconfig.json": "{\n  \"compilerOptions\": {}\n}\n",
		"tsconfig.build.json": "{\n  \"extends\": \"./tsconfig.json\"\n}\n",
		"index.ts": "export default function register() {}\n",
		"src/api/agents.ts": "export const agents = [];\n",
		"src/api/runtime-path.ts": "export const runnerUrl = new URL(\"../../../runner-peer-preload.mjs\", import.meta.url);\n",
		"src/types/pi-runtime-compat.d.ts": "declare module \"fixture\" {}\n",
		"agents/worker.md": "# worker\n",
		"skills/demo/SKILL.md": "# demo skill\n",
		"prompts/demo.md": "# demo prompt\n",
		"docs/demo.md": "# demo docs\n",
		"README.md": "# readme\n",
		"CHANGELOG.md": "# changelog\n",
		"LICENSE": "MIT\n",
		"scripts/build-package.mjs": "// fixture stand-in for the upstream builder\n",
		"scripts/verify-build.mjs": "// replaced with the real verifier below\n",
		"node_modules/typescript/bin/tsc": "// fixture marker for the provisioned compiler\n",
		"node_modules/esbuild/package.json": json({ name: "esbuild" }),
	});
	for (const moduleName of REQUIRED_ROOT_MODULES) writeFiles(forkRoot, { [moduleName]: "export {};\n" });
	for (const target of Object.values(source.exports)) {
		if (!target.startsWith("./src/")) continue;
		const relativePath = target.slice(2);
		if (!fs.existsSync(path.join(forkRoot, ...relativePath.split("/")))) {
			writeFiles(forkRoot, { [relativePath]: "export {};\n" });
		}
	}
	// Deploy mode imports the fork's verifier, so the fixture must carry the real implementation.
	fs.copyFileSync(realVerifyScript, path.join(forkRoot, "scripts", "verify-build.mjs"));
	return forkRoot;
}

/** Creates `<fork>/dist-pkg` as a valid build of the fixture fork (unstamped unless asked). */
function createDistFixture(forkRoot, { options = {}, stamp = true } = {}) {
	const distDir = path.join(forkRoot, "dist-pkg");
	const { built } = packageManifests(options);
	writeFiles(distDir, {
		"package.json": json(built),
		"index.js": "export default function register() {}\n",
		"index.d.ts": "export default function register(): void;\n",
		"src/api/agents.js": "export const agents = [];\n",
		"src/api/agents.d.ts": "export declare const agents: unknown[];\n",
		"src/api/runtime-path.js": "export const runnerUrl = new URL(\"../../../runner-peer-preload.mjs\", import.meta.url);\n",
		"src/api/runtime-path.d.ts": "export declare const runnerUrl: URL;\n",
		"bundle/index.js": "export const entry = new URL(\"../src/api/agents.js\", import.meta.url);\n",
		"bundle/agents.js": "export const agents = [];\n",
		"bundle/chunk-AAAA.js": "export const chunk = new URL(\"../src/api/agents.js\", import.meta.url);\n",
		"agents/worker.md": "# worker\n",
		"skills/demo/SKILL.md": "# demo skill\n",
		"prompts/demo.md": "# demo prompt\n",
		"docs/demo.md": "# demo docs\n",
		"README.md": "# readme\n",
		"CHANGELOG.md": "# changelog\n",
		"LICENSE": "MIT\n",
	});
	for (const moduleName of REQUIRED_ROOT_MODULES) writeFiles(distDir, { [moduleName]: "export {};\n" });
	for (const [name, value] of Object.entries(built.exports)) {
		const bundleName = name === "." ? "index" : name.slice(2);
		if (!fs.existsSync(path.join(distDir, ...value.types.slice(2).split("/")))) {
			writeFiles(distDir, { [value.types.slice(2)]: "export {};\n" });
		}
		if (!fs.existsSync(path.join(distDir, "bundle", `${bundleName}.js`))) {
			writeFiles(distDir, { [`bundle/${bundleName}.js`]: "export {};\n" });
		}
		if (value.types.startsWith("./src/")) {
			const base = value.types.slice(2, -".d.ts".length);
			if (!fs.existsSync(path.join(distDir, ...`${base}.js`.split("/")))) {
				writeFiles(distDir, { [`${base}.js`]: "export {};\n", [`${base}.d.ts`]: "export {};\n" });
			}
		}
	}
	if (stamp) stampBuild({ root: forkRoot, distDir });
	return distDir;
}

/** Writes the compiled npm install the built deploy maps onto, with unmanaged sentinels. */
function writeInstalledFiles(target, options = {}) {
	const { installed } = packageManifests(options);
	writeFiles(target, {
		"package.json": json(installed),
		"index.js": "// installed index\n",
		"index.d.ts": "// installed declaration\n",
		"src/api/agents.js": "// installed agents\n",
		"src/api/agents.d.ts": "// installed agents declaration\n",
		"src/legacy.ts": "// leftover from an old source overlay\n",
		"bundle/index.js": "// installed bundle\n",
		"bundle/agents.js": "// installed agents bundle\n",
		"bundle/chunk-OLD.js": "// stale chunk from an older build\n",
		"agents/worker.md": "# old worker\n",
		"skills/demo/SKILL.md": "# old skill\n",
		"prompts/demo.md": "# old prompt\n",
		"docs/demo.md": "# old docs\n",
		"README.md": "# old readme\n",
		"CHANGELOG.md": "# old changelog\n",
		"LICENSE": "MIT\n",
		"node_modules/sentinel/package.json": json({ name: "sentinel" }),
		"unmanaged/keep.txt": "keep me\n",
		"unmanaged/nested/keep.txt": "keep me too\n",
	});
	return target;
}

function createInstalledFixture(npmRoot, options = {}) {
	return writeInstalledFiles(path.join(npmRoot, packageName), options);
}

/** A pnpm-shaped install: `node_modules/<pkg>` is a symlink into the store. */
function createPnpmInstalledFixture(npmRoot, options = {}) {
	const storeDir = path.join(npmRoot, ".pnpm", `${packageName}@0.81.0`, "node_modules", packageName);
	writeInstalledFiles(storeDir, options);
	fs.mkdirSync(npmRoot, { recursive: true });
	fs.symlinkSync(path.relative(npmRoot, storeDir), path.join(npmRoot, packageName), "dir");
	return { storeDir, linkPath: path.join(npmRoot, packageName) };
}

function builtEntry(overrides = {}) {
	return { packageName, forkDir: path.join("forks", packageName), mode: "built", line: 1, ...overrides };
}

function readManifest(target) {
	return JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
}

function assertBuiltDeployed({ target, distDir, previousManifest, expectedAdded = [] }) {
	assert.ok(fs.existsSync(path.join(target, "bundle", "index.js")));
	assert.equal(fs.readFileSync(path.join(target, "bundle", "chunk-AAAA.js"), "utf8"), fs.readFileSync(path.join(distDir, "bundle", "chunk-AAAA.js"), "utf8"));
	assert.ok(!fs.existsSync(path.join(target, "bundle", "chunk-OLD.js")), "stale bundle chunk must be deleted");
	assert.ok(!fs.existsSync(path.join(target, "src", "legacy.ts")), "plain TypeScript residue must be deleted");
	assert.equal(fs.readFileSync(path.join(target, "src", "api", "agents.js"), "utf8"), "export const agents = [];\n");
	assert.equal(fs.readFileSync(path.join(target, "README.md"), "utf8"), "# readme\n");
	for (const moduleName of REQUIRED_ROOT_MODULES) assert.ok(fs.existsSync(path.join(target, moduleName)), `${moduleName} must be deployed`);
	assert.ok(!fs.existsSync(path.join(target, BUILD_STAMP_FILE)), "the build stamp describes the build, not the install");
	// Unmanaged paths survive.
	assert.equal(fs.readFileSync(path.join(target, "node_modules", "sentinel", "package.json"), "utf8"), json({ name: "sentinel" }));
	assert.equal(fs.readFileSync(path.join(target, "unmanaged", "keep.txt"), "utf8"), "keep me\n");
	assert.equal(fs.readFileSync(path.join(target, "unmanaged", "nested", "keep.txt"), "utf8"), "keep me too\n");
	// Installed manifest fields survive; only the export map grows.
	const manifest = readManifest(target);
	const added = expectedAdded.slice().sort();
	assert.deepEqual(Object.keys(manifest.exports).sort(), [...Object.keys(previousManifest.exports), ...added].sort());
	for (const [name, value] of Object.entries(previousManifest.exports)) {
		assert.deepEqual(manifest.exports[name], value, `export ${name} must keep the installed shape`);
	}
	const preserved = { ...manifest };
	delete preserved.exports;
	const previous = { ...previousManifest };
	delete previous.exports;
	assert.deepEqual(preserved, previous, "manifest fields outside exports must not change");
}

test("parseForksFile: the shipped forks.txt declares an explicit mode per fork", () => {
	const entries = parseForksFile(fs.readFileSync(realForksFile, "utf8"), "forks.txt");
	assert.deepEqual(
		entries.map((entry) => [entry.packageName, entry.forkDir, entry.mode]),
		[
			["pi-guardian", "forks/pi-guardian", "source"],
			["pi-sbx", "forks/pi-sbx", "source"],
			[packageName, "forks/pi-subagents", "built"],
		],
	);
});

test("parseForksFile: a line without a mode is refused", () => {
	assert.throws(() => parseForksFile("pi-sbx|forks/pi-sbx"), /forks\.txt:1: expected/);
});

test("parseForksFile: an unknown mode is refused", () => {
	assert.throws(() => parseForksFile("pi-sbx|forks/pi-sbx|overlay"), /unknown deployment mode "overlay"/);
});

test("parseForksFile: an empty list is refused", () => {
	assert.throws(() => parseForksFile("# nothing here\n"), /no fork entries/);
});

test("source mode mirrors the fork src and removes files the fork dropped", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = path.join(fixture.directory, "forks", "pi-sbx");
	writeFiles(forkRoot, {
		"package.json": json({ name: "pi-sbx", version: "0.2.0" }),
		"src/index.ts": "export const current = true;\n",
	});
	const target = path.join(fixture.npmRoot, "pi-sbx");
	writeFiles(target, {
		"package.json": json({ name: "pi-sbx", version: "0.1.3" }),
		"src/index.ts": "export const current = false;\n",
		"src/removed.ts": "export const gone = true;\n",
		"other/keep.txt": "keep\n",
	});
	const plan = await planForkDeploy({
		entry: { packageName: "pi-sbx", forkDir: "forks/pi-sbx", mode: "source", line: 1 },
		repoRoot: fixture.directory,
		npmRoot: fixture.npmRoot,
	});
	const result = applyForkDeploy(plan);
	assert.equal(result.mode, "source");
	assert.equal(fs.readFileSync(path.join(target, "src", "index.ts"), "utf8"), "export const current = true;\n");
	assert.ok(!fs.existsSync(path.join(target, "src", "removed.ts")));
	assert.equal(fs.readFileSync(path.join(target, "other", "keep.txt"), "utf8"), "keep\n");
	// Source mode reports a version difference instead of refusing: the fork carries newer upstream source.
	assert.deepEqual(result.notes, [
		"note: npm has pi-sbx@0.1.3, fork is 0.2.0",
		"      (a vendored fork may carry newer upstream source; see VENDOR.md)",
	]);
});

test("source mode refuses a fork without src", async () => {
	const fixture = makeCase();
	try {
		writeFiles(path.join(fixture.directory, "forks", "pi-sbx"), { "package.json": json({ name: "pi-sbx", version: "0.2.0" }) });
		writeFiles(path.join(fixture.npmRoot, "pi-sbx"), { "package.json": json({ name: "pi-sbx", version: "0.1.3" }) });
		await assert.rejects(
			planForkDeploy({
				entry: { packageName: "pi-sbx", forkDir: "forks/pi-sbx", mode: "source", line: 1 },
				repoRoot: fixture.directory,
				npmRoot: fixture.npmRoot,
			}),
			/forks\/pi-sbx\/src is missing/,
		);
	} finally {
		removeCase(fixture.directory);
	}
});

test("source mode refuses a symlinked fork src before deleting anything in the install", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const outside = path.join(fixture.directory, "outside");
	writeFiles(outside, { "index.ts": "export const outside = true;\n" });
	const forkRoot = path.join(fixture.directory, "forks", "pi-sbx");
	writeFiles(forkRoot, { "package.json": json({ name: "pi-sbx", version: "0.2.0" }) });
	fs.mkdirSync(forkRoot, { recursive: true });
	fs.symlinkSync(outside, path.join(forkRoot, "src"), "dir");
	const target = path.join(fixture.npmRoot, "pi-sbx");
	writeFiles(target, {
		"package.json": json({ name: "pi-sbx", version: "0.1.3" }),
		"src/index.ts": "export const current = false;\n",
		"src/removed.ts": "export const stale = true;\n",
	});
	const before = snapshotTree(target);
	await assert.rejects(
		planForkDeploy({
			entry: { packageName: "pi-sbx", forkDir: "forks/pi-sbx", mode: "source", line: 1 },
			repoRoot: fixture.directory,
			npmRoot: fixture.npmRoot,
		}),
		/forks\/pi-sbx\/src is missing or not a directory/,
	);
	// Nothing was deleted: the stale file is still there because the source was refused first.
	assertTreeUnchanged(target, before);
	assert.ok(fs.existsSync(path.join(outside, "index.ts")));
});

test("source mode refuses a symlink inside the fork src without deleting install entries", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const outside = path.join(fixture.directory, "outside");
	writeFiles(outside, { "linked.ts": "export const outside = true;\n" });
	const forkRoot = path.join(fixture.directory, "forks", "pi-sbx");
	writeFiles(forkRoot, {
		"package.json": json({ name: "pi-sbx", version: "0.2.0" }),
		"src/index.ts": "export const current = true;\n",
	});
	fs.symlinkSync(path.join(outside, "linked.ts"), path.join(forkRoot, "src", "linked.ts"));
	const target = path.join(fixture.npmRoot, "pi-sbx");
	writeFiles(target, {
		"package.json": json({ name: "pi-sbx", version: "0.1.3" }),
		"src/index.ts": "export const current = false;\n",
		"src/removed.ts": "export const stale = true;\n",
	});
	const before = snapshotTree(target);
	await assert.rejects(
		planForkDeploy({
			entry: { packageName: "pi-sbx", forkDir: "forks/pi-sbx", mode: "source", line: 1 },
			repoRoot: fixture.directory,
			npmRoot: fixture.npmRoot,
		}),
		/forks\/pi-sbx\/src\/linked\.ts is a symlink/,
	);
	assertTreeUnchanged(target, before);
	assertTreeUnchanged(outside, snapshotTree(outside));
});

test("built mode deploys the compiled graph and leaves unmanaged paths alone", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot);
	const target = createInstalledFixture(fixture.npmRoot);
	const previousManifest = readManifest(target);
	const plan = await planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot });
	applyForkDeploy(plan);
	assertBuiltDeployed({ target, distDir, previousManifest });
});

test("built mode merges only the new public exports the build produced", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const options = { extraExports: { "./child-authority": "./src/api/child-authority.ts" } };
	const forkRoot = createForkFixture(fixture.directory, options);
	const distDir = createDistFixture(forkRoot, { options });
	const target = createInstalledFixture(fixture.npmRoot, options);
	const previousManifest = readManifest(target);
	const plan = await planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot });
	assert.deepEqual(plan.exportsAdded, ["./child-authority"]);
	const previousKeys = Object.keys(previousManifest.exports);
	applyForkDeploy(plan);
	assertBuiltDeployed({ target, distDir, previousManifest, expectedAdded: ["./child-authority"] });
	// New keys are appended after the installed ones so the diff is one added entry.
	assert.deepEqual(Object.keys(readManifest(target).exports).slice(0, previousKeys.length), previousKeys);
	assert.deepEqual(readManifest(target).exports["./child-authority"], {
		types: "./src/api/child-authority.d.ts",
		default: "./bundle/child-authority.js",
	});
	assert.ok(fs.existsSync(path.join(target, "src", "api", "child-authority.js")));
	assert.ok(fs.existsSync(path.join(target, "bundle", "child-authority.js")));
});

test("built mode is idempotent: a second deploy leaves package.json byte-identical", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	const target = createInstalledFixture(fixture.npmRoot);
	const deploy = async () => applyForkDeploy(await planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }));
	await deploy();
	const firstManifest = fs.readFileSync(path.join(target, "package.json"), "utf8");
	const firstTree = snapshotTree(target);
	await deploy();
	assert.equal(fs.readFileSync(path.join(target, "package.json"), "utf8"), firstManifest);
	assert.deepEqual([...snapshotTree(target)].sort(), [...firstTree].sort());
});

test("built mode deploys through a pnpm package-root symlink and keeps the link", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot);
	const { storeDir, linkPath } = createPnpmInstalledFixture(fixture.npmRoot);
	const previousManifest = readManifest(linkPath);
	const plan = await planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot });
	// The plan resolves the package link once; writes land in the real package directory.
	assert.equal(plan.targetDir, fs.realpathSync(storeDir));
	applyForkDeploy(plan);
	assert.ok(isSymlink(linkPath), "the pnpm package-root symlink must survive");
	assertBuiltDeployed({ target: linkPath, distDir, previousManifest });
});

test("built mode preserves unmanaged symlinks in the install", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	const target = createInstalledFixture(fixture.npmRoot);
	const outside = path.join(fixture.directory, "outside");
	writeFiles(outside, { "dep.js": "export {};\n" });
	fs.rmSync(path.join(target, "node_modules"), { recursive: true, force: true });
	fs.symlinkSync(outside, path.join(target, "node_modules"), "dir");
	fs.symlinkSync(path.join(outside, "dep.js"), path.join(target, ".unmanaged-link"), "file");
	const before = snapshotTree(outside);
	const plan = await planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot });
	applyForkDeploy(plan);
	assert.ok(isSymlink(path.join(target, "node_modules")), "unmanaged node_modules symlink must survive");
	assert.ok(isSymlink(path.join(target, ".unmanaged-link")), "unmanaged symlink must survive");
	assert.equal(fs.readlinkSync(path.join(target, "node_modules")), outside);
	assertTreeUnchanged(outside, before);
});

test("built mode refuses a managed-subtree symlink pointing outside the package", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	const target = createInstalledFixture(fixture.npmRoot);
	const outside = path.join(fixture.directory, "outside");
	writeFiles(outside, { "demo.md": "// outside docs\n", "keep.txt": "outside sentinel\n" });
	fs.rmSync(path.join(target, "docs"), { recursive: true, force: true });
	fs.symlinkSync(outside, path.join(target, "docs"), "dir");
	const outsideBefore = snapshotTree(outside);
	const before = snapshotTree(target);
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }),
		/pi-subagents\/docs is a symlink/,
	);
	assertTreeUnchanged(outside, outsideBefore);
	assertTreeUnchanged(target, before);
});

test("built mode refuses a symlinked compiled layout directory", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	const target = createInstalledFixture(fixture.npmRoot);
	const outside = path.join(fixture.directory, "outside");
	writeFiles(outside, { "index.js": "// outside bundle\n" });
	fs.rmSync(path.join(target, "bundle"), { recursive: true, force: true });
	fs.symlinkSync(outside, path.join(target, "bundle"), "dir");
	const outsideBefore = snapshotTree(outside);
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }),
		/has no bundle\/ directory; built mode deploys onto the compiled npm layout only/,
	);
	assertTreeUnchanged(outside, outsideBefore);
});

test("built mode refuses a type conflict before deleting anything", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	const target = createInstalledFixture(fixture.npmRoot);
	// The build has `src/api/` as a directory; the install has a file in that place.
	fs.rmSync(path.join(target, "src", "api"), { recursive: true, force: true });
	fs.writeFileSync(path.join(target, "src", "api"), "not a directory\n");
	const before = snapshotTree(target);
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }),
		/the build has a directory where the install has a file/,
	);
	assertTreeUnchanged(target, before);
});

test("built mode never mutates a hardlinked store inode", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const options = { extraExports: { "./child-authority": "./src/api/child-authority.ts" } };
	const forkRoot = createForkFixture(fixture.directory, options);
	createDistFixture(forkRoot, { options });
	const target = createInstalledFixture(fixture.npmRoot, options);
	const store = path.join(fixture.directory, "store");
	writeFiles(store, {
		"package.json": fs.readFileSync(path.join(target, "package.json"), "utf8"),
		"readme.md": "# store readme\n",
	});
	// A pnpm-style store hardlinks package files; the install shares those inodes.
	for (const [stored, installed] of [["package.json", "package.json"], ["readme.md", "README.md"]]) {
		fs.rmSync(path.join(target, installed));
		fs.linkSync(path.join(store, stored), path.join(target, installed));
	}
	const storeBefore = snapshotTree(store);
	const plan = await planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot });
	applyForkDeploy(plan);
	assertTreeUnchanged(store, storeBefore);
	assert.notEqual(fs.statSync(path.join(target, "README.md")).ino, fs.statSync(path.join(store, "readme.md")).ino, "the deploy must replace the inode, not truncate it");
	assert.equal(fs.readFileSync(path.join(target, "README.md"), "utf8"), "# readme\n");
	assert.deepEqual(readManifest(target).exports["./child-authority"], {
		types: "./src/api/child-authority.d.ts",
		default: "./bundle/child-authority.js",
	});
});

test("built mode refuses to write through a symlinked install root file", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	const target = createInstalledFixture(fixture.npmRoot);
	const outside = path.join(fixture.directory, "outside-readme.md");
	writeFiles(fixture.directory, { "outside-readme.md": "# outside sentinel\n" });
	fs.rmSync(path.join(target, "README.md"));
	fs.symlinkSync(outside, path.join(target, "README.md"), "file");
	const outsideBefore = snapshotTree(fixture.directory);
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }),
		/README\.md in the install is a symlink; refusing to replace it/,
	);
	assert.equal(fs.readFileSync(outside, "utf8"), "# outside sentinel\n");
	assertTreeUnchanged(fixture.directory, outsideBefore);
});

test("built mode refuses to write through a symlinked install manifest", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	const target = createInstalledFixture(fixture.npmRoot);
	const outsideManifest = path.join(fixture.directory, "outside-package.json");
	writeFiles(fixture.directory, { "outside-package.json": fs.readFileSync(path.join(target, "package.json"), "utf8") });
	const originalManifest = fs.readFileSync(outsideManifest, "utf8");
	fs.rmSync(path.join(target, "package.json"));
	fs.symlinkSync(outsideManifest, path.join(target, "package.json"), "file");
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }),
		/package\.json is a symlink; refusing to deploy through it/,
	);
	assert.equal(fs.readFileSync(outsideManifest, "utf8"), originalManifest);
});

test("apply re-checks the planned install tree before writing", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	const target = createInstalledFixture(fixture.npmRoot);
	const plan = await planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot });
	// Something else writes the install between planning and applying.
	writeFiles(target, { "src/sneaky.txt": "written after planning\n" });
	assert.throws(() => applyForkDeploy(plan), (error) => error.message.includes(`${path.join(target, "src")} changed between planning and writing`));
	assert.ok(fs.existsSync(path.join(target, "src", "sneaky.txt")));
	assert.ok(fs.existsSync(path.join(target, "bundle", "chunk-OLD.js")), "no deletion may happen after a failed re-check");
	assert.ok(!fs.existsSync(path.join(target, "bundle", "chunk-AAAA.js")), "no copy may happen after a failed re-check");
});

for (const file of ["package.json", "README.md", "index.js"]) {
	test(`apply re-checks installed root file ${file} before writing`, async (t) => {
		const fixture = makeCase();
		t.after(() => removeCase(fixture.directory));
		const forkRoot = createForkFixture(fixture.directory);
		createDistFixture(forkRoot);
		const target = createInstalledFixture(fixture.npmRoot);
		const plan = await planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot });
		writeFiles(target, { [file]: "changed after planning\n" });
		const before = snapshotTree(target);
		assert.throws(() => applyForkDeploy(plan), (error) => error.message.includes(`${path.join(target, file)} changed between planning and writing`));
		assertTreeUnchanged(target, before);
	});
}

test("apply re-checks the build artifact before writing", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot);
	const target = createInstalledFixture(fixture.npmRoot);
	const plan = await planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot });
	writeFiles(distDir, { "bundle/agents.js": "// edited after planning\n" });
	const before = snapshotTree(target);
	assert.throws(() => applyForkDeploy(plan), /build output was edited after the build/);
	assertTreeUnchanged(target, before);
});

test("apply re-checks the planned source tree before writing", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = path.join(fixture.directory, "forks", "pi-sbx");
	writeFiles(forkRoot, { "package.json": json({ name: "pi-sbx", version: "0.2.0" }), "src/index.ts": "export const value = 1;\n" });
	const target = path.join(fixture.npmRoot, "pi-sbx");
	writeFiles(target, { "package.json": json({ name: "pi-sbx", version: "0.1.3" }), "src/index.ts": "export const value = 0;\n" });
	const plan = await planForkDeploy({
		entry: { packageName: "pi-sbx", forkDir: "forks/pi-sbx", mode: "source", line: 1 },
		repoRoot: fixture.directory,
		npmRoot: fixture.npmRoot,
	});
	writeFiles(forkRoot, { "src/index.ts": "export const value = 2;\n" });
	assert.throws(() => applyForkDeploy(plan), /forks\/pi-sbx\/src changed between planning and writing/);
	assert.equal(fs.readFileSync(path.join(target, "src", "index.ts"), "utf8"), "export const value = 0;\n");
});

test("preflight refuses a symlinked build output directory", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot);
	const elsewhere = path.join(fixture.directory, "moved-dist");
	fs.renameSync(distDir, elsewhere);
	fs.symlinkSync(elsewhere, distDir, "dir");
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot, allowMissingTarget: true }),
		/dist-pkg is a symlink; refusing to verify a linked build output/,
	);
});

test("deploy refuses a symlinked fork manifest instead of reading through it", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = path.join(fixture.directory, "forks", "pi-sbx");
	writeFiles(forkRoot, { "src/index.ts": "export const value = 1;\n" });
	const outside = path.join(fixture.directory, "outside-package.json");
	writeFiles(fixture.directory, { "outside-package.json": json({ name: "pi-sbx", version: "0.2.0" }) });
	fs.symlinkSync(outside, path.join(forkRoot, "package.json"), "file");
	writeFiles(path.join(fixture.npmRoot, "pi-sbx"), { "package.json": json({ name: "pi-sbx", version: "0.1.3" }) });
	await assert.rejects(
		planForkDeploy({
			entry: { packageName: "pi-sbx", forkDir: "forks/pi-sbx", mode: "source", line: 1 },
			repoRoot: fixture.directory,
			npmRoot: fixture.npmRoot,
		}),
		/forks\/pi-sbx\/package\.json is a symlink; refusing to read a manifest through it/,
	);
});

test("a failed write leaves no temporary sibling and does not touch the failed subtree", async (t) => {
	const fixture = makeCase();
	t.after(() => {
		try {
			fs.chmodSync(path.join(fixture.npmRoot, packageName, "bundle"), 0o755);
		} catch {
			// the fixture may already be gone
		}
		removeCase(fixture.directory);
	});
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	const target = createInstalledFixture(fixture.npmRoot);
	const plan = await planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot });
	// Make the first managed subtree unwritable so the write fails after planning.
	fs.chmodSync(path.join(target, "bundle"), 0o500);
	assert.throws(() => applyForkDeploy(plan), /EACCES|EPERM/);
	assert.equal(fs.readFileSync(path.join(target, "bundle", "index.js"), "utf8"), "// installed bundle\n");
	assert.deepEqual(
		[...snapshotTree(target).keys()].filter((relativePath) => relativePath.includes(".adripi-tmp")),
		[],
		"a failed write must not leave a temporary sibling behind",
	);
	fs.chmodSync(path.join(target, "bundle"), 0o755);
	assert.ok(!fs.existsSync(path.join(target, "bundle", "chunk-AAAA.js")));
});

test("built mode refuses a missing build before writing anything", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	createForkFixture(fixture.directory);
	const target = createInstalledFixture(fixture.npmRoot);
	const before = snapshotTree(target);
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }),
		/missing build output at .*dist-pkg; run node scripts\/build-subagents\.mjs/,
	);
	assertTreeUnchanged(target, before);
});

test("built mode refuses an unstamped build: existence alone is not freshness", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot, { stamp: false });
	const target = createInstalledFixture(fixture.npmRoot);
	const before = snapshotTree(target);
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }),
		new RegExp(`build stamp dist-pkg/${BUILD_STAMP_FILE.replace(/\./g, "\\.")} is missing`),
	);
	assertTreeUnchanged(target, before);
	assert.ok(fs.existsSync(path.join(distDir, "bundle", "index.js")));
});

test("built mode refuses a stale build before writing anything", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	// Editing a compiled source input after the build must invalidate the artifact.
	writeFiles(forkRoot, { "src/api/agents.ts": "export const agents = [1];\n" });
	const target = createInstalledFixture(fixture.npmRoot);
	const before = snapshotTree(target);
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }),
		/artifact is stale: 1 source input change\(s\) since the build \(src\/api\/agents\.ts \(changed\)\)/,
	);
	assertTreeUnchanged(target, before);
});

test("built mode refuses an edited build output before writing anything", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot);
	writeFiles(distDir, { "bundle/agents.js": "// hand-edited after the build\n" });
	const target = createInstalledFixture(fixture.npmRoot);
	const before = snapshotTree(target);
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }),
		/build output was edited after the build: bundle\/agents\.js/,
	);
	assertTreeUnchanged(target, before);
});

test("built mode refuses version skew before writing anything", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory, { version: "0.82.0" });
	createDistFixture(forkRoot, { options: { version: "0.82.0" } });
	const target = createInstalledFixture(fixture.npmRoot);
	const before = snapshotTree(target);
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }),
		/version skew: the build is 0\.82\.0 but npm installed "0\.81\.0"/,
	);
	assertTreeUnchanged(target, before);
});

test("built mode refuses runtime dependency skew before writing anything", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory, { dependencies: { acorn: "9.0.0" } });
	createDistFixture(forkRoot, { options: { dependencies: { acorn: "9.0.0" } } });
	const target = createInstalledFixture(fixture.npmRoot);
	const before = snapshotTree(target);
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }),
		/dependencies skew: the build expects \{"acorn":"9\.0\.0"\} but the install has \{"acorn":"8\.18\.0"\}/,
	);
	assertTreeUnchanged(target, before);
});

test("built mode refuses extension layout skew before writing anything", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	const target = createInstalledFixture(fixture.npmRoot);
	// An install that loads a different entry cannot be served by this build.
	const manifestPath = path.join(target, "package.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	manifest.pi.extensions = ["./index.js"];
	fs.writeFileSync(manifestPath, json(manifest));
	const before = snapshotTree(target);
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }),
		/pi\.extensions skew/,
	);
	assertTreeUnchanged(target, before);
});

test("built mode refuses an installed export the build does not produce", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	const target = createInstalledFixture(fixture.npmRoot);
	const manifestPath = path.join(target, "package.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	manifest.exports["./retired"] = { types: "./src/api/retired.d.ts", default: "./bundle/retired.js" };
	fs.writeFileSync(manifestPath, json(manifest));
	const before = snapshotTree(target);
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }),
		/exports \.\/retired which the build does not produce/,
	);
	assertTreeUnchanged(target, before);
});

test("built mode refuses to replace an installed export shape", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	const target = createInstalledFixture(fixture.npmRoot);
	const manifestPath = path.join(target, "package.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	manifest.exports["./agents"] = { types: "./src/api/agents.d.ts", default: "./bundle/agents-legacy.js" };
	fs.writeFileSync(manifestPath, json(manifest));
	const before = snapshotTree(target);
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }),
		/export "\.\/agents" differs between the installed package/,
	);
	assertTreeUnchanged(target, before);
});

test("built mode refuses an install that is not the compiled npm layout", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	const target = createInstalledFixture(fixture.npmRoot);
	fs.rmSync(path.join(target, "bundle"), { recursive: true, force: true });
	const before = snapshotTree(target);
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }),
		/has no bundle\/ directory; built mode deploys onto the compiled npm layout only/,
	);
	assertTreeUnchanged(target, before);
});

test("built mode refuses an unexpected directory in the build output", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot);
	writeFiles(distDir, { "tests/fixture.js": "export {};\n" });
	const target = createInstalledFixture(fixture.npmRoot);
	const before = snapshotTree(target);
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }),
		/unexpected directory in the build output: tests/,
	);
	assertTreeUnchanged(target, before);
});

test("deploy refuses a package that is not installed", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	await assert.rejects(
		planForkDeploy({ entry: builtEntry(), repoRoot: fixture.directory, npmRoot: fixture.npmRoot }),
		/pi-subagents is not installed under .*; install the package before deploying the fork/,
	);
});

test("preflight accepts a fresh build before the package exists", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	fs.writeFileSync(fixture.forksFile, `${packageName}|forks/${packageName}|built\n`);
	const messages = [];
	await runForkCommand({ command: "preflight", forksFile: fixture.forksFile, npmRoot: fixture.npmRoot, log: (line) => messages.push(line) });
	assert.deepEqual(messages, [
		`   preflight ok: pi-subagents (built 0.81.0, artifact fresh) will deploy after the package install`,
	]);
});

test("preflight accepts an older install: the pin upgrade is what installs it", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	// packages.txt/fork/artifact are aligned at 0.82.0; the install still has 0.81.0 because
	// `pi install` has not run yet. Preflight must not block that upgrade.
	const forkRoot = createForkFixture(fixture.directory, { version: "0.82.0" });
	createDistFixture(forkRoot, { options: { version: "0.82.0" } });
	const target = createInstalledFixture(fixture.npmRoot);
	const installedBefore = fs.readFileSync(path.join(target, "package.json"), "utf8");
	fs.writeFileSync(fixture.forksFile, `${packageName}|forks/${packageName}|built\n`);
	const messages = [];
	await runForkCommand({ command: "preflight", forksFile: fixture.forksFile, npmRoot: fixture.npmRoot, log: (line) => messages.push(line) });
	assert.deepEqual(messages, [
		`   preflight ok: pi-subagents (built 0.82.0, artifact fresh) will deploy after the package install`,
	]);
	assert.equal(fs.readFileSync(path.join(target, "package.json"), "utf8"), installedBefore);
	// Deploy (after pi install) is where the installed version must match.
	await assert.rejects(
		runForkCommand({ command: "deploy", forksFile: fixture.forksFile, npmRoot: fixture.npmRoot, log: () => {} }),
		/version skew: the build is 0\.82\.0 but npm installed "0\.81\.0"/,
	);
	assert.equal(fs.readFileSync(path.join(target, "package.json"), "utf8"), installedBefore);
	// Once the install matches, the same deploy succeeds.
	const manifestPath = path.join(target, "package.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	manifest.version = "0.82.0";
	fs.writeFileSync(manifestPath, json(manifest));
	await runForkCommand({ command: "deploy", forksFile: fixture.forksFile, npmRoot: fixture.npmRoot, log: () => {} });
	assert.equal(readManifest(target).version, "0.82.0");
	assert.ok(fs.existsSync(path.join(target, "bundle", "chunk-AAAA.js")));
});

test("preflight refuses a source fork without src before the package step", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	writeFiles(path.join(fixture.directory, "forks", "pi-sbx"), { "package.json": json({ name: "pi-sbx", version: "0.2.0" }) });
	fs.writeFileSync(fixture.forksFile, "pi-sbx|forks/pi-sbx|source\n");
	await assert.rejects(
		runForkCommand({ command: "preflight", forksFile: fixture.forksFile, npmRoot: fixture.npmRoot, log: () => {} }),
		/forks\/pi-sbx\/src is missing or not a directory; nothing to overlay/,
	);
	assert.ok(!fs.existsSync(fixture.npmRoot));
});

test("preflight refuses a stale build so install.sh stops before any package side effect", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	writeFiles(forkRoot, { "src/api/agents.ts": "export const agents = [2];\n" });
	fs.writeFileSync(fixture.forksFile, `${packageName}|forks/${packageName}|built\n`);
	await assert.rejects(
		runForkCommand({ command: "preflight", forksFile: fixture.forksFile, npmRoot: fixture.npmRoot, log: () => {} }),
		/artifact is stale/,
	);
	assert.ok(!fs.existsSync(fixture.npmRoot), "preflight must not create the package root");
});

test("deploy plans every fork before writing: a late refusal leaves earlier installs untouched", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	writeFiles(forkRoot, { "src/api/agents.ts": "export const agents = [3];\n" });
	const sourceFork = path.join(fixture.directory, "forks", "pi-sbx");
	writeFiles(sourceFork, { "package.json": json({ name: "pi-sbx", version: "0.2.0" }), "src/index.ts": "export const value = 1;\n" });
	const sbxTarget = path.join(fixture.npmRoot, "pi-sbx");
	writeFiles(sbxTarget, { "package.json": json({ name: "pi-sbx", version: "0.1.3" }), "src/index.ts": "export const value = 0;\n" });
	createInstalledFixture(fixture.npmRoot);
	fs.writeFileSync(fixture.forksFile, `pi-sbx|forks/pi-sbx|source\n${packageName}|forks/${packageName}|built\n`);
	const sbxBefore = snapshotTree(sbxTarget);
	await assert.rejects(
		runForkCommand({ command: "deploy", forksFile: fixture.forksFile, npmRoot: fixture.npmRoot, log: () => {} }),
		/artifact is stale/,
	);
	assertTreeUnchanged(sbxTarget, sbxBefore);
});

test("the deploy CLI exits non-zero and leaves the install untouched on skew", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory, { version: "0.82.0" });
	createDistFixture(forkRoot, { options: { version: "0.82.0" } });
	const target = createInstalledFixture(fixture.npmRoot);
	fs.writeFileSync(fixture.forksFile, `${packageName}|forks/${packageName}|built\n`);
	const before = snapshotTree(target);
	const result = spawnSync(
		process.execPath,
		[deployScript, "deploy", "--forks", fixture.forksFile, "--npm-root", fixture.npmRoot],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /adripi: pi-subagents version skew/);
	assertTreeUnchanged(target, before);
});

test("the deploy CLI deploys every forks.txt entry", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	const sourceFork = path.join(fixture.directory, "forks", "pi-sbx");
	writeFiles(sourceFork, { "package.json": json({ name: "pi-sbx", version: "0.2.0" }), "src/index.ts": "export const value = 1;\n" });
	writeFiles(path.join(fixture.npmRoot, "pi-sbx"), { "package.json": json({ name: "pi-sbx", version: "0.1.3" }) });
	const target = createInstalledFixture(fixture.npmRoot);
	fs.writeFileSync(fixture.forksFile, `pi-sbx|forks/pi-sbx|source\n${packageName}|forks/${packageName}|built\n`);
	const result = spawnSync(
		process.execPath,
		[deployScript, "deploy", "--forks", fixture.forksFile, "--npm-root", fixture.npmRoot],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /deployed pi-sbx <- forks\/pi-sbx \(source 0\.2\.0\)/);
	assert.match(result.stdout, /deployed pi-subagents <- forks\/pi-subagents \(built 0\.81\.0, \d+ files\)/);
	assert.match(result.stderr, /note: npm has pi-sbx@0\.1\.3, fork is 0\.2\.0/);
	assert.equal(fs.readFileSync(path.join(fixture.npmRoot, "pi-sbx", "src", "index.ts"), "utf8"), "export const value = 1;\n");
	assert.ok(fs.existsSync(path.join(target, "bundle", "chunk-AAAA.js")));
});

test("verifyBuiltArtifact accounts for every compiled and runtime path target", (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	const summary = verifyBuiltArtifact({ root: forkRoot });
	assert.equal(summary.declarationOnlyInputs, 1);
	assert.equal(summary.compiledModules, 2);
	assert.equal(summary.bundleModuleUrls, 2);
	assert.equal(summary.compiledModuleUrls, 1);
	assert.equal(summary.moduleUrls, 3);
	assert.match(summary.artifactDigest, /^[0-9a-f]{64}$/);
});

test("verifyBuiltArtifact ignores inputs the build never reads", (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	// Tests, examples and the vendor record do not reach the built package, so editing them must
	// not force a rebuild or mask a stale artifact.
	writeFiles(forkRoot, {
		"test/unit/agents.test.ts": "import { test } from \"node:test\";\n",
		"examples/demo.ts": "export {};\n",
		"VENDOR.md": "# vendor notes\n",
	});
	assert.equal(verifyBuiltArtifact({ root: forkRoot }).version, "0.81.0");
});

test("verifyBuiltArtifact treats the lockfile as a reproducibility input", (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	createDistFixture(forkRoot);
	writeFiles(forkRoot, { "package-lock.json": json({ lockfileVersion: 3, name: packageName, version: "0.81.0", patched: true }) });
	assert.throws(() => verifyBuiltArtifact({ root: forkRoot }), /artifact is stale: 1 source input change\(s\) since the build \(package-lock\.json \(changed\)\)/);
});

test("verifyBuiltArtifact refuses a bundle pointing at a missing compiled module", (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot, { stamp: false });
	fs.rmSync(path.join(distDir, "src", "api", "agents.js"));
	stampBuild({ root: forkRoot, distDir });
	assert.throws(() => verifyBuiltArtifact({ root: forkRoot }), /resolves import\.meta\.url to missing \.\.\/src\/api\/agents\.js/);
});

test("verifyBuiltArtifact refuses a compiled module pointing at a missing runtime file", (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot);
	writeFiles(distDir, { "src/api/runtime-path.js": "export const runnerUrl = new URL(\"../../../missing-runner.mjs\", import.meta.url);\n" });
	stampBuild({ root: forkRoot, distDir });
	assert.throws(
		() => verifyBuiltArtifact({ root: forkRoot }),
		/compiled module src\/api\/runtime-path\.js resolves import\.meta\.url to missing \.\.\/\.\.\/\.\.\/missing-runner\.mjs/,
	);
});

test("verifyBuiltArtifact refuses plain TypeScript under the compiled tree", (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot);
	writeFiles(distDir, { "src/api/agents.ts": "export const agents = [];\n" });
	assert.throws(() => verifyBuiltArtifact({ root: forkRoot }), /compiled tree contains plain TypeScript: src\/api\/agents\.ts/);
});

test("verifyBuiltArtifact refuses a compiled module without a declaration sibling", (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot);
	fs.rmSync(path.join(distDir, "src", "api", "agents.d.ts"));
	assert.throws(() => verifyBuiltArtifact({ root: forkRoot }), /declaration is missing: src\/api\/agents\.d\.ts/);
});

test("verifyBuiltArtifact refuses a build that lost a root module", (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot);
	fs.rmSync(path.join(distDir, "runner-peer-loader.mjs"));
	assert.throws(() => verifyBuiltArtifact({ root: forkRoot }), /root entry is missing: runner-peer-loader\.mjs/);
});

test("verifyBuiltArtifact refuses a build that embeds node_modules", (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot);
	writeFiles(distDir, { "node_modules/acorn/package.json": json({ name: "acorn" }) });
	assert.throws(() => verifyBuiltArtifact({ root: forkRoot }), /build output embeds a dependency tree: node_modules/);
});

test("verifyBuiltArtifact refuses an unexpected file at the build root", (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot);
	writeFiles(distDir, { "EXTRA.txt": "not part of the package\n" });
	try {
		verifyBuiltArtifact({ root: forkRoot });
		assert.fail("verification must refuse an unexpected build-root file");
	} catch (error) {
		assert.match(error.message, /unexpected file in the build output: EXTRA\.txt/);
		assert.match(error.message, /build output holds file\(s\) the build did not produce: EXTRA\.txt/);
	}
});

test("verifyBuiltArtifact refuses a build output whose file was deleted after the build", (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot);
	fs.rmSync(path.join(distDir, "bundle", "chunk-AAAA.js"));
	assert.throws(() => verifyBuiltArtifact({ root: forkRoot }), /build output is missing file\(s\) the build produced: bundle\/chunk-AAAA\.js/);
});

test("verifyBuiltArtifact refuses a build output whose mode was changed after the build", (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot);
	fs.chmodSync(path.join(distDir, "install.mjs"), 0o600);
	assert.throws(() => verifyBuiltArtifact({ root: forkRoot }), /build output was edited after the build: install\.mjs \(content or mode changed\)/);
});

test("verifyBuiltArtifact refuses a symlinked build output file", (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot);
	const outside = path.join(fixture.directory, "outside-agent.md");
	writeFiles(fixture.directory, { "outside-agent.md": "# outside\n" });
	fs.rmSync(path.join(distDir, "agents", "worker.md"));
	fs.symlinkSync(outside, path.join(distDir, "agents", "worker.md"), "file");
	assert.throws(() => verifyBuiltArtifact({ root: forkRoot }), /build output contains a symlink: agents\/worker\.md/);
});

test("verifyBuiltArtifact refuses an export whose targets do not exist", (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot, { stamp: false });
	const manifestPath = path.join(distDir, "package.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	manifest.exports["./agents"] = { types: "./src/api/agents.d.ts", default: "./bundle/missing.js" };
	fs.writeFileSync(manifestPath, json(manifest));
	stampBuild({ root: forkRoot, distDir });
	assert.throws(() => verifyBuiltArtifact({ root: forkRoot }), /export "\.\/agents" points at missing file \.\/bundle\/missing\.js/);
});

test("verifyBuiltArtifact refuses an export added to the build without a source export", (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot, { stamp: false });
	const manifestPath = path.join(distDir, "package.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	manifest.exports["./extra"] = { types: "./src/api/agents.d.ts", default: "./bundle/agents.js" };
	fs.writeFileSync(manifestPath, json(manifest));
	stampBuild({ root: forkRoot, distDir });
	assert.throws(() => verifyBuiltArtifact({ root: forkRoot }), /build exports "\.\/extra" which package\.json does not declare/);
});

test("stampBuild refuses a build output it cannot hash consistently", (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const distDir = createDistFixture(forkRoot, { stamp: false });
	const outside = path.join(fixture.directory, "outside-chunk.js");
	writeFiles(fixture.directory, { "outside-chunk.js": "export {};\n" });
	fs.rmSync(path.join(distDir, "bundle", "chunk-AAAA.js"));
	fs.symlinkSync(outside, path.join(distDir, "bundle", "chunk-AAAA.js"), "file");
	assert.throws(() => stampBuild({ root: forkRoot, distDir }), /refusing to stamp an unsupported build output/);
});

test("describeInputChanges and assertInputsUnchanged name the inputs that moved", () => {
	const before = [
		["index.ts", "aaa"],
		["src/api/agents.ts", "bbb"],
		["src/removed.ts", "ccc"],
	];
	const after = {
		digest: "different",
		entries: [
			["index.ts", "aaa"],
			["src/api/agents.ts", "zzz"],
			["src/added.ts", "ddd"],
		],
	};
	assert.deepEqual(describeInputChanges(before, after.entries), [
		"src/added.ts (added)",
		"src/api/agents.ts (changed)",
		"src/removed.ts (removed)",
	]);
	assert.throws(
		() => assertInputsUnchanged({ beforeEntries: before, beforeDigest: digestInputs(before), after }),
		/source inputs changed while the build ran \(src\/added\.ts \(added\), src\/api\/agents\.ts \(changed\), src\/removed\.ts \(removed\)\)/,
	);
	assert.doesNotThrow(() => assertInputsUnchanged({ beforeEntries: before, beforeDigest: digestInputs(before), after: { digest: digestInputs(before), entries: before } }));
});

test("parseForkArgument: a missing --fork value is refused", () => {
	assert.throws(() => parseForkArgument(["--fork"]), /--fork requires a directory/);
	assert.throws(() => parseForkArgument(["--fork", "--other"]), /--fork requires a directory/);
	assert.equal(parseForkArgument([], { fallbackForkDir: "/tmp/fallback" }), "/tmp/fallback");
	assert.equal(parseForkArgument(["--fork", "/tmp/elsewhere"], { fallbackForkDir: "/tmp/fallback" }), "/tmp/elsewhere");
});

test("buildSubagents stamps and verifies a build produced by the upstream step", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const messages = [];
	const summary = await buildSubagents({
		forkDir: forkRoot,
		runUpstream: ({ forkDir }) => createDistFixture(forkDir, { stamp: false }),
		log: (line) => messages.push(line),
	});
	assert.equal(summary.package, packageName);
	assert.equal(summary.version, "0.81.0");
	const stamp = JSON.parse(fs.readFileSync(path.join(forkRoot, "dist-pkg", BUILD_STAMP_FILE), "utf8"));
	assert.equal(stamp.schemaVersion, 2);
	assert.equal(stamp.artifactDigest, summary.artifactDigest);
	for (const relativePath of ["bundle/index.js", "src/api/agents.js", "agents/worker.md", ...REQUIRED_ROOT_MODULES]) {
		assert.ok(stamp.artifacts[relativePath], `${relativePath} must be covered by the artifact stamp`);
	}
	assert.ok(messages.some((line) => line.includes("artifact digest")));
	assert.equal(verifyBuiltArtifact({ root: forkRoot }).artifactDigest, summary.artifactDigest);
});

test("buildSubagents refuses when the source moves while the upstream step runs", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	await assert.rejects(
		buildSubagents({
			forkDir: forkRoot,
			runUpstream: ({ forkDir }) => {
				createDistFixture(forkDir, { stamp: false });
				writeFiles(forkDir, { "src/api/agents.ts": "export const agents = [changed];\n" });
			},
			log: () => {},
		}),
		/source inputs changed while the build ran \(src\/api\/agents\.ts \(changed\)\); the artifact mixes revisions/,
	);
	assert.ok(!fs.existsSync(path.join(forkRoot, "dist-pkg", BUILD_STAMP_FILE)), "an unstable build must not be stamped");
});

test("buildSubagents refuses a fork without provisioned build tools", async (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	fs.rmSync(path.join(forkRoot, "node_modules"), { recursive: true, force: true });
	await assert.rejects(
		buildSubagents({ forkDir: forkRoot, runUpstream: () => {}, log: () => {} }),
		/is missing typescript; provision it with npm ci in .* \(this build installs nothing\)/,
	);
});

test("collectSourceInputs refuses symlinked required inputs and input directories", (t) => {
	const fixture = makeCase();
	t.after(() => removeCase(fixture.directory));
	const forkRoot = createForkFixture(fixture.directory);
	const outside = path.join(fixture.directory, "outside");
	writeFiles(outside, { "agents.ts": "export const outside = true;\n" });
	fs.rmSync(path.join(forkRoot, "src", "api", "agents.ts"));
	fs.symlinkSync(path.join(outside, "agents.ts"), path.join(forkRoot, "src", "api", "agents.ts"), "file");
	assert.throws(() => collectSourceInputs(forkRoot), /build inputs include symlinks, which the fingerprint refuses: src\/api\/agents\.ts/);
});
