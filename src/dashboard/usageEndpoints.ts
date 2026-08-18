/**
 * The usage endpoint vocabulary every surface shares: paths relative to the
 * server root (NOT the /v1 API root), keyed by endpoint id in probe order.
 * The host's spend client builds its URLs from this table and the poller's
 * refresh-failure summary names paths from it, while the dashboard's detail
 * lines print the same strings - one table, so no surface can name a path the
 * client does not actually call. English protocol terms, never localized.
 */
export const USAGE_ENDPOINT_PATHS = {
	keyInfo: "/key/info",
	dailyActivity: "/user/daily/activity",
	userInfo: "/user/info",
} as const;

/** The usage endpoints tracked per server: the path table's keys ARE the vocabulary. */
export type UsageEndpointId = keyof typeof USAGE_ENDPOINT_PATHS;
