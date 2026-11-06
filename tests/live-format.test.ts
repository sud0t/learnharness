/** Reading formatting out of a draft: what is found, and the exact source
 *  offsets of the symbols the editor may hide. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	LIVE_FORMAT_LIMIT, quoteFilePath, readLiveFormat, revealedLiveKeys,
	type LiveItem, type LiveMath, type LiveRange, type LiveSpan,
} from "../src/core/index.ts";

const read = (text: string, math = true) => readLiveFormat(text, { math });
const spans = (text: string, math = true) => read(text, math).items.filter((item): item is LiveSpan => item.kind === "span");
const maths = (text: string) => read(text).items.filter((item): item is LiveMath => item.kind === "math");
const slice = (text: string, ranges: LiveRange[]) => ranges.map(range => text.slice(range.start, range.end));
const shape = (text: string) => read(text).items.map((item: LiveItem) => item.kind === "span" ? item.style : "math");

describe("live format: inline items", () => {
	for (const [text, style, markers] of [
		["a **bold** b", "strong", ["**", "**"]],
		["a __bold__ b", "strong", ["__", "__"]],
		["a *it* b", "emphasis", ["*", "*"]],
		["a ~~gone~~ b", "delete", ["~~", "~~"]],
		["a `code` b", "code", ["`", "`"]],
		["a ``co`de`` b", "code", ["``", "``"]],
		["a [site](http://a.b) b", "link", ["[", "](http://a.b)"]],
	] as const) it(`finds ${style} in ${text}`, () => {
		const [span] = spans(text);
		assert.equal(span?.style, style);
		assert.deepEqual(slice(text, span!.markers), markers);
	});

	it("styles a bare URL with nothing to hide", () => {
		const [span] = spans("see https://example.com now");
		assert.equal(span?.style, "link");
		assert.deepEqual(span?.markers, []);
	});

	it("nests", () => {
		assert.deepEqual(shape("***both***").sort(), ["emphasis", "strong"]);
	});

	it("reads a whole item across lines", () => {
		assert.deepEqual(slice("**a\nb**", spans("**a\nb**")[0]!.markers), ["**", "**"]);
	});
});

describe("live format: what stays as typed", () => {
	for (const text of [
		"**not closed",
		"`not closed",
		"$not closed",
		"plain text only",
		"```\n**a** $x$\n```",
		"| a | **b** |\n|---|---|\n| $x$ | 2 |",
		"<div>**html block**</div>",
		"![alt **text**](a.png)",
	]) it(text.replace(/\n/g, "⏎"), () => {
		assert.deepEqual(read(text), { items: [], lines: [] });
	});

	it("leaves an empty draft and an oversized draft alone", () => {
		assert.deepEqual(read(""), { items: [], lines: [] });
		assert.deepEqual(read("**a** ".repeat(LIVE_FORMAT_LIMIT / 5)), { items: [], lines: [] });
	});

	it("leaves file paths to their chips", () => {
		const text = `see ${quoteFilePath("/home/me/a.pdf")} and \`code\``;
		assert.deepEqual(spans(text).map(span => text.slice(span.start, span.end)), ["`code`"]);
	});

	it("does not read math inside a file path", () => {
		assert.deepEqual(maths(`${quoteFilePath("/tmp/$a$.md")}`), []);
	});
});

describe("live format: math", () => {
	it("finds inline math with its TeX and caret stop", () => {
		const text = "see $x^2$ here";
		const [math] = maths(text);
		assert.deepEqual([math?.start, math?.end, math?.tex, math?.display], [4, 9, "x^2", false]);
		assert.equal(math?.caret, 8, "inside the closing dollar");
	});

	it("stops the caret in a fence at the end of the equation, not on the closing line", () => {
		const text = "$$\nx^2\n$$";
		assert.equal(maths(text)[0]?.caret, text.indexOf("x^2") + 3);
	});

	it("shows two-dollar math as a block, except where a block would break the line", () => {
		assert.equal(maths("$$x$$")[0]?.display, true);
		assert.equal(maths("Before $$x$$ after")[0]?.display, true);
		assert.equal(maths("$$\nx\n$$")[0]?.display, true);
		assert.equal(maths("- item $$x$$")[0]?.display, false);
		assert.equal(maths("> quoted $$x$$")[0]?.display, false);
	});

	it("reads the backslash forms", () => {
		const text = String.raw`\(a\) and \[b\]`;
		assert.deepEqual(maths(text).map(math => [math.tex, math.display]), [["a", false], ["b", true]]);
	});

	it("keeps Markdown out of math", () => {
		assert.deepEqual(shape(String.raw`\(a*b\) and \(c*d\)`), ["math", "math"]);
		assert.deepEqual(shape("$a*b$ and $c*d$"), ["math", "math"]);
	});

	it("reads inside bold", () => {
		assert.deepEqual(shape("**$x$ bold**"), ["strong", "math"]);
	});

	it("matches sent messages on dollar amounts", () => {
		assert.equal(maths("It costs $5 and $10 more")[0]?.tex, "5 and ");
	});

	it("reads no equation until it is closed", () => {
		assert.deepEqual(maths("$$E=mc^2"), []);
		assert.deepEqual(maths("$$\nE=mc^2\n"), []);
	});

	it("reads none with math off, and Markdown takes the text back", () => {
		assert.deepEqual(read("$a*b$ and $c*d$", false).items.map(item => item.kind === "span" ? item.style : "math"), ["emphasis"]);
	});

	it("leaves an equation that runs through formatted lines as source", () => {
		assert.deepEqual(maths("> $$\n> x\n> $$"), []);
	});
});

describe("live format: lines", () => {
	const line = (text: string, index = 0) => read(text).lines[index]!;

	it("hides a heading's marker", () => {
		const text = "## Title";
		assert.equal(line(text).heading, 2);
		assert.deepEqual(slice(text, line(text).markers), ["## "]);
	});

	it("styles an underlined heading's text and keeps its underline", () => {
		const text = "Title\n---";
		assert.equal(read(text).lines.length, 1);
		assert.equal(line(text).heading, 2);
		assert.deepEqual(line(text).markers, []);
	});

	it("reads bullets and their depth", () => {
		const text = "- one\n  - two";
		assert.deepEqual(read(text).lines.map(value => [value.list, value.depth]), [["bullet", 1], ["bullet", 2]]);
		assert.deepEqual(slice(text, line(text, 1).markers), ["  ", "- "]);
	});

	it("keeps an ordered list's number", () => {
		const text = "1. one";
		assert.equal(line(text).list, "ordered");
		assert.deepEqual(line(text).markers, []);
	});

	it("reads each quote marker, including lazy lines", () => {
		const text = "> > deep\nlazy";
		assert.equal(line(text).quote, 2);
		assert.deepEqual(slice(text, line(text).markers), ["> ", "> "]);
		assert.equal(line(text, 1).quote, 2);
		assert.deepEqual(line(text, 1).markers, []);
	});

	it("stacks a quote and a list on one line", () => {
		const text = "> - item";
		assert.deepEqual([line(text).quote, line(text).list], [1, "bullet"]);
		assert.deepEqual(slice(text, line(text).markers), ["> ", "- "]);
	});

	it("gives a line's end past its newline and its text end before it", () => {
		const text = "- one\nnext";
		assert.deepEqual([line(text).start, line(text).textEnd, line(text).end], [0, 5, 6]);
	});

	it("survives Windows line endings", () => {
		assert.deepEqual(slice("a\r\nb **c**", spans("a\r\nb **c**")[0]!.markers), ["**", "**"]);
	});

	it("takes empty markers without failing", () => {
		assert.equal(line("#").heading, 1);
		assert.equal(line("-").list, "bullet");
	});
});

describe("live format: what a selection reveals", () => {
	const format = read("a **b** c\n# Title\nend");
	const keys = (anchor: number, focus = anchor) => [...revealedLiveKeys(format, { anchor, focus })].sort();

	it("reveals nothing without a selection", () => {
		assert.equal(revealedLiveKeys(format, null).size, 0);
	});

	it("reveals an item with the caret on either edge, not one step away", () => {
		assert.deepEqual(keys(1), []);
		assert.deepEqual(keys(2), ["i0"]);
		assert.deepEqual(keys(4), ["i0"]);
		assert.deepEqual(keys(7), ["i0"]);
		assert.deepEqual(keys(8), []);
	});

	it("reveals a marker anywhere on its line", () => {
		assert.deepEqual(keys(10), ["l0"]);
		assert.deepEqual(keys(17), ["l0"]);
		assert.deepEqual(keys(18), []);
	});

	it("reveals everything a range touches, in either direction", () => {
		assert.deepEqual(keys(0, 20), ["i0", "l0"]);
		assert.deepEqual(keys(20, 0), ["i0", "l0"]);
	});
});
