/**
 * The MCP publisher end to end in the host: what an eager provide pass may
 * carry, what resolve composes, and what moves the change event.
 *
 * The load-bearing test here is "provide carries no secret material". The
 * types already make headers unrepresentable on the provide-side descriptor,
 * but the definition VS Code receives is a plain object the editor may
 * serialize, so the value-level claim is pinned too - over an entry that
 * carries every kind of credential at once.
 */
import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import { createMcpServerDefinitionProvider } from "../../../../extension/features/mcp/provider";
import { McpVersionCounters } from "../../../../extension/features/mcp/versions";
import { wireMcpServers } from "../../../../extension/features/mcp/wiring";
import { updateServerSecret } from "../../../../extension/servers/serverSync/secrets";
import { OneShotClient } from "../../../../provider/transport/oneShotClient";
import { MCP_PROVIDER_ID } from "../../../../shared/config/commandIds";
import { MCP_ENTRY_VERSIONS_KEY, serverSecretsKey } from "../../../../shared/config/storageKeys";
import { Logger } from "../../../../shared/logger";
import { MirroredError } from "../../../../shared/mirroredError";
import { mswServer, TEST_BASE_URL, useMsw } from "../../../mocks/handlers";
import { withConfig } from "../../../testUtils";

const TOKEN_URL = "http://idp.test/oauth2/token";

/** Every credential shape at once, so the secretless claim is tested against all of them. */
const SECRET_VALUES = {
	apiKey: "sk-inline-secret",
	virtualKeyValue: "vk-inline-secret",
	oauthClientSecret: "oauth-inline-secret",
} as const;

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { label: "Main", baseUrl: TEST_BASE_URL, mcp: true, ...overrides };
}

/** A Memento standing in for globalState; the counters only ever read and write one key. */
interface TestMemento extends vscode.Memento {
	readonly values: Map<string, unknown>;
	/** While true every write rejects, the way a failing globalState does. */
	failWrites: boolean;
}

function memento(): TestMemento {
	const values = new Map<string, unknown>();
	const store = {
		values,
		failWrites: false,
		keys: () => [...values.keys()],
		get: <T>(key: string) => values.get(key) as T | undefined,
		update: async (key: string, value: unknown) => {
			if (store.failWrites) {
				throw new Error("globalState write failed");
			}
			values.set(key, value);
		},
	};
	return store as unknown as TestMemento;
}

function quietLogger(): Logger {
	return new Logger({ info() {}, error() {} });
}

/** Let a listener's promise tail run: a macrotask turn drains every microtask queued before it. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A SecretStorage that holds nothing: the entries in this suite keep their secrets inline. */
function emptySecrets(): vscode.SecretStorage {
	return {
		get: async () => undefined,
		store: async () => {},
		delete: async () => {},
		onDidChange: () => new vscode.Disposable(() => {}),
	} as unknown as vscode.SecretStorage;
}

/** The provider under test. */
function makeProvider(
	options: { logged?: [string, unknown?][]; versions?: McpVersionCounters } = {}
): vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> {
	return createMcpServerDefinitionProvider(
		{
			secrets: emptySecrets(),
			oneShot: new OneShotClient({ userAgent: "test-agent" }),
			versions: options.versions ?? new McpVersionCounters(memento()),
			advisory: (message, data) => options.logged?.push([message, data]),
			logError: (message, error) => options.logged?.push([message, error]),
		},
		new vscode.EventEmitter<void>().event
	);
}

async function provide(
	provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition>
): Promise<readonly vscode.McpHttpServerDefinition[]> {
	const source = new vscode.CancellationTokenSource();
	try {
		return (await provider.provideMcpServerDefinitions(source.token)) ?? [];
	} finally {
		source.dispose();
	}
}

async function resolve(
	provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition>,
	definition: vscode.McpHttpServerDefinition
): Promise<vscode.McpHttpServerDefinition> {
	const source = new vscode.CancellationTokenSource();
	try {
		const resolved = await provider.resolveMcpServerDefinition?.(definition, source.token);
		assert.ok(resolved, "resolve must answer with the definition");
		return resolved;
	} finally {
		source.dispose();
	}
}

