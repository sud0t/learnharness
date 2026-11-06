import { IS_MAC } from "@/src/core";
import { clipCaret, chipSpans, guardChipEdit, settleCaret, type Span } from "./vim-chips";
import { caretRect, keepCaretInView, markPathSpot, pathInputOffset, pathInputRanges, restorePathSelection, scrollInsets, sharedHighlight, type Highlights, type PathEditSnapshot, type PathInputHistory, type TextSelection } from "./path-input-dom";
import { vimEngine, VimEditor, type Vim, type VimArrow, type VimBox as Box, type VimHost, type VimLayout } from "./vim-editor";

/** What a box gives vim. Text only ever changes through `commit`, the same path
 *  every other edit takes, so history, drawing and the caller all stay as they are. */
export type VimInput = {
	root: HTMLElement;
	history: PathInputHistory;
	snapshot(): PathEditSnapshot;
	commit(next: PathEditSnapshot, record: boolean, edits?: readonly TextEdit[]): void;
	select(selection: TextSelection): void;
	/** What vim wants shown changed with no move of the caret. */
	reveal(): void;
	/** Undo or redo is about to land on this text. */
	travelled(direction: "undo" | "redo", value: string): void;
	/** Insert mode ended, and Esc's step left lands here. */
	leftInsert(offset: number): void;
	/** A move only this editor knows, such as around a block equation. Null if none. */
	arrowTarget(offset: number, key: VimArrow): number | null;
	/** Whether `<C-g>` can carry a selection between visual and insert mode. */
	bridges(): boolean;
	/** What `o` adds at this offset to start a matrix row. Null for a plain `o`. */
	matrixRow(value: string, offset: number): string | null;
};

export type TextEdit = { from: number; to: number; length: number };

export type VimBox = {
	/** True when vim took the key, which then goes no further. */
	keyDown(event: KeyboardEvent): boolean;
	blocksInput(event: InputEvent): boolean;
	/** True when several cursors took the edit. */
	multiInput(event: InputEvent): boolean;
	multiPaste(text: string): boolean;
	/** True in every mode but insert and replace. */
	blocksTyping(): boolean;
	/** The model changed by an edit of its own. */
	noted(record: boolean): void;
	/** The model changed from outside. A reset is a new draft, so it starts over. */
	external(reset: boolean): void;
	painted(): void;
	/** A caret or selection has finished moving. */
	settled(): void;
	/** Undo closed the session's group, and the session is still going. */
	resumeGroup(): void;
	/** Insert mode with nothing waiting, where keys mean what they mean to a snippet. */
	plainInsert(): boolean;
	/** The cursors of a block insert, top to bottom. Null with one. */
	cursors(): TextSelection[] | null;
	/** The rows a visual block or block insert covers, which show their source. Null with one cursor. */
	block(): TextSelection | null;
	/** Whether several cursors are out, mid-commit, when the engine must not be synced. */
	several(): boolean;
	/** Text in this session changed by more than the keys that were typed. */
	expanded(): void;
	/** A snippet moved the caret, which is no move of the learner's. */
	jumped(selection: TextSelection): void;
	/** Edits at several cursors. Unless `recorded` says otherwise, the caller already
	 *  took their history step and kept any stops in place. */
	multiExpand(edits: readonly (TextEdit & { text: string })[], cursors: readonly TextSelection[] | null, recorded?: boolean): void;
	/** Put block insert's cursors on these. */
	moveCursors(cursors: readonly TextSelection[]): void;
	destroy(): void;
};

const HIGHLIGHT_LIMIT = 1000;
/** Well past a draft's lines, and well short of the stack's limit. */
const MACRO_DEPTH = 500;
/** The motions that can fail, which ends a macro as it does in vim. One that goes
 *  somewhere fixed, such as `0`, is already there and carries on. */
const FAILING_MOTIONS = new Set(["moveByLines", "moveByDisplayLines", "moveByCharacters", "moveByWords", "moveToCharacter", "moveTillCharacter", "repeatLastCharacterSearch", "findNext"]);
const LINE_MOTIONS = new Set(["moveByLines", "moveByDisplayLines"]);
const SEARCH = "lh-vim-search", SELECTION = "lh-vim-selection", CARET = "lh-vim-caret", END_CARET = "lh-vim-end-caret", CURSOR = "lh-vim-cursor";
/** Keys the box keeps from the engine, because they already mean something here. */
const APP_KEYS = new Set(["<C-q>"]);
/** Chords that stop here in every mode, including those the engine does not bind them in. */
const ENGINE_CHORDS = new Set(["<C-c>", "<C-[>", "<C-Esc>", "<C-w>", "<C-r>"]);
/** Editing a box in normal mode goes through keys. These reach the box without them. */
const TYPING_INPUT = /^(insertText|insertTab|insertTranspose|deleteContent|deleteWord|deleteSoftLine|deleteHardLine|deleteEntireSoftLine)/;

/** `<C-g>` while it carries a selection. Any other `<C-g>` stays the app's. */
const BRIDGE = "<BoxBridge>";

/** The engine's own actions, which are how an action of the box gets into insert mode. */
type EngineActions = Record<"enterInsertMode" | "newLineAndEnterInsertMode" | "replayMacro", (cm: Parameters<Vim["handleKey"]>[0], args: Parameters<Parameters<Vim["defineAction"]>[1]>[1], state: Parameters<Parameters<Vim["defineAction"]>[1]>[2]) => void>;

/** The six extra insert-mode moves, kept out of the adapter so the engine's own
 *  tests see the stock engine. */
