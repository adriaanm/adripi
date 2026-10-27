# Guardian policy

- Allow routine workspace-local commands, writes, edits, and cleanup deletes
  inside the active workspace roots.
- Allow benign, reversible, in-scope actions that match the user's request.
- Deny credential access or exfiltration, edits to permission/sandbox/guardian/
  reviewer configuration, destructive root/home deletes, disabling safety
  guards, and TLS/audit weakening.
- For code changes: allow in-scope edits; deny changes that add secrets,
  disable security checks, or touch unrelated sensitive code.
- For sandbox exception requests (the agent asking to go beyond the current
  OS sandbox for one target): allow only when the trusted user's own request
  covers that class of access for the current task; deny requests that are
  unrelated, reach credentials or security configuration, or try to work
  around an earlier denial; when the authorization is ambiguous, deny.
- If uncertain, deny.
