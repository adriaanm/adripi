/**
 * What the model needs to know about this harness, in its own words.
 *
 * Sandbox conventions are not something models are trained on: without this, a
 * perfectly capable model retries a command the OS will never allow, or asks for
 * read access to a credential store that is denied by rule. Keep it short, put it
 * in the system prompt once, and say what to do rather than what is forbidden.
 */
export function sandboxGuidance(options: { scratchDir?: string; projectPolicyPath?: string } = {}): string {
  const scratch = options.scratchDir ? `\`${options.scratchDir}\` (also \`$PI_SANDBOX_SCRATCH\`)` : "`$PI_SANDBOX_SCRATCH`";
  const lines = [
    "You run inside an OS sandbox (pi-sbx) whose exceptions are reviewed by pi-guardian.",
    `- Writes: this workspace and the private scratch dir ${scratch}. Reads: everything except provider credentials.`,
    "- Permanently denied and never grantable: the agent directory's `auth.json`, `~/.config/gh/**`, `~/.ssh/**`, `~/.aws/**`, `~/.gnupg/**`. Do not ask for them.",
    "- Git stays inside the sandbox: status, diff, log, show, add, commit, branch, switch, merge, rebase, tag, stash, worktree all work there and need no exception.",
    "  Only git operations that authenticate with a remote do: clone, fetch, pull, push, ls-remote, submodule update --remote, remote prune. Pulling a public repo may work anonymously; a private repo, and any push, cannot.",
    "- Anything else outside the workspace — a path, a host/port, or a command that needs the host's credentials (gh, ssh, network git as above, xcrun, CoreDevice) — needs one reviewed exception:",
    '  request_sandbox_exception({ surface: "read" | "write" | "network" | "command", target, scope: "once" | "session", reason })',
    "  - `target` is one exact thing: an absolute path, `host:port`, or the exact command line.",
    '  - surface "command" runs that exact string on the host. It must be one plain command: no pipes, redirects, chaining, or interpreter prefixes. After it is granted, run the command unchanged as the next bash call.',
    "  - A git command failing with `could not read Username`, `Permission denied (publickey)`, or a host-key error is the signal to request the command exception for that exact line instead of retrying it locally.",
    "- The request may be allowed, denied by a rule, or deferred to the user. A denial is final for that target: do not retry or rephrase it, continue without it, or ask the user how to proceed.",
    "- Never reach the same effect another way (editing a credential file, asking for gh's config, writing a helper script, disabling the sandbox). That is circumvention, not a workaround.",
    ...(options.projectPolicyPath
      ? [`- Standing permissions for this project live in \`${options.projectPolicyPath}\`; only the user edits that file.`]
      : []),
  ];
  return lines.join("\n");
}
