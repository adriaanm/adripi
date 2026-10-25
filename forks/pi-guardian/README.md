# Pi Guardian

Stateful automatic safety review for the [Pi coding agent](https://github.com/earendil-works/pi-mono).

Pi normally executes model-requested tools without an approval boundary. Pi Guardian intercepts non-read-only tool calls, asks a separate safety-focused Pi conversation to assess the exact action, and either allows or blocks it. The Guardian conversation persists across reviews, so it retains its earlier decisions and receives only new parent-session history after its first assessment.

## How it works

For each parent Pi session, the extension creates one Guardian sidecar session with a stable ID. The parent JSONL stores the link, transcript cursor, denial streak, and assessment records as extension-only custom entries. Those entries are durable but are not sent to the parent model.

When a reviewed tool is called:

1. The extension takes an active-branch snapshot through the assistant message containing the tool call.
2. It renders a bounded full transcript on the first review or a delta after the saved cursor.
3. It recursively starts Pi in JSON print mode with the existing Guardian session ID.
4. The sidecar uses an independent reviewer model, the bundled safety policy, no tools, and no extensions except any explicitly listed in `reviewer.extensions`. Skills, project context, and prompt templates remain disabled.
5. A strict four-field JSON assessment is parsed. `allow` continues tool execution; `deny` becomes an error tool result visible to the parent model.
6. Timeout, process failure, missing authentication, oversized actions, and malformed responses fail closed.

The top-level `codemode` script is reviewed. Each non-exempt nested call is reviewed on demand with its exact computed arguments and the full parent-call arguments (outermost first), including the script even when transcript bounds would truncate it. Missing parent evidence or an oversized action plus parent chain fails closed. Read-only exemptions also apply to nested calls. MCP tools such as `mcp__server__tool` are unknown tools and receive review; server annotations such as `readOnlyHint` never grant exemptions. The built-in `tool_search` only ranks tool metadata and activates matching declarations for future requests; it does not execute those tools.

Top-level sibling tool calls are speculatively reviewed as a batch as soon as the assistant message finishes, with up to four sidecar requests in flight by default. Pi still invokes its tool preflight hooks sequentially, but those hooks normally consume decisions that are already running or complete. The first-ever review initializes the sidecar session before its siblings fan out; later batches launch immediately in parallel.

The sidecar is a short-lived process per review, but its Pi conversation is durable. Reusing its session ID also gives supported providers a stable prompt-cache key. Parallel reviews may create sibling branches in that conversation; the next batch follows the most recently appended leaf rather than attempting to merge those review branches.

An always-on indicator above the editor shows `⬭ guardian enabled` in yellow or `Ψ guardian disabled` in red, followed on the same line by the reviewer model in muted gray. Configuration errors get their own red state rather than claiming that protection is active. While reviews are pending, Pi's animated working row shows how many tools Guardian is reviewing. When each finishes, an `allowed`, `denied`, or `review failed` card is written into the TUI transcript. These cards are durable extension entries, so they reappear when the session is resumed but are never sent to the parent model. Expand a card to see its review timestamp and sidecar session ID.

## Install

Install this checkout as a user-level Pi package:

```bash
pi install /absolute/path/to/pi-guardian
```

Or load it for one run:

```bash
pi --extension /absolute/path/to/pi-guardian/src/index.ts
```

The default reviewer is `openai-codex/gpt-5.6-luna` with low reasoning. Its provider must already be authenticated in Pi. The main session may use any other model.

Requires Pi 1.0.0 or later. By default, `read`, `grep`, `find`, `ls`, and `tool_search` bypass review. `bash`, `powershell`, `write`, `edit`, and unknown extension tools are reviewed.

## Configuration

Optional user-level configuration lives at `~/.pi/agent/guardian.json` (or the corresponding Pi agent directory):

```json
{
  "enabled": true,
  "reviewer": {
    "model": "openai-codex/gpt-5.6-luna",
    "thinking": "low",
    "timeoutMs": 90000,
    "maxAttempts": 3,
    "extensions": []
  },
  "maxParallelReviews": 4,
  "maxConsecutiveDenials": 3,
  "maxActionChars": 64000,
  "exemptTools": ["read", "grep", "find", "ls", "tool_search"],
  "transcript": {
    "maxMessageChars": 40000,
    "maxToolChars": 40000,
    "maxMessageEntryChars": 8000,
    "maxToolEntryChars": 4000,
    "maxRecentNonUserEntries": 40
  }
}
```

`timeoutMs` is the total deadline across all structured-output attempts. Changing the reviewer model, thinking level, policy, or Guardian session directory starts a new sidecar generation so incompatible histories are not mixed.

Additional settings:

- `guardianSessionDir`: overrides the default `~/.pi/agent/guardian-sessions` directory.
- `maxParallelReviews`: caps simultaneous Guardian sidecar processes; additional sibling reviews remain queued.
- `policyPath`: uses a user-owned replacement for the bundled policy.
- `piCommand`: explicit path to the Pi executable if recursive invocation cannot infer it from the current process.
- `reviewer.extensions`: explicit extensions to load in the sidecar, in addition to the provider-less defaults. Local paths are resolved; package sources such as `npm:@scope/package@version` are passed through to Pi. The sidecar still runs with `--no-tools` and `--no-extensions`, so only these entries load. Use provider-only extensions.
- `enabled: false`: explicitly disables review and allows tools normally.

Use `/guardian` to toggle Guardian without editing JSON. `/guardian on`, `/guardian off`, `/guardian toggle`, and `/guardian status` are also supported. Changes take effect immediately and persist the `enabled` value in `guardian.json` for future Pi sessions.

Invalid configuration or an unreadable policy causes reviewed tools to fail closed. Pi shows the error and the configuration path in the TUI; runtime sidecar failures also include a targeted suggestion for the reviewer model, authentication, command path, or timeout as applicable.

## Decisions and recovery

The sidecar must return exactly:

```json
{"risk_level":"low","user_authorization":"medium","outcome":"allow","rationale":"The action is bounded and authorized."}
```

Malformed output is followed by a correction turn in the same Guardian conversation. After the configured attempt limit, the action is denied. Three consecutive denials in one user turn trigger Pi's tool-batch termination hint in addition to blocking the action.

Parent branching before the latest Guardian state naturally creates a new Guardian sidecar. Parent compaction does not: the existing sidecar retains its earlier review history and receives the new compaction record as a transcript delta.

## Machine-readable records

Guardian supports `--mode json --print --no-session --no-approve -e /path/to/pi-guardian/src/index.ts`, with the prompt on stdin. UI calls are guarded. Parent session IDs, branch history, and custom entries work in memory with `--no-session`; they are retained only for that invocation. The reviewer sidecar still uses its own persistent session directory.

Pi 1.0.0 emits custom entries appended through `pi.appendEntry()` as stdout JSONL events. Guardian appends status at `session_start` even if disabled or misconfigured. Pi's print-mode JSON subscriber attaches **after** `session_start`, so Guardian appends the status again at the first `input` event, before model authentication or execution. A normal prompted JSON invocation therefore exposes one status event; its in-memory branch contains both entries. A JSON invocation with no prompt, or one that exits before input (including an extension slash command), may have no stdout status event. Orchestrators should require a valid status record and fail closed when it is absent. Toggling Guardian also appends an updated status.

`entry.parentId` is a string or null; timestamps are ISO 8601 strings. The status event has exactly this shape (IDs, timestamp, model, hash, and tool list vary):

```json
{
  "type": "entry_appended",
  "entry": {
    "type": "custom",
    "customType": "pi-guardian-status",
    "data": {
      "version": 1,
      "guardianVersion": "0.1.0",
      "enabled": true,
      "reviewerModel": "openai-codex/gpt-5.6-luna",
      "reviewerThinking": "low",
      "policySha256": "<64 lowercase hexadecimal SHA-256 characters>",
      "exemptTools": ["read", "grep", "find", "ls", "tool_search"],
      "configError": null
    },
    "id": "<entry ID>",
    "parentId": "<parent entry ID or null>",
    "timestamp": "<ISO 8601 timestamp>"
  }
}
```

`enabled` is the configured switch, defaulting to `true` when parsing fails; it is not by itself proof of valid configuration. Require `enabled === true`, `configError === null`, and the expected policy hash and reviewer settings. If configuration cannot be parsed, `reviewerModel`, `reviewerThinking`, and `policySha256` are null and `exemptTools` is empty. An unreadable policy leaves `policySha256` null. `configError` is a string when initialization fails. A disabled valid configuration still reports its policy hash.

Each completed review appends an assessment event:

```json
{
  "type": "entry_appended",
  "entry": {
    "type": "custom",
    "customType": "pi-guardian.assessment",
    "data": {
      "version": 1,
      "guardianSessionId": "<reviewer session UUID>",
      "toolName": "bash",
      "toolCallId": "<parent tool ID>/1",
      "actionHash": "<64 lowercase hexadecimal SHA-256 characters>",
      "parentCursorEntryId": "<assistant entry ID>",
      "parentToolCallId": "<parent tool ID>",
      "turnKey": "<latest user entry ID>",
      "assessment": {
        "risk_level": "low",
        "user_authorization": "medium",
        "outcome": "allow",
        "rationale": "The action is bounded and authorized."
      },
      "reviewedAt": "<ISO 8601 timestamp>"
    },
    "id": "<entry ID>",
    "parentId": "<parent entry ID or null>",
    "timestamp": "<ISO 8601 timestamp>"
  }
}
```

`parentToolCallId` is omitted for top-level calls. `parentCursorEntryId` is omitted when no containing assistant entry can be located. Review failures add `failure` and `failureHelp` strings and produce a deny assessment. `risk_level` is `low|medium|high|critical`, `user_authorization` is `unknown|low|medium|high`, and `outcome` is `allow|deny`. `actionHash` hashes the JSON action including full parent evidence for nested calls. Exempt or disabled calls do not produce assessment records; initialization failures block tools using the status error rather than a reviewer assessment. Additional `pi-guardian.state` entries are internal state, not assessment records.

## Security boundary

This project is intended to make ordinary YOLO-style Pi usage safer on a personal machine. It is not a hardened sandbox:

- The reviewer receives the retained parent transcript and exact action. Choosing a cloud reviewer can send locally derived content to that provider.
- Direct shell commands entered by the user are not model-requested tool calls and are not reviewed.
- Side effects performed directly by trusted extension code, outside Pi's tool-call path, are not reviewed.
- The extension and the main Pi process share the user's filesystem privileges. Use an OS sandbox when protection against malicious code or extensions is required.

## Development

```bash
pnpm test
pnpm run check
```

The credential-free headless test runs the real local Pi CLI and real recursive reviewer Pi processes against a loopback mock OpenAI-compatible endpoint, executes a reviewed codemode script and nested bash call, and checks stdout records for enabled, invalid, and disabled configurations.

Tests cover strict assessment parsing, transcript trust labels and deltas, state restoration, denial tracking, recursive invocation flags, and a fake sidecar process including malformed-output retry.
