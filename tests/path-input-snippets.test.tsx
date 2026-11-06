/** Snippets in a real mounted PathInput. linkedom has no layout, no native editing and
 *  no Highlight API, so this pins the seams between the box, its history and vim; the
 *  rest was driven with real keys in Chrome and in Electron 44. */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { PathInput } from "../components/path-input.tsx";
import { readPathSelection, restorePathSelection } from "../components/path-input-dom.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function fixture(initial: string, caret: number, options: { vim?: boolean; snippets?: boolean; singleLine?: boolean } = {}) {
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
	let value = initial, snippets = options.snippets ?? true;
	function draw() {
		reactRoot.render(<PathInput ref={ref} vim={options.vim} snippets={snippets} singleLine={options.singleLine} value={value} onValueChange={(next) => { value = next; draw(); }} />);
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
	function select(offset: number) {
		restorePathSelection(root, { anchor: offset, focus: offset });
		doc.dispatchEvent(new win.Event("selectionchange"));
	}
	select(caret);
	async function event(type: string, properties: Record<string, unknown> = {}) {
		const event = new win.Event(type, { bubbles: true, cancelable: true });
		Object.assign(event, properties);
		await act(async () => { root.dispatchEvent(event); });
		return event;
	}
	/** One key as the browser types it: text the box leaves alone it then writes itself. */
	async function type(text: string) {
		for (const data of text) {
			await event("keydown", { key: data });
			const allowed = await event("beforeinput", { inputType: "insertText", data, isComposing: false });
			if (allowed.defaultPrevented) continue;
			const at = readPathSelection(root)!.focus, now = value;
			root.replaceChildren(doc.createTextNode(now.slice(0, at) + data + now.slice(at)));
			// In a browser `input` fires at once, and `selectionchange` comes after it.
			restorePathSelection(root, { anchor: at + 1, focus: at + 1 });
			await event("input", { inputType: "insertText" });
			await act(async () => { doc.dispatchEvent(new win.Event("selectionchange")); });
		}
	}
	return {
		root, event, type, select,
		/** A selection, as a drag leaves it. */
		pick(anchor: number, focus: number) {
			restorePathSelection(root, { anchor, focus });
			doc.dispatchEvent(new win.Event("selectionchange"));
		},
		press: (key: string, more: Record<string, unknown> = {}) => event("keydown", { key, ...more }),
		/** One Backspace as the browser does it, or a Delete once at the start. */
		async erase() {
			const at = readPathSelection(root)!.focus, now = value, inputType = at ? "deleteContentBackward" : "deleteContentForward";
			const allowed = await event("beforeinput", { inputType, isComposing: false });
			if (allowed.defaultPrevented) return;
			const landed = Math.max(0, at - 1);
			root.replaceChildren(doc.createTextNode(now.slice(0, landed) + now.slice(at || 1)));
			restorePathSelection(root, { anchor: landed, focus: landed });
			await event("input", { inputType });
			await act(async () => { doc.dispatchEvent(new win.Event("selectionchange")); });
		},
		undo: () => event("keydown", { key: "z", ctrlKey: true }),
		redo: () => event("keydown", { key: "y", ctrlKey: true }),
		get value() { return value; },
		get caret() { return readPathSelection(root)?.focus; },
		get selected() { const sel = readPathSelection(root)!; return value.slice(Math.min(sel.anchor, sel.focus), Math.max(sel.anchor, sel.focus)); },
		async external(next: string) { await act(async () => { value = next; draw(); }); },
		async setSnippets(on: boolean) { await act(async () => { snippets = on; draw(); }); },
	};
}

