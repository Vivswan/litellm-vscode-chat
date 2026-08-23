import { describe, test } from "bun:test";
import * as assert from "node:assert";
import type { McpDefinitionDescriptor, McpEntryView } from "../../../../../extension/features/mcp/definitions";
import { mcpDefinitionsOf } from "../../../../../extension/features/mcp/definitions";
import type { McpOptIn } from "../../../../../shared/serverEntry";
import { mcpEndpointOf } from "../../../../../shared/util/baseUrl";

function entry(overrides: Partial<McpEntryView> = {}): McpEntryView {
	return { label: "Main", baseUrl: "http://localhost:4000", mcp: true, version: 0, ...overrides };
}

describe("extension/features/mcp/definitions", () => {
	test("mcp: true derives <baseUrl>/mcp", () => {
		assert.deepStrictEqual(mcpDefinitionsOf([entry()]), [
			{ label: "Main", uri: "http://localhost:4000/mcp", version: 0 },
		]);
	});

	test("trailing slashes carry the shared base-URL identity: any run of them derives the same URI", () => {
		for (const baseUrl of ["http://localhost:4000/", "http://localhost:4000///"]) {
			assert.strictEqual(mcpDefinitionsOf([entry({ baseUrl })])[0]?.uri, "http://localhost:4000/mcp");
		}
	});

	test("a path-carrying base URL keeps its path, slashed or not", () => {
		for (const baseUrl of ["https://gw.example/litellm", "https://gw.example/litellm/"]) {
			assert.strictEqual(mcpDefinitionsOf([entry({ baseUrl })])[0]?.uri, "https://gw.example/litellm/mcp");
		}
	});

	test("derivation appends to the base URL as written: a /v1 base derives /v1/mcp", () => {
		assert.strictEqual(mcpDefinitionsOf([entry({ baseUrl: "http://host/v1" })])[0]?.uri, "http://host/v1/mcp");
	});

	test("the object form's explicit url wins as written beyond edge-trimming, trailing slash included", () => {
		const mcp: McpOptIn = { url: "https://gw.example/custom-mcp/" };
		assert.strictEqual(mcpDefinitionsOf([entry({ mcp })])[0]?.uri, "https://gw.example/custom-mcp/");
		const padded: McpOptIn = { url: "  https://gw.example/custom-mcp  " };
		assert.strictEqual(mcpDefinitionsOf([entry({ mcp: padded })])[0]?.uri, "https://gw.example/custom-mcp");
	});

	test("an object form without a usable url derives the default like true", () => {
		for (const mcp of [{}, { url: undefined }, { url: "" }, { url: "   " }] as const) {
			assert.strictEqual(mcpDefinitionsOf([entry({ mcp })])[0]?.uri, "http://localhost:4000/mcp");
		}
	});

	test("the version counter rides each descriptor untouched", () => {
		const descriptors = mcpDefinitionsOf([
			entry({ label: "A", version: 7 }),
			entry({ label: "B", mcp: { url: "https://gw.example/mcp" }, version: 41 }),
		]);
		assert.deepStrictEqual(
			descriptors.map((descriptor) => descriptor.version),
			[7, 41]
		);
	});

	test("duplicate labels follow the parser's first-wins rule; order is preserved", () => {
		const descriptors = mcpDefinitionsOf([
			entry({ label: "A", version: 1 }),
			entry({ label: "B", baseUrl: "http://other:4000" }),
			entry({ label: "A", baseUrl: "http://impostor:4000", version: 9 }),
		]);
		assert.deepStrictEqual(descriptors, [
			{ label: "A", uri: "http://localhost:4000/mcp", version: 1 },
			{ label: "B", uri: "http://other:4000/mcp", version: 0 },
		]);
	});

	test("the published URI IS the shared derivation the server form promises", () => {
		// The form's hint names the address an empty endpoint will publish. It
		// gets that address from mcpEndpointOf; so does the publisher. Pinning
		// the identity here is what keeps the promise from drifting into a lie.
		for (const baseUrl of [
			"http://localhost:4000",
			"http://localhost:4000/",
			"https://gw.example/litellm",
			"http://host/v1",
			"https://gw.example/litellm///",
		]) {
			assert.strictEqual(mcpDefinitionsOf([entry({ baseUrl })])[0]?.uri, mcpEndpointOf(baseUrl));
		}
	});

	test("no entries, no definitions", () => {
		assert.deepStrictEqual(mcpDefinitionsOf([]), []);
	});

	test("a descriptor cannot carry headers, pinned at typecheck time", () => {
		const identity = { label: "Main", uri: "http://localhost:4000/mcp", version: 2 };
		const descriptor: McpDefinitionDescriptor = identity;
		// Not a literal, so structural subtyping would admit it - only `headers?: never` rejects it.
		const withHeaders = { ...identity, headers: { Authorization: "Bearer x" } };
		// @ts-expect-error - a value carrying headers is not a provide-side descriptor
		const smuggled: McpDefinitionDescriptor = withHeaders;
		assert.strictEqual(descriptor.headers, undefined);
		assert.strictEqual(smuggled, withHeaders);
	});
});
