# Open a `.qmd` as a notebook

Right-click any `.qmd` file → **Open With…** → **QMD Notebook**.

- Fenced `{python}` chunks become native Python code cells (Pylance works in them).
- Everything else (YAML front matter, Markdown, callouts, other engines) stays as Markdown cells.
- Saving writes plain Quarto Markdown back: no outputs, no IDs, byte-identical when you change nothing.
- **Edit in Source** (toolbar or `Ctrl+Alt+S`) opens the same file as text; **Reopen as Notebook** brings you back, kernel state intact.