describe("off", () => {
	it("is off unless asked for", async () => {
		const f = await fixture("$$", 1, { snippets: false });
		await f.type("x2");
		assert.equal(f.value, "$x2$");
	});
	it("applies live", async () => {
		const f = await fixture("$$", 1, { snippets: false });
		await f.setSnippets(true);
		await f.type("x2");
		assert.equal(f.value, "$x_{2}$");
		await f.setSnippets(false);
		await f.type("y2");
		assert.equal(f.value, "$x_{2}y2$");
	});
	it("leaves a one-line box alone", async () => {
		const f = await fixture("$$", 1, { singleLine: true });
		await f.type("x2");
		assert.equal(f.value, "$x2$");
	});
});

describe("typing", () => {
	it("expands instead of the key landing", async () => {
		const f = await fixture("$$", 1);
		await f.type("x");
		const key = await f.event("beforeinput", { inputType: "insertText", data: "2", isComposing: false });
		assert.equal(key.defaultPrevented, true);
		assert.equal(f.value, "$x_{2}$");
		assert.equal(f.caret, 6);
	});
	it("leaves a typed macro to the browser", async () => {
		const f = await fixture("$\\alph$", 6);
		const key = await f.event("beforeinput", { inputType: "insertText", data: "a", isComposing: false });
		assert.equal(key.defaultPrevented, false);
	});
	it("does nothing for text that is not one key", async () => {
		const f = await fixture("$x$", 2);
		const key = await f.event("beforeinput", { inputType: "insertText", data: "22", isComposing: false });
		assert.equal(key.defaultPrevented, false);
	});
	it("does nothing while composing", async () => {
		const f = await fixture("$x$", 2);
		const key = await f.event("beforeinput", { inputType: "insertText", data: "2", isComposing: true });
		assert.equal(key.defaultPrevented, false);
	});
	it("will not take a file path apart", async () => {
		const source = "$`/home/u/n.pdf`$";
		const f = await fixture(source, source.length - 1);
		await f.type("alpha");
		assert.equal(f.value, "$`/home/u/n.pdf`alpha$");
	});
});

describe("undo", () => {
	it("gives back the trigger, then takes out the key", async () => {
		const f = await fixture("$$", 1);
		await f.type("x2");
		await f.undo();
		assert.equal(f.value, "$x2$");
		await f.undo();
		assert.equal(f.value, "$x$");
		await f.redo();
		await f.redo();
		assert.equal(f.value, "$x_{2}$");
	});
	it("ends stops, and redo brings back the ones it had", async () => {
		const f = await fixture("$$", 1);
		await f.type("//");
		await f.undo();
		assert.equal(f.value, "$//$");
		assert.equal((await f.press("Tab")).defaultPrevented, true); // In math.
		assert.equal(f.value, "$//$");
		await f.redo();
		await f.press("Tab");
		assert.equal(f.caret, "$\\frac{}{".length);
	});
});

describe("a box emptied of its stops", () => {
	const clear = async (f: Awaited<ReturnType<typeof fixture>>) => {
		while (f.value) await f.erase();
	};
	it("gives Tab back when empty, and after typing", async () => {
		const f = await fixture("$$", 1);
		await f.type("a/");
		assert.equal(f.value, "$\\frac{a}{}$");
		await clear(f);
		for (let count = 0; count < 4; count++) assert.equal((await f.press("Tab")).defaultPrevented, false);
		assert.equal((await f.press("Tab", { shiftKey: true })).defaultPrevented, false);
		await f.type("plain words");
		for (let count = 0; count < 4; count++) assert.equal((await f.press("Tab")).defaultPrevented, false);
		assert.equal((await f.press("Tab", { shiftKey: true })).defaultPrevented, false);
	});
	it("gives Tab back under vim", async () => {
		const f = await fixture("$$", 1, { vim: true });
		await f.press("i");
		await f.type("a/");
		await f.press("Escape");
		await f.press("d");
		await f.press("d");
		await f.press("i");
		assert.equal(f.value, "");
		for (let count = 0; count < 4; count++) assert.equal((await f.press("Tab")).defaultPrevented, false);
		await f.type("hello there");
		for (let count = 0; count < 3; count++) assert.equal((await f.press("Tab")).defaultPrevented, false);
	});
	it("still walks stops that are alive", async () => {
		const f = await fixture("$$", 1);
		await f.type("a/");
		assert.equal((await f.press("Tab")).defaultPrevented, true);
		assert.equal((await f.press("Tab")).defaultPrevented, true);
	});
});

