import { afterEach, describe, expect, test } from "bun:test";
import type { OAuthConfig, TimeoutBudget } from "../../../../provider/transport/auth";
import { OAuthTokenSource } from "../../../../provider/transport/auth";
import type { BackoffSleep } from "../../../../provider/transport/retry";
import { retryBudgetMs } from "../../../../provider/transport/retry";
import { RequestError } from "../../../../provider/transport/transportErrors";
import { DISCOVERY_MAX_RETRIES } from "../../../../shared/config/settingSpec";
import { HANG_PHASES, type Hang } from "./hangingFetch";

const TOKEN_URL = "http://idp.test/oauth2/token";
const CONFIG: OAuthConfig = { tokenUrl: TOKEN_URL, clientId: "client-1", clientSecret: "secret-1" };
/** Per attempt, far below any real setting: the clocks under test are the attempt's and the budget's. */
const ATTEMPT_TIMEOUT_MS = 50;
const BUDGET: TimeoutBudget = { ms: ATTEMPT_TIMEOUT_MS, setting: "discovery.timeout" };
const noBackoff: BackoffSleep = () => Promise.resolve();

/** The token endpoint hangs for its first `hangs` requests and issues a token after. */
function fakeTokenEndpoint(hang: Hang, hangs: number): { requests: () => number } {
	let requests = 0;
	globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
		requests += 1;
		return requests <= hangs
			? hang(init?.signal)
			: Promise.resolve(Response.json({ access_token: `tok-${requests}`, expires_in: 3600 }));
	}) as typeof fetch;
	return { requests: () => requests };
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("the OAuth token exchange retries a timed-out attempt", () => {
	// Regression: each waiter bounded the whole exchange with one AbortSignal.timeout of its budget and the request had
	// no clock of its own, so a first attempt that hung spent the whole budget and the retries covered fast failures
	// only.
	test.each(HANG_PHASES)(
		"a first attempt that hangs %s past the attempt timeout is retried and the second attempt's token serves",
		async (_phase, hang) => {
			const endpoint = fakeTokenEndpoint(hang, 1);
			const token = await new OAuthTokenSource(noBackoff).getToken(CONFIG, "discovery", BUDGET);
			expect(String(token)).toBe("tok-2");
			expect(endpoint.requests()).toBe(2);
		}
	);

	test.each(HANG_PHASES)(
		"every attempt hanging %s ends the exchange inside the retry budget with the timeout verdict naming the budget's setting",
		async (_phase, hang) => {
			const endpoint = fakeTokenEndpoint(hang, Number.POSITIVE_INFINITY);
			const started = Date.now();
			const failure = await new OAuthTokenSource(noBackoff).getToken(CONFIG, "discovery", BUDGET).then(
				() => undefined,
				(error: unknown) => error
			);
			const elapsed = Date.now() - started;
			expect(failure).toBeInstanceOf(RequestError);
			const error = failure as RequestError;
			expect(error.kind).toBe("timeout");
			expect(error.message).toContain(`timed out after ${ATTEMPT_TIMEOUT_MS}ms`);
			expect(error.message).toContain("discovery.timeout");
			expect(error.englishMessage).toBe(error.message);
			expect(endpoint.requests()).toBe(DISCOVERY_MAX_RETRIES + 1);
			expect(elapsed).toBeLessThan(retryBudgetMs(ATTEMPT_TIMEOUT_MS, DISCOVERY_MAX_RETRIES));
		}
	);
});