suite("extension/features/mcp", () => {
	useMsw();

	suite("provide", () => {
		test("carries no secret material, for any credential shape the entry holds", async () => {
			const servers = [
				entry({
					auth: {
						oauth: {
							tokenUrl: TOKEN_URL,
							clientId: "client-1",
							clientSecret: SECRET_VALUES.oauthClientSecret,
							apiKey: SECRET_VALUES.apiKey,
							virtualKey: { header: "x-litellm-key", value: SECRET_VALUES.virtualKeyValue },
						},
					},
				}),
			];
			const provider = makeProvider();
			const definitions = await withConfig({ servers }, () => provide(provider));

			assert.strictEqual(definitions.length, 1);
			const rendered = JSON.stringify(definitions.map((d) => ({ ...d, uri: d.uri.toString() })));
			for (const value of Object.values(SECRET_VALUES)) {
				assert.ok(!rendered.includes(value), `the eager pass must not carry ${value}`);
			}
			assert.deepStrictEqual(definitions[0]?.headers, {}, "no headers at all, not merely no credential ones");
		});

		test("publishes exactly the opted-in entries, at the derived or named endpoint", async () => {
			const servers = [
				entry({ label: "Derived" }),
				entry({ label: "Named", mcp: { url: "https://gw.example/tools/mcp" } }),
				entry({ label: "OptedOut", mcp: false }),
				{ label: "NoField", baseUrl: TEST_BASE_URL },
			];
			const definitions = await withConfig({ servers }, () => provide(makeProvider()));

			assert.deepStrictEqual(
				definitions.map((d) => [d.label, d.uri.toString()]),
				[
					["Derived", `${TEST_BASE_URL}/mcp`],
					["Named", "https://gw.example/tools/mcp"],
				]
			);
		});

		test("no opted-in entries, no definitions - the provider still answers", async () => {
			assert.deepStrictEqual(await withConfig({ servers: [] }, () => provide(makeProvider())), []);
		});

		test("the rotation counter rides as the version string", async () => {
			const versions = new McpVersionCounters(memento());
			const provider = makeProvider({ versions });
			const servers = [entry()];
			assert.strictEqual((await withConfig({ servers }, () => provide(provider)))[0]?.version, "0");
			await versions.bump("Main");
			await versions.bump("Main");
			assert.strictEqual((await withConfig({ servers }, () => provide(provider)))[0]?.version, "2");
		});
	});

	suite("resolve", () => {
		test("composes exactly the headers a request to the same server would carry", async () => {
			const servers = [
				entry({
					auth: { apiKey: SECRET_VALUES.apiKey, virtualKey: { header: "x-litellm-key", value: "vk-1" } },
					headers: { "x-routing-env": "prod" },
				}),
			];
			const provider = makeProvider();
			const [definition] = await withConfig({ servers }, () => provide(provider));
			assert.ok(definition);
			const resolved = await withConfig({ servers }, () => resolve(provider, definition));

			assert.strictEqual(resolved.headers.Authorization, `Bearer ${SECRET_VALUES.apiKey}`);
			assert.strictEqual(resolved.headers["X-API-Key"], SECRET_VALUES.apiKey);
			assert.strictEqual(resolved.headers["x-litellm-key"], "vk-1");
			assert.strictEqual(resolved.headers["x-routing-env"], "prod");
			assert.strictEqual(resolved.headers["User-Agent"], "test-agent");
			assert.strictEqual(resolved.uri.toString(), `${TEST_BASE_URL}/mcp`, "resolve never moves the endpoint");
		});

		test("an endpoint on another origin is published, but bare: credentials stay with the entry's host", async () => {
			// The stored key is paired with the entry's base URL. A URL pointing
			// somewhere else is a destination nothing authorized, so the server is
			// still offered - it may need no credential - but ours do not ride.
			const servers = [
				entry({
					mcp: { url: "https://elsewhere.example/mcp" },
					auth: { apiKey: SECRET_VALUES.apiKey, virtualKey: { header: "x-litellm-key", value: "vk-1" } },
					headers: { "x-routing-env": "prod" },
				}),
			];
			const provider = makeProvider();
			const [definition] = await withConfig({ servers }, () => provide(provider));
			assert.ok(definition);
			const resolved = await withConfig({ servers }, () => resolve(provider, definition));

			assert.deepStrictEqual(resolved.headers, {}, "no header at all, credential or otherwise");
			assert.strictEqual(resolved.uri.toString(), "https://elsewhere.example/mcp", "it is still published");
		});

		test("another PATH on the entry's own origin is the documented case and stays credentialed", async () => {
			const servers = [entry({ mcp: { url: `${TEST_BASE_URL}/tools/mcp` }, auth: { apiKey: SECRET_VALUES.apiKey } })];
			const provider = makeProvider();
			const [definition] = await withConfig({ servers }, () => provide(provider));
			assert.ok(definition);
			const resolved = await withConfig({ servers }, () => resolve(provider, definition));
			assert.strictEqual(resolved.headers.Authorization, `Bearer ${SECRET_VALUES.apiKey}`);
		});

		test("a same-origin endpoint on another scheme or port is not the same origin", async () => {
			// Origin is scheme + host + port, so a downgrade to http or a hop to
			// another port is a different destination and loses the credentials.
			const url = new URL(TEST_BASE_URL);
			for (const elsewhere of [`https://${url.host}/mcp`, `${url.protocol}//${url.hostname}:9999/mcp`]) {
				const servers = [entry({ mcp: { url: elsewhere }, auth: { apiKey: SECRET_VALUES.apiKey } })];
				const provider = makeProvider();
				const [definition] = await withConfig({ servers }, () => provide(provider));
				assert.ok(definition);
				const resolved = await withConfig({ servers }, () => resolve(provider, definition));
				assert.deepStrictEqual(resolved.headers, {}, `${elsewhere} must not be credentialed`);
			}
		});

		test("exchanges an OAuth token and sends it as the bearer", async () => {
			const exchanges: string[] = [];
			mswServer.use(
				http.post(TOKEN_URL, async ({ request }) => {
					exchanges.push(await request.text());
					return HttpResponse.json({ access_token: "tok-mcp", token_type: "Bearer", expires_in: 3600 });
				})
			);
			const servers = [
				entry({
					auth: { oauth: { tokenUrl: TOKEN_URL, clientId: "client-1", clientSecret: "shh" } },
				}),
			];
			const provider = makeProvider();
			const [definition] = await withConfig({ servers }, () => provide(provider));
			assert.ok(definition);
			const resolved = await withConfig({ servers }, () => resolve(provider, definition));

			assert.strictEqual(exchanges.length, 1, "the exchange happens in resolve, not before it");
			assert.strictEqual(resolved.headers.Authorization, "Bearer tok-mcp");
		});

		test("a definition whose entry stopped publishing is refused, not credentialed", async () => {
			// The editor may hold a definition from before an edit retired the
			// opt-in. Attaching current credentials to it would send them to an
			// endpoint the setting no longer names.
			const provider = makeProvider();
			const [definition] = await withConfig({ servers: [entry({ auth: { apiKey: "sk-1" } })] }, () =>
				provide(provider)
			);
			assert.ok(definition);
			for (const servers of [[entry({ mcp: false })], [{ label: "Main", baseUrl: TEST_BASE_URL }]]) {
				await withConfig({ servers }, async () => {
					await assert.rejects(() => resolve(provider, definition), MirroredError);
				});
				assert.deepStrictEqual(definition.headers, {}, "a refused resolve attaches nothing");
			}
		});

		test("the endpoint that goes out is the one published NOW, not the one handed back", async () => {
			// Same reason: a stale URI must never receive live credentials.
			const provider = makeProvider();
			const [definition] = await withConfig({ servers: [entry()] }, () => provide(provider));
			assert.ok(definition);
			// Same origin, so this stays credentialed and the assertion is about the
			// URI alone; the cross-origin case has its own test above.
			const moved = [entry({ mcp: { url: `${TEST_BASE_URL}/moved/mcp` }, auth: { apiKey: "sk-1" } })];
			const resolved = await withConfig({ servers: moved }, () => resolve(provider, definition));
			assert.strictEqual(resolved.uri.toString(), `${TEST_BASE_URL}/moved/mcp`);
			assert.strictEqual(resolved.headers.Authorization, "Bearer sk-1");
		});

		test("a setting edit DURING the exchange is refused, not answered with live credentials", async () => {
			// The window the pre-await check alone cannot close: the opt-in is
			// retired while the token exchange is in flight.
			let release: (() => void) | undefined;
			mswServer.use(
				http.post(
					TOKEN_URL,
					() =>
						new Promise<Response>((resolve) => {
							release = () => resolve(HttpResponse.json({ access_token: "tok", token_type: "Bearer" }));
						})
				)
			);
			const oauthEntry = entry({ auth: { oauth: { tokenUrl: TOKEN_URL, clientId: "c", clientSecret: "s" } } });
			const provider = makeProvider();
			const [definition] = await withConfig({ servers: [oauthEntry] }, () => provide(provider));
			assert.ok(definition);

			// Start the resolve under the opted-in setting, then swap the setting
			// out from under it before letting the exchange finish.
			let pending: Promise<vscode.McpHttpServerDefinition> | undefined;
			await withConfig({ servers: [oauthEntry] }, async () => {
				pending = resolve(provider, definition);
				// Let the exchange reach the token endpoint before the swap.
				while (release === undefined) {
					await new Promise((tick) => setTimeout(tick, 5));
				}
			});
			await withConfig({ servers: [] }, async () => {
				release?.();
				await assert.rejects(
					() => pending as Promise<unknown>,
					(error: unknown) => {
						// The classification, not merely the type: a FAILED exchange
						// would also throw a MirroredError and pass a type-only check.
						// The entry was DELETED mid-exchange, so "no such server" is
						// the true fact - "try again" would send the user in circles.
						assert.ok(error instanceof MirroredError);
						assert.strictEqual(error.logClassification, "Mcp(resolved label is not published)");
						return true;
					}
				);
			});
			assert.deepStrictEqual(definition.headers, {}, "a refused resolve attaches nothing");
		});

		test("the resolved definition carries the CURRENT rotation as its version", async () => {
			const versions = new McpVersionCounters(memento());
			const provider = makeProvider({ versions });
			const servers = [entry({ auth: { apiKey: "sk-1" } })];
			const [definition] = await withConfig({ servers }, () => provide(provider));
			assert.ok(definition);
			assert.strictEqual(definition.version, "0");

			await versions.bump("Main");
			const resolved = await withConfig({ servers }, () => resolve(provider, definition));
			assert.strictEqual(resolved.version, "1", "a rotation since the provide must reach the resolved definition");
		});

		test("a failed token exchange is logged exactly once, as a classification", async () => {
			// RequestError extends MirroredError, so a base-class check here would
			// silence every real failure: the OAuth refusal below would reach no
			// log line and never become the issue report's latest error.
			mswServer.use(http.post(TOKEN_URL, () => HttpResponse.json({ error: "invalid_client" }, { status: 401 })));
			const logged: [string, unknown?][] = [];
			const provider = makeProvider({ logged });
			const servers = [entry({ auth: { oauth: { tokenUrl: TOKEN_URL, clientId: "c", clientSecret: "shh" } } })];
			const [definition] = await withConfig({ servers }, () => provide(provider));
			assert.ok(definition);

			await withConfig({ servers }, async () => {
				await assert.rejects(() => resolve(provider, definition));
			});
			const failures = logged.filter(([message]) => message === "MCP resolve failed");
			assert.strictEqual(failures.length, 1, `expected one failure line, got ${JSON.stringify(logged)}`);
			assert.ok(!JSON.stringify(logged).includes("shh"), "no log line carries the client secret");
		});

		test("a stored secret stamped for another destination refuses the pairing", async () => {
			// The chat path already refuses this (the sync engine's ownership
			// check). Here it matters more: the credentials leave our process, so
			// no 401 of ours could ever correct a wrong pairing.
			const blobs = new Map<string, string>();
			const store: vscode.SecretStorage = {
				get: async (key: string) => blobs.get(key),
				store: async (key: string, value: string) => {
					blobs.set(key, value);
				},
				delete: async (key: string) => {
					blobs.delete(key);
				},
				onDidChange: () => new vscode.Disposable(() => {}),
			} as unknown as vscode.SecretStorage;
			// Stored while the entry pointed at another host, then the entry moved.
			await updateServerSecret(store, "Main", "apiKey", "sk-retired", "http://retired.test");

			const provider = createMcpServerDefinitionProvider(
				{
					secrets: store,
					oneShot: new OneShotClient({ userAgent: "test-agent" }),
					versions: new McpVersionCounters(memento()),
					advisory: () => {},
					logError: () => {},
				},
				new vscode.EventEmitter<void>().event
			);
			const servers = [entry()];
			const [definition] = await withConfig({ servers }, () => provide(provider));
			assert.ok(definition);
			await withConfig({ servers }, async () => {
				await assert.rejects(
					() => resolve(provider, definition),
					(error: unknown) => {
						// Its own sentence: "no such server" would send the user
						// looking for a missing entry instead of re-storing the key.
						assert.ok(error instanceof MirroredError);
						assert.strictEqual(error.logClassification, "Mcp(stored secrets stamped for another destination)");
						assert.ok(error.englishMessage?.includes("saved for a different server"));
						return true;
					}
				);
			});
			assert.deepStrictEqual(definition.headers, {}, "a refused pairing attaches nothing");
		});

		test("an inert stale stamp resolves; declaring the field's shape refuses the same stored value", async () => {
			// Refusal is scoped by the one wire rule (entryUsesSecretField): a
			// stale-stamped virtualKeyValue with no declared header has no carrier
			// (usageConnectionFor builds the virtualKey unit only with a header),
			// so the pairing resolves - and none of the composed headers may carry
			// the stored value.
			const blobs = new Map<string, string>();
			const store: vscode.SecretStorage = {
				get: async (key: string) => blobs.get(key),
				store: async (key: string, value: string) => {
					blobs.set(key, value);
				},
				delete: async (key: string) => {
					blobs.delete(key);
				},
				onDidChange: () => new vscode.Disposable(() => {}),
			} as unknown as vscode.SecretStorage;
			await updateServerSecret(store, "Main", "virtualKeyValue", "vk-stale-stamped", "http://retired.test");

			const provider = createMcpServerDefinitionProvider(
				{
					secrets: store,
					oneShot: new OneShotClient({ userAgent: "test-agent" }),
					versions: new McpVersionCounters(memento()),
					advisory: () => {},
					logError: () => {},
				},
				new vscode.EventEmitter<void>().event
			);
			const inertServers = [entry({ auth: { apiKey: SECRET_VALUES.apiKey } })];
			const [definition] = await withConfig({ servers: inertServers }, () => provide(provider));
			assert.ok(definition);
			const resolved = await withConfig({ servers: inertServers }, () => resolve(provider, definition));
			// The positive control keeps the negative claim meaningful: the inline
			// apiKey DID compose into the handed headers, so an empty-headers
			// regression (a flipped origin verdict) cannot fake the pass below.
			assert.ok(
				JSON.stringify(resolved.headers).includes(SECRET_VALUES.apiKey),
				"the entry's own credential composes into the handed headers"
			);
			assert.ok(
				!JSON.stringify(resolved.headers).includes("vk-stale-stamped"),
				"the inert stored value must never reach the handed headers"
			);

			// The field-becomes-used transition: declaring the header makes the
			// entry's shape send the field, so the SAME stored value now refuses
			// before any header composition - unchanged for sendable credentials.
			const usedServers = [entry({ auth: { apiKey: SECRET_VALUES.apiKey, virtualKey: { header: "x-litellm-key" } } })];
			const [republished] = await withConfig({ servers: usedServers }, () => provide(provider));
			assert.ok(republished);
			await withConfig({ servers: usedServers }, async () => {
				await assert.rejects(
					() => resolve(provider, republished),
					(error: unknown) => {
						assert.ok(error instanceof MirroredError);
						assert.strictEqual(error.logClassification, "Mcp(stored secrets stamped for another destination)");
						return true;
					}
				);
			});
			assert.deepStrictEqual(republished.headers, {}, "a refused pairing attaches nothing");
		});

		test("an unparseable endpoint is published bare rather than credentialed", async () => {
			// The fail-closed arm of the origin check: junk is not this entry's origin.
			const servers = [entry({ mcp: { url: "not a url" }, auth: { apiKey: SECRET_VALUES.apiKey } })];
			const provider = makeProvider();
			const [definition] = await withConfig({ servers }, () => provide(provider));
			assert.ok(definition);
			const resolved = await withConfig({ servers }, () => resolve(provider, definition));
			assert.deepStrictEqual(resolved.headers, {});
		});

		test("a base URL that moves during the exchange refuses: it is what decided the credentials", async () => {
			// The endpoint URL and the version can both stay put while baseUrl moves,
			// flipping the same-origin verdict the headers were composed under.
			let release: (() => void) | undefined;
			mswServer.use(
				http.post(
					TOKEN_URL,
					() =>
						new Promise<Response>((resolve) => {
							release = () => resolve(HttpResponse.json({ access_token: "tok", token_type: "Bearer" }));
						})
				)
			);
			const named = (baseUrl: string) => [
				{
					label: "Main",
					baseUrl,
					mcp: { url: `${TEST_BASE_URL}/mcp` },
					auth: { oauth: { tokenUrl: TOKEN_URL, clientId: "c", clientSecret: "s" } },
				},
			];
			const provider = makeProvider();
			const [definition] = await withConfig({ servers: named(TEST_BASE_URL) }, () => provide(provider));
			assert.ok(definition);

			let pending: Promise<vscode.McpHttpServerDefinition> | undefined;
			await withConfig({ servers: named(TEST_BASE_URL) }, async () => {
				pending = resolve(provider, definition);
				while (release === undefined) {
					await new Promise((tick) => setTimeout(tick, 5));
				}
			});
			await withConfig({ servers: named("https://moved.example") }, async () => {
				release?.();
				await assert.rejects(
					() => pending as Promise<unknown>,
					(error: unknown) => {
						assert.ok(error instanceof MirroredError);
						assert.strictEqual(error.logClassification, "Mcp(entry changed during resolve)");
						return true;
					}
				);
			});
			assert.deepStrictEqual(definition.headers, {});
		});

		test("a label no entry carries refuses with an English mirror", async () => {
			const provider = makeProvider();
			const [definition] = await withConfig({ servers: [entry()] }, () => provide(provider));
			assert.ok(definition);

			// The editor may hold a definition from before an edit removed the entry.
			await withConfig({ servers: [] }, async () => {
				try {
					await resolve(provider, definition);
					assert.fail("expected the resolve to reject");
				} catch (error) {
					assert.ok(error instanceof MirroredError, `expected a MirroredError, got ${String(error)}`);
					assert.ok(error.englishMessage?.includes('"Main"'));
					assert.strictEqual(error.logClassification, "Mcp(resolved label is not published)");
				}
			});
		});

		test("the log line redacts URL-embedded credentials", async () => {
			// A configured URL may embed userinfo, and log lines feed public issue
			// reports; the redaction is enforced in the code, not promised in prose.
			const logged: [string, unknown?][] = [];
			const provider = makeProvider({ logged });
			const servers = [entry({ mcp: { url: "https://user:hunter2@gw.example/mcp" } })];
			const [definition] = await withConfig({ servers }, () => provide(provider));
			assert.ok(definition);
			await withConfig({ servers }, () => resolve(provider, definition));

			const rendered = JSON.stringify(logged);
			assert.ok(!rendered.includes("hunter2"), "no log line carries the embedded credential");
			assert.ok(rendered.includes("gw.example/mcp"), "the endpoint itself still identifies the server");
		});
	});

	suite("wiring: the change event", () => {
		interface WiredSpies {
			readonly registered: string[];
			readonly changes: number;
			fireConfigChange(): Promise<void>;
			fireSecretChange(key: string): Promise<void>;
			readonly store: TestMemento;
		}

		/** Wire the feature with the host surfaces recorded, and run `fn` against them. */
		async function withWiring(initialServers: unknown[], fn: (spies: WiredSpies) => Promise<void>): Promise<void> {
			// One array, so an id can never be sliced by the other's index.
			const registrations: { id: string; provider: vscode.McpServerDefinitionProvider }[] = [];
			const configListeners: ((event: vscode.ConfigurationChangeEvent) => unknown)[] = [];
			const secretListeners: ((event: vscode.SecretStorageChangeEvent) => unknown)[] = [];
			let changes = 0;
			const store = memento();

			// The spies are global while installed, and the production extension is
			// activated in this host, so anything IT registers while they are in
			// place would otherwise count as ours. The spies therefore only COLLECT,
			// and the call under test is bracketed by BOTH indices, captured inside
			// the synchronous callback: a lower bound alone proves nothing here
			// (these arrays start empty, so it is always zero), and the window that
			// actually admits a stray registration is the await AFTER the call.
			const originalRegister = vscode.lm.registerMcpServerDefinitionProvider;
			const originalOnDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration;
			(vscode.lm as Record<string, unknown>).registerMcpServerDefinitionProvider = (
				id: string,
				provider: vscode.McpServerDefinitionProvider
			) => {
				registrations.push({ id, provider });
				return new vscode.Disposable(() => {});
			};
			(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = (
				listener: (event: vscode.ConfigurationChangeEvent) => unknown
			) => {
				configListeners.push(listener);
				return new vscode.Disposable(() => {});
			};

			const context = {
				subscriptions: [] as vscode.Disposable[],
				globalState: store,
				secrets: {
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (listener: (event: vscode.SecretStorageChangeEvent) => unknown) => {
						secretListeners.push(listener);
						return new vscode.Disposable(() => {});
					},
				},
			} as unknown as vscode.ExtensionContext;

			try {
				// Both bounds are read inside the synchronous callback, so the range
				// is exactly what wireMcpServers appended and nothing that lands
				// while the surrounding await settles.
				let ours = { registrations: [0, 0], listeners: [0, 0] };
				await withConfig({ servers: initialServers }, () => {
					const from = { registrations: registrations.length, listeners: configListeners.length };
					wireMcpServers(context, quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
					ours = {
						registrations: [from.registrations, registrations.length],
						listeners: [from.listeners, configListeners.length],
					};
				});
				const mine = registrations.slice(ours.registrations[0], ours.registrations[1]);
				for (const { provider } of mine) {
					provider.onDidChangeMcpServerDefinitions?.(() => {
						changes += 1;
					});
				}
				await fn({
					registered: mine.map((registration) => registration.id),
					get changes() {
						return changes;
					},
					store,
					// The wiring's listeners are synchronous - VS Code does not await
					// what a handler returns - and hand their counter writes to a
					// promise tail. So dispatching is not enough: the helpers settle
					// that tail before the assertions read it.
					fireConfigChange: async () => {
						for (const listener of configListeners.slice(ours.listeners[0], ours.listeners[1])) {
							listener({ affectsConfiguration: () => true });
						}
						await settle();
					},
					fireSecretChange: async (key) => {
						for (const listener of [...secretListeners]) {
							listener({ key });
						}
						await settle();
					},
				} as WiredSpies);
			} finally {
				(vscode.lm as Record<string, unknown>).registerMcpServerDefinitionProvider = originalRegister;
				(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = originalOnDidChangeConfiguration;
			}
		}

		test("registers under the pinned contribution id, with nothing opted in", async () => {
			await withWiring([], async (spies) => {
				assert.deepStrictEqual(spies.registered, [MCP_PROVIDER_ID]);
				assert.strictEqual(spies.changes, 0, "activation is not a change");
			});
		});

		test("an entry gaining the opt-in fires; an edit that leaves the list identical does not", async () => {
			await withWiring([{ label: "Main", baseUrl: TEST_BASE_URL }], async (spies) => {
				await withConfig({ servers: [{ label: "Main", baseUrl: TEST_BASE_URL, budget: 50 }] }, () =>
					spies.fireConfigChange()
				);
				assert.strictEqual(spies.changes, 0, "a budget edit publishes nothing new");

				await withConfig({ servers: [entry()] }, () => spies.fireConfigChange());
				assert.strictEqual(spies.changes, 1, "the opt-in publishes a server");

				await withConfig({ servers: [entry()] }, () => spies.fireConfigChange());
				assert.strictEqual(spies.changes, 1, "an unchanged pass stays quiet");

				await withConfig({ servers: [entry({ mcp: { url: "https://gw.example/mcp" } })] }, () =>
					spies.fireConfigChange()
				);
				assert.strictEqual(spies.changes, 2, "a moved endpoint is a new published list");
			});
		});

		test("a secure-side rotation bumps the version and fires, whoever wrote the secret", async () => {
			await withWiring([entry()], async (spies) => {
				await withConfig({ servers: [entry()] }, () => spies.fireSecretChange(serverSecretsKey("Main")));
				assert.strictEqual(spies.changes, 1);
				assert.deepStrictEqual(spies.store.get(MCP_ENTRY_VERSIONS_KEY), { Main: 1 });

				// Another label's blob is not this entry's rotation.
				await withConfig({ servers: [entry()] }, () => spies.fireSecretChange(serverSecretsKey("Other")));
				assert.strictEqual(spies.changes, 1);
				assert.deepStrictEqual(spies.store.get(MCP_ENTRY_VERSIONS_KEY), { Main: 1 });
			});
		});

		test("a failed counter write leaves the old counter; the next rotation still bumps and fires", async () => {
			// Nothing retries a failed write, deliberately: the version is an
			// opaque change token nobody reads as a count, so the worst case is
			// the editor serving its previous cached credential until the next
			// rotation moves the counter anyway - which this pins.
			await withWiring([entry()], async (spies) => {
				spies.store.failWrites = true;
				await withConfig({ servers: [entry()] }, () => spies.fireSecretChange(serverSecretsKey("Main")));
				assert.strictEqual(spies.store.get(MCP_ENTRY_VERSIONS_KEY), undefined, "the write really failed");
				assert.strictEqual(spies.changes, 0, "nothing new to publish while the counter did not move");

				// No later event retries the failed write: this pass would have
				// replayed it under the old recovery layer, and must not now.
				spies.store.failWrites = false;
				await withConfig({ servers: [entry()] }, () => spies.fireConfigChange());
				assert.strictEqual(spies.store.get(MCP_ENTRY_VERSIONS_KEY), undefined, "no retry writes the counter");
				assert.strictEqual(spies.changes, 0, "no retry publishes anything");

				// The next rotation is its own signal, and its write lands.
				await withConfig({ servers: [entry()] }, () => spies.fireSecretChange(serverSecretsKey("Main")));
				assert.deepStrictEqual(spies.store.get(MCP_ENTRY_VERSIONS_KEY), { Main: 1 });
				assert.strictEqual(spies.changes, 1, "the next rotation publishes a new version");
			});
		});

		test("a failed write for one label does not abandon the rest of the batch", async () => {
			await withWiring([entry({ label: "A" }), entry({ label: "B" })], async (spies) => {
				// Both labels rotate; only the first write fails.
				let writes = 0;
				const store = spies.store;
				const realUpdate = store.update.bind(store);
				(store as unknown as { update: vscode.Memento["update"] }).update = async (key, value) => {
					writes += 1;
					if (writes === 1) {
						throw new Error("globalState write failed");
					}
					await realUpdate(key, value);
				};
				const rotated = [
					entry({ label: "A", auth: { apiKey: "sk-a" } }),
					entry({ label: "B", auth: { apiKey: "sk-b" } }),
				];
				await withConfig({ servers: rotated }, () => spies.fireConfigChange());
				assert.deepStrictEqual(store.get(MCP_ENTRY_VERSIONS_KEY), { B: 1 }, "B landed despite A failing");
			});
		});

		test("an inline-secret edit rotates too, though no published field changed", async () => {
			const withKey = (apiKey: string) => [entry({ auth: { apiKey } })];
			await withWiring(withKey("sk-first"), async (spies) => {
				await withConfig({ servers: withKey("sk-first") }, () => spies.fireConfigChange());
				assert.strictEqual(spies.changes, 0, "the same key is not a rotation");

				await withConfig({ servers: withKey("sk-second") }, () => spies.fireConfigChange());
				assert.strictEqual(spies.changes, 1);
				assert.deepStrictEqual(spies.store.get(MCP_ENTRY_VERSIONS_KEY), { Main: 1 });
			});
		});
	});
});