describe("Tab", () => {
	it("is the app's outside math with no stops", async () => {
		const f = await fixture("words", 5);
		assert.equal((await f.press("Tab")).defaultPrevented, false);
		assert.equal((await f.press("Tab", { shiftKey: true })).defaultPrevented, false);
	});
	it("stays in the box in math", async () => {
		const f = await fixture("$$", 1);
		assert.equal((await f.press("Tab")).defaultPrevented, true);
	});
	it("is the app's in math for Shift with no stops", async () => {
		const f = await fixture("$$", 1);
		assert.equal((await f.press("Tab", { shiftKey: true })).defaultPrevented, false);
	});
	it("walks the stops", async () => {
		const f = await fixture("$$", 1);
		await f.type("lim");
		assert.equal(f.selected, "n");
		await f.press("Tab");
		assert.equal(f.selected, "\\infty");
		await f.press("Tab", { shiftKey: true });
		assert.equal(f.selected, "n");
	});
	it("leaves chords alone", async () => {
		const f = await fixture("$$", 1);
		assert.equal((await f.press("Tab", { ctrlKey: true })).defaultPrevented, false);
	});
});

describe("Backspace", () => {
	it("takes an empty pair", async () => {
		const f = await fixture("a $$", 3);
		assert.equal((await f.press("Backspace")).defaultPrevented, true);
		assert.equal(f.value, "a ");
		await f.undo();
		assert.equal(f.value, "a $$");
	});
	it("leaves everything else to the browser", async () => {
		const f = await fixture("$x$", 2);
		assert.equal((await f.press("Backspace")).defaultPrevented, false);
	});
});

describe("mirrors", () => {
	it("fill every copy in one undo step", async () => {
		const f = await fixture("$$", 1);
		await f.type("outer");
		const text = "$\\ket{z} \\bra{\\psi}$";
		f.root.replaceChildren(f.root.ownerDocument!.createTextNode(text));
		f.select("$\\ket{z".length);
		await f.event("input", { inputType: "insertText" });
		assert.equal(f.value, "$\\ket{z} \\bra{z}$");
		await f.undo();
		assert.equal(f.value, "$\\ket{\\psi} \\bra{\\psi}$");
	});
});

describe("outside edits", () => {
	it("keep stops through an append", async () => {
		const f = await fixture("$$", 1);
		await f.type("//");
		await f.external(`${f.value} more`);
		await f.press("Tab");
		assert.equal(f.caret, "$\\frac{}{".length);
	});
	it("keep stops and the caret through an edit before them", async () => {
		const f = await fixture("$$", 1);
		await f.type("//");
		await f.external(`intro ${f.value}`);
		assert.equal(f.caret, "intro $\\frac{".length);
		await f.press("Tab");
		assert.equal(f.caret, "intro $\\frac{}{".length);
	});
	it("end stops with a cleared draft", async () => {
		const f = await fixture("$$", 1);
		await f.type("//");
		await f.external("");
		assert.equal((await f.press("Tab")).defaultPrevented, false);
	});
});

