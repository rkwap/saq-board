"""
The worker plugin: ``settings = with_board(settings)``.

It adds what SAQ doesn't keep on its own: finished job history, pausing a
queue, and Sidekiq-cron style cron jobs.
"""

from __future__ import annotations

import asyncio
import logging
import typing as t
from datetime import timezone

from saq.job import Job, Status
from saq.queue import Queue

from saq_board import __version__
from saq_board.cron import Scheduler
from saq_board.store import Store

logger = logging.getLogger("saq_board")

PAUSE_STEP = 1.0


def track(queue: Queue, history_limit: int = 1000) -> Queue:
    """Record every finished job of this queue so the dashboard can list it."""
    if getattr(queue, "_saq_board_tracked", False):
        return queue
    store = Store(queue)
    finish = queue.finish

    async def tracked(job: Job, status: Status, **kwargs: t.Any) -> None:
        await finish(job, status, **kwargs)
        try:
            await store.record(job, history_limit)
        except Exception:
            logger.exception("saq-board failed to record job %s", job.key)

    queue.finish = tracked  # type: ignore[method-assign]
    queue._saq_board_tracked = True  # type: ignore[attr-defined]
    return queue


def pausable(queue: Queue) -> Queue:
    """Stop dequeuing while the queue is paused from the dashboard."""
    if getattr(queue, "_saq_board_pausable", False):
        return queue
    store = Store(queue)
    dequeue = queue.dequeue

    async def wrapped(timeout: float = 0.0, **kwargs: t.Any) -> Job | None:
        # Block in short steps so a pause takes effect within a second.
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout if timeout else None
        while True:
            step = PAUSE_STEP if deadline is None else min(PAUSE_STEP, deadline - loop.time())
            if step <= 0:
                return None
            if await store.paused():
                await asyncio.sleep(step)
                continue
            job = await dequeue(timeout=step, **kwargs)
            if job:
                return job

    queue.dequeue = wrapped  # type: ignore[method-assign]
    queue._saq_board_pausable = True  # type: ignore[attr-defined]
    return queue


def many(value: t.Any) -> list:
    if value is None:
        return []
    return [value] if callable(value) else list(value)


def with_board(
    settings: dict[str, t.Any], *, history_limit: int = 1000, cron_poll: float = 1.0
) -> dict[str, t.Any]:
    """
    Add saq-board to SAQ worker settings.

    Example:
        .. code-block::

            settings = with_board({
                "queue": queue,
                "functions": [send_email],
                "cron_jobs": [CronJob(cleanup, cron="0 * * * *")],
            })

    Args:
        settings: SAQ worker settings.
        history_limit: finished jobs kept per status (complete, failed, aborted).
        cron_poll: seconds between cron checks.
    """
    settings = dict(settings)
    queue = settings.get("queue") or Queue.from_url("redis://localhost")
    settings["queue"] = pausable(track(queue, history_limit))

    # The board schedules cron jobs itself, so SAQ's own scheduler must not.
    cron_jobs = many(settings.pop("cron_jobs", None))
    scheduler = Scheduler(
        Store(queue), cron_jobs, tz=settings.get("cron_tz") or timezone.utc, poll=cron_poll
    )
    settings["functions"] = [*settings["functions"], *(c.function for c in cron_jobs)]
    settings["startup"] = [*many(settings.get("startup")), scheduler.start]
    settings["shutdown"] = [scheduler.stop, *many(settings.get("shutdown"))]
    settings["metadata"] = {**(settings.get("metadata") or {}), "saq_board": __version__}
    return settings
