/**
 * A group's first observation schedules the sync pass that acts on it, whatever identity the group reports under. The
 * status window's entry event drives ServerSyncEngine.requestSync as wiring/servers.ts wires it, and the pass runs the
 * production reconciliation (createServerSyncEnv over a real removal store), so what the pass reads from the window is
 * what the dashboard push and the provider's suppression read.
 */
import * as assert from "node:assert";
import type * as vscode from "vscode";
import type { DashboardState } from "../../../dashboard/viewModels";
import { secretValueHolders } from "../../../extension/dashboard/declaredJoin";
import { buildDashboardState } from "../../../extension/dashboard/state";
import type { TombstoneIdentity } from "../../../extension/servers/groupRemovals";
import { GroupRemovalStore, tombstoneHides } from "../../../extension/servers/groupRemovals";
import { createServerSyncEnv, ServerSyncEngine } from "../../../extension/servers/serverSync";
import { GROUP_UPDATE_UNAVAILABLE_MESSAGE } from "../../../extension/servers/serverSync/engine";
import type { GroupServer } from "../../../provider/catalog/groupModels";
import { groupClientId, groupServerLabel, parseGroupConfiguration } from "../../../provider/catalog/groupModels";
import { StatusWindow } from "../../../provider/catalog/statusWindow";
import { SYNCED_ENTRY_BASE_URLS_KEY } from "../../../shared/config/storageKeys";
import { Logger } from "../../../shared/logger";
import { makeModelInfo } from "../../pureHelpers";
import { fakeFingerprintSaltSession, makeExtensionStorage, makeServerStatus } from "../../testUtils";
import { makeReader } from "../dashboard/stateHelpers";

const H = "http://h.test";
/** The status label an unlabeled group at H reports under: discovery's URL-host fallback. */
const HOST = "h.test";
const SECRET = "s3cret";
const L1_INLINE = { label: "L1", baseUrl: H, auth: { apiKey: SECRET } };
const LAST_CHECKED = "2026-07-26T00:00:00.000Z";
const INLINE_KEY_PROVEN = {
	secrets: { kind: "proven", locations: { apiKey: "settings", oauthClientSecret: "none", virtualKeyValue: "none" } },
};
/** How long a pass the observation schedules may take to land; the engine's debounce is 10 ms. */
const PASS_WINDOW_MS = 500;

/**
 * An add-only host whose serve calls are explicit: addProviderGroup creates the group host-side, and report() is the
 * host handing it to the provider, which records it in the status window the way groupDiscovery does (a tombstoned
 * group reports healthy with no models, flagged hiddenByRemoval).
 */
function makeHost(window: StatusWindow, removals: GroupRemovalStore) {
	const servers = new Map<string, GroupServer>();
	/** Each group's server ID by the name it was added under; the extension never sees the name itself. */
	const names = new Map<string, string>();
	const taken = new Set<string>();
	const attempted: string[] = [];
	const reports: string[] = [];
	const host = {
		taken,
		attempted,
		reports,
		addProviderGroup: async (args: Readonly<Record<string, string>>) => {
			attempted.push(args.name ?? "");
			if (taken.has(args.name ?? "")) {
				throw new Error(`Language model group with name ${args.name} already exists for vendor litellm`);
			}
			const server = parseGroupConfiguration(args)?.server;
			assert.ok(server !== undefined);
			servers.set(groupClientId(server), server);
			names.set(args.name ?? "", groupClientId(server));
		},
		idOf(name: string): string {
			const serverId = names.get(name);
			assert.ok(serverId !== undefined, `no group was added under ${name}`);
			return serverId;
		},
		report(name: string): void {
			const serverId = host.idOf(name);
			const server = servers.get(serverId);
			assert.ok(server !== undefined);
			const label = server.label ?? groupServerLabel(server.baseUrl);
			const hidden = removals.isTombstoned({
				groupId: serverId,
				label,
				entryLabel: server.label,
				baseUrl: server.baseUrl,
			});
			const status = makeServerStatus({
				serverId,
				label,
				baseUrl: server.baseUrl,
				lastChecked: LAST_CHECKED,
				servedModelCount: hidden ? 0 : 1,
				...(hidden ? { hiddenByRemoval: true } : {}),
			});
			assert.ok(status.state === "ok");
			reports.push(name);
			window.record(
				status,
				{ discovered: hidden ? [] : [makeModelInfo({ id: `${name}-model`, name: `${name}-model` })], declared: [] },
				server
			);
		},
		/** The host re-resolving every group it serves, as the provider's model-change notification makes it. */
		reportAgain(): void {
			for (const name of new Set(reports)) {
				host.report(name);
			}
		},
	};
	return host;
}

