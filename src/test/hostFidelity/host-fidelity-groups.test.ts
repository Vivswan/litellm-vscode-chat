import * as assert from "node:assert";
import * as vscode from "vscode";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import { createCaptureServer } from "../capture-server";
import {
	addGroup,
	refreshEntryModels,
	removeServerEntry,
	scopedExact,
	uniqueName,
	waitForGroupStatus,
	waitForModels,
	writeServerEntry,
} from "../groupApiHelpers";
import { catalogOff, ensureActivated } from "../hostApiHelpers";
import { expectDefined } from "../pureHelpers";

/**
 * Provider-group semantics probes, in their own extension host: groups are
 * add-only for the host lifetime, so the groups created here serve models until
 * the host exits and a suite with exact-set model waits could never share it.
 * Capture-mode only by construction - every probe stands up its own capture
 * server - so the label runs in `bun run test` and the docker orchestration
 * alike.
 */
suite("Host-Fidelity Tests (provider group semantics)", () => {
	// writeServerEntry edits the real machine-scoped servers setting; restore
	// it even when a test dies between its write and its finally.
	let originalServersSetting: unknown;

	suiteSetup(async () => {
		await ensureActivated();
		await catalogOff();
		originalServersSetting = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(SERVERS_SETTING_KEY);
	});

	suiteTeardown(async () => {
		await vscode.workspace
			.getConfiguration(CONFIG_SECTION)
			.update(SERVERS_SETTING_KEY, originalServersSetting, vscode.ConfigurationTarget.Global);
	});

	test("the host hands configuration.label back; same-URL same-key groups keep distinct identities", async function () {
		// Above the sum of the poll budgets below, so a slow host fails inside
		// a helper's descriptive timeout instead of Mocha's bare one.
		this.timeout(60000);
		const server = createCaptureServer();
		await server.start();
		try {
			const labels = [uniqueName("litellm-label-probe-a"), uniqueName("litellm-label-probe-b")] as const;
			for (const label of labels) {
				// `label` is the schema-declared configuration property under
				// empirical test: the per-entry identity design rests on the host
				// echoing it back through options.configuration on each refresh.
				await addGroup({ name: label, baseUrl: `http://localhost:${server.port}`, apiKey: "probe-key" });
			}

			const first = await waitForGroupStatus(labels[0], (status) => status.state === "ok", 20000);
			const second = await waitForGroupStatus(labels[1], (status) => status.state === "ok", 20000);
			assert.notStrictEqual(
				first.serverId,
				second.serverId,
				"two groups sharing one base URL and key must get distinct status identities from their labels"
			);
		} finally {
			await server.close();
		}
	});

	test("two groups serving one raw model id surface as indistinguishable twin picker entries", async function () {
		// Above the sum of the poll budgets below (see the first test).
		this.timeout(90000);
		const sharedId = uniqueName("openai/shared-probe");
		const serverA = createCaptureServer({ modelId: sharedId });
		const serverB = createCaptureServer({ modelId: sharedId });
		await serverA.start();
		await serverB.start();
		try {
			const nameA = uniqueName("litellm-dup-id-a");
			const nameB = uniqueName("litellm-dup-id-b");
			await addGroup({ name: nameA, baseUrl: `http://localhost:${serverA.port}`, apiKey: "probe-key" });
			await addGroup({ name: nameB, baseUrl: `http://localhost:${serverB.port}`, apiKey: "probe-key" });
			await waitForGroupStatus(nameA, (status) => status.state === "ok", 20000);
			await waitForGroupStatus(nameB, (status) => status.state === "ok", 20000);

			const inUniverse = (model: vscode.LanguageModelChat) => model.id === sharedId;
			// The host does NOT dedupe across groups: both groups' entries land in
			// the picker, and the exact-set wait counts duplicates.
			const models = await waitForModels(
				scopedExact(inUniverse, [sharedId, sharedId]),
				20000,
				`two model entries with id "${sharedId}" (one per group)`
			);
			const twins = models.filter(inUniverse);
			assert.strictEqual(twins.length, 2);
			const firstTwin = expectDefined(twins[0]);
			const secondTwin = expectDefined(twins[1]);
			// The twins are indistinguishable through vscode.lm: the host namespaces
			// models by group internally but exposes none of that on the API object.
			// Design consequence: a suite can attribute a model to the group that
			// served it ONLY through a model ID unique to that group, so group-driven
			// suites must mint per-group model IDs.
			for (const field of ["id", "name", "family", "version", "vendor"] as const) {
				assert.strictEqual(
					firstTwin[field],
					secondTwin[field],
					`the host exposes no group identity; expected identical "${field}" fields on the twin entries`
				);
			}
		} finally {
			await serverA.close();
			await serverB.close();
		}
	});

	test("litellm._test.refreshEntryModels drives the real group path for a declared entry", async function () {
		// Above the sum of the poll budgets below (see the first test).
		this.timeout(120000);
		const modelId = uniqueName("openai/refresh-entry-probe");
		const label = uniqueName("litellm-refresh-entry");
		// A value with no legitimate reason to appear anywhere in the seam's
		// output; the leak assertions below scan for it.
		const secretSentinel = `sk-refresh-entry-sentinel-${process.pid}`;
		const server = createCaptureServer({ modelId });
		await server.start();
		try {
			await writeServerEntry({
				label,
				baseUrl: `http://localhost:${server.port}`,
			});
			// The wait carries the condition itself: writeServerEntry settles on the
			// FIRST recorded status, which may predate discovery completion.
			await waitForGroupStatus(label, (status) => status.state === "ok", 20000);
			// The entry declares no inline auth, so the seam's configuration can
			// resolve an apiKey only through the engine's SecretStorage read.
			await vscode.commands.executeCommand("litellm._test.setServerSecret", label, "apiKey", secretSentinel);

			const infos = await refreshEntryModels(label);
			const info = infos.find((candidate) => candidate.id === modelId);
			assert.ok(
				info,
				`refreshEntryModels must return the entry's discovered model; got: ${infos.map((i) => i.id).join(", ")}`
			);
			// Registration metadata comes from the capture fixture through the real
			// group path: discovery, capability resolution, registration.
			assert.strictEqual(info.maxOutputTokens, 12000);
			assert.strictEqual(info.family, "openai");
			// The stored key was CONSUMED, not merely tolerated: the fixture does
			// not authenticate, so only the wire proves the secrets read happened.
			assert.ok(
				server.getSeenAuthorizations().includes(`Bearer ${secretSentinel}`),
				"the seam's discovery must carry the SecretStorage-resolved key"
			);
			assert.ok(!("litellm" in info), "the seam must strip the credential-carrying transport attachment");
			assert.ok(
				!JSON.stringify(infos).includes(secretSentinel),
				"the resolved secret must never ride the seam's result"
			);
			const logs = (await vscode.commands.executeCommand("litellm._test.getSessionLogs", 0)) as {
				lines: string[];
				dropped: number;
			};
			assert.strictEqual(logs.dropped, 0, "an evicted line would make the leak scan below vacuous");
			assert.ok(
				logs.lines.every((line) => !line.includes(secretSentinel)),
				"the resolved secret must never reach the log path"
			);

			await assert.rejects(
				async () => refreshEntryModels(uniqueName("litellm-absent")),
				/No declared server entry/,
				"an unknown label must fail loudly, not return an empty list"
			);
		} finally {
			await vscode.commands.executeCommand("litellm._test.setServerSecret", label, "apiKey", undefined);
			await removeServerEntry(label);
			await server.close();
		}
	});
});
