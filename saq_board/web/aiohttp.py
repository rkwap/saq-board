"""
aiohttp, also used by the ``saq-board`` command.
"""

from __future__ import annotations

import json
import os
import typing as t

from aiohttp import web

from saq_board.api import VIEWS, Board
from saq_board.web.common import STATIC_PATH, render

if t.TYPE_CHECKING:
    from aiohttp.web_request import Request
    from saq.queue import Queue

    from saq_board.api import Handler


def aiohttp_path(path: str) -> str:
    """Translate Starlette's ``{name:path}`` convertor to an aiohttp regex."""
    return path.replace(":path}", ":.+}")


def create_app(
    queues: list[Queue],
    *,
    root_path: str = "",
    read_only: bool = False,
    history_limit: int = 1000,
) -> web.Application:
    """
    Create the dashboard app, a drop-in for ``saq.web.aiohttp.create_app``.

    Like SAQ's dashboard, setting ``AUTH_PASSWORD`` (and optionally ``AUTH_USER``,
    default ``admin``) turns on basic auth.

    Args:
        queues: The list of known queues.
        root_path: Where the app is mounted when used as a sub-app.
        read_only: Hide and reject every action.
        history_limit: Finished jobs kept per status, for jobs finished from the dashboard.
    """
    middlewares = []
    password = os.environ.get("AUTH_PASSWORD")

    if password:
        from aiohttp_basicauth import BasicAuthMiddleware  # type: ignore

        user = os.environ.get("AUTH_USER", "admin")
        middlewares.append(BasicAuthMiddleware(username=user, password=password))

    board = Board(queues, read_only=read_only, history_limit=history_limit)
    page = render(root_path, read_only)

    def endpoint(method: str, handler: Handler) -> t.Callable[[Request], t.Awaitable[web.Response]]:
        async def call(request: Request) -> web.Response:
            body = await request.read() if method != "GET" else b""
            status, data = await board.call(
                method, handler, dict(request.match_info), request.query, body
            )
            return web.json_response(data, status=status, dumps=lambda d: json.dumps(d, default=repr))

        return call

    async def view(_request: Request) -> web.Response:
        return web.Response(text=page, content_type="text/html")

    async def health(_request: Request) -> web.Response:
        if await board.healthy():
            return web.Response(text="OK")
        raise web.HTTPInternalServerError

    app = web.Application(middlewares=middlewares)
    for method, path, handler in board.routes():
        app.router.add_route(method, aiohttp_path(path), endpoint(method, handler))
    for path in VIEWS:
        app.router.add_get(aiohttp_path(path), view)
    app.router.add_get("/health", health)
    app.router.add_static("/static", STATIC_PATH)
    return app