describe("with vim", () => {
	it("types nothing and fires nothing in normal mode", async () => {
		const f = await fixture("$$", 1, { vim: true });
		await f.press("m");
		await f.press("k");
		assert.equal(f.value, "$$");
	});
	it("leaves Tab alone in normal mode, stops or no stops", async () => {
		const f = await fixture("$$", 1, { vim: true });
		assert.equal((await f.press("Tab")).defaultPrevented, false);
	});
	it("expands in insert, and `.` puts in the text", async () => {
		const f = await fixture("$$", 1, { vim: true });
		await f.press("i");
		await f.type("x2");
		assert.equal(f.value, "$x_{2}$");
		await f.press("Escape");
		await f.press(".");
		assert.equal(f.value, "$x_{2x_{2}}$");
	});
	it("steps Ctrl+Z back through a snippet, then the session", async () => {
		const f = await fixture("$$", 1, { vim: true });
		await f.press("i");
		await f.type("a x2");
		await f.undo();
		assert.equal(f.value, "$a x2$");
		await f.undo();
		assert.equal(f.value, "$a x$");
		await f.undo();
		assert.equal(f.value, "$$");
	});
	it("undoes the whole session with `u`", async () => {
		const f = await fixture("$$", 1, { vim: true });
		await f.press("i");
		await f.type("a x2");
		await f.press("Escape");
		await f.press("u");
		assert.equal(f.value, "$$");
	});
});

/** The value with a bar at the caret. */
const shown = (f: { value: string; caret: number | undefined }) => f.value.slice(0, f.caret) + "|" + f.value.slice(f.caret);
const SEND = Symbol("send");
/** An Enter or Shift+Enter that nothing in the box took goes on to the surface. */
async function enter(f: Awaited<ReturnType<typeof fixture>>, more: Record<string, unknown> = {}) {
	const key = await f.press("Enter", more);
	return key.defaultPrevented ? shown(f) : SEND;
}
const MATRIX = "$$\\begin{matrix}\na\n\\end{matrix}$$";
const inMatrix = MATRIX.indexOf("\na") + 2;
const ROW = "$$\\begin{matrix}\na \\\\\n|\n\\end{matrix}$$";

describe("Enter, vim off", () => {
	const cases: [string, string, string | typeof SEND][] = [
		["plain text", "ab|", SEND],
		["inside a block", "$$\nx|\n$$", "$$\nx\n|\n$$"],
		["inside a block on one line", "$$x|$$", "$$x\n|$$"],
		["inside a block in the middle of a line", "a $$x|$$ b", "a $$x\n|$$ b"],
		["just after a closing $$", "$$x$$|", SEND],
		["just after a closing $$ on its own line", "$$\nx\n$$|", SEND],
		["before an opening $$", "|$$x$$", SEND],
		["in an unclosed block", "$$x|", "$$x\n|"],
		["an unclosed $$ partway along a line, which opens no block", "a $$x|", SEND],
		["an unclosed block that opens after a list marker", "- $$x|", "- $$x\n|"],
		["inline math, which the table leaves as it was", "$x|$", SEND],
		["outside a matrix, in a block", "$$\\begin{matrix}a\\end{matrix}|$$", "$$\\begin{matrix}a\\end{matrix}\n|$$"],
		["outside a block, a matrix is only text", "\\begin{matrix}a|\\end{matrix}", SEND],
	];
	for (const [name, marked, expected] of cases) {
		it(name, async () => {
			const at = marked.indexOf("|");
			const f = await fixture(marked.replace("|", ""), at);
			assert.equal(await enter(f), expected);
		});
	}
	it("adds a row in a matrix", async () => {
		const f = await fixture(MATRIX, inMatrix);
		assert.equal(await enter(f), ROW);
	});
	it("adds a row in a matrix on one line", async () => {
		const f = await fixture("$$\\begin{matrix}a\\end{matrix}$$", "$$\\begin{matrix}a".length);
		assert.equal(await enter(f), "$$\\begin{matrix}a \\\\  |\\end{matrix}$$");
	});
	it("takes Alt+Enter for Enter", async () => {
		const f = await fixture(MATRIX, inMatrix);
		assert.equal(await enter(f, { altKey: true }), ROW);
	});
	it("leaves Ctrl+Enter to the app", async () => {
		const f = await fixture(MATRIX, inMatrix);
		assert.equal(await enter(f, { ctrlKey: true }), SEND);
	});
	it("leaves a matrix with Shift+Enter", async () => {
		const f = await fixture(MATRIX, inMatrix);
		assert.equal(await enter(f, { shiftKey: true }), "$$\\begin{matrix}\na\n\\end{matrix}|$$");
	});
	it("keeps Shift+Enter a new line outside one", async () => {
		const f = await fixture("$$x$$", 3);
		assert.equal(await enter(f, { shiftKey: true }), SEND);
	});
	it("replaces a selection in a block", async () => {
		const f = await fixture("$$xy$$", 3);
		f.pick(2, 4);
		assert.equal(await enter(f), "$$\n|$$");
	});
	it("is one undo step", async () => {
		const f = await fixture(MATRIX, inMatrix);
		await enter(f);
		await f.undo();
		assert.equal(f.value, MATRIX);
	});
	it("stays out of it with snippets off", async () => {
		const f = await fixture(MATRIX, inMatrix, { snippets: false });
		assert.equal(await enter(f), SEND);
	});
});

