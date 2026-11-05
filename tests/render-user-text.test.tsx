/** Learner-authored text in the transcript: markdown and math by default,
 *  literal HTML, file-path chips, and the two Appearance toggles. */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { UserText, UserTextView } from "../components/user-text.tsx";
import { quoteFilePath } from "../src/core/file-paths.ts";

const view = (text: string, opts: { markdown?: boolean; math?: boolean; quoted?: boolean } = {}) => {
	const html = renderToStaticMarkup(<UserTextView text={text} markdown={opts.markdown ?? true} math={opts.math ?? true} quoted={opts.quoted} />);
	return { html, root: parseHTML(`<html><body>${html}</body></html>`).document.body };
};
const display = (root: Element) => root.querySelectorAll(".katex-display").length;
const katex = (root: Element) => root.querySelectorAll(".katex").length;

describe("user text: markdown on, math on", () => {
	it("renders markdown", () => {
		const { root } = view("**bold** and\n\n- one\n- two");
		assert.equal(root.querySelector("strong")?.textContent, "bold");
		assert.equal(root.querySelectorAll("li").length, 2);
	});

	it("renders single-dollar math inline and two-dollar math as a block", () => {
		const inline = view("The map $f(x)=x^2$ is smooth.").root;
		assert.equal(katex(inline), 1);
		assert.equal(display(inline), 0);
		for (const source of ["$$E=mc^2$$", "Before $$E=mc^2$$ after", "$$\nE=mc^2\n$$"]) {
			assert.equal(display(view(source).root), 1, source);
		}
	});

	it("keeps two-dollar math inline inside a list", () => {
		const { root } = view("- item $$x$$\n- next");
		assert.equal(root.querySelectorAll("li").length, 2);
		assert.equal(katex(root), 1);
		assert.equal(display(root), 0);
	});

	it("keeps single newlines as line breaks", () => {
		assert.equal(view("one\ntwo").root.querySelectorAll("br").length, 1);
	});
});

describe("user text: HTML stays literal", () => {
	for (const source of [
		"Use List<string> here",
		"if a<b then c>d",
		"What does <div> do and how is <span> different?",
		"Is <b>this</b> bold?",
	]) it(`keeps every word of ${source}`, () => {
		const { root } = view(source);
		assert.equal(root.textContent?.trim(), source);
		assert.equal(root.querySelector("b, script, span"), null, "no element came from the text");
	});

	it("shows a block of HTML as text in a paragraph", () => {
		const { root } = view("<script>alert(1)</script>\n\nafter");
		assert.equal(root.querySelector("script"), null);
		assert.match(root.querySelector("p")?.textContent ?? "", /<script>alert\(1\)<\/script>/);
	});

	it("still reads < inside math as math", () => {
		const { root } = view("$a<b$ and **bold**");
		assert.equal(katex(root), 1);
		assert.equal(root.querySelector("strong")?.textContent, "bold");
	});

	it("does not treat unfinished markdown as streaming", () => {
		assert.equal(view("**not closed").root.textContent?.trim(), "**not closed");
	});
});

describe("user text: file-path chips", () => {
	const path = "/home/me/my notes.md";

	for (const [name, opts] of [
		["markdown and math", {}],
		["markdown only", { math: false }],
		["plain text", { markdown: false }],
	] as const) it(`renders an attached path as a chip with ${name}`, () => {
		const { root } = view(`open ${quoteFilePath(path)} please`, opts);
		assert.equal(root.querySelector(`[role="img"]`)?.getAttribute("aria-label"), path);
		assert.equal(root.querySelector("code"), null);
	});

	it("keeps a path with markdown characters whole", () => {
		const tricky = "/tmp/my_file_$1*.md";
		const { root } = view(`see ${quoteFilePath(tricky)}`);
		assert.equal(root.querySelector(`[role="img"]`)?.getAttribute("aria-label"), tricky);
	});

	it("keeps other inline code as code", () => {
		const { root } = view("run `npm test` now");
		assert.equal(root.querySelector("code")?.textContent, "npm test");
		assert.equal(root.querySelector(`[role="img"]`), null);
	});

	it("keeps a path inside a fence as code", () => {
		const { root } = view("```\n/home/me/notes.md\n```");
		assert.equal(root.querySelector(`[role="img"]`), null);
		assert.match(root.textContent ?? "", /\/home\/me\/notes\.md/);
	});
});

describe("user text: math off", () => {
	it("shows dollars as typed", () => {
		for (const source of ["It costs $5 and $10 more.", "Inline $x^2$ stays"]) {
			const { root } = view(source, { math: false });
			assert.equal(katex(root), 0);
			assert.equal(root.textContent?.trim(), source);
		}
	});

	it("does not move two-dollar text into a block", () => {
		const { root } = view("Before $$x$$ after", { math: false });
		assert.equal(root.textContent?.trim(), "Before $$x$$ after");
		assert.equal(root.querySelectorAll("p").length, 1);
	});

	it("keeps markdown and literal HTML", () => {
		const { root } = view("**bold** and List<string>", { math: false });
		assert.equal(root.querySelector("strong")?.textContent, "bold");
		assert.match(root.textContent ?? "", /List<string>/);
	});
});

describe("user text: markdown off", () => {
	it("shows the exact text, whatever the math toggle says", () => {
		const source = "**bold** $x$\n\n\n   # kept";
		for (const math of [true, false]) {
			const { html, root } = view(source, { markdown: false, math });
			assert.equal(root.textContent, source);
			assert.equal(katex(root), 0);
			assert.equal(root.querySelector("strong"), null);
			assert.match(html, /whitespace-pre-wrap/);
		}
	});
});

describe("user text: quote marks", () => {
	it("are styled around rendered markdown", () => {
		assert.ok(view("words", { quoted: true }).root.querySelector(".lh-quoted"));
		assert.equal(view("words").root.querySelector(".lh-quoted"), null);
	});

	it("are real characters around plain text", () => {
		assert.equal(view("words", { markdown: false, quoted: true }).root.textContent, "“words”");
		assert.equal(view("words", { markdown: false }).root.textContent, "words");
	});
});

// Static renders cannot see this: settings arrive after first paint, so every
// message with the math toggle off goes through this update on page load.
describe("user text: changing the math toggle on a mounted message", () => {
	it("updates text the math step leaves unchanged", async () => {
		const dom = parseHTML("<html><body></body></html>");
		const globals = { window: dom.window, document: dom.document, Element: dom.window.Element,
			HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
		const previous = Object.getOwnPropertyDescriptors(globalThis);
		Object.assign(globalThis, globals);
		const host = dom.document.createElement("div"); dom.document.body.append(host);
		const root = createRoot(host);
		const render = (math: boolean) => act(async () => root.render(<UserTextView text="Inline $x^2$ here" markdown math={math} />));
		try {
			await render(true);
			assert.equal(katex(host), 1);
			await render(false);
			assert.equal(katex(host), 0, "math off clears rendered math");
			assert.equal(host.textContent?.trim(), "Inline $x^2$ here");
			await render(true);
			assert.equal(katex(host), 1, "math on renders it again");
		} finally {
			await act(async () => root.unmount());
			for (const key of Object.keys(globals)) {
				if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
	});
});

describe("UserText", () => {
	it("defaults to markdown and math", () => {
		const html = renderToStaticMarkup(<UserText text="**b** $x$" />);
		const { document } = parseHTML(`<html><body>${html}</body></html>`);
		assert.ok(document.querySelector("strong"));
		assert.equal(katex(document.body), 1);
	});
});
