/** The adapter the vim engine drives, with a stand-in host. The engine's own
 *  suite runs through this adapter in Chrome; these pin what the app relies on. */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { guardChipEdit, chipSpans } from "../components/vim-chips.ts";
import { Pos, VimEditor, vimEngine, type VimHost, type VimLayout } from "../components/vim-editor.ts";

const layout: VimLayout = {
	coords: () => ({ left: 0, right: 8, top: 0, bottom: 16 }),
	offsetAt: () => 0,
	displayLine: (offset, forward) => (forward ? offset + 1 : offset - 1),
	displayLineEdge: (offset) => offset,
	arrow: (offset) => offset,
	page: (offset, pages) => offset + pages,
	scrollInfo: () => ({ left: 0, top: 0, height: 100, width: 100, clientHeight: 100, clientWidth: 100 }),
	scrollLine() {},
	scrollTo() {},
	scrollIntoView() {},
	lineHeight: () => 16,
};

function open(value: string, overrides: Partial<VimHost> = {}) {
	const calls: string[] = [];
	const host: VimHost = {
		layout,
		guardEdit: (_value, from, to, text) => ({ from, to, text }),
		opaque: () => [],
		undo() { calls.push("undo"); },
		redo() { calls.push("redo"); },
		save() { calls.push("save"); },
		focus() { calls.push("focus"); },
		idle() {},
		overlay() {},
		panel() {},
		promptClosed() {},
		...overrides,
	};
	const editor = new VimEditor(host, value);
	const cm = editor as unknown as Parameters<ReturnType<typeof vimEngine>["handleEx"]>[0];
	const engineCm = editor as unknown as Parameters<ReturnType<typeof vimEngine>["multiSelectHandleKey"]>[0];
	const keys = (...list: string[]) => { for (const key of list) editor.during(() => vimEngine().multiSelectHandleKey(engineCm, key, "user")); };
	return { editor, keys, calls, cm };
}

const withChips = { guardEdit: guardChipEdit, opaque: chipSpans };

describe("positions and offsets", () => {
	it("maps both ways across lines", () => {
		const { editor } = open("ab\n\ncd");
		for (let offset = 0; offset <= 6; offset++) assert.equal(editor.indexFromPos(editor.posFromIndex(offset)), offset);
		assert.equal(editor.posFromIndex(4).line, 2);
		assert.equal(editor.posFromIndex(4).ch, 0);
		assert.equal(editor.lineCount(), 3);
		assert.equal(editor.getLine(1), "");
		assert.equal(editor.getRange(new Pos(0, 1), new Pos(2, 1)), "b\n\nc");
	});
	it("clips what is out of range", () => {
		const { editor } = open("ab\ncd");
		const past = editor.clipPos({ line: 9, ch: 9 }), before = editor.clipPos({ line: -1, ch: 5 });
		assert.deepEqual([past.line, past.ch], [1, 2]);
		assert.deepEqual([before.line, before.ch], [0, 0]);
		assert.equal(editor.indexFromPos({ line: 0, ch: 99 }), 2);
	});
});

describe("edits", () => {
	it("runs each through the host's guard", () => {
		const seen: unknown[] = [];
		const { editor, keys } = open("abc", { guardEdit: (_value, from, to, text) => { seen.push([from, to, text]); return { from, to, text }; } });
		keys("x");
		assert.equal(editor.doc, "bc");
		assert.deepEqual(seen, [[0, 1, ""]]);
	});
	it("a refused edit leaves the text as it was", () => {
		const { editor, keys } = open("abc", { guardEdit: () => null });
		keys("x");
		assert.equal(editor.doc, "abc");
	});
	it("puts several cursors after their own text", () => {
		const { editor } = open("a\nb");
		editor.setRanges([{ anchor: 0, head: 0 }, { anchor: 2, head: 2 }], 0);
		editor.typed("zz");
		assert.equal(editor.doc, "zza\nzzb");
		assert.deepEqual(editor.ranges, [{ anchor: 2, head: 2 }, { anchor: 6, head: 6 }]);
	});
	it("deletes back at each cursor", () => {
		const { editor } = open("ab\ncd");
		editor.setRanges([{ anchor: 1, head: 1 }, { anchor: 4, head: 4 }], 0);
		editor.deleteBy(-1);
		assert.equal(editor.doc, "b\nd");
	});
	it("deletes forward at each cursor", () => {
		const { editor } = open("ab\ncd");
		editor.setRanges([{ anchor: 0, head: 0 }, { anchor: 3, head: 3 }], 0);
		editor.deleteBy(1);
		assert.equal(editor.doc, "b\nd");
	});
	it("typing over a chip continues after it", () => {
		const value = "`/a.pdf` b";
		const { editor } = open(value, withChips);
		editor.overWriteSelection("z");
		assert.equal(editor.doc, "`/a.pdf`zb");
	});
	it("indents and outdents by one unit per line", () => {
		const { editor, keys } = open("a\nb");
		keys(">", ">");
		assert.equal(editor.doc, "  a\nb");
		keys("<", "<");
		assert.equal(editor.doc, "a\nb");
	});
	it("leaves an empty line unindented", () => {
		const { editor, keys } = open("a\n\nb");
		keys(">", "2", "j");
		assert.equal(editor.doc, "  a\n\n  b");
	});
	it("hard wraps with gq", () => {
		const { editor, keys } = open("aaaa bbbb cccc");
		editor.setOption("textwidth", 9);
		keys("g", "q", "q");
		assert.equal(editor.doc, "aaaa bbbb\ncccc");
	});
});

