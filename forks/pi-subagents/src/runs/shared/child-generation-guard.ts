import type { ChildAuthorityLease } from "./child-authority.ts";

interface ModelIdentity { provider: string; id: string; api?: string }
interface BoundSession {
	readonly sessionId: string;
	readonly model: ModelIdentity | undefined;
	readonly agent: { readonly state: { readonly model: ModelIdentity } };
}
type Method = (...args: any[]) => any;
const key = (model: ModelIdentity | undefined) => model ? `${model.provider}/${model.id}` : undefined;

/** Fence the existing, fresh SDK runtime, not a second provider/transport. The
 * runner's first prompt check alone cannot stop session_start-triggered prompts,
 * summaries or cache warming. No claim/ack or permission decision is made here.
 * The actual consumers still own policy/operation checks and readiness. */
export function guardChildGeneration(runtime: object, lease: ChildAuthorityLease, requestedModel: string, startupSignal?: AbortSignal): {
	bind(session: BoundSession): void;
	close(): void;
} {
	let session: BoundSession | undefined, sessionId: string | undefined, closed = false;
	const target = runtime as Record<string, unknown>;
	const fail = (reason: string): never => { closed = true; lease.dispose(); throw new Error(`Guarded child generation refused: ${reason}`); };
	const assert = (model?: ModelIdentity, signal?: AbortSignal) => {
		if (closed || lease.signal.aborted || startupSignal?.aborted || signal?.aborted) fail("the bound generation lifetime ended or was cancelled");
		try { lease.assertReady(); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
		if (!session || session.sessionId !== sessionId || key(session.model) !== requestedModel) return fail("the SDK session/model identity changed or is not bound");
		// SDK virtual routing remains the SDK's path, not a fallback selector here.
		// Physical requests must be the live agent's current routed model. Complete
		// virtual/provider provenance remains a separate composition acceptance gate.
		if (model && key(model) !== requestedModel && !(session.model?.api === "pi-virtual" && key(session.agent.state.model) === key(model))) {
			fail("the requested provider/model is not the bound SDK selection");
		}
	};
	const install = (name: string, wrap: (original: Method) => Method, required = false) => {
		const method = target[name];
		if (typeof method !== "function") {
			if (required) fail(`this SDK lacks the public ${name} generation boundary`);
			return;
		}
		Object.defineProperty(runtime, name, { value: wrap(method.bind(runtime)), enumerable: true, writable: false, configurable: false });
	};
	for (const name of ["stream", "streamSimple", "streamDeferred", "generateImages", "classify"]) {
		install(name, original => (model: ModelIdentity, context: unknown, options?: Record<string, unknown>) => {
			const signal = AbortSignal.any([lease.signal, ...(startupSignal ? [startupSignal] : []), ...(options?.signal ? [options.signal as AbortSignal] : [])]);
			assert(model, signal);
			const bounded = { ...options, signal };
			// These are public SDK transport callbacks. Recheck AFTER asynchronous
			// headers/payload hooks too, rather than trusting an earlier stream call.
			for (const callback of ["transformHeaders", "onPayload", "onResponse", "onProviderStreamEvent"] as const) {
				const previous = options?.[callback];
				(bounded as Record<string, unknown>)[callback] = async (...args: unknown[]) => {
					assert(model, signal);
					const value = typeof previous === "function" ? await previous(...args) : callback === "transformHeaders" ? args[0] : undefined;
					assert(model, signal);
					return value;
				};
			}
			const result = original(model, context, bounded);
			if (name === "generateImages" || name === "classify") return Promise.resolve(result).then(value => { assert(model, signal); return value; });
			// Preserve the SDK stream itself, its public iteration/result contract
			// and native provider cancellation. Do not synthesize messages/usage.
			if (result && typeof result === "object") return new Proxy(result, {
				get(stream, property) {
					const value = Reflect.get(stream, property, stream);
					if (property === "result" && typeof value === "function") return async () => {
						assert(model, signal); const message = await value.call(stream); assert(model, signal); return message;
					};
					if (property === Symbol.asyncIterator && typeof value === "function") return async function* () {
						assert(model, signal);
						for await (const event of { [Symbol.asyncIterator]: () => value.call(stream) }) { assert(model, signal); yield event; }
						assert(model, signal);
					};
					return typeof value === "function" ? value.bind(stream) : value;
				},
			});
			return result;
		}, name === "stream" || name === "streamSimple");
	}
	// Registration/refresh completed before exact CLI-model resolution. Later
	// replacement must not change the code behind the same provider/id silently.
	for (const name of ["registerProvider", "registerNativeProvider", "unregisterProvider", "registerVirtualModel", "unregisterVirtualModel", "refresh"]) {
		install(name, () => () => fail("the selected provider registry cannot be replaced after guarded model resolution"));
	}
	return {
		bind(value) {
			if (session || closed || typeof value.sessionId !== "string" || !value.sessionId) fail("the SDK session cannot initialize or rebind its generation lifetime");
			session = value; sessionId = value.sessionId;
		},
		close() { closed = true; lease.dispose(); },
	};
}
