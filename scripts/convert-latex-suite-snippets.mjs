#!/usr/bin/env node
/**
 * One-off: turns a Latex Suite 1.13.3 setup into the plain data this app ships.
 * Reads source as a syntax tree and never runs it: no eval, no import, no Function.
 *
 *   node scripts/convert-latex-suite-snippets.mjs <data.json> <latex-suite source folder>
 *
 * <data.json> is the plugin's settings file, whose `snippets` is JavaScript source.
 * The folder is the 1.13.3 tag, for its variables, macro list and symbol names.
 *
 * Writes, under src/core/latex-suite:
 *   snippets.json               the snippets and their variables
 *   macros.json                 every macro name, for the guard rule
 *   grammar/latex_symbols.json  the names the grammar's tokenizer tells apart
 *
 * Then regenerate the parser with the pinned generator when the grammar changes:
 *   npx lezer-generator src/core/latex-suite/grammar/latex.grammar -o src/core/latex-suite/grammar/latex-parser
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const [dataFile, upstream] = process.argv.slice(2);
if (!dataFile || !upstream) throw new Error("usage: convert-latex-suite-snippets.mjs <data.json> <latex-suite source folder>");
const target = join(dirname(fileURLToPath(import.meta.url)), "../src/core/latex-suite");

/** The one marker that says a snippet may only fire at a word boundary. */
const WORD_BOUNDARY = "w";

const parse = (text, name = "source.ts") => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const stripped = (node) => (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ? stripped(node.expression) : node);

/** A regex literal's own text is what `.source` gives, and how it was escaped is kept. */
function regexLiteral(node) {
	const text = node.getText();
	const end = text.lastIndexOf("/");
	return { source: text.slice(1, end), flags: text.slice(end + 1) };
}

function literal(node) {
	node = stripped(node);
	if (ts.isStringLiteralLike(node)) return node.text;
	if (ts.isNumericLiteral(node)) return Number(node.text);
	if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) return -literal(node.operand);
	if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
	throw new Error(`Not plain data: ${node.getText()}`);
}

/** A trigger as data, or the name of what makes it code. */
function triggerOf(node) {
	node = stripped(node);
	if (ts.isRegularExpressionLiteral(node)) return { regex: regexLiteral(node) };
	if (ts.isStringLiteralLike(node)) return { text: node.text };
	if (ts.isNewExpression(node) && ts.isClassExpression(stripped(node.expression))) return { subclass: node.getText() };
	throw new Error(`Unknown trigger: ${node.getText()}`);
}

function rawSnippets(source) {
	const file = parse(source);
	const exported = file.statements.find(ts.isExportAssignment);
	if (!exported || !ts.isArrayLiteralExpression(exported.expression)) throw new Error("Expected `export default [...]`");
	return exported.expression.elements.map((element) => {
		if (!ts.isObjectLiteralExpression(element)) throw new Error(`Not a snippet: ${element.getText()}`);
		const raw = {};
		for (const property of element.properties) {
			if (!ts.isPropertyAssignment(property)) throw new Error(`Not plain data: ${property.getText()}`);
			const key = property.name.getText();
			if (key === "trigger") raw.trigger = triggerOf(property.initializer);
			else if (key === "replacement") {
				const value = stripped(property.initializer);
				if (ts.isStringLiteralLike(value)) raw.replacement = value.text;
				else if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) raw.code = value.getText();
				else throw new Error(`Unknown replacement: ${value.getText()}`);
			} else raw[key] = literal(property.initializer);
		}
		return raw;
	});
}

function entry(raw) {
	const out = {};
	const regex = raw.trigger.regex;
	out.trigger = regex ? regex.source : raw.trigger.text;
	out.replacement = raw.replacement;
	// A literal is a regex with no `r`. In data, `r` alone says so.
	out.options = regex && !raw.options.includes("r") ? `r${raw.options}` : raw.options;
	if (regex?.flags) out.flags = regex.flags;
	for (const key of ["priority", "excludedMacros", "description"]) if (raw[key] !== undefined) out[key] = raw[key];
	return out;
}

const textOf = (raw) => raw.trigger.regex?.source ?? raw.trigger.text;
const isList = (raw) => raw.trigger.regex?.source.includes("(?<marker>");
const isSubscript = (raw) => textOf(raw) === String.raw`(\\?)([A-Za-z]+)(\d)`;
const isMacroGuard = (raw) => textOf(raw) === String.raw`\\[A-Za-z]{2,}`;
const isIdentity = (raw) => textOf(raw) === String.raw`iden(\d)`;

