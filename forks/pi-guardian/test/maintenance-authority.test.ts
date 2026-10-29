import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadGuardianConfig } from "../src/config.ts";
import guardianExtension from "../src/index.ts";
import {
	MAINTENANCE_AUTHORITY_SOURCE,
	maintenanceRuleText,
	resolveMaintenanceAuthority,
} from "../src/maintenance.ts";
import { evaluatePermissions } from "../src/permissions.ts";
import { createSandboxBroker, getSandboxBroker } from "../src/sandbox/broker.ts";
import { builtinSandboxDenyRules, evaluateLayeredSandboxRules } from "../src/sandbox/rules.ts";
import type {
	SandboxAuditRecord,
	SandboxExceptionRequest,
	SandboxExceptionRules,
} from "../src/sandbox/types.ts";

const scratch = process.env.PI_SANDBOX_SCRATCH ?? tmpdir();
const emptyRules: SandboxExceptionRules = { allow: [], defer: [], deny: [] };

function workspace(prefix: string): string {
	return mkdtempSync(join(scratch, prefix));
}

function request(overrides: Partial<SandboxExceptionRequest> = {}): SandboxExceptionRequest {
	return {
		id: "req-1",
		origin: "tool",
		surface: "write",
		target: "/tmp/unused",
		scope: "once",
		reason: "The installer repository maintains the profile it ships.",
		cwd: "/work/project",
		...overrides,
	};
}

