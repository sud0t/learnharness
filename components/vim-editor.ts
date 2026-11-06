import { initVim, type CodeMirrorConstructor, type CM5EditorInterface, type MotionFn, type vimState } from "@replit/codemirror-vim-core";
import { IS_MAC } from "@/src/core";
import type { Span, VimEdit } from "./vim-chips";

/** The editor interface the vim engine drives, over a source string and offsets.
 *  It has no CodeMirror and no DOM of its own. What a string cannot answer, such
 *  as where a line wraps, comes from the host. */

export type Vim = ReturnType<typeof initVim>;
export type VimRange = { anchor: number; head: number };
export type VimBox = { left: number; right: number; top: number; bottom: number };
export type VimArrow = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";
type Coordinates = "div" | "local";
type Handler = (...args: never[]) => unknown;
type HandlerHolder = { _handlers?: Record<string, Handler[]> };
type Target = HandlerHolder & { addEventListener?: EventTarget["addEventListener"]; removeEventListener?: EventTarget["removeEventListener"] };

/** Everything here uses the scrolled content's own coordinates. */
export interface VimLayout {
	coords(offset: number): VimBox;
	offsetAt(left: number, top: number): number;
	/** One display line away, at the column nearest a goal. Null at the text's edge. */
	displayLine(offset: number, forward: boolean, goal: number | undefined): number | null;
	/** The start, or the last character, of the display line holding an offset. */
	displayLineEdge(offset: number, forward: boolean): number;
	/** Where an arrow key goes from an offset. */
	arrow(offset: number, key: VimArrow): number;
	page(offset: number, pages: number): number;
	/** Set the source line from `from` to `to` at a spot in the box, keeping `head` in view. */
	scrollLine(head: number, from: number, to: number, position: string): void;
	scrollInfo(): { left: number; top: number; height: number; width: number; clientHeight: number; clientWidth: number };
	scrollTo(left: number | null | undefined, top: number | null | undefined): void;
	scrollIntoView(offset: number): void;
	lineHeight(): number;
}

export interface VimHost {
	/** What opening a line at this offset adds instead of a new line, if anything. */
	matrixRow?(value: string, offset: number): string | null;
	layout: VimLayout;
	/** Null refuses the edit. */
	guardEdit(value: string, from: number, to: number, text: string): VimEdit | null;
	/** Ranges search and substitute treat as opaque. */
	opaque(value: string): Span[];
	undo(): void;
	redo(): void;
	/** `:w` */
	save(): void;
	focus(): void;
	/** An operation ended with no key in progress, as a prompt command does. */
	idle(): void;
	overlay(query: RegExp | null): void;
	panel(element: HTMLElement | null): void;
	promptClosed(refocus: boolean): void;
}

export class Pos {
	line: number;
	ch: number;
	sticky?: string;
	constructor(line: number, ch: number) { this.line = line; this.ch = ch; }
}
type PosLike = { line: number; ch: number };

function on(target: Target, type: string, handler: Handler) {
	if (target.addEventListener) target.addEventListener(type, handler as unknown as EventListener);
	else {
		const handlers = target._handlers ??= {};
		handlers[type] = [...handlers[type] ?? [], handler];
	}
}
function off(target: Target, type: string, handler: Handler) {
	if (target.removeEventListener) target.removeEventListener(type, handler as unknown as EventListener);
	else {
		const list = target._handlers?.[type];
		if (list) target._handlers![type] = list.filter((item) => item !== handler);
	}
}
function signalTo(handlers: Handler[] | undefined, ...args: unknown[]) {
	for (const handler of handlers ?? []) (handler as (...args: unknown[]) => unknown)(...args);
}
function signal(target: HandlerHolder, type: string, ...args: unknown[]) { signalTo(target._handlers?.[type], ...args); }
function stop(event: Event) {
	event.stopPropagation?.();
	event.preventDefault?.();
}

const WORD_CHARACTER = /[\w\p{Alphabetic}\p{Number}_]/u;
/** How the engine confirms a command, on a status line a box does not have.
 *  What a command has to report, an error or `:registers`, still shows. */
const CONFIRMATION = /^(?:\d+ lines yanked|Found \d+ matches|No matches found)/;

class StringStream {
	pos = 0;
	start = 0;
	string: string;
	lastColumnPos = 0;
	lastColumnValue = 0;
	constructor(text: string) { this.string = text; }
	eol() { return this.pos >= this.string.length; }
	sol() { return this.pos === 0; }
	peek() { return this.string.charAt(this.pos) || undefined; }
	next() { return this.pos < this.string.length ? this.string.charAt(this.pos++) : undefined; }
	eat(match: string | RegExp | ((ch: string) => boolean)) {
		const ch = this.string.charAt(this.pos);
		const ok = typeof match === "string" ? ch === match : !!ch && (match instanceof RegExp ? match.test(ch) : match(ch));
		if (!ok) return undefined;
		this.pos++;
		return ch;
	}
	eatWhile(match: string | RegExp | ((ch: string) => boolean)) {
		const start = this.pos;
		while (this.eat(match)) { /* Consumes as it tests. */ }
		return this.pos > start;
	}
	eatSpace() {
		const start = this.pos;
		while (/\s/.test(this.string.charAt(this.pos))) this.pos++;
		return this.pos > start;
	}
	skipToEnd() { this.pos = this.string.length; }
	skipTo(ch: string) {
		const found = this.string.indexOf(ch, this.pos);
		if (found < 0) return undefined;
		this.pos = found;
		return true;
	}
	backUp(count: number) { this.pos -= count; }
	column() { return this.pos; }
	indentation() { return /^\s*/.exec(this.string)![0].length; }
	match(pattern: string | RegExp, consume?: boolean, caseInsensitive?: boolean) {
		if (typeof pattern === "string") {
			const fold = (text: string) => (caseInsensitive ? text.toLowerCase() : text);
			if (fold(this.string.slice(this.pos, this.pos + pattern.length)) !== fold(pattern)) return null;
			if (consume !== false) this.pos += pattern.length;
			return true;
		}
		const found = this.string.slice(this.pos).match(pattern);
		if (found && found.index! > 0) return null;
		if (found && consume !== false) this.pos += found[0].length;
		return found;
	}
	current() { return this.string.slice(this.start, this.pos); }
}

