import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fc from "fast-check";
import {
	apiRootOf,
	canonicalBaseUrl,
	canonicalStoredBaseUrl,
	canonicalUrl,
	DEFAULT_API_VERSION,
	serverRootOf,
} from "../../../../shared/util/baseUrl";
import { resolveFuzzSeed } from "../../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 300;
const SEED = resolveFuzzSeed();

describe("shared/util/baseUrl", () => {
	test("apiRootOf appends the default version, v1, to a version-less base URL", () => {
		const base = "http://localhost:4000";
		assert.strictEqual(apiRootOf(base), "http://localhost:4000/v1");
		assert.strictEqual(apiRootOf(base), `${base}/${DEFAULT_API_VERSION}`, "the appended segment IS the constant");
		assert.strictEqual(apiRootOf("http://localhost:4000/"), "http://localhost:4000/v1");
		assert.strictEqual(apiRootOf("http://h/v1/"), "http://h/v1");
	});

	test("apiRootOf keeps a trailing version segment the URL already carries", () => {
		assert.strictEqual(apiRootOf("http://h/v1"), "http://h/v1");
		assert.strictEqual(apiRootOf("http://h/v2"), "http://h/v2");
		assert.strictEqual(apiRootOf("http://h/v10"), "http://h/v10");
		assert.strictEqual(apiRootOf("http://h/v1beta"), "http://h/v1beta");
		assert.strictEqual(apiRootOf("http://h/v1alpha2"), "http://h/v1alpha2");
		assert.strictEqual(apiRootOf("http://h/v1beta1"), "http://h/v1beta1");
		assert.strictEqual(apiRootOf("https://api.groq.com/openai/v1"), "https://api.groq.com/openai/v1");
	});

	test("apiRootOf appends when the last segment merely resembles a version", () => {
		assert.strictEqual(apiRootOf("http://h/V1"), "http://h/V1/v1", "lowercase only");
		assert.strictEqual(apiRootOf("http://h/team-v1"), "http://h/team-v1/v1", "needs its own path segment");
		assert.strictEqual(apiRootOf("http://h/v1gamma"), "http://h/v1gamma/v1", "only alpha/beta stages");
		assert.strictEqual(apiRootOf("http://h/v2beta1x"), "http://h/v2beta1x/v1", "trailing junk after the stage");
	});

	test("apiRootOf appends when the version-looking tail is not a real path segment", () => {
		assert.strictEqual(apiRootOf("http://v1"), "http://v1/v1", "a host is not a path segment");
		assert.strictEqual(apiRootOf("http://host//v1"), "http://host//v1/v1", "empty segment before it");
		assert.strictEqual(apiRootOf("http:/v1"), "http:/v1/v1", "scheme separator before it");
		assert.strictEqual(apiRootOf("http://v1:8080"), "http://v1:8080/v1");
	});

	test("apiRootOf lets an explicit apiVersion win, verbatim, with empty string meaning none", () => {
		assert.strictEqual(apiRootOf("http://h/v1", "v2"), "http://h/v1/v2");
		assert.strictEqual(apiRootOf("http://h", ""), "http://h");
		assert.strictEqual(apiRootOf("http://h/v1", ""), "http://h/v1");
	});

	test("serverRootOf strips exactly one detected version segment", () => {
		assert.strictEqual(serverRootOf("http://h/v1"), "http://h");
		assert.strictEqual(serverRootOf("http://h/v1/"), "http://h");
		assert.strictEqual(serverRootOf("http://h/v1/v1"), "http://h/v1");
		assert.strictEqual(serverRootOf("http://h/openai/v1"), "http://h/openai");
	});

	test("serverRootOf leaves a URL without a version segment unchanged", () => {
		assert.strictEqual(serverRootOf("http://h"), "http://h");
		assert.strictEqual(serverRootOf("http://h/api"), "http://h/api");
		assert.strictEqual(serverRootOf("http://v1"), "http://v1", "a host is never stripped");
	});

	test("serverRootOf with a non-empty apiVersion returns the normalized base unchanged", () => {
		assert.strictEqual(serverRootOf("http://h/v1", "v2"), "http://h/v1");
		assert.strictEqual(serverRootOf("http://h/", "v2"), "http://h");
	});

	test('serverRootOf with "" still strips a version segment: "" moves the API root, not the server root', () => {
		// The Usage-tab case: base http://h/v1 with "No version" selected must
		// keep /key/info at the server root, exactly like Auto.
		assert.strictEqual(serverRootOf("http://h/v1", ""), "http://h");
		assert.strictEqual(serverRootOf("http://h", ""), "http://h");
		assert.strictEqual(serverRootOf("http://h/llm", ""), "http://h/llm");
	});
});

