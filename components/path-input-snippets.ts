import {
	autoFraction, enlargedBrackets, findExpansion, findVisual, inMath, LatexReader, mapCaret, mapGroups, matrixBracketJump, matrixCell, matrixExit, matrixRow, tabout, tabstopGroups, Tabstops, textChange,
	type Expansion, type Insertion, type LatexContext, type LatexSnippet, type LatexSnippetSet, type Tabout, type TabstopGroup, type TabstopSpec, type TextChange, type TextRange,
} from "@/src/core";
import { atomicPathRange, pathInputRanges, replacePathSelection, sharedHighlight, type Highlights, type PathEditSnapshot, type PathInputHistory, type TextSelection } from "./path-input-dom";
import { isVimSave, type VimBox } from "./path-input-vim";

/** What a box gives its snippets. Text changes through `commit`, as for vim. */
export type SnippetInput = {
	root: HTMLElement;
	history: PathInputHistory;
	snapshot(): PathEditSnapshot;
	commit(next: PathEditSnapshot, record: boolean): void;
	select(selection: TextSelection): void;
	vim(): VimBox | null;
	/** The snippets to run, read at each key so that a saved set applies at once. */
	set(): LatexSnippetSet;
};

export type SnippetBox = {
	/** True when a snippet took the typed text. */
	typed(event: InputEvent): boolean;
	/** True when a snippet took the key, which then goes no further. */
	keyDown(event: KeyboardEvent): boolean;
	/** An edit of the box's own is landing. Stops follow it, and copies of a mirrored
	 *  stop join it: what this returns is the edit to make. */
	edited(before: PathEditSnapshot, next: PathEditSnapshot, edits?: readonly TextChange[]): PathEditSnapshot;
	/** The text changed from outside, as dictation does. With stops still going,
	 *  this is where the selection goes with them. */
	external(before: string, next: string, selection: TextSelection): TextSelection | null;
	/** Undo or redo is about to land on this text. */
	travelled(direction: "undo" | "redo", value: string): void;
	leftInsert(offset: number): void;
	/** The draft was replaced under an edit. */
	clear(): void;
	painted(): void;
	/** A caret or selection has finished moving. */
	selected(): void;
	/** What a new matrix row adds here, or null with no matrix to add to. */
	matrixRow(value: string, offset: number): string | null;
	destroy(): void;
};

const MIRROR = "lh-tabstop-mirror";
const stopColor = (color: number) => `lh-tabstop-${color}`;
/** Redo gives an expansion its stops back, and only a recent one is worth keeping. */
const REMEMBERED = 32;

const collapsed = (offset: number): TextSelection => ({ anchor: offset, focus: offset });
const isCollapsed = ({ anchor, focus }: TextSelection) => anchor === focus;
const asSelection = ({ from, to }: TextRange): TextSelection => ({ anchor: from, focus: to });

/** The Highlight API paints nothing for an empty range, so an empty stop shows on
 *  the character beside it, and on the one before where a line ends. */
function paintable({ from, to }: TextRange, value: string): { start: number; end: number } | null {
	if (from !== to) return { start: from, end: to };
	if (from < value.length && value[from] !== "\n") return { start: from, end: from + 1 };
	return from > 0 && value[from - 1] !== "\n" ? { start: from - 1, end: from } : null;
}

type Found = { caret: number; expansion: Insertion };

