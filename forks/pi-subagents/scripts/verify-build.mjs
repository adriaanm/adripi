// Verification for the `dist-pkg` build of this fork.
//
// The package is built by the unchanged upstream `scripts/build-package.mjs`, wrapped by
// adripi's `scripts/build-subagents.mjs`. That wrapper stamps `dist-pkg/.adripi-build.json`
// with a digest of the inputs the build actually consumes. This module owns both halves so
// the wrapper and the standalone check cannot drift:
//
// - `collectSourceInputs` / `computeSourceDigest` / `stampBuild`: the fingerprint.
// - `verifyBuiltArtifact`: freshness plus the layout the adripi deploy step relies on.
//
// Existence of a file is not freshness: a build is only accepted when the stamp matches the
// current inputs, every artifact the package graph resolves is present, and every produced file
// still has the content and permission bits the build recorded. A stamp can only prove that the
// artifact and the source belong together; it is consistency checking, not defence against a
// hostile same-user writer who edits both.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DIST_DIRECTORY = "dist-pkg";
export const BUILD_STAMP_FILE = ".adripi-build.json";
export const BUILD_STAMP_SCHEMA = 2;
/** Root `.mjs` entries Pi and the background runner load by path; losing one breaks a child. */
export const REQUIRED_ROOT_MODULES = [
	"install.mjs",
	"runner-peer-preload.mjs",
	"runner-peer-loader.mjs",
	"inspector-runner.mjs",
	"async-retention-discovery-worker.mjs",
];
/** Runtime assets and static docs the builder copies next to the compiled graph. */
export const PACKAGE_DIRECTORIES = ["agents", "skills", "prompts", "docs"];
export const STATIC_PACKAGE_FILES = ["README.md", "CHANGELOG.md", "LICENSE"];
const REQUIRED_INPUT_FILES = [
	"index.ts",
	"package.json",
	// The lockfile decides which compiler and bundler version produced the artifact, so it is a
	// reproducibility input even though the builder never reads it.
	"package-lock.json",
	"tsconfig.json",
	"tsconfig.build.json",
	"scripts/build-package.mjs",
	"scripts/verify-build.mjs",
	...STATIC_PACKAGE_FILES,
];
const INPUT_DIRECTORIES = ["src", ...PACKAGE_DIRECTORIES];
/** Publish-only fields: their presence in the built manifest means the field copy regressed. */
const FORBIDDEN_BUILT_MANIFEST_KEYS = ["devDependencies", "scripts", "private"];
const BUILD_ENTRY_POINT = "./bundle/index.js";

function resolveFrom(root, relativePath) {
	return path.join(root, ...relativePath.split("/"));
}

function isFile(absolutePath) {
	try {
		return fs.statSync(absolutePath).isFile();
	} catch {
		return false;
	}
}

function isDirectory(absolutePath) {
	try {
		return fs.statSync(absolutePath).isDirectory();
	} catch {
		return false;
	}
}

function lstatOrNull(absolutePath) {
	try {
		return fs.lstatSync(absolutePath);
	} catch {
		return null;
	}
}

function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * Recursively lists regular files under `<root>/<relativeDirectory>` as posix relative paths.
 * Symlinks are reported to `onSymlink` instead of being followed: the build must consume
 * plain files so the fingerprint describes what was compiled.
 */