type Change = { from: number; to: number; length: number };
/** `skip` leaves a range in place and out of the edit. */
type EditSpan = { from: number; to: number; skip?: boolean };

function mapOffset(offset: number, change: Change, assoc: number) {
	const { from, to, length } = change;
	if (offset < from) return offset;
	if (offset > to) return offset + length - (to - from);
	const side = to === from ? assoc : offset === from ? -1 : offset === to ? 1 : assoc;
	return side < 0 ? from : from + length;
}

class Marker {
	id: number;
	offset: number | null;
	constructor(private editor: VimEditor, offset: number, private assoc: number) {
		this.id = editor.$mid++;
		this.offset = offset;
		editor.marks[this.id] = this;
	}
	clear() { delete this.editor.marks[this.id]; }
	find() { return this.offset === null ? null : this.editor.posFromIndex(this.offset); }
	update(change: Change) {
		if (this.offset === null) return;
		if (this.offset > change.from && this.offset < change.to) this.offset = null;
		else this.offset = mapOffset(this.offset, change, this.assoc);
	}
}

type Operation = {
	$d: number;
	isVimOp?: boolean;
	cursorActivity?: boolean;
	cursorActivityHandlers?: Handler[];
	change?: { text: string[]; next?: unknown };
	lastChange?: { text: string[]; next?: unknown };
	changeHandlers?: Handler[];
	$changeStart?: number;
};
type DialogOptions = {
	value?: string;
	selectValueOnOpen?: boolean;
	onKeyDown?: (event: KeyboardEvent, value: string, close: (value?: string) => void) => unknown;
	onKeyUp?: (event: KeyboardEvent, value: string, close: (value?: string) => void) => unknown;
	closeOnEnter?: boolean;
	closeOnBlur?: boolean;
};
type EditorState = NonNullable<CM5EditorInterface["state"]> & { vim?: (vimState & { mode?: string }) | null };

/** Lines and offsets are derived from `doc`, which is the only text there is. */
export class VimEditor {
	state: EditorState = {};
	marks: Record<string, Marker> = Object.create(null);
	$mid = 0;
	$lastChangeEndOffset = 0;
	$lineHandleChanges: Change[] | undefined;
	curOp: Operation | null = null;
	virtualSelection: VimRange[] | null = null;
	options: Record<string, unknown>;
	_handlers: Record<string, Handler[]> = {};
	doc: string;
	ranges: VimRange[] = [{ anchor: 0, head: 0 }];
	primary = 0;
	/** Registers listeners only: real keys reach the engine through the host, and
	 *  paste must not flip the mode the way the engine's own hook on this would. */
	private field: HandlerHolder = {};
	private lineStarts: number[] | null = null;
	/** True while the host is running a key, so it commits by itself. */
	private busy = false;
	/** Counts the commands the engine has run. A key it only dropped runs none. */
	commands = 0;
	private edits: Change[] = [];
	searchOverlay: RegExp | null = null;
	closePrompt: (() => void) | null = null;

	constructor(readonly host: VimHost, value: string, options: Record<string, unknown> = {}) {
		this.doc = value;
		this.options = { ...options };
		vimEngine().enterVimMode(this as unknown as CM5EditorInterface);
		this.on("vim-mode-change", (event: { mode: string; subMode?: string }) => {
			const vim = this.state.vim;
			if (!vim) return;
			vim.mode = event.mode + (event.subMode ? (event.subMode === "linewise" ? " line" : " block") : "");
		});
	}

	/** Run engine code the caller commits for itself afterwards. */
	during<T>(run: () => T): T {
		const was = this.busy;
		this.busy = true;
		try { return run(); } finally { this.busy = was; }
	}
	/** A raw key, which is how the engine records Backspace for `.` and macros. */
	forwardKey(event: KeyboardEvent) { signal(this.field, "keydown", event); }

