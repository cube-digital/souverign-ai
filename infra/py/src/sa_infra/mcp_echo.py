"""Tiny stdio MCP server for the Hermes smoke test: one `add` tool that logs each call."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

try:  # mcp 2.x renamed FastMCP to MCPServer
    from mcp.server.mcpserver import MCPServer as _Server
except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as _Server

mcp = _Server("sa-echo")
LOG = Path(os.environ.get("SA_ECHO_LOG", ".run/mcp-echo.log"))


@mcp.tool()
def add(a: int, b: int) -> int:
    """Add two integers and return the sum."""
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"ts": time.time(), "tool": "add", "a": a, "b": b}) + "\n")
    return a + b


if __name__ == "__main__":
    mcp.run()
