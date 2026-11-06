/** Stops as source offsets. Mapping follows CodeMirror's mapPos, and the rules follow
 *  Latex Suite 1.13.3's tabstop state. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandTabstops } from "../src/core/latex-suite/snippets.ts";
import { asCaret, mapCaret, tabstopGroups, Tabstops, textChange, type Caret, type TextRange } from "../src/core/latex-suite/tabstops.ts";

const caret = (offset: number): Caret => ({ anchor: offset, focus: offset });
function stops(replacement: string) {
	const { insert, tabstops: specs } = expandTabstops(replacement);
	const tabstops = new Tabstops();
	tabstops.add(tabstopGroups(specs, 0));
	return { tabstops, insert };
}
const ranges = (tabstops: Tabstops) => tabstops.groups.map((group) => group.ranges.map(({ from, to }) => [from, to]));
const texts = (value: string, list: TextRange[]) => list.map(({ from, to }) => value.slice(from, to));

describe("groups", () => {
	it("go by number, lowest first, so $0 comes first", () => {
		const { tabstops } = stops("$2 $0 $1");
		assert.deepEqual(ranges(tabstops), [[[1, 1]], [[2, 2]], [[0, 0]]]);
	});
	it("gather a repeated number", () => {
		const { tabstops, insert } = stops("${0:a} $1 ${0:a}");
		assert.equal(insert, "a  a");
		assert.deepEqual(ranges(tabstops), [[[0, 1], [3, 4]], [[2, 2]]]);
	});
});

describe("stops that land on each other", () => {
	it("are one stop, which is the last, which ends them", () => {
		const { tabstops } = stops("$1 $2 $0");
		tabstops.groups = tabstopGroups([{ index: [1], from: 0, to: 0 }, { index: [2], from: 0, to: 0 }, { index: [0], from: 0, to: 0 }], 0);
		tabstops.select(caret(0));
		assert.deepEqual(ranges(tabstops), []);
		assert.equal(tabstops.active, false);
	});
	it("have nowhere for Tab to go", () => {
		const { tabstops } = stops("$1 $0");
		tabstops.groups = tabstopGroups([{ index: [1], from: 0, to: 0 }, { index: [0], from: 0, to: 0 }], 0);
		tabstops.select(caret(0));
		assert.equal(tabstops.step(caret(0), false), null);
	});
	it("keep apart when any range differs", () => {
		const { tabstops } = stops("$1 $0");
		tabstops.groups = tabstopGroups([{ index: [1], from: 0, to: 0 }, { index: [0], from: 3, to: 3 }], 0);
		tabstops.select(caret(3));
		assert.equal(tabstops.groups.length, 2);
	});
});

describe("mapping", () => {
	const map = (range: [number, number], from: number, to: number, length: number) => {
		const tabstops = new Tabstops();
		tabstops.add([{ ranges: [{ from: range[0], to: range[1] }], color: 0, hidden: false }]);
		tabstops.map([{ from, to, length }]);
		return ranges(tabstops)[0]![0];
	};
	it("takes in text typed at either edge", () => {
		assert.deepEqual(map([2, 2], 2, 2, 1), [2, 3]);
		assert.deepEqual(map([2, 4], 2, 2, 1), [2, 5]);
		assert.deepEqual(map([2, 4], 4, 4, 1), [2, 5]);
	});
	it("moves with text before it and ignores text after it", () => {
		assert.deepEqual(map([2, 4], 0, 0, 3), [5, 7]);
		assert.deepEqual(map([2, 4], 5, 5, 3), [2, 4]);
	});
	it("takes in a replacement of itself", () => assert.deepEqual(map([2, 4], 2, 4, 1), [2, 3]));
	it("survives its text being deleted", () => {
		assert.deepEqual(map([2, 4], 2, 4, 0), [2, 2]);
		assert.deepEqual(map([3, 3], 1, 5, 0), [1, 1]);
	});
	it("maps a selection the same way, staying after an edit at it", () => {
		assert.deepEqual(mapCaret(caret(2), [{ from: 2, to: 2, length: 3 }]), caret(5));
		assert.deepEqual(mapCaret(caret(1), [{ from: 2, to: 2, length: 3 }]), caret(1));
	});
});

describe("telling an edit from a diff", () => {
	it("needs the caret to place a repeated letter", () => {
		assert.deepEqual(textChange("aa", "aaa"), { from: 2, to: 2, length: 1 });
		assert.deepEqual(textChange("aa", "aaa", caret(1), caret(2)), { from: 1, to: 1, length: 1 });
	});
	it("finds a replacement and a deletion", () => {
		assert.deepEqual(textChange("abcd", "aXd"), { from: 1, to: 3, length: 1 });
		assert.deepEqual(textChange("abcd", "ad"), { from: 1, to: 3, length: 0 });
	});
});

describe("the clearing rule", () => {
	it("ends the stops on leaving them all", () => {
		const { tabstops } = stops("{$0}{$1}$2");
		tabstops.select(caret(1));
		assert.equal(tabstops.active, true);
		tabstops.select(caret(0));
		assert.equal(tabstops.active, false);
	});
	it("ends them on reaching the last", () => {
		const { tabstops } = stops("{$0}{$1}$2");
		tabstops.select(caret(3));
		assert.equal(tabstops.active, true);
		assert.equal(tabstops.index, 1);
		tabstops.select(caret(5));
		assert.equal(tabstops.active, false);
	});
	it("ends a single stop at once", () => {
		const { tabstops } = stops("{$0}");
		tabstops.select(caret(1));
		assert.equal(tabstops.active, false);
	});
	it("hides the first group and only that one", () => {
		const { tabstops } = stops("{$0}{$1}{$2}$3");
		tabstops.select(caret(1));
		assert.deepEqual(tabstops.marks().length, 3);
		tabstops.select(caret(3));
		assert.deepEqual(tabstops.marks().length, 3);
		assert.equal(tabstops.groups[0]!.hidden, true);
	});
	it("takes the color back to the start", () => {
		const tabstops = new Tabstops();
		assert.deepEqual([tabstops.nextColor(), tabstops.nextColor(), tabstops.nextColor(), tabstops.nextColor()], [0, 1, 2, 0]);
		tabstops.clear();
		assert.equal(tabstops.nextColor(), 0);
	});
});

describe("Esc", () => {
	it("keeps stops through its step left, off an empty stop", () => {
		const { tabstops } = stops("{$0}{$1}$2");
		tabstops.select(caret(1));
		tabstops.hold(0);
		tabstops.select(caret(0));
		assert.equal(tabstops.active, true);
	});
	it("does not excuse the next move", () => {
		const { tabstops } = stops("  {$0}{$1}$2");
		tabstops.select(caret(3));
		tabstops.hold(2);
		tabstops.select(caret(2));
		tabstops.select(caret(1));
		assert.equal(tabstops.active, false);
	});
	it("lets the next move back in go on as before", () => {
		const { tabstops } = stops("{$0}{$1}$2");
		tabstops.select(caret(1));
		tabstops.hold(0);
		tabstops.select(caret(0));
		tabstops.select(caret(1));
		assert.equal(tabstops.active, true);
	});
});

describe("Tab", () => {
	it("selects a placeholder, and goes to the end of one it is in", () => {
		const { tabstops, insert } = stops("${0:ab} ${1:cd} $2");
		tabstops.select(asCaret({ from: 0, to: 2 }));
		assert.deepEqual(tabstops.step(asCaret({ from: 0, to: 2 }), false), [{ from: 3, to: 5 }]);
		assert.equal(insert.length, 6);
		assert.deepEqual(tabstops.step(caret(3), false), [{ from: 5, to: 5 }]);
	});
	it("goes back a stop", () => {
		const { tabstops } = stops("{$0}{$1}{$2}$3");
		tabstops.select(caret(3));
		assert.deepEqual(tabstops.step(caret(3), true), [{ from: 1, to: 1 }]);
	});
	it("has nowhere to go past the ends", () => {
		const { tabstops } = stops("{$0}{$1}$2");
		tabstops.select(caret(1));
		assert.equal(tabstops.step(caret(1), true), null);
	});
	it("skips a stop it would not move from", () => {
		const { tabstops } = stops("$0$1 $2");
		tabstops.select(caret(0));
		assert.deepEqual(tabstops.step(caret(0), false), [{ from: 1, to: 1 }]);
	});
});

describe("nesting", () => {
	it("puts a snippet's stops in place of the one it expanded in", () => {
		const { tabstops } = stops("{$0}{$1}$2");
		tabstops.select(caret(1));
		tabstops.map([{ from: 1, to: 1, length: 4 }]);
		tabstops.add(tabstopGroups(expandTabstops("[$0]$1").tabstops.map((spec) => ({ ...spec, from: spec.from + 1, to: spec.to + 1 })), 1));
		assert.deepEqual(ranges(tabstops), [[[2, 2]], [[3, 3]], [[7, 7]], [[8, 8]]]);
	});
});

describe("mirrors", () => {
	function outer() {
		const { tabstops, insert } = stops("${0:ab} ${0:ab} $1");
		tabstops.select(asCaret({ from: 0, to: 2 }));
		return { tabstops, value: insert };
	}
	it("copy the range the caret is in over the others", () => {
		const { tabstops, value } = outer();
		const typed = `x${value.slice(2)}`;
		const source = tabstops.linkedRange(asCaret({ from: 0, to: 2 }))!;
		const done = tabstops.mirror(typed, { from: 0, to: 2, length: 1 }, source)!;
		assert.equal(done.value, "x x ");
		assert.deepEqual(ranges(tabstops), [[[0, 1], [2, 3]], [[4, 4]]]);
	});
	it("copy from a later range to an earlier one", () => {
		const { tabstops, value } = outer();
		tabstops.select(asCaret({ from: 3, to: 5 }));
		const source = tabstops.linkedRange(asCaret({ from: 3, to: 5 }))!;
		const typed = `${value.slice(0, 3)}xyz${value.slice(5)}`;
		const done = tabstops.mirror(typed, { from: 3, to: 5, length: 3 }, source)!;
		assert.equal(done.value, "xyz xyz ");
		assert.deepEqual(ranges(tabstops), [[[0, 3], [4, 7]], [[8, 8]]]);
		assert.deepEqual(texts(done.value, [done.primary, ...done.copies]), ["xyz", "xyz"]);
		assert.deepEqual(mapCaret(caret(6), done.changes), caret(7));
	});
	it("take no part in an edit from outside the range", () => {
		const { tabstops } = outer();
		const source = tabstops.linkedRange(asCaret({ from: 0, to: 2 }))!;
		assert.equal(tabstops.mirror("whatever", { from: 5, to: 6, length: 0 }, source), null);
	});
	it("list the copies the caret is not in", () => {
		const { tabstops } = outer();
		assert.deepEqual(tabstops.mirrors(caret(1)), [{ from: 3, to: 5 }]);
		assert.deepEqual(tabstops.mirrors(caret(4)), [{ from: 0, to: 2 }]);
	});
	it("stay linked at the last group until the caret leaves, as upstream's cursors do", () => {
		const { tabstops } = stops("$0 ${1:a} ${1:a}");
		tabstops.select(caret(0));
		tabstops.select(asCaret({ from: 1, to: 2 }));
		assert.equal(tabstops.active, false);
		assert.ok(tabstops.linkedRange(asCaret({ from: 1, to: 2 })));
		assert.equal(tabstops.marks().length, 0);
		tabstops.select(caret(2));
		assert.ok(tabstops.linkedRange(caret(2)));
		tabstops.select(caret(0));
		assert.equal(tabstops.groups.length, 0);
	});
});

describe("edits from outside", () => {
	it("tell an edit inside a stop from one that only touches it", () => {
		const { tabstops } = stops("{${0:ab}} $1");
		assert.equal(tabstops.overlaps({ from: 1, to: 1, length: 1 }), false);
		assert.equal(tabstops.overlaps({ from: 3, to: 3, length: 1 }), false);
		assert.equal(tabstops.overlaps({ from: 2, to: 2, length: 1 }), true);
		assert.equal(tabstops.overlaps({ from: 0, to: 2, length: 1 }), true);
	});
});

describe("redo", () => {
	it("restores stops as they were frozen", () => {
		const groups = tabstopGroups(expandTabstops("{$0}{$1}$2").tabstops, 2);
		const tabstops = new Tabstops();
		tabstops.restore(groups);
		tabstops.select(caret(3));
		assert.equal(groups[0]!.hidden, false);
		assert.equal(tabstops.active, true);
	});
});
