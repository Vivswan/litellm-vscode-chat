/**
 * The display form of a URL echoed in user-facing error text: userinfo
 * (user:pass@) is stripped so credentials embedded in a configured URL never
 * reach toasts, chat errors, the dashboard, or the English log mirrors. Every
 * error-message URL echo routes through here - one pipeline. (The issue-report
 * path additionally redacts URLs wholesale at its own boundary; this helper
 * covers the surfaces that render URLs directly.)
 */

/**
 * Strip URL-embedded credentials from free text: every "//user[:pass]@" run
 * loses its userinfo. For quoted diagnostic text (cause-chain messages,
 * unparseable payloads) that may embed a credentialed URL verbatim, and the
 * fail-closed fallback for strings that do not parse as URLs. The leading "//"
 * anchor keeps bare emails in prose untouched.
 */
export function redactUrlCredentials(text: string): string {
	// Greedy to the last "@" of the run, so multi-@ userinfo cannot leave a
	// password tail behind; the leading "//" anchor keeps bare emails in prose
	// untouched.
	return text.replace(/\/\/[^/\s]*@/g, "//");
}

/**
 * A URL without userinfo passes through byte-identical, so pinned message
 * texts never change for the common case. A URL with userinfo is rebuilt from
 * components, which cannot reassemble the credentials; junk that does not
 * parse as a URL fails closed through the text-level scrub (a malformed
 * "http://user:pass@" must not leak just because the parser refused it).
 */
export function displayUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return redactUrlCredentials(url);
	}
	if (parsed.username === "" && parsed.password === "") {
		return url;
	}
	const rebuilt = `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
	// The parser gives a bare origin the "/" pathname; trim that one back so
	// the echoed URL reads like the configured one. Other parser
	// normalizations may remain - the URL was rewritten anyway.
	return !url.endsWith("/") && parsed.pathname === "/" && parsed.search === "" && parsed.hash === ""
		? rebuilt.slice(0, -1)
		: rebuilt;
}
