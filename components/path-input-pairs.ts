import { deletePair, insertPair, PairClosers, textChange, type PairChange, type PairCursor, type PairKinds } from "@/src/core";
import { atomicPathRange, type PathEditSnapshot, type TextSelection } from "./path-input-dom";
import type { TextEdit, VimBox } from "./path-input-vim";

/** What a box gives its auto pairs. Text changes through `commit`, as for vim. */
export type PairInput = {
	snapshot(): PathEditSnapshot;
	commit(next: PathEditSnapshot, record: boolean): void;
	select(selection: TextSelection): void;
	vim(): VimBox | null;
	/** Which pairs close, read at each key so that a change of setting applies at once. */
	kinds(): PairKinds;
};

export type PairBox = {
	/** True when auto pairs took the typed text. */
	typed(event: InputEvent): boolean;
	/** True when auto pairs took the key, which then goes no further. */
	keyDown(event: KeyboardEvent): boolean;
	/** Text changed by an edit of the box's own. */
	edited(before: PathEditSnapshot, next: PathEditSnapshot, edits?: readonly TextEdit[]): void;
	/** Text changed from outside, as dictation does, and has landed. */
	external(before: string): void;
	/** The draft was replaced under an edit. */
	clear(): void;
	/** A caret or selection has finished moving. */
	selected(): void;
};

/** A chip is one thing in the text, so no pair goes around part of it. */
function splitsChip(value: string, { from, to }: { from: number; to: number }) {
	const { start, end } = atomicPathRange(value, { anchor: from, focus: to });
	return start !== from || end !== to;
}
const reach = ({ anchor, focus }: PairCursor) => ({ from: Math.min(anchor, focus), to: Math.max(anchor, focus) });

export function attachPairs(input: PairInput): PairBox {
	const closers = new PairClosers();
	/** The box's next edit is this module's, which knows its own edits exactly. */
	let applying = false;

	/** Selection events arrive late, and a key must not outrun them. */
	function settle() {
		const { value, selection } = input.snapshot();
		closers.arrived(value, selection.focus);
	}
	function cursors() {
		const { selection } = input.snapshot();
		return input.vim()?.cursors() ?? [selection];
	}
	function apply(change: PairChange) {
		const before = input.snapshot(), vim = input.vim();
		const value = change.edits.reduce((text, { from, to, text: added }) => text.slice(0, from) + added + text.slice(to), before.value);
		const first = change.cursors[0]!;
		applying = true;
		try {
			if (vim?.several()) {
				if (change.edits.length) vim.multiExpand(change.edits, change.cursors, false);
				else vim.moveCursors(change.cursors);
			} else if (change.edits.length) {
				input.commit({ value, selection: first }, true);
				vim?.expanded();
			} else {
				input.select(first);
				vim?.jumped(first);
			}
		} finally { applying = false; }
		closers.took(change, value, first.focus);
	}

	return {
		typed(event) {
			if (event.inputType !== "insertText" || event.data?.length !== 1) return false;
			settle();
			const { value } = input.snapshot(), at = cursors();
			if (at.some((cursor) => splitsChip(value, reach(cursor)))) return false;
			const change = insertPair(value, at, event.data, closers.list, input.kinds());
			if (change) apply(change);
			return !!change;
		},
		keyDown(event) {
			if (event.key !== "Backspace" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
			const vim = input.vim();
			if (vim && !vim.plainInsert()) return false;
			settle();
			const { value } = input.snapshot(), at = cursors();
			const change = deletePair(value, at, input.kinds());
			if (!change || at.some(({ focus }) => splitsChip(value, { from: focus - 1, to: focus + 1 }))) return false;
			apply(change);
			event.preventDefault();
			event.stopPropagation();
			return true;
		},
		edited(before, next, edits) {
			if (applying) return;
			closers.arrived(before.value, before.selection.focus);
			closers.edited(edits?.length ? edits : [textChange(before.value, next.value, before.selection, next.selection)], next.value, next.selection.focus);
		},
		external(before) {
			const { value, selection } = input.snapshot();
			closers.mapped([textChange(before, value)], value, selection.focus);
		},
		clear() { closers.clear(); },
		selected: settle,
	};
}
