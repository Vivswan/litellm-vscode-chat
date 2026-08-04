import * as assert from "node:assert";
import {
	createNoDiscoveryState,
	isDiscoveryRoute,
	NO_DISCOVERY_PREFIX,
	noDiscoveryStats,
	recordDiscoveryAttempt,
	stripNoDiscoveryPrefix,
} from "./noDiscovery";

suite("fakeStack/noDiscovery: prefix routing", () => {
	test("strips the leading prefix and flags the request", () => {
		assert.deepStrictEqual(stripNoDiscoveryPrefix(`${NO_DISCOVERY_PREFIX}/v1/models`), {
			pathname: "/v1/models",
			noDiscovery: true,
		});
		assert.deepStrictEqual(stripNoDiscoveryPrefix(`${NO_DISCOVERY_PREFIX}/v1/chat/completions`), {
			pathname: "/v1/chat/completions",
			noDiscovery: true,
		});
	});

	test("the bare prefix routes to /", () => {
		assert.deepStrictEqual(stripNoDiscoveryPrefix(NO_DISCOVERY_PREFIX), { pathname: "/", noDiscovery: true });
	});

	test("leaves unprefixed and lookalike paths alone", () => {
		assert.deepStrictEqual(stripNoDiscoveryPrefix("/v1/models"), { pathname: "/v1/models", noDiscovery: false });
		assert.deepStrictEqual(stripNoDiscoveryPrefix(`${NO_DISCOVERY_PREFIX}extra/v1/models`), {
			pathname: `${NO_DISCOVERY_PREFIX}extra/v1/models`,
			noDiscovery: false,
		});
	});

	test("isDiscoveryRoute names exactly the two discovery GETs", () => {
		assert.strictEqual(isDiscoveryRoute("/v1/models"), true);
		assert.strictEqual(isDiscoveryRoute("/v1/model/info"), true);
		assert.strictEqual(isDiscoveryRoute("/v1/chat/completions"), false);
		assert.strictEqual(isDiscoveryRoute("/health"), false);
	});
});

suite("fakeStack/noDiscovery: discovery-attempt counters", () => {
	test("counts each blanked endpoint separately, keyed by bearer token", () => {
		const state = createNoDiscoveryState();
		recordDiscoveryAttempt(state, "/v1/model/info", "Bearer key-a");
		recordDiscoveryAttempt(state, "/v1/models", "Bearer key-a");
		recordDiscoveryAttempt(state, "/v1/models", "Bearer key-a");
		recordDiscoveryAttempt(state, "/v1/models", "Bearer key-b");
		assert.deepStrictEqual(noDiscoveryStats(state), {
			"key-a": { models: 2, modelInfo: 1 },
			"key-b": { models: 1, modelInfo: 0 },
		});
	});

	test("requests without a bearer land under (none); non-discovery routes are ignored", () => {
		const state = createNoDiscoveryState();
		recordDiscoveryAttempt(state, "/v1/models", undefined);
		recordDiscoveryAttempt(state, "/v1/models", "Basic dXNlcg==");
		recordDiscoveryAttempt(state, "/v1/chat/completions", "Bearer key-a");
		assert.deepStrictEqual(noDiscoveryStats(state), { "(none)": { models: 2, modelInfo: 0 } });
	});
});
