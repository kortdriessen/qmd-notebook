#!/usr/bin/env python
"""
QMD Notebook kernel host.

A tiny, dependency-light helper that owns one Jupyter kernel through `jupyter_client` and
relays the Jupyter messaging protocol to the QMD Notebook VS Code extension as
newline-delimited JSON over stdio.

Ownership: this file runs inside the *selected kernel environment* (the same Python that
provides `ipykernel`, which always ships `jupyter_client`). It never imports anything from the
user's project and never touches the .qmd file.

Protocol (v1), one JSON object per line:
  → {"id": 1, "method": "hello"|"start"|"execute"|"interrupt"|"restart"|"shutdown"|
                      "input_reply"|"is_alive"|"kernel_info", "params": {...}}
  ← {"id": 1, "result": {...}}  |  {"id": 1, "error": {"code": int, "message": str}}
  ← {"event": "iopub", "requestId": str|null, "msg": {...}}
  ← {"event": "execute_done", "requestId": str, "reply": {...}}
  ← {"event": "stdin_request", "requestId": str, "prompt": str, "password": bool}
  ← {"event": "status", "state": "starting"|"idle"|"busy"|"restarting"|"dead"}
  ← {"event": "kernel_died"}
  ← {"event": "log", "level": str, "message": str}
"""
from __future__ import annotations

import base64
import json
import os
import queue
import sys
import tempfile
import threading
import time
import traceback
import uuid

PROTOCOL_VERSION = 1

_out_lock = threading.Lock()
_stdout = sys.stdout


def _emit(obj):
    line = json.dumps(obj, default=_json_default, ensure_ascii=False)
    with _out_lock:
        _stdout.write(line)
        _stdout.write("\n")
        _stdout.flush()


def _json_default(o):
    if isinstance(o, (bytes, bytearray, memoryview)):
        return {"__bytes_b64__": base64.b64encode(bytes(o)).decode("ascii")}
    try:
        return str(o)
    except Exception:  # pragma: no cover
        return repr(o)


def _log(level, message):
    _emit({"event": "log", "level": level, "message": message})