	/** Take in text that changed outside the engine, keeping marks in place. */
	load(value: string, selection?: VimRange) {
		if (value !== this.doc) {
			const { from, to, length } = this.difference(value);
			const change = { from, to, length };
			for (const mark of Object.values(this.marks)) mark.update(change);
			this.ranges = this.ranges.map((range) => ({ anchor: mapOffset(range.anchor, change, -1), head: mapOffset(range.head, change, -1) }));
			this.doc = value;
			this.lineStarts = null;
		}
		if (selection) {
			this.ranges = [selection];
			this.primary = 0;
		}
	}
	/** The exact edits since last asked, in order. A diff cannot tell these apart
	 *  when one commit holds an edit at every cursor. */
	takeEdits() {
		const edits = this.edits;
		this.edits = [];
		return edits;
	}
	/** Typing and paste, which the engine needs to hear about for `.` and macros. */
	noteEdit(value: string, selection: VimRange) {
		const { from, to, length } = this.difference(value);
		this.write(from, to, value.slice(from, from + length));
		this.edits = [];
		this.ranges = [selection];
		this.primary = 0;
		this.onSelectionChange();
		this.afterDispatch();
	}
	/** The selection moved without the engine: by a click, say. */
	moveExternally(selection: VimRange) {
		this.ranges = [selection];
		this.primary = 0;
		this.onSelectionChange();
		this.afterDispatch();
	}
	/** A selection for the engine to read as one the learner made, which is how it
	 *  comes to be in visual mode for one it did not make itself. */
	selectExternally(ranges: VimRange[]) {
		(this.curOp ??= { $d: 0 }).isVimOp = false;
		this.setRanges(ranges, this.primary);
	}
	/** Typing while block insert holds several cursors. */
	typed(text: string) { this.replaceSelection(text); }
	deleteBy(direction: -1 | 1) {
		const spans = this.selectedSpans().map((span) => {
			if (span.skip || span.from !== span.to) return span;
			return direction < 0 ? { ...span, from: Math.max(0, span.from - 1) } : { ...span, to: Math.min(this.doc.length, span.to + 1) };
		});
		this.applyTo(spans, () => "", true);
	}
	overWriteSelection(text: string) {
		const hidden = (offset: number) => this.host.opaque(this.doc).find((span) => span.start === offset);
		this.ranges = this.ranges.map((range) => {
			if (range.anchor !== range.head || range.head >= this.doc.length || this.doc[range.head] === "\n") return range;
			// A chip stays: typing over one continues after it.
			const start = hidden(range.head)?.end ?? range.head;
			return start >= this.doc.length || this.doc[start] === "\n" ? { anchor: start, head: start } : { anchor: start, head: start + 1 };
		});
		this.replaceSelection(text);
	}

	on(type: string, handler: Handler) { on(this, type, handler); }
	off(type: string, handler: Handler) { off(this, type, handler); }
	signal(type: string, ...args: unknown[]) { signal(this, type, ...args); }

