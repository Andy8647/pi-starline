export const STARLINE_PROTOTYPE_PATCH_REGISTRY = Symbol.for("pi-starline.prototype-patch-registry");

/**
 * The key this package used before it was renamed from pi-zentui. Read AND
 * written, alongside the new key: package load order is not controlled by
 * either side, so whichever of pi-starline/pi-zentui creates the registry
 * first must expose it under both keys. Otherwise a pi-starline-first load
 * (the common order, since it sorts first alphabetically) would leave a
 * later-loading pi-zentui unable to find it, and each package would patch a
 * prototype the other has already patched.
 */
const LEGACY_PROTOTYPE_PATCH_REGISTRY = Symbol.for("pi-zentui.prototype-patch-registry");

type PrototypePatchAdapter =
	| "user-message-render"
	| "user-message-invalidate"
	| "selector-border-render"
	| "mouse-viewport-input"
	| "mouse-wheel"
	| "mouse-selection-event"
	| "mouse-copy"
	| "mouse-word-selection";

type PrototypeMethodName = string;

type PrototypeMethod = (this: unknown, ...args: unknown[]) => unknown;

type PatchInvocation = {
	predecessor: PrototypeMethod;
	receiver: unknown;
	args: unknown[];
};

type PatchBehavior = (invocation: PatchInvocation) => unknown;

type Registration = {
	token: symbol;
	behavior?: PatchBehavior;
};

type PatchRecord = {
	method: PrototypeMethodName;
	predecessor: PrototypeMethod;
	wrapper: PrototypeMethod;
	registration?: Registration;
};

type PatchRegistry = Map<PrototypePatchAdapter, PatchRecord>;

type PatchTarget = Record<PropertyKey, unknown>;

function registryFor(target: PatchTarget): PatchRegistry {
	const existing =
		target[STARLINE_PROTOTYPE_PATCH_REGISTRY] ?? target[LEGACY_PROTOTYPE_PATCH_REGISTRY];
	if (existing instanceof Map) return existing as PatchRegistry;
	const registry: PatchRegistry = new Map();
	// One Map, exposed under both keys, so whichever package looks second
	// (in either load order) adopts this same registry instead of creating
	// its own and double-patching.
	Object.defineProperty(target, STARLINE_PROTOTYPE_PATCH_REGISTRY, {
		value: registry,
		configurable: true,
	});
	Object.defineProperty(target, LEGACY_PROTOTYPE_PATCH_REGISTRY, {
		value: registry,
		configurable: true,
	});
	return registry;
}

function createCleanup(
	target: PatchTarget,
	method: PrototypeMethodName,
	adapter: PrototypePatchAdapter,
	registry: PatchRegistry,
	record: PatchRecord,
	token: symbol,
): () => void {
	let cleaned = false;
	return () => {
		if (cleaned) return;
		cleaned = true;
		if (record.registration?.token !== token) return;
		record.registration.behavior = undefined;
		record.registration = undefined;

		const current = registry.get(adapter);
		if (current !== record) return;
		if (target[method] === record.wrapper) target[method] = record.predecessor;
		registry.delete(adapter);
		if (registry.size === 0) {
			delete target[STARLINE_PROTOTYPE_PATCH_REGISTRY];
			delete target[LEGACY_PROTOTYPE_PATCH_REGISTRY];
		}
	};
}

export function installPrototypePatch(
	targetValue: object,
	method: PrototypeMethodName,
	adapter: PrototypePatchAdapter,
	behavior: PatchBehavior,
): () => void {
	const target = targetValue as PatchTarget;
	const registry = registryFor(target);
	let record = registry.get(adapter);

	if (!(record && record.method === method && target[method] === record.wrapper)) {
		const predecessor = target[method];
		if (typeof predecessor !== "function") {
			throw new TypeError(`Cannot patch ${method}: predecessor is not a function`);
		}
		const nextRecord: PatchRecord = {
			method,
			predecessor: predecessor as PrototypeMethod,
			wrapper: () => undefined,
		};
		const wrapper: PrototypeMethod = function starlinePrototypeWrapper(
			this: unknown,
			...args: unknown[]
		): unknown {
			const activeBehavior = nextRecord.registration?.behavior;
			return activeBehavior
				? activeBehavior({ predecessor: nextRecord.predecessor, receiver: this, args })
				: Reflect.apply(nextRecord.predecessor, this, args);
		};
		nextRecord.wrapper = wrapper;
		record = nextRecord;
		registry.set(adapter, record);
		target[method] = wrapper;
	}

	const token = Symbol(adapter);
	record.registration = { token, behavior };
	return createCleanup(target, method, adapter, registry, record, token);
}