class HostError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class KernelHost:
    def __init__(self):
        self.km = None
        self.kc = None
        self.pending = {}  # msg_id -> {"requestId": str, "reply": bool, "idle": bool}
        self.shell_waiters = {}  # msg_id -> [Event, reply]
        self.pending_lock = threading.Lock()
        self.threads = []
        self.stop_event = threading.Event()
        self.state = "starting"
        self.current_stdin_request = None
        self._temp_dirs = []

    # ------------------------------------------------------------------ lifecycle
    def start(self, params):
        from jupyter_client import KernelManager
        from jupyter_client.kernelspec import KernelSpecManager

        kernel_name = params.get("kernelName")
        argv = params.get("argv")
        cwd = params.get("cwd") or os.getcwd()
        extra_env = params.get("env") or {}
        timeout = float(params.get("startupTimeout") or 60)

        env = dict(os.environ)
        env.update({str(k): str(v) for k, v in extra_env.items()})
        # Keep the kernel from inheriting our stdio expectations.
        env.setdefault("PYTHONUNBUFFERED", "1")

        if argv:
            tmp = tempfile.mkdtemp(prefix="qmd-kernelspec-")
            self._temp_dirs.append(tmp)
            spec_dir = os.path.join(tmp, "kernels", "qmd-python")
            os.makedirs(spec_dir)
            with open(os.path.join(spec_dir, "kernel.json"), "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "argv": argv,
                        "display_name": params.get("displayName") or "Python (QMD)",
                        "language": "python",
                        "metadata": {"qmd": True},
                    },
                    f,
                )
            ksm = KernelSpecManager()
            ksm.kernel_dirs = [os.path.join(tmp, "kernels")]
            km = KernelManager(kernel_name="qmd-python", kernel_spec_manager=ksm)
        elif kernel_name:
            km = KernelManager(kernel_name=kernel_name)
        else:
            raise HostError(-32602, "start requires kernelName or argv")

        km.start_kernel(cwd=cwd, env=env)
        kc = km.client()
        kc.start_channels()
        try:
            kc.wait_for_ready(timeout=timeout)
        except Exception as e:  # noqa: BLE001
            try:
                km.shutdown_kernel(now=True)
            except Exception:
                pass
            raise HostError(-32004, "Kernel failed to become ready: %s" % e)

        # Fetch kernel_info BEFORE the pump threads start: once they run they consume the shell
        # channel and a blocking kernel_info(reply=True) would race them (60 s stall).
        info = None
        try:
            info = kc.kernel_info(reply=True, timeout=min(timeout, 20))
            info = info.get("content", {})
        except Exception as e:  # noqa: BLE001
            _log("warn", "kernel_info failed: %s" % e)
        self.km = km
        self.kc = kc
        self.state = "idle"
        self._start_threads()
        _emit({"event": "status", "state": "idle"})
        return {
            "connectionFile": km.connection_file,
            "kernelInfo": info,
            "pid": getattr(getattr(km, "provisioner", None), "pid", None) or _kernel_pid(km),
        }

    def _start_threads(self):
        self.stop_event.clear()
        for name, target in (
            ("iopub", self._pump_iopub),
            ("shell", self._pump_shell),
            ("stdin", self._pump_stdin),
            ("watchdog", self._watchdog),
        ):
            t = threading.Thread(target=target, name="qmd-" + name, daemon=True)
            t.start()
            self.threads.append(t)

    def _stop_threads(self):
        self.stop_event.set()
        for t in self.threads:
            t.join(timeout=2)
        self.threads = []

    def restart(self, params):
        if not self.km:
            raise HostError(-32004, "Kernel not started")
        timeout = float(params.get("startupTimeout") or 60)
        self.state = "restarting"
        _emit({"event": "status", "state": "restarting"})
        self._fail_pending("Kernel restarted")
        self._stop_threads()
        try:
            self.kc.stop_channels()
        except Exception:
            pass
        self.km.restart_kernel(now=True)
        self.kc = self.km.client()
        self.kc.start_channels()
        try:
            self.kc.wait_for_ready(timeout=timeout)
        except Exception as e:  # noqa: BLE001
            self.state = "dead"
            _emit({"event": "status", "state": "dead"})
            raise HostError(-32004, "Kernel failed to restart: %s" % e)
        self.state = "idle"
        self._start_threads()
        _emit({"event": "status", "state": "idle"})
        return {"ok": True}

    def shutdown(self, params):
        self._fail_pending("Kernel shut down")
        self._stop_threads()
        if self.kc:
            try:
                self.kc.stop_channels()
            except Exception:
                pass
        if self.km:
            try:
                self.km.shutdown_kernel(now=True)
            except Exception as e:  # noqa: BLE001
                _log("warn", "shutdown_kernel failed: %s" % e)
            try:
                self.km.cleanup_resources()
            except Exception:
                pass
        self.state = "dead"
        _emit({"event": "status", "state": "dead"})
        return {"ok": True}

    def interrupt(self, params):
        if not self.km:
            raise HostError(-32004, "Kernel not started")
        self.km.interrupt_kernel()
        return {"ok": True}

    def is_alive(self, params):
        return {"alive": bool(self.km and self.km.is_alive())}

    def kernel_info(self, params):
        if not self.kc:
            raise HostError(-32004, "Kernel not started")
        # The shell pump owns the shell channel; register a waiter instead of a blocking read.
        msg_id = self.kc.kernel_info(reply=False)
        waiter = threading.Event()
        with self.pending_lock:
            self.shell_waiters[msg_id] = [waiter, None]
        if not waiter.wait(float(params.get("timeout") or 30)):
            with self.pending_lock:
                self.shell_waiters.pop(msg_id, None)
            raise HostError(-32005, "kernel_info timed out")
        with self.pending_lock:
            entry = self.shell_waiters.pop(msg_id)
        return (entry[1] or {}).get("content", {})

    # ------------------------------------------------------------------ execution
    def execute(self, params):
        if not self.kc:
            raise HostError(-32004, "Kernel not started")
        request_id = params.get("requestId") or str(uuid.uuid4())
        code = params.get("code", "")
        # Build the message ourselves so the pending entry exists BEFORE the request is sent;
        # otherwise a very fast execution could report idle/reply before we know its msg_id.
        content = {
            "code": code,
            "silent": bool(params.get("silent", False)),
            "store_history": bool(params.get("storeHistory", True)),
            "user_expressions": {},
            "allow_stdin": bool(params.get("allowStdin", True)),
            "stop_on_error": bool(params.get("stopOnError", True)),
        }
        msg = self.kc.session.msg("execute_request", content)
        msg_id = msg["header"]["msg_id"]
        with self.pending_lock:
            self.pending[msg_id] = {"requestId": request_id, "reply": None, "idle": False, "started": time.time()}
        self.kc.shell_channel.send(msg)
        return {"msgId": msg_id, "requestId": request_id}

    def input_reply(self, params):
        if not self.kc:
            raise HostError(-32004, "Kernel not started")
        self.kc.input(str(params.get("value", "")))
        self.current_stdin_request = None
        return {"ok": True}

    # ------------------------------------------------------------------ pumps
    def _pump_iopub(self):
        kc = self.kc
        while not self.stop_event.is_set():
            try:
                msg = kc.get_iopub_msg(timeout=0.2)
            except queue.Empty:
                continue
            except Exception as e:  # noqa: BLE001
                if self.stop_event.is_set():
                    return
                _log("warn", "iopub error: %s" % e)
                time.sleep(0.2)
                continue
            self._handle_iopub(msg)

    def _handle_iopub(self, msg):
        parent_id = (msg.get("parent_header") or {}).get("msg_id")
        msg_type = msg.get("msg_type") or msg.get("header", {}).get("msg_type")
        content = msg.get("content", {})
        request_id = None
        with self.pending_lock:
            entry = self.pending.get(parent_id)
            if entry:
                request_id = entry["requestId"]
        if msg_type == "status":
            state = content.get("execution_state")
            if state in ("idle", "busy"):
                self.state = state
                _emit({"event": "status", "state": state, "requestId": request_id})
            if state == "idle" and parent_id:
                self._mark(parent_id, idle=True)
            return
        out = {
            "event": "iopub",
            "requestId": request_id,
            "msg": {
                "msg_type": msg_type,
                "msg_id": msg.get("header", {}).get("msg_id"),
                "parent_msg_id": parent_id,
                "content": content,
                "metadata": msg.get("metadata", {}),
            },
        }
        bufs = msg.get("buffers")
        if bufs:
            out["msg"]["buffers"] = [base64.b64encode(bytes(b)).decode("ascii") for b in bufs]
        _emit(out)

    def _pump_shell(self):
        kc = self.kc
        while not self.stop_event.is_set():
            try:
                msg = kc.get_shell_msg(timeout=0.2)
            except queue.Empty:
                continue
            except Exception as e:  # noqa: BLE001
                if self.stop_event.is_set():
                    return
                _log("warn", "shell error: %s" % e)
                time.sleep(0.2)
                continue
            msg_type = msg.get("msg_type")
            parent_id = (msg.get("parent_header") or {}).get("msg_id")
            if msg_type == "execute_reply":
                self._mark(parent_id, reply=msg.get("content", {}))
            else:
                with self.pending_lock:
                    waiter = self.shell_waiters.get(parent_id)
                if waiter:
                    waiter[1] = msg
                    waiter[0].set()

    def _pump_stdin(self):
        kc = self.kc
        while not self.stop_event.is_set():
            try:
                msg = kc.get_stdin_msg(timeout=0.2)
            except queue.Empty:
                continue
            except Exception as e:  # noqa: BLE001
                if self.stop_event.is_set():
                    return
                _log("warn", "stdin error: %s" % e)
                time.sleep(0.2)
                continue
            if msg.get("msg_type") == "input_request":
                parent_id = (msg.get("parent_header") or {}).get("msg_id")
                with self.pending_lock:
                    entry = self.pending.get(parent_id)
                request_id = entry["requestId"] if entry else None
                content = msg.get("content", {})
                self.current_stdin_request = request_id
                _emit(
                    {
                        "event": "stdin_request",
                        "requestId": request_id,
                        "prompt": content.get("prompt", ""),
                        "password": bool(content.get("password", False)),
                    }
                )

    def _watchdog(self):
        while not self.stop_event.is_set():
            time.sleep(1.0)
            if self.stop_event.is_set():
                return
            try:
                alive = self.km.is_alive()
            except Exception:
                alive = False
            if not alive and self.state not in ("restarting", "dead"):
                self.state = "dead"
                _emit({"event": "status", "state": "dead"})
                _emit({"event": "kernel_died"})
                self._fail_pending("Kernel died")
                return

    def _mark(self, msg_id, reply=None, idle=None):
        done = None
        with self.pending_lock:
            entry = self.pending.get(msg_id)
            if not entry:
                return
            if reply is not None:
                entry["reply"] = reply
            if idle:
                entry["idle"] = True
            if entry["reply"] is not None and entry["idle"]:
                done = self.pending.pop(msg_id)
        if done:
            _emit({"event": "execute_done", "requestId": done["requestId"], "reply": done["reply"]})

    def _fail_pending(self, reason):
        with self.pending_lock:
            entries = list(self.pending.values())
            self.pending.clear()
        for e in entries:
            _emit(
                {
                    "event": "execute_done",
                    "requestId": e["requestId"],
                    "reply": {"status": "error", "ename": "KernelUnavailable", "evalue": reason, "traceback": []},
                }
            )


