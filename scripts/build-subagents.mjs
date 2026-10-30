// Reproducible build of the vendored pi-subagents fork.
//
// The fork's package exports TypeScript and publishes a compiled graph, so a source-only
// overlay cannot deploy it: Pi loads `bundle/index.js`, background runners load compiled
// `src/*.js`, and only the compiled tree keeps the `import.meta.url` paths to agents,
// prompts and package.json. This wrapper therefore runs the unchanged upstream builder and
// then proves the result belongs to the current source tree.
//
// Freshness is a fingerprint, not a timestamp: the inputs the build reads are hashed before
// and after the build, a mid-build change aborts, the produced files are hashed into the stamp,
// and `scripts/deploy-fork.mjs` refuses to deploy without a stamp that matches both source and
// artifact. `buildSubagents` takes the upstream step as a parameter so the race can be tested
// without a slow real build.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultForkDir = path.join(repoRoot, "forks", "pi-subagents");

const REQUIRED_BUILD_TOOLS = [
	["typescript", path.join("node_modules", "typescript", "bin", "tsc")],
	["esbuild", path.join("node_modules", "esbuild", "package.json")],
];

function displayForkDir(forkDir) {
	const insideRepo = path.relative(repoRoot, forkDir);
	return insideRepo && !insideRepo.startsWith("..") ? insideRepo : forkDir;
}

export function parseForkArgument(argv, { fallbackForkDir = defaultForkDir } = {}) {
	const index = argv.indexOf("--fork");
	if (index === -1) return fallbackForkDir;
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error("--fork requires a directory");
	return path.resolve(value);
}

/** Names every input that differs between two fingerprint snapshots, sorted by path. */
export function describeInputChanges(beforeEntries, afterEntries) {
	const before = new Map(beforeEntries);
	const after = new Map(afterEntries);
	const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
	return paths
		.filter((relativePath) => before.get(relativePath) !== after.get(relativePath))
		.map((relativePath) => (before.has(relativePath) ? `${relativePath} (${after.has(relativePath) ? "changed" : "removed"})` : `${relativePath} (added)`));
}

/**
 * Refuses an artifact whose source inputs moved while the builder ran: the output would mix
 * revisions, so it must not be stamped or deployed.
 */
export function assertInputsUnchanged({ beforeEntries, beforeDigest, after }) {
	if (after.digest === beforeDigest) return;
	const changes = describeInputChanges(beforeEntries, after.entries);
	throw new Error(
		`source inputs changed while the build ran (${changes.slice(0, 8).join(", ")}${changes.length > 8 ? ", …" : ""}); ` +
			"the artifact mixes revisions, so it is not stamped or deployed",
	);
}

/** Runs the unchanged upstream builder in the fork. Never installs anything. */
export function runUpstreamBuild({ forkDir }) {
	const upstream = spawnSync(process.execPath, [path.join("scripts", "build-package.mjs")], {
		cwd: forkDir,
		stdio: "inherit",
	});
	if (upstream.error) throw new Error(`could not run the upstream builder: ${upstream.error.message}`);
	if (upstream.status !== 0) throw new Error(`upstream build-package.mjs exited with ${upstream.status ?? upstream.signal}`);
}

/** Builds, stamps and verifies one fork; every failure is a thrown error. */
export async function buildSubagents({ forkDir = defaultForkDir, runUpstream = runUpstreamBuild, log = console.log } = {}) {
	const relativeFork = displayForkDir(forkDir);
	const verifyUrl = pathToFileURL(path.join(forkDir, "scripts", "verify-build.mjs"));
	const { collectSourceInputs, computeSourceDigest, digestInputs, stampBuild, verifyBuiltArtifact } = await import(verifyUrl.href);

	if (!fs.existsSync(path.join(forkDir, "package.json"))) {
		throw new Error(`${relativeFork} has no package.json; is the fork vendored?`);
	}
	for (const [name, relativePath] of REQUIRED_BUILD_TOOLS) {
		if (!fs.existsSync(path.join(forkDir, relativePath))) {
			// Never install here: the deployment path must not gain network or devDependency side effects.
			throw new Error(`${relativeFork} is missing ${name}; provision it with npm ci in ${relativeFork} (this build installs nothing)`);
		}
	}

	const before = collectSourceInputs(forkDir);
	if (before.missing.length > 0) throw new Error(`${relativeFork} package inputs are missing: ${before.missing.join(", ")}`);
	const beforeDigest = digestInputs(before.entries);
	log(`build-subagents: ${relativeFork} (${before.entries.length} source inputs)`);

	await runUpstream({ forkDir });

	const after = computeSourceDigest(forkDir);
	assertInputsUnchanged({ beforeEntries: before.entries, beforeDigest, after });

	const stamped = stampBuild({ root: forkDir });
	if (stamped.digest !== after.digest || stamped.artifactDigest === undefined) {
		throw new Error("source inputs changed while the build stamp was written; rebuild");
	}
	const summary = verifyBuiltArtifact({ root: forkDir });
	log(
		`build-subagents: stamped ${summary.package}@${summary.version} ` +
			`(${summary.exportCount} exports, ${summary.compiledModules} compiled modules, ${summary.moduleUrls} module-url targets, ` +
			`${Object.keys(stamped.stamp.artifacts).length} artifact files)`,
	);
	log(`build-subagents: source digest ${summary.sourceDigest.slice(0, 16)} (${summary.inputCount} inputs)`);
	log(`build-subagents: artifact digest ${summary.artifactDigest.slice(0, 16)}`);
	return { ...summary, forkDir, relativeFork };
}

/** Paths reached through a symlinked scratch root (/var → /private/var) must still match. */
function isMainModule(moduleUrl) {
	try {
		return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(process.argv[1]);
	} catch {
		return false;
	}
}

if (process.argv[1] && isMainModule(import.meta.url)) {
	try {
		await buildSubagents({ forkDir: parseForkArgument(process.argv.slice(2)) });
	} catch (error) {
		console.error(`adripi: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
