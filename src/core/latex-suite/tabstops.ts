/**
 * A snippet's tabstops, held as source offsets. The rules are Latex Suite 1.13.3's
 * from snippets/tabstop.ts, codemirror/tabstops_state_field.ts and
 * snippet_management.ts, and offsets map through edits the way CodeMirror maps its
 * inclusive marks. MIT, Copyright (c) 2022 artisticat1: see THIRD_PARTY_NOTICES.md.
 *
 * Upstream's mirrored stops are CodeMirror's multiple cursors. A box has one caret,
 * so the other ranges of a group copy the one the caret is in, edit by edit.
 */
import type { Expansion, TabstopSpec } from "./snippets.ts";

export type TextRange = { from: number; to: number };
/** `from` to `to` in the old text became `length` characters. */
export type TextChange = { from: number; to: number; length: number };
export type Caret = { anchor: number; focus: number };

export type TabstopGroup = { ranges: TextRange[]; color: number; hidden: boolean };

const COLORS = 3;

function mapPosition(position: number, change: TextChange, assoc: -1 | 1) {
	const { from, to, length } = change;
	if (position < from) return position;
	if (to > position || (to === position && assoc < 0 && to === from)) return position === from || assoc < 0 ? from : from + length;
	return position + length - (to - from);
}

/** Text typed at either edge of a stop is inside it, and a stop never disappears. */
function mapRange(range: TextRange, change: TextChange): TextRange {
	return { from: mapPosition(range.from, change, -1), to: mapPosition(range.to, change, 1) };
}

/** Groups, after some edits. */
export function mapGroups(groups: readonly TabstopGroup[], changes: readonly TextChange[]): TabstopGroup[] {
	return groups.map((group) => ({ ...group, ranges: group.ranges.map((range) => changes.reduce(mapRange, range)) }));
}

/** The edit that turned one text into another, placed where the caret says when the
 *  text alone cannot: an `a` typed into `aa` could be any of three. */
export function textChange(before: string, after: string, caretBefore?: Caret, caretAfter?: Caret): TextChange {
	const shortest = Math.min(before.length, after.length);
	let start = 0;
	while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) start++;
	if (caretBefore && caretAfter) start = Math.min(start, caretBefore.anchor, caretBefore.focus, caretAfter.anchor, caretAfter.focus);
	let end = 0;
	while (end < shortest - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
	return { from: start, to: before.length - end, length: after.length - end - start };
}

const contains = (range: TextRange, caret: Caret) => {
	const from = Math.min(caret.anchor, caret.focus), to = Math.max(caret.anchor, caret.focus);
	return range.from <= from && range.to >= to;
};
const groupHolds = (group: TabstopGroup, caret: Caret) => group.ranges.some((range) => contains(range, caret));
const copyGroup = (group: TabstopGroup): TabstopGroup => ({ ...group, ranges: group.ranges.map((range) => ({ ...range })) });

/** Lowest number first. The same number, at any depth of index, is one group. */
export function tabstopGroups(specs: readonly TabstopSpec[], color: number): TabstopGroup[] {
	const sorted = [...specs].sort((a, b) => {
		for (let i = 0; i < Math.min(a.index.length, b.index.length); i++) {
			if (a.index[i] !== b.index[i]) return a.index[i]! - b.index[i]!;
		}
		return a.index.length - b.index.length;
	});
	const groups: TabstopGroup[] = [];
	sorted.forEach((spec, i) => {
		const previous = sorted[i - 1];
		const same = previous && spec.index.length === previous.index.length && spec.index.every((value, at) => value === previous.index[at]);
		if (!same) groups.push({ ranges: [], color, hidden: false });
		groups[groups.length - 1]!.ranges.push({ from: spec.from, to: spec.to });
	});
	for (const group of groups) group.ranges.sort((a, b) => a.from - b.from);
	return groups;
}

export const asCaret = (range: TextRange): Caret => ({ anchor: range.from, focus: range.to });
const sameCaret = (a: Caret, b: Caret) => a.anchor === b.anchor && a.focus === b.focus;
const sameRange = (a: TextRange, b: TextRange) => a.from === b.from && a.to === b.to;
const sameRanges = (a: TabstopGroup, b: TabstopGroup) => a.ranges.length === b.ranges.length && a.ranges.every((range, i) => sameRange(range, b.ranges[i]!));

export class Tabstops {
	groups: TabstopGroup[] = [];
	index = 0;
	private color = 0;
	/** Esc steps left off an empty stop, and that alone is no move away from it. */
	private held: number | null = null;
	/** Upstream's stops end on arriving at the last group, but its cursors stay in
	 *  every copy until they leave. This keeps those copies linked for that long. */
	private lingering = false;

	/** Whether there is a stop to go to. A lingering group is only copies. */
	get active() { return this.groups.length > 0 && !this.lingering; }
	nextColor() { return this.color++ % COLORS; }

	clear() {
		this.groups = [];
		this.index = 0;
		this.color = 0;
		this.held = null;
		this.lingering = false;
	}

	map(changes: readonly TextChange[]) {
		for (const group of this.groups) group.ranges = mapGroups([group], changes)[0]!.ranges;
	}

	/** A snippet expanded: its stops take the place of the one it expanded in. */
	add(groups: readonly TabstopGroup[]) {
		this.groups.splice(this.index, 1, ...groups.map(copyGroup));
		this.held = null;
		this.lingering = false;
	}

