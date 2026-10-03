# QMD round-trip contract

This document is the authoritative description of how QMD Notebook maps a `.qmd` file to notebook
cells and back. The parser and emitter live in
`packages/vscode-extension/src/notebook/{parser,emitter,model}.ts` and are covered by
`test/unit/*.test.ts` (fixture corpus in `fixtures/qmd`, golden edit tests, and a 1000-case
property test).

## Invariant

```
serialize(parse(bytes)) === bytes
```

for every file, with no edits. Byte-for-byte: newline style (LF/CRLF, mixed), missing final
newline, BOM, fence characters and lengths, indentation, YAML formatting, all opaque Quarto syntax.
Outputs, execution counts, runtime IDs, request threads and any other session state never enter
the file.

## What becomes a code cell

Exactly what Quarto's own segmenter (`quarto-cli/src/core/lib/break-quarto-md.ts`) treats as an
executable cell, restricted to Python:

- a line matching `^\s*(`{3,})\s*\{python( *[ ,].*)?\}\s*$` — three or more backticks, any
  leading whitespace, `{python}` optionally followed by knitr-style attributes
  (`{python, echo=false}`, `{python label="x"}`);
- closed by the first later line consisting of exactly the same number of backticks
  (`^\s*(`+)\s*$`).

Everything else stays opaque Markdown: tilde fences (Quarto never executes them), plain
```` ```python ```` fences, `{.python}` class fences, `{{python}}` literals, `{r}`, `{julia}`,
`{bash}`, `{ojs}`, `{mermaid}`, `{dot}`, `{=html}`/`{=latex}` raw blocks, callouts, divs, math,
citations, shortcodes, tables, HTML comments.

Protective fences follow CommonMark so a `{python}` line inside a longer outer fence (four
backticks, or a tilde fence) is documentation, not code. YAML front matter (`---` on line 1 until
the next `---`/`...`) is opaque, so example fences inside YAML strings are not cells.

Deliberate divergences from Quarto, always in the *safer* direction (fewer executable cells):

| Construct | Quarto | QMD Notebook |
| --- | --- | --- |
| ```` ```{python} ```` inside a `~~~` fence | executes (tildes are not fences to Quarto) | Markdown |
| ```` ```{python} ```` opener without matching closer | remainder is one cell | Markdown + diagnostic |

The unmatched-opener case shows a warning diagnostic on the Markdown cell and the cell can still
be converted or edited in source.

## Byte ownership

Every byte has exactly one owner:

| Owner | Bytes |
| --- | --- |
| `document.leading` | whitespace-only lines before the first content line (and a BOM) |
| Markdown segment `text` | first content line … last content line, without the last EOL |
| Markdown segment `trailing` | that EOL plus following whitespace-only lines |
| Python segment | `opener` + `openerEol` + body + `closer` + `trailing` |
| Python `source` | body without the EOL of its last line (this is the editable cell text) |
| Python `bodyEol` | the EOL of the last body line (`''` for an empty body) |
| Python `trailing` | closer EOL plus following whitespace-only lines |

Consequences:

- Whitespace-only regions between two code cells never become empty Markdown cells; they are
  trailing trivia of the preceding cell.
- Deleting a cell removes exactly its segment and the separator whitespace it owns.
- Moving a cell moves its fence and its trailing whitespace.

Each cell keeps its parse record in cell metadata (`metadata.qmd`; the serializer consumes it
and never writes it to the file):
runtime `id`, original `kind`, `origSource`, `origBody` (exact original bytes), `opener`,
`openerEol`, `closer`, `bodyEol`, `trailing`, `wasLast`, `origLines`, parsed `#|` options.
Cells created in-session carry `{ fresh: true }` records so they are emitted as new segments.

### UTF-8 BOM

A leading byte-order mark is stored in `document.leading`, never in a cell: VS Code text models
strip a BOM from cell content, so keeping it as document trivia is what makes the round trip
byte-exact (verified in the integration suite).

## Emission rules

For each cell in the current order:

1. **Unchanged cell** (`normalizeEol(source) === normalizeEol(origSource)` and same kind): emit the
   original bytes verbatim (`origBody`), so EOL normalisation inside VS Code text models cannot
   change the file.
2. **Edited Python body**: `opener + openerEol + source(with document EOL) + bodyEol + closer`.
3. **Edited Markdown**: the text with the document EOL.
4. **New Python cell**: the document's predominant fence (`fenceLength` = mode of existing python
   fences, default 3) around the source: ```` ```{python} ```` … ```` ``` ````. Non-Python code
   cells emit their language id (`{r}`, `{bash}` for shellscript).
5. **New Markdown cell**: its literal text.
6. **Converted cell** (kind differs from the record): the content re-wrapped for the new kind; the
   segment's trailing whitespace is retained.

Separators:

- A non-last segment always ends with an EOL (added only if it was the original last segment and
  lacked one).
- Around a new/converted cell, or a cell displaced from the end, one blank line is ensured
  (`trailing` gets a second EOL) — never removed.
- The last segment keeps its original trailing bytes if it was originally last; otherwise it ends
  with a single EOL when the file originally ended with one, or nothing if it did not.
- Extra blank lines are preserved rather than collapsed.

## Source maps

`emitQmd` also returns the 0-based line span of each cell's editable region and of the full
segment. **Edit in Source** uses this (after saving) to place the cursor; the bridge exposes it as
1-based `sourceLines` in `read_notebook`.

## `#|` cell options

Option comments are part of the editable source (they are valid Python). They are parsed only for
hints: `eval: false` (Run skips the cell; **Force Run Cell** overrides), `label`, and any other
`key: value` pairs are surfaced to agents as `options`. Only the leading block of `#|` lines is
parsed, matching Quarto.