describe("chips and the engine's operators", () => {
	const CHIP = "`/tmp/x.txt`";
	const unnamed = () => vimEngine().getRegisterController().unnamedRegister.toString();
	it("deletes a chip whole, and registers the whole of it", () => {
		for (const start of [["w", "x"], ["w", "d", "w"], ["w", "d", "i", "`"]]) {
			const { editor, keys } = open(`ab ${CHIP} cd`, withChips);
			keys(...start);
			assert.equal(editor.doc, "ab  cd", start.join(""));
			assert.equal(unnamed(), CHIP, start.join(""));
			assert.equal(editor.range.head, 3, start.join(""));
		}
	});
	it("takes the whole chip into a delete that ends inside it", () => {
		const { editor, keys } = open(`ab ${CHIP} cd`, withChips);
		keys("d", "t", "/");
		assert.equal(editor.doc, " cd");
		assert.equal(unnamed(), `ab ${CHIP}`);
		assert.equal(editor.range.head, 0);
	});
	it("a put brings the whole chip back", () => {
		const { editor, keys } = open(`ab ${CHIP} cd`, withChips);
		keys("w", "x", "P");
		assert.equal(editor.doc, `ab ${CHIP} cd`);
	});
	it("a change starts where the chip was", () => {
		const { editor, keys } = open(`ab ${CHIP} cd`, withChips);
		keys("w", "c", "i", "`");
		assert.equal(editor.doc, "ab  cd");
		assert.equal(editor.range.head, 3);
		keys("<Esc>");
	});
	it("Ctrl+W leaves the cursor where the chip was", () => {
		const { editor, keys } = open(`a ${CHIP} b`, withChips);
		keys("$", "i", "<C-w>");
		assert.equal(editor.doc, "a b");
		assert.equal(editor.range.head, 2);
		keys("<Esc>");
	});
	it("a range that misses every chip stays as it was", () => {
		const { editor, keys } = open(`ab ${CHIP} cd`, withChips);
		keys("d", "w");
		assert.equal(editor.doc, `${CHIP} cd`);
		assert.equal(unnamed(), "ab ");
	});
});

