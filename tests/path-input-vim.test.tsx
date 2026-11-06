/** Vim in a real mounted PathInput. linkedom has no layout, no native editing and
 *  no Selection.modify, so this pins the seams between the box and the engine;
 *  caret movement, wrapped lines and the block cursor were driven in Chrome and
 *  in Electron 44. */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { INSERT_FILE_PATHS_EVENT, PathInput } from "../components/path-input.tsx";
import { pathInputOffset, readPathSelection, restorePathSelection } from "../components/path-input-dom.ts";
import { enterAction } from "../components/composer.tsx";
import { isVimSave } from "../components/path-input-vim.ts";
import { vimEngine } from "../components/vim-editor.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

type Key = { key: string; ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean; altKey?: boolean; code?: string; keyCode?: number };

async function fixture(initial: string, options: { vim?: boolean; singleLine?: boolean; live?: boolean } = {}) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div><button id='elsewhere'></button></body></html>");
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
	(win.HTMLElement.prototype as unknown as { select(): void }).select = function () {};
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
	let value = initial, vim = options.vim ?? true;
	const seen: string[] = [], saves: boolean[] = [];
	function draw() {
		reactRoot.render(<PathInput ref={ref} vim={vim} singleLine={options.singleLine} liveFormat={options.live ? { math: true } : undefined} value={value} onValueChange={(next) => { value = next; draw(); }} onKeyDown={(event) => { seen.push(event.key); saves.push(isVimSave(event.nativeEvent)); }} />);
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
	function select(anchor: number, focus = anchor) {
		restorePathSelection(root, { anchor, focus });
		doc.dispatchEvent(new win.Event("selectionchange"));
	}
	select(0);
	async function event(type: string, properties: Record<string, unknown> = {}, target: EventTarget = root) {
		const event = new win.Event(type, { bubbles: true, cancelable: true });
		Object.assign(event, properties);
		await act(async () => { target.dispatchEvent(event); });
		return event;
	}
	const press = (key: Key | string) => event("keydown", typeof key === "string" ? { key } : key);
	async function keys(text: string) { for (const key of text) await press(key); }
	return {
		root, doc, select, event, press, keys, seen, saves,
		paste: (text: string) => event("paste", { clipboardData: { getData: () => text } }),
		get value() { return value; },
		get mode() { return root.dataset.vim; },
		get caret() { return readPathSelection(root)?.focus; },
		async external(next: string) { await act(async () => { value = next; draw(); }); },
		async setVim(on: boolean) { await act(async () => { vim = on; draw(); }); },
		/** The browser typing into the box, as it does in insert mode. */
		async native(next: string, inputType = "insertText", caret = next.length) {
			const allowed = await event("beforeinput", { inputType, data: next, isComposing: false });
			if (allowed.defaultPrevented) return false;
			root.replaceChildren(doc.createTextNode(next));
			select(caret);
			await event("input", { inputType });
			return true;
		},
	};
}

describe("off", () => {
	it("is off unless asked for, and keys pass straight through", async () => {
		const f = await fixture("abc", { vim: false });
		assert.equal(f.mode, undefined);
		const key = await f.press("x");
		assert.equal(key.defaultPrevented, false);
		assert.equal(f.value, "abc");
		assert.deepEqual(f.seen, ["x"]);
		assert.equal(await f.native("abcd"), true);
	});
	it("applies live both ways", async () => {
		const f = await fixture("abc", { vim: false });
		await f.setVim(true);
		assert.equal(f.mode, "normal");
		await f.setVim(false);
		assert.equal(f.mode, undefined);
	});
	it("a one-line box stays out of it", async () => {
		const f = await fixture("abc", { singleLine: true });
		assert.equal(f.mode, undefined);
	});
});

describe("modes", () => {
	it("starts in normal, and a key goes no further", async () => {
		const f = await fixture("abc");
		assert.equal(f.mode, "normal");
		const key = await f.press("x");
		assert.equal(key.defaultPrevented, true);
		assert.equal(f.value, "bc");
		assert.deepEqual(f.seen, []);
	});
	it("shows each mode on the box", async () => {
		const f = await fixture("abc");
		await f.press("i");
		assert.equal(f.mode, "insert");
		await f.press("Escape");
		await f.press("v");
		assert.equal(f.mode, "visual");
		await f.press("Escape");
		await f.press("R");
		assert.equal(f.mode, "replace");
		await f.press("Escape");
		assert.equal(f.mode, "normal");
	});
	it("a keystroke it has no use for does not type", async () => {
		const f = await fixture("abc");
		const key = await f.press("Q");
		assert.equal(key.defaultPrevented, true);
		assert.equal(f.value, "abc");
	});
	it("blocks the browser's typing in normal and allows it in insert", async () => {
		const f = await fixture("abc");
		assert.equal(await f.native("abcd"), false);
		assert.equal((await f.event("beforeinput", { inputType: "deleteContentBackward" })).defaultPrevented, true);
		assert.equal((await f.event("beforeinput", { inputType: "deleteWordBackward" })).defaultPrevented, true);
		await f.press("A");
		assert.equal(await f.native("abcd"), true);
		assert.equal(f.value, "abcd");
	});
	it("returns to normal when the draft is cleared, as after sending", async () => {
		const f = await fixture("abc");
		await f.press("A");
		await f.external("");
		assert.equal(f.mode, "normal");
	});
	it("stays in insert when only more text arrives, as with dictation", async () => {
		const f = await fixture("abc");
		await f.press("A");
		await f.external("abc more");
		assert.equal(f.mode, "insert");
	});
});

