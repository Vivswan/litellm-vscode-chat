// scripts/dev/seedDemoUsage.ts
//
// Dev-only demonstration spend: three virtual keys in visibly different
// budget states, so `bun run dev` opens on a populated Usage tab and a
// warning/error status bar item. The dev launcher is the only caller - the
// docker test orchestrator and docker:up never touch these keys, and the
// test fixture key (src/test/fakeStack/usage.ts) is never touched here.
//
// The spend is real: each key fires a handful of deterministic streaming
// completions (the fake stack's %text command, include_usage on) through the
// proxy, LiteLLM prices them off the generated config, and once the async
// spend flush lands the key's max_budget is pinned to a fraction of the
// measured spend so the card shows the intended percentage. Reruns add spend
// (spend IS the demo) and re-pin the budgets to the same fractions, so the
// states hold; a stack recreate starts from zero (tmpfs database) and the
// next dev run rebuilds them.

/** One demo key's identity and target budget state. Every value is a deliberately obvious local fixture. */
export interface DemoUsageKeySpec {
	/** The literal bearer token; /key/generate accepts a caller-chosen value. */
	readonly key: string;
	/** key_alias: how the key shows up in LiteLLM's own bookkeeping. */
	readonly alias: string;
	/** user_id: gives /user/daily/activity a user to aggregate under. */
	readonly userId: string;
	/** The servers-setting entry label the dev seed declares for this key. */
	readonly label: string;
	/** The spend fraction the KEY's max_budget is pinned to produce (spend / budget). */
	readonly keyBudgetRatio: number;
	/**
	 * When set, the seeded entry carries a manual `budget` pinned to this
	 * fraction instead - the entry-over-key budget override demo: the card
	 * shows this percentage with the key-reported budget beside it.
	 */
	readonly entryBudgetRatio?: number;
	/** The fake model the demo completions run against (pricing varies the spend). */
	readonly model: string;
}

export const DEMO_USAGE_KEYS: readonly DemoUsageKeySpec[] = [
	{
		key: "sk-dev-usage-healthy",
		alias: "dev-usage-healthy",
		userId: "dev-usage-healthy-user",
		label: "Dev Usage (healthy)",
		keyBudgetRatio: 0.3,
		model: "claude-opus-4-5",
	},
	{
		// The warning state comes from the ENTRY's budget (85%, over the 0.8
		// default threshold) while the key itself reports a laxer cap (60%):
		// the personal-alert-line-below-the-server-cap story from docs/usage.md.
		key: "sk-dev-usage-warning",
		alias: "dev-usage-warning",
		userId: "dev-usage-warning-user",
		label: "Dev Usage (warning)",
		keyBudgetRatio: 0.6,
		entryBudgetRatio: 0.85,
		model: "gpt-5.2",
	},
	{
		key: "sk-dev-usage-over",
		alias: "dev-usage-over",
		userId: "dev-usage-over-user",
		label: "Dev Usage (over)",
		keyBudgetRatio: 1.1,
		model: "claude-opus-4-5",
	},
];

/** One seeded key's measured outcome; dev.ts turns these into seed entries. */
export interface SeededDemoUsage {
	readonly spec: DemoUsageKeySpec;
	/** The key's accumulated spend in USD after the flush (all runs, not just this one). */
	readonly spend: number;
	/** The max_budget the key was pinned to (spend / keyBudgetRatio). */
	readonly keyBudget: number;
	/** The entry-level budget for the seed (spend / entryBudgetRatio), when the spec asks for one. */
	readonly entryBudget?: number;
}

/** While chats fire, budgets sit at a ceiling no demo spend reaches, so a rerun's over-budget key accepts them. */
const UNBLOCK_BUDGET_USD = 1_000_000;
/** The spend-log flush is async (~10s); poll /key/info until the new spend lands. */
const FLUSH_TIMEOUT_MS = 120_000;
const FLUSH_POLL_MS = 2_000;
/**
 * Consecutive equal readings after the first rise before a key counts as
 * flushed: LiteLLM's batch writer lands queued spend roughly every 10s, so
 * the stability window (FLUSH_STABLE_POLLS x FLUSH_POLL_MS = 12s) must
 * exceed one batch interval - settling on the first rise could measure a
 * partial batch and pin the budgets off-target.
 */
