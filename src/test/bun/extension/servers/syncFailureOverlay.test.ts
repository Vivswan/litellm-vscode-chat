/**
 * The sync-failure overlay's precedence rules: a sync error outranks the live
 * status (ok or error) while the served count stays the live truth, an
 * upsertFailed entry discovery never saw becomes an error serving nothing
 * (blocked and skipped entries wait for their group's report instead), and
 * entries without a sync error change nothing. The cross-surface vocabulary
 * suites pin what the bar and notifier make of the overlaid window; this
 * suite pins the overlay itself.
 */

import { expect, test } from "bun:test";
import type { DeclaredServerView } from "../../../../extension/servers/serverSync";
import { applySyncFailures, declaredPresentation } from "../../../../extension/servers/syncFailureOverlay";
import { markLogSafe } from "../../../../shared/logger";
import type { ServerStatus } from "../../../../shared/servers";

const NO_SECRETS = { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } as const;

function okStatus(overrides: { serverId: string; servedModelCount: number }): ServerStatus {
	return {
		serverId: overrides.serverId,
		label: overrides.serverId,
		baseUrl: `http://${overrides.serverId}.test`,
		state: "ok",
		servedModelCount: overrides.servedModelCount,
		lastChecked: "2026-08-01T00:00:00.000Z",
		hasApiKey: true,
	};
}

function errorStatus(overrides: { serverId: string; servedModelCount: number; error: string }): ServerStatus {
	return {
		serverId: overrides.serverId,
		label: overrides.serverId,
		baseUrl: `http://${overrides.serverId}.test`,
		state: "error",
		error: overrides.error,
		logSafeError: markLogSafe("RequestError(connection)"),
		classification: { kind: "connection" },
		servedModelCount: overrides.servedModelCount,
		lastChecked: "2026-08-01T00:00:00.000Z",
	};
}

function view(overrides: {
	label: string;
	expectedClientId?: string;
	syncError?: string;
	syncErrorClass?: DeclaredServerView["syncErrorClass"];
}): DeclaredServerView {
	return {
		label: overrides.label,
		baseUrl: `http://${overrides.label}.test`,
		secrets: NO_SECRETS,
		...(overrides.expectedClientId !== undefined ? { expectedClientId: overrides.expectedClientId } : {}),
		...(overrides.syncError !== undefined ? { syncError: overrides.syncError } : {}),
		...(overrides.syncErrorClass !== undefined ? { syncErrorClass: overrides.syncErrorClass } : {}),
	};
}

test("a sync error outranks a live ok status while the served count stays the live truth", () => {
	const live = okStatus({ serverId: "live", servedModelCount: 4 });
	const overlaid = applySyncFailures(
		[live],
		[view({ label: "live", expectedClientId: "live", syncError: "blocked message", syncErrorClass: "blocked" })]
	);
	expect(overlaid.length).toBe(1);
	const status = overlaid[0];
	expect(status?.state).toBe("error");
	expect(status?.error).toBe("blocked message");
	expect(status?.servedModelCount).toBe(4);
	// The log rendering is rebuilt from the failure class alone, never the
	// message: log lines land in public issue reports.
	expect(status?.state === "error" ? String(status.logSafeError) : "").toBe("provider group sync failed (blocked)");
	// The live identity keeps riding: same snapshot, judged with the sync truth.
	expect(status?.serverId).toBe("live");
	expect(status?.baseUrl).toBe("http://live.test");
	expect(status?.lastChecked).toBe(live.lastChecked);
	expect(status?.hasApiKey).toBe(true);
});

test("a sync error outranks a live error's text and drops its classification", () => {
	const live = errorStatus({ serverId: "gw", servedModelCount: 3, error: "boom" });
	const overlaid = applySyncFailures([live], [view({ label: "gw", expectedClientId: "gw", syncError: "sync failed" })]);
	const status = overlaid[0];
	expect(status?.state).toBe("error");
	expect(status?.error).toBe("sync failed");
	expect(status?.servedModelCount).toBe(3);
	// The masked transport error's classification must not advise on a failure
	// the status no longer displays (the dashboard row drops it the same way).
	expect(status !== undefined && "classification" in status && status.classification !== undefined).toBe(false);
});