const INSERT_MOVES: Record<string, (editor: VimEditor, head: number) => number> = {
	"<C-h>": (editor, head) => editor.host.layout.arrow(head, "ArrowLeft"),
	"<C-j>": (editor, head) => editor.host.layout.arrow(head, "ArrowDown"),
	"<C-k>": (editor, head) => editor.host.layout.arrow(head, "ArrowUp"),
	"<C-l>": (editor, head) => editor.host.layout.arrow(head, "ArrowRight"),
	"<C-a>": (editor, head) => {
		const line = editor.posFromIndex(head).line;
		return editor.indexFromPos({ line, ch: /^\s*/.exec(editor.getLine(line))![0].length });
	},
	"<C-e>": (editor, head) => {
		const line = editor.posFromIndex(head).line;
		return editor.indexFromPos({ line, ch: editor.getLine(line).length });
	},
};

/** The engine plays a macro one key at a time with no way to stop, and logs a
 *  recording as it goes, so `@a` inside `qa` replays itself. Vim stops a macro at
 *  a failed motion, and plays what a register held before its recording began. */
function boundMacros(engine: Vim) {
	const run = engine.handleKey;
	let depth = 0, stopped = false;
	engine.handleKey = (cm, key, origin) => {
		if (!depth) stopped = false;
		else if (stopped) return true;
		const editor = cm as unknown as VimEditor, state = engine.maybeInitVimState_(cm), input = state.inputState;
		if (/^\d*@$/.test(input.keyBuffer.join(""))) {
			const macro = engine.getVimGlobalState_().macroModeState;
			const name = key === "@" ? macro.latestRegister : key;
			const recording = macro.isRecording && name?.toLowerCase() === macro.latestRegister?.toLowerCase();
			if (recording || depth >= MACRO_DEPTH) {
				if (recording && !macro.isPlaying) engine.getRegisterController().getRegister(name).pushText(key);
				stopped = !recording;
				// A key no register has, which drops the waiting `@`.
				return run.call(engine, cm, "<Nop>", "mapping");
			}
			depth++;
			try { return run.call(engine, cm, key, origin); } finally { depth--; }
		}
		const at = () => (state.visualMode ? editor.indexFromPos(state.sel.head) : editor.range.head);
		const from = at();
		const handled = run.call(engine, cm, key, origin);
		const { motion, operator } = input;
		if (depth && motion && !operator && FAILING_MOTIONS.has(motion)) {
			const moved = LINE_MOTIONS.has(motion) ? editor.posFromIndex(from).line !== editor.posFromIndex(at()).line : from !== at();
			stopped = !moved;
		}
		return handled;
	};
}

/** One entry of a register as `q` logs it. A yank is one entry of the whole text. */
const ONE_KEY = /^(?:<[^>]+>|[^])$/u;
const KEY_IN_TEXT = /<(?:[CSMA]-)*\w+>|[^]/giu;

/** `q` keeps what each insert typed beside its keys, in step, and the engine plays
 *  them that way. A register that only holds text has no such log. */
function isRecording({ keyBuffer, insertModeChanges, searchQueries }: ReturnType<ReturnType<Vim["getRegisterController"]>["getRegister"]>) {
	return (insertModeChanges.length > 0 || searchQueries.length > 0) && keyBuffer.every((key) => ONE_KEY.test(key));
}

/** Play text as keys. What follows an insert command is what that insert types, up
 *  to `<Esc>` or the end of the text, which ends it as an insert in a recording ends. */
function playText(engine: Vim, cm: Parameters<Vim["exitInsertMode"]>[0], text: string) {
	const editor = cm as unknown as VimEditor, state = engine.maybeInitVimState_(cm);
	let typed = "";
	const leaveInsert = () => {
		engine.getVimGlobalState_().macroModeState.lastInsertModeChanges.changes = [typed];
		typed = "";
		engine.exitInsertMode(cm);
	};
	for (const [key] of text.matchAll(KEY_IN_TEXT)) {
		if (!state.insertMode) {
			if (key !== "\n") engine.handleKey(cm, key, "macro");
		} else if (key === "<Esc>") leaveInsert();
		else {
			const letters = key === "<CR>" ? "\n" : key;
			editor.replaceSelection(letters);
			typed += letters;
		}
	}
	if (state.insertMode) leaveInsert();
}

