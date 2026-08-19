/**
 * The stale-serve window against the StatusWindow directly: the configured
 * discovery.staleServeWindow bounds staleServableModels exactly (0 disables
 * stale serving), while eviction only GROWS with the window and never shrinks
 * below its ten-minute floor. Both directions are load-bearing: a suspended
 * host must not lose the success anchor a longer window promises to serve from,
 * and a zero window must not evict mid-sweep entries the one-cycle grace keeps
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

// Failure reports below record the EMPTY list, exactly like groupDiscovery's
// out-of-window failure path: stale retention must come from the recorded
// success, never from a failure report's payload.

function okStatus(serverId = "s1"): Extract<ServerStatus, { state: "ok" }> {
	const common = { serverId, label: "Default", baseUrl: "http://litellm.test", lastChecked: "now" };
	return { ...common, state: "ok", servedModelCount: 1 };
}

function errorStatus(serverId = "s1"): ServerStatusError {
	const common = { serverId, label: "Default", baseUrl: "http://litellm.test", lastChecked: "now" };
	return { ...common, state: "error", error: "boom", logSafeError: markLogSafe("boom"), servedModelCount: 0 };
}

/** A window on a fake clock with a mutable configured stale-serve window. */
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
		expect(window.staleServableModels("s1")?.models).toEqual(models);

		clock.nowMs += 1;
		expect(window.staleServableModels("s1")).toBeUndefined();
	});

	test("a zero window never serves stale, even right after the success", () => {
		const { window } = makeWindow(0);
		window.record(okStatus(), served, groupServer, { discoveredRawIds: ["test-model"] });
		window.record(errorStatus(), NOTHING_SERVED, groupServer);
		expect(window.staleServableModels("s1")).toBeUndefined();
	});

	test("a longer window serves past ten minutes and honors its own bound", () => {
		const { window, clock } = makeWindow(60 * MINUTE_MS);
		window.record(okStatus(), served, groupServer, { discoveredRawIds: ["test-model"] });

		clock.nowMs += 30 * MINUTE_MS;
		window.record(errorStatus(), NOTHING_SERVED, groupServer);
		expect(window.staleServableModels("s1")?.models).toEqual(models);

		clock.nowMs += 31 * MINUTE_MS;
		window.record(errorStatus(), NOTHING_SERVED, groupServer);
		expect(window.staleServableModels("s1")).toBeUndefined();
	});

	test("a settings change reaches the next read without re-recording", () => {
		const { window, clock, config } = makeWindow(DEFAULT_WINDOW_MS);
		window.record(okStatus(), served, groupServer, { discoveredRawIds: ["test-model"] });
		clock.nowMs += 30 * MINUTE_MS;
		window.record(errorStatus(), NOTHING_SERVED, groupServer);
		expect(window.staleServableModels("s1")).toBeUndefined();

		config.windowMs = 60 * MINUTE_MS;
		expect(window.staleServableModels("s1")?.models).toEqual(models);
	});

	test("eviction grows with the window: a report gap longer than the floor keeps the anchor alive", () => {
		// The suspended-host scenario: last report 30 minutes ago, then a new sweep
		// begins. Under a fixed TTL the cycle boundary would evict the entry and
		// lose the recorded success before the failing refresh could serve from it.
		const { window, clock } = makeWindow(60 * MINUTE_MS);
		window.record(okStatus(), served, groupServer, { discoveredRawIds: ["test-model"] });

		clock.nowMs += 30 * MINUTE_MS;
		window.beginCycle();
		expect(window.serverIds()).toEqual(["s1"]);
		window.record(errorStatus(), NOTHING_SERVED, groupServer);
		expect(window.staleServableModels("s1")?.models).toEqual(models);
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

		// One cycle boundary minutes later: the one-cycle grace plus the
		// eviction floor keep the entry visible for the merged status view.
		clock.nowMs += 5 * MINUTE_MS;
		window.beginCycle();
		expect(window.serverIds()).toEqual(["s1"]);
	});
});

describe("provider/catalog/statusWindow: the failure-record contract", () => {
	test("failure reports carry the last success's raw IDs forward into the stale bundle", () => {
		// Declared-ID inertness during an outage judges against this set, so a
		// mid-outage failure report must not blank it.
		const { window, clock } = makeWindow(DEFAULT_WINDOW_MS);
		window.record(okStatus(), served, groupServer, { discoveredRawIds: ["test-model"] });

		clock.nowMs += MINUTE_MS;
		window.record(errorStatus(), NOTHING_SERVED, groupServer);
		expect(window.staleServableModels("s1")?.discoveredRawIds).toEqual(["test-model"]);
	});

	test("a failure report structurally cannot carry observations", () => {
		const { window } = makeWindow(DEFAULT_WINDOW_MS);
		window.record(okStatus(), served, groupServer, { discoveredRawIds: ["test-model"] });

		// @ts-expect-error - the failure overload has no observations parameter
		window.record(errorStatus(), NOTHING_SERVED, groupServer, { discoveredRawIds: ["smuggled"] });
		expect(window.staleServableModels("s1")?.discoveredRawIds).toEqual(["test-model"]);
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

		// A mid-outage failure still serving the declared model records it, but
		// the stale-servable bundle must stay declared-free: declared models are
		// config-rebuilt every serve, so a staled copy would resurrect a removed
		// declaration and collide with the fresh synthesis.
		clock.nowMs += MINUTE_MS;
		window.record(errorStatus(), { discovered: [], declared }, groupServer);
		expect(window.staleServableModels("s1")?.models).toEqual(models);
		expect(window.snapshots().map((snapshot) => snapshot.models.map((info) => info.id))).toEqual([["declared-model"]]);
	});
});
