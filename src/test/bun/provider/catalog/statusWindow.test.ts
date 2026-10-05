/**
 * The stale-serve window against the StatusWindow directly: the configured discovery.staleServeWindow bounds
 * staleServableModels exactly (0 disables stale serving), while eviction only GROWS with the window and never shrinks
 * below its ten-minute floor. Both directions are load-bearing: a suspended host must not lose the success anchor a
 * longer window promises to serve from, and a zero window must not evict mid-sweep entries the one-cycle grace keeps
 * visible.
 */
import { describe, expect, test } from "bun:test";
import type { GroupServer, PreAttachModelInfo } from "../../../../provider/catalog/groupModels";
import { StatusWindow } from "../../../../provider/catalog/statusWindow";
import { markLogSafe } from "../../../../shared/logger";
import type { ServerStatus, ServerStatusError } from "../../../../shared/servers";
import { normalizeBaseUrl } from "../../../../shared/util/baseUrl";

const MINUTE_MS = 60_000;
const DEFAULT_WINDOW_MS = 10 * MINUTE_MS;

const groupServer: GroupServer = { baseUrl: normalizeBaseUrl("http://litellm.test"), apiKey: "k", label: "Default" };

// The window stores and returns models opaquely; one branded stand-in is enough.
const models = [{ id: "test-model" } as PreAttachModelInfo];
const served = { discovered: models, declared: [] };
const NOTHING_SERVED = { discovered: [], declared: [] };

// Failure reports below record the EMPTY list, exactly like groupDiscovery's out-of-window failure path: stale
// retention must come from the recorded success, never from a failure report's payload.

function okStatus(serverId = "s1"): Extract<ServerStatus, { state: "ok" }> {
	const common = { serverId, label: "Default", baseUrl: "http://litellm.test", lastChecked: "now" };
	return { ...common, state: "ok", servedModelCount: 1 };
}

function errorStatus(serverId = "s1"): ServerStatusError {
	const common = { serverId, label: "Default", baseUrl: "http://litellm.test", lastChecked: "now" };
	return { ...common, state: "error", error: "boom", logSafeError: markLogSafe("boom"), servedModelCount: 0 };
}

function makeWindow(initialWindowMs: number) {
	const clock = { nowMs: 1_000_000 };
	const config = { windowMs: initialWindowMs };
	const window = new StatusWindow(
		() => clock.nowMs,
		() => config.windowMs
	);
	return { window, clock, config };
}

describe("provider/catalog/statusWindow: the configured stale-serve window", () => {
	test("the default window serves at ten minutes and stops past it (today's behavior)", () => {
		const { window, clock } = makeWindow(DEFAULT_WINDOW_MS);
		window.record(okStatus(), served, groupServer, { discoveredRawIds: ["test-model"] });

		clock.nowMs += DEFAULT_WINDOW_MS;
		window.record(errorStatus(), NOTHING_SERVED, groupServer);
		expect(window.staleServableModels("s1", groupServer)?.models).toEqual(models);

		clock.nowMs += 1;
		expect(window.staleServableModels("s1", groupServer)).toBeUndefined();
	});

	test("a zero window never serves stale, even right after the success", () => {
		const { window } = makeWindow(0);
		window.record(okStatus(), served, groupServer, { discoveredRawIds: ["test-model"] });
		window.record(errorStatus(), NOTHING_SERVED, groupServer);
		expect(window.staleServableModels("s1", groupServer)).toBeUndefined();
	});

	test("a longer window serves past ten minutes and honors its own bound", () => {
		const { window, clock } = makeWindow(60 * MINUTE_MS);
		window.record(okStatus(), served, groupServer, { discoveredRawIds: ["test-model"] });

		clock.nowMs += 30 * MINUTE_MS;
		window.record(errorStatus(), NOTHING_SERVED, groupServer);
		expect(window.staleServableModels("s1", groupServer)?.models).toEqual(models);

		clock.nowMs += 31 * MINUTE_MS;
		window.record(errorStatus(), NOTHING_SERVED, groupServer);
		expect(window.staleServableModels("s1", groupServer)).toBeUndefined();
	});

	test("a settings change reaches the next read without re-recording", () => {
		const { window, clock, config } = makeWindow(DEFAULT_WINDOW_MS);
		window.record(okStatus(), served, groupServer, { discoveredRawIds: ["test-model"] });
		clock.nowMs += 30 * MINUTE_MS;
		window.record(errorStatus(), NOTHING_SERVED, groupServer);
		expect(window.staleServableModels("s1", groupServer)).toBeUndefined();

		config.windowMs = 60 * MINUTE_MS;
		expect(window.staleServableModels("s1", groupServer)?.models).toEqual(models);
	});

	test("eviction grows with the window: a report gap longer than the floor keeps the anchor alive", () => {
		// The suspended-host scenario: last report 30 minutes ago, then a new sweep begins. Under a fixed TTL the cycle
		// boundary would evict the entry and lose the recorded success before the failing refresh could serve from it.
		const { window, clock } = makeWindow(60 * MINUTE_MS);
		window.record(okStatus(), served, groupServer, { discoveredRawIds: ["test-model"] });

		clock.nowMs += 30 * MINUTE_MS;
		window.beginCycle();
		expect(window.serverIds()).toEqual(["s1"]);
		window.record(errorStatus(), NOTHING_SERVED, groupServer);
		expect(window.staleServableModels("s1", groupServer)?.models).toEqual(models);
	});

	test("eviction keeps its ten-minute floor with the default window (today's behavior)", () => {
		const { window, clock } = makeWindow(DEFAULT_WINDOW_MS);
		window.record(okStatus(), served, groupServer, { discoveredRawIds: ["test-model"] });

		clock.nowMs += 30 * MINUTE_MS;
		window.beginCycle();
		expect(window.serverIds()).toEqual([]);
	});

	test("a zero window never shrinks eviction below the floor: mid-sweep entries survive the cycle boundary", () => {
		const { window, clock } = makeWindow(0);
		window.record(okStatus(), served, groupServer, { discoveredRawIds: ["test-model"] });

		clock.nowMs += 5 * MINUTE_MS;
		window.beginCycle();
		expect(window.serverIds()).toEqual(["s1"]);
	});
});

