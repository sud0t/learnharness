export { LatexReader, type Bounds, type LatexContext, type MathBounds, type ScopeEntry } from "./context.ts";
export { enlargedBrackets } from "./auto-enlarge.ts";
export { autoFraction } from "./autofraction.ts";
export { matrixBracketJump, matrixCell, matrixExit, matrixRow, matrixScope } from "./matrix.ts";
export { tabout, type Tabout } from "./tabout.ts";
export { compileSnippets, defaultSnippetData, defaultSnippets, expandTabstops, findExpansion, findVisual, parseSnippetSource, patternKey, snippetDataErrors, snippetSetFor, unvettedSnippets, type Expansion, type Insertion, type Snippet as LatexSnippet, type SnippetSet as LatexSnippetSet, type TabstopSpec, type TriggerPattern } from "./snippets.ts";
export { isSnippetData, snippetDataSource, type RawSnippet, type SnippetData, type SnippetVariables } from "./snippet-data.ts";
export { asCaret, mapCaret, mapGroups, placedTabstops, tabstopGroups, Tabstops, textChange, type Caret, type TabstopGroup, type TextChange, type TextRange } from "./tabstops.ts";
export { inMath, strictlyInMath, type MacroArea, type Mode as LatexMode } from "./options.ts";
