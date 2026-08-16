/**
 * Fetch, validate, slim, and (by default) write the OpenRouter capability
 * catalog artifact to dist/openrouter-models.json. Strict on purpose: any
 * failure exits non-zero, so a release build and the packaged-file-list CI check
 * can never ship a missing or semantically empty catalog. `--check` runs the
 * same fetch and validation into a temp file and never touches dist/.
 *
 * bundle/bundle:dev deliberately do NOT run this: builds stay network-free and
 * the runtime tolerates a missing artifact. Failure messages distinguish
 * OpenRouter being unreachable (transient) from the payload no longer matching
 * src/shared/config/openRouterCatalog.ts (drift - update the module).
 */

import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	CATALOG_MODEL_COUNT_FLOOR,
	type CatalogModel,
	OPENROUTER_MODELS_URL,
	parseCatalogSnapshot,
	slimCatalogPayload,
} from "../../src/shared/config/openRouterCatalog";

const FETCH_TIMEOUT_MS = 60_000;

/** Transient failures retry (idempotent GET; CI runners hit rate limits), schema drift never does. */
const FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

class UnreachableError extends Error {}
class DriftError extends Error {}

async function fetchOnce(): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	} catch (error) {
		throw new UnreachableError(error instanceof Error ? error.message : String(error));
	}
	if (!response.ok) {
		throw new UnreachableError(`HTTP ${response.status} from ${OPENROUTER_MODELS_URL}`);
	}
	try {
		return await response.json();
	} catch {
		// A 200 with a non-JSON body is an interstitial or truncation, not a
		// schema statement.
		throw new UnreachableError("the response body is not JSON");
	}
}

async function fetchLivePayload(): Promise<unknown> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await fetchOnce();
		} catch (error) {
			if (!(error instanceof UnreachableError) || attempt >= FETCH_ATTEMPTS) {
				throw error;
			}
			console.error(`Attempt ${attempt}/${FETCH_ATTEMPTS} failed (${error.message}); retrying in ${RETRY_DELAY_MS}ms`);
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
		}
	}
}

/** Fraction of models that must satisfy a predicate for the payload to look healthy. */
function assertShare(models: readonly CatalogModel[], floor: number, what: string, has: (m: CatalogModel) => boolean) {
	const count = models.filter(has).length;
	if (count < models.length * floor) {
		throw new DriftError(`only ${count} of ${models.length} models carry ${what} (expected >= ${floor * 100}%)`);
	}
}

function assertSome(models: readonly CatalogModel[], what: string, has: (m: CatalogModel) => boolean) {
	if (!models.some(has)) {
		throw new DriftError(`no model carries ${what}; the mapping is producing nothing for it`);
	}
}

/** Validate the live payload and return its slimmed artifact text. Throws DriftError on any anomaly. */
function validateAndSlim(payload: unknown): { text: string; modelCount: number } {
	const raw = parseCatalogSnapshot(payload);
	if (raw.models.length < CATALOG_MODEL_COUNT_FLOOR) {
		throw new DriftError(
			`payload yields ${raw.models.length} usable models (floor ${CATALOG_MODEL_COUNT_FLOOR}); ` +
				"either the endpoint shape changed or entries stopped carrying string ids"
		);
	}

	const slim = slimCatalogPayload(payload);
	const models = parseCatalogSnapshot(slim).models;
	if (models.length !== raw.models.length) {
		throw new DriftError(`slimming lost models (${raw.models.length} raw vs ${models.length} slimmed)`);
	}

	// Required fields on a sanity subset: OpenRouter has carried these on
	// (nearly) every model for years, so a collapsing share means the wire
	// keys moved, not that models got weirder.
	assertShare(models, 0.9, "context_length", (m) => m.fields.context_length !== undefined);
	assertShare(models, 0.5, "top_provider.max_completion_tokens", (m) => m.fields.max_output_tokens !== undefined);
	assertShare(models, 0.9, "supported_parameters", (m) => m.fields.supports_function_calling !== undefined);

	// Mapping sanity: each derived capability must actually light up somewhere.
	assertSome(models, "supports_vision: true", (m) => m.fields.supports_vision === true);
	assertSome(models, "supports_function_calling: true", (m) => m.fields.supports_function_calling === true);
	assertSome(models, "supports_reasoning: true", (m) => m.fields.supports_reasoning === true);
	assertSome(models, "a six-figure context_length", (m) => (m.fields.context_length ?? 0) >= 100_000);

	return { text: `${JSON.stringify(slim, null, "\t")}\n`, modelCount: models.length };
}

async function main(): Promise<void> {
	const checkOnly = process.argv.includes("--check");
	const payload = await fetchLivePayload();
	const { text, modelCount } = validateAndSlim(payload);

	if (checkOnly) {
		const dir = await mkdtemp(path.join(os.tmpdir(), "openrouter-catalog-"));
		const file = path.join(dir, "openrouter-models.json");
		await writeFile(file, text);
		console.log(`OpenRouter catalog check passed: ${modelCount} models; slimmed artifact at ${file}`);
		return;
	}

	const target = path.join(process.cwd(), "dist", "openrouter-models.json");
	await mkdir(path.dirname(target), { recursive: true });
	const temp = `${target}.tmp`;
	await writeFile(temp, text);
	await rename(temp, target);
	console.log(`Wrote ${target}: ${modelCount} models`);
}

main().catch((error) => {
	if (error instanceof UnreachableError) {
		console.error(`OpenRouter unreachable (transient): ${error.message}`);
		console.error("Not a schema problem - retry once the endpoint is reachable.");
	} else if (error instanceof DriftError) {
		console.error(`OpenRouter payload schema drift: ${error.message}`);
		console.error("Update src/shared/config/openRouterCatalog.ts to match the current payload.");
	} else {
		console.error(error);
	}
	process.exitCode = 1;
});