	private get starts() {
		if (this.lineStarts) return this.lineStarts;
		const starts = [0];
		for (let at = this.doc.indexOf("\n"); at >= 0; at = this.doc.indexOf("\n", at + 1)) starts.push(at + 1);
		return this.lineStarts = starts;
	}
	private lineAt(offset: number) {
		const starts = this.starts;
		let low = 0, high = starts.length - 1;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (starts[middle]! <= offset) low = middle; else high = middle - 1;
		}
		return low;
	}
	private lineEnd(line: number) {
		const next = this.starts[line + 1];
		return next === undefined ? this.doc.length : next - 1;
	}
	indexFromPos(pos: PosLike) {
		let { line, ch } = pos;
		if (line < 0) { line = 0; ch = 0; }
		if (line >= this.starts.length) { line = this.starts.length - 1; ch = Number.MAX_VALUE; }
		return Math.min(this.starts[line]! + Math.max(0, ch), this.lineEnd(line));
	}
	posFromIndex(offset: number) {
		const clamped = Math.max(0, Math.min(this.doc.length, offset));
		const line = this.lineAt(clamped);
		return new Pos(line, clamped - this.starts[line]!);
	}
	firstLine() { return 0; }
	lastLine() { return this.starts.length - 1; }
	lineCount() { return this.starts.length; }
	getValue() { return this.doc; }
	setValue(text: string) {
		this.edit(0, this.doc.length, text);
		this.setRanges([{ anchor: 0, head: 0 }], 0);
	}
	getLine(line: number) { return line < 0 || line >= this.starts.length ? "" : this.doc.slice(this.starts[line]!, this.lineEnd(line)); }
	getRange(start: PosLike, end: PosLike) { return this.doc.slice(this.indexFromPos(start), this.indexFromPos(end)); }
	clipPos(pos: PosLike) {
		let { line, ch } = pos;
		if (line < 0) { line = 0; ch = 0; }
		if (line >= this.starts.length) { line = this.starts.length - 1; ch = Number.MAX_VALUE; }
		return new Pos(line, Math.min(Math.max(0, ch), this.lineEnd(line) - this.starts[line]!));
	}

	get range() { return this.ranges[this.primary] ?? this.ranges[0]!; }
	setRanges(ranges: VimRange[], primary: number) {
		const main = ranges[primary];
		const sorted = [...ranges].sort((a, b) => Math.min(a.anchor, a.head) - Math.min(b.anchor, b.head));
		const kept: VimRange[] = [];
		for (const range of sorted) {
			const last = kept.at(-1);
			const start = Math.min(range.anchor, range.head);
			if (last && Math.max(last.anchor, last.head) > start && (last.anchor !== last.head || range.anchor === range.head)) continue;
			kept.push(range);
		}
		this.ranges = kept;
		this.primary = main ? Math.max(0, kept.indexOf(main)) : 0;
		this.onSelectionChange();
		this.afterDispatch();
	}
	private afterDispatch() { if (this.curOp && !this.curOp.isVimOp) this.onBeforeEndOperation(); }
	setCursor(line: number | PosLike, ch?: number) {
		const pos = typeof line === "object" ? line : { line, ch: ch ?? 0 };
		const offset = this.indexFromPos(pos);
		this.setRanges([{ anchor: offset, head: offset }], 0);
		this.afterDispatch();
	}
	getCursor(which: "head" | "anchor" | "start" | "end" = "head") {
		const { anchor, head } = this.range;
		const offset = which === "head" ? head : which === "anchor" ? anchor : which === "start" ? Math.min(anchor, head) : Math.max(anchor, head);
		return this.posFromIndex(offset);
	}
	listSelections() { return this.ranges.map((range) => ({ anchor: this.posFromIndex(range.anchor), head: this.posFromIndex(range.head) })); }
	setSelections(selections: { anchor: PosLike; head: PosLike }[], primary?: number) {
		const only = selections.length === 1 ? selections[0] : undefined;
		if (only && !this.state.vim?.visualMode) this.widenToCells(only);
		this.setRanges(selections.map((range) => ({ anchor: this.indexFromPos(range.anchor), head: this.indexFromPos(range.head) })), primary ?? 0);
	}
	/** Outside visual mode only an operator sets a real range, and it then reads
	 *  its text and places the cursor from these same objects. So a cell has to be
	 *  whole here, or the register gets a piece of it and the cursor a stale spot. */
	private widenToCells(range: { anchor: PosLike; head: PosLike }) {
		const anchor = this.indexFromPos(range.anchor), head = this.indexFromPos(range.head);
		if (anchor === head) return;
		const from = Math.min(anchor, head), to = Math.max(anchor, head);
		let start = from, end = to;
		for (const cell of this.host.opaque(this.doc)) {
			if (cell.start >= to || cell.end <= from) continue;
			start = Math.min(start, cell.start);
			end = Math.max(end, cell.end);
		}
		if (start === from && end === to) return;
		range.anchor = this.posFromIndex(anchor < head ? start : end);
		range.head = this.posFromIndex(anchor < head ? end : start);
	}
	setSelection(anchor: PosLike, head: PosLike, options?: { origin?: string }) {
		this.setSelections([{ anchor, head }], 0);
		if (options?.origin === "*mouse") this.onBeforeEndOperation();
	}
	somethingSelected() { return this.ranges.some((range) => range.anchor !== range.head); }
	getSelections() { return this.selectedSpans().map(({ from, to, skip }) => (skip ? "" : this.doc.slice(from, to))); }
	getSelection() { return this.getSelections().join("\n"); }
	/** Keep the engine's own idea of a visual selection's head in step with `range`. */
	moveVisualHead(head: number) {
		const vim = this.state.vim, range = this.range;
		if (vim?.visualMode && !vim.visualLine && !vim.visualBlock) vim.sel.head = this.posFromIndex(range.anchor <= head ? head - 1 : head);
		range.head = head;
	}

	save() { this.host.save(); }
	getInputField() { return this.field as unknown as HTMLElement; }
	focus() { this.host.focus(); }
	blur() { /* Only tests of a real editor call this. */ }
	refresh() { /* Layout is live: there is nothing to measure ahead of time. */ }
	getMode() { return { name: this.getOption("mode") }; }

	private difference(value: string) {
		const shortest = Math.min(this.doc.length, value.length);
		let start = 0;
		while (start < shortest && this.doc[start] === value[start]) start++;
		let end = 0;
		while (end < shortest - start && this.doc[this.doc.length - 1 - end] === value[value.length - 1 - end]) end++;
		return { from: start, to: this.doc.length - end, length: value.length - end - start };
	}
	/** Every engine edit passes through here. */
	edit(from: number, to: number, text: string): VimEdit | null {
		const safe = this.host.guardEdit(this.doc, from, to, text);
		if (safe) this.write(safe.from, safe.to, safe.text);
		return safe;
	}
	private write(from: number, to: number, text: string) {
		this.doc = this.doc.slice(0, from) + text + this.doc.slice(to);
		this.lineStarts = null;
		const change = { from, to, length: text.length };
		this.edits.push(change);
		for (const mark of Object.values(this.marks)) mark.update(change);
		this.$lineHandleChanges?.push(change);
		const map = (range: VimRange) => ({ anchor: mapOffset(range.anchor, change, -1), head: mapOffset(range.head, change, -1) });
		this.ranges = this.ranges.map(map);
		this.virtualSelection &&= this.virtualSelection.map(map);
		const operation = this.curOp ??= { $d: 0 };
		if (operation.$changeStart === undefined || operation.$changeStart > from) operation.$changeStart = from;
		this.$lastChangeEndOffset = from + text.length;
		this.report(operation, text);
	}
	private report(operation: Operation, text: string) {
		const record = { text: text.split("\n") };
		if (operation.lastChange) { operation.lastChange.next = record; operation.lastChange = record; }
		else operation.lastChange = operation.change = record;
		operation.changeHandlers ??= this._handlers.change?.slice();
	}
	private applyTo(spans: EditSpan[], textFor: (index: number) => string, cursorAfter: boolean) {
		const order = spans.map((span, index) => ({ ...span, index })).sort((a, b) => b.from - a.from);
		// Edits run last to first, so each one moves the ends already found.
		const ends: number[] = [];
		let untouched = 0;
		for (const span of order) {
			const done = span.skip ? null : this.edit(span.from, span.to, textFor(span.index));
			const grew = done ? done.text.length - (done.to - done.from) : 0;
			for (let index = 0; index < ends.length; index++) ends[index]! += grew;
			ends.unshift(done ? done.from + done.text.length : span.to);
			if (!done) untouched++;
		}
		// The engine expects one change per cursor, or it skips later ones for `.`.
		for (; untouched; untouched--) this.report(this.curOp ??= { $d: 0 }, "");
		if (cursorAfter) {
			this.ranges = ends.map((end) => ({ anchor: end, head: end }));
			this.primary = Math.min(this.primary, ends.length - 1);
			this.onSelectionChange();
		}
		this.afterDispatch();
	}
	/** A block's column can fall inside a cell's source. The cell draws as one
	 *  character, so that line has nothing there: it is too short for the block. */
	private selectedSpans(): EditSpan[] {
		const cells = this.ranges.length > 1 ? this.host.opaque(this.doc) : [];
		return this.ranges.map((range) => {
			const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head);
			return { from, to, skip: cells.some((cell) => from > cell.start && from < cell.end) };
		});
	}
	/** The ranges an edit reaches, which are the ones worth drawing. */
	reachableRanges() {
		const spans = this.selectedSpans();
		return this.ranges.filter((_range, index) => !spans[index]!.skip);
	}
	/** Several edits at once, in order, ending on these cursors if any are given.
	 *  This closes the operation: a change left queued reaches the engine's log later. */
	replaceSpans(spans: readonly { from: number; to: number; text: string }[], cursors: VimRange[] | null) {
		for (const { from, to, text } of spans) this.edit(from, to, text);
		if (cursors) this.setRanges(cursors, 0);
		else this.afterDispatch();
	}
	replaceRange(text: string, start: PosLike, end?: PosLike) {
		this.edit(this.indexFromPos(start), this.indexFromPos(end ?? start), text);
		this.afterDispatch();
	}
	replaceSelection(text: string) { this.applyTo(this.selectedSpans(), () => text, true); }
	replaceSelections(replacements: string[]) { this.applyTo(this.selectedSpans(), (index) => replacements[index] ?? "", false); }

	onSelectionChange() {
		const operation = this.curOp ??= { $d: 0 };
		operation.cursorActivityHandlers ??= this._handlers.cursorActivity?.slice();
		operation.cursorActivity = true;
	}
	operation<T>(run: () => T): T {
		this.commands++;
		const operation = this.curOp ??= { $d: 0 };
		operation.$d = (operation.$d || 0) + 1;
		try { return run(); } finally {
			if (this.curOp && !--this.curOp.$d) this.onBeforeEndOperation();
		}
	}
	onBeforeEndOperation() {
		const operation = this.curOp;
		if (operation) {
			if (operation.change) signalTo(operation.changeHandlers, this, operation.change);
			if (operation.cursorActivity) signalTo(operation.cursorActivityHandlers, this, null);
			this.curOp = null;
		}
		if (!this.busy) this.host.idle();
	}

	getOption(name: string): number | boolean | string | undefined {
		switch (name) {
			case "firstLineNumber": return 1;
			case "tabSize": return (this.options.tabSize as number | undefined) ?? (this.options.indentUnit as number | undefined) ?? 2;
			case "readOnly": return !!this.options.readOnly;
			case "indentWithTabs": return !!this.options.indentWithTabs;
			case "indentUnit": return (this.options.indentUnit as number | undefined) ?? 2;
			case "textwidth": return this.state.textwidth;
			case "keyMap": return this.state.keyMap ?? "vim";
			default: return this.options[name] as number | boolean | string | undefined;
		}
	}
	setOption(name: string, value: unknown) {
		if (name === "keyMap") this.state.keyMap = value as string;
		else if (name === "textwidth") this.state.textwidth = value as number;
		else this.options[name] = value;
	}
	toggleOverwrite(overwrite: boolean) { this.state.overwrite = overwrite; }
	execCommand(name: string) {
		const command = (commands as Record<string, unknown>)[name];
		if (typeof command === "function" && Object.hasOwn(commands, name)) (command as (cm: VimEditor) => void)(this);
		else if (name === "goLineLeft" || name === "goLineRight") {
			const offset = this.host.layout.displayLineEdge(this.range.head, name === "goLineRight");
			this.setRanges([{ anchor: offset, head: offset }], 0);
		}
	}

	setBookmark(cursor: PosLike, options?: { insertLeft?: boolean }) { return new Marker(this, this.indexFromPos(cursor), options?.insertLeft ? 1 : -1); }
	addOverlay({ query }: { query: RegExp }) {
		this.searchOverlay = query;
		this.host.overlay(query);
		return query;
	}
	removeOverlay() {
		this.searchOverlay = null;
		this.host.overlay(null);
	}

	/** The engine's regex dialect, made safe for a global scan. */
	private scanner(query: RegExp) {
		const source = query.source.replace(/(\\.|{(?:\d+(?:,\d*)?|,\d+)})|[{}]/g, (all, kept) => kept ?? `\\${all}`);
		const flags = `gm${query.ignoreCase ? "i" : ""}`;
		try { return new RegExp(source, `${flags}u`); } catch { return new RegExp(source, flags); }
	}
	/** Every match in order, up to a limit, leaving out what the host keeps opaque. */
	findMatches(query: RegExp, limit: number): Span[] {
		const opaque = this.host.opaque(this.doc), pattern = this.scanner(query), found: Span[] = [];
		for (let match = pattern.exec(this.doc); match && found.length < limit; match = pattern.exec(this.doc)) {
			const start = match.index, end = start + match[0].length;
			if (end > start && !opaque.some((span) => start < span.end && end > span.start)) found.push({ start, end });
			if (!match[0]) pattern.lastIndex++;
		}
		return found;
	}
	getSearchCursor(query: RegExp, pos: PosLike) {
		const first = this.indexFromPos({ line: pos.line, ch: pos.ch ?? Number.MAX_VALUE });
		const pattern = () => this.scanner(query);
		type Found = { from: number; to: number; match: RegExpExecArray };
		// Asked per scan: `:s` edits between finds, which moves what is opaque.
		const blocker = () => {
			const opaque = this.host.opaque(this.doc);
			return (from: number, to: number) => opaque.some((span) => from < span.end && to > span.start);
		};
		const nextMatch = (from: number): Found | null => {
			if (from > this.doc.length) return null;
			const scan = pattern(), blocked = blocker();
			scan.lastIndex = from;
			for (let match = scan.exec(this.doc); match; match = scan.exec(this.doc)) {
				const to = match.index + match[0].length;
				if (!blocked(match.index, to)) return { from: match.index, to, match };
				if (!match[0]) scan.lastIndex++;
			}
			return null;
		};
		const previousMatch = (limit: number): Found | null => {
			const scan = pattern(), blocked = blocker();
			let best: Found | null = null;
			for (let match = scan.exec(this.doc); match; match = scan.exec(this.doc)) {
				const to = match.index + match[0].length;
				if (to > limit) break;
				// An empty match right after a real one is not a stop of its own.
				const trailing = !match[0] && match.index === best?.to;
				if (!trailing && !blocked(match.index, to)) best = { from: match.index, to, match };
				if (!match[0]) scan.lastIndex++;
			}
			return best;
		};
		const editor = this;
		let last: Found | null = null, result: { from: Pos; to: Pos; match: RegExpExecArray } | null = null, afterEmpty = false;
		return {
			findNext() { return this.find(false); },
			findPrevious() { return this.find(true); },
			find(back?: boolean) {
				if (back) last = previousMatch(last ? (afterEmpty ? last.to - 1 : last.from) : first);
				else last = nextMatch(last ? (afterEmpty ? last.to + 1 : last.to) : first);
				result = last && { from: editor.posFromIndex(last.from), to: editor.posFromIndex(last.to), match: last.match };
				afterEmpty = last ? last.from === last.to : false;
				return last?.match;
			},
			from() { return result?.from; },
			to() { return result?.to; },
			replace(text: string) {
				if (!last) return;
				editor.edit(last.from, last.to, text);
				editor.afterDispatch();
				last.to = last.from + text.length;
				if (result) result.to = editor.posFromIndex(last.to);
			},
			get match() { return result?.match ?? null; },
		};
	}

	/** `j` and `k` count source lines, or lines hidden by formatting would be
	 *  skipped. Only the display-line motions ask the layout. */
	findPosV(start: PosLike, amount: number, unit: "page" | "line") {
		const offset = this.indexFromPos(start);
		if (unit === "page") return this.posFromIndex(this.host.layout.page(offset, amount));
		const line = Math.max(0, Math.min(this.lastLine(), start.line + amount));
		return new Pos(line, Math.min(start.ch, this.getLine(line).length));
	}
	findDisplayPos(start: PosLike, forward: boolean, goal: number | undefined) {
		const next = this.host.layout.displayLine(this.indexFromPos(start), forward, goal);
		const pos: Pos & { hitSide?: boolean } = this.posFromIndex(next ?? this.indexFromPos(start));
		if (next === null) pos.hitSide = true;
		return pos;
	}
	defaultTextHeight() { return this.host.layout.lineHeight(); }
	charCoords(pos: PosLike, _mode: Coordinates) { return this.host.layout.coords(this.indexFromPos(pos)); }
	coordsChar(coords: { left: number; top: number }, _mode: Coordinates) { return this.posFromIndex(this.host.layout.offsetAt(coords.left, coords.top)); }
	getScrollInfo() { return this.host.layout.scrollInfo(); }
	scrollTo(left?: number | null, top?: number | null) { this.host.layout.scrollTo(left, top); }
	scrollIntoView(pos?: PosLike) { this.host.layout.scrollIntoView(pos ? this.indexFromPos(pos) : this.range.head); }

	findMatchingBracket(pos: PosLike) {
		const offset = this.indexFromPos(pos), pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}", ")": "(", "]": "[", "}": "{" };
		const ch = this.doc[offset];
		const other = ch ? pairs[ch] : undefined;
		if (!ch || !other) return { to: undefined };
		const direction = "([{".includes(ch) ? 1 : -1;
		for (let at = offset, depth = 0; at >= 0 && at < this.doc.length; at += direction) {
			if (this.doc[at] === ch) depth++;
			else if (this.doc[at] === other && --depth === 0) return { to: this.posFromIndex(at) };
		}
		return { to: undefined };
	}
	scanForBracket(where: PosLike, direction: 1 | -1, _style: unknown, config?: { maxScanLineLength?: number; maxScanLines?: number; bracketRegex?: RegExp }) {
		const matching: Record<string, string> = { "(": ")>", ")": "(<", "[": "]>", "]": "[<", "{": "}>", "}": "{<", "<": ">>", ">": "<<" };
		const maxLength = config?.maxScanLineLength ?? 10000, maxLines = config?.maxScanLines ?? 1000, bracket = config?.bracketRegex ?? /[(){}[\]]/;
		const stack: string[] = [];
		const lineEnd = direction > 0 ? Math.min(where.line + maxLines, this.lastLine() + 1) : Math.max(-1, where.line - maxLines);
		let line = where.line;
		for (; line !== lineEnd; line += direction) {
			const text = this.getLine(line);
			if (!text || text.length > maxLength) continue;
			const end = direction > 0 ? text.length : -1;
			let at = direction > 0 ? 0 : text.length - 1;
			if (line === where.line) at = where.ch - (direction < 0 ? 1 : 0);
			for (; at !== end; at += direction) {
				const ch = text.charAt(at);
				if (!bracket.test(ch)) continue;
				const match = matching[ch];
				if (match && (match.charAt(1) === ">") === (direction > 0)) stack.push(ch);
				else if (!stack.length) return { pos: new Pos(line, at), ch };
				else stack.pop();
			}
		}
		return line - direction === (direction > 0 ? this.lastLine() : 0) ? false : null;
	}

	indentLine(line: number, more?: boolean) {
		const unit = this.getOption("indentWithTabs") ? "\t" : " ".repeat(this.getOption("indentUnit") as number);
		const start = this.starts[line]!, text = this.getLine(line);
		if (more) {
			if (text) this.edit(start, start, unit);
		} else {
			const leading = /^(\t| +)/.exec(text)?.[1];
			if (leading) this.edit(start, start + (leading === "\t" ? 1 : Math.min(leading.length, unit.length)), "");
		}
		this.afterDispatch();
	}
	getTokenTypeAt(): "" | "string" | "comment" { return ""; }
	getLastEditEnd() { return this.posFromIndex(this.$lastChangeEndOffset); }
	getLineHandle(row: number) {
		this.$lineHandleChanges ??= [];
		return { row, index: this.indexFromPos(new Pos(row, 0)) };
	}
	getLineNumber(handle: { index: number }) {
		if (!this.$lineHandleChanges) return null;
		let offset = handle.index;
		for (const change of this.$lineHandleChanges) {
			if (offset > change.from && offset < change.to) return null;
			offset = mapOffset(offset, change, 1);
		}
		const pos = this.posFromIndex(offset);
		return pos.ch === 0 ? pos.line : null;
	}
	releaseLineHandles() { this.$lineHandleChanges = undefined; }
	isInMultiSelectMode() { return this.ranges.length > 1; }
	virtualSelectionMode() { return !!this.virtualSelection; }
	forEachSelection(command: () => void) {
		const main = this.primary;
		const selections = this.virtualSelection = this.ranges.map((range) => ({ ...range }));
		for (let index = 0; index < selections.length; index++) {
			const range = this.virtualSelection[index];
			if (!range) continue;
			this.ranges = [range];
			this.primary = 0;
			this.onSelectionChange();
			this.afterDispatch();
			command();
			this.virtualSelection[index] = this.ranges[0]!;
		}
		this.ranges = this.virtualSelection;
		this.primary = main;
		this.virtualSelection = null;
		this.onSelectionChange();
		this.afterDispatch();
	}
	hardWrap(options: { from: number; to: number; column?: number; allowMerge?: boolean }) {
		return hardWrap(this, options);
	}

	get dialogOpen() { return !!this.state.dialog?.querySelector("input"); }
	private showPanel(dialog: HTMLElement) {
		const previous = this.state.dialog;
		this.state.dialog = dialog;
		if (previous === dialog) return;
		if (previous?.contains(document.activeElement)) this.focus();
		this.host.panel(dialog);
	}
	private hidePanel(dialog: HTMLElement) {
		if (this.state.dialog !== dialog) return false;
		this.state.dialog = null;
		this.host.panel(null);
		return true;
	}
	closeNotification() {
		const close = this.state.currentNotificationClose;
		this.state.currentNotificationClose = null;
		close?.();
	}
	openNotification(template: Node, options?: { duration?: number }) {
		if (CONFIRMATION.test(template.textContent ?? "")) return () => {};
		this.closeNotification();
		const dialog = document.createElement("div");
		dialog.append(template);
		let closed = false;
		const duration = options?.duration ?? 5000;
		const close = () => {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			dialog.remove();
			this.hidePanel(dialog);
		};
		this.state.currentNotificationClose = close;
		this.showPanel(dialog);
		const timer = duration ? setTimeout(close, duration) : undefined;
		return close;
	}
	openDialog(template: HTMLElement, callback: ((value: string) => void) | undefined, options: DialogOptions = {}) {
		const input = template.querySelector("input");
		// Macro recording: the mode shows only through the cursor.
		if (!input) return () => {};
		this.closeNotification();
		const dialog = document.createElement("div");
		dialog.append(template);
		let closed = false;
		const finish = (refocus: boolean) => {
			if (closed) return;
			closed = true;
			this.closePrompt = null;
			dialog.remove();
			if (this.hidePanel(dialog)) this.host.promptClosed(refocus);
		};
		this.closePrompt = () => finish(false);
		const close = (value?: string) => {
			if (typeof value === "string") input.value = value;
			else finish(true);
		};
		this.showPanel(dialog);
		if (options.value) {
			input.value = options.value;
			if (options.selectValueOnOpen !== false) input.select();
		}
		input.addEventListener("keydown", (event) => {
			containPromptKey(event);
			if (options.onKeyDown?.(event, input.value, close)) return;
			if (event.keyCode === 13) callback?.(input.value);
			if (event.keyCode === 27 || (options.closeOnEnter !== false && event.keyCode === 13)) {
				stop(event);
				close();
			}
		});
		input.addEventListener("keyup", (event) => { options.onKeyUp?.(event, input.value, close); });
		if (options.closeOnBlur !== false) {
			input.addEventListener("blur", () => setTimeout(() => {
				if (closed || input.ownerDocument.activeElement === input) return;
				// The learner went elsewhere. Leave focus where they put it, and
				// drop any operator still waiting on this prompt.
				finish(false);
				vimEngine().handleKey(this as unknown as CM5EditorInterface, "<Esc>", "user");
			}));
		}
		input.focus();
		return close;
	}
}

