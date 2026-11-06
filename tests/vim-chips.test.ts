/** The rules that keep a file path chip whole under vim. The engine sees only
 *  the source string, so these decide what its edits may do to a chip. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chipSpans, clipCaret, guardChipEdit, settleCaret } from "../components/vim-chips.ts";

const CHIP = "`/home/u/Notes.pdf`";
const value = `say ${CHIP} done`;
const start = value.indexOf(CHIP), end = start + CHIP.length;

function apply(text: string, edit: { from: number; to: number; text: string } | null) {
	assert.ok(edit);
	return text.slice(0, edit.from) + edit.text + text.slice(edit.to);
}

describe("chipSpans", () => {
	it("finds each path in a draft", () => {
		assert.deepEqual(chipSpans(value), [{ start, end }]);
		assert.deepEqual(chipSpans(`${CHIP} ${CHIP}`), [{ start: 0, end: CHIP.length }, { start: CHIP.length + 1, end: CHIP.length * 2 + 1 }]);
		assert.deepEqual(chipSpans("no paths here"), []);
	});
});

describe("guardChipEdit", () => {
	it("leaves an edit that misses every chip alone", () => {
		assert.deepEqual(guardChipEdit(value, 0, 3, "SAY"), { from: 0, to: 3, text: "SAY" });
		assert.deepEqual(guardChipEdit(value, end, end + 1, ""), { from: end, to: end + 1, text: "" });
	});
	it("takes the whole chip when a delete touches any of it", () => {
		assert.equal(apply(value, guardChipEdit(value, start + 3, start + 5, "")), "say  done");
		assert.equal(apply(value, guardChipEdit(value, start, start + 1, "")), "say  done");
		assert.equal(apply(value, guardChipEdit(value, start - 2, start + 1, "")), "sa done");
	});
	it("takes both chips when a delete crosses them", () => {
		const two = `${CHIP} and ${CHIP}`;
		const second = two.lastIndexOf(CHIP);
		assert.equal(apply(two, guardChipEdit(two, 3, second + 2, "")), "");
	});
	it("moves text put down inside a chip to just after it", () => {
		assert.deepEqual(guardChipEdit(value, start + 4, start + 4, "x"), { from: end, to: end, text: "x" });
	});
	it("lets text go right up against a chip", () => {
		assert.deepEqual(guardChipEdit(value, start, start, "x"), { from: start, to: start, text: "x" });
		assert.deepEqual(guardChipEdit(value, end, end, "x"), { from: end, to: end, text: "x" });
	});
	for (const [name, rewrite, expected] of [
		["gU", (text: string) => text.toUpperCase(), `SAY ${CHIP} DONE`],
		["gu", (text: string) => text.toLowerCase(), `say ${CHIP} done`],
		["g~", (text: string) => text.replace(/[a-z]/g, (c) => c.toUpperCase()), `SAY ${CHIP} DONE`],
	] as const) {
		it(`${name} goes around a chip, whose path stays as it was`, () => {
			assert.equal(apply(value, guardChipEdit(value, 0, value.length, rewrite(value))), expected);
		});
	}
	it("recognises a real case swap", () => {
		const mixed = `aB ${CHIP} cD`;
		const swapped = Array.from(mixed, (c) => (c >= "A" && c <= "Z" ? c.toLowerCase() : c.toUpperCase())).join("");
		assert.equal(apply(mixed, guardChipEdit(mixed, 0, mixed.length, swapped)), `Ab ${CHIP} Cd`);
	});
	it("g? goes around a chip", () => {
		const text = `ab ${CHIP} cd`;
		const rotated = text.replace(/[a-z]/gi, (c) => String.fromCharCode(((c.charCodeAt(0) - (c <= "Z" ? 65 : 97) + 13) % 26) + (c <= "Z" ? 65 : 97)));
		assert.equal(apply(text, guardChipEdit(text, 0, text.length, rotated)), `no ${CHIP} pq`);
	});
	it("r goes around a chip and keeps line ends", () => {
		const text = `ab\n${CHIP}\ncd`;
		assert.equal(apply(text, guardChipEdit(text, 0, text.length, text.replace(/[^\n]/g, "x"))), `xx\n${CHIP}\nxx`);
	});
	it("a rewrite wholly inside a chip changes nothing", () => {
		const edit = guardChipEdit(value, start + 2, start + 6, value.slice(start + 2, start + 6).toUpperCase());
		assert.equal(apply(value, edit), value);
	});
	it("a replacement that holds the whole chip goes through as it is", () => {
		assert.deepEqual(guardChipEdit(value, 0, value.length, "new"), { from: 0, to: value.length, text: "new" });
	});
	it("a replacement past a chip's edge takes the whole chip", () => {
		assert.equal(apply(value, guardChipEdit(value, start - 1, start + 2, "z")), "sayz done");
	});
	it("refuses a replacement strictly inside a chip", () => {
		assert.equal(guardChipEdit(value, start + 2, start + 4, "something else"), null);
	});
});

describe("settleCaret", () => {
	it("leaves a caret outside every chip where it is", () => {
		assert.equal(settleCaret(value, 2, 0, true), 2);
		assert.equal(settleCaret(value, start, 0, true), start);
	});
	it("goes past a chip moving forward and before it moving back", () => {
		assert.equal(settleCaret(value, start + 3, start, true), end);
		assert.equal(settleCaret(value, start + 3, end, true), start);
	});
	it("keeps a normal cursor on a chip that ends its line", () => {
		const text = `a ${CHIP}\nb`, at = text.indexOf(CHIP);
		assert.equal(settleCaret(text, at + 3, at, true), at);
		assert.equal(settleCaret(text, at + 3, at, false), at + CHIP.length);
		const last = `a ${CHIP}`;
		assert.equal(settleCaret(last, at + 3, at, true), at);
	});
	it("does not stop inside a surrogate pair", () => {
		const text = "a🙂b";
		assert.equal(settleCaret(text, 2, 1, false), 3);
		assert.equal(settleCaret(text, 2, 3, false), 1);
	});
});

describe("clipCaret", () => {
	it("pulls a normal cursor off a line's end", () => {
		assert.equal(clipCaret("abc", 3), 2);
		assert.equal(clipCaret("abc\ndef", 3), 2);
	});
	it("leaves a cursor on a character or an empty line", () => {
		assert.equal(clipCaret("abc", 1), 1);
		assert.equal(clipCaret("", 0), 0);
		assert.equal(clipCaret("a\n\nb", 2), 2);
		assert.equal(clipCaret("a\n", 2), 2);
	});
	it("lands on a whole chip or a whole emoji", () => {
		const text = `x ${CHIP}`;
		assert.equal(clipCaret(text, text.length), 2);
		assert.equal(clipCaret("a🙂", 3), 1);
	});
});