interface Fixture {
	engine: ServerSyncEngine;
	host: ReturnType<typeof makeHost>;
	removals: GroupRemovalStore;
	passes: number;
	declare(value: unknown): void;
	/** Whether a pass completes within the window; registered before the trigger, so a pass cannot slip by. */
	nextPassWithin(ms: number): Promise<boolean>;
	/** The state push as the panel assembles it over the window's snapshots and the engine's views. */
	pushedState(): DashboardState;
}

function makeFixture(initialMemento?: Record<string, unknown>): Fixture {
	const storage = makeExtensionStorage(initialMemento);
	const salt = fakeFingerprintSaltSession("durable");
	const removals = new GroupRemovalStore(storage.memento, salt);
	const context = { globalState: storage.memento, secrets: storage.secrets } as unknown as vscode.ExtensionContext;
	const logger = new Logger({ info: () => {}, error: () => {} });
	let setting: unknown = [];
	// The one subscription the production wiring makes on the window's entry event.
	const window = new StatusWindow(
		() => Date.now(),
		() => 10 * 60_000,
		() => fixture.engine.requestSync()
	);
	const host = makeHost(window, removals);
	// A tombstone change makes the host re-resolve its groups (wiring/dashboard.ts).
	removals.onDidChange = () => host.reportAgain();
	const engine = new ServerSyncEngine(
		{
			...createServerSyncEnv(
				context,
				logger,
				salt,
				removals,
				(label) => window.observedGroupBaseUrls(label),
				() => window.snapshots()
			),
			readServersSetting: () => setting,
			addProviderGroup: host.addProviderGroup,
		},
		10
	);
	const observed = (tombstone: TombstoneIdentity) =>
		window.snapshots().some((snapshot) =>
			tombstoneHides(tombstone, {
				groupId: snapshot.status.serverId,
				label: snapshot.status.label,
				entryLabel: snapshot.entryLabel,
				baseUrl: snapshot.status.baseUrl,
			})
		);
	const fixture: Fixture = {
		engine,
		host,
		removals,
		passes: 0,
		declare: (value) => {
			setting = structuredClone(value);
		},
		nextPassWithin: (ms) =>
			new Promise<boolean>((resolve) => {
				const subscription = engine.onDidSync(() => {
					subscription.dispose();
					resolve(true);
				});
				setTimeout(() => {
					subscription.dispose();
					resolve(false);
				}, ms);
			}),
		pushedState: () =>
			buildDashboardState({
				snapshots: window.snapshots(),
				reader: makeReader({}),
				declared: { source: "engine", views: engine.getDeclared() },
				removedGroups: { tombstones: removals.tombstones(), origins: [] },
				wasGroupObserved: observed,
				secretHolders: secretValueHolders(
					window.snapshots(),
					(serverId) => window.getGroupServer(serverId),
					engine.getSecretValues()
				),
			}),
	};
	engine.onDidSync(() => {
		fixture.passes += 1;
	});
	return fixture;
}