describe("Enter, vim insert", () => {
	for (const [name, marked, key, expected] of [
		["plain text", "ab|", "A", "ab\n|"],
		["a block", "$$x|$$", "i", "$$x\n|$$"],
		["just after a closing $$", "$$x$$|", "A", "$$x$$\n|"],
		["an unclosed block", "$$x|", "A", "$$x\n|"],
		["an unclosed block that opens partway along a line", "a $$x|", "A", "a $$x\n|"],
		["inline math", "$x|$", "i", "$x\n|$"],
	] as const) {
		it(`is a new line in ${name}`, async () => {
			const at = marked.indexOf("|");
			const f = await fixture(marked.replace("|", ""), at, { vim: true });
			await f.press(key);
			assert.equal(await enter(f), expected);
		});
	}
	it("adds a row in a matrix", async () => {
		const f = await fixture(MATRIX, inMatrix, { vim: true });
		await f.press("a");
		assert.equal(await enter(f), ROW);
	});
	it("leaves a matrix with Shift+Enter", async () => {
		const f = await fixture(MATRIX, inMatrix, { vim: true });
		await f.press("a");
		assert.equal(await enter(f, { shiftKey: true }), "$$\\begin{matrix}\na\n\\end{matrix}|$$");
	});
	it("keeps a row in the session's undo", async () => {
		const f = await fixture(MATRIX, inMatrix, { vim: true });
		await f.press("a");
		await enter(f);
		await f.press("Escape");
		await f.press("u");
		assert.equal(f.value, MATRIX);
	});
});

describe("Enter, vim normal", () => {
	for (const [name, marked] of [
		["plain text", "ab|"], ["a block", "$$x|$$"], ["just after a closing $$", "$$x$$|"], ["an unclosed block", "$$x|"], ["an unclosed block partway along a line", "a $$x|"],
		["a matrix", `${MATRIX.slice(0, inMatrix)}|${MATRIX.slice(inMatrix)}`],
	] as const) {
		it(`sends from ${name}`, async () => {
			const at = marked.indexOf("|");
			const f = await fixture(marked.replace("|", ""), at, { vim: true });
			assert.equal(await enter(f), SEND);
		});
	}
	it("still sends with Shift held out of it", async () => {
		const f = await fixture(MATRIX, inMatrix, { vim: true });
		assert.equal(await enter(f, { shiftKey: true }), SEND);
	});
});

