import * as assert from "node:assert";
import * as vscode from "vscode";
import {
	dataPartCtor,
	logDataPartProbeErrorOnce,
	logMissingDataPartSupportOnce,
	probeDataPartCtor,
	resetDataPartLogOnce,
} from "../../shared/dataPart";

suite("shared/dataPart", () => {
	setup(() => resetDataPartLogOnce());
	teardown(() => resetDataPartLogOnce());

	test("finds the constructor when the host exposes one", () => {
		class FakeDataPart {}
		const probe = probeDataPartCtor({ LanguageModelDataPart: FakeDataPart });
		assert.strictEqual(probe.ctor, FakeDataPart);
		assert.strictEqual(probe.error, undefined);
	});

	test("returns undefined when the host lacks the class", () => {
		const probe = probeDataPartCtor({});
		assert.strictEqual(probe.ctor, undefined);
		assert.strictEqual(probe.error, undefined);
	});

	test("returns undefined when the property is not a constructor", () => {
		const probe = probeDataPartCtor({ LanguageModelDataPart: "not a class" });
		assert.strictEqual(probe.ctor, undefined);
		assert.strictEqual(probe.error, undefined);
	});

	test("captures the error when the host exposes the class behind a throwing getter", () => {
		const host = {};
		Object.defineProperty(host, "LanguageModelDataPart", {
			get() {
				throw new Error("class not available");
			},
		});
		const probe = probeDataPartCtor(host);
		assert.strictEqual(probe.ctor, undefined);
		assert.ok(probe.error?.includes("class not available"));
	});

	test("the module-level probe matches what the running host exposes", () => {
		const hostCtor: unknown = Reflect.get(vscode, "LanguageModelDataPart");
		assert.strictEqual(dataPartCtor, typeof hostCtor === "function" ? hostCtor : undefined);
	});

	test("the missing-support message is logged once until reset", () => {
		const logs: string[] = [];
		logMissingDataPartSupportOnce((msg) => logs.push(msg));
		logMissingDataPartSupportOnce((msg) => logs.push(msg));
		assert.deepStrictEqual(logs, ["Host does not support data parts; generated media will not be displayed"]);

		resetDataPartLogOnce();
		logMissingDataPartSupportOnce((msg) => logs.push(msg));
		assert.strictEqual(logs.length, 2, "The reset hook must re-arm the log");
	});

	test("a probe failure is logged once, however many StreamProcessors report it", () => {
		const logs: Array<{ message: string; data?: unknown }> = [];
		const log = (message: string, data?: unknown) => logs.push({ message, data });
		logDataPartProbeErrorOnce(log, "class not available");
		logDataPartProbeErrorOnce(log, "class not available");
		assert.deepStrictEqual(logs, [
			{ message: "LanguageModelDataPart probe failed", data: { error: "class not available" } },
		]);
	});

	test("no probe error means no probe-failure log", () => {
		const logs: string[] = [];
		logDataPartProbeErrorOnce((msg) => logs.push(msg), undefined);
		assert.deepStrictEqual(logs, []);
	});
});
