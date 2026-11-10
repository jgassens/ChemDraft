"""Read a protocol-2 recognition reply without requiring the model or chemistry libraries."""

import time


def read_result(read, request_id, timeout):
    """Consume progress, then return the matching flat result/error within one timeout.

    `read(remaining_seconds)` reads one JSON object. Progress is not a failed recognition, and
    protocol errors must never count as the clean failure allowed by exactLowOrFailed.
    """
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise SystemExit("the sidecar did not answer within {} s".format(timeout))
        reply = read(remaining)
        if not isinstance(reply, dict):
            raise SystemExit("unexpected sidecar message: {!r}".format(reply))
        kind = reply.get("type")
        if kind == "fatal":
            raise SystemExit("the sidecar stopped ({}): {}".format(reply.get("code"), reply.get("message")))
        if kind not in ("progress", "result", "error"):
            raise SystemExit("unexpected sidecar message: {!r}".format(reply))
        # Like Rust's result_for_id, accept an unscoped error, but never another request's reply.
        if reply.get("id") != request_id and not (kind == "error" and reply.get("id") is None):
            raise SystemExit("the sidecar replied for request {!r} while waiting for {!r}".format(
                reply.get("id"), request_id))
        if kind != "progress":
            return reply
        run, planned = reply.get("run"), reply.get("runsPlanned")
        if (reply.get("stage") != "reading" or type(run) is not int or type(planned) is not int
                or not 1 <= run <= planned):
            raise SystemExit("inconsistent sidecar progress: {!r}".format(reply))