/** A prompt is part of the box, so the app's bare keys and its Esc and Tab
 *  never see it. Chords the prompt has no use for still reach the app. */
function containPromptKey(event: KeyboardEvent) {
	const key = event.key.toLowerCase();
	if (event.ctrlKey && (key === "r" || key === "w")) {
		// In the desktop app these reload and close the window.
		stop(event);
	} else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
		event.stopPropagation();
		if (key === "tab") event.preventDefault();
	}
}

/** Word wrap for `gq` and `gw`, as the engine's CodeMirror 6 wrapper does it. */
function hardWrap(editor: VimEditor, options: { from: number; to: number; column?: number; allowMerge?: boolean }) {
	const max = options.column || (editor.getOption("textwidth") as number | undefined) || 80;
	const allowMerge = options.allowMerge !== false;
	let row = Math.min(options.from, options.to), endRow = Math.max(options.from, options.to);
	while (row <= endRow) {
		const line = editor.getLine(row);
		if (line.length > max) {
			const space = findSpace(line, max, 5);
			if (space) {
				const indentation = /^\s*/.exec(line)![0];
				editor.replaceRange(`\n${indentation}`, new Pos(row, space.start), new Pos(row, space.end));
			}
			endRow++;
		} else if (allowMerge && /\S/.test(line) && row !== endRow) {
			const nextLine = editor.getLine(row + 1);
			if (nextLine && /\S/.test(nextLine)) {
				const trimmedLine = line.replace(/\s+$/, ""), trimmedNext = nextLine.replace(/^\s+/, "");
				const merged = `${trimmedLine} ${trimmedNext}`;
				const space = findSpace(merged, max, 5);
				if ((space && space.start > trimmedLine.length) || merged.length < max) {
					editor.replaceRange(" ", new Pos(row, trimmedLine.length), new Pos(row + 1, nextLine.length - trimmedNext.length));
					row--;
					endRow--;
				} else if (trimmedLine.length < line.length) {
					editor.replaceRange("", new Pos(row, trimmedLine.length), new Pos(row, line.length));
				}
			}
		}
		row++;
	}
	return row;
}
function findSpace(line: string, max: number, min: number) {
	if (line.length < max) return undefined;
	const before = line.slice(0, max), after = line.slice(max);
	const spaceAfter = /^(?:(\s+)|(\S+)(\s+))/.exec(after), spaceBefore = /(?:(\s+)|(\s+)(\S+))$/.exec(before);
	let start = 0, end = 0;
	if (spaceBefore && !spaceBefore[2]) {
		start = max - spaceBefore[1]!.length;
		end = max;
	}
	if (spaceAfter && !spaceAfter[2]) {
		if (!start) start = max;
		end = max + spaceAfter[1]!.length;
	}
	if (start) return { start, end };
	if (spaceBefore?.[2] && spaceBefore.index > min) return { start: spaceBefore.index, end: spaceBefore.index + spaceBefore[2].length };
	if (spaceAfter?.[2]) {
		start = max + spaceAfter[2].length;
		return { start, end: start + spaceAfter[3]!.length };
	}
	return undefined;
}