const FLUSH_STABLE_POLLS = 6;
/** Whole-call bound on each admin request and spend read. */
const ADMIN_TIMEOUT_MS = 30_000;
/** Whole-call bound on one demo completion (a few thousand streamed words). */
const CHAT_TIMEOUT_MS = 120_000;
/** How long a standalone run waits for the proxy; the dev launcher's stack start already waited. */
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 1_000;

function log(message: string): void {
	console.log(`[dev-usage] ${message}`);
}

/** Wait for the proxy's liveliness probe, so the documented standalone invocation works right after an `up`. */
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

async function adminPost(baseUrl: string, masterKey: string, route: string, body: object): Promise<void> {
	const response = await fetch(`${baseUrl}${route}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${masterKey}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`POST ${route} failed: HTTP ${response.status} ${await response.text()}`);
	}
}

/** The key's current spend via GET /key/info (master auth), or undefined when the key does not exist yet. */
async function readSpend(baseUrl: string, masterKey: string, key: string): Promise<number | undefined> {
	const response = await fetch(`${baseUrl}/key/info?key=${encodeURIComponent(key)}`, {
		headers: { Authorization: `Bearer ${masterKey}` },
		signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
	});
	// v1.93 answers a missing key with HTTP 404; tolerate the 400 some
	// versions use for "key not found" too. Anything else is a real failure.
	if (response.status === 400 || response.status === 404) {
		return undefined;
	}
	if (!response.ok) {
		throw new Error(`GET /key/info failed: HTTP ${response.status} ${await response.text()}`);
	}
	const payload = (await response.json()) as { info?: { spend?: unknown } };
	const spend = payload.info?.spend;
	return typeof spend === "number" && Number.isFinite(spend) ? spend : 0;
}

/**
 * Ensure the key exists with its declared identity and an unblocking budget,
 * mirroring scripts/stack/seedUsage.ts: a surviving key gets every declared
 * field re-pinned (never its spend), a missing one is created. Returns the
 * key's current spend, the baseline the flush wait measures against.
 */
async function ensureKeyUnblocked(baseUrl: string, masterKey: string, spec: DemoUsageKeySpec): Promise<number> {
	const declaredFields = {
		key_alias: spec.alias,
		user_id: spec.userId,
		max_budget: UNBLOCK_BUDGET_USD,
		budget_duration: "30d",
	};
	const spend = await readSpend(baseUrl, masterKey, spec.key);
	if (spend === undefined) {
		await adminPost(baseUrl, masterKey, "/key/generate", { key: spec.key, ...declaredFields });
		return 0;
	}
	await adminPost(baseUrl, masterKey, "/key/update", { key: spec.key, ...declaredFields });
	return spend;
}

/**
 * How many demo chats a key fires this run: 2-4, varied by the UTC
 * day-of-month and the key's position so the cards read lived-in without any
 * randomness (the same day seeds the same counts).
 */
function chatCount(keyIndex: number): number {
	return 2 + ((new Date().getUTCDate() + keyIndex) % 3);
}

/** One deterministic streaming completion with include_usage, so LiteLLM accrues spend for it. */
async function fireChat(baseUrl: string, spec: DemoUsageKeySpec, words: number): Promise<void> {
	const response = await fetch(`${baseUrl}/v1/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${spec.key}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: spec.model,
			messages: [{ role: "user", content: `%text:${words}` }],
			stream: true,
			stream_options: { include_usage: true },
		}),
		signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`chat completion for ${spec.alias} failed: HTTP ${response.status} ${await response.text()}`);
	}
	// Drain the stream; spend accrues from the usage trailer once it flushes.
	await response.text();
}

/**
 * Poll /key/info until every key's spend has risen above its pre-chat
 * baseline AND held steady for FLUSH_STABLE_POLLS consecutive readings:
 * risen means the async flush started landing, steady means no partial
 * batch is still queued behind it.
 */
async function awaitSpendFlush(baseUrl: string, masterKey: string, baselines: Map<string, number>): Promise<void> {
	const deadline = Date.now() + FLUSH_TIMEOUT_MS;
	const lastSeen = new Map<string, { spend: number; stablePolls: number }>();
	const pending = new Set(baselines.keys());
	for (;;) {
		for (const key of [...pending]) {
			const spend = await readSpend(baseUrl, masterKey, key);
			if (spend === undefined || spend <= (baselines.get(key) ?? 0)) {
				continue;
			}
			const seen = lastSeen.get(key);
			const stablePolls = seen !== undefined && seen.spend === spend ? seen.stablePolls + 1 : 0;
			lastSeen.set(key, { spend, stablePolls });
			if (stablePolls >= FLUSH_STABLE_POLLS) {
				pending.delete(key);
			}
		}
		if (pending.size === 0) {
			return;
		}
		if (Date.now() >= deadline) {
			throw new Error(`spend flush did not settle within ${FLUSH_TIMEOUT_MS}ms for ${pending.size} key(s)`);
		}
		await new Promise((resolve) => setTimeout(resolve, FLUSH_POLL_MS));
	}
}

