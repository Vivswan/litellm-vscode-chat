import * as assert from "node:assert";
import * as fc from "fast-check";
import { HttpResponse, http } from "msw";
import type { KeyUsage, UserUsage } from "../../../../extension/servers/usage";
import { UsageClient, usageUnavailabilityOf } from "../../../../extension/servers/usage";
import { RequestError } from "../../../../provider/transport/errorMapping";
import { resolveFuzzSeed } from "../../../fuzzStream";
import { mswServer, TEST_BASE_URL, useMsw } from "../../../mocks/handlers";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
// The msw-backed properties cap at 2000 runs (each run is a real intercepted
// HTTP round trip); the pure usageUnavailabilityOf properties scale unbounded.
const MSW_RUNS_CAP = 2000;
const SEED = resolveFuzzSeed();

/**
 * Wire-payload properties for the spend client: usage responses embed hashed
 * key material, aliases, and user IDs, so the client's contract is that every
 * payload shape resolves to a typed outcome (never an exception escaping the
 * parse), unavailability classification is a pure function of the error's
 * structure, and NO response-derived text ever reaches an error message, an
 * error cause, a log line, or the parsed result (the store's contents reach
 * the dashboard webview). The unit suite (spendClient.test.ts) pins the happy
 * paths; these properties pin the same rules against arbitrary garbage.
 */

const KEY_INFO_URL = `${TEST_BASE_URL}/key/info`;
const USER_INFO_URL = `${TEST_BASE_URL}/user/info`;
const DAILY_ACTIVITY_URL = `${TEST_BASE_URL}/user/daily/activity`;
const WINDOW = { startDate: "2026-07-01", endDate: "2026-07-30" };

/** Response-derived text a leak would carry; never a valid YYYY-MM-DD, so pattern-validated day keys cannot alias it. */
const MARKER = "sk-hashed-key-material-FUZZ";

const connection = { label: "alpha", baseUrl: TEST_BASE_URL, apiKey: "sk-test", headers: {} } as const;

/**
 * A client with a recording logger. The spend client's contract is to
 * construct errors and throw WITHOUT logging (the poller boundary logs one
 * classification), so the suites assert the recording stays EMPTY: any future
 * log call added to the client trips it, and a log line carrying response
 * text could never slip through unnoticed.
 */
function recordingClient(): { client: UsageClient; logs: string[] } {
	const logs: string[] = [];
	const client = new UsageClient({
		userAgent: "test-agent",
		getTimeoutMs: () => 5000,
		log: (message, data) => {
			logs.push(`${message} ${JSON.stringify(data) ?? ""}`);
		},
	});
	return { client, logs };
}

/** Every text surface of a thrown error: message, English mirror, classification, and the cause chain. */
function errorTextSurfaces(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
		if (current instanceof RequestError) {
			parts.push(current.message, current.englishMessage ?? "", current.logClassification ?? "");
		} else if (current instanceof Error) {
			parts.push(current.message);
		} else {
			parts.push(String(current));
		}
		current = current instanceof Error ? current.cause : undefined;
	}
	return parts.join("\n");
}

function assertNoMarker(text: string, where: string): void {
	assert.ok(!text.includes(MARKER), `${where} must never carry response-derived text`);
}

/** A usage-number slot as the parser must leave it: absent, or a finite non-negative number. */
function assertUsageNumber(value: number | undefined, field: string): void {
	assert.ok(
		value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0),
		`${field} must be absent or a finite non-negative number, got ${String(value)}`
	);
}

function assertTypedKeyUsage(key: KeyUsage): void {
	assertUsageNumber(key.spend, "spend");
	assertUsageNumber(key.maxBudget, "maxBudget");
	assertUsageNumber(key.softBudget, "softBudget");
	assert.ok(
		key.budgetResetAt === undefined || Number.isFinite(key.budgetResetAt),
		"budgetResetAt must be absent or finite epoch ms"
	);
	assert.strictEqual(typeof key.hasUser, "boolean");
}

