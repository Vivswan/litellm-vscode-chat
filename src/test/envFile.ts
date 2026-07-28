/**
 * .env parsing and variable resolution for the local docker stack, shared by
 * the scripts (config generation, docker-test, dev-fake) and pinned by the
 * unit suite. The grammar follows what Docker Compose itself reads (the
 * godotenv subset the stack relies on): `export ` prefixes are stripped,
 * whole-value single or double quotes are removed, an unquoted value ends at
 * the first `#` that is preceded by whitespace (so `4100 # local` is "4100"
 * and `a#b` stays intact), a comment may follow a closing quote, and an
 * empty value with a trailing comment is empty. Quote stripping is ONE layer
 * only (`"'x'"` keeps its inner quotes, as compose does). Deliberately NOT
 * supported, so the shared blind spot is stated rather than discovered:
 * multi-line quoted values and variable interpolation inside values.
 */

/**
 * The docker stack's default connection settings, one per compose variable.
 * docker-compose.yml restates each as a `${VAR:-default}` fallback (compose
 * cannot import TypeScript), and .env.example and the README restate them as
 * prose; src/test/stackDrift.test.ts pins all three mirrors. The scripts and
 * docker suites take their fallbacks from here, so a rotated default changes
 * every consumer at once.
 */
export const STACK_DEFAULTS = {
	LITELLM_PORT: "4000",
	FAKE_OPENAI_PORT: "8090",
	LITELLM_MASTER_KEY: "sk-test-1234",
} as const;

/**
 * Parse .env file content into key/value pairs (pure; no filesystem).
 * Diverging from compose here would make config generation disagree with
 * what the containers receive.
 */
export function parseEnvFile(content: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) {
			continue;
		}
		const unexported = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
		const eq = unexported.indexOf("=");
		if (eq === -1) {
			continue;
		}
		const key = unexported.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			continue;
		}
		values[key] = parseValue(unexported.slice(eq + 1).trim());
	}
	return values;
}

function parseValue(rest: string): string {
	const quote = rest[0];
	if (quote === '"' || quote === "'") {
		const closing = rest.indexOf(quote, 1);
		if (closing !== -1) {
			// Anything after the closing quote (whitespace, a comment) is ignored.
			return rest.slice(1, closing);
		}
	}
	// Unquoted: the value ends at the first '#' preceded by whitespace; a '#'
	// glued to the value is part of it. `rest` is pre-trimmed, so a leading
	// '#' means the whole value is a comment and the value is empty.
	const comment = rest.search(/(^|\s)#/);
	return (comment === -1 ? rest : rest.slice(0, comment)).trim();
}

/**
 * A variable with docker compose's `${VAR:-fallback}` semantics: the shell
 * environment wins over .env even when set to empty, and an empty resolved
 * value takes the fallback. Diverging from this (e.g. letting .env override
 * an empty shell variable) would make generation disagree with what the
 * container actually receives.
 */
export function composeSetting(
	name: string,
	fallback: string,
	envFile: Record<string, string>,
	env: Record<string, string | undefined> = process.env
): string {
	const raw = env[name] !== undefined ? env[name] : envFile[name];
	return raw ? raw : fallback;
}
