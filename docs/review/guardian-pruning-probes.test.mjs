// Credential-free research probes, NOT a production Guardian pruner.
// Run: node --experimental-strip-types --test docs/review/guardian-pruning-probes.test.mjs
// Uses the existing Guardian dev SDK, without creating an AgentSession or making
// any provider calls. Only synthetic, in-memory sessions are inspected/edited.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { renderGuardianTranscript } from "../../forks/pi-guardian/src/transcript.ts";

const sdkUrl = process.env.GUARDIAN_PROBE_SDK_ROOT
  ? pathToFileURL(resolve(process.env.GUARDIAN_PROBE_SDK_ROOT, "dist/index.js"))
  : new URL("../../forks/pi-guardian/node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url);
const { SessionManager } = await import(sdkUrl.href);
// Diagnostic only: prepareCompaction is not a root public export in SDK 1.0.0.
// Production integration must use AgentSession.compact / supported boundary hooks.
const { prepareCompaction } = await import(new URL("./core/compaction/compaction.js", sdkUrl).href);
const settings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 100 };
const allow = { risk_level: "low", user_authorization: "high", outcome: "allow", rationale: "Bounded fixture." };
const deny = { ...allow, outcome: "deny", rationale: "User explicitly prohibited this target." };

function user(session, text) {
  return session.appendMessage({ role: "user", content: text, timestamp: 1 });
}
function assistant(session, assessment) {
  return session.appendMessage({
    role: "assistant", content: [{ type: "text", text: JSON.stringify(assessment) }],
    api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 2,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
}
function visible(session) { return JSON.stringify(session.buildSessionProjection().messages); }
function compactionInput(session) {
  const preparation = prepareCompaction(session.getBranch(), settings);
  assert.ok(preparation, "fixture must reach real compaction preparation");
  return JSON.stringify([preparation.messagesToSummarize, preparation.turnPrefixMessages]);
}

function fixture() {
  const session = SessionManager.inMemory();
  // A future parent-owned envelope must supply these separately, with real
  // source entry IDs; a pruner cannot safely scrape labels out of request text.
  const directives = [
    { entryId: "human-1", text: "Work only on source. Do not deploy or push." },
    { entryId: "human-2", text: "Preserve the unfinished wiring changes." },
  ];
  const pinned = session.appendCustomMessageEntry("research.directives", JSON.stringify(directives), false);
  const pairs = [];
  for (let i = 0; i < 40; i++) {
    const request = user(session, `REPETITIVE_REVIEW_${i}\n${"untrusted repeated transcript\n".repeat(100)}`);
    const response = assistant(session, i === 5 ? deny : allow);
    pairs.push({ request, response, outcome: i === 5 ? "deny" : "allow" });
  }
  return { session, pairs, pinned, directives };
}

function pruneFixtureAllows(session, pairs) {
  // Fixture-provided association/outcomes, NOT an implemented classifier.
  // A production pruner must validate its own code-owned exchange metadata.
  const activeIds = new Set(session.buildSessionProjection().entries
    .filter((entry) => entry.messages.length > 0).map((entry) => entry.sourceEntry.id));
  for (const pair of pairs.slice(0, -2)) {
    if (pair.outcome !== "allow") continue;
    for (const id of [pair.request, pair.response]) {
      if (activeIds.has(id)) session.appendContextEdit(id, null);
    }
  }
}

test("append-only pruning removes redundant exchanges but retains directives, denial and recent requests", () => {
  const { session, pairs, pinned, directives } = fixture();
  const originals = session.getEntries();
  const rawBefore = JSON.stringify(originals);
  const before = visible(session).length;
  pruneFixtureAllows(session, pairs);
  const text = visible(session);
  for (const directive of directives) assert.ok(text.includes(directive.text));
  assert.ok(session.buildSessionProjection().entries.find((entry) => entry.sourceEntry.id === pinned).messages.length);
  assert.ok(text.includes("REPETITIVE_REVIEW_5"), "an old denial must not disappear behind later allows");
  assert.ok(text.includes("REPETITIVE_REVIEW_38"));
  assert.ok(text.includes("REPETITIVE_REVIEW_39"));
  assert.ok(!text.includes("REPETITIVE_REVIEW_0\\n"));
  assert.ok(text.length < before / 5, "fixture should demonstrate a substantial context reduction");
  assert.equal(JSON.stringify(session.getEntries().slice(0, originals.length)), rawBefore, "raw audit entries stay byte-for-byte identical as serialized");
  const count = session.getEntries().length;
  pruneFixtureAllows(session, pairs);
  assert.equal(session.getEntries().length, count, "already omitted exchanges need no repeated edits");
});

test("canonical edits reduce the actual summarization input; transient filtering alone does not", () => {
  const { session, pairs } = fixture();
  const requestOnlyFiltered = session.buildSessionProjection().messages.filter((message) => message.role !== "assistant");
  assert.ok(requestOnlyFiltered.length > 0);
  assert.ok(compactionInput(session).includes("REPETITIVE_REVIEW_0"), "a request-local filter does not prune persisted compaction input");
  pruneFixtureAllows(session, pairs);
  const input = compactionInput(session);
  assert.ok(!input.includes("REPETITIVE_REVIEW_0\\n"));
  assert.ok(input.includes("REPETITIVE_REVIEW_5"));
  assert.ok(input.includes("Do not deploy or push."));
});

test("pruning edits are branch-local and another leaf can restore the original request", () => {
  const { session, pairs } = fixture();
  const oldLeaf = session.getLeafId();
  pruneFixtureAllows(session, pairs);
  assert.ok(!visible(session).includes("REPETITIVE_REVIEW_0\\n"));
  session.branch(oldLeaf);
  assert.ok(visible(session).includes("REPETITIVE_REVIEW_0\\n"));
});

test("parallel sibling review leaves do not automatically merge denials", () => {
  const session = SessionManager.inMemory();
  const common = user(session, "Trusted fixture directive: no deployment.");
  user(session, "Request A: deploy.");
  const denialId = assistant(session, deny);
  session.branch(common);
  user(session, "Request B: inspect source.");
  assistant(session, allow);
  assert.ok(session.getEntry(denialId), "denial remains in raw audit");
  assert.ok(!session.getBranch().some((entry) => entry.id === denialId), "latest sibling leaf lacks the denial");
  assert.ok(!visible(session).includes(deny.rationale));
});

test("current bounded transcript cannot serve as a lossless directive ledger", () => {
  const session = SessionManager.inMemory();
  user(session, "NEVER_DEPLOY_FIXTURE: do not deploy.");
  for (let i = 0; i < 20; i++) user(session, `Latest user directive ${i}: continue source work.`);
  const transcript = renderGuardianTranscript(session.getBranch(), undefined, {
    maxMessageChars: 200, maxToolChars: 200,
    maxMessageEntryChars: 100, maxToolEntryChars: 100, maxRecentNonUserEntries: 4,
  });
  assert.ok(transcript.omittedEntries > 0);
  assert.ok(!transcript.text.includes("NEVER_DEPLOY_FIXTURE"));
  assert.ok(session.getBranch().some((entry) => entry.type === "message" && entry.message.content.includes("NEVER_DEPLOY_FIXTURE")));
});
