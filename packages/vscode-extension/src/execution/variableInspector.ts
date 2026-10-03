/**
 * Python snippets for bounded, structured kernel inspection. They run as scratch executions
 * (store_history=False) inside a temporary function so they leave no names behind; results are
 * printed as JSON between sentinels and parsed on the Node side.
 */
export const SENTINEL_START = '<<QMD_JSON_START>>';
export const SENTINEL_END = '<<QMD_JSON_END>>';

const PRELUDE = `
import json as __qmd_json, sys as __qmd_sys, types as __qmd_types
def __qmd_emit(obj):
    __qmd_sys.stdout.write(${JSON.stringify(SENTINEL_START)} + __qmd_json.dumps(obj, default=str) + ${JSON.stringify(SENTINEL_END)} + "\\n")
    __qmd_sys.stdout.flush()
def __qmd_cap(s, n):
    s = str(s)
    return s if len(s) <= n else s[:n] + "..."
def __qmd_size(v):
    try:
        import numpy as __np
        if isinstance(v, __np.ndarray):
            return int(v.nbytes)
    except Exception:
        pass
    try:
        if hasattr(v, "memory_usage"):
            m = v.memory_usage(deep=True)
            return int(m.sum() if hasattr(m, "sum") else m)
    except Exception:
        pass
    try:
        return int(__qmd_sys.getsizeof(v))
    except Exception:
        return None
def __qmd_shape(v):
    s = getattr(v, "shape", None)
    if s is not None:
        try:
            return [int(x) for x in s]
        except Exception:
            return None
    try:
        return [len(v)]
    except Exception:
        return None
`;

const CLEANUP = `
for __n in ("__qmd_emit", "__qmd_cap", "__qmd_size", "__qmd_shape", "__qmd_json", "__qmd_sys", "__qmd_types", "__qmd_main"):
    globals().pop(__n, None)
globals().pop("__n", None)
`;

export function listVariablesCode(maxCount: number): string {
  const max = Math.max(1, Math.floor(maxCount));
  return `${PRELUDE}
def __qmd_main():
    out = []
    g = globals()
    skip = (__qmd_types.ModuleType, __qmd_types.FunctionType, __qmd_types.BuiltinFunctionType, type)
    for name, val in list(g.items()):
        if name.startswith("_") or name in ("In", "Out", "exit", "quit", "get_ipython", "open"):
            continue
        if isinstance(val, skip):
            continue
        try:
            t = type(val)
            tname = (t.__module__ + "." if t.__module__ not in ("builtins", "__main__") else "") + t.__name__
        except Exception:
            tname = "?"
        try:
            preview = __qmd_cap(repr(val).replace("\\n", " "), 120)
        except Exception as e:
            preview = "<repr failed: %s>" % e
        out.append({"name": name, "type": tname, "shape": __qmd_shape(val), "bytes": __qmd_size(val), "preview": preview})
        if len(out) >= ${max}:
            break
    __qmd_emit({"variables": out, "count": len(out), "truncated": len(out) >= ${max}})
__qmd_main()
${CLEANUP}`;
}

export function summarizeVariableCode(name: string, maxRows: number, maxChars: number): string {
  const rows = Math.max(1, Math.floor(maxRows));
  const chars = Math.max(200, Math.floor(maxChars));
  return `${PRELUDE}
def __qmd_main():
    name = ${JSON.stringify(name)}
    info = {"name": name}
    if name == "__last_error__":
        import traceback as __tb
        et, ev, tb = getattr(__qmd_sys, "last_type", None), getattr(__qmd_sys, "last_value", None), getattr(__qmd_sys, "last_traceback", None)
        if et is None:
            info["error"] = "no exception has been recorded in this kernel yet"
        else:
            info["type"] = et.__name__
            info["repr"] = __qmd_cap("".join(__tb.format_exception(et, ev, tb)), ${chars})
        __qmd_emit(info)
        return
    try:
        val = eval(name, globals())
    except Exception as e:
        info["error"] = "%s: %s" % (type(e).__name__, e)
        __qmd_emit(info)
        return
    t = type(val)
    info["type"] = (t.__module__ + "." if t.__module__ not in ("builtins", "__main__") else "") + t.__name__
    info["shape"] = __qmd_shape(val)
    info["bytes"] = __qmd_size(val)
    try:
        import pandas as __pd
    except Exception:
        __pd = None
    try:
        import numpy as __np
    except Exception:
        __np = None
    try:
        if __pd is not None and isinstance(val, __pd.DataFrame):
            info["columns"] = [str(c) for c in list(val.columns)[:200]]
            info["dtypes"] = {str(k): str(v) for k, v in list(val.dtypes.items())[:200]}
            info["head"] = __qmd_cap(val.head(${rows}).to_string(), ${chars})
            try:
                info["nulls"] = {str(k): int(v) for k, v in val.isna().sum().items() if int(v) > 0}
            except Exception:
                pass
            try:
                info["describe"] = __qmd_cap(val.describe().to_string(), ${chars})
            except Exception:
                pass
        elif __pd is not None and isinstance(val, __pd.Series):
            info["dtype"] = str(val.dtype)
            info["head"] = __qmd_cap(val.head(${rows}).to_string(), ${chars})
            try:
                info["describe"] = __qmd_cap(val.describe().to_string(), ${chars})
            except Exception:
                pass
        elif __np is not None and isinstance(val, __np.ndarray):
            info["dtype"] = str(val.dtype)
            if val.size and __np.issubdtype(val.dtype, __np.number):
                try:
                    info["min"] = float(__np.nanmin(val)); info["max"] = float(__np.nanmax(val)); info["mean"] = float(__np.nanmean(val))
                    info["nan_count"] = int(__np.isnan(val).sum()) if __np.issubdtype(val.dtype, __np.floating) else 0
                except Exception:
                    pass
            info["repr"] = __qmd_cap(repr(val), ${chars})
        elif isinstance(val, BaseException):
            import traceback as __tb
            info["repr"] = __qmd_cap("".join(__tb.format_exception(type(val), val, val.__traceback__)), ${chars})
        elif isinstance(val, dict):
            info["keys"] = [__qmd_cap(k, 80) for k in list(val.keys())[:${rows}]]
            info["repr"] = __qmd_cap(repr(val), ${chars})
        elif isinstance(val, (list, tuple, set)):
            info["length"] = len(val)
            info["repr"] = __qmd_cap(repr(val), ${chars})
        else:
            info["repr"] = __qmd_cap(repr(val), ${chars})
            doc = getattr(val, "__doc__", None)
            if isinstance(doc, str) and not isinstance(val, (int, float, str, bool)):
                info["doc"] = __qmd_cap(doc.strip().split("\\n")[0], 200)
    except Exception as e:
        info["error"] = "summary failed: %s: %s" % (type(e).__name__, e)
    __qmd_emit(info)
__qmd_main()
${CLEANUP}`;
}

export function extractJson(stdout: string): unknown | undefined {
  const start = stdout.lastIndexOf(SENTINEL_START);
  if (start < 0) return undefined;
  const end = stdout.indexOf(SENTINEL_END, start);
  if (end < 0) return undefined;
  try {
    return JSON.parse(stdout.slice(start + SENTINEL_START.length, end));
  } catch {
    return undefined;
  }
}