describe("a block across a chip", () => {
	const value = "abc\n`/tmp/x.txt`\nxyz";
	function block(start = "l") {
		const opened = open(value, withChips);
		opened.keys(start, "<C-v>", "j", "j");
		return opened;
	}
	it("d works on the plain lines and leaves the chip", () => {
		const { editor, keys } = block();
		keys("d");
		assert.equal(editor.doc, "ac\n`/tmp/x.txt`\nxz");
	});
	it("r works on the plain lines and leaves the chip", () => {
		const { editor, keys } = block();
		keys("r", "Z");
		assert.equal(editor.doc, "aZc\n`/tmp/x.txt`\nxZz");
	});
	it("I types on the plain lines and leaves the chip", () => {
		const { editor, keys } = block();
		keys("I");
		editor.typed("Z");
		assert.equal(editor.doc, "aZbc\n`/tmp/x.txt`\nxZyz");
		keys("<Esc>");
	});
	it("Backspace at a cursor inside a chip leaves the chip", () => {
		const { editor, keys } = block();
		keys("I");
		editor.deleteBy(-1);
		assert.equal(editor.doc, "bc\n`/tmp/x.txt`\nyz");
		keys("<Esc>");
	});
	it("column 0 reaches a chip that starts there, so d takes it whole", () => {
		const { editor, keys } = open(value, withChips);
		keys("<C-v>", "j", "j", "d");
		assert.equal(editor.doc, "bc\n\nyz");
	});
	it("leaves . working for the next edit", () => {
		const { editor, keys } = block();
		keys("I");
		editor.typed("Z");
		keys("<Esc>", "G", "A");
		editor.noteEdit("aZbc\n`/tmp/x.txt`\nxZyz!", { anchor: editor.doc.length + 1, head: editor.doc.length + 1 });
		keys("<Esc>", "g", "g", ".");
		assert.equal(editor.doc, "aZbc!\n`/tmp/x.txt`\nxZyz!");
	});
	it("does not draw what it cannot reach", () => {
		const { editor, keys } = block();
		assert.equal(editor.ranges.length, 3);
		assert.equal(editor.reachableRanges().length, 2);
		keys("<Esc>");
	});
});

describe("text from outside", () => {
	it("keeps a mark on its character", () => {
		const { editor, keys } = open("abc def");
		keys("w", "m", "a", "0");
		editor.load("xx abc def");
		keys("`", "a");
		assert.equal(editor.range.head, 7);
	});
	it("drops the selection given and follows the change otherwise", () => {
		const { editor } = open("abc");
		editor.load("zabc");
		assert.equal(editor.range.head, 0);
		editor.setRanges([{ anchor: 2, head: 2 }], 0);
		editor.load("zzabc");
		assert.equal(editor.range.head, 3);
		editor.load("zzabc", { anchor: 1, head: 1 });
		assert.equal(editor.range.head, 1);
	});
	it("records typed text for dot", () => {
		const { editor, keys } = open("a\nb");
		keys("A");
		editor.noteEdit("a!\nb", { anchor: 2, head: 2 });
		keys("<Esc>", "j", ".");
		assert.equal(editor.doc, "a!\nb!");
	});
});

describe("search", () => {
	it("finds every match", () => {
		const { editor } = open("one two one");
		assert.deepEqual(editor.findMatches(/one/, 10), [{ start: 0, end: 3 }, { start: 8, end: 11 }]);
	});
	it("stops at the limit and skips empty matches", () => {
		const { editor } = open("aaaa");
		assert.equal(editor.findMatches(/a/, 2).length, 2);
		assert.deepEqual(editor.findMatches(/x*/, 10), []);
	});
	it("takes a brace the engine's dialect leaves bare", () => {
		const { editor } = open("a{b}");
		assert.deepEqual(editor.findMatches(/a{b}/, 10), [{ start: 0, end: 4 }]);
	});
	it("never matches text touching what the host keeps opaque", () => {
		const { editor } = open("pdf `/a.pdf` pdf", withChips);
		assert.deepEqual(editor.findMatches(/pdf/, 10), [{ start: 0, end: 3 }, { start: 13, end: 16 }]);
	});
	it("steps forward and back", () => {
		const { editor } = open("a b a b a");
		const cursor = editor.getSearchCursor(/a/, new Pos(0, 1));
		cursor.findNext();
		assert.equal(cursor.from()!.ch, 4);
		cursor.findNext();
		assert.equal(cursor.from()!.ch, 8);
		assert.ok(!cursor.findNext());
		const back = editor.getSearchCursor(/a/, new Pos(0, 5));
		back.findPrevious();
		assert.equal(back.from()!.ch, 4);
		back.findPrevious();
		assert.equal(back.from()!.ch, 0);
	});
	it("`:s` skips a chip, however many edits come first", async () => {
		const { document } = parseHTML("<html><body></body></html>");
		Object.assign(globalThis, { document });
		const { editor, cm } = open("pdf `/a.pdf` pdf pdf", withChips);
		vimEngine().handleEx(cm, "s/pdf/x/g");
		assert.equal(editor.doc, "x `/a.pdf` x x");
	});
	it("`*` puts the word up as an overlay", async () => {
		const overlays: unknown[] = [];
		const { editor, keys } = open("word and word", { overlay: (query) => { overlays.push(query); } });
		keys("*");
		assert.equal(editor.range.head, 9);
		// The engine draws its highlights just after the key.
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.ok(editor.searchOverlay);
		assert.equal(overlays.length, 1);
	});
});

