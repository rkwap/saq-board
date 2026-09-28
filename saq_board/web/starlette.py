"""
Starlette/FastAPI/ASGI
"""

from __future__ import annotations

import json
import typing as t

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, PlainTextResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from saq_board.api import VIEWS, Board
from saq_board.web.common import STATIC_PATH, render

if t.TYPE_CHECKING:
    from saq.queue import Queue

    from saq_board.api import Handler


def saq_board(
    root_path: str, queues: list[Queue], *, read_only: bool = False, history_limit: int = 1000
) -> Starlette:
    """
    Create an embeddable dashboard, a drop-in for ``saq.web.starlette.saq_web``.

    Example:
        .. code-block::

            routes = [
                Mount("/monitor", saq_board("/monitor", queues=all_the_queues_list))
            ]

    Args:
        root_path: The absolute mount point, typically the same as where you mount it.
        queues: The list of known queues.
        read_only: Hide and reject every action.
        history_limit: Finished jobs kept per status, for jobs finished from the dashboard.
    """
    board = Board(queues, read_only=read_only, history_limit=history_limit)
    page = render(root_path, read_only)

    def endpoint(method: str, handler: Handler) -> t.Callable[[Request], t.Awaitable[Response]]:
        async def call(request: Request) -> Response:
            body = await request.body() if method != "GET" else b""
            status, data = await board.call(
                method, handler, dict(request.path_params), request.query_params, body
            )
            return Response(json.dumps(data, default=repr), status, media_type="application/json")

        return call

    async def view(_request: Request) -> Response:
        return HTMLResponse(page)

    async def health(_request: Request) -> Response:
        if await board.healthy():
            return PlainTextResponse("OK")
        return PlainTextResponse("ERROR", 500)

    return Starlette(
        routes=[
            *(Route(path, endpoint(m, h), methods=[m]) for m, path, h in board.routes()),
            *(Route(path, view) for path in VIEWS),
            Route("/health", health),
            Mount("/static", StaticFiles(directory=STATIC_PATH)),
        ]
    )
