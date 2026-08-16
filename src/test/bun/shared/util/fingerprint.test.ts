import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { pbkdf2Sync } from "node:crypto";
import { fingerprint, initFingerprintSalt } from "../../../../shared/util/fingerprint";
import { FIXED_TEST_SALT } from "../../../util/testSalt";

/** The same construction fingerprint() pins: PBKDF2-SHA256, one iteration, 32 bytes, hex, truncated. */
function saltedRendering(text: string, salt: string): string {
	return pbkdf2Sync(text, salt, 1, 32, "sha256").toString("hex").slice(0, 32);
}

describe("shared/util/fingerprint", () => {
	// The fixed salt the preload installed before any test file loaded.
	const testSalt = FIXED_TEST_SALT;

	test("distinguishes inputs that collide under 32-bit FNV-1a", () => {
		// This pair collides under the FNV-1a hash the fingerprint used to be; a
		// collision shares one cached client, and its credentials, across two
		// different API keys.
		assert.notStrictEqual(fingerprint("s6czs01643wfz"), fingerprint("1360ljmt56q89"));
	});

	test("is deterministic and hex-shaped", () => {
		assert.strictEqual(fingerprint("some-key"), fingerprint("some-key"));
		assert.match(fingerprint("some-key"), /^[0-9a-f]{32}$/);
		assert.notStrictEqual(fingerprint("some-key"), fingerprint("some-key2"));
	});

	test("is keyed by the salt: same input, different salt, different fingerprint", () => {
		assert.ok(testSalt.length > 0, "the harness must provide the fixed test salt");
		// The output is exactly the salted PBKDF2 rendering under the active salt,
		// so the salt provably participates - the defense against key guessing.
		assert.strictEqual(fingerprint("sk-1234"), saltedRendering("sk-1234", testSalt));
		assert.notStrictEqual(fingerprint("sk-1234"), saltedRendering("sk-1234", `${testSalt}-other`));
	});

	test("the salt is loaded once: a matching re-init is a no-op, a different one throws", () => {
		// The first fingerprint() call latched the harness salt, freezing the
		// identity space for the process: re-keying mid process would churn every
		// credential identity.
		const before = fingerprint("stable");
		initFingerprintSalt(testSalt);
		assert.strictEqual(fingerprint("stable"), before, "a matching re-init changes nothing");
		assert.throws(() => initFingerprintSalt("a-different-salt"), /already initialized/);
		assert.throws(() => initFingerprintSalt(""), /must not be empty/);
		assert.strictEqual(fingerprint("stable"), before, "a rejected re-init changes nothing either");
	});
});