/** What each snippet that carries code becomes. Anything else with code is refused. */
function convert(raw, report) {
	if (raw.trigger.subclass) {
		// Only a workaround for iOS without lookbehind, which Chromium has.
		report.converted.push("empty-line dm");
		return [{
			trigger: String.raw`(?<=\n|^)([ \t]*(?:> ?)*[ \t]*)dm`,
			replacement: raw.replacement,
			options: `r${raw.options}`,
			priority: raw.priority,
			description: raw.description,
		}];
	}
	if (raw.code === undefined) return [entry(raw)];
	if (isSubscript(raw)) {
		report.converted.push("auto subscript");
		const common = { options: "rmA", excludedMacros: raw.excludedMacros };
		return [
			{ ...common, trigger: String.raw`\\(${"${GREEK}"})(\d)`, replacement: "\\[[0]]_{[[1]]}", priority: -1, description: "Auto subscript for greek letters" },
			{ ...common, trigger: String.raw`\\([A-Za-z]+)(\d)`, replacement: "\\[[0]] [[1]]", priority: -2, description: "Add a space after other macros before a digit" },
			{ ...common, trigger: String.raw`([A-Za-z]+)(\d)`, replacement: "[[0]]_{[[1]]}", priority: -3, description: "Auto subscript for variables" },
		];
	}
	if (isIdentity(raw)) {
		report.converted.push("iden");
		return Array.from({ length: 10 }, (_, size) => {
			const rows = Array.from({ length: size }, (_row, j) => Array.from({ length: size }, (_cell, i) => (i === j ? 1 : 0)).join(" & "));
			return { trigger: `iden${size}`, replacement: `\\begin{pmatrix}\n${rows.join(" \\\\\n")}\n\\end{pmatrix}`, options: "mA", description: raw.description };
		});
	}
	throw new Error(`Code with no conversion: ${textOf(raw)}`);
}

function convertAll(source) {
	const report = { input: 0, dropped: [], native: [], converted: [] };
	const snippets = [];
	for (const raw of rawSnippets(source)) {
		report.input++;
		if (raw.trigger.text === "chk" || raw.trigger.text === "prob" || isList(raw) || (raw.trigger.text === "K" && raw.options.includes("v"))) {
			report.dropped.push(isList(raw) ? "list-indented dm" : raw.trigger.text);
			continue;
		}
		if (isMacroGuard(raw)) {
			report.native.push(raw.description);
			continue;
		}
		for (const converted of convert(raw, report)) {
			// Never mid-word in prose. Inside \text it stays as the user has it.
			if (converted.trigger === "mk" && converted.options === "tA") converted.options += WORD_BOUNDARY;
			snippets.push(converted);
		}
	}
	return { report, snippets };
}

function objectKeys(file, name) {
	let found;
	const visit = (node) => {
		if (ts.isVariableDeclaration(node) && node.name.getText() === name) found = node.initializer;
		else ts.forEachChild(node, visit);
	};
	visit(file);
	if (!found || !ts.isObjectLiteralExpression(found)) throw new Error(`No object ${name}`);
	return found.properties.flatMap((property) => {
		const key = ts.isStringLiteralLike(property.name) ? property.name.text : property.name.getText();
		// `cmd_symbols[x] || greek[x]`: an empty value does not count.
		return ts.isStringLiteralLike(property.initializer) && !property.initializer.text ? [] : [key];
	});
}

function exportedArray(file, name) {
	let found;
	const visit = (node) => {
		if (ts.isVariableDeclaration(node) && node.name.getText() === name) found = node.initializer;
		else ts.forEachChild(node, visit);
	};
	visit(file);
	if (!found || !ts.isArrayLiteralExpression(found)) throw new Error(`No array ${name}`);
	return found.elements.map(literal);
}

function defaultVariables(source) {
	const file = parse(source);
	const exported = file.statements.find(ts.isExportAssignment);
	if (!exported || !ts.isObjectLiteralExpression(exported.expression)) throw new Error("Expected `export default {...}`");
	return Object.fromEntries(exported.expression.properties.map((property) => [literal(property.name), literal(property.initializer)]));
}

const read = (path) => readFileSync(join(upstream, path), "utf8");
const settings = JSON.parse(readFileSync(dataFile, "utf8"));
const { report, snippets } = convertAll(settings.snippets);
const variables = defaultVariables(read("src/default_snippet_variables.js"));
const macros = exportedArray(parse(read("src/snippets/luasnip_api/macros.ts")), "ALL_MACROS");
const concealMaps = parse(read("src/editor_extensions/conceal_maps.ts"));
const symbols = [...new Set([...objectKeys(concealMaps, "cmd_symbols"), ...objectKeys(concealMaps, "greek")])].sort();

const save = (path, value) => writeFileSync(join(target, path), `${JSON.stringify(value, null, "\t")}\n`);
save("snippets.json", { variables, snippets });
save("macros.json", macros);
save("grammar/latex_symbols.json", symbols);
console.log(JSON.stringify({ ...report, output: snippets.length, macros: macros.length, symbols: symbols.length }, null, 2));
