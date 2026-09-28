"""
SAQ Board: a bull-board style dashboard for SAQ with Sidekiq-cron style cron jobs.
"""

from __future__ import annotations

import typing as t

__version__ = "0.1.1"

from saq_board.cron import CronJob  # noqa: E402
from saq_board.worker import track, with_board  # noqa: E402

if t.TYPE_CHECKING:
    from aiohttp.web import Application
    from saq.queue import Queue
    from starlette.applications import Starlette

__all__ = ["CronJob", "__version__", "create_app", "saq_board", "track", "with_board"]


def saq_board(root_path: str, queues: list[Queue], **kwargs: t.Any) -> Starlette:
    """Starlette/FastAPI app, a drop-in for ``saq.web.starlette.saq_web``."""
    from saq_board.web.starlette import saq_board as app

    return app(root_path, queues, **kwargs)


def create_app(queues: list[Queue], **kwargs: t.Any) -> Application:
    """aiohttp app, a drop-in for ``saq.web.aiohttp.create_app``."""
    from saq_board.web.aiohttp import create_app as app

    return app(queues, **kwargs)