function listFiles(root, relativeDirectory, { onSymlink } = {}) {
	const files = [];
	const start = resolveFrom(root, relativeDirectory);
	if (!isDirectory(start)) return files;
	const pending = [""];
	while (pending.length > 0) {
		const current = pending.pop();
		const currentDirectory = current ? path.join(start, ...current.split("/")) : start;
		for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
			const relative = current ? `${current}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) {
				onSymlink?.(relativeDirectory ? `${relativeDirectory}/${relative}` : relative);
				continue;
			}
			if (entry.isDirectory()) {
				pending.push(relative);
				continue;
			}
			if (entry.isFile()) files.push(relativeDirectory ? `${relativeDirectory}/${relative}` : relative);
		}
	}
	return files.sort();
}

/**
 * Enumerates every file the build reads and hashes it, plus the required inputs that are missing.
 * Excluded on purpose: `node_modules/`, `dist-pkg/`, `test/`, `examples/`, `tools/`
 * and the vendor notes. None of them reach the built package, so editing one must not force a
 * rebuild and must not be able to disguise a stale artifact.
 */
export function collectSourceInputs(root) {
	const files = new Set();
	const missing = [];
	const symlinks = [];
	for (const relativePath of REQUIRED_INPUT_FILES) {
		// Required root/config inputs must be real files: hashing or compiling through a link
		// would describe something the package does not ship.
		const stat = lstatOrNull(resolveFrom(root, relativePath));
		if (stat?.isSymbolicLink()) symlinks.push(relativePath);
		else if (stat?.isFile()) files.add(relativePath);
		else missing.push(relativePath);
	}
	const rootEntries = isDirectory(root) ? fs.readdirSync(root, { withFileTypes: true }) : [];
	for (const entry of rootEntries) {
		// Only a root `.mjs` is a build input, so only a symlinked one is refused. A linked
		// `node_modules/` is the provisioned dependency tree, which the build copies nothing from.
		if (entry.name.endsWith(".mjs")) {
			if (entry.isSymbolicLink()) symlinks.push(entry.name);
			else if (entry.isFile()) files.add(entry.name);
		}
	}
	for (const relativeDirectory of INPUT_DIRECTORIES) {
		const directoryStat = lstatOrNull(resolveFrom(root, relativeDirectory));
		if (directoryStat?.isSymbolicLink()) {
			symlinks.push(relativeDirectory);
			continue;
		}
		if (!directoryStat?.isDirectory()) {
			missing.push(relativeDirectory);
			continue;
		}
		for (const relativePath of listFiles(root, relativeDirectory, { onSymlink: (link) => symlinks.push(link) })) {
			files.add(relativePath);
		}
	}
	if (symlinks.length > 0) {
		throw new Error(`build inputs include symlinks, which the fingerprint refuses: ${symlinks.sort().join(", ")}`);
	}
	const entries = [...files]
		.sort()
		.map((relativePath) => [relativePath, sha256(fs.readFileSync(resolveFrom(root, relativePath)))]);
	return { entries, missing };
}

export function digestInputs(entries) {
	return sha256(entries.map(([relativePath, hash]) => `${relativePath}\0${hash}\n`).join(""));
}

export function computeSourceDigest(root) {
	const { entries, missing } = collectSourceInputs(root);
	return { digest: digestInputs(entries), entries, missing };
}

/**
 * Every file the build produced, with its permission bits and content hash. The stamp itself is
 * excluded: it is the record of the build, not part of the graph it describes. Comparing this
 * catches an edited, mixed-revision or truncated `dist-pkg`, which a source-only fingerprint
 * cannot see.
 */
export function collectArtifactEntries(distDir) {
	const entries = new Map();
	const violations = [];
	const rootStat = lstatOrNull(distDir);
	if (!rootStat?.isDirectory()) {
		violations.push(`build output ${DIST_DIRECTORY} is ${rootStat ? "not a directory" : "missing"}`);
		return { entries, violations };
	}
	const pending = [""];
	while (pending.length > 0) {
		const current = pending.pop();
		const directory = current ? path.join(distDir, ...current.split("/")) : distDir;
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const relative = current ? `${current}/${entry.name}` : entry.name;
			if (relative === BUILD_STAMP_FILE) continue;
			const absolute = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) {
				violations.push(`build output contains a symlink: ${relative}`);
				continue;
			}
			if (entry.isDirectory()) {
				pending.push(relative);
				continue;
			}
			if (!entry.isFile()) {
				violations.push(`build output contains an unsupported file type: ${relative}`);
				continue;
			}
			const mode = (lstatOrNull(absolute)?.mode ?? 0) & 0o777;
			entries.set(relative, { mode, hash: sha256(fs.readFileSync(absolute)) });
		}
	}
	return { entries, violations };
}

function sortedArtifactPaths(entries) {
	return [...entries.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Sorted content+mode digest; the single value the deploy compares before writing. */
export function digestArtifacts(entries) {
	const lines = sortedArtifactPaths(entries).map((relative) => {
		const info = entries.get(relative);
		return `${relative}\0${info.mode.toString(8)}\0${info.hash}\n`;
	});
	return sha256(lines.join(""));
}

function serializeArtifacts(entries) {
	return Object.fromEntries(sortedArtifactPaths(entries).map((relative) => {
		const info = entries.get(relative);
		return [relative, `${info.mode.toString(8)}:${info.hash}`];
	}));
}

function describeArtifactList(paths) {
	return `${paths.slice(0, 8).join(", ")}${paths.length > 8 ? ", …" : ""}`;
}

function compareArtifacts(stampedArtifacts, currentEntries) {
	const stamped = new Map(Object.entries(stampedArtifacts ?? {}));
	const current = new Map(sortedArtifactPaths(currentEntries).map((relative) => {
		const info = currentEntries.get(relative);
		return [relative, `${info.mode.toString(8)}:${info.hash}`];
	}));
	return {
		changed: [...current.keys()].filter((relative) => stamped.has(relative) && stamped.get(relative) !== current.get(relative)),
		added: [...current.keys()].filter((relative) => !stamped.has(relative)),
		removed: [...stamped.keys()].filter((relative) => !current.has(relative)),
	};
}

/**
 * Writes the build stamp. Called by adripi's build wrapper after the upstream build, and by
 * fixture tests that need a fresh artifact.
 */
export function stampBuild({ root, distDir = path.join(root, DIST_DIRECTORY) }) {
	const { entries, missing, digest } = computeSourceDigest(root);
	if (missing.length > 0) {
		throw new Error(`package inputs are missing: ${missing.join(", ")}`);
	}
	const artifacts = collectArtifactEntries(distDir);
	if (artifacts.violations.length > 0) {
		throw new Error(`refusing to stamp an unsupported build output:\n  - ${artifacts.violations.join("\n  - ")}`);
	}
	const artifactDigest = digestArtifacts(artifacts.entries);
	const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	const stamp = {
		schemaVersion: BUILD_STAMP_SCHEMA,
		generator: "adripi scripts/build-subagents.mjs",
		package: manifest.name,
		version: manifest.version,
		sourceDigest: digest,
		inputs: Object.fromEntries(entries),
		artifactDigest,
		artifacts: serializeArtifacts(artifacts.entries),
	};
	fs.writeFileSync(path.join(distDir, BUILD_STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`);
	return { digest, entries, artifactDigest, artifactEntries: artifacts.entries, stamp };
}

