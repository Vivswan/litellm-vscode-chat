import { describe, test } from "bun:test";
import * as assert from "node:assert";
import {
	classifyOverall,
	latestCheckedMs,
	overallStatusText,
	servedModelsBreakdown,
	serverOutcomeParts,
	serverOutcomeText,
	unitBehavior,
	zeroModelEnglishDetail,
	zeroModelExplanation,
} from "../../../dashboard/presenters";
import type { DashboardServer } from "../../../dashboard/viewModels";
import type { CapabilityJsonValue, CapabilityValueKind } from "../../../shared/config/capabilityResolution";
import {
	CAPABILITY_FIELDS,
	CONSUMED_CAPABILITY_FIELDS,
	capabilityField,
} from "../../../shared/config/capabilityResolution";
import type { NumberSettingId } from "../../../shared/config/settingSpec";
import { isIntegerSetting, NUMBER_SETTING_SPECS } from "../../../shared/config/settingSpec";

/**
 * Wording pins for the shared diagnostics renderers. These lines are what users
 * copy out of the Diagnostics tab into issue reports, so the exact text is
 * pinned once here instead of per surface.
 */

type DeclaredServer = Extract<DashboardServer, { origin: "declared" }>;

function declaredServer(overrides: Partial<DeclaredServer> = {}): DashboardServer {
	const base: DeclaredServer = {
		origin: "declared",
		label: "Prod",
		baseUrl: "http://prod.test",
		servedModelCount: 0,
		hasApiKey: false,
		hasOAuth: false,
		state: "ok",
		config: {
			secrets: { kind: "proven", locations: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } },
		},
	};
	return { ...base, ...overrides } as DeclaredServer;
}

function misconfiguredServer(problems: readonly string[]): DashboardServer {
	return {
		origin: "misconfigured",
		label: "Broken",
		baseUrl: "http://broken.test",
		servedModelCount: 0,
		hasApiKey: false,
		hasOAuth: false,
		state: "error",
		problems,
		error: "misconfigured entry; not used until its configuration is fixed",
		errorEnglish: "misconfigured entry; not used until its configuration is fixed",
	};
}