describe("Enter", () => {
	it("in normal with nothing pending takes the box's own path", async () => {
		const f = await fixture("abc");
		const key = await f.press("Enter");
		assert.equal(key.defaultPrevented, false);
		assert.deepEqual(f.seen, ["Enter"]);
		assert.equal(f.value, "abc");
	});
	it("in insert is a new line and never sends", async () => {
		const f = await fixture("ab");
		await f.press("A");
		await f.press("Enter");
		assert.equal(f.value, "ab\n");
		assert.deepEqual(f.seen, []);
		assert.equal(f.mode, "insert");
	});
	it("stays vim's while a key is pending", async () => {
		const f = await fixture("abc");
		await f.press("r");
		const key = await f.press("Enter");
		assert.equal(key.defaultPrevented, true);
		assert.deepEqual(f.seen, []);
		assert.equal(f.value, "\nbc");
	});
	it("with Shift stays the box's own new line, in either mode", async () => {
		const f = await fixture("ab");
		assert.equal((await f.press({ key: "Enter", shiftKey: true })).defaultPrevented, false);
		await f.event("beforeinput", { inputType: "insertLineBreak" });
		assert.equal(f.value, "\nab");
		await f.press("A");
		assert.equal((await f.press({ key: "Enter", shiftKey: true })).defaultPrevented, false);
		await f.event("beforeinput", { inputType: "insertLineBreak" });
		assert.equal(f.value.split("\n").length, 3);
		assert.deepEqual(f.seen, ["Enter", "Enter"]);
	});
	it("in visual is the engine's", async () => {
		const f = await fixture("abc");
		await f.press("v");
		await f.press("Enter");
		assert.deepEqual(f.seen, []);
	});
	it("Alt+Enter is Enter in every mode, so insert never sends with it", async () => {
		const alt = { key: "Enter", altKey: true };
		const f = await fixture("ab");
		await f.press("A");
		await f.press(alt);
		assert.equal(f.value, "ab\n");
		await f.press("Escape");
		await f.press("v");
		await f.press(alt);
		await f.press("Escape");
		await f.press("R");
		await f.press(alt);
		assert.deepEqual(f.seen, []);
		await f.press("Escape");
		assert.equal((await f.press(alt)).defaultPrevented, false);
		assert.deepEqual(f.seen, ["Enter"]);
	});
	it("Mod+Enter is a chord vim has no use for, so it stays the app's submit", async () => {
		for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
			const f = await fixture("ab");
			await f.press("A");
			assert.equal((await f.press({ key: "Enter", ...mod })).defaultPrevented, false);
			assert.deepEqual(f.seen, ["Enter"]);
			await cleanup?.();
			cleanup = undefined;
		}
	});
	it("with Shift stays a new line in visual, in place of what it selected", async () => {
		const f = await fixture("hi");
		await f.press("v");
		assert.equal((await f.press({ key: "Enter", shiftKey: true })).defaultPrevented, false);
		await f.event("beforeinput", { inputType: "insertLineBreak" });
		assert.equal(f.value, "\ni");
		assert.equal(f.mode, "normal");
	});
	it("with Shift stays a new line while a key is pending, and drops that key", async () => {
		const f = await fixture("hi");
		await f.press("d");
		assert.equal((await f.press({ key: "Enter", shiftKey: true })).defaultPrevented, false);
		await f.event("beforeinput", { inputType: "insertLineBreak" });
		assert.equal(f.value, "\nhi");
		await f.press("x");
		assert.equal(f.value, "\ni");
	});
	it("after Ctrl+O is the one-shot command's", async () => {
		const f = await fixture("a\n  b");
		await f.press("i");
		await f.press({ key: "o", ctrlKey: true });
		const key = await f.press("Enter");
		assert.equal(key.defaultPrevented, true);
		assert.deepEqual(f.seen, []);
		assert.equal(f.value, "a\n  b");
		assert.equal(f.mode, "insert");
		assert.equal(f.caret, 4);
	});
	it("Esc after Ctrl+O is pending like any other, so it stays in the box", async () => {
		const f = await fixture("ab");
		await f.press("i");
		await f.press({ key: "o", ctrlKey: true });
		const key = await f.press("Escape");
		assert.equal(key.defaultPrevented, true);
		assert.deepEqual(f.seen, []);
		assert.equal(f.mode, "normal");
	});
	it("a draft cleared after Ctrl+O still lands in normal", async () => {
		const f = await fixture("ab");
		await f.press("i");
		await f.press({ key: "o", ctrlKey: true });
		await f.external("");
		assert.equal(f.mode, "normal");
	});
});

describe("Esc", () => {
	it("leaves insert, visual and a pending key, and goes no further", async () => {
		const f = await fixture("abc");
		for (const start of ["i", "v", "d"]) {
			await f.press(start);
			const key = await f.press("Escape");
			assert.equal(key.defaultPrevented, true, start);
			assert.equal(f.mode, "normal", start);
		}
		assert.deepEqual(f.seen, []);
		await f.press("x");
		assert.equal(f.value, "bc");
	});
	it("in normal with nothing pending passes through", async () => {
		const f = await fixture("abc");
		const key = await f.press("Escape");
		assert.equal(key.defaultPrevented, false);
		assert.deepEqual(f.seen, ["Escape"]);
	});
});