let configured = false;
function boxEngine(): Vim {
	const engine = vimEngine();
	if (configured) return engine;
	configured = true;
	for (const [keys, move] of Object.entries(INSERT_MOVES)) {
		const action = `boxInsertMove${keys}`;
		engine.defineAction(action, (cm) => {
			const editor = cm as unknown as VimEditor, offset = move(editor, editor.range.head);
			editor.setRanges([{ anchor: offset, head: offset }], 0);
		});
		engine.mapCommand(keys, "action", action, {}, { context: "insert" });
	}
	// Changing mode drops a selection, so these put it back. Both as Latex Suite.
	engine.defineAction("boxBridgeToInsert", function (this: EngineActions, cm, args, state) {
		const selections = cm.listSelections();
		this.enterInsertMode(cm, { ...args, insertAt: undefined }, state);
		cm.setSelections(selections);
	});
	engine.mapCommand(BRIDGE, "action", "boxBridgeToInsert", {}, { context: "visual" });
	engine.defineAction("boxBridgeToVisual", (cm, _args, state) => {
		const editor = cm as unknown as VimEditor;
		if (!editor.somethingSelected()) return;
		const ranges = editor.ranges.map((range) => ({ ...range })).sort((a, b) => a.head - b.head);
		engine.exitInsertMode(cm, true);
		editor.selectExternally(ranges);
		if (ranges.length < 2) return;
		// The engine reads several ranges as one: this is the block they came from.
		state.visualBlock = true;
		state.sel = { anchor: editor.posFromIndex(ranges[0]!.anchor), head: editor.posFromIndex(ranges.at(-1)!.head - 1) };
	});
	engine.mapCommand(BRIDGE, "action", "boxBridgeToVisual", {}, { context: "insert" });
	// A row where the line is in a matrix, and a stock `o` where not. `.` and macros
	// see one action either way.
	engine.defineAction("boxOpenLine", function (this: EngineActions, cm, args, state) {
		const editor = cm as unknown as VimEditor, { line } = editor.getCursor();
		const end = editor.indexFromPos({ line, ch: Number.MAX_VALUE });
		const row = editor.host.matrixRow?.(editor.doc, end) ?? null;
		if (row === null) {
			this.newLineAndEnterInsertMode(cm, args, state);
			return;
		}
		state.insertMode = true;
		editor.replaceRange(row, editor.posFromIndex(end));
		editor.setCursor(editor.posFromIndex(end + row.length));
		this.enterInsertMode(cm, { repeat: args.repeat }, state);
	});
	engine.mapCommand("o", "action", "boxOpenLine", { after: true }, { context: "normal", isEdit: true, interlaceInsertRepeat: true });
	// The engine works from a line's first row, which a long wrapped line can
	// leave a whole box away from the cursor, and ignores the box's padding.
	engine.defineAction("scrollToCursor", (cm, args) => {
		const editor = cm as unknown as VimEditor, { line } = editor.getCursor();
		editor.host.layout.scrollLine(editor.range.head, editor.indexFromPos({ line, ch: 0 }), editor.indexFromPos({ line, ch: Number.MAX_VALUE }), args.position ?? "");
	});
	// The browser has one clipboard, so `*` and `+` are the same register.
	engine.defineAction("setRegister", (_cm, args, state) => {
		state.inputState.registerName = args.selectedCharacter === "*" ? "+" : args.selectedCharacter;
	});
	engine.defineAction("insertRegister", (cm, args) => {
		const editor = cm as unknown as VimEditor, name = args.selectedCharacter;
		if (name === "+" || name === "*") {
			navigator.clipboard.readText().then((text) => {
				if (text && editor.state.vim?.insertMode) editor.replaceSelection(text);
			}, () => {});
			return;
		}
		const text = engine.getRegisterController().getRegister(name).toString();
		if (text) editor.replaceSelection(text);
	});
	// The stock action reads a register's insert log whatever filled it, and throws
	// on yanked text with its playing flag still up, which ends `.` and every macro.
	engine.defineAction("boxReplayMacro", function (this: EngineActions, cm, args, state) {
		const macro = engine.getVimGlobalState_().macroModeState, wasPlaying = macro.isPlaying;
		const given = args.selectedCharacter ?? "", name = given === "@" ? macro.latestRegister ?? "" : given;
		const register = engine.getRegisterController().getRegister(name);
		try {
			if (name === ":" || isRecording(register)) {
				this.replayMacro(cm, args, state);
				return;
			}
			if (given !== "@") macro.latestRegister = name;
			macro.isPlaying = true;
			macro.replaySearchQueries = register.searchQueries.slice(0);
			for (let left = args.repeat || 1; left > 0; left--) playText(engine, cm, register.toString());
		} finally {
			macro.isPlaying = wasPlaying;
		}
	});
	engine.mapCommand("@<register>", "action", "boxReplayMacro", {}, {});
	boundMacros(engine);
	return engine;
}

