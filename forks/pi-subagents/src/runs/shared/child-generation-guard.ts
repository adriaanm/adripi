import { isDeepStrictEqual, types } from "node:util";
import type { ChildAuthorityLease } from "./child-authority.ts";

interface ModelIdentity { provider: string; id: string; api?: string }
interface BoundSession {
	readonly sessionId: string;
	readonly model: ModelIdentity | undefined;
}
type Method = (...args: any[]) => any;
const key = (model: ModelIdentity | undefined) => model ? `${model.provider}/${model.id}` : undefined;

/** Capture all SDK model data, including future metadata fields, without getters,
 * coercion, JSON loss or retaining mutable nested aliases. Bounds refuse rather
 * than truncating. This is request provenance, never a permission/cache entry. */
function snapshotMetadata(value: unknown, budget = { nodes: 1024, bytes: 65536 }, ancestors = new Set<object>(), depth = 0): unknown {
	if (--budget.nodes < 0 || depth > 12) throw new Error("model metadata exceeds its bounded data shape");
	if (typeof value === "string") { budget.bytes -= Buffer.byteLength(value); if (budget.bytes < 0) throw new Error("model metadata exceeds its byte bound"); return value; }
	if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) throw new Error("model metadata contains code, proxies, symbols or cycles");
	if (Array.isArray(value) && value.length > 1024) throw new Error("model metadata array exceeds its item bound");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null && !(Array.isArray(value) && prototype === Array.prototype)) throw new Error("model metadata has an unsupported prototype");
	const result = Array.isArray(value) ? [] : Object.create(prototype);
	ancestors.add(value);
	try {
		for (const name of Reflect.ownKeys(value)) {
			if (typeof name !== "string") throw new Error("model metadata has symbol keys");
			budget.bytes -= Buffer.byteLength(name); if (budget.bytes < 0) throw new Error("model metadata exceeds its byte bound");
			const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
			if (!("value" in descriptor)) throw new Error("model metadata has an accessor");
			const arrayLength = Array.isArray(value) && name === "length";
			// Deep comparison must include non-enumerable SDK metadata too.
			Object.defineProperty(result, name, { value: snapshotMetadata(descriptor.value, budget, ancestors, depth + 1), enumerable: !arrayLength, configurable: !arrayLength, writable: true });
		}
	} finally { ancestors.delete(value); }
	return result;
}

/** Fence the existing, fresh SDK runtime, not a second provider/transport. The
 * runner's first prompt check alone cannot stop session_start-triggered prompts,
 * summaries or cache warming. No claim/ack or permission decision is made here.
 * The actual consumers still own policy/operation checks and readiness. */