describe("chords", () => {
	const ctrl = (key: string) => ({ key, ctrlKey: true });
	/** Ctrl+D and Ctrl+U scroll by the line height, which linkedom has none of. */
	const lineHeight = (doc: unknown) => Object.assign((doc as Document).defaultView!, { getComputedStyle: () => ({ lineHeight: "20px" }) });
	it("the engine's take none of the app's route", async () => {
		const f = await fixture("one two");
		for (const key of ["d", "u", "f", "b", "r", "v", "a", "x"]) {
			const event = await f.press(ctrl(key));
			assert.equal(event.defaultPrevented, true, key);
			await f.press("Escape");
		}
		assert.deepEqual(f.seen.filter((key) => key !== "Escape"), []);
	});
	it("Ctrl+W does nothing in normal but is still kept from the window", async () => {
		const f = await fixture("one two");
		const event = await f.press(ctrl("w"));
		assert.equal(event.defaultPrevented, true);
		assert.equal(f.value, "one two");
	});
	it("Ctrl+W deletes a word in insert", async () => {
		const f = await fixture("one two");
		await f.press("A");
		await f.press(ctrl("w"));
		assert.equal(f.value, "one ");
	});
	it("Ctrl+Q keeps its meaning", async () => {
		const f = await fixture("abc");
		const event = await f.press(ctrl("q"));
		assert.equal(event.defaultPrevented, false);
		assert.deepEqual(f.seen, ["q"]);
	});
	it("a chord nothing in vim uses still reaches the app, so rebinding works", async () => {
		const f = await fixture("abc");
		for (const key of [{ key: "p", ctrlKey: true, shiftKey: true }, { key: "F2" }, { key: "k", altKey: true }]) {
			const event = await f.press(key);
			assert.equal(event.defaultPrevented, false, key.key);
		}
		assert.deepEqual(f.seen, ["p", "F2", "k"]);
	});
	it("a chord vim has no use for reaches the app while a key is pending, and drops it", async () => {
		for (const start of ["d", "r", "f", "3", '"a']) {
			const f = await fixture("abc");
			await f.keys(start);
			assert.equal((await f.press(ctrl("m"))).defaultPrevented, false, start);
			assert.deepEqual(f.seen, ["m"], start);
			await f.press("x");
			assert.equal(f.value, "bc", start);
			await cleanup?.();
			cleanup = undefined;
		}
	});
	it("a pending key keeps the chords vim does use", async () => {
		const f = await fixture("abc");
		for (const [start, key] of [["d", "b"], ["d", "n"], ["f", "c"], ["d", "w"], ["f", "r"]] as const) {
			await f.press(start);
			assert.equal((await f.press(ctrl(key))).defaultPrevented, true, start + key);
			await f.press("Escape");
		}
		assert.deepEqual(f.seen.filter((key) => key !== "Escape"), []);
	});
	it("a waiting key drops on a chord vim uses, with no change to the selection, the draft or the clipboard", async () => {
		const draft = "first words\nsecond line";
		// An operator takes Ctrl+D and the like as motions, so those are real commands after one.
		const actions = ["a", "x", "v", "o", "e", "y", "i"], all = [...actions, "d", "f", "u", "b", "n", "p"];
		const cases: [(string | Key)[], string[]][] = [
			[["d"], actions], [["c"], actions], [["y"], actions],
			...[["g"], ["f"], ["r"], ["q"], ['"'], ["v", "l", "r"], ["v", "l", '"'], ["v", "l", "g"], [ctrl("v"), "j", "r"]].map((start) => [start, all] as [(string | Key)[], string[]]),
		];
		for (const [start, chords] of cases) {
			for (const key of chords) {
				const f = await fixture(draft);
				lineHeight(f.doc);
				for (const each of start) await f.press(each);
				const mode = f.mode, selection = readPathSelection(f.root);
				const label = `${start.map((each) => (typeof each === "string" ? each : `C-${each.key}`)).join(" ")} C-${key}`;
				assert.equal((await f.press(ctrl(key))).defaultPrevented, true, label);
				assert.deepEqual(f.seen, [], label);
				assert.equal(f.value, draft, label);
				assert.equal(f.mode, mode, label);
				assert.deepEqual(readPathSelection(f.root), selection, label);
				// Nothing waits any more, so this is an ordinary `x`.
				await f.press("x");
				assert.notEqual(f.value, draft, label);
				await cleanup?.();
				cleanup = undefined;
			}
		}
	});
	it("a chord reaches the app from a waiting key only if it would with nothing waiting", async () => {
		const f = await fixture("first words\nsecond line");
		lineHeight(f.doc);
		const rest = async () => { await f.press("Escape"); await f.press("Escape"); };
		const passes = async (keys: (string | Key)[], letter: string) => {
			for (const key of keys) await f.press(key);
			const passed = !(await f.press(ctrl(letter))).defaultPrevented;
			await rest();
			return passed;
		};
		const visual = "abdefghijklmnopqrstuvwxyz", every = `c${visual}`;
		const states: [string, (string | Key)[], (string | Key)[][]][] = [
			[every, [], [["d"], ["c"], ["r"], ["g"], ["f"], ["q"]]],
			// Ctrl+C with a selection is the browser's copy, unless a key is waiting.
			[visual, ["v"], [["v", "r"], ["v", "g"], ["v", '"']]],
			[every, ["i"], [["i", ctrl("r")]]],
		];
		for (const [letters, still, waiting] of states) for (const letter of letters) {
			const expected = await passes(still, letter);
			for (const keys of waiting) assert.equal(await passes(keys, letter), expected, `${JSON.stringify(keys)} then Ctrl+${letter}`);
		}
	});
	it("Ctrl+R waiting in insert keeps the chords insert uses, and leaves the rest to the app", async () => {
		const f = await fixture("one two");
		lineHeight(f.doc);
		await f.press("A");
		for (const key of ["w", "d", "a", "k"]) {
			await f.press(ctrl("r"));
			assert.equal((await f.press(ctrl(key))).defaultPrevented, true, key);
			assert.equal(f.value, "one two", key);
		}
		await f.press(ctrl("r"));
		assert.equal((await f.press(ctrl("v"))).defaultPrevented, false, "Ctrl+V still pastes");
		assert.deepEqual(f.seen, ["v"]);
	});
	it("Ctrl+C with a key waiting drops the key and copies nothing", async () => {
		const f = await fixture("first words");
		await f.keys("vlr");
		assert.equal((await f.press(ctrl("c"))).defaultPrevented, true);
		assert.equal(f.mode, "visual");
		await f.press("Escape");
		await f.keys("vl");
		assert.equal((await f.press(ctrl("c"))).defaultPrevented, false, "with nothing waiting the browser copies");
	});
	it("asking about a chord logs nothing in a recording and leaves nothing waiting", async () => {
		const f = await fixture("first words");
		await f.keys("qad");
		await f.press(ctrl("a"));
		await f.keys("xq@a");
		assert.equal(f.value, "rst words");
		await f.press("A");
		await f.press(ctrl("r"));
		await f.press(ctrl("w"));
		await f.press("Escape");
		assert.equal(f.mode, "normal");
	});
	it("Ctrl+K moves up in insert and is the app's in normal", async () => {
		const f = await fixture("abc");
		assert.equal((await f.press(ctrl("k"))).defaultPrevented, false);
		await f.press("i");
		assert.equal((await f.press(ctrl("k"))).defaultPrevented, true);
	});
	it("Ctrl+A and Ctrl+E go to a line's text in insert", async () => {
		const f = await fixture("  abc\nnext");
		await f.press("i");
		await f.press(ctrl("e"));
		assert.equal(f.caret, 5);
		await f.press(ctrl("a"));
		assert.equal(f.caret, 2);
	});
	it("Ctrl+A adds and Ctrl+X subtracts in normal", async () => {
		const f = await fixture("x 9");
		await f.press(ctrl("a"));
		assert.equal(f.value, "x 10");
		await f.press(ctrl("x"));
		assert.equal(f.value, "x 9");
	});
	it("space in normal neither types nor scrolls", async () => {
		const f = await fixture("abc");
		const event = await f.press({ key: " ", code: "Space" });
		assert.equal(event.defaultPrevented, true);
		assert.equal(f.value, "abc");
		assert.equal(f.caret, 0);
	});
});

