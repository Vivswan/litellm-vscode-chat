import * as assert from "node:assert";
import * as vscode from "vscode";
import {
	logMissingThinkingPartSupportOnce,
	logThinkingPartProbeErrorOnce,
	probeThinkingPartCtor,
	resetThinkingPartLogOnce,
	thinkingPartCtor,
} from "../../shared/thinkingPart";

suite("shared/thinkingPart", () => {
	setup(() => resetThinkingPartLogOnce());
	teardown(() => resetThinkingPartLogOnce());

	test("finds the constructor when the host exposes one", () => {
		class FakeThinkingPart {}
		const probe = probeThinkingPartCtor({ LanguageModelThinkingPart: FakeThinkingPart });
		assert.strictEqual(probe.ctor, FakeThinkingPart);
		assert.strictEqual(probe.error, undefined);
	});

	test("returns undefined when the host lacks the class", () => {
		const probe = probeThinkingPartCtor({});
		assert.strictEqual(probe.ctor, undefined);
		assert.strictEqual(probe.error, undefined);
	});

	test("returns undefined when the property is not a constructor", () => {
		const probe = probeThinkingPartCtor({ LanguageModelThinkingPart: "not a class" });
		assert.strictEqual(probe.ctor, undefined);
		assert.strictEqual(probe.error, undefined);
	});

	test("captures the error when the host exposes the class behind a throwing getter", () => {
		const host = {};
		Object.defineProperty(host, "LanguageModelThinkingPart", {
			get() {
				throw new Error("proposed API not enabled");
			},
		});
		const probe = probeThinkingPartCtor(host);
		assert.strictEqual(probe.ctor, undefined);
		assert.ok(probe.error?.includes("proposed API not enabled"));
	});

	test("the module-level probe matches what the running host exposes", () => {
		const hostCtor: unknown = Reflect.get(vscode, "LanguageModelThinkingPart");
		assert.strictEqual(thinkingPartCtor, typeof hostCtor === "function" ? hostCtor : undefined);
	});

	test("the missing-support message is logged once until reset", () => {
		const logs: string[] = [];
		logMissingThinkingPartSupportOnce((msg) => logs.push(msg));
		logMissingThinkingPartSupportOnce((msg) => logs.push(msg));
		assert.deepStrictEqual(logs, ["Host does not support thinking parts; reasoning output will not be displayed"]);

		resetThinkingPartLogOnce();
		logMissingThinkingPartSupportOnce((msg) => logs.push(msg));
		assert.strictEqual(logs.length, 2, "The reset hook must re-arm the log");
	});

	test("a probe failure is logged once, however many StreamProcessors report it", () => {
		const logs: Array<{ message: string; data?: unknown }> = [];
		const log = (message: string, data?: unknown) => logs.push({ message, data });
		logThinkingPartProbeErrorOnce(log, "proposed API not enabled");
		logThinkingPartProbeErrorOnce(log, "proposed API not enabled");
		assert.deepStrictEqual(logs, [
			{ message: "LanguageModelThinkingPart probe failed", data: { error: "proposed API not enabled" } },
		]);
	});

	test("no probe error means no probe-failure log", () => {
		const logs: string[] = [];
		logThinkingPartProbeErrorOnce((msg) => logs.push(msg), undefined);
		assert.deepStrictEqual(logs, []);
	});
});
