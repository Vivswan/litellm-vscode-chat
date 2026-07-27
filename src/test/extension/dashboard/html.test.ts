import * as assert from "node:assert";
import { buildDashboardHtml } from "../../../extension/dashboard/html";

suite("extension/dashboard/html", () => {
	const options = {
		cspSource: "https://webview.test",
		nonce: "abc123",
		scriptUri: "https://webview.test/dist/webview/dashboard.js",
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
});