describe("the character under the block cursor", () => {
	type Marked = { startContainer: Node; startOffset: number; endContainer: Node; endOffset: number };
	/** linkedom has neither the Highlight API nor a working Range, so these stand in. */
	class Highlight extends Set<Marked> {}
	afterEach(() => { for (const name of ["CSS", "Highlight"]) delete (globalThis as Record<string, unknown>)[name]; });
	async function start(value: string) {
		const f = await fixture(value), highlights = new Map<string, Highlight>();
		Object.assign(globalThis, { CSS: { highlights }, Highlight });
		(f.doc as unknown as { createRange: () => unknown }).createRange = () => ({
			setStart(node: Node, offset: number) { Object.assign(this, { startContainer: node, startOffset: offset }); },
			setEnd(node: Node, offset: number) { Object.assign(this, { endContainer: node, endOffset: offset }); },
			collapse() {}, selectNode() {}, getClientRects: () => [],
		});
		const marked = () => [...highlights.get("lh-vim-cursor") ?? []].map((range) => ({
			start: pathInputOffset(f.root, range.startContainer, range.startOffset),
			end: pathInputOffset(f.root, range.endContainer, range.endOffset),
		}));
		return { f, marked };
	}
	it("is marked in normal mode and follows the cursor", async () => {
		const { f, marked } = await start("abc\ndef");
		await f.press("l");
		assert.deepEqual(marked(), [{ start: 1, end: 2 }]);
		await f.press("j");
		assert.deepEqual(marked(), [{ start: 5, end: 6 }]);
	});
	it("follows a caret set by a click", async () => {
		const { f, marked } = await start("abc\ndef");
		f.select(2);
		assert.deepEqual(marked(), [{ start: 2, end: 3 }]);
	});
	it("is not marked in insert mode, on a line's end, in a selection or out of focus", async () => {
		const { f, marked } = await start("a\n\nb");
		await f.press("i");
		assert.deepEqual(marked(), []);
		await f.press("Escape");
		await f.press("j");
		assert.equal(f.caret, 2);
		assert.deepEqual(marked(), [], "an empty line has no character");
		await f.press("j");
		assert.equal(marked().length, 1);
		await f.press("v");
		await f.press("h");
		assert.deepEqual(marked(), []);
		await f.press("Escape");
		assert.equal(marked().length, 1);
		await act(async () => { (f.doc.getElementById("elsewhere") as HTMLElement).focus(); f.root.dispatchEvent(new window.Event("blur")); });
		assert.deepEqual(marked(), []);
	});
	it("is redrawn after an edit, whose paint replaces the text it was on", async () => {
		const { f, marked } = await start("abc def");
		await f.press("x");
		assert.equal(f.value, "bc def");
		assert.deepEqual(marked(), [{ start: 0, end: 1 }]);
	});
	it("goes when vim does", async () => {
		const { f, marked } = await start("abc");
		await f.press("l");
		await f.setVim(false);
		assert.deepEqual(marked(), []);
	});
});

describe("undo", () => {
	it("takes a whole insert session at once", async () => {
		const f = await fixture("abc");
		await f.press("A");
		await f.native("abcd");
		await f.native("abcde");
		await f.press("Enter");
		await f.press("Escape");
		await f.press("u");
		assert.equal(f.value, "abc");
		await f.press({ key: "r", ctrlKey: true });
		assert.equal(f.value, "abcde\n");
	});
	it("takes c's delete along with what was typed", async () => {
		const f = await fixture("one two");
		await f.keys("cw");
		assert.equal(f.value, " two");
		await f.native("three two");
		await f.press("Escape");
		await f.press("u");
		assert.equal(f.value, "one two");
	});
	it("Ctrl+Z shares that history", async () => {
		const f = await fixture("abc");
		await f.press("A");
		await f.native("abcd");
		await f.native("abcde");
		await f.press("Escape");
		await f.press({ key: "z", ctrlKey: true });
		assert.equal(f.value, "abc");
	});
	it("x is one step each", async () => {
		const f = await fixture("abc");
		await f.keys("xx");
		await f.press("u");
		assert.equal(f.value, "bc");
		await f.press("u");
		assert.equal(f.value, "abc");
	});
	it("puts the caret back on a deleted letter that repeats", async () => {
		const f = await fixture("hello");
		f.select(2);
		await f.press("x");
		await f.press("u");
		assert.equal(f.value, "hello");
		assert.equal(f.caret, 2);
	});
	it("still goes to where a change began when the caret was elsewhere", async () => {
		const f = await fixture("one two");
		f.select(5);
		await f.keys("diw");
		await f.press("u");
		assert.equal(f.caret, 4);
	});
	it("an undo inside a session leaves the rest of it grouped", async () => {
		const f = await fixture("abc");
		await f.press("A");
		await f.native("abcd");
		await f.press({ key: "z", ctrlKey: true });
		assert.equal(f.value, "abc");
		await f.native("abcx");
		await f.native("abcxy");
		await f.press("Escape");
		await f.press("u");
		assert.equal(f.value, "abc");
	});
});