function assertTypedUserUsage(user: UserUsage): void {
	assertUsageNumber(user.spend, "spend");
	assertUsageNumber(user.maxBudget, "maxBudget");
	assert.ok(
		user.budgetResetAt === undefined || Number.isFinite(user.budgetResetAt),
		"budgetResetAt must be absent or finite epoch ms"
	);
}

// -- Payload arbitraries ------------------------------------------------------

/** Field values the endpoints could serve: usable numbers, junk types, huge numbers, nested garbage, marker text. */
const junkFieldValue = fc.oneof(
	fc.double({ noNaN: true, min: -1e12, max: 1e12 }),
	fc.constantFrom<unknown>(
		0,
		-0,
		-5,
		1e308,
		-1e308,
		Number.MAX_SAFE_INTEGER,
		4.2,
		MARKER,
		"not-a-number",
		"",
		null,
		true,
		false,
		[MARKER],
		{ nested: { deep: MARKER } },
		{ usd: 1 },
		// Date-shaped strings for the epoch slots: valid ISO forms, an
		// impossible calendar date, the Date range edges (one representable,
		// one NaN), and a NUMERIC epoch - which must read as absent, because
		// usageEpochMs only accepts strings. "user-1" populates hasUser.
		"2026-09-01T00:00:00.000Z",
		"2026-09-01",
		"2026-02-30T00:00:00Z",
		"+275760-09-13T00:00:00.000Z",
		"+275760-09-14",
		1756684800000,
		"user-1"
	),
	fc.jsonValue({ maxDepth: 2 })
);

/** An info-shaped record whose recognized keys carry junk, plus noise keys. */
const infoRecordArb = fc
	.tuple(
		fc.dictionary(
			fc.constantFrom("spend", "max_budget", "soft_budget", "budget_reset_at", "budget_duration", "user_id"),
			junkFieldValue,
			{ maxKeys: 6 }
		),
		fc.dictionary(fc.string({ maxLength: 12 }), junkFieldValue, { maxKeys: 3 })
	)
	.map(([known, noise]) => ({ ...noise, ...known }));

/** A whole key-info or user-info payload: targeted shapes and outright junk. */
const rollupPayloadArb = fc.oneof(
	{ weight: 3, arbitrary: infoRecordArb.map((info) => ({ key: MARKER, info })) },
	{ weight: 3, arbitrary: infoRecordArb.map((info) => ({ user_id: MARKER, user_info: info })) },
	{ weight: 1, arbitrary: fc.jsonValue({ maxDepth: 3 }) },
	{ weight: 1, arbitrary: fc.constantFrom<unknown>(null, [], {}, { info: null }, { info: [] }, { user_info: 42 }) }
);

const dayKeyArb = fc.oneof(
	fc.constantFrom("2026-07-01", "2026-07-15", "0000-00-00", "9999-99-99"),
	fc.constantFrom("2026-7-1", "not-a-day", "", MARKER, "2026-07-01T00:00:00Z", "2026-07-011")
);

/** One daily-activity results element: day-shaped records with junk metrics, and outright junk. */
const dailyEntryArb = fc.oneof(
	{
		weight: 3,
		arbitrary: fc
			.tuple(
				dayKeyArb,
				fc.dictionary(
					fc.constantFrom(
						"spend",
						"prompt_tokens",
						"completion_tokens",
						"total_tokens",
						"api_requests",
						"successful_requests",
						"failed_requests",
						"cache_read_input_tokens",
						"cache_creation_input_tokens"
					),
					junkFieldValue,
					{ maxKeys: 9 }
				),
				fc.boolean()
			)
			.map(([date, metrics, withMetrics]) => (withMetrics ? { date, metrics } : { date, metrics: MARKER })),
	},
	{ weight: 1, arbitrary: fc.jsonValue({ maxDepth: 2 }) },
	{ weight: 1, arbitrary: fc.constantFrom<unknown>(null, 42, MARKER, { date: 20260701 }, { metrics: {} }) }
);