describe("Tab's chain", () => {
	const tab = async (marked: string, options: { vim?: boolean } = {}) => {
		const at = marked.indexOf("|");
		const f = await fixture(marked.replace("|", ""), at, options);
		if (options.vim) await f.press("a");
		const key = await f.press("Tab");
		return { f, taken: key.defaultPrevented, after: shown(f) };
	};
	it("runs a Tab snippet ahead of everything", async () => {
		const { after } = await tab("$$\\begin{matrix}\\sum|\\end{matrix}$$");
		assert.equal(after.includes("\\sum_{"), true);
		assert.equal(after.includes("&"), false);
	});
	it("goes to the next stop ahead of the matrix", async () => {
		const f = await fixture("$$\\begin{matrix} \\end{matrix}$$", "$$\\begin{matrix} ".length);
		await f.type("//");
		await f.press("Tab");
		assert.equal(shown(f), "$$\\begin{matrix} \\frac{}{|}\\end{matrix}$$");
	});
	it("jumps a bracket ahead of a new cell", async () => {
		assert.equal((await tab("$$\\begin{pmatrix}(a|)\\end{pmatrix}$$")).after, "$$\\begin{pmatrix}(a)|\\end{pmatrix}$$");
	});
	it("adds a cell with no bracket to jump", async () => {
		assert.equal((await tab("$$\\begin{pmatrix}a|\\end{pmatrix}$$")).after, "$$\\begin{pmatrix}a & |\\end{pmatrix}$$");
	});
	it("tabs out where nothing else applies", async () => {
		assert.equal((await tab("$$\\frac{a|}{b}$$")).after, "$$\\frac{a}|{b}$$");
	});
	it("out of a macro in a matrix, not into a cell", async () => {
		assert.equal((await tab("$$\\begin{matrix}\\frac{a|}{b}\\end{matrix}$$")).after, "$$\\begin{matrix}\\frac{a}|{b}\\end{matrix}$$");
	});
	it("keeps Tab in math even with nothing to do", async () => {
		const { taken, after } = await tab("$a|b$");
		assert.equal(taken, true);
		assert.equal(after, "$a|b$");
	});
	it("gives Tab back outside math", async () => {
		const { taken } = await tab("ab|");
		assert.equal(taken, false);
	});
	it("gives Tab back after leaving an equation", async () => {
		const f = await fixture("$a$", 2);
		assert.equal((await f.press("Tab")).defaultPrevented, true);
		assert.equal(f.caret, 3);
		assert.equal((await f.press("Tab")).defaultPrevented, false);
	});
	it("gives Tab back once the caret leaves every stop", async () => {
		const f = await fixture("a $$x$$", 5);
		await f.type("/");
		f.select(0);
		assert.equal((await f.press("Tab")).defaultPrevented, false);
	});
	it("leaves a stop's math with Tab, with vim on too", async () => {
		assert.equal((await tab("$a|$", { vim: true })).after, "$a$|");
	});
	it("does nothing to tabstops in normal mode", async () => {
		const f = await fixture("$$a$$", 3, { vim: true });
		await f.press("i");
		await f.type("/");
		await f.press("Escape");
		const before = shown(f);
		assert.equal((await f.press("Tab")).defaultPrevented, false);
		assert.equal(shown(f), before);
	});
	it("keeps stops across Esc", async () => {
		const f = await fixture("$$ $$", 3, { vim: true });
		await f.press("i");
		await f.type("//");
		await f.press("Escape");
		await f.press("a");
		await f.press("Tab");
		assert.equal(shown(f), "$$ \\frac{}{|}$$");
	});
	it("Shift+Tab takes a stop back", async () => {
		const f = await fixture("$$ $$", 3);
		await f.type("//");
		await f.press("Tab");
		await f.press("Tab", { shiftKey: true });
		assert.equal(shown(f), "$$ \\frac{|}{}$$");
	});
	it("Shift+Tab is the app's with no stop", async () => {
		const f = await fixture("$$a$$", 3);
		assert.equal((await f.press("Tab", { shiftKey: true })).defaultPrevented, false);
	});
});

