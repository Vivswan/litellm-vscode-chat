import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { markLogSafe } from "../../../shared/logger";
import type { ServerStatus } from "../../../shared/servers";
import { unexpectedFailureCount, unexpectedServerFailures } from "../../../shared/servers";

/**
 * The shared unexpected-failure reading behind every "N servers unreachable"
 * count and failure verdict: a failure the entry's expectedFailures declares is
 * configured as normal and never counts.
 */

function ok(serverId: string, servedModelCount = 3): ServerStatus {
	return {
		serverId,
		label: serverId,
		baseUrl: `http://${serverId}.test`,
		state: "ok",
		servedModelCount,
		lastChecked: "2026-07-26T00:00:00.000Z",
	};
}

function failure(serverId: string, overrides: { expected?: boolean; declaredModelCount?: number } = {}): ServerStatus {
	return {
		serverId,
		label: serverId,
		baseUrl: `http://${serverId}.test`,
		state: "error",
		error: "boom",
		logSafeError: markLogSafe("RequestError(connection)"),
		servedModelCount: overrides.declaredModelCount ?? 0,
		...(overrides.expected !== undefined ? { expected: overrides.expected } : {}),
		...(overrides.declaredModelCount !== undefined ? { declaredModelCount: overrides.declaredModelCount } : {}),
		lastChecked: "2026-07-26T00:00:00.000Z",
	};
}

describe("shared/servers unexpected failures", () => {
	test("an expected failure never counts; an unexpected one always does", () => {
		// The exact mix that once diverged across surfaces: one expected + one
		// real failure must count 1, never 2.
		const window = [ok("srv1"), failure("srv2"), failure("srv3", { expected: true })];
		assert.strictEqual(unexpectedFailureCount(window), 1);
		assert.deepStrictEqual(
			unexpectedServerFailures(window).map((status) => status.serverId),
			["srv2"]
		);
	});

	test("an absent expected flag reads as unexpected", () => {
		assert.strictEqual(unexpectedFailureCount([failure("srv1")]), 1);
	});

	test("declared models do not excuse an unexpected failure", () => {
		// Serving declared models changes the verdict's serving side, never the
		// failure side: the server is still unreachable.
		assert.strictEqual(unexpectedFailureCount([failure("srv1", { declaredModelCount: 2 })]), 1);
	});

	test("healthy and expected-only windows count zero", () => {
		assert.strictEqual(unexpectedFailureCount([]), 0);
		assert.strictEqual(unexpectedFailureCount([ok("srv1"), ok("srv2")]), 0);
		assert.strictEqual(unexpectedFailureCount([failure("srv1", { expected: true })]), 0);
	});
});
