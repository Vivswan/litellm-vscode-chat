// scripts/stack/seedUsage.ts
//
// Deterministic, idempotent seeding of the stack's usage/budget fixture: one
// virtual key with a max_budget, so LiteLLM's DB-backed spend endpoints have
// something to report. Both stack-starting paths run it after the containers
// are healthy, so a restarted stack always carries the key. The key's identity
// lives in src/test/fakeStack/usage.ts, shared with the docker-usage suite.

import { USAGE_SEED_KEY } from "../../src/test/fakeStack/usage";
import { composeSetting, readEnvFile, STACK_DEFAULTS } from "./litellmConfig";

const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 1_000;

/**
 * Wait for the proxy to answer its liveliness probe. Both callers start the
 * stack with compose --wait, so this normally returns on the first probe; it
 * exists for `up -d` without --wait and for the window where compose reports
 * healthy before a connection is accepted.
 */
async function waitForProxy(baseUrl: string): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	for (;;) {
		try {
			const response = await fetch(`${baseUrl}/health/liveliness`, { signal: AbortSignal.timeout(READY_POLL_MS) });
			if (response.ok) {
				return;
			}
		} catch {
			// Not up yet; keep polling until the deadline.
		}
		if (Date.now() >= deadline) {
			throw new Error(`LiteLLM at ${baseUrl} did not answer /health/liveliness within ${READY_TIMEOUT_MS}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
	}
}

async function callAdmin(baseUrl: string, masterKey: string, route: string, body: object): Promise<void> {
	const response = await fetch(`${baseUrl}${route}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${masterKey}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(`POST ${route} failed: HTTP ${response.status} ${await response.text()}`);
	}
}

/**
 * Ensure the seeded budget key exists with its declared fields. The existence
 * probe runs as the master key, so a transient proxy failure surfaces as an
 * error instead of masquerading as "missing" and driving /key/generate into a
 * duplicate. A key surviving an earlier start has every declared field
 * re-pinned - identity included, so a reused dev database cannot drift - but
 * never its accumulated spend: the budget is deterministic, the spend is the
 * data under test.
 */
export async function seedUsageBudgetKey(baseUrl: string, masterKey: string): Promise<void> {
	await waitForProxy(baseUrl);
	const declaredFields = {
		key_alias: USAGE_SEED_KEY.alias,
		user_id: USAGE_SEED_KEY.userId,
		max_budget: USAGE_SEED_KEY.maxBudget,
		budget_duration: USAGE_SEED_KEY.budgetDuration,
	};
	const probe = await fetch(`${baseUrl}/key/info?key=${encodeURIComponent(USAGE_SEED_KEY.key)}`, {
		headers: { Authorization: `Bearer ${masterKey}` },
	});
	if (probe.ok) {
		await callAdmin(baseUrl, masterKey, "/key/update", { key: USAGE_SEED_KEY.key, ...declaredFields });
		return;
	}
	// v1.93 answers a missing key with HTTP 404; tolerate the 400 some
	// versions use for "key not found" too. Anything else is a real failure,
	// not absence.
	if (probe.status !== 400 && probe.status !== 404) {
		throw new Error(`GET /key/info probe failed: HTTP ${probe.status} ${await probe.text()}`);
	}
	await callAdmin(baseUrl, masterKey, "/key/generate", { key: USAGE_SEED_KEY.key, ...declaredFields });
}

/**
 * seedUsageBudgetKey against the running compose stack, resolving the port and
 * master key exactly as compose does (shell env over .env over the defaults).
 */
export async function seedStackUsageBudgetKey(): Promise<void> {
	const envFile = readEnvFile();
	const port = composeSetting("LITELLM_PORT", STACK_DEFAULTS.LITELLM_PORT, envFile);
	const masterKey = composeSetting("LITELLM_MASTER_KEY", STACK_DEFAULTS.LITELLM_MASTER_KEY, envFile);
	await seedUsageBudgetKey(`http://localhost:${port}`, masterKey);
}
