import * as assert from "node:assert";
import * as vscode from "vscode";
import { probeThinkingPartCtor, thinkingPartCtor } from "../../shared/thinkingPart";

suite("shared/thinkingPart", () => {
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
});
