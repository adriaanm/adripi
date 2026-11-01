// Credential-free source composition. This gate needs `just build-subagents`:
// it uses the complete verified build, not an API facade/source-only overlay.
// Actual SDK/registered consumers/runner/IPC/parent services; explicit SRT backend,
// provider, reviewer verdict/usage and human-answer fixtures. NOT OS/live acceptance.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { before } from "node:test";
import { fixture } from "../forks/pi-guardian/test/support/delegated-parent.ts";
import { findGuardianState } from "../forks/pi-guardian/src/state.ts";
import { GUARDIAN_STATE_ENTRY } from "../forks/pi-guardian/src/types.ts";
import { guardianUsageView } from "../forks/pi-guardian/src/usage.ts";
import { publishChildAuthority } from "../forks/pi-sbx/src/child-authority.ts";
import { createFilePolicy } from "../forks/pi-sbx/src/path-policy.ts";
import { createChildAuthorityController } from "../forks/pi-subagents/src/api/child-authority.ts";
import { registerRequiredChildExtensions } from "../forks/pi-subagents/src/api/required-child-extensions.ts";
import { verifyBuiltArtifact } from "../forks/pi-subagents/scripts/verify-build.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const subagents = path.join(repo, "forks/pi-subagents");
before(() => verifyBuiltArtifact({ root: subagents }));

function install(f, options) {
	const modules = path.join(f.agentDir, "npm/node_modules");
	mkdirSync(modules, { recursive: true });
	for (const pkg of ["pi-sbx", "pi-guardian"]) {
		cpSync(path.join(repo, "forks", pkg, "src"), path.join(modules, pkg, "src"), { recursive: true });
		writeFileSync(path.join(modules, pkg, "package.json"), JSON.stringify({ type: "module", version: "0.0.0-source-fixture" }));
	}
	cpSync(path.join(subagents, "dist-pkg"), path.join(modules, "pi-subagents"), { recursive: true });
	verifyBuiltArtifact({ root: subagents, distDir: path.join(modules, "pi-subagents") });
	mkdirSync(path.join(modules, "@earendil-works"));
	for (const dep of ["pi-coding-agent", "pi-ai", "pi-tui", "pi-agent-core"]) {
		symlinkSync(realpathSync(path.join(subagents, "node_modules/@earendil-works", dep)), path.join(modules, "@earendil-works", dep), "dir");
	}
	for (const dep of ["minimatch", "typebox"]) {
		symlinkSync(realpathSync(path.join(repo, "forks/pi-sbx/node_modules", dep)), path.join(modules, dep), "dir");
	}
	mkdirSync(path.join(f.agentDir, "extensions"));
	writeFileSync(path.join(f.agentDir, "extensions/sandbox.json"), "poison root profile must never be loaded by child");
	const mock = path.join(modules, "@anthropic-ai/sandbox-runtime"), journal = path.join(f.root, "runtime.jsonl");
	mkdirSync(mock, { recursive: true });
	writeFileSync(path.join(mock, "package.json"), JSON.stringify({ type: "module", exports: { ".": "./index.js" }, version: "0.0.74-test-backend" }));
	const schema = pathToFileURL(path.join(repo, "forks/pi-sbx/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js")).href;
	// Only the OS backend is replaced. The real SandboxController owns activation,
	// configuration, callback registration, scoped rollback and fail-closed state.
	writeFileSync(path.join(mock, "index.js"), `
import {appendFileSync} from 'node:fs';
export {SandboxRuntimeConfigSchema} from ${JSON.stringify(schema)};
let config, ask;
const record=(event,extra={})=>appendFileSync(${JSON.stringify(journal)},JSON.stringify({event,config,...extra})+'\\n');
export const SandboxManager={
 isSupportedPlatform:()=>${!options.runtimeUnavailable},checkDependencies:()=>({errors:[],warnings:[]}),
 initialize:async(c,a)=>{config=c;ask=a;record('initialize')},getConfig:()=>config,
 updateConfig:c=>{config=c;record('update')},reset:async()=>{config=undefined;record('reset')},isSandboxingEnabled:()=>!!config,
 wrapWithSandbox:async command=>{record('wrap',{command});if(command==='printf network-probe'){
  const host=${JSON.stringify(options.networkHost ?? "held.example")};const allowed=await ask({host,port:443});record('network',{host,allowed});if(!allowed)throw new Error('fixture connection refused');
 }return command},cleanupAfterCommand(){},annotateStderrWithSandboxFailures:(_id,text)=>text};
`);
	const extensions = ["pi-sbx", "pi-guardian"].map(id => ({ id, path: path.join(modules, id, "src/index.ts") }));
	if (options.brokenGuardian) writeFileSync(extensions[1].path, "throw new Error('guardian-import-broken');");
	const additionalExtensions = [];
	if (options.foreignOwner || options.startupGeneration) {
		const extra = path.join(modules, "startup-negative.ts");
		writeFileSync(extra, options.foreignOwner
			? `import {Type} from 'typebox'; export default function(pi){pi.registerTool({name:'read',label:'foreign-read',description:'must not execute',parameters:Type.Object({path:Type.String()}),execute:async()=>{throw new Error('foreign tool ran')}})}`
			: `export default function(pi){pi.on('session_start',async(_event,ctx)=>{await ctx.modelRegistry.streamSimple(ctx.model,{messages:[]}).result()})}`);
		additionalExtensions.push(extra);
	}
	return { extensions, additionalExtensions, runtime: () => existsSync(journal) ? readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [] };
}

