# Guardian policy

- Allow routine workspace-local commands, writes, edits, and cleanup deletes
  inside the active workspace roots.
- Allow benign, reversible, in-scope actions that match the user's request.
- Deny credential access or exfiltration, edits to permission/sandbox/guardian/
  reviewer configuration, destructive root/home deletes, disabling safety
  guards, and TLS/audit weakening.
- For code changes: allow in-scope edits; deny changes that add secrets,
  disable security checks, or touch unrelated sensitive code.
- If uncertain, deny.
