"""
FastMCP server instance for the CodeChef Contest MCP Server.

This module creates the central MCP server that all tools register against.
The FastMCP class uses Python type hints and docstrings to automatically
generate tool definitions.
"""

from mcp.server.fastmcp import FastMCP

# Initialize the FastMCP server instance
# All tools across the project register against this single instance
mcp = FastMCP(
    "codechef-mcp",
    host="0.0.0.0",
    instructions="""
    CodeChef MCP Server — Comprehensive AI-powered competitive programming and analytics assistant.

    Available capabilities:
    - User Profiles & Analytics:
      * Get complete user profile (name, stars, current/highest rating, division, global/country rank)
      * Retrieve contest rating history with rating changes/deltas and ranks
      * Analyze submission heat map and activity patterns over time windows
      * View contest participation history and problems solved per contest
      * Fetch list of unique problems solved by a user
      * Compare multiple users side-by-side
    - Contest Automation & Solving:
      * Open a CodeChef contest and list all problems
      * Fetch complete problem details (statement, constraints, examples)
      * Run code in a secure Docker sandbox (C++, Python, Java, Go, Rust) with no network access
      * Generate adversarial edge-case tests for problems
      * Validate solution complexity and estimate runtime
      * Evaluate submission confidence before submitting
      * Submit solutions to CodeChef and poll for verdicts (AC/WA/TLE/RE)
      * Retry and self-repair failed solutions
      * Solve contests sequentially (Q1→Q5) with smart prioritization
      * Track contest progress and submission history

    Security: All code execution happens inside isolated Docker containers.
    The LLM NEVER gets raw shell access. Only constrained MCP tools are exposed.

    Authentication: Contest submissions require CodeChef credentials in .env file;
    user profile and analytics tools do not require authentication.
    """,
)