/** Pin one key's max_budget to spend / keyBudgetRatio; the returned number is what /key/info will report. */
async function pinKeyBudget(
	baseUrl: string,
	masterKey: string,
	spec: DemoUsageKeySpec,
	spend: number
): Promise<number> {
	const keyBudget = Number((spend / spec.keyBudgetRatio).toFixed(6));
	await adminPost(baseUrl, masterKey, "/key/update", { key: spec.key, max_budget: keyBudget });
	return keyBudget;
}

/**
 * Best-effort recovery when seeding dies between the unblock and the final
 * pinning: any key left at the interim ceiling would otherwise read as ~0%
 * spent on cards a previous run already seeded. Re-pin every key with
 * readable spend to its target fraction; keys with none keep the ceiling
 * (there is nothing to compute a budget from), and new errors are swallowed
 * so the original failure stays the one reported.
 */
async function restoreBudgetsBestEffort(baseUrl: string, masterKey: string): Promise<void> {
	for (const spec of DEMO_USAGE_KEYS) {
		try {
			const spend = await readSpend(baseUrl, masterKey, spec.key);
			if (spend !== undefined && spend > 0) {
				await pinKeyBudget(baseUrl, masterKey, spec, spend);
			}
		} catch {
			// The original failure is the story; this cleanup is best effort.
		}
	}
}

/**
 * Seed the three demo keys: ensure each exists unblocked, fire its chats,
 * wait for the spend flush, then pin each key's max_budget to spend /
 * keyBudgetRatio so the Usage tab shows the intended states. Any failure
 * after the unblock re-pins whatever it can before rethrowing; callers treat
 * a throw as "the usage demo is unavailable", never as a failed stack start.
 */
export async function seedDemoUsage(baseUrl: string, masterKey: string): Promise<SeededDemoUsage[]> {
	await waitForProxy(baseUrl);
	// The unblock loop sits inside the recovery try too: a failure on the
	// second key must still re-pin the first one off the interim ceiling.
	try {
		const baselines = new Map<string, number>();
		for (const spec of DEMO_USAGE_KEYS) {
			baselines.set(spec.key, await ensureKeyUnblocked(baseUrl, masterKey, spec));
		}
		for (const [keyIndex, spec] of DEMO_USAGE_KEYS.entries()) {
			const chats = chatCount(keyIndex);
			log(`${spec.alias}: firing ${chats} demo completions against ${spec.model}`);
			for (let chat = 0; chat < chats; chat++) {
				// 1200-3000 words, deterministic per key and chat; %text caps at 5000.
				await fireChat(baseUrl, spec, 1200 + 500 * chat + 150 * keyIndex);
			}
		}
		log("waiting for LiteLLM's async spend flush to settle (~25s)");
		await awaitSpendFlush(baseUrl, masterKey, baselines);
		const results: SeededDemoUsage[] = [];
		for (const spec of DEMO_USAGE_KEYS) {
			const spend = await readSpend(baseUrl, masterKey, spec.key);
			if (spend === undefined || spend <= 0) {
				throw new Error(`${spec.alias} reports no spend after the flush`);
			}
			const keyBudget = await pinKeyBudget(baseUrl, masterKey, spec, spend);
			const entryBudget =
				spec.entryBudgetRatio !== undefined ? Number((spend / spec.entryBudgetRatio).toFixed(6)) : undefined;
			const effective = entryBudget ?? keyBudget;
			log(
				`${spec.alias}: spend $${spend.toFixed(4)}, budget $${effective.toFixed(4)} (~${Math.round((spend / effective) * 100)}% spent)`
			);
			results.push({ spec, spend, keyBudget, ...(entryBudget !== undefined ? { entryBudget } : {}) });
		}
		return results;
	} catch (error) {
		await restoreBudgetsBestEffort(baseUrl, masterKey);
		throw error;
	}
}