def _kernel_pid(km):
    try:
        return km.kernel.pid  # older jupyter_client
    except Exception:
        return None


def main():
    host = KernelHost()
    methods = {
        "hello": lambda p: {
            "protocolVersion": PROTOCOL_VERSION,
            "python": sys.version.split()[0],
            "executable": sys.executable,
            "jupyterClient": _version("jupyter_client"),
            "ipykernel": _version("ipykernel"),
            "pid": os.getpid(),
        },
        "start": host.start,
        "execute": host.execute,
        "interrupt": host.interrupt,
        "restart": host.restart,
        "shutdown": host.shutdown,
        "input_reply": host.input_reply,
        "is_alive": host.is_alive,
        "kernel_info": host.kernel_info,
    }
    _emit({"event": "ready", "protocolVersion": PROTOCOL_VERSION})
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except Exception as e:  # noqa: BLE001
            _emit({"id": None, "error": {"code": -32700, "message": "parse error: %s" % e}})
            continue
        rid = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}
        fn = methods.get(method)
        if fn is None:
            _emit({"id": rid, "error": {"code": -32601, "message": "unknown method %r" % method}})
            continue
        try:
            result = fn(params)
            _emit({"id": rid, "result": result})
        except HostError as e:
            _emit({"id": rid, "error": {"code": e.code, "message": e.message}})
        except Exception as e:  # noqa: BLE001
            _emit({"id": rid, "error": {"code": -32603, "message": "%s: %s" % (type(e).__name__, e), "data": traceback.format_exc()}})
        if method == "shutdown":
            break
    # stdin closed or shutdown: make sure the kernel does not outlive us
    try:
        if host.state != "dead":
            host.shutdown({})
    except Exception:
        pass


def _version(mod):
    try:
        m = __import__(mod)
        return getattr(m, "__version__", "?")
    except Exception:
        return None


if __name__ == "__main__":
    try:
        import jupyter_client  # noqa: F401
    except Exception as e:  # noqa: BLE001
        _emit({"event": "fatal", "code": "missing-jupyter-client", "message": "jupyter_client is not importable in %s: %s" % (sys.executable, e)})
        sys.exit(3)
    main()