/** Geometry the engine needs. Only the browser knows where a line wraps. */
function boxLayout(input: VimInput): VimLayout {
	const { root } = input;
	const document = root.ownerDocument;
	const area = () => {
		const box = root.getBoundingClientRect();
		return { left: box.left + root.clientLeft - root.scrollLeft, top: box.top + root.clientTop - root.scrollTop };
	};
	function coords(offset: number): Box {
		const end = Math.min(input.snapshot().value.length, offset + 64);
		// Hidden symbols have no box, and share the next visible character's spot.
		for (let at = offset; at <= end; at++) {
			const rect = caretRect(root, at);
			if (!rect) continue;
			const { left, top } = area();
			return { left: rect.left - left, right: rect.right - left, top: rect.top - top, bottom: rect.bottom - top };
		}
		return { left: 0, right: 0, top: 0, bottom: 0 };
	}
	function offsetAt(left: number, top: number) {
		const scrolled = root.scrollTop, y = Math.max(0, Math.min(root.scrollHeight - 1, top));
		// Only what is on screen can be hit.
		if (y < scrolled || y >= scrolled + root.clientHeight) root.scrollTop = y;
		const origin = area();
		const x = Math.max(0, Math.min(root.clientWidth - 1, left - root.scrollLeft)) + root.scrollLeft;
		const hit = document.caretPositionFromPoint?.(origin.left + x, origin.top + y);
		const offset = hit ? pathInputOffset(root, hit.offsetNode, hit.offset) : null;
		root.scrollTop = scrolled;
		return offset ?? input.snapshot().selection.focus;
	}
	/** Where a line ends on screen. Hidden symbols at its end have no box, and the
	 *  next visible character is on the next line. */
	function lastBox(from: number, to: number): Box {
		for (let at = to; at > from; at--) {
			const rect = caretRect(root, at);
			if (!rect) continue;
			const { top } = area();
			return { left: 0, right: 0, top: rect.top - top, bottom: rect.bottom - top };
		}
		return coords(from);
	}
	/** Ask the browser, on the real selection, and put that back. */
	function nativeMove(offset: number, direction: "left" | "right" | "forward" | "backward", unit: "character" | "line" | "lineboundary") {
		const selection = document.getSelection();
		if (!selection?.modify) return offset;
		if (document.activeElement !== root) root.focus();
		restorePathSelection(root, { anchor: offset, focus: offset });
		selection.modify("move", direction, unit);
		const moved = selection.focusNode ? pathInputOffset(root, selection.focusNode, selection.focusOffset) : null;
		restorePathSelection(root, input.snapshot().selection);
		return moved ?? offset;
	}
	const sameRow = (a: Box, b: Box) => Math.abs((a.top + a.bottom) - (b.top + b.bottom)) < (a.bottom - a.top);
	return {
		coords,
		offsetAt,
		displayLine(offset, forward, goal) {
			const landing = nativeMove(offset, forward ? "forward" : "backward", "line");
			if (landing === offset || sameRow(coords(offset), coords(landing))) return null;
			if (goal === undefined) return landing;
			keepCaretInView(root, landing);
			const row = coords(landing);
			const hit = offsetAt(goal, (row.top + row.bottom) / 2);
			if (sameRow(row, coords(hit))) return hit;
			// Past a wrapped row's end, the hit is the next row's first spot.
			return hit > 0 && sameRow(row, coords(hit - 1)) ? hit - 1 : landing;
		},
		displayLineEdge(offset, forward) {
			const edge = nativeMove(offset, forward ? "forward" : "backward", "lineboundary");
			if (!forward) return edge;
			const { value } = input.snapshot();
			return edge >= value.length || value[edge] === "\n" ? edge : edge - 1;
		},
		arrow(offset, key) {
			const target = input.arrowTarget(offset, key);
			if (target !== null) return target;
			if (key === "ArrowLeft" || key === "ArrowRight") return nativeMove(offset, key === "ArrowLeft" ? "left" : "right", "character");
			return nativeMove(offset, key === "ArrowUp" ? "backward" : "forward", "line");
		},
		page(offset, pages) {
			const from = coords(offset);
			return offsetAt(from.left, from.top + pages * root.clientHeight);
		},
		scrollLine(head, from, to, position) {
			const height = root.clientHeight, inset = scrollInsets(root), caret = coords(head);
			const wanted = position === "top" ? coords(from).top - inset.top
				: position === "bottom" ? lastBox(from, to).bottom + inset.bottom - height
				: coords(from).bottom - height / 2;
			root.scrollTop = Math.max(caret.bottom + inset.bottom - height, Math.min(caret.top - inset.top, wanted));
		},
		scrollInfo: () => ({ left: root.scrollLeft, top: root.scrollTop, height: root.scrollHeight, width: root.scrollWidth, clientHeight: root.clientHeight, clientWidth: root.clientWidth }),
		scrollTo(left, top) {
			if (left !== null && left !== undefined) root.scrollLeft = left;
			if (top !== null && top !== undefined) root.scrollTop = top;
		},
		scrollIntoView: (offset) => keepCaretInView(root, offset),
		lineHeight: () => parseFloat(document.defaultView?.getComputedStyle(root).lineHeight ?? "") || 20,
	};
}

/** Where this insert session started, for the text it adds up to. Keys alone cannot
 *  say: a snippet takes out what was typed, and the engine only logs what goes in. */
type InsertSession = {
	doc: string;
	caret: number;
	/** The caret after the session's last edit. Anywhere else, the learner moved it. */
	last: number;
	/** The log no longer adds up to the text. */
	dirty: boolean;
	/** Block insert's first two cursors, whose span is what one line got. */
	block: { from: Marker; to: Marker; text: string } | null;
};
type Marker = ReturnType<VimEditor["setBookmark"]>;

function sameSelection(a: TextSelection, b: TextSelection) { return a.anchor === b.anchor && a.focus === b.focus; }
const collapsed = (offset: number): TextSelection => ({ anchor: offset, focus: offset });

/** The first spot two texts differ, which is where an undo should put the cursor.
 *  A repeated letter leaves several such spots, and the step's own caret knows which. */
