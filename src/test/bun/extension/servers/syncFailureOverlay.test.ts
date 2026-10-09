/**
 * The sync-failure overlay's precedence rules: a sync error outranks the live status (ok or error) while the served
 * count stays the live truth, an entry discovery never saw becomes an error serving nothing whatever its failure
 * class, and entries without a sync error change nothing. The cross-surface vocabulary suites pin what the bar and
 * notifier make of the overlaid window; this suite pins the overlay itself.
 */

import { expect, test } from "bun:test";
import { classifyOverall } from "../../../../dashboard/presenters";
import type { DeclaredServerView } from "../../../../extension/servers/serverSync/engine";
import {
	applySyncFailures,
	declaredPresentation,
	ServerVerdict,
} from "../../../../extension/servers/syncFailureOverlay";
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

function errorStatus(overrides: { serverId: string; servedModelCount: number }): ServerStatus {
	return {
		serverId: overrides.serverId,
		label: overrides.serverId,
		baseUrl: `http://${overrides.serverId}.test`,
		state: "error",
		cause: { kind: "transport", classification: { kind: "connection" } },
		logSafeError: markLogSafe("RequestError(connection)"),
		servedModelCount: overrides.servedModelCount,
		lastChecked: "2026-08-01T00:00:00.000Z",
	};
}

function view(overrides: {
	label: string;
	expectedClientId?: string;
	syncFailure?: DeclaredServerView["syncFailure"];
}): DeclaredServerView {
	return {
		label: overrides.label,
		baseUrl: `http://${overrides.label}.test`,
		secrets: NO_SECRETS,
		...(overrides.expectedClientId !== undefined ? { expectedClientId: overrides.expectedClientId } : {}),
		...(overrides.syncFailure !== undefined ? { syncFailure: overrides.syncFailure } : {}),
	};
}

test("a sync failure outranks a live ok status while the served count stays the live truth", () => {
	// A virtual-key-only group: the kind must survive the rebuild beside the presence, or the persisted status and the
	// diagnostics read a static API key while the row shows Virtual key.
	const live: ServerStatus = {
		...okStatus({ serverId: "live", servedModelCount: 4 }),
		hasOAuth: false,
		hasVirtualKey: true,
	};
	const overlaid = applySyncFailures(
		[live],
		[view({ label: "live", expectedClientId: "live", syncFailure: { class: "blocked" } })]
	);
	expect(overlaid.length).toBe(1);
	const status = overlaid[0];
	expect(status?.state).toBe("error");
	expect(status?.state === "error" ? status.cause : undefined).toEqual({ kind: "sync", failureClass: "blocked" });
	expect(status?.servedModelCount).toBe(4);
	// The log rendering is the failure class alone: log lines land in public issue reports.
	expect(status?.state === "error" ? String(status.logSafeError) : "").toBe("provider group sync failed (blocked)");
	expect(status?.serverId).toBe("live");
	expect(status?.baseUrl).toBe("http://live.test");
	expect(status?.lastChecked).toBe(live.lastChecked);
	expect(status?.hasApiKey).toBe(true);
	expect(status?.hasOAuth).toBe(false);
	expect(status?.hasVirtualKey).toBe(true);
});

test("a sync failure outranks a live error's cause, transport classification included", () => {
	const live = errorStatus({ serverId: "gw", servedModelCount: 3 });
	const overlaid = applySyncFailures(
		[live],
		[view({ label: "gw", expectedClientId: "gw", syncFailure: { class: "blocked" } })]
	);
	const status = overlaid[0];
	expect(status?.state).toBe("error");
	// The masked transport cause must not advise on a failure the status no longer displays (the dashboard row drops
	// it the same way): the sync cause replaces it whole.
	expect(status?.state === "error" ? status.cause : undefined).toEqual({ kind: "sync", failureClass: "blocked" });
	expect(status?.servedModelCount).toBe(3);
});

