/**
 * The stale-serve window against the StatusWindow directly: the configured discovery.staleServeWindow bounds
 * staleServableModels exactly (0 disables stale serving), while eviction only GROWS with the window and never shrinks
 * below its ten-minute floor. Both directions are load-bearing: a suspended host must not lose the success anchor a
 * longer window promises to serve from, and a zero window must not evict mid-sweep entries the one-cycle grace keeps
 * visible.
 *
 * The window stores and returns models opaquely, so one branded stand-in model is enough.
 */
import { describe, expect, test } from "bun:test";
import type { GroupServer, PreAttachModelInfo } from "../../../../provider/catalog/groupModels";
import { StatusWindow } from "../../../../provider/catalog/statusWindow";
import { markLogSafe } from "../../../../shared/logger";
import type { ServerStatus, ServerStatusError } from "../../../../shared/servers";
import { normalizeBaseUrl } from "../../../../shared/util/baseUrl";
import { fixedHeaderValue } from "../../../../shared/util/headers";

const MINUTE_MS = 60_000;
const DEFAULT_WINDOW_MS = 10 * MINUTE_MS;

const groupServer: GroupServer = {
	baseUrl: normalizeBaseUrl("http://litellm.test"),
	apiKey: fixedHeaderValue("k"),
	label: "Default",
	entryOwned: true,
};

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
	return {
		...common,
		state: "error",
		cause: { kind: "unclassified" },
		logSafeError: markLogSafe("boom"),
		servedModelCount: 0,
	};
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

describe("provider/catalog/statusWindow: one entry per client ID", () => {
	test("a record under another identity with the same client ID replaces the standing entry; a rotated ID keeps it", () => {
		// getGroupServer answers by client ID and assumes one entry per ID. Nothing else says what happens when the same
		// connection is recorded owned (label plus URL) and then unowned (client ID): hidden after its entry's removal,
		// or declared after serving as external. Left beside each other, a removed entry's models stayed counted and
		// routable for a cycle.
		const { window } = makeWindow(DEFAULT_WINDOW_MS);
		const unowned: GroupServer = { baseUrl: groupServer.baseUrl, apiKey: groupServer.apiKey, label: "Default" };
		window.record(okStatus("s1"), served, groupServer, { discoveredRawIds: ["test-model"] });
		const hidden = { ...okStatus("s1"), servedModelCount: 0, hiddenByRemoval: true };

		expect(window.record(hidden, NOTHING_SERVED, unowned)).toBe("entered");
		expect(window.snapshots().map((s) => [s.status.serverId, s.status.servedModelCount])).toEqual([["s1", 0]]);
		expect(window.getGroupServer("s1")).toEqual(unowned);

		// Declared again: the owned record takes the slot back, and the hidden one goes with it.
		window.record(okStatus("s1"), served, groupServer, { discoveredRawIds: ["test-model"] });
		expect(window.snapshots().map((s) => s.status.servedModelCount)).toEqual([1]);

		// A rotation moves the ID, so the hidden record of the retired connection is a different entry.
		expect(window.record({ ...hidden, serverId: "s2" }, NOTHING_SERVED, unowned)).toBe("entered");
		expect(window.serverIds().sort()).toEqual(["s1", "s2"]);
		// And the retired ID's index slot went with the rotation: a later record under it enters anew.
		window.record(okStatus("s3"), served, groupServer, { discoveredRawIds: ["test-model"] });
		expect(window.getGroupServer("s1")).toBeUndefined();
		expect(window.serverIds().sort()).toEqual(["s2", "s3"]);
	});
});

describe("provider/catalog/statusWindow: the client-ID retirement event", () => {
	test("fires only when a record replaces its own entry's client ID, not on entering or on replacing a same-ID twin", () => {
		// The facade prunes the retired ID's caches on this event (index.ts); a rollback to the old credentials would
		// otherwise serve the retired key's cached listing. A twin replacement retires nothing: the IDs are equal.
		const clock = { nowMs: 1_000_000 };
		let retired = 0;
		const window = new StatusWindow(
			() => clock.nowMs,
			() => DEFAULT_WINDOW_MS,
			() => {},
			() => {
				retired += 1;
			}
		);
		const unowned: GroupServer = { baseUrl: groupServer.baseUrl, apiKey: groupServer.apiKey, label: "Default" };
		window.record(okStatus("s1"), served, groupServer, { discoveredRawIds: ["test-model"] });
		expect(retired).toBe(0);
		window.record(okStatus("s2"), served, groupServer, { discoveredRawIds: ["test-model"] });
		expect(retired).toBe(1);
		// The same-ID twin replaces the owned entry; the owned record then re-enters. Neither retires an ID.
		window.record(okStatus("s2"), NOTHING_SERVED, unowned);
		window.record(okStatus("s2"), served, groupServer, { discoveredRawIds: ["test-model"] });
		expect(retired).toBe(1);
	});
});