	/** Redo brought an expansion back, with the stops it had. */
	restore(groups: readonly TabstopGroup[]) {
		this.clear();
		this.groups = groups.map(copyGroup);
	}

	/** Deleting the text between stops leaves them on one spot, where nothing tells
	 *  them apart and there is nowhere for Tab to go. Those are one stop from then on,
	 *  or a box emptied of a snippet would keep stops that swallow whatever comes next. */
	private merge() {
		const count = this.groups.length;
		this.groups = this.groups.filter((group, at) => !this.groups.slice(0, at).some((earlier) => sameRanges(earlier, group)));
		for (const group of this.groups) group.ranges = group.ranges.filter((range, at) => !group.ranges.slice(0, at).some((earlier) => sameRange(earlier, range)));
		if (this.groups.length < count) this.held = null;
	}

	/** The clearing rule. Arriving at the last group, or leaving all of them, ends it. */
	select(caret: Caret) {
		if (!this.groups.length) return;
		this.merge();
		if (this.held !== null) {
			if (caret.anchor === caret.focus && caret.focus === this.held) return;
			this.held = null;
		}
		const found = this.groups.findIndex((group) => groupHolds(group, caret));
		this.index = found < 0 ? this.groups.length : found;
		if (this.groups.length > 1 && this.index < this.groups.length - 1) {
			this.groups[0]!.hidden = true;
			return;
		}
		const arrived = this.groups[this.index];
		this.clear();
		if (arrived && arrived.ranges.length > 1) {
			this.groups = [{ ...arrived, hidden: true }];
			this.lingering = true;
		}
	}

	/** Where Tab goes: every range of the next group, leaving what is already selected. */
	step(caret: Caret, back: boolean): TextRange[] | null {
		const direction = back ? -1 : 1;
		for (let at = this.index + direction; ; at += direction) {
			const group = this.groups[at];
			if (!group) return null;
			const target = groupHolds(group, caret) ? group.ranges.map(({ to }) => ({ from: to, to })) : group.ranges;
			if (!sameCaret(caret, asCaret(target[0]!))) return target.map((range) => ({ ...range }));
		}
	}

	/** Keep stops through the move that leaving insert mode makes. */
	hold(offset: number) { if (this.groups.length) this.held = offset; }

	/** The range an edit made at this caret lands in, when its group is mirrored. */
	linkedRange(caret: Caret): TextRange | null {
		const group = this.groups[this.index];
		if (!group || group.ranges.length < 2) return null;
		return group.ranges.find((range) => contains(range, caret)) ?? null;
	}

	/** Whether an edit reaches into a stop, rather than only touching its edge. */
	overlaps(change: TextChange) {
		return this.groups.some(({ ranges }) => ranges.some((range) => change.from < range.to && change.to > range.from));
	}

	/**
	 * Map an edit made inside a mirrored range, then copy that range over the others.
	 * Returns the new text, or null if the edit was nothing to do with one.
	 */
	mirror(value: string, change: TextChange, source: TextRange): { value: string; changes: TextChange[]; primary: TextRange; copies: TextRange[] } | null {
		if (change.from < source.from || change.to > source.to) return null;
		const group = this.groups[this.index]!;
		const at = group.ranges.indexOf(source);
		this.map([change]);
		const text = value.slice(group.ranges[at]!.from, group.ranges[at]!.to);
		const changes: TextChange[] = [];
		// Last to first, so that earlier offsets stay good while the text changes.
		const others = group.ranges.map((_range, i) => i).filter((i) => i !== at).sort((a, b) => group.ranges[b]!.from - group.ranges[a]!.from);
		for (const i of others) {
			const { from, to } = group.ranges[i]!;
			value = value.slice(0, from) + text + value.slice(to);
			const copy = { from, to, length: text.length };
			changes.push(copy);
			this.mapCopy(copy, i);
		}
		return { value, changes, primary: group.ranges[at]!, copies: group.ranges.filter((_range, i) => i !== at) };
	}

	/** A copy lands exactly on its own range, and pushes along what comes after it. */
	private mapCopy(copy: TextChange, own: number) {
		const active = this.groups[this.index]!;
		this.map([copy]);
		active.ranges[own] = { from: copy.from, to: copy.from + copy.length };
	}

	/** The ranges to mark, by color. */
	marks(): { color: number; ranges: TextRange[] }[] {
		return this.groups.filter((group) => !group.hidden).map(({ color, ranges }) => ({ color, ranges }));
	}

	/** The other ranges of the group the caret is in. */
	mirrors(caret: Caret): TextRange[] {
		const source = this.linkedRange(caret);
		return source ? this.groups[this.index]!.ranges.filter((range) => range !== source) : [];
	}
}

/** A selection after an edit to its left, or around it. */
export function mapCaret(caret: Caret, changes: readonly TextChange[]): Caret {
	let { anchor, focus } = caret;
	for (const change of changes) {
		anchor = mapPosition(anchor, change, 1);
		focus = mapPosition(focus, change, 1);
	}
	return { anchor, focus };
}

/** An expansion's stops in the coordinates of the text it produced. */
export function placedTabstops(expansion: Pick<Expansion, "from" | "tabstops">): TabstopSpec[] {
	return expansion.tabstops.map((tabstop) => ({ ...tabstop, from: tabstop.from + expansion.from, to: tabstop.to + expansion.from }));
}
