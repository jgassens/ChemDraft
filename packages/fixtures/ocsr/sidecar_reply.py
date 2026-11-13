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
            raise SystemExit("the sidecar did not answer within {:.1f} s".format(timeout))
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
        if kind == "result":
            agreement = reply.get("agreement")
            if not isinstance(agreement, dict):
                raise SystemExit("inconsistent sidecar agreement: {!r}".format(agreement))
            runs, agreeing = agreement.get("runs"), agreement.get("agreeing")
            invalid = agreement.get("invalidRuns", 0)
            scales = agreement.get("scalesPx")
            if (any(type(value) is not int or not 0 <= value <= 0xffffffff
                    for value in (runs, agreeing, invalid))
                    or not isinstance(scales, list)
                    or any(type(value) is not int or not 0 <= value <= 0xffffffff for value in scales)
                    or runs == 0 or agreeing == 0 or agreeing + invalid > runs
                    or len(scales) != runs):
                raise SystemExit("inconsistent sidecar agreement: {!r}".format(agreement))
        if kind != "progress":
            return reply
        run, planned = reply.get("run"), reply.get("runsPlanned")
        if (reply.get("stage") != "reading" or type(run) is not int or type(planned) is not int
                or not 1 <= run <= planned <= 64):
            raise SystemExit("inconsistent sidecar progress: {!r}".format(reply))
