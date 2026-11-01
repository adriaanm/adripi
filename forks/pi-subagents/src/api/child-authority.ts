// Public, host-only child authority surface. The parent (launch lane) prepares and binds one lease to a
// host-created IPC channel; child extension code consumes it only through withChildAuthority().
// Launch owns exactly one runner client and must budget spawn-to-prepare slack explicitly.
//
// The provider is host code injected by the same process. This validates the service contract; it is not a
// sandbox against arbitrary privileged code that already runs in the host process.
export {
	CHILD_AUTHORITY_MAX_ACTION_REASON_BYTES,
	CHILD_AUTHORITY_MAX_ACTION_TARGET_BYTES,
	CHILD_AUTHORITY_MAX_TOOL_ACTION_CHARS,
	CHILD_AUTHORITY_MAX_TOOL_ACTION_BYTES,
	CHILD_AUTHORITY_MAX_DECIDED_REQUEST_IDS,
	CHILD_AUTHORITY_MAX_INFLIGHT_REQUESTS,
	CHILD_AUTHORITY_MAX_PAYLOAD_BYTES,
	CHILD_AUTHORITY_MAX_RATIONALE_BYTES,
	CHILD_AUTHORITY_PROVIDER_VERSION,
	ChildAuthorityError,
	acknowledgeChildAuthority,
	claimChildAuthority,
	hasChildAuthorityContext,
	isChildRuntimeControlTool,
	readChildAuthorityProvider,
	withChildAuthority,
	type ChildAuthorityAction,
	type ChildAuthorityCancelReason,
	type ChildAuthorityDecision,
	type ChildAuthorityErrorCode,
	type ChildAuthorityIdentity,
	type ChildAuthorityJsonValue,
	type ChildAuthorityLease,
	type ChildAuthorityOutcome,
	type ChildAuthorityPayload,
	type ChildAuthorityPrepareIdentity,
	type ChildAuthorityProvider,
	type ChildAuthorityProviderLease,
	type ChildAuthoritySurface,
} from "../runs/shared/child-authority.ts";

export {
	CHILD_AUTHORITY_DEFAULT_DECISION_TIMEOUT_MS,
	CHILD_AUTHORITY_DEFAULT_LEASE_TIMEOUT_MS,
	CHILD_AUTHORITY_DEFAULT_PREPARE_TIMEOUT_MS,
	CHILD_AUTHORITY_DEFAULT_REQUEST_TIMEOUT_MS,
	CHILD_AUTHORITY_ENVELOPE_VERSION,
	createChildAuthorityController,
	createChildAuthorityRunnerClient,
	type ChildAuthorityActionDecision,
	type ChildAuthorityActionRequest,
	type ChildAuthorityCancelMessage,
	type ChildAuthorityController,
	type ChildAuthorityLeaseGrant,
	type ChildAuthorityLeaseRevoke,
	type ChildAuthorityPreparedLease,
	type ChildAuthorityRunnerClient,
	type ChildAuthorityWireMessage,
	type CreateChildAuthorityControllerInput,
	type CreateChildAuthorityRunnerClientOptions,
} from "../runs/shared/child-authority-ipc.ts";
