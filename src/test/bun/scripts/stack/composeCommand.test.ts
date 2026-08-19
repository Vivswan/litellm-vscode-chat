import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { splitCommandWords } from "../../../../../scripts/stack/composeCommand";

/**
 * COMPOSE_CMD word splitting: the resolved argv is spawned directly, never
 * re-parsed by a shell, so this split is the only place a quoted binary path
 * (Docker Desktop under "Program Files", say) either survives or breaks.
 */
describe("splitCommandWords", () => {
	test("plain words split on any whitespace run", () => {
		assert.deepStrictEqual(splitCommandWords("docker compose"), ["docker", "compose"]);
		assert.deepStrictEqual(splitCommandWords("docker \t compose"), ["docker", "compose"]);
		assert.deepStrictEqual(splitCommandWords("podman-compose"), ["podman-compose"]);
	});

	test("quotes keep a spaced path as one word, either quote style", () => {
		assert.deepStrictEqual(splitCommandWords('"/opt/container tools/docker" compose'), [
			"/opt/container tools/docker",
			"compose",
		]);
		assert.deepStrictEqual(splitCommandWords("'/opt/container tools/docker' compose"), [
			"/opt/container tools/docker",
			"compose",
		]);
	});

	test("a quoted span glues to its neighbors, shell-style", () => {
		assert.deepStrictEqual(splitCommandWords(`docker" compose"`), ["docker compose"]);
		assert.deepStrictEqual(splitCommandWords(`'a'"b"c`), ["abc"]);
	});

	test("quotes of one style ride verbatim inside the other", () => {
		assert.deepStrictEqual(splitCommandWords(`"it's" here`), ["it's", "here"]);
	});

	test("an empty quoted word is a word", () => {
		assert.deepStrictEqual(splitCommandWords("'' compose"), ["", "compose"]);
	});

	test("an unclosed quote is undefined, never a silently mangled argv", () => {
		assert.strictEqual(splitCommandWords('"/opt/broken compose'), undefined);
		assert.strictEqual(splitCommandWords("docker 'compose"), undefined);
	});
});