test("an upsertFailed entry discovery never saw becomes an error serving nothing", () => {
	const overlaid = applySyncFailures([], [view({ label: "pending", syncFailure: { class: "upsertFailed" } })]);
	expect(overlaid.length).toBe(1);
	const status = overlaid[0];
	expect(status?.state).toBe("error");
	expect(status?.state === "error" ? status.cause : undefined).toEqual({ kind: "sync", failureClass: "upsertFailed" });
	expect(status?.servedModelCount).toBe(0);
	expect(status?.label).toBe("pending");
	expect(status?.baseUrl).toBe("http://pending.test");
});

test("a blocked or skipped entry with no live status is the dashboard's row: an error serving nothing", () => {
	// The bar and the hero read one row set: an entry no report reached is the error row the dashboard draws, and a
	// live group reporting later is overlaid as the same error.
	for (const failureClass of ["blocked", "saltUnavailable", "secretsUnreadable", "secretsMismatched"] as const) {
		const overlaid = applySyncFailures([], [view({ label: "held", syncFailure: { class: failureClass } })]);
		expect(overlaid.length, failureClass).toBe(1);
		const held = overlaid[0];
		expect(held?.state, failureClass).toBe("error");
		expect(held?.state === "error" ? held.cause : undefined, failureClass).toEqual({ kind: "sync", failureClass });
		expect(overlaid[0]?.servedModelCount, failureClass).toBe(0);
		expect(overlaid[0]?.label, failureClass).toBe("held");
	}
});

test("the owner's verdict rows carry a declared entry awaiting its first report as unchecked, beside the overlaid statuses", () => {
	// classifyOverall reads these for the bar, the notifier, and the hero: one awaiting entry beside one failed entry
	// is degraded, not the error a failure-only set would give.
	const rows = new ServerVerdict({
		statuses: () => [],
		declared: () => ({
			source: "engine",
			views: [view({ label: "fresh" }), view({ label: "unread", syncFailure: { class: "secretsUnreadable" } })],
		}),
		entryReports: () => [],
	}).rows();
	expect(rows).toEqual([
		{
			state: "error",
			servedModelCount: 0,
			failure: { cause: { kind: "sync", failureClass: "secretsUnreadable" }, baseUrl: "http://unread.test" },
		},
		{ state: "unchecked", servedModelCount: 0 },
	]);
	expect(classifyOverall(rows)).toBe("degraded");
});

test("claimants sharing one live snapshot overlay it once, keeping the live served count", () => {
	const shared = okStatus({ serverId: "shared", servedModelCount: 3 });
	const sharedView = (label: string) => ({
		label,
		baseUrl: "http://shared.test",
		secrets: NO_SECRETS,
		expectedConnectionId: "shared",
		syncFailure: { class: "blocked" } as const,
	});
	const result = applySyncFailures([shared], [sharedView("Prod"), sharedView("Staging")]);
	expect(result.length).toBe(1);
	expect(result[0]?.state).toBe("error");
	expect(result[0]?.servedModelCount).toBe(3);
});

test("entries without a sync failure change nothing: statuses pass through untouched", () => {
	const live = okStatus({ serverId: "live", servedModelCount: 2 });
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
			view({ label: "live", expectedClientId: "live", syncFailure: { class: "blocked" } }),
		]
	);
	expect(result.length).toBe(2);
	expect(result[0]).toBe(healthy);
	expect(result[1]?.state).toBe("error");
});

test("declaredPresentation owns the precedence: sync failure first, then live, then unchecked", () => {
	const failure = { class: "blocked" } as const;
	expect(declaredPresentation({ servedModelCount: 7 }, failure)).toEqual({
		kind: "sync-failed",
		servedModelCount: 7,
		failure,
	});
	expect(declaredPresentation(undefined, failure)).toEqual({
		kind: "sync-failed",
		servedModelCount: 0,
		failure,
	});
	expect(declaredPresentation({ servedModelCount: 7 }, undefined)).toEqual({ kind: "live" });
	expect(declaredPresentation(undefined, undefined)).toEqual({ kind: "unchecked" });
});
