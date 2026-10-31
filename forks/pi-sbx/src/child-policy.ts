import { isAbsolute, normalize, sep } from "node:path";
import {
  boundedPayload,
  CHILD_AUTHORITY_PROVIDER_VERSION,
  type ChildAuthorityPolicyPayload,
} from "./child-authority.ts";
import { capturePolicyPathAnchor, canonicalizeTarget, policyPathAnchorsUnchanged } from "./path-policy.ts";

/** Data validation only. A decoded snapshot is NOT authority: consumers must
 * first claim the same live public lease, then install real enforcement before
 * acknowledging it. Neither artifacts nor ambient config can create a lease. */
export function decodeChildPolicy(value: unknown, cwd: string): ChildAuthorityPolicyPayload {
  const snapshot = boundedPayload(value);
  const fail = (field: string): never => { throw new Error(`Invalid child policy: ${field}`); };
  const record = (data: unknown, fields: readonly string[], label: string): Record<string, unknown> => {
    if (!data || typeof data !== "object" || Array.isArray(data)) return fail(`${label} must be an object`);
    const keys = Object.keys(data);
    if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) return fail(`${label} has missing or unsupported fields`);
    return data as Record<string, unknown>;
  };
  const tag = (data: unknown, expected: string | number, label: string): void => {
    if (data !== expected) fail(`${label} is unsupported`);
  };
  const boolean = (data: unknown, label: string): void => {
    if (typeof data !== "boolean") fail(`${label} must be a boolean`);
  };
  const strings = (data: unknown, label: string): string[] => {
    if (!Array.isArray(data) || data.some(item => typeof item !== "string" || !item)) return fail(`${label} must contain nonempty strings`);
    if (new Set(data).size !== data.length) return fail(`${label} contains duplicates`);
    return data;
  };
  const absolute = (data: unknown, label: string, glob = false): string => {
    if (typeof data !== "string" || !data || !isAbsolute(data) || (!glob && /[*?[]/.test(data))) return fail(`${label} must be an absolute ${glob ? "policy path" : "exact path"}`);
    return data;
  };
  const paths = (data: unknown, label: string, glob = true): string[] => strings(data, label).map(item => absolute(item, label, glob));

  const root = record(snapshot, ["version", "kind", "anchor", "workspace", "read", "write", "network", "environment", "isolation", "command"], "root");
  tag(root.version, CHILD_AUTHORITY_PROVIDER_VERSION, "version");
  tag(root.kind, "pi-sbx.child-policy", "kind");
  const anchor = record(root.anchor, ["cwd", "paths"], "anchor");
  const anchorCwd = absolute(anchor.cwd, "anchor.cwd");
  if (!Array.isArray(anchor.paths) || !anchor.paths.length) fail("anchor.paths must contain prepared pins");
  const pins = (anchor.paths as unknown[]).map(item => {
    const pin = record(item, ["spelled", "canonical"], "anchor.paths entry");
    return { spelled: absolute(pin.spelled, "anchor spelled path"), canonical: absolute(pin.canonical, "anchor canonical path") };
  });
  if (new Set(pins.map(pin => pin.spelled)).size !== pins.length) fail("anchor paths contain duplicate spellings");
  const workspace = record(root.workspace, ["spelled", "canonical"], "workspace");
  const spelled = absolute(workspace.spelled, "workspace.spelled");
  const canonical = absolute(workspace.canonical, "workspace.canonical");
  absolute(cwd, "consumer cwd");
  const normalized = (path: string): string => {
    const result = normalize(path);
    return result.length > 1 && result.endsWith(sep) ? result.slice(0, -1) : result;
  };
  if (normalized(cwd) !== normalized(spelled)) fail("workspace does not match the claimed consumer cwd");
  if (canonicalizeTarget(spelled, anchorCwd) !== canonical) fail("workspace canonical identity changed");

  const requiredPaths = [anchorCwd, spelled, canonical];
  const read = record(root.read, ["policy", "deny", "allow", "mandatoryDeny"], "read");
  tag(read.policy, "deny-based", "read.policy");
  for (const field of ["deny", "allow", "mandatoryDeny"]) requiredPaths.push(...paths(read[field], `read.${field}`));
  const write = record(root.write, ["policy", "allow", "deny", "mandatoryDeny"], "write");
  tag(write.policy, "allowlist", "write.policy");
  const writeAllow = paths(write.allow, "write.allow", false);
  if (!writeAllow.includes(canonical)) fail("write.allow does not hold the assigned canonical workspace");
  requiredPaths.push(...writeAllow, ...paths(write.deny, "write.deny"), ...paths(write.mandatoryDeny, "write.mandatoryDeny"));

  const network = record(root.network, ["policy", "allowedDomains", "deniedDomains", "strictAllowlist", "unixSocketCeiling", "allowLocalBinding"], "network");
  tag(network.policy, "parent-decision", "network.policy");
  strings(network.allowedDomains, "network.allowedDomains");
  strings(network.deniedDomains, "network.deniedDomains");
  boolean(network.strictAllowlist, "network.strictAllowlist");
  boolean(network.allowLocalBinding, "network.allowLocalBinding");
  const sockets = record(network.unixSocketCeiling, ["all", "roots"], "network.unixSocketCeiling");
  boolean(sockets.all, "network.unixSocketCeiling.all");
  requiredPaths.push(...paths(sockets.roots, "network.unixSocketCeiling.roots", false));
  const environment = record(root.environment, ["deny"], "environment");
  if (strings(environment.deny, "environment.deny").some(name => name.includes("="))) fail("environment.deny must contain names, not values");
  const isolation = record(root.isolation, ["allowPty", "mandatoryDenySearchDepth"], "isolation");
  boolean(isolation.allowPty, "isolation.allowPty");
  const depth = isolation.mandatoryDenySearchDepth;
  if (depth !== null && (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1 || depth > 10)) fail("isolation.mandatoryDenySearchDepth must be null or an integer 1-10");
  const command = record(root.command, ["policy", "allowHost"], "command");
  tag(command.policy, "parent-decision", "command.policy");
  boolean(command.allowHost, "command.allowHost");

  // No policy path may silently be reinterpreted relative to a child cwd/HOME.
  // Require a prepared pin for every literal/static-glob prefix, not just one
  // plausible workspace pin. Extra pins retain Git aliases and socket spellings.
  const bySpelling = new Map(pins.map(pin => [pin.spelled, pin.canonical]));
  for (const path of requiredPaths) {
    const expected = capturePolicyPathAnchor(path, anchorCwd);
    if (bySpelling.get(expected.spelled) !== expected.canonical) fail("a policy path has no matching prepared anchor");
  }
  if (!policyPathAnchorsUnchanged(pins, anchorCwd)) fail("a prepared policy path was retargeted");
  // boundedPayload already made an independent, deeply frozen JSON snapshot;
  // all required current-v2 fields have now been checked without coercion.
  return snapshot as ChildAuthorityPolicyPayload;
}
