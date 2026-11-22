"""
Verdict polling for CodeChef submissions.

    GET /api/ide/submit?solution_id=<id>  -> {"result_code": "wait" | "accepted" | ...}

The endpoint only answers JSON for the logged-in owner of the submission, so it
is called through the authenticated session. ``result_code`` values are words
(as used by the codechef.com web app), not the AC/WA abbreviations the previous
implementation expected, which is why it never produced a verdict.
"""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any

from app.browser.login import JudgeError, clean_message, get_session
from app.utils.logger import logger

VERDICTS: dict[str, tuple[str, str]] = {
    "accepted": ("AC", "Accepted"),
    "partial_accepted": ("PAC", "Partially Accepted"),
    "wrong": ("WA", "Wrong Answer"),
    "time": ("TLE", "Time Limit Exceeded"),
    "runtime": ("RE", "Runtime Error"),
    "compile": ("CE", "Compilation Error"),
    "memory": ("MLE", "Memory Limit Exceeded"),
    "wait": ("wait", "Judging"),
}


def normalize_verdict(submission_id: str, raw: Any) -> dict:
    """Turn a raw verdict payload into a stable shape."""
    raw = raw if isinstance(raw, dict) else {}
    result_code = str(raw.get("result_code") or "").lower()
    code, label = VERDICTS.get(result_code, (result_code.upper() or "UNKNOWN", result_code or "Unknown"))
    out = {
        "submission_id": str(submission_id),
        "verdict": label,
        "verdict_code": code,
        "result_code": result_code or None,
        "pending": result_code == "wait",
        "execution_time": raw.get("time", "N/A"),
        "memory": raw.get("memory", "N/A"),
    }
    if "score" in raw:
        out["score"] = raw["score"]
    for key in ("cmpinfo", "compile_info", "error_msg", "signal"):
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = value[:2000]
    if code == "CE":
        out["compile_error"] = out.get("cmpinfo") or out.get("compile_info") or out.get("error_msg") or ""
    return out


async def poll_submission_verdict(
    submission_id: str,
    max_wait: float = 60.0,
    interval: float = 2.0,
) -> dict:
    """Poll until judging finishes or ``max_wait`` seconds pass.

    Returns a normalized verdict (``pending: True`` if still judging), or
    ``{"error", "code"}`` on failure.
    """
    sid = str(submission_id).strip()
    if not re.fullmatch(r"\d{1,15}", sid):
        return {"error": "submission_id must be the numeric id returned by submit_solution.", "code": "INVALID_INPUT"}

    session = get_session()
    deadline = time.monotonic() + max(0.0, max_wait)

    async def fetch() -> Any:
        response = await session.request(
            "GET", f"/api/ide/submit?solution_id={sid}", headers={"Accept": "application/json"}
        )
        return session.read_json(response, "Verdict")

    try:
        while True:
            raw = await session.with_auth(fetch)
            if isinstance(raw, dict) and raw.get("status") == "error":
                raise JudgeError(
                    f"CodeChef could not return this submission: {clean_message(raw.get('errors') or raw.get('message'))}",
                    "NOT_FOUND",
                )
            verdict = normalize_verdict(sid, raw)
            if not verdict["pending"] or time.monotonic() + interval > deadline:
                logger.info(f"Verdict for {sid}: {verdict['verdict']}")
                return verdict
            await asyncio.sleep(interval)
    except JudgeError as err:
        logger.error(f"Verdict polling failed: {err.message}")
        return {"error": err.message, "code": err.code, "submission_id": sid}
