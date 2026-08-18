/**
 * The completeness pin on RECORD_TYPE_DIRECTIVES, the one mint of every
 * type-specific directive name. The sibling wrong-type sets derive from it by
 * construction; this suite closes what a derivation cannot prove: the rows
 * stay disjoint (from each other and the shared engine directives), every
 * registered name is really handled by its own parser rather than sitting
 * stale, and every parser flags exactly the sibling names - nothing more. The
 * parser map is total over RecordType, so minting a third record type fails
 * this file's typecheck until its parser is wired in, and the loops then hold
 * it to the same mutual-flagging contract.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { parseCapabilityRecord } from "../../../../shared/config/capabilityResolution";
import { parseParameterRecord } from "../../../../shared/config/parameterResolution";
import type { ParsedRecord, RecordType } from "../../../../shared/config/recordResolution";
import {
	INHERIT_FROM_DIRECTIVE,
	INHERITABLE_DIRECTIVE,
	RECORD_TYPE_DIRECTIVES,
} from "../../../../shared/config/recordResolution";

/** Total over RecordType on purpose: a registry row without a parser fails typecheck here. */
const PARSERS: Readonly<Record<RecordType, (record: Readonly<Record<string, unknown>>) => ParsedRecord>> = {
	parameters: parseParameterRecord,
	capabilities: (record) => parseCapabilityRecord(record),
};

const RECORD_TYPES = Object.keys(RECORD_TYPE_DIRECTIVES) as readonly RecordType[];
const SHARED_DIRECTIVES: ReadonlySet<string> = new Set([INHERITABLE_DIRECTIVE, INHERIT_FROM_DIRECTIVE]);

describe("shared/config record-type directive registry", () => {
	test("every name is underscore-prefixed and minted in exactly one row, never a shared engine directive", () => {
		const seen = new Map<string, RecordType>();
		for (const type of RECORD_TYPES) {
			for (const name of RECORD_TYPE_DIRECTIVES[type]) {
				assert.ok(name.startsWith("_"), `${name} is not underscore-prefixed`);
				assert.ok(!SHARED_DIRECTIVES.has(name), `${name} collides with a shared engine directive`);
				assert.strictEqual(seen.get(name), undefined, `${name} is minted in two rows`);
				seen.set(name, type);
			}
		}
	});

	test("each registered directive is live in its own parser and wrong-record-type in every sibling", () => {
		for (const type of RECORD_TYPES) {
			for (const name of RECORD_TYPE_DIRECTIVES[type]) {
				// 12345 is a valid value for no known directive, so a handled name
				// must answer with some diagnostic; an unhandled one would parse
				// silently (the forward-compat rule) and mean a stale registry row.
				const own = PARSERS[type]({ [name]: 12345 });
				assert.ok(own.diagnostics.length > 0, `${type} parser silently ignores its own ${name}`);
				assert.ok(
					own.diagnostics.every((diagnostic) => diagnostic.kind !== "wrong-record-type"),
					`${type} parser flags its own ${name} as the wrong record type`
				);
				for (const sibling of RECORD_TYPES.filter((other) => other !== type)) {
					assert.deepStrictEqual(
						PARSERS[sibling]({ [name]: 12345 }).diagnostics,
						[{ kind: "wrong-record-type", key: name }],
						`${sibling} parser does not flag ${name} as exactly one wrong-record-type`
					);
				}
			}
		}
	});

	test("no parser flags beyond the sibling rows: shared directives and unknown underscore keys pass", () => {
		for (const type of RECORD_TYPES) {
			for (const name of SHARED_DIRECTIVES) {
				assert.ok(
					PARSERS[type]({ [name]: false }).diagnostics.every((diagnostic) => diagnostic.kind !== "wrong-record-type"),
					`${type} parser flags shared ${name} as the wrong record type`
				);
			}
			assert.deepStrictEqual(PARSERS[type]({ _future_directive: 12345 }).diagnostics, []);
		}
	});
});