function cursorOf(editor: VimEditor) { return editor.range.head; }
function moveEditor(editor: VimEditor, delta: number) {
	const offset = Math.max(0, Math.min(editor.doc.length, cursorOf(editor) + delta));
	editor.setRanges([{ anchor: offset, head: offset }], 0);
}
const commands = {
	undo: (editor: VimEditor) => editor.host.undo(),
	redo: (editor: VimEditor) => editor.host.redo(),
	cursorCharLeft: (editor: VimEditor) => moveEditor(editor, -1),
	newlineAndIndent: (editor: VimEditor) => editor.replaceSelection(`\n${/^\s*/.exec(editor.getLine(editor.getCursor().line))![0]}`),
	indentAuto: () => {},
	toggleLineComment: () => {},
};
const deleteAt = (editor: VimEditor, direction: -1 | 1) => {
	const { anchor, head } = editor.range;
	if (anchor !== head) { editor.replaceSelection(""); return; }
	const from = direction < 0 ? head - 1 : head, to = from + 1;
	if (from >= 0 && to <= editor.doc.length) editor.replaceRange("", editor.posFromIndex(from), editor.posFromIndex(to));
};
const keys: Record<string, (editor: VimEditor) => void> = {
	Left: (editor) => moveEditor(editor, -1),
	Right: (editor) => moveEditor(editor, 1),
	Up: (editor) => {
		const pos = editor.getCursor();
		editor.setCursor(pos.line - 1, pos.ch);
	},
	Down: (editor) => {
		const pos = editor.getCursor();
		editor.setCursor(pos.line + 1, pos.ch);
	},
	Backspace: (editor) => deleteAt(editor, -1),
	Delete: (editor) => deleteAt(editor, 1),
};

