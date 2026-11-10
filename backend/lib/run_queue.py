"""First-come-first-served queue for AI runs, with status the viewer can poll.

One GPU, many users: runs take turns instead of competing for GPU memory
(two at once would each take twice as long anyway, and the loaded models are
shared, not safe to run twice in parallel). MyApp.infer (main.py) wraps every
run in `turn(run_id)`; the viewer sends a random run_id with each request and
polls GET /run-status/<run_id> (served by lib/user_context.py) to show
"Queued (N ahead)" or "Running 45%".

Progress comes from the models' own tqdm bars (nnU-Net's sliding-window tiles,
SAM2's slice propagation): tqdm is patched once so any bar updated on a run's
thread reports to that run.
"""

import threading
import uuid
from contextlib import contextmanager

_cond = threading.Condition()
_queue = []  # run ids in arrival order; _queue[0] is the one running
_progress = {}  # run id -> {"done": n, "total": m} of its latest progress bar
_local = threading.local()  # .run_id of the run executing on this thread


def _install_tqdm_hook():
    from tqdm import std

    if getattr(std.tqdm, "_ild_hooked", False):
        return

    def record(bar):
        run_id = getattr(_local, "run_id", None)
        # total > 1 skips one-step bars like nnU-Net's "Collecting results 1/1".
        if run_id and bar.total and bar.total > 1:
            _progress[run_id] = {"done": int(min(bar.n, bar.total)), "total": int(bar.total)}

    orig_update, orig_close = std.tqdm.update, std.tqdm.close

    def update(self, n=1):
        r = orig_update(self, n)
        record(self)
        return r

    def close(self):
        # Iterating a bar (for x in tqdm(...)) reports its last steps only here.
        record(self)
        return orig_close(self)

    std.tqdm.update, std.tqdm.close = update, close
    std.tqdm._ild_hooked = True


_install_tqdm_hook()


@contextmanager
def turn(run_id=None):
    run_id = str(run_id or uuid.uuid4())
    with _cond:
        _queue.append(run_id)
        while _queue[0] != run_id:
            _cond.wait()
    _local.run_id = run_id
    try:
        yield
    finally:
        _local.run_id = None
        with _cond:
            _queue.remove(run_id)
            _progress.pop(run_id, None)
            _cond.notify_all()


def status(run_id):
    """{"state": "queued", "ahead": N} | {"state": "running", "progress": {...}?} | {"state": "unknown"}.

    "unknown" = not started yet (request still arriving) or already finished.
    "progress" is absent while the run prepares (no progress bar yet).
    """
    with _cond:
        if run_id not in _queue:
            return {"state": "unknown"}
        i = _queue.index(run_id)
        if i:
            return {"state": "queued", "ahead": i}
        p = _progress.get(run_id)
        return {"state": "running", "progress": dict(p)} if p else {"state": "running"}