export function guardChildGeneration(runtime: object, lease: ChildAuthorityLease, selectedModel: ModelIdentity, startupSignal?: AbortSignal): {
	bind(session: BoundSession): void;
	close(): void;
} {
	let session: BoundSession | undefined, sessionId: string | undefined, closed = false;
	const target = runtime as Record<string, unknown>;
	const fail = (reason: string): never => { closed = true; lease.dispose(); throw new Error(`Guarded child generation refused: ${reason}`); };
	const metadata = (model: ModelIdentity | undefined): ModelIdentity => {
		try {
			const data = snapshotMetadata(model) as ModelIdentity;
			if (!data || typeof data !== "object" || typeof Object.getOwnPropertyDescriptor(data, "provider")?.value !== "string" || typeof Object.getOwnPropertyDescriptor(data, "id")?.value !== "string") throw new Error("missing model identity");
			return data;
		} catch { return fail("model metadata cannot be pinned as bounded accessor-free SDK data"); }
	};
	const selected = metadata(selectedModel), requestedModel = key(selected);
	// Observed native router outputs, not decisions/grants or a substitute router.
	// Exact SDK-owned references also cover its native cache warmer's reuse. Each
	// operation still checks readiness, cancellation and all pinned model data.
	const routed = new WeakMap<object, ModelIdentity>();
	const physicalLookup = target.getPhysicalModel;
	if (selected.api === "pi-virtual" && typeof physicalLookup !== "function") fail("this SDK lacks the public physical catalogue for virtual routing");
	const assert = (model?: ModelIdentity, signal?: AbortSignal, requestMetadata?: ModelIdentity) => {
		if (closed || lease.signal.aborted || startupSignal?.aborted || signal?.aborted) fail("the bound generation lifetime ended or was cancelled");
		try { lease.assertReady(); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
		if (!session || session.sessionId !== sessionId) return fail("the SDK session/model identity changed or is not bound");
		const current = metadata(session.model);
		if (key(current) !== requestedModel) return fail("the SDK session/model identity changed or is not bound");
		if (!isDeepStrictEqual(current, selected)) fail("the selected model metadata changed after exact SDK resolution");
		const requested = model && metadata(model);
		if (requestMetadata && !isDeepStrictEqual(requested, requestMetadata)) fail("the in-flight request model metadata changed");
		if (requested && key(requested) === requestedModel && !isDeepStrictEqual(requested, selected)) fail("the request substituted metadata behind the selected provider/model name");
		if (selected.api === "pi-virtual" && target.getPhysicalModel !== physicalLookup) fail("the SDK physical catalogue lookup changed");
		if (requested && key(requested) !== requestedModel) {
			const observed = model && routed.get(model);
			if (selected.api !== "pi-virtual" || !observed) fail("the requested provider/model is not the bound SDK selection or a native routed reference");
			if (!isDeepStrictEqual(requested, observed)) fail("the native routed model metadata changed");
			const catalogue = (physicalLookup as Method).call(runtime, requested.provider, requested.id);
			if (!isDeepStrictEqual(metadata(catalogue), observed)) fail("the SDK physical catalogue no longer matches the native route");
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
	if (selected.api === "pi-virtual") {
		install("resolveModel", original => async (model: ModelIdentity, messages: unknown, options?: Record<string, unknown>) => {
			const signal = AbortSignal.any([lease.signal, ...(startupSignal ? [startupSignal] : []), ...(options?.signal ? [options.signal as AbortSignal] : [])]);
			assert(model, signal);
			if (!isDeepStrictEqual(metadata(model), selected)) fail("routing requires the selected virtual model metadata");
			const route = await original(model, messages, { ...options, signal });
			assert(model, signal);
			const physical = metadata(route?.model);
			const catalogue = (physicalLookup as Method).call(runtime, physical.provider, physical.id);
			if (physical.api === "pi-virtual" || !isDeepStrictEqual(physical, metadata(catalogue))) fail("the native route is not the physical SDK catalogue model");
			const previous = routed.get(route.model);
			if (previous && !isDeepStrictEqual(physical, previous)) fail("the native routed model metadata changed");
			routed.set(route.model, physical);
			return route;
		}, true);
	}
	for (const name of ["stream", "streamSimple", "streamDeferred", "generateImages", "classify"]) {
		install(name, original => (model: ModelIdentity, context: unknown, options?: Record<string, unknown>) => {
			const signal = AbortSignal.any([lease.signal, ...(startupSignal ? [startupSignal] : []), ...(options?.signal ? [options.signal as AbortSignal] : [])]);
			const requestMetadata = metadata(model);
			assert(model, signal, requestMetadata);
			const bounded = { ...options, signal };
			// These are public SDK transport callbacks. Recheck AFTER asynchronous
			// headers/payload hooks too, rather than trusting an earlier stream call.
			for (const callback of ["transformHeaders", "onPayload", "onResponse", "onProviderStreamEvent"] as const) {
				const previous = options?.[callback];
				(bounded as Record<string, unknown>)[callback] = async (...args: unknown[]) => {
					assert(model, signal, requestMetadata);
					const value = typeof previous === "function" ? await previous(...args) : callback === "transformHeaders" ? args[0] : undefined;
					assert(model, signal, requestMetadata);
					return value;
				};
			}
			const result = original(model, context, bounded);
			if (name === "generateImages" || name === "classify") return Promise.resolve(result).then(value => { assert(model, signal, requestMetadata); return value; });
			// Preserve the SDK stream itself, its public iteration/result contract
			// and native provider cancellation. Do not synthesize messages/usage.
			if (result && typeof result === "object") return new Proxy(result, {
				get(stream, property) {
					const value = Reflect.get(stream, property, stream);
					if (property === "result" && typeof value === "function") return async () => {
						assert(model, signal, requestMetadata); const message = await value.call(stream); assert(model, signal, requestMetadata); return message;
					};
					if (property === Symbol.asyncIterator && typeof value === "function") return async function* () {
						assert(model, signal, requestMetadata);
						for await (const event of { [Symbol.asyncIterator]: () => value.call(stream) }) { assert(model, signal, requestMetadata); yield event; }
						assert(model, signal, requestMetadata);
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
