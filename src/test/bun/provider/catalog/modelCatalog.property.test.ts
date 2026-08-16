/**
 * The exposed-ID namespace round trip: rawModelIdFromExposed must invert
 * buildExposedModelId, because the dashboard's state builder recovers raw
 * model IDs (what requests and modelParameters prefixes match against) from
 * snapshot IDs without a route map.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fc from "fast-check";
import { buildExposedModelId, rawModelIdFromExposed } from "../../../../provider/catalog/modelCatalog";
import { resolveFuzzSeed } from "../../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

// Raw model IDs and server IDs as LiteLLM and the registry mint them; "/" is
// legal inside raw IDs (provider routes like "openai/gpt-4o"), so it stays in
// the alphabet on purpose.
const idChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.:-/");
const id = fc.string({ unit: idChar, minLength: 1, maxLength: 24 });

describe("provider/catalog modelCatalog exposed-ID properties", () => {
	test("multi-server exposed IDs round-trip exactly, whatever the raw ID contains", () => {
		fc.assert(
			fc.property(id, id, fc.integer({ min: 2, max: 9 }), (rawId, serverId, serverCount) => {
				const exposed = buildExposedModelId(rawId, serverId, serverCount);
				assert.strictEqual(exposed, `${serverId}/${rawId}`);
				assert.strictEqual(rawModelIdFromExposed(exposed, serverId), rawId);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("single-server IDs are already raw and pass through unless they spell the namespace themselves", () => {
		fc.assert(
			fc.property(id, id, fc.integer({ min: 0, max: 1 }), (rawId, serverId, serverCount) => {
				const exposed = buildExposedModelId(rawId, serverId, serverCount);
				assert.strictEqual(exposed, rawId);
				// The documented ambiguity: a raw ID beginning with "<serverId>/"
				// (which no LiteLLM route mints) would lose the prefix.
				if (!rawId.startsWith(`${serverId}/`)) {
					assert.strictEqual(rawModelIdFromExposed(exposed, serverId), rawId);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
