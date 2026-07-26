import * as assert from "node:assert";
import { fingerprint } from "../../shared/fingerprint";

suite("shared/fingerprint", () => {
	test("distinguishes inputs that collide under 32-bit FNV-1a", () => {
		// This pair collides under the FNV-1a hash the fingerprint used to be:
		// a collision here would share one cached client (and its credentials)
		// between two different API keys.
		assert.notStrictEqual(fingerprint("s6czs01643wfz"), fingerprint("1360ljmt56q89"));
	});

	test("is deterministic and hex-shaped", () => {
		assert.strictEqual(fingerprint("some-key"), fingerprint("some-key"));
		assert.match(fingerprint("some-key"), /^[0-9a-f]{32}$/);
		assert.notStrictEqual(fingerprint("some-key"), fingerprint("some-key2"));
	});
});