const dailyPayloadArb = fc.oneof(
	{
		weight: 4,
		arbitrary: fc
			.tuple(
				fc.array(dailyEntryArb, { maxLength: 8 }),
				// The metadata slot carries the canary explicitly: a regression
				// that trusts or logs response metadata must trip the marker check.
				fc.oneof(fc.jsonValue({ maxDepth: 1 }), fc.constant<unknown>({ total_spend: 12345, secret: MARKER }))
			)
			.map(([results, metadata]) => ({ results, metadata })),
	},
	{ weight: 1, arbitrary: fc.jsonValue({ maxDepth: 3 }) }
);

/** The parser's documented day-acceptance rule, restated for the retained-set check. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
function expectedDayKeys(payload: unknown): string[] {
	const record = payload as { results?: unknown };
	const results = typeof record === "object" && record !== null && Array.isArray(record.results) ? record.results : [];
	return results
		.filter(
			(entry): entry is { date: string } =>
				typeof entry === "object" &&
				entry !== null &&
				!Array.isArray(entry) &&
				typeof (entry as { date?: unknown }).date === "string" &&
				DAY_PATTERN.test((entry as { date: string }).date)
		)
		.map((entry) => entry.date)
		.sort((a, b) => a.localeCompare(b));
}

suite("extension/servers/usage spendClient payload properties", () => {
	useMsw();

	test("key-info and user-info parsing is total and typed over arbitrary payloads; nothing response-derived rides into the result", async function () {
		this.timeout(240000);
		// One stable handler pair reading mutable state: use() inside the
		// property would stack handlers per run and never honor a high FUZZ_RUNS.
		let served: unknown;
		mswServer.use(
			http.get(KEY_INFO_URL, () => HttpResponse.json(served as never)),
			http.get(USER_INFO_URL, () => HttpResponse.json(served as never))
		);
		const { client, logs } = recordingClient();
		await fc.assert(
			fc.asyncProperty(rollupPayloadArb, async (payload) => {
				served = payload;
				const key = await client.fetchKeyInfo(connection);
				const user = await client.fetchUserInfo(connection);
				assertTypedKeyUsage(key);
				assertTypedUserUsage(user);
				// The one string the payload could smuggle out is gone: results are
				// numbers, epoch timestamps, and booleans only.
				assertNoMarker(JSON.stringify(key) + JSON.stringify(user), "a parsed rollup");
			}),
			{ numRuns: Math.min(NUM_RUNS, MSW_RUNS_CAP), seed: SEED }
		);
		assert.strictEqual(logs.length, 0, "the spend client constructs errors and throws WITHOUT logging");
	});

	test("daily activity keeps exactly the pattern-valid days, sorted, typed, and self-summed", async function () {
		this.timeout(240000);
		let served: unknown;
		mswServer.use(http.get(DAILY_ACTIVITY_URL, () => HttpResponse.json(served as never)));
		const { client, logs } = recordingClient();
		await fc.assert(
			fc.asyncProperty(dailyPayloadArb, async (payload) => {
				served = payload;
				const daily = await client.fetchDailyActivity(connection, WINDOW);

				// A malformed day drops itself, not the window: the retained set is
				// exactly the record-shaped entries with a pattern-valid date.
				assert.deepStrictEqual(
					daily.days.map((day) => day.date),
					expectedDayKeys(payload)
				);
				const expectedTotals: Record<string, number> = Object.fromEntries(
					Object.keys(daily.totals).map((field) => [field, 0])
				);
				for (const day of daily.days) {
					for (const [field, value] of Object.entries(day)) {
						if (field === "date") {
							continue;
						}
						assert.ok(
							typeof value === "number" && Number.isFinite(value) && value >= 0,
							`day.${field} must be a finite non-negative number`
						);
						// Same accumulation order as the client's reduce, so the
						// floating-point result must agree bit for bit.
						expectedTotals[field] = (expectedTotals[field] as number) + value;
					}
				}
				// Totals are summed from the retained days, never trusted from the
				// response metadata. The sum follows IEEE float semantics on purpose
				// (two 1e308 days overflow to Infinity), because the documented
				// contract is that the totals AGREE WITH THE DAYS SHOWN - but they
				// can never go negative or NaN (every addend is >= 0).
				assert.deepStrictEqual({ ...daily.totals }, expectedTotals);
				for (const [field, total] of Object.entries(daily.totals)) {
					assert.ok(!Number.isNaN(total) && (total as number) >= 0, `totals.${field} must be a non-negative number`);
				}
				assertNoMarker(JSON.stringify(daily), "a parsed daily window");
			}),
			{ numRuns: Math.min(NUM_RUNS, MSW_RUNS_CAP), seed: SEED }
		);
		assert.strictEqual(logs.length, 0, "the spend client constructs errors and throws WITHOUT logging");
	});

	test("non-JSON bodies fail as typed errors with no response-derived text on any surface", async function () {
		this.timeout(240000);
		let servedBody = "";
		let servedContentType = "text/plain";
		mswServer.use(
			http.get(
				KEY_INFO_URL,
				() => new HttpResponse(servedBody, { status: 200, headers: { "Content-Type": servedContentType } })
			)
		);
		const { client, logs } = recordingClient();
		await fc.assert(
			fc.asyncProperty(
				fc.oneof(
					fc.constantFrom(`${MARKER}`, `not json ${MARKER}`, `<html>${MARKER}</html>`, `{"broken": ${MARKER}`, ""),
					fc.string({ maxLength: 40 }).map((prefix) => `${prefix}${MARKER}`),
					// Valid JSON with the marker inside a string: the success branch
					// below is reachable and must still come out marker-free.
					fc.constant(JSON.stringify({ info: { spend: 1, note: MARKER } }))
				),
				// The content type is deliberately inert: the client reads text()
				// and parses it itself, so a mislabeled body must behave identically.
				fc.constantFrom("text/plain", "text/html", "application/json", "application/octet-stream"),
				async (body, contentType) => {
					servedBody = body;
					servedContentType = contentType;
					try {
						const parsed = await client.fetchKeyInfo(connection);
						// The valid-JSON body lands here whatever its content type says:
						// typed fields only, the marker string narrowed away.
						assertTypedKeyUsage(parsed);
						assertNoMarker(JSON.stringify(parsed), "a parsed rollup");
					} catch (error) {
						assert.ok(error instanceof RequestError, `expected a RequestError, got ${String(error)}`);
						assert.strictEqual(error.kind, "http");
						assert.strictEqual(error.cause, undefined, "the SyntaxError quotes the payload; it must not ride as cause");
						assertNoMarker(errorTextSurfaces(error), "a parse-failure error");
					}
				}
			),
			{ numRuns: Math.min(NUM_RUNS, MSW_RUNS_CAP), seed: SEED }
		);
		assert.strictEqual(logs.length, 0, "the spend client constructs errors and throws WITHOUT logging");
	});

	test("non-OK statuses classify deterministically from the status alone; bodies never leak", async function () {
		this.timeout(240000);
		// 4xx fails on the first attempt, so the property stays cheap; 501 and
		// 5xx ride the retry budget first (200ms+400ms backoff), so the retried
		// path gets one pinned example below and the 500 exhaustion lives in the
		// unit suite. The status-to-verdict mapping itself is pure and fully
		// covered by the usageUnavailabilityOf property.
		let servedStatus = 400;
		mswServer.use(
			http.get(KEY_INFO_URL, () =>
				HttpResponse.json({ error: MARKER, detail: { key: MARKER } }, { status: servedStatus })
			)
		);
		const { client, logs } = recordingClient();
		const expectFailure = async (status: number): Promise<RequestError> => {
			servedStatus = status;
			let thrown: unknown;
			try {
				await client.fetchKeyInfo(connection);
			} catch (error) {
				thrown = error;
			}
			assert.ok(thrown instanceof RequestError, "a non-OK status must surface as a RequestError");
			assert.strictEqual(thrown.status, status);
			assertNoMarker(errorTextSurfaces(thrown), "a usage HTTP error");
			return thrown;
		};
		await fc.assert(
			fc.asyncProperty(
				fc.oneof(fc.constantFrom(400, 401, 403, 404, 405, 451), fc.integer({ min: 400, max: 499 })),
				async (status) => {
					const thrown = await expectFailure(status);
					assert.strictEqual(thrown.kind, status === 401 || status === 403 ? "auth" : "http");

					// The documented mapping, and its determinism: classifying the same
					// error twice can never disagree (the availability standing the
					// poller stores from this verdict is permanent).
					const expected =
						status === 401 || status === 403
							? "forbidden"
							: [400, 404, 405].includes(status)
								? "unsupported"
								: undefined;
					assert.strictEqual(usageUnavailabilityOf(thrown), expected);
					assert.strictEqual(usageUnavailabilityOf(thrown), expected, "classification must be deterministic");
				}
			),
			{ numRuns: Math.min(NUM_RUNS, MSW_RUNS_CAP), seed: SEED }
		);
		// The one retried non-OK verdict: a 501 exhausts the retry budget and
		// still reads as permanently unsupported, body unread throughout.
		const routeMissing = await expectFailure(501);
		assert.strictEqual(usageUnavailabilityOf(routeMissing), "unsupported");
		// A 500 exhausts the same budget and stays transient, marker-free on
		// every surface (the property above skips 5xx to dodge the backoff).
		const exhausted = await expectFailure(500);
		assert.strictEqual(exhausted.kind, "http");
		assert.strictEqual(usageUnavailabilityOf(exhausted), undefined, "5xx must not read as permanently unavailable");
		assert.strictEqual(logs.length, 0, "the spend client constructs errors and throws WITHOUT logging");
	});

	test("a network failure exhausts the retries into a typed error whose cause chain carries no response text", async function () {
		this.timeout(30000);
		// HttpResponse.error() makes fetch itself throw, driving the one path
		// that attaches a cause to the thrown RequestError - so the cause-chain
		// walk in errorTextSurfaces is exercised for real, not vacuously.
		mswServer.use(http.get(KEY_INFO_URL, () => HttpResponse.error()));
		const { client, logs } = recordingClient();
		let thrown: unknown;
		try {
			await client.fetchKeyInfo(connection);
		} catch (error) {
			thrown = error;
		}
		assert.ok(thrown instanceof RequestError, `expected a RequestError, got ${String(thrown)}`);
		assert.strictEqual(thrown.kind, "network");
		assert.ok(thrown.cause !== undefined, "the network error must carry the underlying failure as its cause");
		assertNoMarker(errorTextSurfaces(thrown), "a network error chain");
		assert.strictEqual(usageUnavailabilityOf(thrown), undefined, "network failures stay transient");
		assert.strictEqual(logs.length, 0, "the spend client constructs errors and throws WITHOUT logging");
	});
});

suite("extension/servers/usage usageUnavailabilityOf properties", () => {
	test("the verdict is a pure function of status and the oauth marker; everything else stays transient", () => {
		fc.assert(
			fc.property(
				fc.option(fc.integer({ min: 100, max: 599 }), { nil: undefined }),
				fc.constantFrom<RequestError["kind"]>("auth", "http", "network", "timeout"),
				fc.boolean(),
				(status, kind, oauthTokenEndpoint) => {
					const error = new RequestError("rejected", kind, {
						englishMessage: "rejected",
						...(status !== undefined ? { status } : {}),
						...(oauthTokenEndpoint ? { oauthTokenEndpoint: true } : {}),
					});
					const expected =
						status === undefined || oauthTokenEndpoint
							? undefined
							: status === 401 || status === 403
								? "forbidden"
								: [400, 404, 405, 501].includes(status)
									? "unsupported"
									: undefined;
					assert.strictEqual(usageUnavailabilityOf(error), expected);
					assert.strictEqual(usageUnavailabilityOf(error), expected, "classification must be deterministic");
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("non-RequestError values never classify as permanently unavailable, however duck-typed", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.anything(),
					// Duck-typed lookalikes: the verdict must gate on the RequestError
					// class, never on a status field readable off any object.
					fc.record({ status: fc.constantFrom(400, 401, 403, 404, 501), kind: fc.constant("http") }),
					fc
						.constantFrom(400, 401, 403, 404, 405, 501)
						.map((status) => Object.assign(new Error("rejected"), { status }))
				),
				(value) => {
					assert.strictEqual(usageUnavailabilityOf(value), undefined);
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
