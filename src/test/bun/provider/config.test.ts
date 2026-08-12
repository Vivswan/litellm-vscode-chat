import { describe, test } from "bun:test";
import * as assert from "node:assert";
import type { ConfigurationPrompt } from "../../../provider/config";
import { ensureServers, resolveServer } from "../../../provider/config";
import type { ServerWithKey } from "../../../shared/servers";

/**
 * The provider layer's server resolution: chat requests route by serverId
 * (chatClient), refreshes gate on the configured list, and the injected
 * configuration prompt is strictly optional. All pure logic over an injected
 * getServers, so no storage or UI is stubbed.
 */
describe("provider/config", () => {
	function server(id: string, label = id): ServerWithKey {
		return { id, label, baseUrl: `http://${id}.test`, apiKey: "" };
	}

	/** A getServers that counts its calls and serves the given lists in order (last repeats). */
	function servedLists(...lists: ServerWithKey[][]) {
		let calls = 0;
		const getServers = async (): Promise<ServerWithKey[]> => {
			const list = lists[Math.min(calls, lists.length - 1)] ?? [];
			calls += 1;
			return list;
		};
		return { getServers, callCount: () => calls };
	}

	test("resolveServer returns the matching server and undefined for an unknown id", async () => {
		const { getServers } = servedLists([server("a"), server("b")]);
		const found = await resolveServer("b", getServers);
		assert.strictEqual(found?.id, "b");
		// A serverId can outlive its registry entry mid-conversation; the miss
		// must resolve undefined, not route to some other server or crash.
		assert.strictEqual(await resolveServer("gone", getServers), undefined);
	});

	test("ensureServers returns a non-empty list immediately and never invokes the prompt", async () => {
		const { getServers, callCount } = servedLists([server("a")]);
		let prompted = 0;
		const prompt: ConfigurationPrompt = {
			promptToConfigure: async () => {
				prompted += 1;
				return true;
			},
		};
		const servers = await ensureServers(false, getServers, prompt);
		assert.strictEqual(servers?.length, 1);
		assert.strictEqual(prompted, 0, "configured users must not be re-prompted on refresh");
		assert.strictEqual(callCount(), 1);
	});

	test("a silent refresh with no servers resolves undefined without prompting", async () => {
		const { getServers } = servedLists([]);
		let prompted = 0;
		const prompt: ConfigurationPrompt = {
			promptToConfigure: async () => {
				prompted += 1;
				return true;
			},
		};
		assert.strictEqual(await ensureServers(true, getServers, prompt), undefined);
		assert.strictEqual(prompted, 0, "silent refreshes surface no UI");
	});

	test("a non-silent refresh without an injected prompt resolves undefined", async () => {
		// The prompt is optional in the signature and the provider passes it
		// possibly-undefined; this must be a clean miss, not a crash.
		const { getServers } = servedLists([]);
		assert.strictEqual(await ensureServers(false, getServers), undefined);
	});

	test("a completed configuration prompt re-fetches and returns the fresh server list", async () => {
		const { getServers, callCount } = servedLists([], [server("fresh")]);
		const prompt: ConfigurationPrompt = { promptToConfigure: async () => true };
		const servers = await ensureServers(false, getServers, prompt);
		assert.strictEqual(servers?.length, 1);
		assert.strictEqual(servers?.[0]?.id, "fresh", "the post-configuration refetch must serve the new list");
		assert.strictEqual(callCount(), 2, "exactly one refetch after the completed prompt");
	});

	test("a completed prompt that still yields no servers resolves undefined, not an empty success", async () => {
		const { getServers } = servedLists([], []);
		const prompt: ConfigurationPrompt = { promptToConfigure: async () => true };
		const servers = await ensureServers(false, getServers, prompt);
		// [] as a configured result would suppress the not-configured signal downstream.
		assert.strictEqual(servers, undefined);
	});

	test("a dismissed prompt resolves undefined without a second getServers call", async () => {
		const { getServers, callCount } = servedLists([]);
		const prompt: ConfigurationPrompt = { promptToConfigure: async () => false };
		assert.strictEqual(await ensureServers(false, getServers, prompt), undefined);
		assert.strictEqual(callCount(), 1, "cancelling the flow must not trigger a refetch loop");
	});
});