describe("chips", () => {
	const CHIP = "`/home/u/Notes.pdf`";
	it("x and dw take a chip whole", async () => {
		const f = await fixture(`${CHIP} end`);
		await f.press("x");
		assert.equal(f.value, " end");
		await f.external(`${CHIP} end`);
		await f.keys("gg0dw");
		assert.equal(f.value, " end");
	});
	for (const vim of [true, false]) it(`measures the caret after a chip is drawn, vim ${vim ? "on" : "off"}`, async () => {
		const f = await fixture(`${CHIP}\nend`, { vim });
		const { root } = f;
		root.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 300 }) as DOMRect;
		Object.defineProperties(root, { clientHeight: { value: 100 }, clientWidth: { value: 300 }, clientTop: { value: 0 }, clientLeft: { value: 0 } });
		root.scrollTop = 0;
		// An empty chip host has no height, so the first measure lands too high.
		(root.ownerDocument as unknown as { createRange: () => unknown }).createRange = () => ({
			setStart() {}, setEnd() {}, collapse() {}, selectNode() {},
			getClientRects() {
				const drawn = [...root.querySelectorAll("[contenteditable='false']")].every((host) => host.children.length > 0);
				const top = (drawn ? 300 : 60) - root.scrollTop;
				return [{ top, bottom: top + 20, left: 5, right: 5, height: 20 }];
			},
		});
		if (vim) await f.press("i");
		await f.paste("more");
		assert.equal(root.scrollTop, 220);
	});
	describe("a block that starts on a chip", () => {
		const value = "a `/home/u/n.pdf` b\nccc ddd eee fff g";
		const start = async () => {
			const f = await fixture(value);
			await f.keys("gg0ll");
			await f.press({ key: "v", ctrlKey: true });
			return f;
		};
		it("keeps its own column, and takes the chip", async () => {
			const f = await start();
			await f.keys("jld");
			assert.equal(f.value, "a  b\nccddd eee fff g");
		});
		it("stays a block when it moves along the line", async () => {
			const f = await start();
			await f.keys("l");
			assert.equal(f.mode, "visual");
		});
	});
	it("gU and g~ leave a path as it was", async () => {
		const f = await fixture(`one ${CHIP} two`);
		await f.keys("gUU");
		assert.equal(f.value, `ONE ${CHIP} TWO`);
		await f.keys("g~~");
		assert.equal(f.value, `one ${CHIP} two`);
	});
	it("a yank takes a chip whole, and leaves the cursor", async () => {
		const f = await fixture("ab `/tmp/x.txt` cd");
		await f.keys("wyw");
		assert.equal(f.caret, 3);
		await f.press("P");
		assert.equal(f.value, "ab `/tmp/x.txt``/tmp/x.txt` cd");
	});
	it("a put after x brings the path back, never a piece of it", async () => {
		const start = "ab `/tmp/x.txt` cd";
		for (const [keys, expected] of [["wxp", "ab  `/tmp/x.txt`cd"], ["wxP", start], ["wdwP", start], ["dt/$p", " cdab `/tmp/x.txt`"]]) {
			const f = await fixture(start);
			await f.keys(keys!);
			assert.equal(f.value, expected, keys);
			await cleanup?.();
			cleanup = undefined;
		}
	});
	it("Ctrl+R puts a deleted chip back whole", async () => {
		const f = await fixture("ab `/tmp/x.txt` cd");
		await f.keys("wxi");
		await f.press({ key: "r", ctrlKey: true });
		await f.press('"');
		await f.press("Escape");
		assert.equal(f.value, "ab `/tmp/x.txt` cd");
	});
	it("typing after Ctrl+W lands where the chip was", async () => {
		const f = await fixture("a `/tmp/x.txt` b");
		await f.keys("$i");
		await f.press({ key: "w", ctrlKey: true });
		assert.equal(f.value, "a b");
		assert.equal(f.caret, 2);
	});
	it("a second Ctrl+W deletes before the caret, not after it", async () => {
		const f = await fixture("a `/tmp/x.txt` b");
		await f.keys("$i");
		await f.press({ key: "w", ctrlKey: true });
		await f.press({ key: "w", ctrlKey: true });
		assert.equal(f.value, "b");
	});
	it("a block keeps its cursors when one falls inside a chip", async () => {
		const f = await fixture("abc\n`/tmp/x.txt`\nxyz");
		await f.press("l");
		await f.press({ key: "v", ctrlKey: true });
		await f.keys("jj");
		assert.equal(f.mode, "visual");
		await f.press("d");
		assert.equal(f.value, "ac\n`/tmp/x.txt`\nxz");
	});
	it("a motion steps over a chip as one cell", async () => {
		const f = await fixture(`a ${CHIP} b`);
		await f.keys("ll");
		assert.equal(f.caret, 2);
		await f.press("l");
		assert.equal(f.caret, 2 + CHIP.length);
	});
});