suite("extension/servers the observation event schedules the pass that acts on the group", () => {
	test("a re-declared unstamped group clears in the pass its first observation schedules, not the next", async () => {
		const fixture = makeFixture();
		const { engine, host, removals } = fixture;
		try {
			// L1's group from before labels flowed into configurations: no stamp, the key baked in, labeled by host.
			await host.addProviderGroup({ name: "L1", vendor: "litellm", baseUrl: H, apiKey: SECRET });
			const groupId = host.idOf("L1");
			// The user hid it from the dashboard as an external row: a tombstone by its client ID.
			await removals.addTombstone({ by: "group", groupId, label: HOST, baseUrl: H });
			// Then declared L1 again with the same key; the add-only host still holds the name.
			host.taken.add("L1");
			fixture.declare([L1_INLINE]);
			await engine.syncNow();
			assert.strictEqual(fixture.passes, 1);
			assert.deepStrictEqual(
				removals.tombstones(),
				[{ by: "group", groupId, label: HOST, baseUrl: H }],
				"nothing observed, so no group joined the entry and the tombstone stands"
			);
			assert.deepStrictEqual(fixture.pushedState().servers, [
				{
					baseUrl: H,
					config: INLINE_KEY_PROVEN,
					credentials: "present",
					error: GROUP_UPDATE_UNAVAILABLE_MESSAGE,
					hasOAuth: false,
					label: "L1",
					lastChecked: undefined,
					origin: "declared",
					servedModelCount: 0,
					state: "error",
				},
			]);

			const hostCalls = host.attempted.length;
			const scheduled = fixture.nextPassWithin(PASS_WINDOW_MS);
			host.report("L1");
			assert.deepStrictEqual(
				fixture.pushedState().hiddenGroups,
				[{ label: HOST, baseUrl: H, reason: "removed" }],
				"the first serve is suppressed: the group is hidden and offered for unhide"
			);
			assert.strictEqual(await scheduled, true, "the observation itself schedules the pass");
			assert.strictEqual(fixture.passes, 2);
			assert.deepStrictEqual(
				removals.tombstones(),
				[],
				"that pass joined the group to L1 by connection ID and cleared it"
			);
			assert.strictEqual(host.attempted.length, hostCalls, "the blocked entry is not retried against the host");
			assert.deepStrictEqual(host.reports, ["L1", "L1"], "the clear made the host re-resolve the group");
			const after = fixture.pushedState();
			assert.deepStrictEqual(after.hiddenGroups, []);
			// The add-only host still holds the name, so the row keeps the remove-and-resync line; what the clear
			// changed is that the group serves again, under L1 (joined by connection ID, so L1's own entry fields are
			// flagged inactive).
			assert.deepStrictEqual(after.servers, [
				{
					baseUrl: H,
					config: INLINE_KEY_PROVEN,
					credentials: "present",
					entryFieldsInactive: true,
					error: GROUP_UPDATE_UNAVAILABLE_MESSAGE,
					hasOAuth: false,
					label: "L1",
					lastChecked: Date.parse(LAST_CHECKED),
					origin: "declared",
					servedModelCount: 1,
					state: "error",
				},
			]);
			assert.deepStrictEqual(
				after.models.map((model) => model.id),
				["L1-model"]
			);
		} finally {
			engine.dispose();
		}
	});

	test("an unstamped group the host reports only after its entry's removal is hidden on that first observation", async () => {
		// An older build synced L1 (the ledger knows its URL) and left a pre-label group the host has not reported
		// yet. The user removes L1 before the host does: the removal must retain the keys that group will carry.
		const fixture = makeFixture({ [SYNCED_ENTRY_BASE_URLS_KEY]: { L1: H } });
		const { engine, host, removals } = fixture;
		try {
			await host.addProviderGroup({ name: "L1", vendor: "litellm", baseUrl: H, apiKey: SECRET });
			host.taken.add("L1");
			fixture.declare([L1_INLINE]);
			await engine.syncNow();
			fixture.declare([]);
			await engine.syncNow();
			assert.deepStrictEqual(
				removals.tombstones().map((record) => record.by),
				["entry", "group", "group"],
				"the removal retains L1's client and connection IDs beside its entry record"
			);

			host.report("L1");
			assert.deepStrictEqual(
				fixture.pushedState().hiddenGroups,
				[{ label: "L1", baseUrl: H, reason: "removed" }],
				"hidden on the first report, by the connection ID the pre-label group carries, under the removed label"
			);
			assert.deepStrictEqual(fixture.pushedState().models, []);
		} finally {
			engine.dispose();
		}
	});

	test("a labeled group's first observation schedules one pass, as before", async () => {
		const fixture = makeFixture();
		const { engine, host } = fixture;
		try {
			fixture.declare([L1_INLINE]);
			await engine.syncNow();
			assert.deepStrictEqual(host.attempted, ["L1"], "the add landed; the host has not served the group yet");
			assert.strictEqual(fixture.passes, 1);

			const scheduled = fixture.nextPassWithin(PASS_WINDOW_MS);
			host.report("L1");
			assert.strictEqual(await scheduled, true);
			assert.strictEqual(fixture.passes, 2);
			assert.deepStrictEqual(host.attempted, ["L1"], "the in-sync entry makes no host call");
			assert.deepStrictEqual(fixture.pushedState().servers, [
				{
					baseUrl: H,
					config: INLINE_KEY_PROVEN,
					credentials: "present",
					hasOAuth: false,
					label: "L1",
					lastChecked: Date.parse(LAST_CHECKED),
					origin: "declared",
					servedModelCount: 1,
					state: "ok",
				},
			]);
		} finally {
			engine.dispose();
		}
	});
});
