import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { Classification, DiscoveryLog } from "../../../../provider/catalog/discoveryLog";
import { discoveryLineWriter, failureKindOf, logFailure, parseWire } from "../../../../provider/catalog/discoveryLog";
import { MirroredError } from "../../../../shared/mirroredError";

describe("provider/catalog/discoveryLog", () => {
	test.each([
		[
			"a record key is the input's, so it renders as a placeholder",
			z.record(z.string(), z.number()),
			{ "sk-live-abc": "x" },
			"[key]: expected number, received string",
		],
		[
			"a static key renders and the dynamic one below it does not",
			z.object({ data: z.record(z.string(), z.number()) }),
			{ data: { "sk-live-abc": "x" } },
			"data.[key]: expected number, received string",
		],
		[
			"a custom issue renders its code, never its message",
			z.string().superRefine((value, ctx) => ctx.addIssue({ code: "custom", message: value })),
			"sk-live-abc",
			"custom",
		],
	])("%s", (_name, schema, value, rejection) => {
		const parsed = parseWire(schema, value);
		const lines: unknown[] = [];
		const log = discoveryLineWriter((_message, data) => lines.push(data));
		if (!parsed.success) {
			log("Skipping malformed models entry", { index: 0, rejection: parsed.rejection });
		}
		expect(lines).toEqual([{ index: 0, rejection }]);
	});

	// The gate is `bun run typecheck`: an unused @ts-expect-error fails the build, so each line below is a form the log
	// type must keep refusing. The log is a no-op, so running the refused calls has no effect.
	test("a response value has no way into a discovery log line by type", () => {
		const log: DiscoveryLog = () => undefined;
		const wire: unknown = { id: "sk-live-abc" };
		// @ts-expect-error the message is a table key, never text built from a value
		log(String(wire), { modelCount: 1 });
		// @ts-expect-error the message is a table key, never a template over a value
		log(`wire: ${wire}`, { modelCount: 1 });
		// @ts-expect-error a data record's keys are the line's own, never computed
		log("Parsed models listing", { modelCount: 1, [String(wire)]: 0 });
		const widened = { modelCount: 1, secret: String(wire) };
		// @ts-expect-error nor widened through a variable that carries more than the line's keys
		log("Parsed models listing", widened);
		// @ts-expect-error a bare string is not a Classification
		log("Skipping malformed models entry", { index: 0, rejection: String(wire) });
		const forged = Object.assign(String(wire), { __brand: "logSafe" as const });
		// @ts-expect-error a Classification is an instance this module cannot construct, so a string cannot pose as one
		log("Skipping malformed models entry", { index: 0, rejection: forged });
	});

	// A narrowed alias, a defined-in property, a cast, a string or a toString behind the Classification type: forms the
	// type system never saw.
	test.each<[string, (log: DiscoveryLog) => void, { message: string; data: unknown }[]]>([
		[
			"an alias typed narrower than its object hides a key",
			(log) => {
				const widened = { modelCount: 1, secret: "sk-live-abc" };
				const narrowed: { modelCount: number } = widened;
				log("Parsed models listing", narrowed);
			},
			[{ message: "Parsed models listing", data: { modelCount: 1 } }],
		],
		[
			"a property defined after typing hides a key",
			(log) =>
				log(
					"Parsed models listing",
					Object.defineProperty({ modelCount: 1 }, "sk-live-abc", { value: 0, enumerable: true })
				),
			[{ message: "Parsed models listing", data: { modelCount: 1 } }],
		],
		[
			"a value of the wrong kind leaves the marker, not its text",
			(log) => log("Parsed models listing", { modelCount: "sk-live-abc" as unknown as number }),
			[{ message: "Parsed models listing", data: { modelCount: "[rejected]" } }],
		],
		[
			"a classification and an index pass through whole",
			(log) => log("Skipping malformed models entry", { index: 2, rejection: classified() }),
			[
				{
					message: "Skipping malformed models entry",
					data: { index: 2, rejection: "expected string, received number" },
				},
			],
		],
		[
			"a string carried behind the Classification type by Object.assign leaves the marker",
			(log) => {
				const overwritten = Object.assign({ rejection: classified() }, { rejection: "sk-live-abc" });
				log("Skipping malformed models entry", { index: 3, rejection: overwritten.rejection });
			},
			[{ message: "Skipping malformed models entry", data: { index: 3, rejection: "[rejected]" } }],
		],
		[
			"a toString planted on a genuine classification is never consulted",
			(log) => {
				const planted = Object.assign(classified(), { toString: () => "sk-live-abc" });
				log("Skipping malformed models entry", { index: 4, rejection: planted });
			},
			[
				{
					message: "Skipping malformed models entry",
					data: { index: 4, rejection: "expected string, received number" },
				},
			],
		],
		[
			"a logClassification planted on an arbitrary throw is not a failure kind",
			(log) =>
				log("model/info failed; falling back to the models listing", {
					expected: false,
					...failureKindOf(Object.assign(new Error(), { logClassification: "sk-live-abc", kind: "http" })),
				}),
			[
				{
					message: "model/info failed; falling back to the models listing",
					data: { expected: false, kind: "unclassified" },
				},
			],
		],
		[
			"the repository's own error speaks through the closed kind vocabulary only",
			(log) => {
				const own = Object.assign(new MirroredError("x", { logClassification: "sk-live-abc" }), {
					kind: "http",
					status: 500,
				});
				const odd = Object.assign(new MirroredError("x", { logClassification: "sk-live-abc" }), { kind: "sk-live" });
				log("model/info failed; falling back to the models listing", { expected: true, ...failureKindOf(own) });
				log("model/info failed; falling back to the models listing", { expected: true, ...failureKindOf(odd) });
			},
			[
				{
					message: "model/info failed; falling back to the models listing",
					data: { expected: true, kind: "http", status: 500 },
				},
				{
					message: "model/info failed; falling back to the models listing",
					data: { expected: true, kind: "unclassified" },
				},
			],
		],
	])("%s", (_name, write, expected) => {
		const lines: { message: string; data: unknown }[] = [];
		write(discoveryLineWriter((message, data) => lines.push({ message, data })));
		expect(lines).toEqual(expected);
		expect(JSON.stringify(lines)).not.toContain("sk-live");
	});

	test("an instance's constructor mints nothing without the module's token", () => {
		expect(() => Reflect.construct(classified().constructor, ["sk-live-abc"])).toThrow(TypeError);
	});

	// The sink's third argument is the caught value itself, for the recorder; the line never renders it.
	test.each<[string, unknown, Record<string, unknown>]>([
		[
			"a logClassification planted on an arbitrary throw is not a classification",
			Object.assign(new Error("sk-live-abc"), { logClassification: "sk-live-abc", kind: "http", status: 500 }),
			{ kind: "unclassified" },
		],
		[
			"the repository's own error carries its kind, status, and terse classification",
			Object.assign(new MirroredError("sk-live-abc", { logClassification: "RequestError(http, status 500)" }), {
				kind: "http",
				status: 500,
			}),
			{ kind: "http", status: 500, classification: "RequestError(http, status 500)" },
		],
		[
			"the repository's own error without a transport kind keeps its classification",
			new MirroredError("sk-live-abc", { logClassification: "RequestRouting(no group identity)" }),
			{ kind: "unclassified", classification: "RequestRouting(no group identity)" },
		],
	])("%s", (_name, error, line) => {
		const written: { message: string; data: unknown; error: unknown }[] = [];
		logFailure((message, data, cause) => written.push({ message, data, error: cause }), "Chat request failed", error);
		expect(written).toEqual([{ message: "Chat request failed", data: line, error }]);
		expect(JSON.stringify(written.map(({ error: _, ...rest }) => rest))).not.toContain("sk-live");
	});
});

function classified(): Classification {
	const parsed = parseWire(z.string(), 1);
	if (parsed.success) {
		throw new Error("a number cannot parse as a string");
	}
	return parsed.rejection;
}