describe("shared/util/baseUrl canonical spellings", () => {
	// The WHATWG facts the one spelling rests on: the platform's URL parser accepts these spellings and serializes each
	// to the text below; a runtime whose parser drifts (userinfo encoding, default-port elision, the slash rules)
	// would silently change what every entry stores.
	test("canonicalUrl is the WHATWG serialization of what the parser accepts with a host, else undefined", () => {
		const cases: [string, string | undefined][] = [
			["HTTP://User:Pa ss@Host:4000/", "http://User:Pa%20ss@host:4000/"],
			["http:user:pass@host", "http://user:pass@host/"],
			["http:/host", "http://host/"],
			["ht\ttp://host", "http://host/"],
			["  http://two.test/  ", "http://two.test/"],
			["https://host:443/x", "https://host/x"],
			["http://host/a b?q=1#f", "http://host/a%20b?q=1#f"],
			["http://[::1]:4000", "http://[::1]:4000/"],
			["wss://gw.example/mcp", "wss://gw.example/mcp"],
			["http://user:pa/ss@host", undefined],
			["localhost:4000", undefined],
			["mailto:x@y", undefined],
			["file:///tmp/x", undefined],
			["not a url", undefined],
			["", undefined],
		];
		for (const [typed, canonical] of cases) {
			assert.strictEqual(canonicalUrl(typed), canonical, JSON.stringify(typed));
		}
	});

	test("a stored identity whose stripped slash exposed a trailing space keeps the space the parser would trim", () => {
		// WHATWG trims trailing spaces before parsing: the external fact the stored-identity reader works around.
		assert.strictEqual(canonicalBaseUrl("http://host.test/a "), "http://host.test/a");
		assert.strictEqual(canonicalStoredBaseUrl("http://host.test/a "), "http://host.test/a%20");
		assert.strictEqual(canonicalStoredBaseUrl("http://host.test/a%20"), "http://host.test/a%20");
		assert.strictEqual(canonicalStoredBaseUrl("http://host.test/?x=1"), "http://host.test/?x=1");
		assert.strictEqual(canonicalStoredBaseUrl("HTTP://Host.test"), "http://host.test");
	});

	test("canonicalization is idempotent, so a stored canonical text re-parses to itself", () => {
		for (const typed of ["HTTP://Host:4000/", "http:user:pass@host/x/", "https://host:443/a b"]) {
			const url = canonicalUrl(typed);
			const base = canonicalBaseUrl(typed);
			assert.ok(url !== undefined && base !== undefined);
			assert.strictEqual(canonicalUrl(url), url);
			assert.strictEqual(canonicalBaseUrl(base), base);
		}
	});
});

describe("shared/util/baseUrl properties", () => {
	// Well-formed URLs only: hosts that are not bare version tokens and non-empty path segments, so the
	// preceding-character guard cases never fire and the segment text alone decides version detection.
	const hostArb = fc.constantFrom("h", "localhost:4000", "api.example.com", "litellm.internal");
	const segmentArb = fc.oneof(
		fc.constantFrom("v1", "v2", "v10", "v1beta", "v1alpha2", "v1beta1", "V1", "v1gamma", "team-v1", "openai", "api"),
		fc.string({ unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.-"), minLength: 1, maxLength: 8 })
	);
	const urlArb = fc
		.tuple(fc.constantFrom("http", "https"), hostArb, fc.array(segmentArb, { maxLength: 3 }))
		.map(([scheme, host, segments]) => [`${scheme}://${host}`, ...segments].join("/"));

	const VERSION_TAIL = /\/v\d+(?:(?:alpha|beta)\d*)?$/;

	test("the default API root always ends in a version segment", () => {
		fc.assert(
			fc.property(urlArb, (url) => {
				assert.ok(VERSION_TAIL.test(apiRootOf(url)), `apiRootOf(${url}) must end in a version segment`);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("a /v1/v1 tail never appears unless the input already carried it", () => {
		fc.assert(
			fc.property(urlArb, (url) => {
				if (!url.includes("/v1/v1")) {
					assert.ok(!apiRootOf(url).endsWith("/v1/v1"), `apiRootOf(${url}) must not double the version`);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("apiRootOf is idempotent", () => {
		fc.assert(
			fc.property(urlArb, (url) => {
				const once = apiRootOf(url);
				assert.strictEqual(apiRootOf(once), once);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("a trailing slash never changes the API root", () => {
		fc.assert(
			fc.property(urlArb, (url) => {
				assert.strictEqual(apiRootOf(`${url}/`), apiRootOf(url));
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("serverRootOf inverts apiRootOf: the API root and its input share a server root", () => {
		fc.assert(
			fc.property(urlArb, (url) => {
				assert.strictEqual(serverRootOf(apiRootOf(url)), serverRootOf(url));
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