describe("provider/catalog/statusWindow: the failure-record contract", () => {
	test("failure reports carry the last success's raw IDs forward into the stale bundle", () => {
		// Declared-ID inertness during an outage judges against this set, so a mid-outage failure report must not blank
		// it.
		const { window, clock } = makeWindow(DEFAULT_WINDOW_MS);
		window.record(okStatus(), served, groupServer, { discoveredRawIds: ["test-model"] });

		clock.nowMs += MINUTE_MS;
		window.record(errorStatus(), NOTHING_SERVED, groupServer);
		expect(window.staleServableModels("s1", groupServer)?.discoveredRawIds).toEqual(["test-model"]);
	});

	test("a failure report structurally cannot carry observations", () => {
		const { window } = makeWindow(DEFAULT_WINDOW_MS);
		window.record(okStatus(), served, groupServer, { discoveredRawIds: ["test-model"] });

		// @ts-expect-error - the failure overload has no observations parameter
		window.record(errorStatus(), NOTHING_SERVED, groupServer, { discoveredRawIds: ["smuggled"] });
		expect(window.staleServableModels("s1", groupServer)?.discoveredRawIds).toEqual(["test-model"]);
	});
});

describe("provider/catalog/statusWindow: declared models in the served record", () => {
	const declared = [{ id: "declared-model" } as PreAttachModelInfo];

	test("snapshots carry the full served set, discovered then declared", () => {
		const { window } = makeWindow(DEFAULT_WINDOW_MS);
		window.record(okStatus(), { discovered: models, declared }, groupServer, { discoveredRawIds: ["test-model"] });
		expect(window.snapshots().map((snapshot) => snapshot.models.map((info) => info.id))).toEqual([
			["test-model", "declared-model"],
		]);
	});

	test("stale serving anchors to the discovered set alone: declared models never ride the success bundle", () => {
		const { window, clock } = makeWindow(DEFAULT_WINDOW_MS);
		window.record(okStatus(), { discovered: models, declared }, groupServer, { discoveredRawIds: ["test-model"] });

		// A mid-outage failure still serving the declared model records it, but the stale-servable bundle must stay
		// declared-free: declared models are config-rebuilt every serve, so a staled copy would resurrect a removed
		// declaration and collide with the fresh synthesis.
		clock.nowMs += MINUTE_MS;
		window.record(errorStatus(), { discovered: [], declared }, groupServer);
		expect(window.staleServableModels("s1", groupServer)?.models).toEqual(models);
		expect(window.snapshots().map((snapshot) => snapshot.models.map((info) => info.id))).toEqual([["declared-model"]]);
	});
});

