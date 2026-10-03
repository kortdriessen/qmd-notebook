# Select a kernel

Use VS Code's kernel picker in the notebook toolbar. QMD Notebook lists:

- Python environments known to the Python extension (venv, uv, conda, system);
- registered Jupyter kernelspecs;
- extra interpreters from `qmdNotebook.execution.pythonCandidates`.

The environment needs `ipykernel` (which brings `jupyter_client`). If it is missing you will be offered a one-line install.

A `jupyter: python3` hint in the YAML front matter pre-selects the matching kernelspec.
