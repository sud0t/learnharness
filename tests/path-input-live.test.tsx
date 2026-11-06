/** Format as you type, in the editor. linkedom has no layout or native editing,
 *  so this pins the offset and model contract; caret movement itself was
 *  verified in Chromium and cannot be tested here. */
import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { LivePathInput } from "../components/live-path-input.tsx";
import { PathInput } from "../components/path-input.tsx";
import {
	atPreviewEnd, keepPreviewInView, LIVE_WIDGET_ATTRIBUTE, pathInputOffset, pathInputPoint, previewArrowTarget, readPathInput, readPathSelection, renderLiveInput, renderPathInput,
	restorePathSelection, revealLiveInput, settleLiveCaret,
} from "../components/path-input-dom.ts";
import { LIVE_FORMAT_LIMIT, quoteFilePath, readLiveFormat, type LiveFormatOptions } from "../src/core/index.ts";

const MATH = { math: true };
const draw = (value: string, options: LiveFormatOptions = MATH) => {
	const { document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const root = document.getElementById("root") as unknown as HTMLElement;
	const format = readLiveFormat(value, options);
	const { chips, view } = renderLiveInput(root, value, format);
	return { root, view, chips, format };
};

const drafts = [
	"",
	"plain",
	"a **b** c",
	"***both*** and ~~gone~~ and `code` and [site](http://a.b)",
	"see $x^2$ and $$y$$ and \\(z\\)",
	"# Title\n\n- one **b**\n  - nested\n\n> quoted $q$\n\n1. first\n\nend\n",
	"$$\n\\frac{a}{b}\n$$\nafter",
	"```\n**a**\n```\n| a |\n|---|",
	"trailing newline\n",
	"- list ending\n",
	"a\r\nb **c**",
];

describe("drawing a formatted draft", () => {
	for (const value of drafts) {
		it(`keeps every character of ${JSON.stringify(value)}`, () => {
			assert.equal(readPathInput(draw(value).root), value);
		});
		it(`maps every offset of ${JSON.stringify(value)} there and back`, () => {
			const { root } = draw(value);
			for (let offset = 0; offset <= value.length; offset++) {
				const point = pathInputPoint(root, offset);
				assert.equal(pathInputOffset(root, point.node, point.offset), offset, `offset ${offset}`);
			}
		});
	}

	it("draws plain text exactly as the plain editor does", () => {
		const value = "just\nwords";
		const live = draw(value).root;
		const plain = live.cloneNode(false) as HTMLElement;
		renderPathInput(plain, value);
		assert.equal(live.innerHTML, plain.innerHTML);
	});

	it("keeps a chip whole inside a formatted line", () => {
		const path = "/home/me/a.pdf";
		const value = `- ${quoteFilePath(path)} **b**`;
		const { root, chips } = draw(value);
		assert.deepEqual(chips.map(chip => chip.path), [path]);
		assert.ok(root.querySelector(".lh-lf-line")?.contains(chips[0]!.host));
		assert.equal(readPathInput(root), value);
	});

	it("does not count an equation's drawing as text", () => {
		const { root } = draw("a $x^2$ b");
		assert.ok(root.querySelector(".katex"));
		assert.equal(readPathInput(root), "a $x^2$ b");
	});

	it("maps a point inside an equation to the equation", () => {
		const { root } = draw("a $x$ b");
		const inside = root.querySelector(`[${LIVE_WIDGET_ATTRIBUTE}] .katex`)!;
		assert.equal(pathInputOffset(root, inside, 0), 2);
	});

	it("shows bad TeX without throwing", () => {
		assert.ok(draw("$\\notacommand{$").root.querySelector(`[${LIVE_WIDGET_ATTRIBUTE}]`));
	});

	it("keeps every character of a draft at the size limit", () => {
		const value = "**a** $x$ ".repeat(LIVE_FORMAT_LIMIT / 10);
		const { root, format } = draw(value);
		assert.equal(format.items.length, LIVE_FORMAT_LIMIT / 5);
		assert.equal(readPathInput(root), value);
	});
});

describe("TeX that KaTeX cannot read", () => {
	it("shows muted for a ParseError", () => {
		assert.match(draw("$\\frac$ tail").root.innerHTML, /katex-error/);
	});
	for (const tex of ["\\begin{a b}x\\end{a b}", "\\begin{a~b}", "\\begin{pmatrix}a\\end{pma~trix}", "\\begin{\\quad}"]) {
		it(`does not throw for ${tex}, which is a plain Error to KaTeX`, () => {
			const { innerHTML } = draw(`$${tex}$ tail`).root;
			assert.match(innerHTML, /katex-error/);
		});
	}
	it("keeps the source from being read as markup", () => {
		assert.equal(draw("$\\begin{a b}<i>$ tail").root.querySelector("i"), null);
	});
});

describe("revealing source", () => {
	it("toggles attributes and never replaces a node", () => {
		const { root, view } = draw("a **b** $x$ c");
		const nodes = [...root.childNodes];
		const text = root.querySelector(".lh-lf-strong")!.firstChild;
		const shown = () => [...root.querySelectorAll("[data-show]")].map(element => element.textContent);
		assert.deepEqual(shown(), []);
		revealLiveInput(view, { anchor: 4, focus: 4 });
		assert.deepEqual(shown(), ["**", "**"]);
		revealLiveInput(view, null);
		assert.deepEqual(shown(), []);
		assert.deepEqual([...root.childNodes], nodes);
		assert.equal(root.querySelector(".lh-lf-strong")!.firstChild, text);
	});

	it("takes an equation's drawing out of the editing path while its source shows", () => {
		const { root, view } = draw("$x$");
		const widget = root.querySelector(`[${LIVE_WIDGET_ATTRIBUTE}]`)!;
		assert.equal(widget.getAttribute("contenteditable"), "false");
		revealLiveInput(view, { anchor: 0, focus: 0 });
		assert.equal(widget.hasAttribute("data-show"), true);
		assert.equal(widget.hasAttribute("contenteditable"), false);
		revealLiveInput(view, null);
		assert.equal(widget.getAttribute("contenteditable"), "false");
	});

	it("keeps a block equation on screen below its source, as its preview", () => {
		const { root, view } = draw("$$E=mc^2$$\nnext");
		const widget = root.querySelector(`[${LIVE_WIDGET_ATTRIBUTE}]`)!;
		const source = root.querySelector(".lh-lf-source")!;
		assert.equal(source.nextSibling?.nodeName, "BR", "the source ends its own line");
		assert.equal(source.nextSibling?.nextSibling, widget, "the preview follows the source");
		revealLiveInput(view, { anchor: 3, focus: 3 });
		assert.equal(source.hasAttribute("data-show"), true);
		assert.equal(widget.hasAttribute("data-show"), false, "the preview is not hidden");
		assert.equal(widget.getAttribute("contenteditable"), "false");
		revealLiveInput(view, null);
		assert.equal(source.hasAttribute("data-show"), false);
	});

	it("gives an equation in a list no preview: it stays inline", () => {
		const { root, view } = draw("- item $$x$$");
		assert.equal(view.previews.size, 0);
		revealLiveInput(view, { anchor: 10, focus: 10 });
		assert.equal(root.querySelector(`[${LIVE_WIDGET_ATTRIBUTE}]`)!.hasAttribute("data-show"), true);
	});

	it("draws no preview for an unclosed equation", () => {
		assert.equal(draw("$$E=mc^2").root.querySelector(`[${LIVE_WIDGET_ATTRIBUTE}]`), null);
	});

	it("steps arrow keys around a block equation", () => {
		const value = "ab\n$$x$$\ncd";
		const { view } = draw(value);
		const target = (offset: number, key: string) => previewArrowTarget(view, value, offset, key);
		assert.equal(target(2, "ArrowRight"), 3, "into the hidden source");
		assert.equal(target(8, "ArrowRight"), 9, "out past the preview");
		assert.equal(target(8, "ArrowDown"), 9);
		for (const [offset, key] of [[1, "ArrowRight"], [5, "ArrowRight"], [8, "ArrowLeft"], [8, "ArrowUp"], [2, "ArrowDown"], [9, "ArrowLeft"], [8, "x"]] as const) {
			assert.equal(target(offset, key), null, `${offset} ${key}`);
		}
		assert.equal(atPreviewEnd(view, 8), true);
		assert.equal(atPreviewEnd(view, 7), false);
	});

	it("stops arrow keys at the end of a draft, and never splits an emoji", () => {
		const closed = draw("$$x$$");
		assert.equal(previewArrowTarget(closed.view, "$$x$$", 5, "ArrowRight"), 5);
		const emoji = "$$x$$😀";
		assert.equal(previewArrowTarget(draw(emoji).view, emoji, 5, "ArrowRight"), 7);
	});

	it("leaves arrow keys alone around inline math", () => {
		const value = "a\n$x$\nb";
		const { view } = draw(value);
		assert.equal(previewArrowTarget(view, value, 1, "ArrowRight"), null);
		assert.equal(previewArrowTarget(view, value, 5, "ArrowRight"), null);
	});

	it("scrolls a preview into view without losing its source", () => {
		const { root, view } = draw("$$x$$");
		const rect = (top: number, bottom: number) => () => ({ top, bottom }) as DOMRect;
		root.getBoundingClientRect = rect(0, 100);
		view.previews.get("i0")!.getBoundingClientRect = rect(90, 140);
		root.querySelector(".lh-lf-source")!.getBoundingClientRect = rect(70, 90);
		root.scrollTop = 0;
		revealLiveInput(view, { anchor: 0, focus: 0 });
		keepPreviewInView(root, view);
		assert.equal(root.scrollTop, 40);
		root.scrollTop = 0;
		view.previews.get("i0")!.getBoundingClientRect = rect(30, 300);
		root.querySelector(".lh-lf-source")!.getBoundingClientRect = rect(10, 30);
		keepPreviewInView(root, view);
		assert.equal(root.scrollTop, 10, "stops with the source at the top");
	});

	it("shows a line's markers together", () => {
		const { root, view } = draw("> - item\nend");
		revealLiveInput(view, { anchor: 5, focus: 5 });
		assert.deepEqual([...root.querySelectorAll(".lh-lf-marker[data-show]")].map(element => element.textContent), ["> ", "- "]);
		assert.ok(root.querySelector(".lh-lf-line[data-show]"));
	});
});

describe("settling a caret that lands against hidden symbols", () => {
	const value = "ab ***cd*** ef";
	it("moves it outside them", () => {
		const { view } = draw(value);
		assert.equal(settleLiveCaret(view, 6), 3, "after the opener");
		assert.equal(settleLiveCaret(view, 8), 11, "before the closer");
	});

	it("leaves every other position alone", () => {
		const { view } = draw(value);
		for (const offset of [0, 3, 7, 11, 14]) assert.equal(settleLiveCaret(view, offset), offset);
	});

	it("leaves a caret already inside shown symbols alone", () => {
		const { view } = draw("ab **cd** ef");
		revealLiveInput(view, { anchor: 5, focus: 5 });
		assert.equal(settleLiveCaret(view, 5), 5);
		assert.equal(settleLiveCaret(view, 7), 7);
	});
});

describe("the mounted editor", () => {
	let cleanup = async () => {};
	afterEach(async () => { await cleanup(); cleanup = async () => {}; });

	async function mount(initial: string, initialLive: LiveFormatOptions | null = MATH, Input: typeof PathInput | typeof LivePathInput = PathInput) {
		const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
		let active: Element = doc.body;
		Object.defineProperty(doc, "activeElement", { get: () => active });
		const selection = {
			anchorNode: null as Node | null, anchorOffset: 0, focusNode: null as Node | null, focusOffset: 0,
			setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
				Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
			},
		};
		Object.assign(doc, { getSelection: () => selection, oninput: null });
		win.HTMLElement.prototype.focus = function () { active = this; };
		const globals = { window: win, document: doc, HTMLElement: win.HTMLElement, Element: win.Element, Event: win.Event, IS_REACT_ACT_ENVIRONMENT: true };
		const previous = Object.getOwnPropertyDescriptors(globalThis);
		Object.assign(globalThis, globals);
		const { createRoot } = await import("react-dom/client");
		const reactRoot = createRoot(doc.getElementById("root")!);
		const ref = React.createRef<HTMLDivElement>();
		let value = initial, live = initialLive;
		const render = () => reactRoot.render(<Input ref={ref} value={value} liveFormat={live} onValueChange={next => { value = next; render(); }} />);
		await act(async () => render());
		cleanup = async () => {
			await act(async () => reactRoot.unmount());
			for (const key of Object.keys(globals)) {
				if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!);
				else Reflect.deleteProperty(globalThis, key);
			}
		};
		const root = ref.current!;
		root.focus();
		const fire = async (type: string, properties: Record<string, unknown> = {}, target: EventTarget = root) => {
			const event = new win.Event(type, { bubbles: true, cancelable: true });
			Object.assign(event, properties);
			await act(async () => { target.dispatchEvent(event); });
			return event;
		};
		const select = async (anchor: number, focus = anchor) => {
			restorePathSelection(root, { anchor, focus });
			await fire("selectionchange", {}, doc);
		};
		const showing = () => root.querySelectorAll("[data-show]").length;
		return { root, doc, fire, select, showing, get value() { return value; },
			async setLive(next: LiveFormatOptions | null) { await act(async () => { live = next; render(); }); } };
	}

	it("formats once mounted and follows the setting", async () => {
		const editor = await mount("**b** $x$", null);
		assert.equal(editor.root.querySelector(".lh-lf-strong"), null);
		await editor.setLive(MATH);
		assert.ok(editor.root.querySelector(".lh-lf-strong"));
		assert.ok(editor.root.querySelector(".katex"));
		await editor.setLive({ math: false });
		assert.ok(editor.root.querySelector(".lh-lf-strong"));
		assert.equal(editor.root.querySelector(".katex"), null);
		await editor.setLive(null);
		assert.equal(editor.root.querySelector(".lh-lf-strong"), null);
		assert.equal(readPathInput(editor.root), "**b** $x$");
		assert.equal(editor.value, "**b** $x$");
	});

	it("reveals what the caret touches and hides it again on blur", async () => {
		const editor = await mount("**b** rest");
		await editor.select(9);
		assert.equal(editor.showing(), 0);
		await editor.select(3);
		assert.equal(editor.showing(), 2);
		await editor.fire("blur", {});
		assert.equal(editor.showing(), 2, "focus is still reported here");
		(editor.doc.activeElement as HTMLElement | null)?.blur?.();
	});

	/** A caret drawn far below a box that is scrolled away from it. */
	const scrolledAway = (root: HTMLElement) => {
		root.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 300 }) as DOMRect;
		Object.defineProperties(root, { clientHeight: { value: 100 }, clientWidth: { value: 300 }, clientTop: { value: 0 }, clientLeft: { value: 0 } });
		(root.ownerDocument as unknown as { createRange: () => unknown }).createRange = () => ({
			setStart() {}, setEnd() {}, collapse() {}, selectNode() {},
			getClientRects: () => [{ top: 500, bottom: 522, left: 5, right: 5, height: 22 }],
		});
		root.scrollTop = 40;
	};

	it("leaves a box the learner scrolled alone on keys that move nothing", async () => {
		const editor = await mount("plain words");
		await editor.select(3);
		scrolledAway(editor.root);
		await editor.fire("keydown", { key: "Control", ctrlKey: true });
		assert.equal(editor.root.scrollTop, 40);
	});

	it("follows the caret when showing symbols moves the text", async () => {
		const editor = await mount("**b** rest");
		await editor.select(9);
		scrolledAway(editor.root);
		await editor.select(4);
		assert.equal(editor.showing(), 2);
		assert.equal(editor.root.scrollTop, 462);
	});

	it("follows a caret settled outside hidden symbols", async () => {
		const editor = await mount("**b** rest");
		await editor.select(9);
		scrolledAway(editor.root);
		await editor.select(3);
		assert.equal(readPathSelection(editor.root)?.focus, 5);
		assert.equal(editor.root.scrollTop, 462);
	});

	/** A box whose offsets all draw at one spot, until symbols appear and push them down. */
	const pushedBySymbols = (editor: Awaited<ReturnType<typeof mount>>, before: number, after: number) => {
		const { root } = editor;
		scrolledAway(root);
		(root.ownerDocument as unknown as { createRange: () => unknown }).createRange = () => ({
			setStart() {}, setEnd() {}, collapse() {}, selectNode() {},
			getClientRects: () => {
				const top = (editor.showing() ? after : before) + 40 - root.scrollTop;
				return [{ top, bottom: top + 22, left: 5, right: 5, height: 22 }];
			},
		});
	};
	it("follows a selection's end that showing symbols pushes out of the box", async () => {
		const editor = await mount("**b** rest and more");
		await editor.select(19);
		pushedBySymbols(editor, 50, 150);
		await editor.select(19, 3);
		assert.equal(editor.showing(), 2);
		assert.equal(editor.root.scrollTop, 112);
	});
	it("follows a selection's end to the spot it has, when one offset is two spots around a preview", async () => {
		const editor = await mount("$$a$$b c");
		await editor.select(8);
		const { root } = editor;
		const tail = [...root.querySelectorAll("*"), root].flatMap((element) => [...element.childNodes]).find((node) => node.nodeType === 3 && node.textContent === "b c")!;
		scrolledAway(root);
		let measured: Node | null = null;
		(root.ownerDocument as unknown as { createRange: () => unknown }).createRange = () => ({
			setStart(node: Node) { measured = node; }, setEnd() {}, collapse() {}, selectNode() {},
			// The source ends in the box, and the text past the preview goes far below it.
			getClientRects: () => {
				const top = (measured === tail && editor.showing() ? 200 : 60) + 40 - root.scrollTop;
				return [{ top, bottom: top + 22, left: 5, right: 5, height: 22 }];
			},
		});
		root.ownerDocument.getSelection()!.setBaseAndExtent(tail, 3, tail, 0);
		await editor.fire("selectionchange", {}, editor.doc);
		assert.equal(readPathSelection(root)?.focus, 5);
		assert.ok(editor.showing() > 0);
		assert.equal(root.scrollTop, 162);
	});
	it("leaves the box alone when a selection's end was already out of it, as select-all's is", async () => {
		const editor = await mount("**b** rest and more");
		await editor.select(9);
		pushedBySymbols(editor, 500, 600);
		await editor.select(0, 19);
		assert.equal(editor.showing(), 2);
		assert.equal(editor.root.scrollTop, 40);
	});

	it("deletes in the model, keeping hidden symbols", async () => {
		const editor = await mount("hello **b** ");
		await editor.select(12);
		const event = await editor.fire("beforeinput", { inputType: "deleteContentBackward", isComposing: false, getTargetRanges: () => [] });
		assert.equal(event.defaultPrevented, true);
		assert.equal(editor.value, "hello **b**");
	});

	it("removes a whole emoji without a target range", async () => {
		const editor = await mount("**b** 😀");
		await editor.select(8);
		await editor.fire("beforeinput", { inputType: "deleteContentBackward", isComposing: false, getTargetRanges: () => [] });
		assert.equal(editor.value, "**b** ");
		await editor.select(0);
		const forward = await mount("😀 **b**");
		await forward.select(0);
		await forward.fire("beforeinput", { inputType: "deleteContentForward", isComposing: false, getTargetRanges: () => [] });
		assert.equal(forward.value, " **b**");
	});

	it("leaves the first and last positions to the browser", async () => {
		const editor = await mount("**b**");
		await editor.select(0);
		const event = await editor.fire("beforeinput", { inputType: "deleteContentBackward", isComposing: false, getTargetRanges: () => [] });
		assert.equal(event.defaultPrevented, false);
		assert.equal(editor.value, "**b**");
	});

	it("replaces a selection in the model, hidden symbols included", async () => {
		const editor = await mount("a **b** c");
		await editor.select(0, 9);
		const event = await editor.fire("beforeinput", { inputType: "insertText", isComposing: false, data: "X" });
		assert.equal(event.defaultPrevented, true);
		assert.equal(editor.value, "X");
	});

	it("leaves plain typing to the browser", async () => {
		const editor = await mount("a **b** c");
		await editor.select(9);
		const event = await editor.fire("beforeinput", { inputType: "insertText", isComposing: false, data: "X" });
		assert.equal(event.defaultPrevented, false);
	});

	it("holds still through a mouse press", async () => {
		const editor = await mount("**b** rest");
		await editor.select(9);
		await editor.fire("mousedown", {});
		await editor.select(3);
		assert.equal(editor.showing(), 0);
		await editor.fire("mouseup", { detail: 2 }, editor.doc);
		assert.equal(editor.showing(), 2);
	});

	it("waits after a single click, until the keyboard is used", async () => {
		const editor = await mount("**b** rest");
		await editor.select(9);
		await editor.fire("mousedown", {});
		await editor.select(3);
		await editor.fire("mouseup", { detail: 1 }, editor.doc);
		assert.equal(editor.showing(), 0, "a second click may still be coming");
		await editor.fire("keydown", { key: "x" });
		assert.equal(editor.showing(), 2);
	});

	it("opens an equation when clicked, inside its closing delimiter", async () => {
		const editor = await mount("a $x$ b");
		await editor.select(7);
		const widget = editor.root.querySelector(`[${LIVE_WIDGET_ATTRIBUTE}]`)!;
		await editor.fire("mousedown", {}, widget);
		assert.equal(editor.showing() > 0, true);
		assert.equal(widget.hasAttribute("data-show"), true);
		await editor.fire("beforeinput", { inputType: "insertText", isComposing: false, data: "" });
		assert.equal(editor.value, "a $x$ b");
	});

	it("applies a new draft from outside", async () => {
		const editor = await mount("first");
		assert.equal(editor.root.querySelector(".lh-lf-strong"), null);
		await editor.setLive(null);
		await editor.setLive(MATH);
		assert.equal(readPathInput(editor.root), "first");
	});

	it("formats by default through the learner's settings", async () => {
		const editor = await mount("**b**", null, LivePathInput);
		assert.ok(editor.root.querySelector(".lh-lf-strong"));
	});
});
