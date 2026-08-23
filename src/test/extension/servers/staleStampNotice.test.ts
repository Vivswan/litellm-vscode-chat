/**
 * The stale-stamp consent notice (serverSync/staleStampNotice.ts): raised once
 * per mismatch state off the engine's "secretsMismatched" views, re-armed by a
 * changed mismatch rather than by every pass, and applying each answer through
 * the real blob machinery - "use-same" re-stamps the stored value for the
 * entry's current destination, "clear" deletes it - against a real
 * SecretStorage fake, with a fresh re-verification between the answer and the
 * write.
 */

import * as assert from "node:assert";
import type { DeclaredServerView } from "../../../extension/servers/serverSync";
import type { SecretStore } from "../../../extension/servers/serverSync/secrets";
import { readServerSecretsRecord, updateServerSecret } from "../../../extension/servers/serverSync/secrets";
import type {
	StaleStampAnswer,
	StaleStampNoticeEngine,
	StaleStampNoticeEnv,
} from "../../../extension/servers/serverSync/staleStampNotice";
import { StaleStampNotice } from "../../../extension/servers/serverSync/staleStampNotice";

function makeSecretStore(): SecretStore & { values: Map<string, string> } {
	const values = new Map<string, string>();
	return {
		values,
		get: async (key) => values.get(key),
		store: async (key, value) => {
			values.set(key, value);
		},
		delete: async (key) => {
			values.delete(key);
		},
	};
}

/** A mismatched view row: the engine's classification is the watcher's trigger. */
function mismatchedView(label: string): DeclaredServerView {
	return {
		label,
		baseUrl: "http://new.test",
		secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
		syncError: "mismatch",
		syncErrorClass: "secretsMismatched",
	} as DeclaredServerView;
}

interface World {
	store: SecretStore & { values: Map<string, string> };
	notice: StaleStampNotice;
	/** The scripted answer per ask; undefined is a dismissal. */
	answers: (StaleStampAnswer | undefined)[];
	/** When set, replaces the scripted answers (the held-open-notification test). */
	askOverride: ((label: string) => Promise<StaleStampAnswer | undefined>) | undefined;
	/** Runs INSIDE the recheck wait (the transient-state tests); resolves immediately by default. */
	delayOverride: (() => Promise<void>) | undefined;
	/** How many recheck waits ran. */
	delays: number;
	asks: string[];
	logs: string[];
	syncRequests: number;
	views: DeclaredServerView[];
	setting: unknown;
	fire: () => void;
}

function makeWorld(): World {
	const store = makeSecretStore();
	let listener: (() => void) | undefined;
	const world: Partial<World> = {
		store,
		answers: [],
		askOverride: undefined,
		delayOverride: undefined,
		delays: 0,
		asks: [],
		logs: [],
		syncRequests: 0,
		views: [],
		setting: [],
	};
	const engine: StaleStampNoticeEngine = {
		onDidSync: (fn) => {
			listener = fn;
			return { dispose: () => undefined };
		},
		getDeclared: () => world.views ?? [],
	};
	const env: StaleStampNoticeEnv = {
		readServersSetting: () => world.setting,
		secrets: store,
		ask: async (label) => {
			(world.asks as string[]).push(label);
			if (world.askOverride !== undefined) {
				return world.askOverride(label);
			}
			return (world.answers as (StaleStampAnswer | undefined)[]).shift();
		},
		requestSync: () => {
			world.syncRequests = (world.syncRequests ?? 0) + 1;
		},
		log: (message) => {
			(world.logs as string[]).push(message);
		},
		delay: async () => {
			world.delays = (world.delays ?? 0) + 1;
			await world.delayOverride?.();
		},
	};
	world.notice = new StaleStampNotice(engine, env);
	world.fire = () => listener?.();
	return world as World;
}

