/**
 * What the model needs to know about this harness, in its own words.
 *
 * Sandbox conventions are not something models are trained on: without this, a
 * perfectly capable model retries a command the OS will never allow, or asks for
 * read access to a credential store that is denied by rule. Keep it short, put it
 * in the system prompt once, and say what to do rather than what is forbidden.
 */
export function sandboxGuidance(options: { scratchDir?: string; projectPolicyPath?: string; delegated?: boolean } = {}): string {
  const scratch = options.scratchDir ? `\`${options.scratchDir}\` (also \`$PI_SANDBOX_SCRATCH\`)` : "`$PI_SANDBOX_SCRATCH`";
  const lines = [
    "You run inside an OS sandbox (pi-sbx) whose exceptions are reviewed by pi-guardian.",
    options.delegated
      ? `- Delegated scope: only the prepared workspace/admitted Git roots and private scratch ${scratch}; reads remain bounded by the prepared parent policy. No parent maintenance authority is inherited.`
      : `- Writes: this workspace and the private scratch dir ${scratch}. Reads: everything except provider credentials.`,
    "- Permanently denied and never grantable: the agent directory's `auth.json`, `~/.config/gh/**`, `~/.ssh/**`, `~/.aws/**`, `~/.gnupg/**`. Do not ask for them.",
    "- The sandbox is on. Prefer working inside it; escalate only when the sandbox is what blocks you.",
    "- Git stays inside the sandbox: status, diff, log, show, add, commit, branch, switch, merge, rebase, tag, stash, worktree all work and need no exception. Only operations that authenticate with a remote do: clone, fetch, pull, push, ls-remote, submodule update --remote. A public repo may fetch anonymously; a private one, and any push, cannot.",
    "- If a command fails *because of the sandbox* (`Operation not permitted`, `could not read Username`, `Permission denied (publickey)`, DNS/host resolution, a cache dir it cannot write), do not message the user first and do not re-run it the same way. Re-run that same bash call with the escalation attached:",
    '  sandbox_permissions: "with_additional_permissions", additional_permissions: { file_system: { read: ["/abs/path"], write: ["/abs/path"] } }, justification: "<one-line question for the user>"',
    "  That widens the sandbox for that one command only (it is taken back afterwards) and keeps everything inside the sandbox.",
    options.delegated
      ? '  Full-host execution uses sandbox_permissions: "require_escalated" with justification. It requires the actual parent human to admit that exact command; it is not a filesystem jail. Do not supply prefix_rule: a child cannot save standing permissions.'
      : '  When only running outside the sandbox can work — a tool that needs the host credentials or host services (gh, ssh, network git as above, xcrun, CoreDevice) — use sandbox_permissions: "require_escalated" with justification, and optionally prefix_rule: ["git", "push"] to propose a standing rule. The prefix must be a true prefix of the command in that call.',
    "- To capture full command output without shell redirection, use bash's `output_file` with a new file in an existing directory. That write is independently authorized and never widens the command's sandbox; failures/cancellations retain partial logs with status. Logs are not redacted or automatically expired.",
    "- Native Read/Write/Edit stay native: their file gate requests a grantable exact target through the same Guardian/human decision path. Do not rewrite a denied file operation as Bash. Grants cover that call only; recursive search/traversal is not widened.",
    "- There is no separate exception tool. Network destinations are decided per connection by the proxy. Bash path or host exceptions are attached to the bash call that needs them; native file actions use their own gate.",
    ...(options.delegated
      ? ["- No child sandbox settings, local approval UI, unreviewed user_bash or policy store exists. Native process/device paths and unfenceable SDK external helpers refuse; socket/local-binding/PTY ceilings are not new grants."]
      : ["- Choose prefix_rule sparingly: categorical and narrow ([\"git\", \"pull\"], [\"gh\", \"pr\", \"check\"]), never a shell, interpreter, or rm, and never for a command with a heredoc. Only the user can save it, and only Guardian's project policy can store it."]),
    "- The request may be allowed, denied by a rule, or deferred to the user. A denial is final for that target: do not retry or rephrase it, continue without it, or ask the user how to proceed.",
    "- Never reach the same effect another way (editing a credential file, asking for gh's config, writing a helper script, disabling the sandbox). That is circumvention, not a workaround.",
    ...(options.projectPolicyPath
      ? [`- Standing permissions for this project live in \`${options.projectPolicyPath}\`; only the user edits that file.`]
      : []),
  ];
  return lines.join("\n");
}