describe("scrolling", () => {
	/** Rows of 20px in a 100px box with 8px of scroll padding, one row per offset, so
	 *  that a line's own boxes can be told from the cursor's. */
	function rows(f: Awaited<ReturnType<typeof fixture>>, hidden: (offset: number) => boolean = () => false) {
		const { root } = f;
		const win = root.ownerDocument.defaultView!;
		root.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 300 }) as DOMRect;
		Object.defineProperties(root, { clientHeight: { value: 100 }, clientWidth: { value: 300 }, clientTop: { value: 0 }, clientLeft: { value: 0 }, scrollHeight: { value: 4000 } });
		let scrolled = 0;
		Object.defineProperty(root, "scrollTop", { get: () => scrolled, set: (value: number) => { scrolled = Math.max(0, value); } });
		Object.assign(win, { getComputedStyle: () => ({ scrollPaddingTop: "8px", scrollPaddingBottom: "8px", lineHeight: "20px" }) });
		let offset = 0;
		(root.ownerDocument as unknown as { createRange: () => unknown }).createRange = () => ({
			setStart(node: Node, at: number) { offset = pathInputOffset(root, node, at) ?? 0; }, setEnd() {}, collapse() {}, selectNode() {},
			getClientRects() {
				if (hidden(offset)) return [];
				const top = offset * 20 - root.scrollTop;
				return [{ top, bottom: top + 20, left: 5, right: 5, height: 20 }];
			},
		});
	}
	const LINES = Array.from({ length: 30 }, (_, line) => `${line}`.padStart(2, "0")).join("\n");

	it("zt and zb leave the box's padding around the line", async () => {
		const f = await fixture(LINES);
		rows(f);
		await f.keys("10jzb");
		const offset = LINES.indexOf("10"), lineEnd = offset + 2;
		assert.equal(f.root.scrollTop, (lineEnd + 1) * 20 + 8 - 100);
		await f.keys("zt");
		assert.equal(f.root.scrollTop, offset * 20 - 8);
	});
	it("zz puts the line in the middle", async () => {
		const f = await fixture(LINES);
		rows(f);
		await f.keys("10jzz");
		assert.equal(f.root.scrollTop, (LINES.indexOf("10") + 1) * 20 - 50);
	});
	it("zb finds the end of a line whose last symbols have no box", async () => {
		const value = "aaaa**\nbb";
		const f = await fixture(value);
		rows(f, (offset) => offset >= 4 && offset <= 6);
		await f.keys("3l");
		f.root.scrollTop = 40;
		await f.keys("zb");
		assert.equal(f.root.scrollTop, 0, "the line's last box is at 60 to 80, not on the next line");
	});
	it("a line too long for the box keeps the cursor on screen", async () => {
		const value = "x".repeat(40);
		const f = await fixture(value);
		rows(f);
		await f.keys("30l");
		for (const command of ["zz", "zt", "zb"]) {
			await f.keys(command);
			const top = f.caret! * 20 - f.root.scrollTop;
			assert.ok(top >= 8 && top + 20 <= 92, `${command} left the cursor at ${top}`);
		}
	});
});

describe("input from outside the keyboard", () => {
	it("a file insert lands in normal, and the engine sees it", async () => {
		const f = await fixture("ab");
		await f.event(INSERT_FILE_PATHS_EVENT, { detail: ["/x.pdf"] });
		assert.match(f.value, /\/x\.pdf/);
		assert.equal(f.mode, "normal");
		await f.press("0");
		await f.press("x");
		assert.doesNotMatch(f.value, /\/x\.pdf/);
	});
	it("a paste over a visual selection ends visual, so the next key is an operator", async () => {
		const f = await fixture("hello world");
		await f.keys("llvll");
		await f.paste("P");
		assert.equal(f.value, "heP world");
		assert.equal(f.mode, "normal");
		await f.keys("dd");
		assert.equal(f.value, "");
	});
	it("a paste over a line selection leaves the draft for u to restore", async () => {
		const f = await fixture("one\ntwo");
		await f.keys("Vj");
		await f.paste("PP");
		assert.equal(f.value, "PP");
		assert.equal(f.mode, "normal");
		await f.press("u");
		assert.equal(f.value, "one\ntwo");
	});
	it("a file insert over a visual selection ends visual", async () => {
		const f = await fixture("ab cd");
		await f.keys("vl");
		await f.event(INSERT_FILE_PATHS_EVENT, { detail: ["/x.pdf"] });
		assert.equal(f.mode, "normal");
		assert.match(f.value, /\/x\.pdf/);
		assert.doesNotMatch(f.value, /ab/);
	});
	it("a block insert repeats a paste on every line", async () => {
		const f = await fixture("ab\ncd");
		await f.press({ key: "v", ctrlKey: true });
		await f.keys("jI");
		await f.paste("PP");
		await f.press("Escape");
		assert.equal(f.value, "PPab\nPPcd");
	});
	it("a block insert repeats Delete on every line", async () => {
		const f = await fixture("ab\ncd");
		await f.press({ key: "v", ctrlKey: true });
		await f.keys("jI");
		await f.press("Delete");
		assert.equal((await f.event("beforeinput", { inputType: "deleteContentForward" })).defaultPrevented, true);
		await f.press("Escape");
		assert.equal(f.value, "b\nd");
	});
	it("paste and drop are not typing", async () => {
		const f = await fixture("ab");
		assert.equal((await f.event("beforeinput", { inputType: "insertFromPaste" })).defaultPrevented, false);
		assert.equal((await f.event("beforeinput", { inputType: "insertFromDrop" })).defaultPrevented, false);
	});
	it("nothing composed in normal lands in the draft", async () => {
		const f = await fixture("ab");
		await f.event("compositionstart");
		f.root.replaceChildren(f.doc.createTextNode("ab日本"));
		await f.event("compositionend");
		await act(async () => { await Promise.resolve(); });
		assert.equal(f.value, "ab");
		assert.equal(f.root.textContent, "ab");
	});
	it("what is composed in insert does", async () => {
		const f = await fixture("ab");
		await f.press("A");
		await f.event("compositionstart");
		f.root.replaceChildren(f.doc.createTextNode("ab日本"));
		f.select(4);
		await f.event("compositionend");
		await act(async () => { await Promise.resolve(); });
		assert.equal(f.value, "ab日本");
	});
});