test("an upsertFailed entry discovery never saw becomes an error serving nothing", () => {
	const overlaid = applySyncFailures(
		[],
		[view({ label: "pending", syncError: "upsert failed", syncErrorClass: "upsertFailed" })]
	);
	expect(overlaid.length).toBe(1);
	const status = overlaid[0];
	expect(status?.state).toBe("error");
	expect(status?.error).toBe("upsert failed");
	expect(status?.servedModelCount).toBe(0);
	expect(status?.label).toBe("pending");
	expect(status?.baseUrl).toBe("http://pending.test");
});

test("a blocked or skipped entry with no live status synthesizes nothing: its group reports later", () => {
	// blocked proves a group with the name EXISTS (the duplicate refusal), and
	// The skip classes mean the pass left live groups serving; a synthesized
	// dead error would race the first discovery report red.
	expect(
		applySyncFailures([], [view({ label: "held", syncError: "name conflict", syncErrorClass: "blocked" })])
	).toEqual([]);
	expect(
		applySyncFailures(
			[],
			[view({ label: "skipped", syncError: "salt unavailable", syncErrorClass: "saltUnavailable" })]
		)
	).toEqual([]);
	expect(
		applySyncFailures(
			[],
			[view({ label: "unread", syncError: "secrets unreadable", syncErrorClass: "secretsUnreadable" })]
		)
	).toEqual([]);
	expect(
		applySyncFailures(
			[],
			[view({ label: "mismatched", syncError: "ownership refused", syncErrorClass: "secretsMismatched" })]
		)
	).toEqual([]);
});

test("claimants sharing one live snapshot overlay it once, keeping the live served count", () => {
	const shared = okStatus({ serverId: "shared", servedModelCount: 3 });
	// Both entries claim the snapshot through the shared connection identity.
	const sharedView = (label: string) => ({
		label,
		baseUrl: "http://shared.test",
		secrets: NO_SECRETS,
		expectedConnectionId: "shared",
		syncError: "blocked message",
		syncErrorClass: "blocked" as const,
	});
	const result = applySyncFailures([shared], [sharedView("Prod"), sharedView("Staging")]);
	expect(result.length).toBe(1);
	expect(result[0]?.state).toBe("error");
	expect(result[0]?.servedModelCount).toBe(3);
});

test("entries without a sync error change nothing: statuses pass through untouched", () => {
	const live = okStatus({ serverId: "live", servedModelCount: 2 });
	// An unchecked healthy entry stays out of the window too, exactly as before.
	const result = applySyncFailures(
		[live],
		[view({ label: "live", expectedClientId: "live" }), view({ label: "fresh" })]
	);
	expect(result).toEqual([live]);
	expect(result[0]).toBe(live);
});

test("an unrelated neighbor passes through by reference beside a sync failure", () => {
	const healthy = okStatus({ serverId: "fine", servedModelCount: 5 });
	const live = okStatus({ serverId: "live", servedModelCount: 1 });
	const result = applySyncFailures(
		[healthy, live],
		[
			view({ label: "fine", expectedClientId: "fine" }),
			view({ label: "live", expectedClientId: "live", syncError: "blocked" }),
		]
	);
	expect(result.length).toBe(2);
	expect(result[0]).toBe(healthy);
	expect(result[1]?.state).toBe("error");
});

test("declaredPresentation owns the precedence: sync error first, then live, then unchecked", () => {
	expect(declaredPresentation({ servedModelCount: 7 }, "blocked")).toEqual({
		kind: "sync-failed",
		servedModelCount: 7,
		error: "blocked",
	});
	expect(declaredPresentation(undefined, "blocked")).toEqual({
		kind: "sync-failed",
		servedModelCount: 0,
		error: "blocked",
	});
	expect(declaredPresentation({ servedModelCount: 7 }, undefined)).toEqual({ kind: "live" });
	expect(declaredPresentation(undefined, undefined)).toEqual({ kind: "unchecked" });
});
