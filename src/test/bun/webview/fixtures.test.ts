/**
 * The fixture builders' type-level contract, proven in both directions: a coherent per-variant
 * override compiles (these calls), and an incoherent state cluster fails to typecheck (the
 * @ts-expect-error probes - typecheck rejects this file if any of them starts compiling).
 * Runtime stays the plain spread; the assertions pin that the override wins the merge.
 */
import { expect, test } from "bun:test";
import { declaredWithSecrets, makeDeclaredServer, makeExternalServer, makeMisconfiguredServer } from "./fixtures";

test("coherent state-cluster overrides compile and win the merge", () => {
	const failed = makeDeclaredServer({
		label: "Down",
		state: "error",
		error: "connect ECONNREFUSED",
		classification: { kind: "connection", setupHint: "proxy-not-running" },
		expected: true,
		declaredModelCount: 2,
	});
	expect(failed.state).toBe("error");
	expect(failed.error).toBe("connect ECONNREFUSED");

	// The ok cluster's own optional companions need no state key.
	expect(makeDeclaredServer({ modelInfoUnsupported: "timeout" }).modelInfoUnsupported).toBe("timeout");
	expect(makeDeclaredServer({ state: "unchecked" }).state).toBe("unchecked");

	expect(makeExternalServer({ state: "error", error: "boom" }).error).toBe("boom");
	expect(declaredWithSecrets({ apiKey: "secure" }, { state: "error", error: "401" }).error).toBe("401");

	// The misconfigured base already sits in the error cluster; its fields override piecewise.
	expect(makeMisconfiguredServer({ error: "renamed key" }).error).toBe("renamed key");
	expect(makeMisconfiguredServer({ state: "ok" }).state).toBe("ok");
});

test("incoherent state-cluster overrides fail to typecheck", () => {
	// @ts-expect-error: state "error" without its required `error` must not compile
	makeDeclaredServer({ state: "error" });
	// @ts-expect-error: an ok row cannot smuggle the error cluster's `expected`
	makeDeclaredServer({ state: "ok", expected: true });
	// @ts-expect-error: an ok row cannot carry an error - a sync failure is an error row keeping its served count
	makeDeclaredServer({ error: "upsert failed" });
	// @ts-expect-error: an unchecked row carries no error
	makeDeclaredServer({ state: "unchecked", error: "x" });
	// @ts-expect-error: a key on no variant is a typo, not an override
	makeDeclaredServer({ stat: "error" });
	// @ts-expect-error: the external builder enforces the same cluster
	makeExternalServer({ state: "error" });
	// @ts-expect-error: declaredWithSecrets forwards the same override type
	declaredWithSecrets({ apiKey: "secure" }, { state: "error" });
	// @ts-expect-error: a misconfigured base keeps its error, which the unchecked variant forbids
	makeMisconfiguredServer({ state: "unchecked" });
	// @ts-expect-error: the ok cluster on a misconfigured row cannot carry a classification
	makeMisconfiguredServer({ state: "ok", classification: { kind: "http", status: 500 } });
});
