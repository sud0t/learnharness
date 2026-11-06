/** mhchem and the `${} x {}$` that `mk` writes, through every place math renders. */
import React from "react";
(globalThis as { React?: typeof React }).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { LIVE_WIDGET_ATTRIBUTE, renderLiveInput, revealLiveInput } from "../components/path-input-dom.ts";
import { UserTextView } from "../components/user-text.tsx";
import { canParseTex, knownTexCommand } from "../src/core/content-reader.ts";
import { readLiveFormat, repairMathForDisplay, transformMathDelimiters } from "../src/core/index.ts";

const sent = (text: string) => renderToStaticMarkup(<UserTextView text={text} markdown math />);
const reply = (text: string) => renderToStaticMarkup(<MessageResponse>{text}</MessageResponse>);
const tex = (html: string) => [...html.matchAll(/<annotation[^>]*>([^<]*)</g)].map((match) => match[1]!.replaceAll("&gt;", ">"));
function live(value: string, caret: number | null = null) {
	const { document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const root = document.getElementById("root") as unknown as HTMLElement;
	const { view } = renderLiveInput(root, value, readLiveFormat(value, { math: true }));
	if (caret !== null) revealLiveInput(view, { anchor: caret, focus: caret });
	return root;
}

const CHEMISTRY = ["\\ce{H2O}", "\\ce{2H2 + O2 -> 2H2O}", "\\ce{CO2 + C -> 2 CO}", "\\pu{123 kJ/mol}", "\\pu{1.5e3 m/s}"];

describe("mhchem", () => {
	it("is known to KaTeX", () => {
		assert.equal(knownTexCommand("ce"), true);
		assert.equal(knownTexCommand("pu"), true);
	});
	for (const source of CHEMISTRY) {
		it(`parses ${source}`, () => assert.equal(canParseTex(source, false), true));
		it(`renders ${source} in a sent message`, () => {
			const html = sent(`Then $${source}$ follows`);
			assert.deepEqual(tex(html), [source]);
			assert.doesNotMatch(html, /katex-error/);
		});
		it(`renders ${source} in a reply`, () => {
			const html = reply(`Then $${source}$ follows`);
			assert.deepEqual(tex(html), [source]);
			assert.doesNotMatch(html, /katex-error/);
		});
		it(`renders ${source} in the live box`, () => {
			const root = live(`Then $${source}$ follows`);
			assert.ok(root.querySelector(".katex"));
			assert.doesNotMatch(root.innerHTML, /katex-error/);
		});
		it(`renders ${source} in a block equation's preview`, () => {
			const root = live(`$$\n${source}\n$$`, 4);
			assert.ok(root.querySelector(`[${LIVE_WIDGET_ATTRIBUTE}]`)?.querySelector(".katex"), "the preview draws");
			assert.doesNotMatch(root.innerHTML, /katex-error/);
		});
		it(`is left alone on its way to the renderer: ${source}`, () => {
			for (const text of [`$${source}$`, `$$\n${source}\n$$`]) {
				assert.equal(transformMathDelimiters(text), text);
				assert.equal(repairMathForDisplay(text), text);
			}
		});
	}
});

describe("the math `mk` writes", () => {
	const math = "${} x {}$";
	it("stays in the text as it is", () => {
		assert.equal(transformMathDelimiters(math), math);
		assert.equal(repairMathForDisplay(math), math);
	});
	it("renders in a sent message, spaces and all", () => {
		const html = sent(`so ${math} here`);
		assert.deepEqual(tex(html), ["{} x {}"]);
		assert.doesNotMatch(html, /katex-error/);
	});
	it("renders in a reply", () => {
		const html = reply(`so ${math} here`);
		assert.deepEqual(tex(html), ["{} x {}"]);
		assert.doesNotMatch(html, /katex-error/);
	});
	it("renders in the live box", () => {
		const root = live(`so ${math} here`);
		assert.ok(root.querySelector(".katex"));
		assert.doesNotMatch(root.innerHTML, /katex-error/);
	});
	it("renders with nothing in it", () => {
		const html = sent("so ${}{}$ here");
		assert.deepEqual(tex(html), ["{}{}"]);
		assert.doesNotMatch(html, /katex-error/);
	});
});