export function attachSnippets(input: SnippetInput): SnippetBox {
	const { history } = input;
	const reader = new LatexReader();
	const tabstops = new Tabstops();
	let drawn: { highlight: Highlights; ranges: Range[] }[] = [];
	let expansions: { value: string; groups: TabstopGroup[] }[] = [];

	function draw() {
		for (const { highlight, ranges } of drawn) for (const range of ranges) highlight.delete(range);
		drawn = [];
		if (!tabstops.groups.length) return;
		const { value, selection } = input.snapshot();
		const lists = new Map<string, { start: number; end: number }[]>();
		const add = (name: string, ranges: TextRange[]) => {
			const spans = ranges.flatMap((range) => paintable(range, value) ?? []);
			lists.set(name, [...lists.get(name) ?? [], ...spans]);
		};
		for (const { color, ranges } of tabstops.marks()) add(stopColor(color), ranges);
		add(MIRROR, tabstops.mirrors(selection));
		for (const [name, spans] of lists) {
			const highlight = sharedHighlight(name);
			if (!highlight || !spans.length) continue;
			const ranges = pathInputRanges(input.root, spans);
			for (const range of ranges) highlight.add(range);
			drawn.push({ highlight, ranges });
		}
	}
	/** Selection events arrive late, and a key must not outrun them. */
	function settle() { tabstops.select(input.snapshot().selection); }

	function outsideChips(value: string, { from, to }: Insertion) {
		const { start, end } = atomicPathRange(value, { anchor: from, focus: to });
		return start === from && end === to;
	}
	function find(list: LatexSnippet[], key: string): Found[] | null {
		const { value, selection } = input.snapshot();
		const cursors = input.vim()?.cursors() ?? [selection];
		if (!cursors.every(isCollapsed)) return null;
		const read = (offset: number) => reader.context(value, offset);
		const found: { caret: number; expansion: Expansion }[] = [];
		for (const { focus: caret } of cursors) {
			const expansion = findExpansion(list, input.set().macros, value, caret, key, read);
			if (expansion && outsideChips(value, expansion)) found.push({ caret, expansion });
		}
		// The macro guard hands back what was typed, and typing already does that.
		return found.every(({ expansion }) => expansion.snippet.guard === "keep") ? null : found;
	}
	/** Whatever `make` puts in at each cursor. With `all`, every cursor must take some. */
	function atCursors(make: (value: string, from: number, to: number, context: LatexContext) => Insertion | null, all = false): Found[] | null {
		const { value, selection } = input.snapshot();
		const cursors = input.vim()?.cursors() ?? [selection];
		const found: Found[] = [];
		for (const { anchor, focus } of cursors) {
			const from = Math.min(anchor, focus), to = Math.max(anchor, focus);
			const expansion = make(value, from, to, reader.context(value, to));
			if (expansion && outsideChips(value, expansion)) found.push({ caret: to, expansion });
		}
		return found.length && (!all || found.length === cursors.length) ? found : null;
	}
	function visual(key: string) {
		return atCursors((value, from, to) => findVisual(input.set().visual, value, from, to, key, (offset) => reader.context(value, offset)));
	}
	function fraction() { return atCursors(autoFraction); }
	/** The text with each key in place: Latex Suite's undo step between trigger and snippet. */
	function literalStep(found: Found[]): PathEditSnapshot | undefined {
		const { value, selection } = input.snapshot();
		const keys = found.filter(({ expansion }) => expansion.key !== null).sort((a, b) => b.caret - a.caret);
		if (!keys.length) return undefined;
		let text = value;
		for (const { caret, expansion } of keys) text = text.slice(0, caret) + expansion.key! + text.slice(caret);
		const moved = keys.filter(({ caret }) => caret <= selection.focus).length;
		return { value: text, selection: collapsed(selection.focus + moved) };
	}
	function run(found: Found[]) {
		const before = input.snapshot();
		const ordered = [...found].sort((a, b) => a.expansion.from - b.expansion.from);
		const literal = literalStep(found);
		let value = before.value, shift = 0;
		const edits: (TextChange & { text: string })[] = [];
		let specs: TabstopSpec[] = [];
		for (const { expansion } of ordered) {
			const from = expansion.from + shift, to = expansion.to + shift, text = expansion.insert;
			value = value.slice(0, from) + text + value.slice(to);
			edits.push({ from, to, length: text.length, text });
			specs.push(...expansion.tabstops.map((spec) => ({ ...spec, from: spec.from + from, to: spec.to + from })));
			shift += text.length - (to - from);
		}
		const last = edits.at(-1)!;
		const several = input.vim()?.cursors() ?? null;
		let selection = collapsed(last.from + last.length);
		const source = several ? null : tabstops.linkedRange(before.selection);
		const mirrored = source ? tabstops.mirror(value, last, source) : null;
		if (mirrored) {
			const start = source!.from;
			value = mirrored.value;
			selection = mapCaret(selection, mirrored.changes);
			const relative = specs.map((spec) => ({ ...spec, from: spec.from - start, to: spec.to - start }));
			specs = [mirrored.primary, ...mirrored.copies].flatMap((range) => relative.map((spec) => ({ ...spec, from: spec.from + range.from, to: spec.to + range.from })));
		} else tabstops.map(edits);
		let targets: TextRange[] | null = null;
		if (specs.length) {
			const groups = tabstopGroups(specs, tabstops.nextColor());
			tabstops.add(groups);
			expansions = [...expansions, { value, groups }].slice(-REMEMBERED);
			targets = groups[0]!.ranges;
			selection = asSelection(targets[0]!);
		}
		history.pushExpansion(before, literal);
		tabstops.select(selection);
		if (several) input.vim()!.multiExpand(edits, targets && targets.map(asSelection));
		else input.commit({ value, selection }, false);
		if (found.some(({ expansion }) => expansion.enlarge)) enlarge();
		input.vim()?.expanded();
	}
	/** Brackets around what just went in grow to fit, in the same undo step. */
	function enlarge() {
		const { value, selection } = input.snapshot();
		const edits = enlargedBrackets(reader, value, selection.focus);
		if (!edits.length) return;
		const next = edits.reduce((text, edit) => text.slice(0, edit.from) + edit.text + text.slice(edit.to), value);
		tabstops.map(edits);
		const last = expansions.at(-1);
		if (last?.value === value) {
			last.value = next;
			last.groups = mapGroups(last.groups, edits);
		}
		const vim = input.vim(), several = vim?.cursors();
		if (several) vim!.multiExpand(edits, several.map((cursor) => mapCaret(cursor, edits)));
		else input.commit({ value: next, selection: mapCaret(selection, edits) }, false);
	}

	/** Tab's next stop, with Shift the one before. */
	function move(back: boolean) {
		const { selection } = input.snapshot();
		const target = tabstops.step(selection, back);
		if (!target) return false;
		const vim = input.vim(), first = asSelection(target[0]!);
		tabstops.select(first);
		if (vim?.cursors()) vim.moveCursors(target.map(asSelection));
		else {
			input.select(first);
			vim?.jumped(first);
		}
		draw();
		return true;
	}
	/** One caret, moved by a key, as opposed to by the learner. */
	function moveCaret(offset: number) {
		const caret = collapsed(offset);
		tabstops.select(caret);
		input.select(caret);
		input.vim()?.jumped(caret);
		draw();
	}
	function leave({ value, caret }: Tabout) {
		if (value === input.snapshot().value) moveCaret(caret);
		else {
			input.commit({ value, selection: collapsed(caret) }, true);
			input.vim()?.expanded();
		}
	}
	/** Upstream's chain, in order. Each step that does nothing hands on to the next. */
	function tab(event: KeyboardEvent) {
		if (event.shiftKey) {
			if (!tabstops.active) return false;
			const { value, selection } = input.snapshot();
			return move(true) || inMath(reader.context(value, Math.max(selection.anchor, selection.focus)).mode);
		}
		const found = find(input.set().onTab, "");
		if (found) {
			run(found);
			return true;
		}
		if (move(false)) return true;
		const { value, selection } = input.snapshot();
		const to = Math.max(selection.anchor, selection.focus);
		const context = reader.context(value, to), one = !input.vim()?.several();
		const jump = one ? matrixBracketJump(value, to, context) : null;
		if (jump !== null) {
			moveCaret(jump);
			return true;
		}
		const cells = atCursors((_value, from, end, here) => (from === end ? matrixCell(end, here) : null), true);
		if (cells) {
			run(cells);
			return true;
		}
		const out = one && isCollapsed(selection) ? tabout(value, to, context) : null;
		if (out) leave(out);
		// Nothing above took it, so a stop can only hold Tab by giving it somewhere to go.
		return !!out || inMath(context.mode);
	}
	/** Vim off, a block equation keeps Enter from sending. Vim's insert mode does its own. */
	function enter(shift: boolean) {
		const { value, selection } = input.snapshot();
		const to = Math.max(selection.anchor, selection.focus);
		const context = reader.context(value, to);
		if (shift) {
			const exit = input.vim()?.several() ? null : matrixExit(value, to, context);
			if (exit !== null) moveCaret(exit);
			return exit !== null;
		}
		const rows = atCursors(matrixRow, true);
		if (rows) {
			run(rows);
			return true;
		}
		if (input.vim() || !context.mode.blockMath) return false;
		input.commit(replacePathSelection(value, selection, "\n"), true);
		return true;
	}
	/** A closing bracket steps over the one it matches, if tabout goes there too. */
	function closeBracket(key: string) {
		const { value, selection } = input.snapshot();
		if (!")]}".includes(key) || !isCollapsed(selection) || input.vim()?.several() || value[selection.focus] !== key) return false;
		const out = tabout(value, selection.focus, reader.context(value, selection.focus));
		if (out) leave(out);
		return !!out;
	}
	function backspace() {
		const { value, selection } = input.snapshot();
		if (!isCollapsed(selection) || input.vim()?.cursors()) return false;
		const pair = reader.emptyPair(value, selection.focus);
		if (!pair) return false;
		input.commit(replacePathSelection(value, { anchor: pair.from, focus: pair.to }, ""), true);
		input.vim()?.expanded();
		return true;
	}

	return {
		typed(event) {
			if (event.inputType !== "insertText" || event.data?.length !== 1) return false;
			settle();
			const key = event.data;
			const found = find(input.set().automatic, key) ?? visual(key) ?? (key === "/" ? fraction() : null);
			if (found) run(found);
			return !!found || closeBracket(key);
		},
		keyDown(event) {
			const vim = input.vim(), enterKey = event.key === "Enter";
			if ((vim && !vim.plainInsert()) || event.ctrlKey || event.metaKey || isVimSave(event)) return false;
			// Every box takes Alt+Enter for Enter.
			if (event.altKey && !enterKey) return false;
			if (event.key !== "Tab" && event.key !== "Backspace" && !enterKey) return false;
			settle();
			const taken = enterKey ? enter(event.shiftKey) : event.key === "Tab" ? tab(event) : !event.shiftKey && backspace();
			if (!taken) return false;
			event.preventDefault();
			event.stopPropagation();
			return true;
		},
		edited(before, next, edits) {
			if (!tabstops.groups.length) return next;
			const changes = edits?.length ? edits : [textChange(before.value, next.value, before.selection, next.selection)];
			const vim = input.vim();
			const source = changes.length === 1 && !vim?.several() ? tabstops.linkedRange(before.selection) : null;
			const mirrored = source ? tabstops.mirror(next.value, changes[0]!, source) : null;
			if (!mirrored) {
				tabstops.map(changes);
				tabstops.select(next.selection);
				return next;
			}
			const selection = mapCaret(next.selection, mirrored.changes);
			tabstops.select(selection);
			vim?.expanded();
			return { value: mirrored.value, selection };
		},
		external(before, next, selection) {
			if (!tabstops.groups.length) return null;
			const change = textChange(before, next);
			// An edit inside a stop says nothing of where that stop now is.
			if (!next || tabstops.overlaps(change)) {
				tabstops.clear();
				return null;
			}
			tabstops.map([change]);
			return mapCaret(selection, [change]);
		},
		travelled(direction, value) {
			tabstops.clear();
			if (direction !== "redo") return;
			const expansion = expansions.findLast((item) => item.value === value);
			if (expansion) tabstops.restore(expansion.groups);
		},
		leftInsert(offset) { tabstops.hold(offset); },
		clear() { tabstops.clear(); },
		painted: draw,
		selected() {
			if (!tabstops.groups.length && !drawn.length) return;
			settle();
			draw();
		},
		matrixRow: (value, offset) => matrixRow(value, offset, offset, reader.context(value, offset))?.insert ?? null,
		destroy() {
			tabstops.clear();
			expansions = [];
			draw();
		},
	};
}
