import escapeStringRegExp from "escape-string-regexp";

/**
 * The monkey fuzzer's leak oracle, kept free of vscode so the bun tree can pin it. The fuzzer mints a secret per
 * credentialed walk and logs more per provider group, so the scan is one matcher per batch rather than one pass per
 * secret.
 *
 *   longest literal first -> a secret that prefixes another names the longer one when both are present
 *   no secrets            -> an empty alternation would match every line
 */
export function findSecretLeak(
	lines: readonly string[],
	secrets: readonly string[]
): { readonly lineIndex: number; readonly secret: string } | undefined {
	const distinct = [...new Set(secrets)].sort((a, b) => b.length - a.length);
	if (distinct.length === 0) {
		return undefined;
	}
	const matcher = new RegExp(distinct.map((secret) => escapeStringRegExp(secret)).join("|"));
	for (const [lineIndex, line] of lines.entries()) {
		const match = matcher.exec(line);
		if (match !== null) {
			return { lineIndex, secret: match[0] };
		}
	}
	return undefined;
}