async function run(f, steps, options = {}) {
	const layout = install(f, options), wire = [], humans = [];
	const policy = createFilePolicy({ filesystem: { denyRead: [], allowRead: [], allowWrite: [f.parent], denyWrite: [] },
		mandatoryDenyRead: [path.join(f.agentDir, "auth.json")], mandatoryDenyWrite: [f.agentDir] });
	const publication = publishChildAuthority({ sessionId: "parent", agentDir: f.agentDir, configDirName: ".pi",
		getBaseline: () => ({ cwd: f.parent, policy, allowUnsandboxedCommands: options.host === true, environmentDeny: ["SYNTHETIC_SECRET"],
			runtime: { network: { allowedDomains: ["held.example"], deniedDomains: ["blocked.example"] },
				filesystem: { denyRead: [], allowRead: [], allowWrite: [f.parent], denyWrite: [] } } }),
		getHuman: () => ({ ask: async request => {
			humans.push(request);
			// Deterministic test answers, never a live approval transport/authority.
			return options.human?.(request, humans.length) ?? { kind: "unavailable", reason: "source fixture has no human UI" };
		} }), requiredExtensions: layout.extensions, loadRegistration: async () => ({ registerRequiredChildExtensions }),
	});
	let child, controller, timer, closed, watcher;
	let output = "", error = "";
	try {
		await publication.ready;
		if (options.cancelDuringReview) watcher = watch(f.root, (_event, name) => {
			if (name === "started" && existsSync(f.started)) { watcher.close(); controller.dispose(); }
		});
		child = spawn(process.execPath, ["--experimental-strip-types", path.join(repo, "scripts/fixtures/production-consumer-runner.ts"),
			JSON.stringify({ cwd: f.child, extensions: layout.extensions, additionalExtensions: layout.additionalExtensions, steps })], {
			cwd: f.child, env: { ...process.env, PI_CODING_AGENT_DIR: f.agentDir }, stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
		child.on("message", message => { if (message?.kind === "child-authority:request") wire.push(message.action); });
		closed = new Promise((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
		controller = createChildAuthorityController({ child, provider: publication.provider, sessionId: "parent", runId: "run" });
		timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		await controller.prepare({ agent: "worker", index: 0, cwd: f.child });
		const code = await closed;
		assert.equal(code, 0, error + output);
		const line = output.split("\n").find(line => line.startsWith("PRODUCTION_RESULT "));
		assert.ok(line, output + error);
		const report = JSON.parse(line.slice("PRODUCTION_RESULT ".length));
		assert.equal(report.readyAtGenerations.length, report.calls);
		for (const required of report.readyAtGenerations) assert.deepEqual([...required].sort(), ["pi-guardian", "pi-sbx"]);
		return { ...report, wire, humans, runtime: layout.runtime(), output, error };
	} finally {
		clearTimeout(timer); watcher?.close(); controller?.dispose(); publication.dispose();
		if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
	}
}
const toolResults = report => report.result.messages.filter(message => message.role === "toolResult");
const scratch = f => readdirSync(f.child).filter(name => name.startsWith("pi-sbx-scratch-"));

test("both actual SDK consumers/real IPC: read/write/edit/Bash/output, full evidence, no duplicate held review, disposal", async () => {
	const f = fixture();
	try {
		await f.ask({ path: "seed-state-only" }, { tool_name: "read" });
		f.append(GUARDIAN_STATE_ENTRY, { ...findGuardianState(f.branch), lastReviewedParentEntryId: "parent-cursor" });
		const content = "Exact source data 文🌍 ".repeat(100);
		const report = await run(f, [
			{ name: "write", input: { path: "native.txt", content } },
			{ name: "read", input: { path: "native.txt" } },
			{ name: "edit", input: { path: "native.txt", edits: [{ oldText: content, newText: "edited exactly" }] } },
			{ name: "bash", input: { command: "printf composition-output", output_file: "command.log" } },
		]);
		assert.equal(report.result.exitCode, 0); assert.equal(report.calls, 5);
		assert.ok(toolResults(report).every(result => !result.isError), report.output);
		assert.equal(readFileSync(path.join(f.child, "native.txt"), "utf8"), "edited exactly");
		assert.equal(readFileSync(path.join(f.child, "command.log"), "utf8"), "composition-output");
		assert.deepEqual(f.readPrompts().map(prompt => prompt.action.tool_name), ["write", "edit", "bash"]);
		assert.equal(f.readPrompts()[0].action.input.content, content);
		assert.deepEqual(f.readPrompts()[1].action.input.edits, [{ oldText: content, newText: "edited exactly" }]);
		assert.ok(f.readPrompts().every(prompt => prompt.directives.some(item => item.text.includes("Never deploy"))));
		assert.deepEqual(report.wire.map(action => action.surface), ["tool", "write", "tool", "read", "tool", "read", "write", "tool", "write"]);
		assert.equal(report.humans.length, 0);
		assert.equal(guardianUsageView(f.branch, "parent").totals.review.calls, 3);
		assert.equal(findGuardianState(f.branch).lastReviewedParentEntryId, "parent-cursor");
		assert.equal(f.branch.some(entry => entry.type === "message" && entry.message.role === "assistant"), false);
		assert.equal(report.runtime.filter(event => event.event === "wrap").length, 1);
		assert.deepEqual(report.runtime.find(event => event.event === "initialize").config.network.allowedDomains, []);
		assert.equal(report.runtime.at(-1).event, "reset"); assert.deepEqual(scratch(f), []);
	} finally { f.close(); }
});

for (const [label, options] of [
	["unavailable runtime", { runtimeUnavailable: true }],
	["broken actual Guardian entry", { brokenGuardian: true }],
	["conflicting native read registration", { foreignOwner: true }],
	["startup generation before actual consumer hooks", { startupGeneration: true }],
]) {
	test(`actual combined startup refuses ${label}: zero model calls, no file or scratch leak`, async () => {
		const f = fixture();
		try {
			const report = await run(f, [{ name: "write", input: { path: "must-not-exist", content: "x" } }], options);
			assert.notEqual(report.result.exitCode, 0); assert.equal(report.calls, 0);
			if (options.foreignOwner) assert.match(report.result.error, /Tool "read" conflicts with .*startup-negative/);
			assert.equal(existsSync(path.join(f.child, "must-not-exist")), false);
			assert.deepEqual(report.wire, []); assert.deepEqual(f.readPrompts(), []); assert.deepEqual(scratch(f), []);
		} finally { f.close(); }
	});
}

test("parent semantic termination reaches actual SDK consumers before native mutation or another generation", async () => {
	const f = fixture();
	try {
		const report = await run(f, [{ name: "write", input: { path: "forbidden", content: "FORBIDDEN exact content" } }]);
		assert.notEqual(report.result.exitCode, 0); assert.equal(report.calls, 1);
		assert.equal(existsSync(path.join(f.child, "forbidden")), false);
		assert.deepEqual(report.wire.map(action => action.surface), ["tool"]);
		assert.equal(f.readPrompts().length, 1); assert.equal(guardianUsageView(f.branch, "parent").totals.review.calls, 1);
		assert.deepEqual(scratch(f), []);
	} finally { f.close(); }
});

test("parent maintenance semantic allow cannot make actual native IO write the child SDK agent directory", async () => {
	const f = fixture(), target = path.join(f.agentDir, "settings.json");
	try {
		const report = await run(f, [{ name: "write", input: { path: target, content: "unauthorized maintenance" } }]);
		assert.equal(toolResults(report)[0].isError, true); assert.equal(existsSync(target), false);
		assert.deepEqual(report.wire.map(action => action.surface), ["tool"]);
		assert.deepEqual(f.readPrompts(), []); assert.deepEqual(report.humans, []); assert.deepEqual(scratch(f), []);
	} finally { f.close(); }
});

test("actual Bash output_file admission is independent: unavailable parent human prevents capture and command dispatch", async () => {
	const f = fixture(), target = path.join(f.parent, "unheld-log");
	try {
		const report = await run(f, [{ name: "bash", input: { command: "printf must-not-run", output_file: target } }]);
		assert.equal(toolResults(report)[0].isError, true); assert.equal(existsSync(target), false);
		assert.deepEqual(report.wire.map(action => action.surface), ["tool", "write"]);
		assert.equal(report.humans.length, 1); assert.equal(report.humans[0].surface, "write");
		assert.equal(report.runtime.filter(event => event.event === "wrap").length, 0);
		assert.deepEqual(scratch(f), []);
	} finally { f.close(); }
});

for (const [networkHost, allowed] of [["held.example", true], ["blocked.example", false]]) {
	test(`actual controller connection callback routes ${networkHost} through parent policy (${allowed})`, async () => {
		const f = fixture();
		try {
			const report = await run(f, [{ name: "bash", input: { command: "printf network-probe" } }], { networkHost });
			assert.equal(toolResults(report)[0].isError === true, !allowed);
			assert.deepEqual(report.wire.map(action => action.surface), ["tool", "network"]);
			assert.equal(report.runtime.find(event => event.event === "network").allowed, allowed);
			assert.equal(f.readPrompts().length, 1, "held connection and final static deny add no semantic review");
			assert.deepEqual(report.humans, []); assert.deepEqual(scratch(f), []);
		} finally { f.close(); }
	});
}

test("actual scoped dispatcher restores runtime and cannot lend its one-action path to following native IO", async () => {
	const f = fixture(), outside = path.join(f.parent, "outside"); mkdirSync(outside);
	try {
		const report = await run(f, [
			{ name: "bash", input: { command: "printf scoped", sandbox_permissions: "with_additional_permissions", justification: "Fixture scope", additional_permissions: { file_system: { write: [outside] } } } },
			{ name: "write", input: { path: path.join(outside, "no-lending"), content: "must not write" } },
		], { human: (_request, count) => count === 1 ? { kind: "allow", standing: false } : { kind: "deny", reason: "new native action not admitted" } });
		assert.equal(toolResults(report)[0].isError, false); assert.equal(toolResults(report)[1].isError, true);
		assert.equal(existsSync(path.join(outside, "no-lending")), false); assert.equal(report.humans.length, 2);
		const wrapped = report.runtime.find(event => event.event === "wrap");
		assert.ok(wrapped.config.filesystem.allowWrite.includes(realpathSync(outside)));
		const updates = report.runtime.filter(event => event.event === "update");
		assert.ok(!updates.at(-1).config.filesystem.allowWrite.includes(realpathSync(outside)));
		assert.deepEqual(scratch(f), []);
	} finally { f.close(); }
});

test("actual explicit-host branch needs separate exact parent human and does not wrap or save a standing rule", async () => {
	const f = fixture();
	try {
		const report = await run(f, [{ name: "bash", input: { command: "printf host-admitted", sandbox_permissions: "require_escalated", justification: "Fixture host branch" } }],
			{ host: true, human: () => ({ kind: "allow", standing: false }) });
		assert.equal(toolResults(report)[0].isError, false);
		assert.deepEqual(report.wire.map(action => action.surface), ["tool", "command"]);
		assert.equal(report.humans.length, 1); assert.equal(report.humans[0].target, "printf host-admitted");
		assert.equal(report.humans[0].standingRule, undefined); assert.equal(report.runtime.filter(event => event.event === "wrap").length, 0);
		assert.deepEqual(scratch(f), []);
	} finally { f.close(); }
});

test("real parent cancellation during sidecar review closes both actual consumers before native mutation", async () => {
	const f = fixture(true);
	try {
		const report = await run(f, [{ name: "write", input: { path: "cancelled", content: "must not write" } }], { cancelDuringReview: true });
		assert.notEqual(report.result.exitCode, 0); assert.equal(report.calls, 1);
		assert.equal(existsSync(path.join(f.child, "cancelled")), false); assert.equal(f.readPrompts().length, 1);
		assert.deepEqual(scratch(f), []);
	} finally { f.close(); }
});
