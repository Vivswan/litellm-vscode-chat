import * as assert from "node:assert";
import { composeSetting, parseEnvFile } from "./envFile";

/**
 * Pins the .env grammar the docker stack scripts share with docker-compose
 * (godotenv subset) and the ${VAR:-fallback} resolution semantics. The
 * config generator, docker-test, and the dev launcher all resolve ports,
 * keys, and wildcard emission through these two functions, so a divergence
 * from what compose reads shows up as a stack that disagrees with its own
 * config.
 */

suite("envFile: parseEnvFile", () => {
	test("strips the export prefix", () => {
		assert.deepStrictEqual(parseEnvFile("export OPENAI_API_KEY=sk-x"), { OPENAI_API_KEY: "sk-x" });
	});

	test("unquoted value ends at a whitespace-preceded inline comment", () => {
		assert.deepStrictEqual(parseEnvFile("LITELLM_PORT=4100 # local override"), { LITELLM_PORT: "4100" });
	});

	test("a hash glued to the value is part of the value", () => {
		assert.deepStrictEqual(parseEnvFile("KEY=a#b"), { KEY: "a#b" });
	});

	test("empty value with a trailing comment is empty", () => {
		assert.deepStrictEqual(parseEnvFile("OPENAI_API_KEY= # disabled for now"), { OPENAI_API_KEY: "" });
	});

	test("quoted value with a comment after the closing quote", () => {
		assert.deepStrictEqual(parseEnvFile('KEY="v" # comment'), { KEY: "v" });
		assert.deepStrictEqual(parseEnvFile("KEY='v' # comment"), { KEY: "v" });
	});

	test("whole-value quotes are stripped one layer only", () => {
		assert.deepStrictEqual(parseEnvFile("A=\"value\"\nB='value'\nC=\"'x'\""), {
			A: "value",
			B: "value",
			C: "'x'",
		});
	});

	test("a hash inside a quoted value survives", () => {
		assert.deepStrictEqual(parseEnvFile('KEY="a # b"'), { KEY: "a # b" });
	});

	test("CRLF line endings parse like LF", () => {
		assert.deepStrictEqual(parseEnvFile("A=1\r\nB=2\r\n"), { A: "1", B: "2" });
	});

	test("blank lines, comment lines, and invalid keys are skipped", () => {
		assert.deepStrictEqual(parseEnvFile("\n# comment\nnot a line\n1BAD=x\nGOOD=1\n"), { GOOD: "1" });
	});

	test("later assignments win", () => {
		assert.deepStrictEqual(parseEnvFile("K=1\nK=2"), { K: "2" });
	});
});

suite("envFile: composeSetting", () => {
	const file = { KEY: "from-file", PORT: "4100" };

	test("a set shell variable wins over .env", () => {
		assert.strictEqual(composeSetting("KEY", "fallback", file, { KEY: "from-shell" }), "from-shell");
	});

	test("a set-but-empty shell variable is authoritative and takes the fallback, never .env", () => {
		assert.strictEqual(composeSetting("KEY", "fallback", file, { KEY: "" }), "fallback");
		assert.strictEqual(composeSetting("KEY", "", file, { KEY: "" }), "");
	});

	test("an unset shell variable falls back to .env", () => {
		assert.strictEqual(composeSetting("PORT", "4000", file, {}), "4100");
	});

	test("unset everywhere resolves to the fallback", () => {
		assert.strictEqual(composeSetting("MISSING", "default", file, {}), "default");
	});

	test("an empty .env value takes the fallback (the colon in compose's VAR:-fallback form)", () => {
		assert.strictEqual(composeSetting("EMPTY", "default", { EMPTY: "" }, {}), "default");
	});
});
