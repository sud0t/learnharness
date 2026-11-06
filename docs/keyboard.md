# Keyboard shortcuts

**Mod** means ⌘ on macOS and Ctrl on Windows/Linux; the dispatcher accepts
either modifier on every platform. Press **?** outside a text field for the
in-app cheat sheet. See [Getting started](getting-started.md) for setup.

## Default key map

| Action | Binding |
|---|---|
| Toggle dictation | Mod+D |
| Open settings | Mod+, |
| Model selector | Mod+K |
| Cycle thinking level | Shift+Tab |
| Toggle sessions sidebar | Mod+B |
| Search sessions | Mod+Shift+F |
| Graph view | Mod+G |
| New session | Mod+N |
| Rename current session | F2 |
| Toggle all your thinking in the session | Mod+T |
| Find in session / search graph or chains view | Mod+F |
| Shortcut cheat sheet | ? |

Surface-specific actions require their surface to be mounted. Bare shortcuts
such as **?** and **F2** do not fire while typing; modifier shortcuts still do.

**Settings → Keyboard** displays the registry and offers Rebind, per-action
Reset, and Reset all controls. Overrides are stored on this device in
localStorage (`lh:keymap`), not in the learning-data settings file. Contextual
question keys are shown as **Fixed — part of this screen**, not rebindable.
Tab and Esc also have dedicated handling outside ordinary registry dispatch.

## Keyboard layouts

Shortcut matching and Settings rebinding use the same normalization. With
**Ctrl, ⌘, or Alt/Option** held, a single non-ASCII character falls back to its
physical **A–Z or comma** key position when the event supplies that code. For
example, Russian Ctrl+`л` at `KeyK` matches **Mod+K**, and ⌘+`б` at `Comma`
matches **Mod+,**. This also covers non-ASCII characters produced by Alt/Option,
such as Option+K reporting `˚` at `KeyK` and normalizing to `alt+k`.

ASCII characters still follow the reported character, not the physical position:
an AZERTY event reporting `q` at `KeyA` stays `mod+q`. Bare typing is unchanged.
Other physical codes and named keys (including dead keys) keep their existing
handling; this is not a guarantee for every OS/IME or layout-specific key.

## Focus and Esc

- **Tab** does not use the browser's normal focus traversal. On composer-bearing
  pages it cycles the live text fields forward, wrapping to the first. In a
  session the order is reading-thinking → active dock fields → composer,
  including only fields currently mounted. From elsewhere it enters the first
  field. The expanded select-question dock has its own rows↔thinking cycle below.
