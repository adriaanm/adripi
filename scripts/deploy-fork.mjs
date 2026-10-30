// Deployment of the vendored forks into the installed Pi packages.
//
// Two modes, because the forks differ in how Pi loads them:
//
// - `source`: Pi and `jiti` load the TypeScript source directly, so overlaying `<fork>/src`
//   onto `<install>/src` is the whole deployment. The npm version may legitimately be older
//   than the vendored fork (pi-guardian), so a version difference is reported, not refused.
// - `built`: pi-subagents publishes a compiled graph. Public exports resolve to `bundle/`,
//   background runners execute compiled `src/*.js`, and every `import.meta.url` points at a
//   compiled file. Overlaying TypeScript would leave Pi loading a bundle that imports files
//   it cannot find, so the deploy ships one upstream-built artifact graph and nothing else.
//
// Deployment is plan-then-apply:
//
// - `preflight` validates fork/build readiness only. It never reads the installed package,
//   because `pi install` has not run yet: an old installed version must not block a pin and
//   fork upgrade that the next step is about to align.
// - `deploy` (after `pi install`) plans every listed fork first and only then writes, so a
//   refusal on the last package cannot leave earlier packages half-upgraded.
//
// Each plan captures digests of what it read (source trees, managed target trees/root files,
// the installed manifest and build artifact) and re-checks them immediately before writing. That is consistency checking
// against accidental drift, not a transaction and not protection against a hostile same-user
// writer; a process killed mid-apply can still leave one package partially updated.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FORK_MODES = ["source", "built"];
/** Subtrees a built deploy owns completely; everything else in the installed package is left alone. */
export const MANAGED_DIRECTORIES = ["bundle", "src", "agents", "skills", "prompts", "docs"];
/** Written by the build wrapper; describes build inputs, not deployed state. */
const BUILD_STAMP_FILE = ".adripi-build.json";
const NOT_DEPLOYED_ROOT_FILES = new Set(["package.json", BUILD_STAMP_FILE]);
const TEMP_SUFFIX = ".adripi-tmp";

function lstatOrNull(absolutePath) {
	try {
		return fs.lstatSync(absolutePath);
	} catch {
		return null;
	}
}

function isRegularFile(absolutePath) {
	return Boolean(lstatOrNull(absolutePath)?.isFile());
}

/** True only for a real directory: a symlink that happens to point at a directory is not one. */
function isRealDirectory(absolutePath) {
	return Boolean(lstatOrNull(absolutePath)?.isDirectory());
}

function describeStat(stat) {
	if (!stat) return "missing";
	if (stat.isSymbolicLink()) return "a symlink";
	if (stat.isDirectory()) return "a directory";
	if (stat.isFile()) return "a file";
	return "an unsupported file type";
}

function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