describe("dashboard/presenters renderers", () => {
	describe("overallStatusText", () => {
		test("nothing configured anywhere reads as not configured", () => {
			assert.strictEqual(overallStatusText([], 0), "Not configured");
		});

		test("connected with zero models names the empty listings through the one English detail", () => {
			const servers = [declaredServer({ servedModelCount: 0 })];
			assert.strictEqual(
				overallStatusText(servers, 0),
				"Connected, but 0 models are served (answered with an empty listing)"
			);
		});

		test("hidden groups alone read as the connected zero-model warning, never as not configured", () => {
			// Hidden groups leave the server list, but they are answering
			// configuration the user chose to silence: the classifier and the
			// paste line must match the status bar's warning.
			assert.strictEqual(classifyOverall([], { hiddenGroupCount: 1 }), "connected");
			assert.strictEqual(
				overallStatusText([], 0, { hiddenGroupCount: 1 }),
				"Connected, but 0 models are served (1 hidden by user removal)"
			);
			assert.strictEqual(
				overallStatusText([], 0, { hiddenGroupCount: 2 }),
				"Connected, but 0 models are served (2 hidden by user removal)"
			);
		});

		test("a hidden group beside an empty-listing server names both causes on the paste line", () => {
			const servers = [declaredServer({ servedModelCount: 0 })];
			assert.strictEqual(
				overallStatusText(servers, 0, { hiddenGroupCount: 1 }),
				"Connected, but 0 models are served (1 hidden by user removal; 1 answered with an empty listing)"
			);
		});

		test("a legacy-only registry names the registry instead of a not-configured claim", () => {
			assert.strictEqual(overallStatusText([], 0, { legacyServerCount: 1 }), "Legacy registry only (1 server)");
			assert.strictEqual(overallStatusText([], 0, { legacyServerCount: 2 }), "Legacy registry only (2 servers)");
		});

		test("legacy leftovers never override a configured verdict", () => {
			const servers = [declaredServer({ state: "ok", servedModelCount: 3 })];
			assert.strictEqual(overallStatusText(servers, 3, { legacyServerCount: 2 }), "Connected (3 models)");
		});

		test("every server reachable reads as connected with the model count", () => {
			const servers = [
				declaredServer({ servedModelCount: 4 }),
				declaredServer({ label: "Backup", servedModelCount: 2 }),
			];
			assert.strictEqual(overallStatusText(servers, 6), "Connected (6 models)");
		});

		test("one failing server among reachable ones reads as degraded", () => {
			const servers = [
				declaredServer({ servedModelCount: 4 }),
				declaredServer({ label: "Backup", state: "error", error: "connection refused" }),
			];
			assert.strictEqual(overallStatusText(servers, 4), "Degraded (4 models, some servers failed)");
		});

		test("every server failing surfaces the first error as the status", () => {
			const servers = [
				declaredServer({ state: "error", error: "connection refused" }),
				declaredServer({ label: "Backup", state: "error", error: "timeout" }),
			];
			assert.strictEqual(overallStatusText(servers, 0), "Error: connection refused");
		});

		test("declared entries no discovery pass has seen read as waiting, never as a failure", () => {
			const servers = [declaredServer({ state: "unchecked" })];
			assert.strictEqual(classifyOverall(servers), "waiting");
			assert.strictEqual(overallStatusText(servers, 0), "Waiting for first sync");
		});

		test("expected failures never count as failures: declared models read as connected", () => {
			const servers = [
				declaredServer({ servedModelCount: 4 }),
				declaredServer({
					label: "Gateway",
					state: "error",
					error: "404 on /models",
					expected: true,
					servedModelCount: 2,
					declaredModelCount: 2,
				}),
			];
			assert.strictEqual(classifyOverall(servers), "connected");
			assert.strictEqual(overallStatusText(servers, 6), "Connected (6 models)");
		});

		test("all-expected failures with nothing declared read as the neutral needs-declare verdict", () => {
			const servers = [declaredServer({ state: "error", error: "404 on /models", expected: true })];
			assert.strictEqual(classifyOverall(servers), "needs-declare");
			assert.strictEqual(
				overallStatusText(servers, 0),
				"Expected discovery failures; no declared models (add IDs to the entry's discovery.declared)"
			);
		});

		test("a misconfigured entry beside a healthy server stays neutral: connected, not degraded", () => {
			// The status bar cannot see misconfigured entries, so counting them here
			// would split the headline from the bar.
			const servers = [misconfiguredServer(["auth must pick one form"]), declaredServer({ servedModelCount: 3 })];
			assert.strictEqual(classifyOverall(servers), "connected");
			assert.strictEqual(overallStatusText(servers, 3), "Connected (3 models)");
		});

		test("with every real server down, the headline names the transport failure, not the misconfigured row", () => {
			// Rows sort by label ("Broken" first); the real outage is the line
			// worth pasting into an issue report.
			const servers = [
				misconfiguredServer(["auth must pick one form"]),
				declaredServer({ state: "error", error: "connection refused" }),
			];
			assert.strictEqual(classifyOverall(servers), "error");
			assert.strictEqual(overallStatusText(servers, 0), "Error: connection refused");
		});

		test("a configuration of only misconfigured entries is an error, never waiting", () => {
			const servers = [misconfiguredServer(["auth must pick one form"])];
			assert.strictEqual(classifyOverall(servers), "error");
			assert.strictEqual(
				overallStatusText(servers, 0),
				"Error: misconfigured entry; not used until its configuration is fixed"
			);
		});

		test("an unexpected failure beside an expected one still degrades, not errors", () => {
			const servers = [
				declaredServer({ state: "error", error: "refused" }),
				declaredServer({
					label: "Gateway",
					state: "error",
					error: "404 on /models",
					expected: true,
					servedModelCount: 1,
					declaredModelCount: 1,
				}),
			];
			assert.strictEqual(classifyOverall(servers), "degraded");
		});
	});

	describe("serverOutcomeText", () => {
		test("a reachable server reads OK with its model count", () => {
			assert.strictEqual(serverOutcomeText(declaredServer({ servedModelCount: 3 })), "OK (3 models)");
		});

		test("a reachable server whose sync failed reads Error with its still-served count", () => {
			// declaredOutcome renders a sync failure as an error row keeping the
			// live served count, so the paste line says both facts.
			const server = declaredServer({ state: "error", error: "upsert refused", servedModelCount: 2 });
			assert.strictEqual(serverOutcomeText(server), "Error (2 models still served): upsert refused");
		});

		test("a failing server reads its error", () => {
			const server = declaredServer({ state: "error", error: "connection refused" });
			assert.strictEqual(serverOutcomeText(server), "Error: connection refused");
		});

		test("an unchecked entry reads not checked yet", () => {
			assert.strictEqual(serverOutcomeText(declaredServer({ state: "unchecked" })), "Not checked yet");
		});

		test("a two-part error flattens to one physical line in the paste form", () => {
			// The grid renders headline and detail as separate lines; the copied
			// issue-report line must stay one physical line per server.
			const server = declaredServer({
				state: "error",
				error: "The server refused this request.\nLiteLLM 403: blocked by policy",
			});
			assert.strictEqual(
				serverOutcomeText(server),
				"Error: The server refused this request. - LiteLLM 403: blocked by policy"
			);
			assert.strictEqual(
				serverOutcomeParts(server).error,
				"The server refused this request.\nLiteLLM 403: blocked by policy"
			);
		});

		test("an expected failure with declared models reads as OK, annotated (expected)", () => {
			const server = declaredServer({
				state: "error",
				error: "404 on /models",
				expected: true,
				servedModelCount: 2,
				declaredModelCount: 2,
			});
			assert.strictEqual(serverOutcomeText(server), "OK (2 declared models) - 404 on /models (expected)");
			assert.strictEqual(
				serverOutcomeText(
					declaredServer({ state: "error", error: "x", expected: true, servedModelCount: 1, declaredModelCount: 1 })
				),
				"OK (1 declared model) - x (expected)"
			);
		});

		test("an expected failure serving stale AND declared models names the served total, declared as qualifier", () => {
			// The declared subset must never displace the served count: the row's
			// "5 models" and the paste line have to agree on one number.
			const server = declaredServer({
				state: "error",
				error: "404 on /models",
				expected: true,
				servedModelCount: 5,
				declaredModelCount: 2,
			});
			assert.strictEqual(serverOutcomeText(server), "OK (5 models, 2 declared) - 404 on /models (expected)");
		});

		test("servedModelsBreakdown classifies once for both string surfaces", () => {
			// The English paste line and the Servers row's localized headline both
			// render this classification; these pins are the shared vocabulary.
			assert.deepStrictEqual(servedModelsBreakdown(2, 2), { kind: "declared", declared: 2 });
			assert.deepStrictEqual(servedModelsBreakdown(5, 2), { kind: "mixed", served: 5, declared: 2 });
			// Discovery serves every declared model (served = discovered + declared,
			// groupDiscovery), so declared never exceeds served and mixed implies
			// served >= 2 - which is why neither surface carries a singular mixed
			// form. An out-of-contract input still classifies as the two-count form
			// rather than claiming the whole served set is declared.
			assert.deepStrictEqual(servedModelsBreakdown(1, 2), { kind: "mixed", served: 1, declared: 2 });
			assert.deepStrictEqual(servedModelsBreakdown(3, 0), { kind: "stale", served: 3 });
		});

		test("the models part, when present, always states the server's servedModelCount", () => {
			const servers: DashboardServer[] = [
				declaredServer({ servedModelCount: 3 }),
				declaredServer({ servedModelCount: 2, error: "upsert refused" }),
				declaredServer({ state: "error", error: "x", servedModelCount: 4 }),
				declaredServer({ state: "error", error: "x", expected: true, servedModelCount: 5, declaredModelCount: 2 }),
				declaredServer({ state: "error", error: "x", expected: true, servedModelCount: 2, declaredModelCount: 2 }),
				declaredServer({ state: "error", error: "x", expected: true, servedModelCount: 3 }),
			];
			for (const server of servers) {
				const models = serverOutcomeParts(server).models;
				assert.ok(models !== undefined, serverOutcomeText(server));
				assert.ok(
					models.startsWith(`${server.servedModelCount} `),
					`"${models}" must state servedModelCount ${server.servedModelCount}`
				);
			}
		});

		test("an expected two-part error carries its (expected) annotation on the headline", () => {
			const server = declaredServer({
				state: "error",
				error: "Discovery is declared unavailable.\nHTTP 404: not found",
				expected: true,
				servedModelCount: 2,
				declaredModelCount: 2,
			});
			assert.strictEqual(
				serverOutcomeParts(server).error,
				"Discovery is declared unavailable. (expected)\nHTTP 404: not found"
			);
			assert.strictEqual(
				serverOutcomeText(server),
				"OK (2 declared models) - Discovery is declared unavailable. (expected) - HTTP 404: not found"
			);
		});

		test("an expected failure with nothing declared stays an annotated error line", () => {
			const line = serverOutcomeText(
				declaredServer({
					state: "error",
					error: "404 on /models",
					expected: true,
					notices: ["expected-failures-nothing-declared"],
				})
			);
			assert.ok(line.startsWith("Error: 404 on /models (expected)"), line);
			assert.ok(line.includes("discovery.declared"), line);
		});

		test("an entry whose group cannot serve its per-entry parameters says so on a healthy line", () => {
			// The row is healthy, which is why the line must call the inactive
			// parameters out.
			const line = serverOutcomeText(declaredServer({ servedModelCount: 2, notices: ["entry-params-inactive"] }));
			assert.ok(line.startsWith("OK (2 models) - per-entry modelParameters are not applied"), line);
			assert.ok(line.includes("run Sync Models Now"), line);
		});

		test("an entry whose group cannot serve its apiVersion override says so on a healthy line", () => {
			// Same policy as the params notice: healthy row, English diagnostics
			// prose, and the line must say requests fell back to the auto rule.
			const line = serverOutcomeText(declaredServer({ servedModelCount: 2, notices: ["entry-api-version-inactive"] }));
			assert.ok(line.startsWith("OK (2 models) - the per-entry API version override is not applied"), line);
			assert.ok(line.includes("requests use the auto rule"), line);
			assert.ok(line.includes("run Sync Models Now"), line);
		});

		test("the capabilities twin of the params-inactive line names its own fields", () => {
			const line = serverOutcomeText(declaredServer({ servedModelCount: 2, notices: ["entry-capabilities-inactive"] }));
			assert.ok(
				line.startsWith(
					"OK (2 models) - per-entry modelCapabilities, declared models, and expectedFailures are not applied"
				),
				line
			);
			assert.ok(line.includes("run Sync Models Now"), line);
		});

		test("the custom-headers twin of the params-inactive line names its own fields", () => {
			const line = serverOutcomeText(declaredServer({ servedModelCount: 2, notices: ["entry-headers-inactive"] }));
			assert.ok(line.startsWith("OK (2 models) - per-entry custom headers are not applied"), line);
			assert.ok(line.includes("run Sync Models Now"), line);
		});

		test("the four entry-*-inactive notices share one composed cause-and-remedy clause", () => {
			// Each notice is its own subject plus the clause the composer appends;
			// the clause is pinned here once, as users paste it into issue reports.
			const clause =
				" (the provider group does not carry this entry's labeled identity); delete the group's object from the models file (chatLanguageModels.json), reload the window, and run Sync Models Now, or save the entry under a new label";
			const notices = [
				"entry-params-inactive",
				"entry-capabilities-inactive",
				"entry-headers-inactive",
				"entry-api-version-inactive",
			] as const;
			const subjects = notices.map((notice) => {
				const [text = ""] = serverOutcomeParts(declaredServer({ servedModelCount: 1, notices: [notice] })).notice;
				assert.ok(text.endsWith(clause), `${notice}: ${text}`);
				return text.slice(0, -clause.length);
			});
			assert.strictEqual(new Set(subjects).size, notices.length, "each notice names its own affected fields");
		});

		test("a row carrying both inactive notices lists them both, params first", () => {
			const line = serverOutcomeText(
				declaredServer({ servedModelCount: 2, notices: ["entry-params-inactive", "entry-capabilities-inactive"] })
			);
			assert.ok(line.includes("per-entry modelParameters are not applied"), line);
			assert.ok(
				line.includes("per-entry modelCapabilities, declared models, and expectedFailures are not applied"),
				line
			);
			assert.ok(
				line.indexOf("modelParameters are not applied") <
					line.indexOf("modelCapabilities, declared models, and expectedFailures"),
				line
			);
		});

		test("a misconfigured row short-circuits to its status with the parser's reports as the error", () => {
			const server = misconfiguredServer(["auth must pick one form", "unknown field ignored"]);
			assert.deepStrictEqual(serverOutcomeParts(server), {
				status: "Misconfigured",
				error: "auth must pick one form; unknown field ignored",
				notice: [],
			});
			assert.strictEqual(serverOutcomeText(server), "Misconfigured: auth must pick one form; unknown field ignored");
		});

		test("the one-line form is exactly the composition of serverOutcomeParts", () => {
			// The Diagnostics grid renders the decomposed parts; the pinned line is
			// what lands in issue reports. Re-deriving one from the other keeps the
			// two surfaces from drifting.
			const cases: DashboardServer[] = [
				declaredServer({ servedModelCount: 3 }),
				declaredServer({ state: "error", error: "upsert refused", servedModelCount: 2 }),
				declaredServer({ state: "error", error: "connection refused" }),
				declaredServer({ state: "unchecked" }),
				declaredServer({ servedModelCount: 2, notices: ["entry-params-inactive"] }),
				declaredServer({
					state: "error",
					error: "upsert refused",
					servedModelCount: 2,
					notices: ["entry-params-inactive"],
				}),
				declaredServer({ state: "error", error: "connection refused", notices: ["entry-params-inactive"] }),
				declaredServer({ state: "unchecked", notices: ["entry-params-inactive"] }),
				declaredServer({ servedModelCount: 2, notices: ["entry-params-inactive", "entry-capabilities-inactive"] }),
				declaredServer({ state: "error", error: "404", expected: true, servedModelCount: 2, declaredModelCount: 2 }),
				declaredServer({ state: "error", error: "404", expected: true, servedModelCount: 5, declaredModelCount: 2 }),
				declaredServer({
					state: "error",
					error: "404",
					expected: true,
					notices: ["expected-failures-nothing-declared"],
				}),
				declaredServer({ state: "error", error: "headline\nLiteLLM 403: detail line" }),
				declaredServer({ state: "error", error: "headline\nHTTP 502: upsert detail", servedModelCount: 2 }),
				declaredServer({
					state: "error",
					error: "headline\nHTTP 404: detail line",
					expected: true,
					servedModelCount: 2,
					declaredModelCount: 2,
				}),
			];
			for (const server of cases) {
				const parts = serverOutcomeParts(server);
				const status = parts.models === undefined ? parts.status : `${parts.status} (${parts.models})`;
				// The one-line form flattens a two-part error's newline to " - ";
				// the grid renders parts.error two-part on purpose.
				const flat = parts.error
					?.split("\n")
					.map((line) => line.trim())
					.filter((line) => line.length > 0)
					.join(" - ");
				const error = flat === undefined ? "" : parts.status === "OK" ? ` - ${flat}` : `: ${flat}`;
				const notice = parts.notice.map((text) => ` - ${text}`).join("");
				assert.strictEqual(serverOutcomeText(server), `${status}${error}${notice}`);
			}
		});
	});

	describe("zero-model prose", () => {
		test("the localized explanation names hidden groups first, then the empty listings", () => {
			// The one sentence the bar tooltip, the toasts, and the draft probe
			// share (English-bundle wording pinned here once).
			assert.strictEqual(
				zeroModelExplanation(1, 0),
				"1 server is hidden by an explicit removal and serves no models. Restore it from the dashboard's server list."
			);
			assert.strictEqual(
				zeroModelExplanation(2, 1),
				"2 servers are hidden by an explicit removal and serve no models. Restore them from the dashboard's server list. The remaining servers answered but listed no models."
			);
			assert.strictEqual(zeroModelExplanation(0, 1), "The server answered but listed no models.");
			assert.strictEqual(zeroModelExplanation(0, 2), "Your servers answered but listed no models.");
		});

		test("the English detail mirrors the same causes for logs and pasted reports", () => {
			assert.strictEqual(zeroModelEnglishDetail(0, 1), "answered with an empty listing");
			assert.strictEqual(zeroModelEnglishDetail(1, 0), "1 hidden by user removal");
			assert.strictEqual(zeroModelEnglishDetail(2, 1), "2 hidden by user removal; 1 answered with an empty listing");
		});
	});

	describe("latestCheckedMs", () => {
		test("undefined while nothing was checked; otherwise the most recent timestamp", () => {
			assert.strictEqual(latestCheckedMs([]), undefined);
			assert.strictEqual(latestCheckedMs([{ lastChecked: undefined }]), undefined);
			const older = "2026-07-26T01:02:03.000Z";
			const newer = "2026-07-27T05:06:07.000Z";
			assert.strictEqual(
				latestCheckedMs([{ lastChecked: older }, { lastChecked: undefined }, { lastChecked: newer }]),
				new Date(newer).getTime()
			);
		});

		test("unparseable timestamps are ignored instead of poisoning the maximum", () => {
			assert.strictEqual(latestCheckedMs([{ lastChecked: "not a date" }]), undefined);
		});
	});

	describe("capability vocabulary", () => {
		test("the consumed vocabulary contains the registration-typed core", () => {
			// The record editors key their inputs and validation hints off these
			// constants.
			for (const name of Object.keys(CAPABILITY_FIELDS)) {
				assert.ok(Object.hasOwn(CONSUMED_CAPABILITY_FIELDS, name), `core field ${name} must be consumed`);
			}
			const costKind: CapabilityValueKind | undefined = CONSUMED_CAPABILITY_FIELDS.input_cost_per_token;
			assert.strictEqual(costKind, "cost");
		});

		test("capabilityField reads own properties only, so prototype-named open fields cannot leak members", () => {
			const bag: Readonly<Record<string, CapabilityJsonValue | undefined>> = { toString: "own" };
			assert.strictEqual(capabilityField(bag, "toString"), "own");
			assert.strictEqual(capabilityField(bag, "constructor"), undefined);
			assert.strictEqual(capabilityField(bag, "__proto__"), undefined);
		});
	});
});

describe("dashboard/presenters number-unit grammars", () => {
	test("a setting's draft grammar refuses fractions exactly when its spec is integer-only", () => {
		// The integer-only fact has one source, the spec's `integer` flag, so a new
		// integer setting cannot ship a unit whose input accepts values the host
		// would silently floor.
		for (const id of Object.keys(NUMBER_SETTING_SPECS) as NumberSettingId[]) {
			const fractionReading = unitBehavior(id).parseDraft("1.5");
			assert.strictEqual(
				fractionReading === undefined,
				isIntegerSetting(id),
				`${id}: the draft grammar and the spec's integer flag disagree about fractions`
			);
		}
	});
});
