/** Auto pairs in a real mounted PathInput. linkedom has no layout, no native editing and
 *  no Highlight API, so this pins the seams between pairs, the box's history, snippets
 *  and vim; the rest was driven with real keys in Chrome and in Electron 44. */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { PathInput } from "../components/path-input.tsx";
import { readPathSelection, restorePathSelection } from "../components/path-input-dom.ts";
import type { PairKinds } from "../src/core/index.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function fixture(initial: string, caret: number, options: { vim?: boolean; snippets?: boolean; pairs?: boolean | PairKinds; singleLine?: boolean } = {}) {
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
	class KeyboardEvent extends win.Event {
		constructor(type: string, init: Record<string, unknown>) { super(type, init); Object.assign(this, init); }
	}
	const globals = { React, window: win, document: doc, HTMLElement: win.HTMLElement, Element: win.Element, Event: win.Event, KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries(globals)) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const reactRoot = createRoot(doc.getElementById("root")!);
	const ref = React.createRef<HTMLDivElement>();
	let value = initial, pairs = "pairs" in options ? options.pairs : true;
	function draw() {
		reactRoot.render(<PathInput ref={ref} vim={options.vim} snippets={options.snippets ?? false} pairs={pairs} singleLine={options.singleLine} value={value} onValueChange={(next) => { value = next; draw(); }} />);
	}
	await act(async () => { draw(); });
	cleanup = async () => {
		await act(async () => { reactRoot.unmount(); });
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const root = ref.current!;
	root.focus();
	function pick(anchor: number, focus: number) {
		restorePathSelection(root, { anchor, focus });
		doc.dispatchEvent(new win.Event("selectionchange"));
	}
	pick(caret, caret);
	async function event(type: string, properties: Record<string, unknown> = {}) {
		const event = new win.Event(type, { bubbles: true, cancelable: true });
		Object.assign(event, properties);
		await act(async () => { root.dispatchEvent(event); });
		return event;
	}
	/** One key as the browser types it: text the box leaves alone it then writes itself. */
	async function type(text: string) {
		for (const data of text) {
			const down = await event("keydown", { key: data });
			if (down.defaultPrevented) continue;
			const allowed = await event("beforeinput", { inputType: "insertText", data, isComposing: false });
			if (allowed.defaultPrevented) continue;
			const at = readPathSelection(root)!.focus, now = value;
			root.replaceChildren(doc.createTextNode(now.slice(0, at) + data + now.slice(at)));
			restorePathSelection(root, { anchor: at + 1, focus: at + 1 });
			await event("input", { inputType: "insertText" });
			await act(async () => { doc.dispatchEvent(new win.Event("selectionchange")); });
		}
	}
	return {
		root, event, type, pick,
		press: (key: string, more: Record<string, unknown> = {}) => event("keydown", { key, ...more }),
		undo: () => event("keydown", { key: "z", ctrlKey: true }),
		redo: () => event("keydown", { key: "y", ctrlKey: true }),
		get value() { return value; },
		get caret() { return readPathSelection(root)?.focus; },
		get selected() { const sel = readPathSelection(root)!; return value.slice(Math.min(sel.anchor, sel.focus), Math.max(sel.anchor, sel.focus)); },
		async external(next: string) { await act(async () => { value = next; draw(); }); },
		async setPairs(on: boolean | PairKinds) { await act(async () => { pairs = on; draw(); }); },
	};
}

describe("the two settings", () => {
	const brackets = { brackets: true, markdown: false }, markdown = { brackets: false, markdown: true };
	it("closes brackets and leaves Markdown alone", async () => {
		const f = await fixture("", 0, { pairs: brackets });
		await f.type("( *");
		assert.equal(f.value, "( *)");
	});
	it("closes Markdown and leaves brackets alone", async () => {
		const f = await fixture("", 0, { pairs: markdown });
		await f.type("( *");
		assert.equal(f.value, "( **");
	});
	it("still wraps a selection with either", async () => {
		for (const pairs of [brackets, markdown]) {
			const f = await fixture("ab", 0, { pairs });
			f.pick(0, 2);
			await f.type("$");
			assert.equal(f.value, "$ab$");
			await cleanup?.();
			cleanup = undefined;
		}
	});
	it("does nothing with both off", async () => {
		const f = await fixture("ab", 0, { pairs: { brackets: false, markdown: false } });
		f.pick(0, 2);
		await f.type("$");
		assert.equal(f.value, "ab$");
	});
	it("applies at the next key", async () => {
		const f = await fixture("", 0, { pairs: brackets });
		await f.type("(");
		assert.equal(f.value, "()");
		await f.setPairs(markdown);
		await f.type("[");
		assert.equal(f.value, "([)");
		await f.setPairs(true);
		await f.type("[");
		assert.equal(f.value, "([[])");
	});
});

