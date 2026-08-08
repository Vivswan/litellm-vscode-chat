/**
 * The virtual key the docker stack seeds for spend/budget tests, shared by
 * the seeder (scripts/stack/seedUsage.ts) and the docker-usage suite so the
 * two can never disagree on what was seeded. The stack's postgres service
 * gives LiteLLM a database, which is what makes /key/info and
 * /user/daily/activity exist at all; this key is what the suites
 * authenticate those endpoints with.
 *
 * Every value is a deliberately low-entropy test fixture (same spirit as the
 * sk-test-1234 master key): it authenticates only against the local compose
 * stack and must look obviously fake.
 */
export const USAGE_SEED_KEY = {
	/** The literal bearer token; /key/generate accepts a caller-chosen value. */
	key: "sk-usage-seed-1234",
	/** key_alias: how the key shows up in LiteLLM's own bookkeeping. */
	alias: "usage-seed-budget",
	/** user_id: gives /user/daily/activity a user to aggregate under. */
	userId: "usage-seed-user",
	/** max_budget in USD; suites assert this exact number via /key/info. */
	maxBudget: 25,
	/** budget_duration: makes /key/info report a budget_reset_at schedule. */
	budgetDuration: "30d",
} as const;
