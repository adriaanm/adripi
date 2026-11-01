import {
  CHILD_AUTHORITY_PROVIDER_VERSION,
  loadInstalledChildAuthorityModule,
  type ChildAuthorityIdentity,
  type ChildAuthorityPayload,
} from "./child-authority.ts";
import type { ChildAction, ChildActionDecision } from "./action-authorizer.ts";
export { decodeChildPolicy } from "./child-policy.ts";

/** Host-only bridge to pi-subagents' ONE public claim/ack API. This structural
 * view neither reconstructs a lease nor publishes a broker/permission store.
 * The actual public implementation validates its opaque ALS-bound lease. */
export interface ChildConsumerLease {
  readonly version: typeof CHILD_AUTHORITY_PROVIDER_VERSION;
  readonly leaseId: string;
  readonly identity: ChildAuthorityIdentity;
  readonly payload: ChildAuthorityPayload;
  readonly requiredConsumers: readonly string[];
  readonly signal: AbortSignal;
  request(action: ChildAction, signal?: AbortSignal): Promise<ChildActionDecision>;
  assertReady(): void;
  dispose(): void;
}

export interface ChildConsumerApi {
  readonly CHILD_AUTHORITY_PROVIDER_VERSION: typeof CHILD_AUTHORITY_PROVIDER_VERSION;
  hasChildAuthorityContext(): boolean;
  claimChildAuthority(consumerId: string, cwd: string): ChildConsumerLease;
  acknowledgeChildAuthority(consumerId: string): void;
  isChildRuntimeControlTool(lease: ChildConsumerLease, name: string): boolean;
}

/** Presence chooses a public-API lookup, NOT root/child authority. Even malformed
 * or undefined slots must reach that fail-closed detector. Inactive valid ALS
 * may still select ordinary root startup. Never inspect an env/file manifest as
 * an alternate claim, or manufacture a replacement registry after failure. */
export function mayHaveChildAuthorityContext(): boolean {
  return Symbol.for("pi-subagents.child-authority-lease.v1") in globalThis ||
    Symbol.for("pi-subagents.child-authority-runner.v1") in globalThis;
}

export async function loadInstalledChildConsumerApi(agentDir: string): Promise<ChildConsumerApi> {
  const loaded = await loadInstalledChildAuthorityModule(agentDir, "./child-authority");
  if (loaded.CHILD_AUTHORITY_PROVIDER_VERSION !== CHILD_AUTHORITY_PROVIDER_VERSION ||
      ["hasChildAuthorityContext", "claimChildAuthority", "acknowledgeChildAuthority", "isChildRuntimeControlTool"].some(name => typeof loaded[name] !== "function")) {
    throw new Error("the installed launcher public child-authority API is missing, malformed or incompatible; root fallback is forbidden");
  }
  return loaded as unknown as ChildConsumerApi;
}