/** What the engine calls `CodeMirror`. */
export const editorStatics = {
	Pos,
	StringStream,
	version: "6.0.0",
	isMac: IS_MAC,
	commands,
	keys,
	isWordChar: (ch: string) => WORD_CHARACTER.test(ch),
	addClass: () => {},
	rmClass: () => {},
	e_preventDefault: (event: Event) => event.preventDefault(),
	e_stop: stop,
	lookupKey: (key: string, _map: string, handle: (binding: (editor: VimEditor) => void) => void) => {
		const binding = keys[key] ?? (key.startsWith("Arrow") ? keys[key.slice(5)] : undefined);
		if (binding) handle(binding);
	},
	on,
	off,
	signal,
	findMatchingTag: () => null,
	findEnclosingTag: () => undefined,
};

/** The engine asks one call for both `j` and `gj`, and `j` must count source
 *  lines or lines hidden by formatting would be skipped. So this motion gets its
 *  own way to the layout. Otherwise it matches the engine's. */
const moveByDisplayLines: MotionFn = (cm, head, args, vim) => {
	const editor = cm as unknown as VimEditor;
	if (vim.lastMotion !== moveByDisplayLines && !GOAL_KEEPING_MOTIONS.has(vim.lastMotion?.name ?? "")) vim.lastHSPos = editor.charCoords(head, "div").left;
	let cursor: PosLike = head;
	for (let step = 0; step < Math.round(args.repeat ?? 1); step++) {
		const next = editor.findDisplayPos(cursor, !!args.forward, vim.lastHSPos);
		if (next.hitSide) break;
		cursor = next;
	}
	if (cursor !== head) vim.lastHPos = cursor.ch;
	return new Pos(cursor.line, cursor.ch);
};
const GOAL_KEEPING_MOTIONS = new Set(["moveByScroll", "moveByLines", "moveToColumn", "moveToEol"]);

let engine: Vim | null = null;
/** Registers, macros and the last search are shared by every box. */
export function vimEngine(): Vim {
	if (engine) return engine;
	engine = initVim(editorStatics as unknown as CodeMirrorConstructor);
	engine.defineMotion("moveByDisplayLines", moveByDisplayLines);
	return engine;
}