describe("keys that type", () => {
	it("makes a fraction on `/`, and its stops work", async () => {
		const f = await fixture("$$a$$", 3);
		await f.type("/b");
		assert.equal(shown(f), "$$\\frac{a}{b|}$$");
		await f.press("Tab");
		assert.equal(shown(f), "$$\\frac{a}{b}|$$");
	});
	it("undoes a fraction to the typed key, then the text", async () => {
		const f = await fixture("$$a$$", 3);
		await f.type("/");
		await f.undo();
		assert.equal(shown(f), "$$a/|$$");
		await f.undo();
		assert.equal(shown(f), "$$a|$$");
	});
	it("keeps `//` a snippet", async () => {
		const f = await fixture("$$$$", 2);
		await f.type("//");
		assert.equal(shown(f), "$$\\frac{|}{}$$");
	});
	it("turns a selection into a numerator", async () => {
		const f = await fixture("$$a+b$$", 2);
		f.pick(2, 5);
		await f.type("/");
		assert.equal(shown(f), "$$\\frac{a+b}{|}$$");
		await f.undo();
		assert.equal(f.value, "$$a+b$$");
	});
	it("steps over a closing bracket", async () => {
		const f = await fixture("$(a)$", 3);
		await f.type(")");
		assert.equal(shown(f), "$(a)|$");
	});
	it("types one with no closing bracket there", async () => {
		const f = await fixture("$a$", 2);
		await f.type(")");
		assert.equal(shown(f), "$a)|$");
	});
	it("types one that is not the next character", async () => {
		const f = await fixture("$(a)$", 2);
		await f.type("]");
		assert.equal(shown(f), "$(]|a)$");
	});
	it("types one outside math", async () => {
		const f = await fixture("(a)", 2);
		await f.type(")");
		assert.equal(shown(f), "(a)|)");
	});
	it("enlarges brackets round an expansion, in one undo step", async () => {
		const f = await fixture("$$(\\sum)$$", "$$(\\sum".length);
		await f.type("/");
		assert.equal(f.value, "$$\\left( \\frac{\\sum}{} \\right)$$");
		await f.undo();
		await f.undo();
		assert.equal(f.value, "$$(\\sum)$$");
	});
	it("keeps stops through an enlargement, and redo brings them back", async () => {
		const f = await fixture("$$()$$", 3);
		await f.type("//");
		assert.equal(shown(f), "$$\\left( \\frac{|}{} \\right)$$");
		await f.press("Tab");
		assert.equal(shown(f), "$$\\left( \\frac{}{|} \\right)$$");
		await f.press("Tab", { shiftKey: true });
		await f.undo();
		await f.redo();
		await f.press("Tab");
		assert.equal(shown(f), "$$\\left( \\frac{}{|} \\right)$$");
	});
});

describe("visual snippets, in a box", () => {
	it("wraps any selection with vim off", async () => {
		const f = await fixture("$$ab$$", 2);
		f.pick(2, 4);
		await f.type("S");
		assert.equal(f.value, "$$\\sqrt{ ab }$$");
		assert.equal(f.selected, "\\sqrt{ ab }");
	});
	it("chains on the selection it leaves", async () => {
		const f = await fixture("$$ab$$", 2);
		f.pick(2, 4);
		await f.type("S(");
		assert.equal(f.value, "$$(\\sqrt{ ab })$$");
	});
	it("is one undo step, back to the selection", async () => {
		const f = await fixture("$$ab$$", 2);
		f.pick(2, 4);
		await f.type("S");
		await f.undo();
		assert.equal(f.value, "$$ab$$");
		assert.equal(f.selected, "ab");
	});
	it("types over a selection outside math", async () => {
		const f = await fixture("ab", 0);
		f.pick(0, 2);
		const key = await f.event("beforeinput", { inputType: "insertText", data: "S", isComposing: false });
		assert.equal(key.defaultPrevented, false);
	});
	it("does not run in vim's visual mode", async () => {
		const f = await fixture("$$ab$$", 2, { vim: true });
		await f.press("v");
		await f.press("l");
		await f.press("S");
		assert.equal(f.value.includes("sqrt"), false);
	});
});

