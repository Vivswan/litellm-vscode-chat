import * as assert from "node:assert";
import * as vscode from "vscode";
import type { ServerStatus } from "../../shared/servers";
import { createCaptureServer } from "../capture-server";
import { ensureActivated } from "../hostApiHelpers";
import { expectDefined } from "../testUtils";

/**
 * Group-configuration label round trip, in its own extension host (the
 * host-fidelity-groups label): provider groups are add-only for the host
 * lifetime, so the groups created here serve models until the host exits,
 * and a suite with exact-set model waits could never share this host.
 * Capture-mode only by construction - the probe stands up its own capture
 * server - so the label runs in the plain `bun run test` pass and in the
 * docker orchestration alike.
 */
suite("Host-Fidelity Tests (group label round trip)", () => {
	test("the host hands configuration.label back; same-URL same-key groups keep distinct identities", async function () {
		this.timeout(30000);
		const server = createCaptureServer();
		await server.start();
		try {
			await ensureActivated();
			const base = `litellm-label-probe-${process.pid}`;
			const labels = [`${base}-a`, `${base}-b`] as const;
			for (const label of labels) {
				// Mirrors the declared-entry sync chain (name === label). `label` is
				// the schema-declared configuration property under empirical test:
				// the per-entry identity design rests on the host echoing it back
				// through options.configuration on the per-group refresh.
				await vscode.commands.executeCommand("lm.addLanguageModelsProviderGroup", {
					name: label,
					vendor: "litellm",
					baseUrl: `http://localhost:${server.port}`,
					apiKey: "probe-key",
					label,
				});
			}

			// The host resolves a new group by calling the provider, but ingests
			// asynchronously; poll the status window and nudge with model queries.
			const deadline = Date.now() + 20000;
			let statuses: ServerStatus[] = [];
			while (Date.now() < deadline) {
				statuses = (await vscode.commands.executeCommand("litellm._test.getServerStatuses")) as ServerStatus[];
				if (labels.every((label) => statuses.some((status) => status.label === label))) {
					break;
				}
				await vscode.lm.selectChatModels({ vendor: "litellm" });
				await new Promise((resolve) => setTimeout(resolve, 200));
			}

			const byLabel = new Map(statuses.map((status) => [status.label, status]));
			for (const label of labels) {
				assert.ok(
					byLabel.get(label),
					`the host never handed configuration.label back for "${label}"; the per-entry status identity cannot work. Statuses: ${statuses.map((s) => `${s.label} (${s.serverId})`).join(", ")}`
				);
			}
			const first = expectDefined(byLabel.get(labels[0]));
			const second = expectDefined(byLabel.get(labels[1]));
			assert.notStrictEqual(
				first.serverId,
				second.serverId,
				"two groups sharing one base URL and key must get distinct status identities from their labels"
			);
			assert.strictEqual(first.state, "ok", "the first labeled group must have fetched models");
			assert.strictEqual(second.state, "ok", "the second labeled group must have fetched models");
		} finally {
			await server.close();
		}
	});
});
