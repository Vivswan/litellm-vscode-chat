/**
 * The usage endpoint vocabulary every surface shares: paths relative to the server root (NOT the /v1 API root), keyed
 * by endpoint id in probe order. An entry may move any of them (its `usageEndpoints` field), so no surface reads the
 * table directly: the host's spend client builds its URLs, the poller's refresh-failure summary and the dashboard's
 * detail lines name their paths, all through usageEndpointPath - one resolver, so no surface can name a path the
 * client does not actually call.
 *
 *   English protocol terms -> never localized
 */
export const USAGE_ENDPOINT_PATHS = {
	keyInfo: "/key/info",
	dailyActivity: "/user/daily/activity",
	userInfo: "/user/info",
} as const;

export type UsageEndpointId = keyof typeof USAGE_ENDPOINT_PATHS;

export const USAGE_ENDPOINT_IDS = Object.keys(USAGE_ENDPOINT_PATHS) as readonly UsageEndpointId[];

/** The one membership check for the endpoint ids, so the settings parser cannot accept a member the table lacks. */
export function isUsageEndpointId(value: unknown): value is UsageEndpointId {
	return typeof value === "string" && Object.hasOwn(USAGE_ENDPOINT_PATHS, value);
}

/**
 * An entry's `usageEndpoints` as parsed: a root-relative path per endpoint it moves, present only for those. Only the
 * path moves; the response is still read in LiteLLM's shape for that endpoint.
 */
export type UsageEndpointOverrides = Readonly<Partial<Record<UsageEndpointId, string>>>;

/** The path the client calls for `endpoint` on an entry: the entry's override where it names one, else the default. */
export function usageEndpointPath(endpoint: UsageEndpointId, overrides: UsageEndpointOverrides | undefined): string {
	return overrides?.[endpoint] ?? USAGE_ENDPOINT_PATHS[endpoint];
}