test("maintenance authority needs a trusted root and both spellings inside it", () => {
	const root = workspace("guardian-maintenance-roots-");
	try {
		const project = join(root, "project");
		const outside = join(root, "outside");
		mkdirSync(join(project, "forks", "pi-sbx"), { recursive: true });
		mkdirSync(outside);
		// A cwd that is spelled inside the project but leaves it, and a cwd that is
		// spelled outside it but lands in it.
		symlinkSync(outside, join(project, "escape"));
		symlinkSync(project, join(root, "alias"));

		const decide = (cwd: string, roots: readonly string[] | undefined = [project]) =>
			resolveMaintenanceAuthority(roots, cwd);

		const granted = decide(project);
		assert.ok(granted);
		assert.equal(granted.root, project);
		assert.equal(granted.source, MAINTENANCE_AUTHORITY_SOURCE);
		assert.match(maintenanceRuleText(granted, join(project, "x")), /^permissions\.agentDirWriteProjects\(/);

		assert.ok(decide(join(project, "forks", "pi-sbx")));
		assert.ok(decide(`${project}/./forks/`));
		// Ordinary sibling, a parent of the root, and no configured roots at all.
		assert.equal(decide(join(root, "sibling")), undefined);
		assert.equal(decide(root), undefined);
		assert.equal(decide(`${project}/../outside`), undefined);
		assert.equal(decide(project, []), undefined);
		assert.equal(resolveMaintenanceAuthority(undefined, project), undefined);
		// A cwd symlinked outside the project keeps no authority, and a symlink into
		// it is not a stand-in for the trusted directory either.
		assert.equal(decide(join(project, "escape")), undefined);
		assert.equal(decide(join(project, "escape", "deeper")), undefined);
		assert.equal(decide(join(root, "alias")), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("file permissions grant agent-dir maintenance only from a trusted root", () => {
	const root = workspace("guardian-maintenance-permissions-");
	try {
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		const sibling = join(root, "sibling");
		const auditDir = join(root, "audit");
		for (const directory of [agentDir, project, sibling, auditDir]) mkdirSync(directory, { recursive: true });
		symlinkSync(join(root, "sibling"), join(project, "escape"));
		writeFileSync(
			join(agentDir, "guardian.json"),
			JSON.stringify({
				guardianSessionDir: auditDir,
				permissions: { allow: ["Read", "Write", "Edit"], agentDirWriteProjects: [project] },
			}),
		);
		const config = loadGuardianConfig(agentDir, "/policy");
		const permissions = config.permissions;
		const decide = (cwd: string, tool: string, path: string, extra: Record<string, unknown> = {}) =>
			evaluatePermissions(permissions, tool, { path, ...extra }, cwd, agentDir);

		const settings = join(agentDir, "settings.json");
		const granted = decide(project, "write", settings, { content: "{}" });
		assert.equal(granted.outcome, "allow");
		assert.deepEqual(granted, {
			outcome: "allow",
			rule: `permissions.agentDirWriteProjects(${settings}) root=${project}`,
		});
		// A nested cwd of the trusted project keeps the authority.
		assert.equal(decide(join(project, "forks", "pi-sbx"), "write", join(agentDir, "extensions", "sandbox.json")).outcome, "allow");
		// An ordinary sibling and a cwd that leaves the project through a symlink do not.
		assert.equal(decide(sibling, "write", settings).outcome, "deny");
		assert.equal(decide(join(project, "escape"), "write", settings).outcome, "deny");
		// Credentials and Guardian's own audit trail stay denied, wherever the audit
		// directory is configured.
		for (const tool of ["read", "write", "edit"]) {
			assert.equal(decide(project, tool, join(agentDir, "auth.json")).outcome, "deny", tool);
		}
		assert.equal(decide(project, "write", join(auditDir, "session.jsonl")).outcome, "deny");
		assert.equal(decide(project, "write", join(agentDir, "guardian-sessions", "session.jsonl")).outcome, "deny");
		// The workspace's own policy directory is never agent-writable.
		assert.equal(decide(project, "write", join(project, ".pi", "guardian.json")).outcome, "deny");
		assert.equal(decide(project, "write", join(project, ".pi", "sandbox.json")).outcome, "deny");
		// Reads of other agent files need no grant: only auth.json is hidden.
		assert.equal(decide(sibling, "read", join(agentDir, "guardian.json")).outcome, "allow");
		assert.equal(decide(sibling, "read", join(agentDir, "auth.json")).outcome, "deny");
		// A user deny inside the directory is not lifted by the maintenance grant.
		const denied = evaluatePermissions(
			{ ...permissions, deny: [...permissions.deny, `Edit(/${agentDir}/models.json)`] },
			"write",
			{ path: join(agentDir, "models.json"), content: "{}" },
			project,
			agentDir,
		);
		assert.deepEqual(denied, { outcome: "deny", rule: `Edit(/${agentDir}/models.json)` });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the workspace policy directory is denied through a canonical spelling too", () => {
	const root = workspace("guardian-maintenance-pi-canonical-");
	try {
		const project = join(root, "project");
		mkdirSync(join(project, ".pi"), { recursive: true });
		symlinkSync(project, join(root, "alias"));
		const permissions = { allow: ["Read", "Write", "Edit"], deny: [] };
		const outcome = (path: string) =>
			evaluatePermissions(permissions, "write", { path, content: "{}" }, join(root, "alias"), join(root, "agent")).outcome;
		assert.equal(outcome(join(project, ".pi", "guardian.json")), "deny");
		assert.equal(outcome(join(root, "alias", ".pi", "guardian.json")), "deny");
		assert.equal(outcome(join(project, "src", "main.ts")), "allow");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("sandbox exception admission follows the same maintenance boundary", async () => {
	const root = workspace("guardian-maintenance-broker-");
	try {
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		const sibling = join(root, "sibling");
		const auditDir = join(root, "audit");
		for (const directory of [agentDir, project, sibling, auditDir]) mkdirSync(directory, { recursive: true });
		writeFileSync(join(agentDir, "auth.json"), "{}\n");
		symlinkSync(join(agentDir, "auth.json"), join(root, "cred-link.json"));

		const audits: SandboxAuditRecord[] = [];
		const reviews: SandboxExceptionRequest[] = [];
		const broker = createSandboxBroker({
			rules: emptyRules,
			agentDir,
			sessionDir: auditDir,
			maintenanceRoots: [project],
			maxConsecutiveDenials: 100,
			audit: (record) => audits.push(record),
			review: async (seen) => {
				reviews.push(seen);
				return { outcome: "allow", rationale: `Reviewed ${seen.surface}.` };
			},
		});
		const decide = (overrides: Partial<SandboxExceptionRequest>) =>
			broker.review(request({ id: `req-${audits.length}`, cwd: project, ...overrides }));

		const settings = join(agentDir, "settings.json");
		const maintained = await decide({ target: settings });
		assert.equal(maintained.kind, "allow");
		assert.equal(maintained.kind === "allow" ? maintained.review.source : undefined, "rule");
		assert.deepEqual(
			{ rule: audits[0].rule, decision: audits[0].decision, provenance: audits[0].source },
			{
				rule: `permissions.agentDirWriteProjects(${settings}) root=${project}`,
				decision: "allow",
				provenance: "rule",
			},
		);
		// The grant decides in the rule engine, so the reviewer is never consulted.
		assert.equal(reviews.length, 0);

		// Credentials, the audit trail and the workspace policy directory stay denied.
		for (const [index, target] of [
			join(agentDir, "auth.json"),
			join(auditDir, "session.jsonl"),
			join(project, ".pi", "guardian.json"),
		].entries()) {
			const denied = await decide({ id: `hard-${index}`, target });
			assert.equal(denied.kind, "deny", target);
			assert.equal(denied.kind === "deny" ? denied.review.source : undefined, "rule", target);
		}
		const authRead = await decide({ id: "auth-read", surface: "read", target: join(agentDir, "auth.json") });
		assert.equal(authRead.kind, "deny");
		assert.match(authRead.kind === "deny" ? authRead.reason : "", /by rule read:.*auth\.json/);
		// A symlink alias of a credential file is the credential file.
		const aliasRead = await decide({ id: "auth-alias", surface: "read", target: join(root, "cred-link.json") });
		assert.equal(aliasRead.kind, "deny");
		assert.match(aliasRead.kind === "deny" ? aliasRead.reason : "", /auth\.json/);

		// An ordinary project keeps no agent-dir write authority; other agent files
		// are readable and go to the reviewer like any ordinary read.
		const ordinary = await decide({ id: "ordinary", target: settings, cwd: sibling });
		assert.equal(ordinary.kind, "deny");
		assert.ok((ordinary.kind === "deny" ? ordinary.reason : "").includes(`by rule write:${agentDir}/**`));
		const readable = await decide({ id: "readable", surface: "read", target: settings, cwd: sibling });
		assert.equal(readable.kind, "allow");
		assert.equal(readable.kind === "allow" ? readable.review.source : undefined, "reviewer");
		// The maintenance root never authorizes an unrelated host command.
		const command = await decide({ id: "command", surface: "command", target: "git push origin main" });
		assert.equal(command.kind, "allow");
		assert.equal(command.kind === "allow" ? command.review.source : undefined, "reviewer");
		assert.equal(reviews.length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("user and project restrictions win and project policy cannot create maintenance", async () => {
	const root = workspace("guardian-maintenance-restrictions-");
	try {
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		for (const directory of [agentDir, project]) mkdirSync(directory, { recursive: true });
		const settings = join(agentDir, "settings.json");
		const decide = (rules: SandboxExceptionRules, projectRules?: SandboxExceptionRules) =>
			evaluateLayeredSandboxRules(projectRules, rules, request({ target: settings, cwd: project }), agentDir, {
				maintenance: resolveMaintenanceAuthority([project], project),
			});

		assert.equal(decide({ allow: [], defer: [], deny: [] }).outcome, "allow");
		// A user deny that repeats the built-in lock stays in force: only the
		// built-in spelling is liftable.
		const userDeny = decide({ allow: [], defer: [], deny: [`write:${agentDir}/**`] });
		assert.deepEqual(userDeny, { outcome: "deny", rule: `write:${agentDir}/**` });
		// A narrower user deny inside the directory wins too.
		assert.deepEqual(decide({ allow: [], defer: [], deny: [`write:${settings}`] }), {
			outcome: "deny",
			rule: `write:${settings}`,
		});
		// A global defer still reaches the human instead of being granted.
		assert.deepEqual(decide({ allow: [], defer: [`write:${agentDir}/**`], deny: [] }), {
			outcome: "defer",
			rule: `write:${agentDir}/**`,
		});
		// A project policy cannot create maintenance, but may still restrict it.
		const projectAllow: SandboxExceptionRules = { allow: [`write:${agentDir}/**`], defer: [], deny: [] };
		assert.equal(decide({ allow: [], defer: [], deny: [] }, projectAllow).outcome, "allow");
		const projectDeny: SandboxExceptionRules = { allow: [], defer: [], deny: [`write:${agentDir}/**`] };
		assert.equal(decide({ allow: [], defer: [], deny: [] }, projectDeny).outcome, "deny");
		assert.equal(decide(emptyRules, { allow: [], deny: [], defer: [`write:${agentDir}/**`] }).outcome, "defer");

		// Without a maintenance grant, a project allow cannot open the agent dir.
		const plain = await createSandboxBroker({
			rules: emptyRules,
			projectRules: () => projectAllow,
			agentDir,
			maxConsecutiveDenials: 100,
			review: async () => ({ outcome: "allow", rationale: "should not be reviewed" }),
		}).review(request({ target: settings, cwd: project }));
		assert.equal(plain.kind, "deny");
		assert.match(plain.kind === "deny" ? plain.reason : "", /never grantable/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the published broker carries the trusted global maintenance roots", async () => {
	const directory = workspace("guardian-maintenance-published-");
	const agentDir = join(directory, "agent");
	const project = join(directory, "project");
	const sibling = join(directory, "sibling");
	const auditDir = join(directory, "relocated-audit");
	const reviewerLog = join(directory, "reviewer-calls.log");
	const executable = join(directory, "fake-pi.mjs");
	for (const path of [agentDir, project, sibling, auditDir]) mkdirSync(path, { recursive: true });
	writeFileSync(
		executable,
		`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(${JSON.stringify(reviewerLog)}, JSON.stringify({ prompt }) + "\\n");
const assessment = {risk_level:"low",user_authorization:"medium",outcome:"allow",rationale:"Bounded and authorized."};
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify(assessment)}]}}) + "\\n");
`,
		{ mode: 0o700 },
	);
	chmodSync(executable, 0o700);
	writeFileSync(
		join(agentDir, "guardian.json"),
		JSON.stringify({
			piCommand: executable,
			guardianSessionDir: auditDir,
			maxConsecutiveDenials: 100,
			reviewer: { model: "fake/luna", timeoutMs: 5_000, maxAttempts: 1 },
			permissions: { agentDirWriteProjects: [project] },
		}),
	);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let shutdown: (() => unknown) | undefined;
	try {
		const branch: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "Repair the installed profile from this repo.", timestamp: 0 } as never,
			},
		];
		const handlers = new Map<string, Function>();
		const audits: SandboxAuditRecord[] = [];
		const fakePi = {
			on: (name: string, handler: Function) => handlers.set(name, handler),
			appendEntry(customType: string, data: unknown) {
				if (customType === "guardian-sandbox-exception") audits.push(data as SandboxAuditRecord);
				branch.push({
					type: "custom",
					id: `entry-${branch.length}`,
					parentId: branch.at(-1)?.id ?? null,
					timestamp: new Date().toISOString(),
					customType,
					data,
				});
			},
			registerEntryRenderer() {},
			registerCommand() {},
		} as unknown as ExtensionAPI;
		guardianExtension(fakePi);
		shutdown = () => handlers.get("session_shutdown")?.({});
		const context = {
			hasUI: false,
			mode: "json",
			cwd: project,
			signal: undefined,
			sessionManager: { getBranch: () => structuredClone(branch), getSessionId: () => "maintenance-parent" },
			ui: new Proxy({}, { get() { throw new Error("Headless UI must not be accessed"); } }),
		};
		handlers.get("session_start")!({}, context);
		const broker = getSandboxBroker();
		assert.ok(broker, "the broker must be published so the sandbox can escalate");
		const settings = join(agentDir, "settings.json");
		const decide = (overrides: Partial<SandboxExceptionRequest>) =>
			broker.review(request({ id: `published-${audits.length}`, cwd: project, ...overrides }));

		const maintained = await decide({ target: settings });
		assert.equal(maintained.kind, "allow");
		assert.equal(maintained.kind === "allow" ? maintained.scope : undefined, "once");
		assert.equal(maintained.kind === "allow" ? maintained.review.source : undefined, "rule");
		assert.equal(
			maintained.kind === "allow" ? maintained.review.rationale : undefined,
			`Allowed by rule permissions.agentDirWriteProjects(${settings}) root=${project}.`,
		);
		// Provenance is one concise line with paths only.
		assert.equal(audits[0].rule, `permissions.agentDirWriteProjects(${settings}) root=${project}`);
		assert.doesNotMatch(String(audits[0].rule), /[\r\n]/);

		const denied: Array<[Partial<SandboxExceptionRequest>, string]> = [
			[{ target: join(agentDir, "auth.json") }, `write:${agentDir}/auth.json`],
			[{ target: join(auditDir, "session.jsonl") }, `write:${auditDir}/**`],
			[{ target: join(project, ".pi", "guardian.json") }, `write:${project}/.pi/**`],
			[{ surface: "read", target: join(agentDir, "auth.json") }, `read:${agentDir}/auth.json`],
		];
		for (const [overrides, rule] of denied) {
			const decision = await decide({ id: `denied-${audits.length}`, ...overrides });
			assert.equal(decision.kind, "deny", String(overrides.target));
			assert.ok(
				(decision.kind === "deny" ? decision.reason : "").includes(`by rule ${rule}`),
				`${String(overrides.target)}: ${decision.kind === "deny" ? decision.reason : ""}`,
			);
			assert.equal(decision.kind === "deny" ? decision.review.source : undefined, "rule");
		}
		const mismatched = await decide({ id: "mismatched", target: settings, cwd: sibling });
		assert.equal(mismatched.kind, "deny");
		assert.match(mismatched.kind === "deny" ? mismatched.reason : "", /does not match the active Guardian session/);
		// The host command is the only request here that needs the reviewer.
		const command = await decide({ id: "command", surface: "command", target: "git push origin main" });
		assert.equal(command.kind, "allow");
		assert.equal(command.kind === "allow" ? command.review.source : undefined, "reviewer");
		const reviewerCalls = readFileSync(reviewerLog, "utf8").trim().split("\n");
		assert.equal(reviewerCalls.length, 1);
		assert.equal((JSON.parse(reviewerCalls[0]) as { prompt: string }).prompt.includes("git push"), true);
		// A session rooted in the sibling cannot impersonate the privileged one.
		handlers.get("session_start")!({}, { ...context, cwd: sibling });
		const forged = await getSandboxBroker()!.review(request({ cwd: project, target: settings }));
		assert.equal(forged.kind, "deny");
		assert.match(forged.kind === "deny" ? forged.reason : "", /does not match the active Guardian session/);
	} finally {
		await shutdown?.();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the built-in sandbox denies keep credentials, audit and the broad lock apart", () => {
	const agentDir = "/srv/pi-agent";
	const auditDir = "/srv/pi-audit";
	const rules = builtinSandboxDenyRules(agentDir, auditDir);
	assert.ok(rules.includes(`read:${agentDir}/auth.json`));
	assert.ok(!rules.includes(`read:${agentDir}/**`), "other agent files are readable");
	assert.ok(rules.includes(`write:${agentDir}/auth.json`));
	assert.ok(rules.includes(`write:${auditDir}/**`));
	assert.ok(rules.includes(`write:${agentDir}/**`));
	// The default audit directory stays denied when none is configured.
	assert.ok(builtinSandboxDenyRules(agentDir).includes(`write:${join(agentDir, "guardian-sessions")}/**`));
});