- **Shift+Tab** cycles the model's thinking level, including while typing; it is
  not backward focus traversal. Connection dialogs can own their own Tab trap.
  [LaTeX snippets](#latex-snippets) take both keys in math and between stops.
- **Esc** acts on the active field or topmost surfaced layer first: for example,
  leave a field, dismiss a menu/dialog, or close Find. Handlers claim the event
  so one Esc does not also act on lower layers. With no layer claiming it, the
  fallback closes the cheat sheet or cancels dictation (discarding its pending
  transcript) before reaching the chat's confirmation to dismiss a pending
  question/problem or abort a running turn. Confirmed turn abort signals the
  server, including for background turns; it also detaches any local stream.

To keep dictated text, stop dictation with **Mod+D** / Stop rather than the
fallback Esc cancellation.

## Enter and submission

- In the **chat composer**, **question answer/thinking fields**, and **practice
  thinking field**, **Enter submits**; **Shift+Enter** inserts a newline;
  **Mod+Enter** also submits. A question still needs an answer, and practice
  needs nonempty thinking. Submission is disabled during compaction.
- The composer's action follows its state: send text (or steer a running turn),
  Stop when busy with no sendable text, or **Next problem** when empty in the
  practice pause.
- Plain **Enter outside a typing surface** also submits the active question or
  practice response when valid, or advances from the practice pause. A
  pointer-clicked transcript button does not steal this submit. Keyboard-focused
  buttons and buttons in open menus/dialogs retain native Enter activation.
- When a pending check is closed, **Enter** opens it rather than submitting a
  hidden answer. In **Thinking while reading**, Enter / Mod+Enter opens that
  waiting check; otherwise Enter makes a newline and Mod+Enter leaves the field.
- The single-line **Other…** answer submits on Enter, including Shift+Enter.
- With [LaTeX snippets](#latex-snippets) on, Enter in a `$$` block is a newline
  and Enter in a matrix adds a row, in every box above. Vim has
  [its own rules](#latex-snippets) for insert and normal mode.
- Search/menu fields own their Enter; Find navigation never submits an answer.

## Question dock

While a select question is expanded and active:

- **↑/↓** walk answer rows: options first, then **I don't know** (quiz) or
  **Other…** (ask). The walk stops at either end; it does not wrap.
- **Space** acts like clicking the walked row: toggles a multi-select option or
  picks a single-select option. Selecting Other focuses its input; Space on an
  already selected Other row deselects it without erasing its text.
- **←/→** adjust quiz confidence through its stops, except on **I don't know**.
- **Tab** toggles between the thinking field and walked (or first) answer row.
  Focus follows the arrow walk while in the rows. The confidence slider is not
  part of this cycle. **Shift+Tab** remains the thinking-level shortcut.
- Arrows and Space keep their text-editing meaning in typing fields; Alt/Ctrl/⌘
  combinations do not walk the dock. In Other, **Esc** leaves the input but
  keeps the answer selected.

Text-only questions have no answer-row machine; their answer field uses the
submission conventions above.

## Chains view

- **Mod+F** focuses the chains search while the view is open, rather than the
  graph search underneath it. **↓** from that field enters the first result;
  the other arrows retain their text-editing meaning there.
- **↑/↓** move between siblings in the current layer, skipping expanded
  descendants and stopping at either end without wrapping.
- **→** expands the highlighted row and enters its first child: folders →
  sources → chains → propositions. A leaf stays where it is.
- **←** returns to the parent and collapses that parent's contents. At the top
  level, it collapses the highlighted row if open.
- **Space** toggles the highlighted row's checkbox, where available. Ordinary
  browsing selects whole sources/folders; practice's Pick nodes also offers
  chain/proposition checkboxes. Text inputs retain normal Space behavior.
- Clicking blank space below the tree clears row focus/highlighting, not checked
  items. Creating a folder clears any search and focuses the new folder.
- The whole active row is highlighted and scrolled into view. This focus is
  separate from checkbox selection; navigation does not select graph nodes.
  Clicking a row establishes the navigation position. Rename inputs keep their
  normal text-editing arrow keys; foreground menus/dialogs take priority.

## Search and menus

- **Sessions search (Mod+Shift+F):** opens the sidebar if needed and focuses its
  search field. **↑/↓** walk the filtered sessions with wrap; **Enter** opens the
  walked row, or the first match if none was walked, then leaves the field.
  **Esc** leaves the field without clearing the query.
- **Model search menus:** focus stays in search. **↑/↓** walk filtered results
  without wrap; the first ↓ starts at the first result, the first ↑ at the last.
  **Enter** picks the walked result or the first result. Editing the query resets
  the walk. Menus without a search field instead move button focus with wrapping
  **↑/↓**, support **Home/End**, and use native **Enter** activation.
- **Find (Mod+F):** in the graph, focuses node search; with the chains view
  open, focuses that view's search instead. In a session, opens a
  literal, case-insensitive search of displayed session text, including offscreen
  scroll content but excluding hidden/collapsed content, draft fields, and embedded
  documents. **Enter / Shift+Enter** in the Find field move to the next/previous
  match with wrap. **Esc** closes Find, clears highlights, and restores prior
  focus. Reopening retains the query and reading position within that session;
  changing sessions resets Find. A foreground menu/dialog takes priority.

## LaTeX snippets

**Settings → Appearance → LaTeX snippets**, on by default, expands Latex Suite's
snippets as you type in every box you write in, except the one-line "Other" answer.
It needs **Math in your messages**, and does nothing with that off.

- A snippet fires as you type its last key, or on **Tab** if it says so. `mk` opens
  inline math and `dm` opens a block.
- Snippets for text, `mk` and `dm` among them, do not fire in code: not in a code
  span or a fence, whether closed or still open. Latex Suite counts inline code and
  an unclosed fence as text, and this is the one place these differ from it.
- **Tab** belongs to Latex Suite in math or while a stop is active. In order, it
  runs a Tab snippet, goes to the next stop, jumps a closing bracket in a matrix,
  adds a matrix cell, or tabs out: past the next closing bracket, or out of the
  equation from its end. With nothing to do in math it stays in the box.
- **Shift+Tab** goes back a stop while any is left. Otherwise both keys keep their
  usual meaning, including in the question dock.
- Stops are marked in color until you reach them. Typing in a stop that a snippet
  repeats fills in every copy, which are marked too.
- Moving outside all of a snippet's stops ends them, and so does reaching the last.
  Outside math a stop only keeps **Tab** while it has somewhere to go, and stops
  that have all landed on one spot, as in a box you have emptied, are over.
- **Backspace** between an empty `$$` or `${}{}$` pair removes both sides.
- **Undo** first gives back what you typed with the key that fired the snippet,
  then takes out that key.

With [vim](#vim-mode) on, these keys work in insert mode. Stops stay through **Esc**,
but **Tab** does nothing to them in normal mode. **Ctrl+Z** steps back through a
snippet as above and then undoes the rest of the session; **u** undoes the whole
session. **`.`**, counts and macros repeat the text a session ended up with.

In math, a few more keys do Latex Suite's work:

- **/** makes a fraction of what is before the caret, or of a selection. Exponents
  and `\pu` keep a plain `/`, and so does a `/` with nothing before it, which is
  how `//` still reaches its snippet.
- **)**, **]** and **}** step over the same bracket when it is next, rather than
  doubling it.
- Brackets grow `\left` and `\right` when a snippet puts a big operator or a
  fraction inside them, in the same undo step.
- With a selection, the visual snippets wrap it: **U**, **O**, **B**, **C**, **S**,
  **(**, **[** and **{**. A result with no stops stays selected, so wraps chain.

| Enter | Vim off | Vim insert | Vim normal |
| --- | --- | --- | --- |
| Outside math | Sends | New line | Sends |
| In a `$$` block | New line | New line | Sends |
| In a matrix in a `$$` block | Adds a row | Adds a row | Sends |
| Shift+Enter in a matrix | Leaves the row | Leaves the row | New line |

Inline math and math fences count as outside math here, and so does a `$$` partway
along a line with nothing to close it, which opens no block. Mod+Enter stays the
surface's own. Where a surface's Enter does something other than send, such as
**Thinking while reading**, "sends" means that.

With vim on, visual snippets run on a selection in insert mode only, and visual
mode keeps its own keys. **Ctrl+G** carries a selection from visual to insert
mode and back, block selections included, and goes to the app when there is no
selection to carry. **o** adds a ` \\` row on a line in a matrix, and is a plain
**o** elsewhere.

### Your own snippets

**Settings → Appearance → Your snippets** edits the whole set as JSON, starting
from the set that ships. **Save** applies it to every box at once and keeps it in
your settings file, and **Reset to defaults** takes it out again. A set the same as
the defaults is not stored, so a later update of them still reaches you.

The text is plain data, so a function or a regular expression literal is an error:

```json
{
  "variables": { "${GREEK}": "(?:alpha|beta)" },
  "snippets": [
    { "trigger": "ee", "replacement": "e^{ $0 }$1", "options": "mA", "description": "Exponential" },
    { "trigger": "(${GREEK})h", "replacement": "\\hat{\\[[0]]}", "options": "rmA" }
  ]
}
```

A snippet needs `trigger`, `replacement` and `options`, and may have `flags`,
`priority`, `description`, `triggerAfter`, `excludedEnvironments`, `excludedMacros`
and `includedMacros`. `options` takes Latex Suite's letters: `t` text, `m` math, `M`
block math, `n` inline math, `T` text inside math, `c` code blocks, `C` inline code,
`A` automatic, `r` regular expression, `v` visual and `w` word boundary. Any other
field is an error.

Anything wrong keeps **Save** from saving. The errors name the snippet and its
trigger, what you wrote stays in the box, and the boxes keep the last good set. A
set that was stored bad shows its errors when opened, and only its bad entries are
skipped while you type. **Saved** only shows once the settings file has the set. If
the write fails, you get **Not saved**, and what you wrote stays in the box.

A regular expression can run for longer than anyone would wait, and once it runs it
cannot be stopped. So one of yours that the app does not ship has to pass a check
before it runs in a box:

- The check runs apart from the page, where it can be ended. It times the regular
  expression on the longest text a trigger ever sees, built from the expression's
  own repeats, and fails one that does not finish or takes too long. It runs on
  **Save**, which refuses a trigger that fails, and on every set when the app loads.
- A trigger that has not passed yet, failed or could not be checked stays off, and
  the rest of the set works. Opening the editor names any that failed.
- A trigger that only fires in math does not run in prose, or anywhere else it could
  not fire. One that still takes over 100 ms on a key stays off until you reload.

This lowers the risk and does not end it. The check tries the shapes of text it can
work out from the pattern, so one that only goes bad on some other shape passes, such
as a bad repeat behind a backreference or a lookahead: `(b)\1(a+)+x` and
`(?=.*z)(a+)+x` both pass. Typed one key at a time, such a run gets slower by degrees
and the 100 ms rule turns it off. Long text arriving all at once gets no such warning,
so a paste followed by one key can freeze the box, with nothing able to stop it.

### Chemistry

`\ce` and `\pu` from mhchem render everywhere math does, as in `$\ce{2H2 + O2 -> 2H2O}$`
and `$\pu{123 kJ/mol}$`.

## Auto pairs

**Settings → Keyboard → Auto pair brackets** and **Auto pair Markdown**, both on by
default, close what you open in every box you write in, except the one-line "Other"
answer. Brackets covers **(**, **[**, **{**, **'** and **"**, and Markdown covers
**\***, **\_**, **\`** and fences. The rules are Obsidian's.

- **(**, **[** and **{** add their closer at the end of a line, or in front of white
  space or one of `) ] } ' " : ; >`. In front of a word they type alone.
- **'**, **"**, **\***, **\_** and **\`** add theirs only with white space or the edge
  of the text on both sides, so `don't`, `2*3` and `a_b` type as they are.
- With a selection, each of those wraps it and keeps it selected. So do **$**, **=**,
  **~** and **%**, which do nothing else, and work with either setting on. Over
  several lines, a bracket, quote, **\*** or **\_** replaces the selection with the
  pair, and the others still wrap.
- A closer steps over the one auto pairs put in, and only that one. Moving to
  another line forgets them all, as does **Enter**.
- **Backspace** in an empty pair removes both sides, whoever typed the closer, and
  **Undo** takes a pair or a wrap in one step.
- A third **\`** after two opens a fence on two lines, staying inside the quote or
  list item it started in.
- Typing a file path between backticks takes the closer back out as soon as the text
  reads as a path, so the backtick you type at its end makes the one chip.

In math, [snippets](#latex-snippets) go first, and pairs act only on what no snippet
takes. With vim on, pairs work in insert mode, and normal, visual and replace mode
keep their keys. A block insert pairs at every cursor or at none. **`.`**, counts and
macros repeat the text the session ended up with.

## Vim mode

**Settings → Keyboard → Vim mode** turns on vim keys in every box you write in
except the single-line **Other…** answer. It applies at once and is off by
default. With it off, nothing in this page changes.

Boxes start in normal mode, and go back to it after sending or when a dock comes
back. The cursor's shape shows the mode: a block in normal and visual, a line in
insert, an underscore in replace. Only the `:` and `/` prompt adds any text, and
only while it is open. A command that fails, and long output like `:registers`,
show in the same place.

- **Inside a box, vim wins.** A chord vim uses does not reach the app, and one it
  does not use still does, including anything you rebind. **Mod+D** does not start
  dictation from a box in any mode; the mic button still does.
- **A half-typed command** ends on a chord it cannot use. If vim uses that chord in
  the mode you are in, that is all that happens, so **Ctrl+A**, **Ctrl+X** and
  **Ctrl+V** after `d`, `r` or `g` do not select, cut or paste, and **Ctrl+C** does
  not copy. If vim has no use for it, it does what it does anywhere else.
- **Esc** returns to normal from insert, visual or a half-typed command and stops
  there, even while dictating. In normal mode with nothing pending, Esc does what
  it does everywhere else.
- **Enter** makes a new line in insert, in every box. In normal mode with nothing
  pending it does what Enter does in that box today, including Stop in an empty
  composer. A pending command keeps it (`r<CR>`, `f<CR>`), as does visual mode.
  **Alt+Enter** is the same as Enter, and **Ctrl+O** Enter is vim's. **Shift+Enter**
  stays a new line: in visual it replaces the selection, and it drops a pending
  command. **Mod+Enter** is the app's in every mode. **`:w`** sends, as Enter does,
  and never stops a turn.
- **Insert mode** also has **Ctrl+h/j/k/l** to move left, down, up and right, and
  **Ctrl+a** and **Ctrl+e** for the first non-blank and the end of the line.
  **Ctrl+W** deletes a word and **Ctrl+R** inserts a register. **Ctrl+V** pastes.
- **Normal mode:** **Ctrl+R** redoes, **Ctrl+A** / **Ctrl+X** change the number
  under the cursor, **Ctrl+V** starts visual block, and **Ctrl+W** does nothing.
  None of them reach the window. **Ctrl+Q** and **Ctrl+M** keep their app meaning.
- **`y`** stays in vim's registers. **`"+y`** and **`"+p`** use the system clipboard,
  and **`"*`** is the same register as **`"+`**.
- **`u`** and **Ctrl+Z** share one history, and undo a whole insert session.
- **File paths** are one unit. `x`, `d` and `y` take the whole chip. `gU`, `g~`, `:s`
  and any other rewrite go around it, and `/` does not match inside it. A visual
  block that starts inside a chip skips that line, as it does a line too short.
- **`@`** of the register being recorded plays nothing, and a macro that calls
  itself stops at the first motion that cannot move, or after 500 levels.
- **`@`** of a register that holds text, such as a yanked line, plays it as keys.
  What follows an insert command is typed, up to `<Esc>` or the end of the text, and
  the replay ends in normal mode, where vim itself would stay in insert. **`@@`**
  before any macro plays the unnamed register, as the engine does.
- **Visual block** and block insert show the source of every row they cover while
  they are out, as **v** does, and the rendered math comes back after. Every cursor
  of a block insert is marked, including one at the end of a line.
- **Space** does nothing outside insert mode, as with `unmap <Space>`.
- Motions step through hidden formatting symbols, which show as they are reached.

## Maintainer entry points

The [registry](../src/core/keyboard.ts) defines defaults/persistence; the
[window dispatcher](../components/keyboard-shortcuts.tsx) handles global actions.
Contextual behavior lives with its surface: question/practice docks, composer,
menus, Find, and [chains navigation](../components/chain-navigation.ts). Vim lives
in [its box host](../components/path-input-vim.ts), over
[an editor adapter](../components/vim-editor.ts) and
[the chip rules](../components/vim-chips.ts).
Snippets live in [their box host](../components/path-input-snippets.ts), over
[the rules, which know nothing of boxes](../src/core/latex-suite).