describe("the system clipboard", () => {
	function clipboard(text: string) {
		const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { readText: async () => text, writeText: async () => {} } } });
		return () => { if (previous) Object.defineProperty(globalThis, "navigator", previous); else delete (globalThis as Record<string, unknown>).navigator; };
	}
	it("Ctrl+R + and * read it, not the engine's old copy", async () => {
		for (const name of ["+", "*"]) {
			const restore = clipboard("CL");
			try {
				const f = await fixture("hello world");
				await f.keys('"+dwi');
				await f.press({ key: "r", ctrlKey: true });
				await f.press(name);
				await act(async () => { await new Promise((resolve) => setTimeout(resolve)); });
				assert.equal(f.value, "CLworld", name);
				await f.press("Escape");
				await cleanup?.();
				cleanup = undefined;
			} finally { restore(); }
		}
	});
	it('"*p reads it, as "+p does', async () => {
		const restore = clipboard("CL");
		try {
			const f = await fixture("ab");
			await f.keys('"*p');
			await act(async () => { await new Promise((resolve) => setTimeout(resolve)); });
			assert.equal(f.value, "aCLb");
		} finally { restore(); }
	});
});

describe("macros", () => {
	const run = async (f: Awaited<ReturnType<typeof fixture>>, keys: string) => {
		for (const key of keys.match(/<Esc>|./g)!) await f.press(key === "<Esc>" ? "Escape" : key);
	};
	it("a recursive macro stops at the failed motion on the last line", async () => {
		const errors: unknown[] = [];
		const logged = console.error;
		console.error = (...args) => { errors.push(args); };
		try {
			const f = await fixture("a\nb\nc");
			await f.keys("gg0qaqqa");
			await f.press("A");
			await f.native("ax\nb\nc", "insertText", 2);
			await f.press("Escape");
			await f.keys("j@aq@a");
			assert.equal(f.value, "ax\nbx\ncx");
			assert.deepEqual(errors, []);
		} finally { console.error = logged; }
	});
	it("@ of the register being recorded plays nothing, and is recorded", async () => {
		for (const keys of ["qa@@q", "qa@aq"]) {
			const f = await fixture("abc");
			await run(f, keys);
			assert.equal(f.value, "abc", keys);
			assert.equal(f.mode, "normal");
			await cleanup?.();
			cleanup = undefined;
		}
	});
	it("a macro that only calls itself stops by itself, with no error", async () => {
		const errors: unknown[] = [];
		const logged = console.error;
		console.error = (...args) => { errors.push(args); };
		try {
			const f = await fixture("abc");
			await run(f, "qa@aq@a");
			assert.equal(f.value, "abc");
			await f.press("x");
			assert.equal(f.value, "bc");
			assert.deepEqual(errors, []);
		} finally { console.error = logged; }
	});
	it("a recursive macro's motion that fails ends it, and 0 at column 0 does not", async () => {
		const f = await fixture("ab\ncd");
		await run(f, "qaq");
		await run(f, "qa0xj@aq@a");
		assert.equal(f.value, "b\nd");
	});
	it("a failed motion in a plain macro skips the rest of it", async () => {
		const f = await fixture("ab");
		await run(f, "$qqhxq");
		assert.equal(f.value, "b");
		await run(f, "@q");
		assert.equal(f.value, "b");
		await f.press("x");
		assert.equal(f.value, "");
	});
});

describe("a register holding text", () => {
	const ctrl = (key: string) => ({ key, ctrlKey: true });
	it("plays a yanked line, and `.` and macros still work", async (t) => {
		const errors = t.mock.method(console, "error", () => {});
		const f = await fixture("xabc\nnext");
		await f.keys("yy@0");
		assert.equal(f.value, "abc\nbc\nnext");
		assert.equal(f.mode, "normal");
		assert.equal(errors.mock.callCount(), 0);
		await f.keys("0x.");
		assert.equal(f.value, "abc\n\nnext");
		await f.keys("k0qaxq@a");
		assert.equal(f.value, "c\n\nnext");
		await f.press("u");
		assert.equal(f.value, "bc\n\nnext");
	});
	it("plays a register with no line break", async () => {
		const f = await fixture("xabc");
		await f.keys("0\"ay$@a");
		assert.equal(f.value, "abcbc");
		assert.equal(f.mode, "normal");
		await f.keys("0x");
		await f.press(".");
		assert.equal(f.value, "cbc");
	});
	it("repeats what the insert typed with `.`", async () => {
		const f = await fixture("ihi\nzz");
		await f.keys("0yyj@0");
		assert.equal(f.value, "ihi\nhi\nzz");
		await f.press(".");
		assert.equal(f.value, "ihi\nhi\nhi\nzz");
	});
	it("takes a count", async () => {
		const f = await fixture("x\nabcd");
		await f.keys("yyj02@0");
		assert.equal(f.value, "x\ncd");
	});
	it("ends an insert at `<Esc>`", async () => {
		const f = await fixture("ia<Esc>x\nzz");
		await f.keys("0y$j0@0");
		// In goes the `a`, and out it comes again with the `x`.
		assert.equal(f.value, "ia<Esc>x\nzz");
		assert.equal(f.mode, "normal");
	});
	it("plays commands that insert nothing", async () => {
		const f = await fixture("dw\none two");
		await f.keys("0y$j0@0");
		assert.equal(f.value, "dw\ntwo");
	});
	it("does nothing with an empty register", async () => {
		const f = await fixture("abc");
		await f.keys("@z");
		assert.equal(f.value, "abc");
		assert.equal(f.mode, "normal");
	});
	it("leaves a recording to the engine, with its inserts in step", async () => {
		const f = await fixture("one");
		await f.keys("qaA");
		await f.native("onex", "insertText", 4);
		await f.press("Escape");
		await f.keys("A");
		await f.native("onexy", "insertText", 5);
		await f.press("Escape");
		await f.keys("q@a");
		assert.equal(f.value, "onexyxy");
	});
	it("plays a search a recording holds", async () => {
		const f = await fixture("a b a b a");
		await f.keys("q");
		await f.keys("a");
		await f.press("*");
		await f.keys("q@a");
		assert.equal(f.caret, 8);
	});
	it("`@@` with no macro yet plays the unnamed register, as the engine does", async () => {
		vimEngine().getVimGlobalState_().macroModeState.latestRegister = undefined;
		const f = await fixture("dG\nsecond line\nthird line");
		await f.keys("yy@@");
		assert.equal(f.value, "");
		await f.press("u");
		assert.equal(f.value, "dG\nsecond line\nthird line");
	});
	it("gets `.` and macros back from a throw in the middle", async (t) => {
		t.mock.method(console, "error", () => {});
		const f = await fixture("abcd");
		// `q` while an insert is out leaves a recording whose log is a step short.
		await f.keys("qai");
		await f.press(ctrl("o"));
		await f.keys("q");
		await f.press("Escape");
		await f.keys("0@a");
		await f.press("Escape");
		await f.keys("0x.");
		assert.equal(f.value.length <= 2, true, f.value);
		const before = f.value;
		await f.keys("qbxq");
		await f.keys("@b");
		assert.equal(f.value.length, before.length - 2 < 0 ? 0 : before.length - 2);
	});
	it("still draws a block after it", async () => {
		const f = await fixture("x\nab\ncd");
		await f.keys("yyj0@0");
		await f.press(ctrl("v"));
		await f.keys("j");
		assert.equal(f.mode, "visual");
	});
});

