/**
 * The fake backend's no-discovery mode: requests under this path prefix get a
 * 404 for the discovery GETs (the /v1/models listing and /v1/model/info)
 * while everything else - chat completions above all - dispatches normally.
 * Docker suites point a server entry at `${FAKE_URL}${NO_DISCOVERY_PREFIX}`
 * to drive a gateway that serves chat but cannot list models (the
 * `expectedFailures` + declared-model topologies). The mode rides the URL path
 * because every fake route shares one port and base URL root, mirroring the
 * /authed bearer-guarded prefix (src/test/fakeStack/oauth.ts). Pure
 * constants, string functions, and the per-credential discovery-attempt
 * counters the server keeps: no vscode, no DOM, no Node.
 */

export const NO_DISCOVERY_PREFIX = "/nodiscovery";

/** A pathname split into its no-discovery flag and the route the handlers should serve. */
export interface NoDiscoveryRouting {
	readonly pathname: string;
	readonly noDiscovery: boolean;
}

/**
 * Strip NO_DISCOVERY_PREFIX off a pathname when it leads, flagging the
 * request; exact-prefix requests route to "/". A pathname that merely shares
 * the prefix's characters ("/nodiscoveryextra") is left alone.
 */
export function stripNoDiscoveryPrefix(pathname: string): NoDiscoveryRouting {
	if (pathname === NO_DISCOVERY_PREFIX || pathname.startsWith(`${NO_DISCOVERY_PREFIX}/`)) {
		return { pathname: pathname.slice(NO_DISCOVERY_PREFIX.length) || "/", noDiscovery: true };
	}
	return { pathname, noDiscovery: false };
}

/**
 * The discovery routes the no-discovery mode blanks: the extension's two
 * model-discovery GETs. /v1/model/info is listed even though the fake
 * backend never served it (it 404s regardless), so the mode stays total if
 * that route ever appears.
 */
export function isDiscoveryRoute(pathname: string): boolean {
	return pathname === "/v1/models" || pathname === "/v1/model/info";
}

/** Attempts against the two blanked discovery GETs, per credential. */
export interface NoDiscoveryAttemptCounts {
	models: number;
	modelInfo: number;
}

/** The no-discovery mirror's whole state; the counters only ever grow. */
export interface NoDiscoveryState {
	readonly attemptsByBearer: Map<string, NoDiscoveryAttemptCounts>;
}

export function createNoDiscoveryState(): NoDiscoveryState {
	return { attemptsByBearer: new Map() };
}

/**
 * Count one blanked discovery GET, keyed by the request's bearer token (or
 * "(none)"): the docker suites give each no-discovery server a unique key,
 * so a suite's no-retry assertions read its own server's attempts even while
 * other servers hit the same prefix. Counters reset only on a process
 * restart, so tests assert deltas, not absolutes.
 */
export function recordDiscoveryAttempt(
	state: NoDiscoveryState,
	pathname: string,
	authorization: string | undefined
): void {
	const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "(none)";
	const counts = state.attemptsByBearer.get(bearer) ?? { models: 0, modelInfo: 0 };
	if (pathname === "/v1/models") {
		counts.models += 1;
	} else if (pathname === "/v1/model/info") {
		counts.modelInfo += 1;
	} else {
		return;
	}
	state.attemptsByBearer.set(bearer, counts);
}

/** The GET /_test/nodiscovery-stats payload: bearer token to per-endpoint attempt counts. */
export function noDiscoveryStats(state: NoDiscoveryState): Record<string, NoDiscoveryAttemptCounts> {
	return Object.fromEntries(state.attemptsByBearer);
}