function changeSpot(a: string, b: string, caret: number) {
	let first = 0;
	while (first < a.length && first < b.length && a[first] === b[first]) first++;
	const shortest = Math.min(a.length, b.length);
	let tail = 0;
	while (tail < shortest && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	return caret >= shortest - tail && caret <= first ? caret : first;
}

/** The Enter that `:w` stands in for, for a box to tell from a real one. */
const SAVES = new WeakSet<Event>();
export function isVimSave(event: Event) { return SAVES.has(event); }

export function attachVim(input: VimInput): VimBox {
	const { root, history } = input;
	const document = root.ownerDocument;
	const engine = boxEngine();
	/** Undo and redo already moved the history, so their text must not record again. */
	let travelled = false;
	/** The next commit is flush's own, not news. */
	let flushing = false;
	let idleQueued = false;
	let saving = false;
	let sending = false;
	/** What the box shows for a one-line block. Its anchor can be inside a chip,
	 *  which the box can only show from the edge, and that is no move of the user's. */
	let blockShown: TextSelection | null = null;
	let destroyed = false;
	let copyWatch: (() => void) | null = null;
	let shell: HTMLElement | null = null;
	let drawn: { highlight: Highlights; ranges: Range[] }[] = [];
	/** Block insert's cursors at a line's end, where there is no character to paint. */
	let endCarets: HTMLElement[] = [];
	/** The character under the block cursor, which is redrawn on its own as the caret moves. */
	let cursorMark: { highlight: Highlights; range: Range } | null = null;
	let blockOut = false;
	let session: InsertSession | null = null;

	const host: VimHost = {
		layout: boxLayout(input),
		guardEdit: guardChipEdit,
		opaque: chipSpans,
		matrixRow: input.matrixRow,
		undo: () => travel("undo"),
		redo: () => travel("redo"),
		save() { saving = true; },
		focus() { root.focus(); },
		idle() {
			if (idleQueued) return;
			idleQueued = true;
			queueMicrotask(() => {
				idleQueued = false;
				if (!destroyed) flush();
			});
		},
		overlay() { draw(); },
		panel(element) {
			shell?.remove();
			shell = null;
			if (!element) return;
			shell = document.createElement("div");
			shell.className = "lh-vim-prompt";
			shell.append(element);
			document.body.append(shell);
			placePrompt(shell);
		},
		promptClosed(refocus) {
			if (destroyed) return;
			flush();
			// The prompt took the browser's selection, so hand it back. Focusing
			// first would read the lost one as where the learner moved to.
			input.select(input.snapshot().selection);
			if (refocus) root.focus();
		},
	};
	const editor = new VimEditor(host, input.snapshot().value);
	const cm = editor as unknown as Parameters<Vim["handleKey"]>[0];
	const vim = () => editor.state.vim!;
	root.dataset.vim = "normal";
	editor.on("vim-mode-change", show);
	root.addEventListener("blur", clearCursor);
	sync();

	function placePrompt(element: HTMLElement) {
		const box = root.getBoundingClientRect(), gap = 4;
		element.style.left = `${box.left}px`;
		element.style.width = `${box.width}px`;
		const above = box.top - gap - element.offsetHeight;
		element.style.top = `${above >= 0 ? above : box.bottom + gap}px`;
	}
	function show() {
		const state = vim();
		const mode = state.insertMode ? (editor.state.overwrite ? "replace" : "insert") : state.visualMode ? "visual" : "normal";
		if (root.dataset.vim !== mode) root.dataset.vim = mode;
	}
	function isVisual() { return !!vim().visualMode; }
	function isNormal() { return !vim().insertMode && !isVisual(); }
	function isPending() {
		const state = vim(), keys = state.inputState;
		return !!(keys.keyBuffer.length || keys.operator || keys.registerName || keys.prefixRepeat.length || keys.motionRepeat.length || keys.operatorShortcut || editor.state.closeVimNotification || state.insertModeReturn);
	}

	/** Where the box's own selection belongs. Several ranges can only be drawn, so
	 *  the real caret just marks the main one, at the spot it can take: the engine's
	 *  cursor can sit in a chip's source, and that is no move of the learner's. */
	function selectionInEditor(): TextSelection {
		const state = vim(), { anchor, head } = editor.range;
		if (editor.ranges.length < 2) return { anchor, focus: head };
		const main = state.visualBlock ? editor.indexFromPos(state.sel.head) : head;
		return collapsed(settleCaret(editor.doc, main, main, false));
	}
	function settle(target: TextSelection, from: TextSelection): TextSelection {
		const normal = isNormal(), value = editor.doc;
		const focus = settleCaret(value, target.focus, from.focus, normal);
		if (target.anchor === target.focus) return collapsed(focus);
		return { anchor: settleCaret(value, target.anchor, from.anchor, false), focus };
	}
	function travel(direction: "undo" | "redo") {
		commitText(false);
		const current: PathEditSnapshot = { value: editor.doc, selection: selectionInEditor() };
		const next = history[direction](current);
		if (!next) return;
		input.travelled(direction, next.value);
		const caret = changeSpot(current.value, next.value, next.selection.focus);
		editor.load(next.value, { anchor: caret, head: caret });
		travelled = true;
	}
	/** Hand the engine's text to the model. */
	function commitText(move: boolean) {
		const before = input.snapshot();
		const edits = editor.takeEdits();
		if (editor.doc === before.value) return;
		const selection = move ? settle(selectionInEditor(), before.selection) : before.selection;
		flushing = true;
		try { input.commit({ value: editor.doc, selection }, !travelled, edits); }
		finally { flushing = false; }
	}
	function beginSession(): InsertSession {
		const doc = editor.doc, caret = editor.range.head;
		const [first, second] = [...editor.ranges].sort((a, b) => a.head - b.head);
		const block = first && second ? {
			from: editor.setBookmark(editor.posFromIndex(first.head)),
			to: editor.setBookmark(editor.posFromIndex(second.head)),
			text: doc.slice(first.head, second.head),
		} : null;
		return { doc, caret, last: caret, dirty: false, block };
	}
	function endSession() {
		session?.block?.from.clear();
		session?.block?.to.clear();
		session = null;
	}
	/** Make the engine's log of this session say what it added up to, so that `.`,
	 *  a count and a macro all put in the text and not the keys. */
	function rewriteLog() {
		if (!session) return;
		const log = engine.getVimGlobalState_().macroModeState.lastInsertModeChanges;
		let back = 0, forward = 0, text = "";
		const { block } = session, from = block?.from.offset, to = block?.to.offset;
		if (block && typeof from === "number" && typeof to === "number") {
			// A line keeps what follows its cursor, so only the end of the span can match.
			const now = editor.doc.slice(from, to);
			let same = 0;
			while (same < Math.min(now.length, block.text.length) && now[now.length - 1 - same] === block.text[block.text.length - 1 - same]) same++;
			forward = block.text.length - same;
			text = now.slice(0, now.length - same);
		} else {
			const { doc, caret } = session, now = editor.doc;
			let same = 0;
			while (same < Math.min(caret, now.length) && doc[same] === now[same]) same++;
			let tail = 0;
			while (tail < Math.min(doc.length - caret, now.length - same) && doc[doc.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
			back = caret - same;
			forward = doc.length - caret - tail;
			text = now.slice(same, now.length - tail);
		}
		log.changes = [];
		log.maybeReset = false;
		for (let i = 0; i < back; i++) editor.forwardKey(new KeyboardEvent("keydown", { key: "Backspace" }));
		for (let i = 0; i < forward; i++) editor.forwardKey(new KeyboardEvent("keydown", { key: "Delete" }));
		if (text) log.changes.push(text);
	}
	function settleLog() { if (session?.dirty) rewriteLog(); }
	function changedInSession() {
		if (!session) return;
		session.dirty = true;
		session.last = editor.range.head;
	}
	/** The learner moved the caret, which starts what `.` repeats over, as the engine does. */
	function followCaret() {
		if (!session || !vim().insertMode || editor.ranges.length > 1 || editor.range.head === session.last) return;
		const log = engine.getVimGlobalState_().macroModeState.lastInsertModeChanges;
		if (session.dirty) {
			rewriteLog();
			log.maybeReset = true;
		}
		endSession();
		session = beginSession();
	}
	/** Make the box show what the engine just did. Safe to call with nothing to do. */
	function flush() {
		const state = vim();
		// Before the commit: a `c` deletes as it enters insert, and that is part of the session.
		if (state.insertMode) {
			history.openGroup();
			session ??= beginSession();
		}
		if (!editor.dialogOpen) {
			const before = input.snapshot();
			if (session && !state.insertMode) input.leftInsert(settle(selectionInEditor(), before.selection).focus);
			if (editor.doc !== before.value) {
				commitText(true);
				const after = input.snapshot().selection;
				writeBack(after);
				if (session) session.last = editor.range.head;
			} else {
				const selection = settle(selectionInEditor(), before.selection);
				writeBack(selection);
				if (!sameSelection(selection, before.selection)) input.select(selection);
				blockShown = state.visualBlock ? selection : null;
				followCaret();
			}
			travelled = false;
		}
		if (!state.insertMode) {
			history.closeGroup();
			endSession();
		}
		show();
		draw();
		const block = editor.ranges.length > 1;
		if (block || blockOut) input.reveal();
		blockOut = block;
		if (saving && !editor.dialogOpen) {
			saving = false;
			sending = true;
			// Enter's own path, so `:w` sends in every box exactly as Enter does.
			const enter = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
			SAVES.add(enter);
			root.dispatchEvent(enter);
			sending = false;
		}
	}
	/** A snapped cursor has to be where the engine thinks it is, too. */
	function writeBack(selection: TextSelection) {
		if (sameSelection(selection, selectionInEditor())) return;
		if (selection.anchor === selection.focus && !isVisual()) {
			editor.ranges = [{ anchor: selection.focus, head: selection.focus }];
			editor.primary = 0;
		} else if (isVisual() && !vim().visualBlock) {
			editor.range.anchor = selection.anchor;
			editor.moveVisualHead(selection.focus);
		}
	}
	/** Take in what changed since the engine last looked. */
	function sync() {
		if (editor.dialogOpen) return;
		const { value, selection } = input.snapshot();
		editor.load(value);
		if (sameSelection(selection, selectionInEditor())) return;
		if (blockShown && sameSelection(selection, blockShown)) return;
		editor.moveExternally({ anchor: selection.anchor, head: selection.focus });
	}
	/** An edit from outside, which ends a visual selection it replaced. */
	function takeIn(value: string, selection: TextSelection) {
		const range = { anchor: selection.anchor, head: selection.focus };
		editor.load(value, range);
		if (isVisual()) editor.moveExternally(range);
	}

	function clearCursor() {
		cursorMark?.highlight.delete(cursorMark.range);
		cursorMark = null;
	}
	/** The block takes the color of the text under it, so dim text sits on a dim
	 *  block. Bringing up that one character keeps it as readable as any other. */
	function drawCursor() {
		clearCursor();
		const { value, selection: { anchor, focus } } = input.snapshot();
		if (vim().insertMode || anchor !== focus || focus >= value.length || value[focus] === "\n" || document.activeElement !== root) return;
		const highlight = sharedHighlight(CURSOR);
		if (!highlight) return;
		const [range] = pathInputRanges(root, [{ start: focus, end: focus + 1 }]);
		highlight.add(range!);
		cursorMark = { highlight, range: range! };
	}
	function clearDrawing() {
		clearCursor();
		for (const { highlight, ranges } of drawn) for (const range of ranges) highlight.delete(range);
		drawn = [];
		for (const caret of endCarets) caret.remove();
		endCarets = [];
	}
	function draw() {
		clearDrawing();
		drawCursor();
		const search = editor.searchOverlay ? editor.findMatches(editor.searchOverlay, HIGHLIGHT_LIMIT) : [];
		const several = editor.ranges.length > 1;
		const reached = several ? editor.reachableRanges() : [];
		const spans = (list: VimEditor["ranges"]): Span[] => list.flatMap(({ anchor, head }) => (anchor === head ? [] : [{ start: Math.min(anchor, head), end: Math.max(anchor, head) }]));
		// The main cursor is the browser's own.
		const others = several && vim().insertMode ? reached.filter((range) => range !== editor.range).map((range) => range.head) : [];
		const onCharacter = (head: number) => head < editor.doc.length && editor.doc[head] !== "\n";
		endCarets = sharedHighlight(CARET) ? others.filter((head) => !onCharacter(head)).map((head) => markPathSpot(root, head, END_CARET)) : [];
		const groups: [string, Span[]][] = [[SEARCH, search], [SELECTION, spans(reached)], [CARET, others.filter(onCharacter).map((head) => ({ start: head, end: head + 1 }))]];
		for (const [name, list] of groups) {
			const highlight = sharedHighlight(name);
			if (!highlight || !list.length) continue;
			const ranges = pathInputRanges(root, list);
			for (const range of ranges) highlight.add(range);
			drawn.push({ highlight, ranges });
		}
	}

	/** Out of whatever the engine is doing. Marked as its own operation, or it
	 *  would read the selection this drops as the learner's. */
	function escape() {
		settleLog();
		editor.during(() => editor.operation(() => {
			editor.curOp!.isVimOp = true;
			engine.handleKey(cm, "<Esc>", "user");
		}));
	}
	function backToNormal() {
		vim().insertModeReturn = false;
		if (!isNormal() || isPending()) escape();
		history.closeGroup();
		show();
	}
	function runKey(key: string) {
		settleLog();
		try { return editor.during(() => !!engine.multiSelectHandleKey(cm, key, "user")); }
		catch (error) {
			// A throw leaves the engine mid-command, which would swallow every later key.
			console.error(error);
			escape();
			return true;
		}
	}
	function consume(event: KeyboardEvent) {
		event.preventDefault();
		event.stopPropagation();
		return true;
	}
	function isChord(event: KeyboardEvent) { return event.ctrlKey || event.metaKey || event.altKey; }
	function isPrintable(key: string, event: KeyboardEvent) { return key.length === 1 && !isChord(event); }
	/** Whether `<C-g>` has a selection to carry. Latex Suite's keys, off with it. */
	function bridgeable() {
		if (!input.bridges() || isPending()) return false;
		const { anchor, focus } = input.snapshot().selection;
		// Block insert's cursors are the editor's alone.
		const selected = editor.ranges.length > 1 ? editor.somethingSelected() : anchor !== focus;
		return isVisual() || (vim().insertMode && selected);
	}
	/** The key as this box reads it. */
	function boxKey(event: KeyboardEvent) {
		const state = vim(), key = engine.vimKeyFromEvent(event, state);
		if (key === "<C-g>" && bridgeable()) return BRIDGE;
		// Every box takes Alt+Enter for Enter, so the engine does too.
		const enter = key === "<CR>" || key === "<A-CR>";
		// To the engine Enter is `j^`, and a one-shot command ends at the `j`,
		// which would type the `^`. This is the same move as a single key.
		return enter ? (state.insertModeReturn ? "+" : "<CR>") : key;
	}
	/** Whether the box has a use for a chord with nothing waiting. Asking the engine
	 *  runs nothing, and this origin keeps a macro being recorded from logging it. */
	function chordInUse(event: KeyboardEvent) {
		const key = boxKey(event);
		if (!key) return false;
		if (ENGINE_CHORDS.has(key)) return true;
		const bound = !!engine.findKey(cm, key, "mapping");
		// `<C-r>` in insert is the start of a command, and asking left it waiting.
		vim().inputState.keyBuffer.length = 0;
		return bound;
	}
	function watchCopy() {
		copyWatch?.();
		const copied = () => {
			copyWatch?.();
			if (vim().insertMode) {
				const { focus } = input.snapshot().selection;
				editor.moveExternally({ anchor: focus, head: focus });
			} else escape();
			flush();
		};
		root.addEventListener("copy", copied, { once: true });
		const timer = setTimeout(() => copyWatch?.(), 200);
		copyWatch = () => {
			clearTimeout(timer);
			root.removeEventListener("copy", copied);
			copyWatch = null;
		};
	}

	function keyDown(event: KeyboardEvent) {
		if (sending) return false;
		const state = vim();
		const key = boxKey(event);
		if (!key || APP_KEYS.has(key)) return false;
		const message = !!editor.state.currentNotificationClose;
		// The engine closes its long output for itself, and reads this key to do so.
		if (message && !editor.state.closeVimNotification) editor.closeNotification();
		sync();
		if (state.insertMode && (key === "<BS>" || key === "<Del>")) editor.forwardKey(event);
		const pending = isPending();
		// Esc from a one-shot command is normal, as from any pending state.
		if (key === "<Esc>") state.insertModeReturn = false;
		if (isNormal() && !pending) {
			if (key === "<CR>") return false;
			if (key === "<Esc>") {
				// Dismissing a message is all this press does.
				if (message) return consume(event);
				const search = state.searchState_;
				if (search?.getOverlay()) {
					editor.removeOverlay();
					search.setOverlay(null);
				}
				return false;
			}
		}
		// Space stays bare typing, which normal mode has no use for.
		if (key === "<Space>" && !state.insertMode && !state.expectLiteralNext) {
			if (pending) backToNormal();
			flush();
			return consume(event);
		}
		// Shift+Enter stays the box's own new line, and ends whatever was waiting.
		if (key === "<S-CR>" && !state.insertMode) {
			if (pending) backToNormal();
			flush();
			return false;
		}
		const { anchor, focus } = input.snapshot().selection;
		if (key === "<C-c>" && !IS_MAC && anchor !== focus && !pending) {
			// The browser's copy runs after this key. The engine's Esc waits for it.
			watchCopy();
			return false;
		}
		const replacing = state.insertMode && editor.state.overwrite;
		const commands = editor.commands;
		if (runKey(key)) {
			// A chord drops a waiting key, and only goes on if the box has no use for it.
			const dropped = pending && !isPending() && editor.commands === commands;
			flush();
			return dropped && isChord(event) && !chordInUse(event) ? false : consume(event);
		}
		if (replacing && (key.length === 1 || key === "<Space>" || key === "<BS>")) {
			editor.during(() => {
				if (key === "<BS>") editor.execCommand("cursorCharLeft");
				else editor.overWriteSelection(key === "<Space>" ? " " : key);
			});
			flush();
			return consume(event);
		}
		if (state.insertMode) {
			if (key !== "<CR>") return pending && isChord(event) && chordInUse(event) ? consume(event) : false;
			editor.during(() => editor.typed("\n"));
			flush();
			return consume(event);
		}
		if ((pending && (!isChord(event) || chordInUse(event))) || ENGINE_CHORDS.has(key) || isPrintable(key, event)) return consume(event);
		if (isVisual() && key === "<CR>") return consume(event);
		return false;
	}
	/** Block insert: one edit at every cursor. */
	function multiEdit(edit: () => void) {
		if (!vim().insertMode || editor.ranges.length < 2) return false;
		editor.during(edit);
		flush();
		return true;
	}

	return {
		keyDown,
		blocksInput: (event) => !vim().insertMode && TYPING_INPUT.test(event.inputType),
		multiInput(event) {
			if (event.inputType === "insertText" && event.data) return multiEdit(() => editor.typed(event.data!));
			if (event.inputType === "deleteContentBackward") return multiEdit(() => editor.deleteBy(-1));
			if (event.inputType === "deleteContentForward") return multiEdit(() => editor.deleteBy(1));
			return false;
		},
		multiPaste: (text) => multiEdit(() => editor.typed(text)),
		blocksTyping: () => !vim().insertMode,
		noted(record) {
			const { value, selection } = input.snapshot();
			// A mirrored stop may have added to the engine's own commit.
			if (flushing) {
				if (value !== editor.doc) takeIn(value, selection);
				return;
			}
			if (record && vim().insertMode) {
				editor.noteEdit(value, { anchor: selection.anchor, head: selection.focus });
				if (session) session.last = editor.range.head;
			} else takeIn(value, selection);
			draw();
		},
		external(reset) {
			const { value, selection } = input.snapshot();
			// Dictation added this, so it is no part of what the session repeats.
			if (session && !session.block && value.startsWith(editor.doc)) session.doc += value.slice(editor.doc.length);
			takeIn(value, selection);
			if (reset) {
				backToNormal();
				flush();
			}
			draw();
		},
		// Text the engine has not been told about yet draws once it has.
		painted() { if (editor.doc === input.snapshot().value) draw(); },
		settled() {
			if (editor.dialogOpen) return;
			sync();
			followCaret();
			drawCursor();
			if (!isNormal() || document.activeElement !== root) return;
			const { value, selection } = input.snapshot();
			if (selection.anchor !== selection.focus) return;
			const clipped = clipCaret(value, selection.focus);
			if (clipped === selection.focus) return;
			editor.moveExternally({ anchor: clipped, head: clipped });
			input.select(collapsed(clipped));
		},
		resumeGroup() {
			if (!vim().insertMode) return;
			history.openGroup();
			changedInSession();
		},
		plainInsert: () => vim().insertMode && !editor.state.overwrite && !isPending(),
		cursors() {
			sync();
			if (editor.ranges.length < 2) return null;
			return editor.reachableRanges().map(({ anchor, head }) => ({ anchor, focus: head })).sort((a, b) => a.focus - b.focus);
		},
		block() {
			if (editor.ranges.length < 2) return null;
			const lines = editor.ranges.map((range) => editor.posFromIndex(range.head).line);
			return { anchor: editor.indexFromPos({ line: Math.min(...lines), ch: 0 }), focus: editor.indexFromPos({ line: Math.max(...lines), ch: Number.MAX_VALUE }) };
		},
		several: () => editor.ranges.length > 1,
		expanded: changedInSession,
		jumped(selection) {
			editor.moveExternally({ anchor: selection.anchor, head: selection.focus });
			if (session?.dirty) session.last = selection.focus;
		},
		multiExpand(edits, cursors, recorded = true) {
			editor.during(() => editor.replaceSpans(edits, cursors && cursors.map(({ anchor, focus }) => ({ anchor, head: focus }))));
			travelled = recorded;
			flush();
			changedInSession();
		},
		moveCursors(cursors) {
			editor.during(() => editor.setRanges(cursors.map(({ anchor, focus }) => ({ anchor, head: focus })), 0));
			flush();
			if (session) session.last = editor.range.head;
		},
		destroy() {
			destroyed = true;
			root.removeEventListener("blur", clearCursor);
			endSession();
			copyWatch?.();
			editor.closePrompt?.();
			editor.closeNotification();
			shell?.remove();
			clearDrawing();
			history.closeGroup();
			engine.leaveVimMode(cm);
			delete root.dataset.vim;
		},
	};
}