describe("the vim bridges", () => {
	const ctrlG = { ctrlKey: true, code: "KeyG" };
	const visualAB = async () => {
		const f = await fixture("$$ab$$", 2, { vim: true });
		await f.press("v");
		await f.press("l");
		return f;
	};
	it("carries visual's selection into insert", async () => {
		const f = await visualAB();
		assert.equal(f.selected, "ab");
		const key = await f.press("g", ctrlG);
		assert.equal(key.defaultPrevented, true);
		assert.equal(f.root.dataset.vim, "insert");
		assert.equal(f.selected, "ab");
	});
	it("runs a visual snippet from there", async () => {
		const f = await visualAB();
		await f.press("g", ctrlG);
		await f.type("S");
		assert.equal(f.value, "$$\\sqrt{ ab }$$");
	});
	it("carries it back again", async () => {
		const f = await visualAB();
		await f.press("g", ctrlG);
		await f.press("g", ctrlG);
		assert.equal(f.root.dataset.vim, "visual");
		assert.equal(f.selected, "ab");
		await f.press("d");
		assert.equal(f.value, "$$$$");
	});
	it("takes an insert-mode selection into visual", async () => {
		const f = await fixture("$$ab$$", 2, { vim: true });
		await f.press("i");
		f.pick(2, 4);
		await f.press("g", ctrlG);
		assert.equal(f.root.dataset.vim, "visual");
		assert.equal(f.selected, "ab");
	});
	it("leaves <C-g> to the app with nothing to carry", async () => {
		const f = await fixture("$$ab$$", 2, { vim: true });
		await f.press("i");
		assert.equal((await f.press("g", ctrlG)).defaultPrevented, false);
		assert.equal(f.root.dataset.vim, "insert");
	});
	it("leaves <C-g> alone with snippets off", async () => {
		const f = await fixture("$$ab$$", 2, { vim: true, snippets: false });
		await f.press("v");
		await f.press("l");
		await f.press("g", ctrlG);
		assert.equal(f.root.dataset.vim, "visual");
	});
});

describe("normal o", () => {
	it("adds a row in a matrix", async () => {
		const f = await fixture(MATRIX, inMatrix - 1, { vim: true });
		await f.press("o");
		assert.equal(shown(f), ROW);
		assert.equal(f.root.dataset.vim, "insert");
	});
	it("brings the row's leading cells", async () => {
		const text = "$$\\begin{align}\n&=20\n\\end{align}$$";
		const f = await fixture(text, text.indexOf("=20"), { vim: true });
		await f.press("o");
		assert.equal(shown(f), "$$\\begin{align}\n&=20 \\\\\n&|\n\\end{align}$$");
	});
	it("is a plain line elsewhere", async () => {
		const f = await fixture("$$x$$\ny", 0, { vim: true });
		await f.press("o");
		assert.equal(shown(f), "$$x$$\n|\ny");
	});
	it("is a plain line on a matrix's last line", async () => {
		const f = await fixture(MATRIX, MATRIX.length - 1, { vim: true });
		await f.press("o");
		assert.equal(shown(f), `${MATRIX}\n|`);
	});
	it("is a plain line with snippets off", async () => {
		const f = await fixture(MATRIX, inMatrix - 1, { vim: true, snippets: false });
		await f.press("o");
		assert.equal(shown(f), "$$\\begin{matrix}\na\n|\n\\end{matrix}$$");
	});
	it("repeats with `.`", async () => {
		const f = await fixture(MATRIX, inMatrix - 1, { vim: true });
		await f.press("o");
		await f.type("b");
		await f.press("Escape");
		await f.press(".");
		assert.equal(f.value, "$$\\begin{matrix}\na \\\\\nb \\\\\nb\n\\end{matrix}$$");
	});
	it("is one undo step with what is typed after it", async () => {
		const f = await fixture(MATRIX, inMatrix - 1, { vim: true });
		await f.press("o");
		await f.type("b");
		await f.press("Escape");
		await f.press("u");
		assert.equal(f.value, MATRIX);
	});
});
