import * as assert from "node:assert";
import { buildDashboardHtml } from "../../../extension/dashboard/html";

suite("extension/dashboard/html", () => {
	const options = {
		cspSource: "https://webview.test",
		nonce: "abc123",
		scriptUri: "https://webview.test/dist/webview/dashboard.js",
		language: "en",
		l10nBundle: undefined,
	};

	test("carries a strict CSP: no default sources, nonce-gated scripts, cspSource-gated styles", () => {
		const html = buildDashboardHtml(options);
		const cspMatch = html.match(/http-equiv="Content-Security-Policy"\s*content="([^"]*)"/);
		assert.ok(cspMatch?.[1], "CSP meta tag missing");
		const csp = cspMatch[1];

		assert.ok(csp.includes("default-src 'none'"), csp);
		assert.ok(csp.includes("form-action 'none'"), csp);
		assert.ok(csp.includes("base-uri 'none'"), csp);
		assert.ok(csp.includes(`script-src 'nonce-${options.nonce}'`), csp);
		assert.ok(csp.includes(`style-src ${options.cspSource} 'unsafe-inline'`), csp);
		assert.ok(!csp.includes("unsafe-eval"), csp);
	});

	test("the script tag carries the nonce and the webview URI", () => {
		const html = buildDashboardHtml(options);

		assert.ok(html.includes(`<script nonce="${options.nonce}" src="${options.scriptUri}"></script>`), html);
	});

	test("interpolated values are attribute-escaped", () => {
		const html = buildDashboardHtml({
			...options,
			scriptUri: 'https://webview.test/x?a=1&b="2"',
		});

		assert.ok(html.includes("a=1&amp;b=&quot;2&quot;"), "special characters must be escaped");
		assert.ok(!html.includes('b="2"'), "raw quotes must not survive into the attribute");
	});

	test("styles use theme tokens", () => {
		const html = buildDashboardHtml(options);
		const style = html.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? "";

		assert.ok(style.includes("var(--vscode-foreground)"));
		assert.ok(style.includes("var(--vscode-button-background)"));
	});

	test("the html element carries the host's display language, attribute-escaped", () => {
		assert.ok(buildDashboardHtml(options).includes('<html lang="en">'));
		assert.ok(buildDashboardHtml({ ...options, language: "zh-cn" }).includes('<html lang="zh-cn">'));
		assert.ok(
			buildDashboardHtml({ ...options, language: '"><script>' }).includes('<html lang="&quot;&gt;&lt;script&gt;">')
		);
	});

	test("without a bundle no inline script renders and the title stays English", () => {
		const html = buildDashboardHtml(options);

		assert.ok(!html.includes("__l10nBundle"), html);
		assert.ok(html.includes("<title>LiteLLM Dashboard</title>"), html);
	});

	test("an injected bundle renders as a nonce'd inline script before the dashboard script", () => {
		const html = buildDashboardHtml({
			...options,
			language: "zh-cn",
			l10nBundle: { "Manage LiteLLM Provider": "translated-title" },
		});

		const inline = html.match(/<script nonce="([^"]+)">window\.__l10nBundle = (.*);<\/script>/);
		assert.ok(inline, "inline bundle script missing");
		assert.strictEqual(inline[1], options.nonce);
		assert.deepStrictEqual(JSON.parse(inline[2] ?? ""), { "Manage LiteLLM Provider": "translated-title" });
		assert.ok(
			html.indexOf("window.__l10nBundle") < html.indexOf(`src="${options.scriptUri}"`),
			"the bundle must be set before the dashboard bundle loads"
		);
	});

	test("bundle JSON cannot break out of the inline script", () => {
		const html = buildDashboardHtml({
			...options,
			l10nBundle: { "</script><script>": "x\u2028y\u2029z</style>" },
		});

		const body = html.match(/window\.__l10nBundle = (.*);<\/script>/)?.[1] ?? "";
		assert.ok(!body.includes("<"), "every '<' must be escaped inside the inline script");
		assert.ok(!body.includes("\u2028") && !body.includes("\u2029"), "line separators must be escaped");
		assert.deepStrictEqual(JSON.parse(body), { "</script><script>": "x\u2028y\u2029z</style>" });
	});
});
