import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import type * as vscode from "vscode";
import type { UsageConnection } from "../../../../extension/servers/usage/spendClient";
import { createUsagePollerEnv } from "../../../../extension/servers/usage/vscodeEnv";
import { MIN_TIMEOUT_MS } from "../../../../shared/config/settingSpec";
import { fixedHeaderValue } from "../../../../shared/util/headers";
import { mswServer, TEST_BASE_URL, useMsw } from "../../../mocks/handlers";
import { makeLogger } from "../../../pureHelpers";
import { withConfig } from "../../../testUtils";

/** The env reads secrets only inside a poll; this suite never starts one. */
const UNUSED_CONTEXT = {
	secrets: {
		get: async () => undefined,
		store: async () => {},
		delete: async () => {},
		onDidChange: () => ({ dispose() {} }),
	},
} as unknown as vscode.ExtensionContext;

/** The connection every usage fetch in the suite is made with. */
const CONNECTION: UsageConnection = {
	label: "alpha",
	baseUrl: TEST_BASE_URL,
	apiKey: fixedHeaderValue("sk-test"),
	headers: {},
};

suite("extension/servers/usage vscodeEnv", () => {
	useMsw();

	test("an invalid setting warns once for the session, however many reads the client and the poller make", async () => {
		// The warnings land in the bounded log behind the public issue report, and the client reads discovery.timeout
		// on every usage GET: a repeated warning evicts the entries the report exists to carry.
		mswServer.use(http.get(`${TEST_BASE_URL}/key/info`, () => HttpResponse.json({ info: { spend: 1 } })));
		const { logger, lines } = makeLogger();
		const env = createUsagePollerEnv(UNUSED_CONTEXT, logger, fixedHeaderValue("test-agent"));

		await withConfig({ "discovery.timeout": MIN_TIMEOUT_MS - 1, "usage.pollInterval": 1 }, async () => {
			await env.client.fetchKeyInfo(CONNECTION);
			await env.client.fetchKeyInfo(CONNECTION);
			env.pollIntervalMs();
			env.pollIntervalMs();
		});

		const warned = (key: string) => lines.filter((line) => line.includes(`${key} must be a whole number`)).length;
		assert.deepStrictEqual(
			{ discoveryTimeout: warned("discovery.timeout"), pollInterval: warned("usage.pollInterval") },
			{ discoveryTimeout: 1, pollInterval: 1 }
		);
	});
});
