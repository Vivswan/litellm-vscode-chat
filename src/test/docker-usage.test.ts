import * as assert from "node:assert";
import { USAGE_SEED_KEY } from "./fakeStack/usage";

/**
 * Usage/budget smoke suite: pins that the postgres-backed stack serves LiteLLM's spend endpoints with the
 * seeded fixture key's shape. Raw fetch, no extension host machinery: what is under test is the STACK.
 * Run via `bun run test:docker --only docker-usage`.
 */

const BASE_URL = process.env.LITELLM_DOCKER_BASE_URL || "";

suite("Docker usage/budget stack smoke", () => {
	if (!BASE_URL) {
		test("SKIPPED: LITELLM_DOCKER_BASE_URL not set; run via `bun run test:docker`", () => {});
		return;
	}

	/** The seeded key asking about itself, exactly as the extension will. */
	const asSeededKey = { headers: { Authorization: `Bearer ${USAGE_SEED_KEY.key}` } };

	test("/key/info answers the seeded key with its own spend and budget", async () => {
		const response = await fetch(`${BASE_URL}/key/info`, asSeededKey);
		assert.ok(response.ok, `GET /key/info failed: ${response.status}`);
		const { info } = (await response.json()) as { info?: Record<string, unknown> };
		const record = info ?? {};
		assert.strictEqual(record.key_alias, USAGE_SEED_KEY.alias, "the record is the seeded key's own");
		assert.strictEqual(record.max_budget, USAGE_SEED_KEY.maxBudget, "max_budget carries the seeded budget");
		assert.strictEqual(typeof record.spend, "number", "spend is a number from the first fetch on");
		assert.ok((record.spend as number) >= 0, `spend is non-negative, got ${record.spend}`);
		assert.ok(
			typeof record.budget_reset_at === "string" && record.budget_reset_at.length > 0,
			`the seeded budget_duration yields a reset timestamp, got ${JSON.stringify(record.budget_reset_at)}`
		);
	});

	test("/user/daily/activity answers the seeded key", async () => {
		// v1.93 requires an explicit date window (HTTP 400 without one); a
		// +/- one day bracket around now is timezone-proof.
		const isoDay = (unixMs: number): string => new Date(unixMs).toISOString().slice(0, 10);
		const dayMs = 24 * 60 * 60 * 1000;
		const window = `start_date=${isoDay(Date.now() - dayMs)}&end_date=${isoDay(Date.now() + dayMs)}`;
		const response = await fetch(`${BASE_URL}/user/daily/activity?${window}`, asSeededKey);
		assert.ok(response.ok, `GET /user/daily/activity failed: ${response.status}`);
		const body = (await response.json()) as { results?: unknown; metadata?: unknown };
		assert.ok(Array.isArray(body.results), "daily activity carries a results array");
		assert.ok(body.metadata !== null && typeof body.metadata === "object", "daily activity carries metadata");
	});
});