suite("serverSync stale-stamp notice", () => {
	/** One label with a stored key stamped for the OLD host while the entry names a new one. */
	async function seedMismatch(world: World, label = "Prod"): Promise<void> {
		await updateServerSecret(world.store, label, "apiKey", "sk-old", "http://old.test");
		world.setting = [{ label, baseUrl: "http://new.test" }];
		world.views = [mismatchedView(label)];
	}

	test("use-same re-stamps the stored value for the entry's current destination and requests a sync", async () => {
		const world = makeWorld();
		await seedMismatch(world);
		world.answers.push("use-same");
		await world.notice.scan();

		assert.deepStrictEqual(world.asks, ["Prod"]);
		assert.deepStrictEqual(await readServerSecretsRecord(world.store, "Prod"), {
			values: { apiKey: "sk-old" },
			owners: { apiKey: "http://new.test" },
		});
		assert.strictEqual(world.syncRequests, 1);
	});

	test("clear deletes the stored value and requests a sync", async () => {
		const world = makeWorld();
		await seedMismatch(world);
		world.answers.push("clear");
		await world.notice.scan();

		assert.deepStrictEqual(await readServerSecretsRecord(world.store, "Prod"), { values: {}, owners: {} });
		assert.strictEqual(world.syncRequests, 1);
	});

	test("a dismissed question does not re-raise while the same mismatch persists, pass after pass", async () => {
		const world = makeWorld();
		await seedMismatch(world);
		world.answers.push(undefined);
		await world.notice.scan();
		// The engine keeps classifying the entry mismatched on every later pass
		// (settings keystrokes, unrelated edits); the question must not spam.
		await world.notice.scan();
		await world.notice.scan();

		assert.deepStrictEqual(world.asks, ["Prod"]);
		assert.deepStrictEqual(await readServerSecretsRecord(world.store, "Prod"), {
			values: { apiKey: "sk-old" },
			owners: { apiKey: "http://old.test" },
		});
		assert.strictEqual(world.syncRequests, 0, "a dismissal changes nothing");
	});

	test("a changed mismatch re-arms a dismissed question; the same state asked twice never does", async () => {
		const world = makeWorld();
		await seedMismatch(world);
		world.answers.push(undefined);
		await world.notice.scan();
		assert.deepStrictEqual(world.asks, ["Prod"]);

		// The URL moves AGAIN: a different mismatch state, so it asks again.
		world.setting = [{ label: "Prod", baseUrl: "http://third.test" }];
		world.answers.push(undefined);
		await world.notice.scan();
		assert.deepStrictEqual(world.asks, ["Prod", "Prod"]);

		// Back to the already-dismissed state: still armed off.
		world.setting = [{ label: "Prod", baseUrl: "http://new.test" }];
		await world.notice.scan();
		assert.deepStrictEqual(world.asks, ["Prod", "Prod"]);
	});

	test("the sync-pass listener drives the scan", async () => {
		const world = makeWorld();
		await seedMismatch(world);
		world.answers.push("use-same");
		world.fire();
		// The listener's scan is fire-and-forget; settle its microtasks.
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.deepStrictEqual(world.asks, ["Prod"]);
		assert.deepStrictEqual((await readServerSecretsRecord(world.store, "Prod")).owners, {
			apiKey: "http://new.test",
		});
	});

	test("an answer arriving after the mismatch resolved is a no-op", async () => {
		const world = makeWorld();
		await seedMismatch(world);
		let release: (value: StaleStampAnswer | undefined) => void = () => undefined;
		world.askOverride = () =>
			new Promise<StaleStampAnswer | undefined>((resolve) => {
				release = resolve;
			});
		const scanning = world.notice.scan();
		// While the notification sits open, the user repairs the pairing by hand.
		await new Promise((resolve) => setTimeout(resolve, 0));
		await updateServerSecret(world.store, "Prod", "apiKey", "sk-old", "http://new.test");
		release("clear");
		await scanning;

		// The fresh re-verification found nothing refused, so nothing was cleared.
		assert.deepStrictEqual(await readServerSecretsRecord(world.store, "Prod"), {
			values: { apiKey: "sk-old" },
			owners: { apiKey: "http://new.test" },
		});
	});

	test("an answer arriving after the mismatch CHANGED mutates nothing; the new state asks its own question", async () => {
		const world = makeWorld();
		await seedMismatch(world);
		let release: (value: StaleStampAnswer | undefined) => void = () => undefined;
		world.askOverride = () =>
			new Promise<StaleStampAnswer | undefined>((resolve) => {
				release = resolve;
			});
		const scanning = world.notice.scan();
		await new Promise((resolve) => setTimeout(resolve, 0));
		// While the notification sits open, the URL moves AGAIN: a different
		// mismatch the user never saw. The old answer must not touch it.
		world.setting = [{ label: "Prod", baseUrl: "http://third.test" }];
		release("clear");
		await scanning;

		assert.deepStrictEqual(await readServerSecretsRecord(world.store, "Prod"), {
			values: { apiKey: "sk-old" },
			owners: { apiKey: "http://old.test" },
		});
		assert.ok(world.logs.some((line) => line.includes("after the mismatch changed")));
		// The changed state's own key is unasked, so the next pass asks again.
		world.askOverride = undefined;
		world.answers.push("clear");
		await world.notice.scan();
		assert.deepStrictEqual(world.asks, ["Prod", "Prod"]);
		assert.deepStrictEqual(await readServerSecretsRecord(world.store, "Prod"), { values: {}, owners: {} });
	});

	test("a transient mismatch that resolves inside the recheck wait never asks and burns no key", async () => {
		// The dashboard save's staged-write window: the blob is re-stamped for
		// the new URL before the settings write lands, so a pass caught inside
		// the window classifies the entry mismatched. The persistence gate must
		// let it evaporate - and must NOT burn the arming key, or the same
		// mismatch appearing later for real would be silently suppressed.
		const world = makeWorld();
		await seedMismatch(world);
		world.delayOverride = async () => {
			// The save's settings write lands during the wait.
			world.setting = [{ label: "Prod", baseUrl: "http://old.test" }];
		};
		await world.notice.scan();
		assert.deepStrictEqual(world.asks, [], "a transient mismatch is never asked about");
		assert.strictEqual(world.delays, 1);

		// The same mismatch later, for real: the key was not burned, so it asks.
		world.delayOverride = undefined;
		world.setting = [{ label: "Prod", baseUrl: "http://new.test" }];
		world.answers.push("use-same");
		await world.notice.scan();
		assert.deepStrictEqual(world.asks, ["Prod"]);
		assert.deepStrictEqual((await readServerSecretsRecord(world.store, "Prod")).owners, {
			apiKey: "http://new.test",
		});
	});

	test("a pass landing under an open notification queues ONE follow-up: the changed state's question still appears", async () => {
		// The changed state's sync pass may be its only event; a pending question
		// must not consume it. The follow-up evaluation runs when the open
		// question settles, so the new mismatch is asked about without waiting
		// for another settings change.
		const world = makeWorld();
		await seedMismatch(world);
		let release: (value: StaleStampAnswer | undefined) => void = () => undefined;
		world.askOverride = () =>
			new Promise<StaleStampAnswer | undefined>((resolve) => {
				release = resolve;
			});
		const first = world.notice.scan();
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The URL moves while the notification is open; its pass fires a scan
		// that the pending gate absorbs.
		world.setting = [{ label: "Prod", baseUrl: "http://third.test" }];
		await world.notice.scan();
		assert.deepStrictEqual(world.asks, ["Prod"], "the absorbed pass raised no second question yet");
		// The user dismisses the stale question; the queued rescan then asks
		// about the changed state on its own.
		world.askOverride = undefined;
		world.answers.push("clear");
		release(undefined);
		await first;
		assert.deepStrictEqual(world.asks, ["Prod", "Prod"], "the queued follow-up asked the new question");
		assert.deepStrictEqual(await readServerSecretsRecord(world.store, "Prod"), { values: {}, owners: {} });
	});

	test("only secretsMismatched views are evaluated; other classes never read the blob or ask", async () => {
		const world = makeWorld();
		await seedMismatch(world);
		world.views = [
			{ ...mismatchedView("Prod"), syncError: "upsert failed", syncErrorClass: "upsertFailed" } as DeclaredServerView,
			{ ...mismatchedView("Prod"), syncError: undefined, syncErrorClass: undefined } as DeclaredServerView,
		];
		await world.notice.scan();
		assert.deepStrictEqual(world.asks, []);
		assert.strictEqual(world.delays, 0, "no evaluation started at all");
	});

	test("one question per label at a time: passes landing under an open notification do not stack a second", async () => {
		const world = makeWorld();
		await seedMismatch(world);
		let release: (value: StaleStampAnswer | undefined) => void = () => undefined;
		world.askOverride = () =>
			new Promise<StaleStampAnswer | undefined>((resolve) => {
				release = resolve;
			});
		const first = world.notice.scan();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = world.notice.scan();
		await second;
		assert.deepStrictEqual(world.asks, ["Prod"], "the open question absorbs later passes");
		release("clear");
		await first;
		assert.deepStrictEqual(await readServerSecretsRecord(world.store, "Prod"), { values: {}, owners: {} });
	});

	test("distinct labels each get their own question in one pass", async () => {
		const world = makeWorld();
		await updateServerSecret(world.store, "A", "apiKey", "sk-a", "http://old-a.test");
		await updateServerSecret(world.store, "B", "virtualKeyValue", "vk-b", "http://old-b.test");
		world.setting = [
			{ label: "A", baseUrl: "http://new-a.test" },
			{ label: "B", baseUrl: "http://new-b.test", auth: { virtualKey: { header: "x-key" } } },
		];
		world.views = [mismatchedView("A"), mismatchedView("B")];
		world.answers.push("use-same", "clear");
		await world.notice.scan();

		assert.deepStrictEqual(world.asks, ["A", "B"]);
		assert.deepStrictEqual((await readServerSecretsRecord(world.store, "A")).owners, {
			apiKey: "http://new-a.test",
		});
		assert.deepStrictEqual(await readServerSecretsRecord(world.store, "B"), { values: {}, owners: {} });
	});

	test("a failed blob write forgets the arming key so the next pass asks again", async () => {
		const world = makeWorld();
		await seedMismatch(world);
		const realStore = world.store.store.bind(world.store);
		let failNext = true;
		world.store.store = async (key, value) => {
			if (failNext) {
				failNext = false;
				throw new Error("secret store refused");
			}
			await realStore(key, value);
		};
		world.answers.push("use-same");
		await world.notice.scan();
		assert.ok(world.logs.some((line) => line.includes("Applying the stale-stamped secret answer failed")));
		assert.strictEqual(world.syncRequests, 0);

		world.answers.push("use-same");
		await world.notice.scan();
		assert.deepStrictEqual(world.asks, ["Prod", "Prod"], "the failure re-arms the question");
		assert.deepStrictEqual((await readServerSecretsRecord(world.store, "Prod")).owners, {
			apiKey: "http://new.test",
		});
		assert.strictEqual(world.syncRequests, 1);
	});
});
