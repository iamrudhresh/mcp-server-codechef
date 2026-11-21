"""
MCP tools for CodeChef user profile, rating history, activity, and comparisons.
"""

from typing import Any
from app.mcp_server import mcp
from app.browser import profile as profile_api
from app.utils.logger import logger


@mcp.tool()
async def get_profile(handle: str) -> dict[str, Any]:
    """Fetch a CodeChef user's profile as compact structured JSON.

    Returns: name, star rating, current/highest rating, division, global rank,
    country rank, problems solved, contests participated, latest contest, and recent form.
    Prefer this over scraping raw HTML.

    Args:
        handle: CodeChef username/handle, e.g. "gennady.korotkevich" or "tourist".
    """
    logger.info(f"MCP Tool 'get_profile' called for handle={handle}")
    try:
        return await profile_api.get_profile(handle)
    except Exception as e:
        logger.error(f"Error fetching profile for {handle}: {e}")
        return {"status": "error", "error": str(e), "handle": handle}


@mcp.tool()
async def get_rating_history(handle: str, limit: int = 20) -> dict[str, Any]:
    """Return a user's contest rating history (newest first).

    Includes rating after each contest, rating change (delta), and rank.
    Useful for trends, streaks, and tracking competitive progression.

    Args:
        handle: CodeChef username/handle.
        limit: How many recent contests to return (default 20, max 200).
    """
    logger.info(f"MCP Tool 'get_rating_history' called for handle={handle}, limit={limit}")
    limit = max(1, min(limit, 200))
    try:
        return await profile_api.get_rating_history(handle, limit=limit)
    except Exception as e:
        logger.error(f"Error fetching rating history for {handle}: {e}")
        return {"status": "error", "error": str(e), "handle": handle}


@mcp.tool()
async def get_activity(handle: str, days: int = 90) -> dict[str, Any]:
    """Summarize a user's submission heat map over a time window.

    Provides total submissions, active days, average per active day, busiest day,
    and monthly totals. Answers 'how active is X' without loading raw images/HTML.

    Args:
        handle: CodeChef username/handle.
        days: Look-back window in days (default 90, min 7, max 3650).
    """
    logger.info(f"MCP Tool 'get_activity' called for handle={handle}, days={days}")
    days = max(7, min(days, 3650))
    try:
        return await profile_api.get_activity(handle, days=days)
    except Exception as e:
        logger.error(f"Error fetching activity for {handle}: {e}")
        return {"status": "error", "error": str(e), "handle": handle}


@mcp.tool()
async def get_contests(handle: str, limit: int = 10) -> dict[str, Any]:
    """List a user's contests (newest first) with the problems solved in each.

    Includes rank and rating change where available.

    Args:
        handle: CodeChef username/handle.
        limit: How many recent contests to return (default 10, max 100).
    """
    logger.info(f"MCP Tool 'get_contests' called for handle={handle}, limit={limit}")
    limit = max(1, min(limit, 100))
    try:
        return await profile_api.get_contests(handle, limit=limit)
    except Exception as e:
        logger.error(f"Error fetching contests for {handle}: {e}")
        return {"status": "error", "error": str(e), "handle": handle}


@mcp.tool()
async def get_solved_problems(handle: str, limit: int = 200) -> dict[str, Any]:
    """Return the unique problem names a user has solved, with the contest each came from.

    Also returns their reported total solved count.

    Args:
        handle: CodeChef username/handle.
        limit: Maximum number of problem names to return (default 200, max 1000).
    """
    logger.info(f"MCP Tool 'get_solved_problems' called for handle={handle}, limit={limit}")
    limit = max(1, min(limit, 1000))
    try:
        return await profile_api.get_solved_problems(handle, limit=limit)
    except Exception as e:
        logger.error(f"Error fetching solved problems for {handle}: {e}")
        return {"status": "error", "error": str(e), "handle": handle}


@mcp.tool()
async def compare_users(handles: list[str]) -> dict[str, Any]:
    """Fetch compact side-by-side profiles for 2-5 CodeChef handles.

    Includes rating, stars, ranks, problems solved, and contest count.

    Args:
        handles: List of 2 to 5 CodeChef handles to compare.
    """
    logger.info(f"MCP Tool 'compare_users' called for handles={handles}")
    if len(handles) < 2 or len(handles) > 5:
        return {"status": "error", "message": "compare_users requires between 2 and 5 handles."}
    try:
        return await profile_api.compare_users(handles)
    except Exception as e:
        logger.error(f"Error comparing users {handles}: {e}")
        return {"status": "error", "error": str(e)}
