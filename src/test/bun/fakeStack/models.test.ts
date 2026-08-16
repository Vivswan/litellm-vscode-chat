import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { createCatalogLookup, parseCatalogSnapshot } from "../../../shared/config/openRouterCatalog";
import { catalogFixtureJson } from "../../catalogFixture";
import { FAKE_MODELS } from "../../fakeStack/models";

/**
 * Hermeticity canary for the fake stack's model names against the pinned
 * OpenRouter catalog fixture. The docker and host-fidelity hosts run
 * catalog-OFF; this pins the FIXTURE relationship, so the catalog-ON tests that
 * seed exactly this fixture can never have a fake-stack model silently
 * backfilling from it. A collision by exact ID or unambiguous post-vendor
 * suffix fails here.
 */
describe("fake stack models vs the pinned catalog fixture", () => {
	const snapshot = parseCatalogSnapshot(catalogFixtureJson());
	const lookup = createCatalogLookup(snapshot, { implicitLookup: true });

	test("the fixture parses to a non-trivial catalog", () => {
		// A fixture rename or emptying would make every not-found assertion below
		// pass vacuously.
		assert.ok(snapshot.models.length >= 5, `expected the pinned fixture's entries, got ${snapshot.models.length}`);
	});

	test("no fake-stack model ID matches the fixture by exact ID or suffix", () => {
		// Blocked models and upstream ids included: an upstream id registers through
		// direct-mode discovery, and a blocked alias unblocked later must not start
		// colliding silently.
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