describe("provider/catalog/statusWindow: a labeled group's entry keys on its identity, never its credentials", () => {
	test("a credential rotation updates the one entry in place: new client ID, last success carried, no entry event", () => {
		// The incident: a rotation minted a second entry beside the retired one, double-counting the merged status
		// and rendering a ghost external row whose Hide tombstoned the label the real group serves under.
		const clock = { nowMs: 1_000_000 };
		let entered = 0;
		const window = new StatusWindow(
			() => clock.nowMs,
			() => DEFAULT_WINDOW_MS,
			() => {
				entered += 1;
			}
		);
		window.record(okStatus("s1"), served, groupServer, { discoveredRawIds: ["test-model"] });
		const rotated: GroupServer = { ...groupServer, apiKey: "k2" };

		// The failing serve reads the anchor BEFORE its own record lands, under the client ID no report has used yet.
		clock.nowMs += MINUTE_MS;
		expect(window.staleServableModels("s2", rotated)?.models).toEqual(models);
		window.record(errorStatus("s2"), NOTHING_SERVED, rotated);
		expect(window.serverIds()).toEqual(["s2"]);
		expect(window.getGroupServer("s1")).toBeUndefined();
		expect(window.getGroupServer("s2")?.apiKey).toBe("k2");
		expect(window.staleServableModels("s2", rotated)?.discoveredRawIds).toEqual(["test-model"]);
		expect(entered).toBe(1);

		const relabeled: GroupServer = { ...groupServer, label: "Other" };
		const moved: GroupServer = { ...groupServer, baseUrl: normalizeBaseUrl("http://moved.test") };
		window.record(errorStatus("s3"), NOTHING_SERVED, relabeled);
		window.record(errorStatus("s4"), NOTHING_SERVED, moved);
		expect(window.serverIds()).toEqual(["s2", "s3", "s4"]);
		expect(window.staleServableModels("s3", relabeled)).toBeUndefined();
		expect(entered).toBe(3);
	});

	test("on unmarked cycles only the same client ID re-sighted advances the cycle; a rotation leaves the other groups alone", () => {
		// The regression the identity key invited: a rotated client ID read as a re-sight advanced the cycle twice
		// in a row and evicted a live group (its stale anchor with it) before the sweep re-reached it.
		const { window } = makeWindow(DEFAULT_WINDOW_MS);
		const other: GroupServer = { ...groupServer, label: "Other" };
		window.record(okStatus("a1"), served, groupServer, { discoveredRawIds: ["test-model"] });
		window.record(okStatus("b1"), served, other, { discoveredRawIds: ["test-model"] });
		expect(window.beginCycleOnReSight("a1", groupServer)).toBe(true);
		window.record(okStatus("a1"), served, groupServer, { discoveredRawIds: ["test-model"] });

		expect(window.beginCycleOnReSight("a2", groupServer)).toBe(false);
		window.record(errorStatus("a2"), NOTHING_SERVED, { ...groupServer, apiKey: "k2" });
		expect(window.serverIds()).toEqual(["a2", "b1"]);
		expect(window.staleServableModels("b1", other)?.models).toEqual(models);
	});
});

describe("provider/catalog/statusWindow: observed labeled group identities", () => {
	test("labeled groups' base URLs are the window's LIVE view per label, unlabeled groups leave no trace, and entering fires once", () => {
		const clock = { nowMs: 1_000_000 };
		let entered = 0;
		const window = new StatusWindow(
			() => clock.nowMs,
			() => DEFAULT_WINDOW_MS,
			() => {
				entered += 1;
			}
		);
		const oldGroup: GroupServer = { baseUrl: normalizeBaseUrl("http://old.test/"), apiKey: "k", label: "Prod" };
		const newGroup: GroupServer = { baseUrl: normalizeBaseUrl("http://new.test"), apiKey: "k", label: "Prod" };
		const unlabeled: GroupServer = { baseUrl: normalizeBaseUrl("http://bare.test"), apiKey: "k" };
		window.record(errorStatus("old"), NOTHING_SERVED, oldGroup);
		window.record(okStatus("new"), served, newGroup, { discoveredRawIds: ["test-model"] });
		window.record(okStatus("bare"), served, unlabeled, { discoveredRawIds: ["test-model"] });
		// A re-report is not an entry.
		window.record(errorStatus("old"), NOTHING_SERVED, oldGroup);
		expect(entered).toBe(2);
		expect(window.observedGroupBaseUrls("Prod")).toEqual(["http://old.test", "http://new.test"]);
		expect(window.observedGroupBaseUrls("bare.test")).toEqual([]);
		expect(window.observedGroupBaseUrls("Never")).toEqual([]);

		// Live, not historical: an evicted group is no evidence, and its return is an entry again (the sync engine
		// re-runs on it).
		clock.nowMs += 3 * DEFAULT_WINDOW_MS;
		window.beginCycle();
		window.beginCycle();
		expect(window.serverIds()).toEqual([]);
		expect(window.observedGroupBaseUrls("Prod")).toEqual([]);
		window.record(errorStatus("old"), NOTHING_SERVED, oldGroup);
		expect(entered).toBe(3);
		expect(window.observedGroupBaseUrls("Prod")).toEqual(["http://old.test"]);
	});
});
