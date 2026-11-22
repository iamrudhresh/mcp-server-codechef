"""
MCP tools for code submission, verdict polling, and solution repair (retry).
"""

from typing import Any
from app.mcp_server import mcp
from app.browser.submission import submit_code
from app.browser.verdict import poll_submission_verdict
from app.solver.contest_solver import get_contest_state
from app.retry_engine.retry import get_retry_state, analyze_failure
from app.models.database import (
    save_submission,
    get_submission,
    get_problem_submissions,
)
from app.utils.logger import logger


@mcp.tool()
async def submit_solution(
    contest_code: str,
    problem_code: str,
    language: str,
    code: str,
) -> dict[str, Any]:
    """Submit code to CodeChef for judging on your account; returns the submission id.

    Requires CODECHEF_USERNAME and CODECHEF_PASSWORD (.env or the MCP client's
    env block). Follow up with get_submission_status.

    Args:
        contest_code: The code of the contest (e.g. "START123", or "PRACTICE").
        problem_code: The code of the problem (e.g. "FLOW001").
        language: cpp, c, python, pypy, java, go, rust, javascript, or any CodeChef language name.
        code: The complete source code to submit.
    """
    contest_code = contest_code.upper()
    problem_code = problem_code.upper()
    logger.info(f"MCP Tool 'submit_solution' called for {contest_code}/{problem_code}")

    # Submit through the CodeChef API using the logged-in session
    result = await submit_code(contest_code, problem_code, language, code)
    if "error" in result:
        return {"status": "error", "code": result.get("code", "ERROR"), "message": result["error"]}
    contest_code = result.get("contest_code", contest_code)
    problem_code = result.get("problem_code", problem_code)

    submission_id = result.get("submission_id")
    if submission_id:
        # Save submission to database with "Pending" status
        await save_submission(
            submission_id=submission_id,
            contest_code=contest_code,
            problem_code=problem_code,
            language=result.get("language", language),
            code=code,
            verdict="Pending",
            verdict_code="wait",
        )

        # Update active contest state if one exists
        state = get_contest_state(contest_code)
        if state:
            state.mark_attempted(problem_code)
            state.record_submission(
                problem_code,
                {
                    "submission_id": submission_id,
                    "language": language,
                    "code_preview": code[:200],
                    "status": "Pending",
                },
            )

    return result


@mcp.tool()
async def get_submission_status(submission_id: str, wait_seconds: int = 60) -> dict[str, Any]:
    """Wait for and return the verdict of a CodeChef submission.

    Verdicts: Accepted, Wrong Answer, Time Limit Exceeded, Runtime Error,
    Compilation Error, Partially Accepted (with time, memory and compile output).
    Requires CODECHEF_USERNAME / CODECHEF_PASSWORD.

    Args:
        submission_id: The ID returned by submit_solution.
        wait_seconds: How long to wait for judging to finish (default 60, max 180).
    """
    logger.info(f"MCP Tool 'get_submission_status' called for ID={submission_id}")

    # Retrieve submission metadata from DB to check if it's already solved or get problem info
    sub = await get_submission(submission_id)

    # Poll verdict from CodeChef API
    result = await poll_submission_verdict(submission_id, max_wait=max(0, min(int(wait_seconds), 180)))
    if "error" in result:
        return {"status": "error", "code": result.get("code", "ERROR"), "message": result["error"]}

    # Update database once judging has finished
    if sub and not result.get("pending"):
        await save_submission(
            submission_id=submission_id,
            contest_code=sub.contest_code,
            problem_code=sub.problem_code,
            language=sub.language,
            code=sub.code,
            verdict=result.get("verdict", "Unknown"),
            verdict_code=result.get("verdict_code", "wait"),
            execution_time=result.get("execution_time", "N/A"),
            memory=result.get("memory", "N/A"),
        )

        # If Accepted, mark problem as solved in active contest state
        if result.get("verdict_code") == "AC":
            state = get_contest_state(sub.contest_code)
            if state:
                state.mark_solved(sub.problem_code)

    return result


@mcp.tool()
async def retry_solution(contest_code: str, problem_code: str) -> dict[str, Any]:
    """Retrieve the retry state for a problem and generate a solution repair analysis.

    Looks up the latest failed submission for this problem, diagnoses the error (WA/TLE/RE),
    and suggests fix strategies.

    Args:
        contest_code: The code of the contest (e.g. "START123").
        problem_code: The code of the problem (e.g. "PROB1").
    """
    contest_code = contest_code.upper()
    problem_code = problem_code.upper()
    logger.info(f"MCP Tool 'retry_solution' called for {contest_code}/{problem_code}")

    # Fetch retry state
    retry_state = get_retry_state(problem_code)

    # Fetch latest submission from DB to diagnose
    submissions = await get_problem_submissions(problem_code)
    if not submissions:
        return {
            "status": "info",
            "message": "No submissions found in DB for this problem yet. Cannot analyze failures.",
            "retry_state": retry_state.to_dict(),
        }

    latest_sub = submissions[0]
    verdict = latest_sub.verdict
    verdict_code = latest_sub.verdict_code

    if verdict_code == "AC":
        return {
            "status": "success",
            "message": "Problem is already Accepted! No retry needed.",
            "retry_state": retry_state.to_dict(),
        }

    # Generate diagnosis and fix tips
    # In sandbox or real run, stderr might be captured. Let's parse from DB or pass empty.
    # Note: compilation errors are stored in latest_sub.verdict if we don't have compile log.
    analysis = analyze_failure(verdict_code, stderr="", failed_input="")

    # Record attempt in retry state
    retry_state.record_attempt(
        verdict=verdict,
        code=latest_sub.code,
        analysis=analysis["diagnosis"],
    )

    return {
        "status": "retry_needed",
        "retry_state": retry_state.to_dict(),
        "analysis": analysis,
        "latest_code": latest_sub.code,
    }


@mcp.tool()
async def get_submission_history(contest_code: str, problem_code: str) -> list[dict[str, Any]]:
    """Get the list of all prior submissions for a problem from the database.

    Args:
        contest_code: The code of the contest (e.g. "START123").
        problem_code: The code of the problem (e.g. "PROB1").
    """
    contest_code = contest_code.upper()
    problem_code = problem_code.upper()
    logger.info(f"MCP Tool 'get_submission_history' called for {contest_code}/{problem_code}")

    submissions = await get_problem_submissions(problem_code)
    return [
        {
            "submission_id": sub.submission_id,
            "contest_code": sub.contest_code,
            "problem_code": sub.problem_code,
            "language": sub.language,
            "verdict": sub.verdict,
            "verdict_code": sub.verdict_code,
            "execution_time": sub.execution_time,
            "memory": sub.memory,
            "timestamp": sub.timestamp.isoformat(),
        }
        for sub in submissions
    ]