describe("a path typed in backticks", () => {
	for (const text of ["open `/tmp/a.txt` now", "the file `~/b.pdf` is here", "`/tmp/a b.txt`"]) {
		it(`stays as typed: ${text}`, async () => {
			const f = await fixture("", 0);
			await f.type(text);
			assert.equal(f.value, text);
			assert.equal(f.caret, text.length);
		});
		it(`stays as typed in vim's insert mode: ${text}`, async () => {
			const f = await fixture("", 0, { vim: true });
			await f.press("i");
			await f.type(text);
			assert.equal(f.value, text);
		});
	}
});

describe("the switch", () => {
	it("is off unless asked for", async () => {
		const f = await fixture("", 0, { pairs: false });
		await f.type("(");
		assert.equal(f.value, "(");
	});
	it("is off in a box that gets no prop", async () => {
		const f = await fixture("", 0, { pairs: undefined });
		await f.type("[");
		assert.equal(f.value, "[");
	});
	it("applies live", async () => {
		const f = await fixture("", 0, { pairs: false });
		await f.setPairs(true);
		await f.type("(");
		assert.equal(f.value, "()");
		await f.setPairs(false);
		await f.type("[");
		assert.equal(f.value, "([)");
	});
	it("leaves a one-line box alone", async () => {
		const f = await fixture("", 0, { singleLine: true });
		await f.type("(");
		assert.equal(f.value, "(");
	});
});

describe("a box's history", () => {
	it("undoes a pair at once, and redoes it", async () => {
		const f = await fixture("", 0);
		await f.type("(");
		await f.undo();
		assert.equal(f.value, "");
		await f.redo();
		assert.equal(f.value, "()");
		assert.equal(f.caret, 1);
	});
	it("keeps a closer live across an undo of what was typed in it", async () => {
		const f = await fixture("", 0);
		await f.type("(x");
		await f.undo();
		assert.equal(f.value, "()");
		await f.type(")");
		assert.equal(f.value, "()");
		assert.equal(f.caret, 2);
	});
	it("undoes a wrap and gives the selection back", async () => {
		const f = await fixture("a word", 0);
		f.pick(2, 6);
		await f.type("(");
		assert.equal(f.value, "a (word)");
		assert.equal(f.selected, "word");
		await f.undo();
		assert.equal(f.value, "a word");
		assert.equal(f.selected, "word");
	});
	it("brings an empty pair back after Backspace", async () => {
		const f = await fixture("", 0);
		await f.type("(");
		await f.press("Backspace");
		assert.equal(f.value, "");
		await f.undo();
		assert.equal(f.value, "()");
	});
});

describe("closers", () => {
	it("types over only its own", async () => {
		const f = await fixture("(x)", 2);
		await f.type(")");
		assert.equal(f.value, "(x))");
	});
	it("follows text added in front of them", async () => {
		const f = await fixture("", 0);
		await f.type("(");
		await f.type("abc");
		assert.equal(f.value, "(abc)");
		await f.type(")");
		assert.equal(f.value, "(abc)");
		assert.equal(f.caret, 5);
	});
	it("forgets them on another line", async () => {
		const f = await fixture("\nb", 0);
		await f.type("(");
		f.pick(4, 4);
		f.pick(1, 1);
		await f.type(")");
		assert.equal(f.value, "())\nb");
	});
	it("keeps them through a draft that only grew", async () => {
		const f = await fixture("", 0);
		await f.type("(");
		await f.external("()!");
		await f.type(")");
		assert.equal(f.value, "()!");
		assert.equal(f.caret, 2);
	});
	it("forgets them when the draft is cleared", async () => {
		const f = await fixture("", 0);
		await f.type("(");
		await f.external("");
		await f.type(")");
		assert.equal(f.value, ")");
	});
});