function readJson(absolutePath, label) {
	let text;
	try {
		text = fs.readFileSync(absolutePath, "utf8");
	} catch (error) {
		throw new Error(`${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Refuses to read a manifest through a link: root/config inputs must be the real files. */
function readManifestFile(absolutePath, label) {
	const stat = lstatOrNull(absolutePath);
	if (!stat?.isFile()) throw new Error(`${label} is ${describeStat(stat)}; refusing to read a manifest through it`);
	return readJson(absolutePath, label);
}

function sameJson(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Parses `forks.txt`: `<npm package>|<vendored fork directory>|<mode>`. The mode is explicit so
 * a compiled fork can never be deployed by an overlay path that looks the same in a diff.
 */
export function parseForksFile(text, label = "forks.txt") {
	const entries = [];
	text.split(/\r?\n/).forEach((line, index) => {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) return;
		const fields = trimmed.split("|").map((field) => field.trim());
		if (fields.length !== 3 || fields.some((field) => field === "")) {
			throw new Error(`${label}:${index + 1}: expected "<npm package>|<vendored fork directory>|<mode>"`);
		}
		const [packageName, forkDir, mode] = fields;
		if (!FORK_MODES.includes(mode)) {
			throw new Error(`${label}:${index + 1}: unknown deployment mode "${mode}" (expected ${FORK_MODES.join(" or ")})`);
		}
		entries.push({ packageName, forkDir, mode, line: index + 1 });
	});
	if (entries.length === 0) throw new Error(`${label}: no fork entries`);
	return entries;
}

function readForksFile(forksFile) {
	return parseForksFile(fs.readFileSync(forksFile, "utf8"), forksFile);
}

/** Orders added keys after the installed ones so an unchanged package.json stays byte-identical. */
function mergeExportMaps({ builtManifest, targetManifest, distDir, packageName }) {
	const builtExports = builtManifest.exports;
	const targetExports = targetManifest.exports;
	if (!builtExports || typeof builtExports !== "object" || Array.isArray(builtExports)) {
		throw new Error(`${packageName} build has no exports map; refusing to merge a manifest without public exports`);
	}
	if (!targetExports || typeof targetExports !== "object" || Array.isArray(targetExports)) {
		throw new Error(`installed ${packageName} has no exports map; refusing to overwrite an unknown layout`);
	}
	const merged = {};
	for (const [name, value] of Object.entries(targetExports)) merged[name] = value;
	const added = [];
	for (const [name, value] of Object.entries(builtExports)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`${packageName} build export "${name}" is not a {types, default} object: ${JSON.stringify(value)}`);
		}
		const extraKeys = Object.keys(value).filter((key) => key !== "types" && key !== "default");
		if (extraKeys.length > 0) {
			throw new Error(`${packageName} build export "${name}" has unexpected conditions: ${extraKeys.join(", ")}`);
		}
		for (const [kind, target] of Object.entries(value)) {
			if (typeof target !== "string" || !target.startsWith("./")) {
				throw new Error(`${packageName} build export "${name}" ${kind} target is not a package-relative path: ${JSON.stringify(target)}`);
			}
			if (!isRegularFile(path.join(distDir, ...target.slice(2).split("/")))) {
				throw new Error(`${packageName} build export "${name}" ${kind} must point at a regular file, ${target} is not one`);
			}
		}
		if (!(name in merged)) {
			merged[name] = value;
			added.push(name);
			continue;
		}
		const installed = merged[name];
		if (!installed || typeof installed !== "object" || installed.types !== value.types || installed.default !== value.default) {
			throw new Error(
				`${packageName} export "${name}" differs between the installed package (${JSON.stringify(installed)}) and the build ` +
					`(${JSON.stringify(value)}); refusing to replace an installed public shape with a build`,
			);
		}
	}
	const dropped = Object.keys(targetExports).filter((name) => !(name in builtExports));
	if (dropped.length > 0) {
		throw new Error(
			`installed ${packageName} exports ${dropped.join(", ")} which the build does not produce; ` +
				"the deployed bundle would lose them",
		);
	}
	return { exports: merged, added };
}

/**
 * Describes a tree without following links. Symlinks and non-regular entries are collected as
 * violations: a managed subtree must be plain files and directories, so nothing can be read
 * from or written through a link that points outside the package.
 */
function describeTree(root, label) {
	const entries = new Map();
	const violations = [];
	const rootStat = lstatOrNull(root);
	if (!rootStat) return { entries, violations };
	if (!rootStat.isDirectory()) {
		violations.push(`${label} is ${describeStat(rootStat)}`);
		return { entries, violations };
	}
	const pending = [""];
	while (pending.length > 0) {
		const current = pending.pop();
		const directory = current ? path.join(root, ...current.split("/")) : root;
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const relative = current ? `${current}/${entry.name}` : entry.name;
			const absolute = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) {
				violations.push(`${label}/${relative} is a symlink`);
				continue;
			}
			if (entry.isDirectory()) {
				entries.set(relative, { type: "directory" });
				pending.push(relative);
				continue;
			}
			if (entry.isFile()) {
				entries.set(relative, { type: "file", mode: (lstatOrNull(absolute)?.mode ?? 0) & 0o777 });
				continue;
			}
			violations.push(`${label}/${relative} is an unsupported file type`);
		}
	}
	return { entries, violations };
}

/** Content+mode digest of a described tree; used to prove nothing moved between plan and write. */
function digestTree(root, entries) {
	const lines = [...entries.entries()]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([relative, info]) => {
			if (info.type === "directory") return `${relative}\0directory`;
			const content = fs.readFileSync(path.join(root, ...relative.split("/")));
			return `${relative}\0file\0${info.mode.toString(8)}\0${sha256(content)}`;
		});
	return sha256(lines.join("\n"));
}

/** Topmost entries of the install that the build no longer produces. */
function staleEntries({ source, target }) {
	return [...target.entries.keys()]
		.filter((relative) => {
			if (source.entries.has(relative)) return false;
			const parts = relative.split("/");
			for (let index = 1; index < parts.length; index += 1) {
				if (!source.entries.has(parts.slice(0, index).join("/"))) return false;
			}
			return true;
		})
		.sort();
}

/**
 * Plans one managed-subtree mirror. Both trees are walked completely before anything is
 * deleted, so a symlink or a type conflict refuses the deploy with the install untouched.
 */
function planMirror({ from, to, label }) {
	const source = describeTree(from, label);
	if (source.entries.size === 0 && source.violations.length === 0) {
		throw new Error(`${label} is missing or empty; refusing to mirror it`);
	}
	const targetLabel = to;
	const target = describeTree(to, targetLabel);
	const violations = [...source.violations, ...target.violations];
	for (const [relative, info] of source.entries) {
		const existing = target.entries.get(relative);
		if (existing && existing.type !== info.type) {
			violations.push(`${label}/${relative}: the build has a ${info.type} where the install has a ${existing.type}`);
		}
	}
	if (violations.length > 0) {
		throw new Error(`refusing to deploy ${label}:\n  - ${violations.join("\n  - ")}`);
	}
	const deletions = staleEntries({ source, target });
	return {
		from,
		to,
		label,
		targetLabel,
		source,
		target,
		deletions,
		copies: [...source.entries.entries()].filter(([, info]) => info.type === "file").map(([relative]) => relative).sort(),
		sourceDigest: digestTree(from, source.entries),
		targetDigest: digestTree(to, target.entries),
	};
}

/** Content/mode/absence snapshot without following a file symlink. */
function fingerprintFile(file) {
	const stat = lstatOrNull(file);
	if (!stat) return "missing";
	if (!stat.isFile()) return describeStat(stat);
	return `${(stat.mode & 0o777).toString(8)}:${sha256(fs.readFileSync(file))}`;
}

/**
 * Plans the compiled root files (index.js/index.d.ts, runner entries, static docs).
 * Root entries are never deleted: an install may hold files this build does not produce.
 */
function planRootFiles({ distDir, targetDir, names, forkRelative }) {
	const violations = [];
	const files = [];
	for (const name of new Set(names).values()) {
		const source = path.join(distDir, name);
		const sourceStat = lstatOrNull(source);
		if (!sourceStat?.isFile()) {
			violations.push(`${forkRelative}/dist-pkg/${name} is ${describeStat(sourceStat)}`);
			continue;
		}
		const target = path.join(targetDir, name);
		const targetStat = lstatOrNull(target);
		if (targetStat && !targetStat.isFile()) {
			violations.push(`${name} in the install is ${describeStat(targetStat)}; refusing to replace it`);
			continue;
		}
		files.push({ from: source, to: target, name });
	}
	if (violations.length > 0) throw new Error(`refusing to deploy the build root files:\n  - ${violations.join("\n  - ")}`);
	return files;
}

async function loadArtifactVerifier({ forkDir, forkRelative }) {
	const verifyPath = path.join(forkDir, "scripts", "verify-build.mjs");
	if (!isRegularFile(verifyPath)) {
		throw new Error(`${forkRelative}/scripts/verify-build.mjs is missing; built mode needs the artifact verifier`);
	}
	const module = await import(pathToFileURL(verifyPath).href);
	if (typeof module.verifyBuiltArtifact !== "function") {
		throw new Error(`${forkRelative}/scripts/verify-build.mjs does not export verifyBuiltArtifact`);
	}
	return module;
}

function artifactGuard({ forkDir, distDir, artifact, verify }) {
	return {
		verify,
		forkDir,
		distDir,
		sourceDigest: artifact.sourceDigest,
		artifactDigest: artifact.artifactDigest,
	};
}

function planSourceMode({ entry, forkDir, targetDir, forkManifest, targetManifest }) {
	const sourceDir = path.join(forkDir, "src");
	if (!isRealDirectory(sourceDir)) throw new Error(`${entry.forkDir}/src is missing or not a directory; nothing to overlay`);
	const mirror = planMirror({ from: sourceDir, to: path.join(targetDir, "src"), label: `${entry.forkDir}/src` });
	const notes = [];
	if (targetManifest.version && forkManifest.version && targetManifest.version !== forkManifest.version) {
		notes.push(`note: npm has ${entry.packageName}@${targetManifest.version}, fork is ${forkManifest.version}`);
		notes.push("      (a vendored fork may carry newer upstream source; see VENDOR.md)");
	}
	return {
		entry,
		mode: "source",
		forkDir,
		targetDir,
		version: forkManifest.version,
		notes,
		mirrors: [mirror],
		rootFiles: [],
		manifest: null,
		exportsAdded: [],
		artifactDigest: null,
		guard: {
			sources: [{ path: mirror.from, label: mirror.label, digest: mirror.sourceDigest }],
			targets: [{ path: mirror.to, label: mirror.targetLabel, digest: mirror.targetDigest }],
			artifact: null,
		},
	};
}

function planBuiltMode({ entry, forkDir, targetDir, targetManifest, artifact, verify }) {
	const { packageName, mode } = entry;
	const distDir = path.join(forkDir, "dist-pkg");
	if (!isRealDirectory(distDir)) {
		throw new Error(`${entry.forkDir}/dist-pkg is ${describeStat(lstatOrNull(distDir))}; refusing to deploy a linked build output`);
	}
	const builtManifest = readManifestFile(path.join(distDir, "package.json"), `${entry.forkDir}/dist-pkg/package.json`);

	if (artifact.version !== targetManifest.version) {
		throw new Error(
			`${packageName} version skew: the build is ${artifact.version} but npm installed ${JSON.stringify(targetManifest.version)}; ` +
				"align packages.txt (and the fork version) with the build, then install that version before deploying",
		);
	}
	for (const field of ["dependencies", "peerDependencies"]) {
		if (!sameJson(builtManifest[field], targetManifest[field])) {
			throw new Error(
				`${packageName} ${field} skew: the build expects ${JSON.stringify(builtManifest[field])} but the install has ` +
					`${JSON.stringify(targetManifest[field])}; compiled code would resolve different runtime modules`,
			);
		}
	}
	for (const directory of ["bundle", "src"]) {
		if (!isRealDirectory(path.join(targetDir, directory))) {
			throw new Error(
				`installed ${packageName} has no ${directory}/ directory; built mode deploys onto the compiled npm layout only`,
			);
		}
	}
	if (!sameJson(builtManifest.pi?.extensions, targetManifest.pi?.extensions)) {
		throw new Error(
			`${packageName} pi.extensions skew: build is ${JSON.stringify(builtManifest.pi?.extensions)}, ` +
				`install is ${JSON.stringify(targetManifest.pi?.extensions)}`,
		);
	}
	for (const key of ["skills", "prompts"]) {
		if (!sameJson(builtManifest.pi?.[key], targetManifest.pi?.[key])) {
			throw new Error(
				`${packageName} pi.${key} skew: build is ${JSON.stringify(builtManifest.pi?.[key])}, ` +
					`install is ${JSON.stringify(targetManifest.pi?.[key])}`,
			);
		}
	}
	const { exports: mergedExports, added } = mergeExportMaps({ builtManifest, targetManifest, distDir, packageName });

	const rootNames = [];
	for (const rootEntry of fs.readdirSync(distDir, { withFileTypes: true })) {
		if (rootEntry.isSymbolicLink()) throw new Error(`${entry.forkDir}/dist-pkg/${rootEntry.name} is a symlink; refusing to deploy it`);
		if (rootEntry.isFile() && !NOT_DEPLOYED_ROOT_FILES.has(rootEntry.name)) rootNames.push(rootEntry.name);
		if (rootEntry.isDirectory() && !MANAGED_DIRECTORIES.includes(rootEntry.name)) {
			throw new Error(
				`${entry.forkDir}/dist-pkg/${rootEntry.name}/ is an unexpected build directory; ` +
					`managed subtrees are ${MANAGED_DIRECTORIES.join(", ")}`,
			);
		}
	}
	const rootFiles = planRootFiles({ distDir, targetDir, names: rootNames, forkRelative: entry.forkDir });
	const mirrors = MANAGED_DIRECTORIES.map((directory) => {
		const from = path.join(distDir, directory);
		if (!isRealDirectory(from)) throw new Error(`${entry.forkDir}/dist-pkg/${directory}/ is missing from the build`);
		return planMirror({ from, to: path.join(targetDir, directory), label: `${entry.forkDir}/dist-pkg/${directory}` });
	});

	const manifestPath = path.join(targetDir, "package.json");
	const manifestStat = lstatOrNull(manifestPath);
	if (!manifestStat?.isFile()) {
		throw new Error(`installed ${packageName} package.json is ${describeStat(manifestStat)}; refusing to write the manifest through it`);
	}

	return {
		entry,
		mode,
		forkDir,
		targetDir,
		version: artifact.version,
		sourceDigest: artifact.sourceDigest,
		artifactDigest: artifact.artifactDigest,
		notes: [],
		mirrors,
		rootFiles,
		manifest: { path: manifestPath, value: { ...targetManifest, exports: mergedExports }, mode: manifestStat.mode & 0o777 },
		exportsAdded: added,
		guard: {
			sources: mirrors.map((mirror) => ({ path: mirror.from, label: mirror.label, digest: mirror.sourceDigest })),
			targets: mirrors.map((mirror) => ({ path: mirror.to, label: mirror.targetLabel, digest: mirror.targetDigest })),
			artifact: artifactGuard({ forkDir, distDir, artifact, verify }),
			files: [...rootFiles.map((file) => file.to), manifestPath].map((file) => ({
				path: file,
				digest: fingerprintFile(file),
			})),
		},
	};
}

/**
 * Resolves the installed package directory once. A pnpm install links
 * `node_modules/<pkg>` at the store, and that link is legitimate: writes go through the
 * resolved real directory so the link itself is preserved.
 */
function resolveInstalledTarget({ npmRoot, packageName }) {
	const lexicalTarget = path.join(npmRoot, packageName);
	const manifestPath = path.join(lexicalTarget, "package.json");
	const manifestStat = lstatOrNull(manifestPath);
	if (!manifestStat) {
		throw new Error(`${packageName} is not installed under ${npmRoot}; install the package before deploying the fork`);
	}
	if (!manifestStat.isFile()) {
		throw new Error(`${packageName} package.json is ${describeStat(manifestStat)}; refusing to deploy through it`);
	}
	const resolved = fs.realpathSync(lexicalTarget);
	if (!isRealDirectory(resolved)) {
		throw new Error(`${packageName} resolves to ${describeStat(lstatOrNull(resolved))} instead of a package directory`);
	}
	return resolved;
}

/**
 * Validates one forks.txt entry and returns the writes that would deploy it.
 *
 * `allowMissingTarget` is preflight: it validates fork/build readiness only, because it runs
 * before `pi install` has aligned the installed package with packages.txt. The strict
 * installed version/dependency/layout checks belong to deploy, after that install.
 */
export async function planForkDeploy({ entry, repoRoot, npmRoot, allowMissingTarget = false }) {
	const forkDir = path.resolve(repoRoot, entry.forkDir);
	const forkManifest = readManifestFile(path.join(forkDir, "package.json"), `${entry.forkDir}/package.json`);
	if (forkManifest.name !== entry.packageName) {
		throw new Error(`${entry.forkDir}/package.json is ${JSON.stringify(forkManifest.name)}, forks.txt expects ${JSON.stringify(entry.packageName)}`);
	}
	const verify = entry.mode === "built" ? await loadArtifactVerifier({ forkDir, forkRelative: entry.forkDir }) : null;
	if (verify) {
		const distStat = lstatOrNull(path.join(forkDir, "dist-pkg"));
		if (distStat && !distStat.isDirectory()) {
			throw new Error(`${entry.forkDir}/dist-pkg is ${describeStat(distStat)}; refusing to verify a linked build output`);
		}
	}
	// Fork-side readiness: an absent, stale, tampered or malformed build is refused here, which is
	// what install.sh needs before it installs anything.
	const artifact = verify ? verify.verifyBuiltArtifact({ root: forkDir }) : null;
	if (!verify && !isRealDirectory(path.join(forkDir, "src"))) {
		throw new Error(`${entry.forkDir}/src is missing or not a directory; nothing to overlay`);
	}
	if (allowMissingTarget) {
		return {
			entry,
			mode: entry.mode,
			forkDir,
			targetDir: path.join(npmRoot, entry.packageName),
			version: artifact?.version ?? forkManifest.version,
			artifact,
			notes: [],
			pendingInstall: true,
		};
	}
	const targetDir = resolveInstalledTarget({ npmRoot, packageName: entry.packageName });
	const targetManifest = readManifestFile(path.join(targetDir, "package.json"), `installed ${entry.packageName}`);
	if (entry.mode === "source") return planSourceMode({ entry, forkDir, targetDir, forkManifest, targetManifest });
	return planBuiltMode({ entry, forkDir, targetDir, targetManifest, artifact, verify });
}

let tempCounter = 0;

function tempPathFor(target) {
	tempCounter += 1;
	return path.join(path.dirname(target), `.${path.basename(target)}${TEMP_SUFFIX}-${process.pid}-${tempCounter}`);
}

/**
 * Writes through an exclusive temporary sibling and renames it into place. The destination inode
 * is replaced rather than truncated, so a pnpm store hardlink shared with another install is
 * never mutated, and a failure mid-write cannot leave a half-written package file behind.
 */
function copyFileAtomically(source, target, mode) {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const temporary = tempPathFor(target);
	try {
		fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
		fs.chmodSync(temporary, mode);
		fs.renameSync(temporary, target);
	} catch (error) {
		fs.rmSync(temporary, { force: true });
		throw error;
	}
}

function writeFileAtomically(content, target, mode) {
	const temporary = tempPathFor(target);
	try {
		fs.writeFileSync(temporary, content, { flag: "wx", mode });
		fs.chmodSync(temporary, mode);
		fs.renameSync(temporary, target);
	} catch (error) {
		fs.rmSync(temporary, { force: true });
		throw error;
	}
}

function applyMirror(mirror) {
	fs.mkdirSync(mirror.to, { recursive: true });
	for (const relative of mirror.deletions) {
		fs.rmSync(path.join(mirror.to, ...relative.split("/")), { recursive: true, force: true });
	}
	for (const [relative, info] of mirror.source.entries) {
		if (info.type === "directory") fs.mkdirSync(path.join(mirror.to, ...relative.split("/")), { recursive: true });
	}
	for (const relative of mirror.copies) {
		const info = mirror.source.entries.get(relative);
		copyFileAtomically(
			path.join(mirror.from, ...relative.split("/")),
			path.join(mirror.to, ...relative.split("/")),
			info.mode,
		);
	}
	return mirror.copies.length;
}

/**
 * Re-reads everything the plan was derived from. Any drift refuses the write, so a package that
 * changed between planning and writing is never overwritten with a stale decision.
 */
function recheckGuard(guard) {
	const problems = [];
	for (const watched of [...guard.sources, ...guard.targets]) {
		const described = describeTree(watched.path, watched.label);
		problems.push(...described.violations);
		if (digestTree(watched.path, described.entries) !== watched.digest) {
			problems.push(`${watched.label} changed between planning and writing`);
		}
	}
	for (const watched of guard.files ?? []) {
		if (fingerprintFile(watched.path) !== watched.digest) {
			problems.push(`${watched.path} changed between planning and writing`);
		}
	}
	if (guard.artifact) {
		const summary = guard.artifact.verify.verifyBuiltArtifact({ root: guard.artifact.forkDir, distDir: guard.artifact.distDir });
		if (summary.sourceDigest !== guard.artifact.sourceDigest || summary.artifactDigest !== guard.artifact.artifactDigest) {
			problems.push("the build artifact changed between planning and writing");
		}
	}
	if (problems.length > 0) {
		throw new Error(`refusing to write: the planned deploy is no longer current\n  - ${problems.join("\n  - ")}`);
	}
}

/** Applies a plan returned by `planForkDeploy`. Never called after a refusal. */
export function applyForkDeploy(plan) {
	recheckGuard(plan.guard);
	let filesCopied = 0;
	for (const mirror of plan.mirrors) filesCopied += applyMirror(mirror);
	for (const file of plan.rootFiles) {
		const mode = (lstatOrNull(file.from)?.mode ?? 0o644) & 0o777;
		copyFileAtomically(file.from, file.to, mode);
		filesCopied += 1;
	}
	// The manifest is written last: a partial file copy stays repairable, a manifest that
	// advertises exports whose files are missing is not.
	if (plan.manifest) {
		writeFileAtomically(`${JSON.stringify(plan.manifest.value, null, 2)}\n`, plan.manifest.path, plan.manifest.mode);
	}
	return {
		packageName: plan.entry.packageName,
		mode: plan.mode,
		version: plan.version,
		filesCopied,
		exportsAdded: plan.exportsAdded,
		notes: plan.notes,
	};
}

function describePlan(plan) {
	if (plan.pendingInstall) {
		if (plan.mode === "source") return `${plan.entry.packageName} (source overlay ${plan.version}) will deploy after the package install`;
		return `${plan.entry.packageName} (built ${plan.version}, artifact fresh) will deploy after the package install`;
	}
	if (plan.mode === "source") return `${plan.entry.packageName} (source overlay ${plan.version})`;
	const added = plan.exportsAdded.length > 0 ? `, ${plan.exportsAdded.length} new export(s)` : "";
	return `${plan.entry.packageName} (built ${plan.version}, artifact fresh${added})`;
}

export async function runForkCommand({ command, forksFile, npmRoot, log = console.log, logError = console.error }) {
	if (command !== "preflight" && command !== "deploy") {
		throw new Error(`unknown command ${JSON.stringify(command)} (expected "preflight" or "deploy")`);
	}
	if (!npmRoot) throw new Error("--npm-root is required");
	const entries = readForksFile(forksFile);
	// forks.txt lives at the root the fork directories are relative to.
	const repoRoot = path.dirname(path.resolve(forksFile));
	const allowMissingTarget = command === "preflight";
	// Every entry is planned before any is applied, so a refusal on a later package cannot leave
	// earlier packages overwritten. This is a validation order, not a transaction: an IO failure
	// during the apply loop can still leave one package partially written.
	const plans = [];
	for (const entry of entries) plans.push(await planForkDeploy({ entry, repoRoot, npmRoot, allowMissingTarget }));
	for (const plan of plans) {
		if (allowMissingTarget) {
			log(`   preflight ok: ${describePlan(plan)}`);
			continue;
		}
		const result = applyForkDeploy(plan);
		for (const note of result.notes) logError(`   ${note}`);
		const detail = result.mode === "built" ? `, ${result.filesCopied} files` : "";
		log(`   deployed ${result.packageName} <- ${plan.entry.forkDir} (${result.mode} ${result.version}${detail})`);
	}
	return entries;
}

function parseArguments(argv) {
	const options = { forks: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "forks.txt") };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag !== "--forks" && flag !== "--npm-root") throw new Error(`unknown option ${JSON.stringify(flag)}`);
		const value = argv[index + 1];
		if (!value) throw new Error(`${flag} requires a path`);
		options[flag === "--forks" ? "forks" : "npmRoot"] = path.resolve(value);
		index += 1;
	}
	return options;
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
	const [command, ...rest] = process.argv.slice(2);
	try {
		const options = parseArguments(rest);
		await runForkCommand({ command, forksFile: options.forks, npmRoot: options.npmRoot });
	} catch (error) {
		console.error(`adripi: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