function readJsonFile(absolutePath, label, violations) {
	try {
		return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
	} catch (error) {
		violations.push(`${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

function compareInputs(stampInputs, currentEntries) {
	const stamped = new Map(Object.entries(stampInputs ?? {}));
	const current = new Map(currentEntries);
	const added = [...current.keys()].filter((key) => !stamped.has(key)).sort();
	const removed = [...stamped.keys()].filter((key) => !current.has(key)).sort();
	const changed = [...current.keys()].filter((key) => stamped.has(key) && stamped.get(key) !== current.get(key)).sort();
	return [...changed.map((key) => `${key} (changed)`), ...added.map((key) => `${key} (added)`), ...removed.map((key) => `${key} (removed)`)];
}

function expectedExportValue(exportName, sourceTarget) {
	if (typeof sourceTarget !== "string" || !sourceTarget.endsWith(".ts")) {
		throw new Error(`unsupported source export "${exportName}": ${String(sourceTarget)}`);
	}
	const bundleName = exportName === "." ? "index" : exportName.slice(2);
	return { types: `${sourceTarget.slice(0, -3)}.d.ts`, default: `./bundle/${bundleName}.js` };
}

function sameStringList(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function describeExportValue(value) {
	return JSON.stringify(value);
}

function verifyExports({ distDir, forkManifest, violations }) {
	const builtManifest = readJsonFile(path.join(distDir, "package.json"), "dist-pkg/package.json", violations);
	if (!builtManifest) return null;
	const builtExports = builtManifest.exports;
	const sourceExports = forkManifest?.exports;
	if (!builtExports || typeof builtExports !== "object" || Array.isArray(builtExports)) {
		violations.push("dist-pkg/package.json has no exports map");
		return builtManifest;
	}
	if (!sourceExports || typeof sourceExports !== "object") {
		violations.push("package.json has no exports map to build from");
		return builtManifest;
	}
	const builtNames = Object.keys(builtExports).sort();
	const sourceNames = Object.keys(sourceExports).sort();
	for (const name of sourceNames) {
		if (!builtNames.includes(name)) violations.push(`build is missing public export "${name}"`);
	}
	for (const name of builtNames) {
		if (!sourceNames.includes(name)) violations.push(`build exports "${name}" which package.json does not declare`);
	}
	for (const [name, sourceTarget] of Object.entries(sourceExports)) {
		let expected;
		try {
			expected = expectedExportValue(name, sourceTarget);
		} catch (error) {
			violations.push(error instanceof Error ? error.message : String(error));
			continue;
		}
		const actual = builtExports[name];
		if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
			violations.push(`export "${name}" must be a {types, default} object, found ${describeExportValue(actual)}`);
			continue;
		}
		const extraKeys = Object.keys(actual).filter((key) => key !== "types" && key !== "default");
		if (extraKeys.length > 0) violations.push(`export "${name}" has unexpected conditions: ${extraKeys.join(", ")}`);
		if (actual.types !== expected.types) {
			violations.push(`export "${name}" types target is ${describeExportValue(actual.types)}, expected ${expected.types}`);
		}
		if (actual.default !== expected.default) {
			violations.push(`export "${name}" default target is ${describeExportValue(actual.default)}, expected ${expected.default}`);
		}
		for (const target of [actual.types, actual.default]) {
			if (typeof target !== "string" || !target.startsWith("./")) {
				violations.push(`export "${name}" target ${describeExportValue(target)} is not a package-relative path`);
				continue;
			}
			if (!isFile(resolveFrom(distDir, target.slice(2)))) {
				violations.push(`export "${name}" points at missing file ${target}`);
			}
		}
	}
	const topLevelTypes = builtManifest.types ?? builtManifest.typings;
	if (typeof topLevelTypes !== "string" || !isFile(resolveFrom(distDir, topLevelTypes.slice(2)))) {
		violations.push(`dist-pkg/package.json types is ${describeExportValue(topLevelTypes)} but the file is missing`);
	}
	return builtManifest;
}

function verifyManifest({ builtManifest, forkManifest, target, violations }) {
	if (!builtManifest || !forkManifest) return;
	if (builtManifest.name !== forkManifest.name) {
		violations.push(`built package name is ${describeExportValue(builtManifest.name)}, source is ${forkManifest.name}`);
	}
	if (builtManifest.version !== forkManifest.version) {
		violations.push(`built version is ${describeExportValue(builtManifest.version)}, source is ${forkManifest.version}`);
	}
	if (builtManifest.type !== forkManifest.type) {
		violations.push(`built package type is ${describeExportValue(builtManifest.type)}, source is ${describeExportValue(forkManifest.type)}`);
	}
	for (const key of FORBIDDEN_BUILT_MANIFEST_KEYS) {
		if (key in builtManifest) violations.push(`built manifest carries publish-only field "${key}"`);
	}
	for (const key of ["dependencies", "peerDependencies", "peerDependenciesMeta"]) {
		if (JSON.stringify(builtManifest[key]) !== JSON.stringify(forkManifest[key])) {
			violations.push(`built manifest ${key} does not match the source package (runtime dependency wiring)`);
		}
	}
	const extensions = builtManifest.pi?.extensions;
	if (!Array.isArray(extensions) || extensions.length !== 1 || extensions[0] !== BUILD_ENTRY_POINT) {
		violations.push(`built pi.extensions is ${describeExportValue(extensions)}, expected ${describeExportValue([BUILD_ENTRY_POINT])}`);
	}
	for (const key of ["skills", "prompts"]) {
		if (!sameStringList(builtManifest.pi?.[key], forkManifest.pi?.[key])) {
			violations.push(`built pi.${key} is ${describeExportValue(builtManifest.pi?.[key])}, source is ${describeExportValue(forkManifest.pi?.[key])}`);
		}
	}
	if (!isFile(path.join(target, "bundle", "index.js"))) {
		violations.push(`${BUILD_ENTRY_POINT} is missing from the bundle`);
	}
}

function verifyCompiledTree({ root, distDir, violations }) {
	const compiledDirectory = path.join(distDir, "src");
	if (!isDirectory(compiledDirectory)) {
		violations.push("dist-pkg/src is missing; the compiled graph was not emitted");
		return { compiledModules: 0, declarationOnlyInputs: 0 };
	}
	const sourceFiles = listFiles(root, "src");
	const compiledSources = sourceFiles.filter((relativePath) => !relativePath.endsWith(".d.ts"));
	// A source `.d.ts` input is declaration-only: TypeScript emits nothing for it, so neither a
	// `.js` nor a `.d.ts` sibling is required (upstream has `src/types/pi-runtime-compat.d.ts`).
	const declarationOnlyInputs = sourceFiles.filter((relativePath) => relativePath.endsWith(".d.ts"));
	for (const relativePath of compiledSources) {
		const base = relativePath.slice(0, -3);
		if (!isFile(resolveFrom(distDir, `${base}.js`))) violations.push(`compiled module is missing: ${base}.js`);
		if (!isFile(resolveFrom(distDir, `${base}.d.ts`))) violations.push(`declaration is missing: ${base}.d.ts`);
	}
	let compiledModules = 0;
	for (const relativePath of listFiles(distDir, "src", { onSymlink: (link) => violations.push(`dist-pkg/src contains a symlink: ${link}`) })) {
		if (relativePath.endsWith(".ts") && !relativePath.endsWith(".d.ts")) {
			violations.push(`compiled tree contains plain TypeScript: ${relativePath}`);
			continue;
		}
		if (relativePath.endsWith(".js")) {
			compiledModules += 1;
			const declaration = `${relativePath.slice(0, -3)}.d.ts`;
			if (!isFile(resolveFrom(distDir, declaration))) violations.push(`compiled JS has no declaration sibling: ${relativePath}`);
			continue;
		}
		if (relativePath.endsWith(".d.ts") || relativePath.endsWith(".js.map")) continue;
		violations.push(`compiled tree contains an unexpected file: ${relativePath}`);
	}
	return { compiledModules, declarationOnlyInputs: declarationOnlyInputs.length };
}

function verifyRootEntries({ root, distDir, violations }) {
	const rootEntries = isDirectory(distDir) ? fs.readdirSync(distDir, { withFileTypes: true }) : [];
	const rootFiles = new Set(rootEntries.filter((entry) => entry.isFile()).map((entry) => entry.name));
	for (const moduleName of REQUIRED_ROOT_MODULES) {
		if (!rootFiles.has(moduleName)) {
			violations.push(`root entry is missing: ${moduleName}`);
			continue;
		}
		if (!isFile(resolveFrom(root, moduleName))) violations.push(`root entry ${moduleName} is not a source input`);
	}
	const sourceRootModules = isDirectory(root)
		? fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
		: [];
	for (const entry of sourceRootModules) {
		if (!rootFiles.has(entry.name)) violations.push(`root module from the source package was not copied: ${entry.name}`);
	}
	for (const staticFile of STATIC_PACKAGE_FILES) {
		if (!rootFiles.has(staticFile)) violations.push(`static package file is missing: ${staticFile}`);
	}
	for (const moduleName of ["index.js", "index.d.ts"]) {
		if (!rootFiles.has(moduleName)) violations.push(`compiled root entry is missing: ${moduleName}`);
	}
	for (const entry of rootEntries) {
		if (!entry.isDirectory()) continue;
		if (!PACKAGE_DIRECTORIES.includes(entry.name) && entry.name !== "src" && entry.name !== "bundle") {
			violations.push(`unexpected directory in the build output: ${entry.name}`);
		}
	}
	for (const relativeDirectory of PACKAGE_DIRECTORIES) {
		const files = listFiles(distDir, relativeDirectory);
		if (files.length === 0) violations.push(`runtime asset directory is empty or missing: ${relativeDirectory}`);
	}
	if (listFiles(distDir, "bundle").length === 0) violations.push("dist-pkg/bundle is empty or missing");
	// Anything else at the build root is not part of the package: refuse it rather than deploy it.
	const expectedRootFiles = new Set([
		...REQUIRED_ROOT_MODULES,
		...sourceRootModules.map((entry) => entry.name),
		...STATIC_PACKAGE_FILES,
		"index.js",
		"index.d.ts",
		"package.json",
		BUILD_STAMP_FILE,
	]);
	for (const name of rootFiles) {
		if (!expectedRootFiles.has(name)) violations.push(`unexpected file in the build output: ${name}`);
	}
	return { rootFiles: [...rootFiles].filter((name) => name !== "package.json" && name !== BUILD_STAMP_FILE) };
}

/**
 * Every bundled module keeps the `import.meta.url` of its compiled file, and the compiled modules
 * keep their own, so a stale or partial build leaves `new URL("...", import.meta.url)` pointing at
 * nothing. Both trees are real runtime paths: the bundle points at compiled `src/`, and compiled
 * `src/` points at the root runners, static docs and assets.
 */
function verifyModuleUrls({ distDir, violations }) {
	const counts = { bundle: 0, compiled: 0 };
	for (const [relativeDirectory, kind] of [["bundle", "bundle"], ["src", "compiled module"]]) {
		for (const relativePath of listFiles(distDir, relativeDirectory)) {
			if (!relativePath.endsWith(".js")) continue;
			const absolute = resolveFrom(distDir, relativePath);
			const text = fs.readFileSync(absolute, "utf8");
			// `new URL("../../x.mjs", new URL("../src/y.js", import.meta.url).href)` nests two calls, so
			// the argument match must not cross a quote: only the inner call owns `import.meta.url`.
			const pattern = /new URL\(\s*(["'])([^"']*)\1\s*,\s*import\.meta\.url\s*\)/g;
			for (const match of text.matchAll(pattern)) {
				const target = match[2];
				if (!target.startsWith(".")) continue;
				if (kind === "bundle") counts.bundle += 1;
				else counts.compiled += 1;
				const resolved = path.resolve(path.dirname(absolute), target);
				if (!fs.existsSync(resolved)) violations.push(`${kind} ${relativePath} resolves import.meta.url to missing ${target}`);
			}
		}
	}
	return counts;
}

function verifyNoEmbeddedDependencies({ distDir, violations }) {
	const pending = [distDir];
	while (pending.length > 0) {
		const current = pending.pop();
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.name === "node_modules") {
				violations.push(`build output embeds a dependency tree: ${path.relative(distDir, path.join(current, entry.name)) || "node_modules"}`);
				continue;
			}
			if (entry.isDirectory()) pending.push(path.join(current, entry.name));
		}
	}
}

/**
 * Throws unless `dist-pkg` is a fresh build of the current source inputs and has the layout the
 * adripi deploy step maps onto the installed package.
 */
export function verifyBuiltArtifact({ root, distDir = path.join(root, DIST_DIRECTORY) }) {
	const violations = [];
	if (!isDirectory(distDir)) {
		throw new Error(`missing build output at ${distDir}; run node scripts/build-subagents.mjs`);
	}
	const forkManifest = readJsonFile(path.join(root, "package.json"), "package.json", violations);
	const current = computeSourceDigest(root);
	if (current.missing.length > 0) violations.push(`package inputs are missing: ${current.missing.join(", ")}`);

	const artifacts = collectArtifactEntries(distDir);
	violations.push(...artifacts.violations);
	const currentArtifactDigest = artifacts.violations.length > 0 ? null : digestArtifacts(artifacts.entries);

	const stampPath = path.join(distDir, BUILD_STAMP_FILE);
	if (!isFile(stampPath)) {
		violations.push(`build stamp ${DIST_DIRECTORY}/${BUILD_STAMP_FILE} is missing; existence of dist-pkg does not prove the artifact matches the source`);
	} else {
		const stamp = readJsonFile(stampPath, `${DIST_DIRECTORY}/${BUILD_STAMP_FILE}`, violations);
		if (stamp) {
			if (stamp.schemaVersion !== BUILD_STAMP_SCHEMA) {
				violations.push(`build stamp schema is ${describeExportValue(stamp.schemaVersion)}, expected ${BUILD_STAMP_SCHEMA}`);
			}
			if (stamp.package !== forkManifest?.name || stamp.version !== forkManifest?.version) {
				violations.push(`build stamp describes ${describeExportValue(stamp.package)}@${describeExportValue(stamp.version)}, source is ${describeExportValue(forkManifest?.name)}@${describeExportValue(forkManifest?.version)}`);
			}
			const differences = compareInputs(stamp.inputs, current.entries);
			if (differences.length > 0) {
				violations.push(`artifact is stale: ${differences.length} source input change(s) since the build (${differences.slice(0, 8).join(", ")}${differences.length > 8 ? ", …" : ""}); re-run node scripts/build-subagents.mjs`);
			}
			if (stamp.sourceDigest !== current.digest) {
				violations.push(`artifact is stale: the source digest ${describeExportValue(stamp.sourceDigest)} does not match the current inputs`);
			}
			const artifactDifferences = compareArtifacts(stamp.artifacts, artifacts.entries);
			if (artifactDifferences.changed.length > 0) {
				violations.push(`build output was edited after the build: ${describeArtifactList(artifactDifferences.changed)} (content or mode changed)`);
			}
			if (artifactDifferences.added.length > 0) {
				violations.push(`build output holds file(s) the build did not produce: ${describeArtifactList(artifactDifferences.added)}`);
			}
			if (artifactDifferences.removed.length > 0) {
				violations.push(`build output is missing file(s) the build produced: ${describeArtifactList(artifactDifferences.removed)}`);
			}
			if (stamp.artifactDigest !== currentArtifactDigest) {
				violations.push(`build output digest ${describeExportValue(stamp.artifactDigest)} does not match the files on disk`);
			}
		}
	}

	const builtManifest = verifyExports({ distDir, forkManifest, violations });
	verifyManifest({ builtManifest, forkManifest, target: distDir, violations });
	const compiled = verifyCompiledTree({ root, distDir, violations });
	const rootEntries = verifyRootEntries({ root, distDir, violations });
	const moduleUrls = verifyModuleUrls({ distDir, violations });
	verifyNoEmbeddedDependencies({ distDir, violations });

	if (violations.length > 0) {
		throw new Error(`pi-subagents build verification failed:\n  - ${violations.join("\n  - ")}`);
	}
	return {
		package: forkManifest.name,
		version: forkManifest.version,
		sourceDigest: current.digest,
		artifactDigest: currentArtifactDigest,
		inputCount: current.entries.length,
		exportCount: Object.keys(builtManifest.exports).length,
		rootEntries: rootEntries.rootFiles.length,
		compiledModules: compiled.compiledModules,
		declarationOnlyInputs: compiled.declarationOnlyInputs,
		bundleModuleUrls: moduleUrls.bundle,
		compiledModuleUrls: moduleUrls.compiled,
		moduleUrls: moduleUrls.bundle + moduleUrls.compiled,
	};
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
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	try {
		const summary = verifyBuiltArtifact({ root });
		console.log(
			`verify-build: ${summary.package}@${summary.version} is fresh ` +
				`(${summary.inputCount} inputs, ${summary.exportCount} exports, ${summary.compiledModules} compiled modules, ` +
				`${summary.moduleUrls} module-url targets [${summary.bundleModuleUrls} bundle, ${summary.compiledModuleUrls} compiled], ` +
				`artifact ${summary.artifactDigest.slice(0, 16)})`,
		);
	} catch (error) {
		console.error(`verify-build: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