describe("snippets", () => {
	it("go first in math", async () => {
		const f = await fixture("$$", 1, { snippets: true });
		await f.type("(");
		assert.equal(f.value, "$()$");
		await f.type("x)");
		assert.equal(f.value, "$(x)$");
		assert.equal(f.caret, 4);
	});
	it("leave plain text to pairs", async () => {
		const f = await fixture("", 0, { snippets: true });
		await f.type("(");
		assert.equal(f.value, "()");
	});
	it("take the Backspace of a math pair", async () => {
		const f = await fixture("$$", 1, { snippets: true });
		await f.press("Backspace");
		assert.equal(f.value, "");
	});
	it("keep their tabstops around a pair", async () => {
		const f = await fixture("$$", 1, { snippets: true });
		await f.type("sq(a");
		assert.equal(f.value, "$\\sqrt{ (a) }$");
		await f.press("Tab");
		assert.equal(f.value.slice(0, f.caret), "$\\sqrt{ (a)");
	});
});

describe("a file path", () => {
	const chip = "`/home/u/n.pdf`";
	it("is wrapped whole", async () => {
		const f = await fixture(chip, 0);
		f.pick(0, chip.length);
		await f.type("(");
		assert.equal(f.value, `(${chip})`);
	});
	it("is not typed into", async () => {
		const f = await fixture(`${chip} `, chip.length + 1);
		await f.type("`");
		assert.equal(f.value, `${chip} \`\``);
	});
	it("does not lose half of itself to Backspace between two of them", async () => {
		const f = await fixture(`${chip}${chip}`, chip.length);
		await f.press("Backspace");
		assert.equal(f.value.length % chip.length, 0);
	});
});

describe("under vim", () => {
	const enter = async (f: Awaited<ReturnType<typeof fixture>>, key = "i") => { await f.press(key); };
	it("pairs in insert mode only", async () => {
		const f = await fixture("", 0, { vim: true });
		await f.press("(");
		assert.equal(f.value, "");
		await enter(f);
		await f.type("(");
		assert.equal(f.value, "()");
	});
	it("is one change to u", async () => {
		const f = await fixture("", 0, { vim: true });
		await enter(f);
		await f.type("(x");
		await f.press("Escape");
		assert.equal(f.value, "(x)");
		await f.press("u");
		assert.equal(f.value, "");
	});
	it("replays the pair with .", async () => {
		const f = await fixture("\n", 0, { vim: true });
		await enter(f);
		await f.type("(x");
		await f.press("Escape");
		await f.press("j");
		await f.press(".");
		assert.equal(f.value, "(x)\n(x)");
	});
	it("replays a step over with . as nothing more than the text", async () => {
		const f = await fixture("\n", 0, { vim: true });
		await enter(f);
		await f.type("(x)");
		await f.press("Escape");
		await f.press("j");
		await f.press(".");
		assert.equal(f.value, "(x)\n(x)");
	});
	it("replays through a macro", async () => {
		const f = await fixture("\n", 0, { vim: true });
		await f.press("q");
		await f.press("a");
		await enter(f);
		await f.type("(x");
		await f.press("Escape");
		await f.press("q");
		await f.press("j");
		await f.press("@");
		await f.press("a");
		assert.equal(f.value, "(x)\n(x)");
	});
	it("runs at every cursor of a block insert", async () => {
		const f = await fixture("\n\n", 0, { vim: true });
		await f.press("v", { ctrlKey: true });
		await f.press("j");
		await f.press("I");
		await f.type("(x)y");
		assert.equal(f.value, "(x)y\n(x)y\n");
		await f.press("Escape");
		await f.press("u");
		assert.equal(f.value, "\n\n");
	});
	it("leaves replace mode alone", async () => {
		const f = await fixture("ab", 0, { vim: true });
		await f.press("R");
		await f.press("(");
		assert.equal(f.value, "(b");
	});
});
