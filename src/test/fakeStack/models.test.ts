import * as assert from "node:assert";
import { createCatalogLookup, parseCatalogSnapshot } from "../../shared/config/openRouterCatalog";
import { catalogFixtureJson } from "../catalogFixture";
import { FAKE_MODELS } from "./models";

/**
 * Hermeticity canary for the fake stack's model names against the pinned
 * OpenRouter catalog fixture (src/test/fixtures/openrouter-models.json).
 *
 * Born from a real regate catch: the fake stack's realistic aliases
 * (llama-4-scout, gpt-5.2) once suffix-matched entries of the build-time
 * catalog artifact, so docker assertions pinned on "what the SERVER
 * declares" changed with whatever catalog snapshot the checkout happened to
 * carry. The docker and host-fidelity hosts now run catalog-OFF
 * (hostApiHelpers.catalogOff), which closes the hole against LIVE
 * artifacts; this canary pins the FIXTURE relationship, so the
 * docker-resolution suite's catalog-ON tests (which seed exactly this
 * fixture) can never have a fake-stack model silently backfilling from it.
 * A new fake model or a new fixture entry that collides by exact ID or by
 * unambiguous post-vendor suffix must fail here, loudly, at unit time.
 */
suite("fake stack models vs the pinned catalog fixture", () => {
	const snapshot = parseCatalogSnapshot(catalogFixtureJson());
	const lookup = createCatalogLookup(snapshot, { implicitLookup: true });

	test("the fixture parses to a non-trivial catalog", () => {
		// A fixture rename or emptying would make every not-found assertion
		// below pass vacuously.
		assert.ok(snapshot.models.length >= 5, `expected the pinned fixture's entries, got ${snapshot.models.length}`);
	});

	test("no fake-stack model ID matches the fixture by exact ID or suffix", () => {
		// Blocked models and upstream ids included: an upstream id registers
		// through direct-mode discovery, and a blocked alias unblocked later
		// must not start colliding silently.
		const stackIds = FAKE_MODELS.flatMap((model) => [
			model.alias,
			...model.deployments.map((deployment) => deployment.upstreamModel),
		]);
		assert.ok(stackIds.length >= 10, "the fake stack's model table is non-trivial");
		for (const id of stackIds) {
			const result = lookup.byRawModelId(id);
			assert.strictEqual(
				result.kind,
				"not-found",
				`fake-stack model "${id}" matches the pinned catalog fixture (${result.kind}); ` +
					"rename the model or the fixture entry - catalog-ON hosts seed this fixture and would backfill it"
			);
		}
	});
});
