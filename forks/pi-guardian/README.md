# Pi Guardian

Stateful automatic safety review for the [Pi coding agent](https://github.com/earendil-works/pi-mono).

Pi normally executes model-requested tools without an approval boundary. Pi Guardian intercepts tool calls, applies fixed permission rules first, and asks a separate safety-focused Pi conversation to assess actions that still need review. The Guardian conversation persists across reviews, so it retains its earlier decisions and receives only new parent-session history after its first assessment.

## How it works

For each parent Pi session, the extension creates one Guardian sidecar session with a stable ID. The parent JSONL stores the link, transcript cursor, denial streak, and assessment records as extension-only custom entries. Those entries are durable but are not sent to the parent model.

When a reviewed tool is called:

1. The extension takes an active-branch snapshot through the assistant message containing the tool call.
2. It renders a bounded full transcript on the first review or a delta after the saved cursor.
3. It recursively starts Pi in JSON print mode with the existing Guardian session ID.
4. The sidecar uses an independent reviewer model, the bundled safety policy, and no tools, extensions, skills, project context, or prompt templates.
5. A strict four-field JSON assessment is parsed. `allow` continues tool execution; `deny` becomes an error tool result visible to the parent model.
6. Timeout, process failure, missing authentication, oversized actions, and malformed responses fail closed.

The top-level `codemode` script is reviewed. Each non-exempt nested call is reviewed on demand with its exact computed arguments and the full parent-call arguments (outermost first), including the script even when transcript bounds would truncate it. Missing parent evidence or an oversized action plus parent chain fails closed. Permission rules apply identically to nested calls. MCP tools such as `mcp__server__tool` are unknown tools and receive review; server annotations such as `readOnlyHint` never grant exemptions. The built-in `tool_search` only ranks tool metadata and activates matching declarations for future requests; it does not execute those tools.

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
    "maxAttempts": 3
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
- `enabled: false`: explicitly disables review and allows tools normally.

Use `/guardian` to toggle Guardian without editing JSON. `/guardian on`, `/guardian off`, `/guardian toggle`, and `/guardian status` are also supported. Changes take effect immediately and persist the `enabled` value in `guardian.json` for future Pi sessions.

Invalid configuration or an unreadable policy causes all enabled tool calls to fail closed. Pi shows the error and the configuration path in the TUI; runtime sidecar failures also include a targeted suggestion for the reviewer model, authentication, command path, or timeout as applicable.

## Permissions

`guardian.json` accepts this optional object; both arrays are optional and contain rule strings:

```json
{
  "permissions": {
    "deny": ["Read(~/.codex/**)", "Edit(//opt/pi-extensions/**)", "Bash(git push:*)", "mcp__dangerous__*"],
    "allow": ["Read", "Grep", "Find", "Ls", "Bash(git status)", "Bash(ls:*)"]
  }
}
```

Rules run before any reviewer request, including speculative sibling reviews and nested codemode calls. **Deny wins**, then allow skips review, then an unmatched call receives the existing LLM review. There is no `ask` setting. `enabled: false` bypasses the entire Guardian, including fixed rules. Malformed rules or unsupported permission keys fail configuration closed with a clear error.

The syntax follows [Claude Code permissions](https://code.claude.com/docs/en/permissions), with these supported forms:

- `Tool` matches all calls to that tool. Names are case-insensitive. `Read`, `Edit`, `Write`, `MultiEdit`, `Glob`, `Grep`, `LS`, `Bash`, and `PowerShell` map to Pi's names; `MultiEdit` maps to `edit`, `Glob` to `find`. `Edit` also covers `write`. Pi names (`find`, `ls`, `codemode`, `tool_search`) and unknown extension tool names are accepted.
- `mcp__server__tool` matches exactly; `mcp__server__*` and `mcp__server` match all tools from that server. Hyphens in MCP names normalize to underscores, as in Pi 1.0.
- `Read(path)`, `Edit(path)`, `Write(path)`, `Grep(path)`, `Find(path)`, and `Ls(path)` match Pi's `path` input. Grep/find/ls default to cwd when omitted. `//path` is absolute, `~/path` is home-relative, `/path` is relative to **the Pi agent directory**, and `path` or `./path` is cwd-relative. In particular, `/opt/...` is not absolute: use `//opt/...`. Paths normalize `..`; existing symlinks and existing ancestors of new files are resolved. Deny matches either requested or resolved spelling; allow requires both to match.
- Path globs support `*` within a segment, `?`, bracket classes (`[ab]`, `[!ab]`), and `**` across directories. `dir/**` includes the directory itself. Bare filenames match at any depth beneath cwd. A cwd-relative single directory pattern such as `secrets/**` matches at any depth for deny, but only directly beneath cwd for allow; use `**/secrets/**` for a recursive allow. Negation (`!`) and backslash escapes are unsupported and produce configuration errors; use positive deny patterns. Unknown tools support bare rules only.
- `Bash(command)` and `PowerShell(command)` match exact trimmed subcommands. A final `:*` matches that command prefix at a word boundary, including the bare command; `Bash(ls:*)` matches `ls -la`, but not `lsof`. `Bash(*)` matches every parseable command. Guardian splits `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines, and inspects subshells, `$()` and backticks for denies. Every subcommand must match some allow rule, while any matching subcommand triggers a deny. Complex, unsupported, or unparseable commands cannot match shell allow rules and go to review. Guardian does not implement Claude's wrapper stripping, general shell wildcard patterns, or input-parameter specifiers.

If `permissions.allow` and `exemptTools` are both absent, the allow list is `["Read", "Grep", "Find", "Ls", "tool_search"]`. Supplying `allow` replaces that default, including when it is empty. Legacy `exemptTools` supplies bare allow rules; when both settings exist, they are merged. Supplying only `deny` retains the default allow list. Rules retain their original text and insertion order; duplicate strings are removed. Status `exemptTools` is the deduplicated, normalized list of effective bare tool allow names, excluding conditional and MCP wildcard rules. A bare `Edit` appears as `edit` there, although it also allows `write`.

Guardian adds three protections beyond Claude-style matching:

- **Directory containment:** a deny `Read` (or other read-path) rule also blocks grep/find/ls when their root could contain a matching path. `Read(~/.codex/**)` therefore blocks searches rooted at home or `/`. Edit/Write rules don't do this, since reading those files is allowed, and allows never do. Broad searches can consequently be blocked even when their result filters would exclude protected files.
- **Literal path detection:** deny path rules also check serialized inputs of shell, codemode, MCP, and other tools for the rule's non-glob prefix, resolved to an absolute path (including its realpath spelling). Rules for paths under the home directory, whether written with `~/` or as absolute paths, additionally check `~/...`, `$HOME/...`, and `${HOME}/...`. The literal must end at a path boundary, so `/root/.pi` doesn't match `/root/.pip`. Patterns with no literal target prefix skip this check. It is deliberately conservative and can block harmless mentions. Read-only file tools may inspect and list files protected only by Edit/Write rules, so skills under the agent dir and Guardian's source/policy stay readable.
- **Non-removable built-in denies:** in this stable order, `Edit` protects `<agentDir>/**` (everything Pi loads: settings, auth, extensions, `mcp.json`, system prompts, skills), `<guardianSessionDir>/**`, and `<Guardian packageDir>/**` (resolved from `import.meta.url`); identical directories are listed once. Then `Read` protects `<agentDir>/auth.json`, `<agentDir>/guardian.json`, and `<guardianSessionDir>/**` (the reviewer's transcripts). Edit covers Write, so no separate Write entries are needed. These rules use absolute `//` spellings and precede user deny rules. Config cannot remove them.

Fixed denies produce assessment records and count toward the same consecutive-denial streak as reviewer denies. Rule allows produce no records, preserving the previous exemption volume; they also preserve the previous exemption behavior for the streak. The reviewer prompt includes the active deny list and asks it to reject obfuscated or indirect attempts at those targets.

Shell parsing and substring detection are **best-effort**, not an OS security boundary. Encoding, variables, relative path spellings in scripts, interpreter wrappers, filesystem races, and other obfuscation can bypass deterministic detection. Keep allows narrow: allowed calls never reach the reviewer. The agent, extension, and reviewer share a UID; use an OS sandbox to enforce isolation against malicious code.

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
      "guardianVersion": "0.2.0",
      "enabled": true,
      "reviewerModel": "openai-codex/gpt-5.6-luna",
      "reviewerThinking": "low",
      "policySha256": "<64 lowercase hexadecimal SHA-256 characters>",
      "exemptTools": ["read", "grep", "find", "ls", "tool_search"],
      "permissions": {
        "allow": ["Read", "Grep", "Find", "Ls", "tool_search"],
        "deny": [
          "Edit(//example/agent/**)",
          "Edit(//example/agent/guardian-sessions/**)",
          "Edit(//example/pi-guardian/**)",
          "Read(//example/agent/auth.json)",
          "Read(//example/agent/guardian.json)",
          "Read(//example/agent/guardian-sessions/**)"
        ]
      },
      "permissionsSha256": "<64 lowercase hexadecimal SHA-256 characters>",
      "configError": null
    },
    "id": "<entry ID>",
    "parentId": "<parent entry ID or null>",
    "timestamp": "<ISO 8601 timestamp>"
  }
}
```

`enabled` is the configured switch, defaulting to `true` when parsing fails; it is not by itself proof of valid configuration. Require `enabled === true`, `configError === null`, and the expected policy hash and reviewer settings. If configuration cannot be parsed, `reviewerModel`, `reviewerThinking`, and `policySha256` are null and `exemptTools` is empty; `permissions` and `permissionsSha256` are null. An unreadable policy leaves `policySha256` null. `configError` is a string when initialization fails. A disabled valid configuration still reports its policy hash and effective permissions. `permissions` always has keys `allow` then `deny`, both string arrays. `permissionsSha256` is lowercase hex SHA-256 of the UTF-8 bytes of `JSON.stringify(permissions)` exactly as emitted (no pretty printing). Built-in denies come first, followed by user denies; original rule text and ordering are part of the hash.

Each completed reviewer attempt or fixed rule deny appends an assessment event:

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
      "source": "reviewer",
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

`source` is always `"reviewer"` for reviewer outcomes (including failures), or `"rule"` for fixed denies. Rule records additionally contain `rule`, the exact first matching effective deny string, at the same level as `source`. Rule allows are not recorded. For example, the rule-deny `data` shape is:

```json
{
  "version": 1,
  "guardianSessionId": "<reserved reviewer session UUID; no reviewer request needed>",
  "toolName": "read",
  "toolCallId": "call-1",
  "actionHash": "<64 lowercase hexadecimal SHA-256 characters>",
  "parentCursorEntryId": "<assistant entry ID>",
  "turnKey": "<latest user entry ID>",
  "assessment": {
    "risk_level": "high",
    "user_authorization": "unknown",
    "outcome": "deny",
    "rationale": "Denied by rule Read(~/.codex/**)"
  },
  "source": "rule",
  "rule": "Read(~/.codex/**)",
  "reviewedAt": "<ISO 8601 timestamp>"
}
```

Rule records reserve/reuse the Guardian session ID but do not increment the reviewer review count or transcript cursor. They have no `failure` or `failureHelp`. A fixed deny remains authoritative even if parent evidence is missing; in that case `actionHash` hashes the fallback `{tool_name, tool_call_id, input}` rather than a full action. `parentToolCallId` is omitted for top-level calls. `parentCursorEntryId` is omitted when no containing assistant entry can be located. Review failures add `failure` and `failureHelp` strings and produce a deny assessment. `risk_level` is `low|medium|high|critical`, `user_authorization` is `unknown|low|medium|high`, and `outcome` is `allow|deny`. `actionHash` hashes the JSON action including full parent evidence for nested calls. Exempt or disabled calls do not produce assessment records; initialization failures block tools using the status error rather than a reviewer assessment. Additional `pi-guardian.state` entries are internal state, not assessment records.

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

The credential-free headless test also checks a protected read denied by a rule with no reviewer request. It runs the real local Pi CLI and real recursive reviewer Pi processes against a loopback mock OpenAI-compatible endpoint, executes a reviewed codemode script and nested bash call, and checks stdout records for enabled, invalid, and disabled configurations.

Tests cover strict assessment parsing, transcript trust labels and deltas, state restoration, denial tracking, recursive invocation flags, and a fake sidecar process including malformed-output retry.

## Local change: `reviewer.extensions`

This is the vendored fork. When the reviewer model is supplied by a Pi
extension (for example `npm:@aliou/pi-neuralwatt`), list that extension in
`guardian.json`:

```json
{
  "reviewer": {
    "model": "neuralwatt/nw-flash",
    "extensions": ["npm:@aliou/pi-neuralwatt@0.18.0"]
  }
}
```

Only the listed entries are loaded by the reviewer sidecar, which still runs
with `--no-tools` and `--no-extensions`. See `VENDOR.md` for the full patch set.
