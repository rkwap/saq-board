"""
saq-board: run the dashboard on its own.

    saq-board --url redis://localhost:6379 --queue default --queue emails
    saq-board --settings app.worker.settings
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys

from saq.queue import Queue

from saq_board.store import REGISTRY, text


def discover(url: str) -> list[str]:
    """Queue names registered by the worker plugin, else found by scanning for SAQ keys."""
    from redis import asyncio as aioredis

    async def run() -> list[str]:
        redis = aioredis.from_url(url)
        try:
            names = {text(n) for n in await redis.smembers(REGISTRY)}
            if not names:
                async for key in redis.scan_iter(match="saq:*:incomplete", count=1000):
                    names.add(text(key)[len("saq:") : -len(":incomplete")])
            return sorted(names)
        finally:
            await redis.aclose()

    return asyncio.run(run())


def main() -> None:
    parser = argparse.ArgumentParser(description="SAQ Board dashboard")
    parser.add_argument("--url", default=os.environ.get("SAQ_BOARD_URL"),
                        help="Redis url, eg: redis://localhost:6379 (env SAQ_BOARD_URL)")
    parser.add_argument("--queue", "-q", action="append", default=[],
                        help="Queue name to monitor, repeatable. Default: discover them")
    parser.add_argument("--settings", "-s", action="append", default=[],
                        help="SAQ worker settings whose queue to monitor, eg: app.worker.settings")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind, defaults to 0.0.0.0")
    parser.add_argument("--port", type=int, default=8080, help="Port, defaults to 8080")
    parser.add_argument("--root-path", default="", help="Path prefix when behind a proxy")
    parser.add_argument("--read-only", action="store_true", help="Hide and reject every action")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)
    sys.path.append(os.getcwd())

    queues: list[Queue] = []
    if args.settings:
        from saq.worker import import_settings

        queues += [import_settings(s).get("queue") or Queue.from_url("redis://localhost")
                   for s in args.settings]
    if args.url:
        names = args.queue or discover(args.url) or ["default"]
        queues += [Queue.from_url(args.url, name=name) for name in names]
    if not queues:
        parser.error("pass --url or --settings")

    from aiohttp import web

    from saq_board.web.aiohttp import create_app

    app = create_app(queues, root_path=args.root_path, read_only=args.read_only)

    async def disconnect(_app: web.Application) -> None:
        for queue in queues:
            await queue.disconnect()

    app.on_shutdown.append(disconnect)
    logging.info("Monitoring queues: %s", ", ".join(q.name for q in queues))
    web.run_app(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
