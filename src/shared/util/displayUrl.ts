/** The display form of a URL echoed in user-facing error text: userinfo (user:pass@) is stripped. */

/**
 * For quoted diagnostic text (cause-chain messages, unparseable payloads) that may embed a credentialed URL
 * verbatim.
 */
export function redactUrlCredentials(text: string): string {
	// Greedy to the last "@" of the run, so multi-@ userinfo cannot leave a password tail behind; the leading "//"
	// anchor keeps bare emails in prose untouched.
	return text.replace(/\/\/[^/\s]*@/g, "//");
}

/**
 * A URL without userinfo passes through byte-identical, so pinned message texts never change for the common case. A
 * URL with userinfo is rebuilt from components, which cannot reassemble the credentials.
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
	// The parser gives a bare origin the "/" pathname; trim that one back so the echoed URL reads like the configured
	// one. Other parser normalizations may remain - the URL was rewritten anyway.
	return !url.endsWith("/") && parsed.pathname === "/" && parsed.search === "" && parsed.hash === ""
		? rebuilt.slice(0, -1)
		: rebuilt;
}