describe("geometry comes from the host", () => {
	it("gj and gk ask the layout, j and k count source lines", () => {
		const asked: boolean[] = [];
		const { editor, keys } = open("ab\n\ncd", { layout: { ...layout, displayLine(offset, forward) { asked.push(forward); return forward ? offset + 1 : offset - 1; } } });
		keys("g", "j");
		assert.deepEqual(asked, [true]);
		assert.equal(editor.range.head, 1);
		keys("0", "j", "j");
		assert.equal(editor.range.head, 4);
		assert.deepEqual(asked, [true]);
	});
	it("gj stops at the text's edge", () => {
		const { editor, keys } = open("ab", { layout: { ...layout, displayLine: () => null } });
		keys("g", "j");
		assert.equal(editor.range.head, 0);
	});
	it("Ctrl+F goes a page through the layout", () => {
		const { editor, keys } = open("0\n1\n2\n3\n4\n5", { layout: { ...layout, page: (_offset, pages) => (pages > 0 ? 4 : 0) } });
		keys("<C-f>");
		assert.equal(editor.posFromIndex(editor.range.head).line, 2);
	});
});

describe("host commands", () => {
	it("u and Ctrl+R go to the host's history", () => {
		const { keys, calls } = open("abc");
		keys("u", "<C-r>");
		assert.deepEqual(calls, ["undo", "redo"]);
	});
	it("`:w` goes to the host", () => {
		const { cm, calls } = open("abc");
		vimEngine().handleEx(cm, "w");
		assert.deepEqual(calls, ["save"]);
	});
});

describe("prompts and messages", () => {
	let restore: (() => void) | undefined;
	afterEach(() => { restore?.(); restore = undefined; });
	function page() {
		const { window: win, document } = parseHTML("<html><body></body></html>");
		const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
		Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: document });
		restore = () => { if (previous) Object.defineProperty(globalThis, "document", previous); else delete (globalThis as Record<string, unknown>).document; };
		win.HTMLElement.prototype.focus = function () {};
		(win.HTMLElement.prototype as unknown as { select(): void }).select = function () {};
		return document;
	}
	it("a macro's recording prompt shows nothing", () => {
		page();
		const shown: unknown[] = [];
		const { editor, keys } = open("abc", { panel: (element) => { shown.push(element); } });
		keys("q", "a");
		assert.deepEqual(shown, []);
		assert.equal(editor.dialogOpen, false);
		keys("q");
	});
	it("opens one prompt, and closing it tells the host", () => {
		const document = page();
		const shown: unknown[] = [], closed: boolean[] = [];
		const { editor, keys } = open("abc", { panel: (element) => { shown.push(element); }, promptClosed: (refocus) => { closed.push(refocus); } });
		keys(":");
		assert.equal(editor.dialogOpen, true);
		assert.ok(shown[0]);
		editor.closePrompt!();
		assert.equal(editor.dialogOpen, false);
		assert.equal(shown.at(-1), null);
		assert.deepEqual(closed, [false]);
		void document;
	});
	it("a yank or a substitute confirms with no text", () => {
		page();
		const shown: unknown[] = [];
		const { keys, cm, editor } = open("a b\na\nc", { panel: (element) => { shown.push(element); } });
		keys("y", "y");
		keys("3", "y", "y");
		keys("y", "i", "w");
		vimEngine().handleEx(cm, "%s/a/b/g");
		assert.equal(editor.doc, "b b\nb\nc");
		assert.deepEqual(shown, []);
	});
	it("an error still shows", () => {
		page();
		const shown: HTMLElement[] = [];
		const { cm, editor } = open("abc", { panel: (element) => { if (element) shown.push(element); } });
		vimEngine().handleEx(cm, "notacommand");
		assert.match(shown[0]!.textContent!, /Not an editor command/);
		editor.closeNotification();
	});
	it("a message clears with closeNotification", () => {
		const document = page();
		const shown: unknown[] = [];
		const { editor } = open("abc", { panel: (element) => { shown.push(element); } });
		editor.openNotification(document.createTextNode("hello") as unknown as Node, { duration: 0 });
		assert.ok(shown[0]);
		assert.equal(editor.dialogOpen, false);
		editor.closeNotification();
		assert.equal(shown.at(-1), null);
	});
});