describe("a block over rendered math", () => {
	const ctrl = (key: string) => ({ key, ctrlKey: true });
	const shown = (f: Awaited<ReturnType<typeof fixture>>) => [...f.root.querySelectorAll(".lh-lf-source[data-show], [data-show] .lh-lf-source, [data-show]")].length;
	const lines = "$a$ one\n$b$ two\n$c$ three";
	it("shows the source of every row while it is out, and goes back", async () => {
		const f = await fixture(lines, { live: true });
		await f.keys("ggl");
		const alone = shown(f);
		await f.press(ctrl("v"));
		await f.keys("jj");
		const block = shown(f);
		assert.ok(block > alone, `${block} > ${alone}`);
		await f.press("Escape");
		assert.equal(shown(f), alone);
	});
	it("shows as much as `v` does over the same rows", async () => {
		const f = await fixture(lines, { live: true });
		await f.keys("gglvjj");
		const line = shown(f);
		await f.press("Escape");
		await f.keys("ggl");
		await f.press(ctrl("v"));
		await f.keys("jj");
		assert.equal(shown(f), line);
	});
	it("stays shown through a block insert", async () => {
		const f = await fixture(lines, { live: true });
		await f.keys("ggl");
		await f.press(ctrl("v"));
		await f.keys("jj");
		const block = shown(f);
		await f.keys("I");
		assert.equal(f.mode, "insert");
		assert.equal(shown(f), block);
	});
});

describe("the prompt", () => {
	async function ask(f: Awaited<ReturnType<typeof fixture>>, line: string) {
		await f.press(":");
		const prompt = f.doc.querySelector(".lh-vim-prompt") as unknown as HTMLElement;
		assert.ok(prompt);
		const input = prompt.querySelector("input") as HTMLInputElement;
		input.value = line;
		await f.event("keydown", { key: "Enter", keyCode: 13 }, input);
		await act(async () => { await Promise.resolve(); });
		return prompt;
	}
	it("`:w` takes Enter's path", async () => {
		const f = await fixture("abc");
		const prompt = await ask(f, "w");
		assert.deepEqual(f.seen, ["Enter"]);
		assert.equal(prompt.isConnected, false);
		assert.equal(f.value, "abc");
	});
	it("`:w` sends, and only a real Enter stops a turn", async () => {
		const f = await fixture("abc");
		await f.press("Enter");
		await ask(f, "w");
		assert.deepEqual(f.saves, [false, true]);
		assert.equal(enterAction({ busy: true, canSend: false }), "stop");
		assert.equal(enterAction({ busy: true, canSend: false, save: true }), "none");
		assert.equal(enterAction({ busy: true, canSend: true, save: true }), "send");
		assert.equal(enterAction({ busy: false, canSend: true, save: true }), "send");
	});
	it("`:s` keeps a chip, in one undo step", async () => {
		const chip = "`/a/pdf.pdf`";
		const f = await fixture(`pdf ${chip} pdf`);
		await ask(f, "s/pdf/x/g");
		assert.equal(f.value, `x ${chip} x`);
		await f.press("u");
		assert.equal(f.value, `pdf ${chip} pdf`);
	});
	it("Esc shuts it and leaves the app out of it", async () => {
		const f = await fixture("abc");
		await f.press(":");
		const prompt = f.doc.querySelector(".lh-vim-prompt") as unknown as HTMLElement;
		const input = prompt.querySelector("input")!;
		const event = await f.event("keydown", { key: "Escape", keyCode: 27 }, input);
		assert.equal(event.defaultPrevented, true);
		assert.equal(f.doc.querySelector(".lh-vim-prompt"), null);
		assert.deepEqual(f.seen, []);
	});
	it("goes when the box does", async () => {
		const f = await fixture("abc");
		await f.press(":");
		assert.ok(f.doc.querySelector(".lh-vim-prompt"));
		await f.setVim(false);
		assert.equal(f.doc.querySelector(".lh-vim-prompt"), null);
	});
});