describe("provider/catalog/statusWindow: what a record reports as changed", () => {
	test("a report equal to the recorded status except lastChecked is repeated; a moved count, state, or client ID is changed", () => {
		// The reporter's fan-out gate (statusReporting.ts) reads this answer; nothing else in the repository says that a
		// fresh lastChecked alone is no change, so a window that counted it as one would fan out every hidden sweep.
		const { window } = makeWindow(DEFAULT_WINDOW_MS);
		const hidden = { ...okStatus(), servedModelCount: 0, hiddenByRemoval: true, lastChecked: "t1" };

		expect(window.record(hidden, NOTHING_SERVED, groupServer)).toBe("entered");
		expect(window.record({ ...hidden, lastChecked: "t2" }, NOTHING_SERVED, groupServer)).toBe("repeated");
		expect(window.snapshots().map((s) => s.status.lastChecked)).toEqual(["t2"]);

		const moved = [
			{ ...hidden, servedModelCount: 1, hiddenByRemoval: undefined },
			{ ...hidden, serverId: "s2" },
		];
		for (const status of moved) {
			expect(window.record(status, NOTHING_SERVED, groupServer)).toBe("changed");
			// Back to the hidden status is a change too: the comparison is against what stands, not against history.
			expect(window.record(hidden, NOTHING_SERVED, groupServer)).toBe("changed");
		}
		expect(window.record({ ...errorStatus(), lastChecked: "t3" }, NOTHING_SERVED, groupServer)).toBe("changed");
		expect(window.record(hidden, NOTHING_SERVED, groupServer)).toBe("changed");
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
		const rotated: GroupServer = { ...groupServer, apiKey: fixedHeaderValue("k2") };

		// The failing serve reads the anchor BEFORE its own record lands, under the client ID no report has used yet.
		clock.nowMs += MINUTE_MS;
		expect(window.staleServableModels("s2", rotated)?.models).toEqual(models);
		window.record(errorStatus("s2"), NOTHING_SERVED, rotated);
		expect(window.serverIds()).toEqual(["s2"]);
		expect(window.getGroupServer("s1")).toBeUndefined();
		expect(window.getGroupServer("s2")?.apiKey).toBe(rotated.apiKey);
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
		window.record(errorStatus("a2"), NOTHING_SERVED, { ...groupServer, apiKey: fixedHeaderValue("k2") });
		expect(window.serverIds()).toEqual(["a2", "b1"]);
		expect(window.staleServableModels("b1", other)?.models).toEqual(models);
	});
});

describe("provider/catalog/statusWindow: observed labeled group identities", () => {
	test("labeled groups' base URLs are the window's LIVE view per label, an unlabeled group leaves no URL, and every identity's entry fires once", () => {
		const clock = { nowMs: 1_000_000 };
		let entered = 0;
		const window = new StatusWindow(
			() => clock.nowMs,
			() => DEFAULT_WINDOW_MS,
			() => {
				entered += 1;
			}
		);
		const oldGroup: GroupServer = {
			baseUrl: normalizeBaseUrl("http://old.test/"),
			apiKey: fixedHeaderValue("k"),
			label: "Prod",
			entryOwned: true,
		};
		const newGroup: GroupServer = {
			baseUrl: normalizeBaseUrl("http://new.test"),
			apiKey: fixedHeaderValue("k"),
			label: "Prod",
			entryOwned: true,
		};
		const unlabeled: GroupServer = { baseUrl: normalizeBaseUrl("http://bare.test"), apiKey: fixedHeaderValue("k") };
		window.record(errorStatus("old"), NOTHING_SERVED, oldGroup);
		window.record(okStatus("new"), served, newGroup, { discoveredRawIds: ["test-model"] });
		window.record(okStatus("bare"), served, unlabeled, { discoveredRawIds: ["test-model"] });
		// A re-report is not an entry; the unlabeled group's entry counts like a labeled one's (the sync engine joins it
		// by client ID too).
		window.record(errorStatus("old"), NOTHING_SERVED, oldGroup);
		expect(entered).toBe(3);
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
		expect(entered).toBe(4);
		expect(window.observedGroupBaseUrls("Prod")).toEqual(["http://old.test"]);
	});
});
