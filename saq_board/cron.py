"""
Sidekiq-cron style cron jobs.

Cron jobs are defined in code and synced to Redis when a worker starts. Redis
holds their state (enabled, last enqueued, next run, history), which the
dashboard reads and changes. Every worker process runs a scheduler; a claim
key per run makes sure each run is enqueued once across all of them.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import typing as t
from datetime import datetime, timezone, tzinfo

from croniter import croniter
from saq.job import TERMINAL_STATUSES, Job
from saq.job import CronJob as SaqCronJob
from saq.utils import now

from saq_board.store import Store

logger = logging.getLogger("saq_board")

JOB_OPTIONS = ("timeout", "heartbeat", "retries", "ttl")


@dataclasses.dataclass
class CronJob(SaqCronJob):
    """
    SAQ's CronJob plus a name, a description and an initial enabled state.

    Plain ``saq.CronJob`` instances work too; they are named after their function.
    """

    name: str | None = None
    description: str = ""
    enabled: bool = True


def definition(cron_job: SaqCronJob, tz: tzinfo) -> dict[str, t.Any]:
    if not croniter.is_valid(cron_job.cron):
        raise ValueError(f"Cron is invalid {cron_job.cron}")
    function = cron_job.function.__qualname__
    return {
        "name": getattr(cron_job, "name", None) or function,
        "function": function,
        "cron": cron_job.cron,
        "kwargs": cron_job.kwargs or {},
        "description": getattr(cron_job, "description", ""),
        "unique": cron_job.unique,
        "tz": str(tz),
        **{k: getattr(cron_job, k) for k in JOB_OPTIONS if getattr(cron_job, k) is not None},
    }


async def enqueue(
    store: Store, cron: dict[str, t.Any], key: str, run_at: int, manual: bool = False
) -> dict[str, t.Any]:
    """Enqueue one run of a cron job and log it in the job's history."""
    name = cron["name"]
    entry: dict[str, t.Any] = {"at": now(), "run_at": run_at, "key": key, "manual": manual}
    state: dict[str, t.Any] = {"last_run": run_at}

    last_key = cron.get("last_key")
    last = await store.queue.job(last_key) if cron.get("unique") and not manual and last_key else None

    if last and last.status not in TERMINAL_STATUSES:
        entry["skipped"] = f"previous run {last_key} is still {last.status.value}"
    else:
        job = Job(
            function=cron["function"],
            kwargs=cron.get("kwargs") or None,
            key=key,
            meta={"cron": name},
            **{k: cron[k] for k in JOB_OPTIONS if cron.get(k) is not None},
        )
        if await store.queue.enqueue(job):
            state.update(last_enqueued=entry["at"], last_key=key)
        else:
            entry["skipped"] = f"a job with key {key} already exists"

    await store.cron_log(name, entry, **state)
    return entry


class Scheduler:
    """Syncs code-defined cron jobs to Redis and enqueues them when they are due."""

    def __init__(
        self,
        store: Store,
        cron_jobs: t.Iterable[SaqCronJob],
        tz: tzinfo = timezone.utc,
        poll: float = 1.0,
        grace: int = 60,
    ) -> None:
        self.store = store
        self.tz = tz
        self.poll = poll
        self.grace = grace * 1000
        cron_jobs = list(cron_jobs)
        self.crons = [definition(c, tz) for c in cron_jobs]
        self.initial = {d["name"]: getattr(c, "enabled", True) for d, c in zip(self.crons, cron_jobs)}
        names = [d["name"] for d in self.crons]
        dupes = {n for n in names if names.count(n) > 1}
        if dupes:
            raise ValueError(f"Duplicate cron job names {sorted(dupes)}, give them unique names")
        self._task: asyncio.Task | None = None

    async def sync(self) -> None:
        if not self.crons:
            return
        async with self.store.redis.pipeline(transaction=True) as pipe:
            for cron in self.crons:
                key = self.store.cron_key(cron["name"])
                pipe.hset(key, "def", json.dumps(cron, default=repr))
                pipe.hsetnx(key, "enabled", int(self.initial[cron["name"]]))
                pipe.hsetnx(key, "enabled_at", now())
            pipe.sadd(self.store.key("crons"), *self.initial)
            await pipe.execute()

    async def tick(self, current: datetime | None = None) -> list[dict[str, t.Any]]:
        current = current or datetime.now(self.tz)
        ts = int(current.timestamp() * 1000)
        states = await self.store.cron_states([c["name"] for c in self.crons])
        fired = []

        for cron, state in zip(self.crons, states):
            if not state.get("def"):
                continue  # deleted from the dashboard; comes back on the next worker start

            name = cron["name"]
            run_at = int(croniter(cron["cron"], current).get_prev(float) * 1000)
            next_run = int(croniter(cron["cron"], current).get_next(float) * 1000)
            if state.get("next_run") != str(next_run):
                await self.store.redis.hset(self.store.cron_key(name), "next_run", next_run)

            if (
                state.get("enabled") != "1"
                or ts - run_at > self.grace
                or run_at < int(state.get("enabled_at") or 0)
                or run_at <= int(state.get("last_run") or 0)
            ):
                continue

            claim = self.store.cron_key(name, "claim", str(run_at))
            if not await self.store.redis.set(claim, 1, nx=True, px=self.grace * 2):
                continue

            cron = {**cron, "last_key": state.get("last_key")}
            fired.append(await enqueue(self.store, cron, f"cron:{name}:{run_at // 1000}", run_at))

        return fired

    async def run(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:
                logger.exception("saq-board cron tick failed")
            await asyncio.sleep(self.poll)

    async def start(self, ctx: t.Any) -> None:
        await self.store.register(ctx["worker"].functions)
        await self.sync()
        if self.crons:
            self._task = asyncio.create_task(self.run())

    async def stop(self, _ctx: t.Any) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
