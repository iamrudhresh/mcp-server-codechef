"""
Code submission to CodeChef.

Uses the endpoint the codechef.com web app calls (verified against its bundle):

    POST /api/ide/submit  sourceCode, language (numeric id), problemCode, contestCode
         -> {"upid": <submission id>} or {"status": "error", "errors": [...]}

Language ids come from the public ``/api/ide/all/languages/all`` list, so new
CodeChef languages work without a code change.
"""

from __future__ import annotations

import re
import time
from typing import Any, Optional

from app.browser.login import JudgeError, clean_message, get_session
from app.utils.logger import logger

MAX_SOURCE_BYTES = 64 * 1024
_CODE_RE = re.compile(r"^[A-Z0-9_]{1,40}$")

# User-facing names -> CodeChef ``short_name``s, in preference order.
LANGUAGE_PREFERENCES: dict[str, list[str]] = {
    "cpp": ["C++", "CPP20", "CPP17", "CPP14"],
    "c++": ["C++", "CPP20", "CPP17", "CPP14"],
    "cpp17": ["C++", "CPP17", "CPP20"],
    "cpp20": ["CPP20", "C++"],
    "cpp14": ["CPP14", "C++"],
    "c": ["C"],
    "python": ["PYTH 3", "PYTH3"],
    "python3": ["PYTH 3", "PYTH3"],
    "py": ["PYTH 3", "PYTH3"],
    "pypy": ["PYPY3", "PYP3"],
    "pypy3": ["PYPY3", "PYP3"],
    "java": ["JAVA"],
    "go": ["GO"],
    "golang": ["GO"],
    "rust": ["rust", "RUST"],
    "javascript": ["NODEJS"],
    "js": ["NODEJS"],
    "node": ["NODEJS"],
    "nodejs": ["NODEJS"],
    "kotlin": ["kotlin", "KOTLIN"],
    "csharp": ["CS2", "C#"],
}

_language_cache: Optional[tuple[float, list[dict]]] = None


def resolve_language(language: str, languages: list[dict]) -> Optional[dict]:
    """Pick the CodeChef language entry for a name, short name or numeric id."""
    wanted = str(language or "").strip()
    by_short = {str(l.get("short_name", "")).lower(): l for l in languages}
    for entry in languages:
        if str(entry.get("id")) == wanted:
            return entry
    if wanted.lower() in by_short:
        return by_short[wanted.lower()]
    for candidate in LANGUAGE_PREFERENCES.get(wanted.lower(), []):
        if candidate.lower() in by_short:
            return by_short[candidate.lower()]
    return None


async def get_languages() -> list[dict]:
    global _language_cache
    if _language_cache and time.time() - _language_cache[0] < 24 * 3600:
        return _language_cache[1]
    session = get_session()
    response = await session.request(
        "GET", "/api/ide/all/languages/all", headers={"Accept": "application/json"}
    )
    data = session.read_json(response, "Language list")
    languages = data.get("languages") if isinstance(data, dict) else None
    if not languages:
        raise JudgeError("CodeChef returned an empty language list.", "UPSTREAM")
    _language_cache = (time.time(), languages)
    return languages


def reset_language_cache() -> None:
    global _language_cache
    _language_cache = None


async def submit_code(contest_code: str, problem_code: str, language: str, code: str) -> dict:
    """Submit code for judging. Returns ``{"submission_id", ...}`` or ``{"error", "code"}``."""
    try:
        return await _submit(contest_code, problem_code, language, code)
    except JudgeError as err:
        logger.error(f"Submission failed: {err.message}")
        return {"error": err.message, "code": err.code}


async def _submit(contest_code: str, problem_code: str, language: str, code: str) -> dict:
    contest = str(contest_code).strip().upper()
    problem = str(problem_code).strip().upper()
    if not _CODE_RE.match(contest) or not _CODE_RE.match(problem):
        raise JudgeError(
            "contest_code and problem_code must be CodeChef codes like START123 / FLOW001.",
            "INVALID_INPUT",
        )
    if not code or len(code.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise JudgeError(f"Source code must be 1-{MAX_SOURCE_BYTES} bytes.", "INVALID_INPUT")

    languages = await get_languages()
    lang = resolve_language(language, languages)
    if not lang:
        names = ", ".join(str(l.get("short_name")) for l in languages)
        raise JudgeError(f'Unsupported language "{language}". CodeChef accepts: {names}', "INVALID_INPUT")

    session = get_session()
    referer_path = "problems" if contest == "PRACTICE" else f"{contest}/problems"

    async def send() -> Any:
        response = await session.request(
            "POST",
            "/api/ide/submit",
            data={
                "sourceCode": code,
                "language": str(lang["id"]),
                "problemCode": problem,
                "contestCode": contest,
            },
            headers={
                "Accept": "application/json",
                "Referer": f"https://www.codechef.com/{referer_path}/{problem}",
            },
        )
        data = session.read_json(response, "Submit")
        message = clean_message(data.get("errors") or data.get("message")) if isinstance(data, dict) else ""
        if isinstance(data, dict) and data.get("status") == "error" and re.search(
            r"log\s*in|session|sign\s*in", message, re.IGNORECASE
        ):
            raise JudgeError(message, "AUTH_REQUIRED")
        return data

    data = await session.with_auth(send)
    if not isinstance(data, dict) or data.get("status") == "error" or not data.get("upid"):
        reason = clean_message((data or {}).get("errors") or (data or {}).get("message")) if isinstance(data, dict) else ""
        raise JudgeError(
            f"CodeChef rejected the submission: {reason or 'no submission id returned'}",
            "SUBMIT_REJECTED",
        )

    submission_id = str(data["upid"])
    logger.info(f"Submitted {contest}/{problem} as {lang.get('short_name')}: id={submission_id}")
    return {
        "submission_id": submission_id,
        "status": "submitted",
        "contest_code": contest,
        "problem_code": problem,
        "language": lang.get("short_name"),
        "language_id": lang.get("id"),
        "url": f"https://www.codechef.com/viewsolution/{submission_id}",
    }
