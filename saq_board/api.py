"""
Framework-independent dashboard API.

The routes are a superset of SAQ's built-in dashboard API, so anything that
talks to ``saq.web`` keeps working.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import typing as t

from saq.job import TERMINAL_STATUSES, Job
from saq.utils import now

from saq_board import cron
from saq_board.store import FINISHED, LIVE, STATUSES, Store
from saq_board.worker import track

if t.TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Mapping

    from saq.queue import Queue

    Handler = Callable[[dict[str, str], Mapping[str, str], dict[str, t.Any]], Awaitable[dict]]

logger = logging.getLogger("saq_board")

ADD_OPTIONS = {"key", "timeout", "heartbeat", "retries", "ttl", "retry_delay", "retry_backoff",
               "scheduled", "meta"}
REDIS_INFO = ("redis_version", "redis_mode", "uptime_in_seconds", "connected_clients",
              "blocked_clients", "used_memory_human", "used_memory_peak_human", "maxmemory_human",
              "mem_fragmentation_ratio", "instantaneous_ops_per_sec", "total_commands_processed")
CRON_ACTIONS = ("enqueue", "enable", "disable", "delete")
# Job keys and cron names may contain "/", so they use Starlette's path convertor
# (the aiohttp adapter translates it).
VIEWS = ("/", "/queues/{queue}", "/queues/{queue}/jobs/{job:path}", "/cron", "/cron/{queue}/{name:path}")


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


async def in_batches(fn: Callable[[t.Any], Awaitable[t.Any]], items: list, size: int = 100) -> int:
    """Run fn on every item, a batch at a time. Returns how many succeeded.

    Items that raise ApiError (say, a job that finished meanwhile) are skipped.
    """
    done = 0
    for i in range(0, len(items), size):
        results = await asyncio.gather(*(fn(item) for item in items[i : i + size]), return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException) and not isinstance(result, ApiError):
                raise result
            done += not isinstance(result, BaseException)
    return done


def safe(value: t.Any) -> t.Any:
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return repr(value)


def job_json(job: Job) -> dict[str, t.Any]:
    data = {f.name: getattr(job, f.name) for f in dataclasses.fields(job)}
    data["queue"] = job.queue.name if job.queue else None
    data["status"] = job.status.value
    for key in ("kwargs", "result", "meta"):
        data[key] = safe(data[key])
    return data


class Board:
    def __init__(self, queues: list[Queue], *, read_only: bool = False, history_limit: int = 1000):
        self.queues = {q.name: q for q in queues}
        self.stores = {q.name: Store(track(q, history_limit)) for q in queues}
        self.read_only = read_only
        self.history_limit = history_limit

    def routes(self) -> list[tuple[str, str, Handler]]:
        return [
            ("GET", "/api/queues", self.list_queues),
            ("GET", "/api/queues/{queue}", self.get_queue),
            ("GET", "/api/queues/{queue}/jobs", self.list_jobs),
            ("POST", "/api/queues/{queue}/jobs", self.add_job),
            ("GET", "/api/queues/{queue}/jobs/{job:path}", self.get_job),
            ("POST", "/api/queues/{queue}/jobs/{job:path}/{action}", self.job_action),
            ("POST", "/api/queues/{queue}/{action}", self.queue_action),
            ("GET", "/api/redis", self.redis_info),
            ("GET", "/api/cron", self.list_cron),
            ("POST", "/api/cron/{action}", self.cron_bulk),
            ("GET", "/api/cron/{queue}/{name:path}", self.get_cron),
            ("POST", "/api/cron/{queue}/{name:path}/{action}", self.cron_action),
        ]

    async def call(
        self, method: str, handler: Handler, params: dict[str, str], query: Mapping[str, str],
        body: bytes,
    ) -> tuple[int, dict[str, t.Any]]:
        """Run a handler and turn its outcome into a status code and a JSON body."""
        try:
            if method != "GET" and self.read_only:
                raise ApiError(403, "The dashboard is read-only")
            data = json.loads(body) if body else {}
            if not isinstance(data, dict):
                raise ApiError(400, "Expected a JSON object")
            return 200, await handler(params, query, data)
        except ApiError as e:
            return e.status, {"error": str(e)}
        except json.JSONDecodeError as e:
            return 400, {"error": f"Invalid JSON: {e}"}
        except Exception as e:
            logger.exception("saq-board request failed")
            return 500, {"error": f"{type(e).__name__}: {e}"}

    async def healthy(self) -> bool:
        try:
            await asyncio.gather(*(q.info() for q in self.queues.values()))
            return bool(self.queues)
        except Exception:
            logger.exception("saq-board health check failed")
            return False

    # ---- helpers ----

    def store(self, name: str) -> Store:
        if name not in self.stores:
            raise ApiError(404, f"Unknown queue {name}")
        return self.stores[name]

    async def find_job(self, store: Store, key: str) -> Job:
        job = await store.queue.job(key) or await store.snapshot(key)
        if not job:
            raise ApiError(404, f"Job {key} not found")
        return job

    async def queue_info(self, name: str, jobs: bool = False) -> dict[str, t.Any]:
        store = self.store(name)
        info, summary = await asyncio.gather(store.queue.info(jobs=jobs), store.summary())
        workers = info["workers"].values()
        plugin = any("saq_board" in (w.get("metadata") or {}) for w in workers)
        return {**info, **summary, "plugin": plugin}

    async def abort(self, job: Job) -> None:
        if job.status in TERMINAL_STATUSES:
            raise ApiError(400, f"Job {job.key} already finished")
        store = self.store(job.queue.name)
        if not await store.abort_job(job, self.history_limit):
            raise ApiError(409, "Job changed or is being claimed; refresh and try again")

    async def retry(self, store: Store, job: Job) -> None:
        if not await store.retry_terminal(job):
            raise ApiError(409, "Only the current terminal execution may be retried")

    # ---- queues ----

    async def list_queues(self, params: dict, query: Mapping, body: dict) -> dict:
        return {"queues": await asyncio.gather(*(self.queue_info(n) for n in self.queues))}

    async def get_queue(self, params: dict, query: Mapping, body: dict) -> dict:
        info = await self.queue_info(params["queue"], jobs=True)
        return {"queue": {**info, "functions": await self.store(params["queue"]).functions()}}

    async def queue_action(self, params: dict, query: Mapping, body: dict) -> dict:
        store = self.store(params["queue"])
        action, status = params["action"], body.get("status")

        if action in ("pause", "resume"):
            await store.set_paused(action == "pause")
            return {}
        if action == "promote-all":
            ids, _ = await store.live_ids("scheduled")
            return {"count": await store.promote(ids)}
        if action == "clean" and status in FINISHED:
            keys = await store.history_keys(status)
            await store.forget(*keys)
            return {"count": len(keys)}
        if action == "retry-all" and status in ("failed", "aborted"):
            keys = await store.history_keys(status)
            payloads = await store.redis.mget([store.snap_key(k) for k in keys]) if keys else []
            jobs = [j for j in map(store.queue.deserialize, payloads) if j]
            return {"count": await in_batches(lambda job: self.retry(store, job), jobs)}
        if action == "abort-all" and status in ("queued", "scheduled"):
            ids, _ = await store.live_ids(status)
            payloads = await store.redis.mget(ids) if ids else []
            jobs = [j for j in map(store.queue.deserialize, payloads) if j]
            jobs = [j for j in jobs if j.status not in TERMINAL_STATUSES]
            return {"count": await in_batches(self.abort, jobs)}
        raise ApiError(400, f"Unknown action {action} {status or ''}".strip())

    # ---- jobs ----

    async def list_jobs(self, params: dict, query: Mapping, body: dict) -> dict:
        store = self.store(params["queue"])
        status = query.get("status", "active")
        if status not in STATUSES:
            raise ApiError(400, f"Unknown status {status}")
        try:
            offset = max(int(query.get("offset", 0)), 0)
            limit = min(max(int(query.get("limit", 20)), 1), 100)
        except ValueError as e:
            raise ApiError(400, "offset and limit must be integers") from e
        load = store.live if status in LIVE else store.history
        jobs, total = await load(status, offset, limit)
        return {"jobs": [job_json(j) for j in jobs], "total": total}

    async def get_job(self, params: dict, query: Mapping, body: dict) -> dict:
        return {"job": job_json(await self.find_job(self.store(params["queue"]), params["job"]))}

    async def add_job(self, params: dict, query: Mapping, body: dict) -> dict:
        store = self.store(params["queue"])
        function, kwargs, options = body.get("function"), body.get("kwargs") or {}, body.get("options") or {}
        if not function or not isinstance(function, str):
            raise ApiError(400, "function is required")
        if not isinstance(kwargs, dict) or not isinstance(options, dict):
            raise ApiError(400, "kwargs and options must be JSON objects")
        options = {k: v for k, v in options.items() if v is not None}
        unknown = set(options) - ADD_OPTIONS
        if unknown:
            raise ApiError(400, f"Unknown options {sorted(unknown)}, allowed: {sorted(ADD_OPTIONS)}")
        job = await store.queue.enqueue(Job(function=function, kwargs=kwargs or None, **options))
        if not job:
            raise ApiError(409, f"A job with key {options.get('key')} already exists")
        return {"job": job_json(job)}

    async def job_action(self, params: dict, query: Mapping, body: dict) -> dict:
        store = self.store(params["queue"])
        key, action = params["job"], params["action"]
        job = await self.find_job(store, key)

        if action == "retry":
            await self.retry(store, job)
        elif action == "abort":
            await self.abort(job)
        elif action == "promote":
            if not await store.promote([store.queue.job_id(key)]):
                raise ApiError(400, f"Job {key} is not scheduled")
        elif action == "remove":
            live = await store.queue.job(key)
            if live and live.status not in TERMINAL_STATUSES:
                if not await store.snapshot(key):
                    raise ApiError(400, f"Job {key} is {live.status.value}, abort it first")
            elif live:
                await store.redis.delete(store.queue.job_id(key))
            await store.forget(key)
        else:
            raise ApiError(400, f"Unknown action {action}")
        return {}

    # ---- redis ----

    async def redis_info(self, params: dict, query: Mapping, body: dict) -> dict:
        if not self.stores:
            return {"redis": {}}
        info = await next(iter(self.stores.values())).redis.info()
        return {"redis": {k: safe(info.get(k)) for k in REDIS_INFO if k in info}}

    # ---- cron ----

    async def list_cron(self, params: dict, query: Mapping, body: dict) -> dict:
        crons = [c for cs in await asyncio.gather(*(s.crons() for s in self.stores.values())) for c in cs]
        return {"cron": sorted(crons, key=lambda c: (not c["enabled"], c["name"], c["queue"]))}

    async def get_cron(self, params: dict, query: Mapping, body: dict) -> dict:
        found = await self.store(params["queue"]).cron(params["name"])
        if not found:
            raise ApiError(404, f"Cron job {params['name']} not found")
        return {"cron": found}

    async def cron_run(self, store: Store, found: dict, action: str) -> None:
        name = found["name"]
        if action == "enqueue":
            at = now()
            await cron.enqueue(store, found, f"cron:{name}:now:{at}", at, manual=True)
        elif action in ("enable", "disable"):
            state = {"enabled": int(action == "enable")}
            if action == "enable":
                state["enabled_at"] = now()
            await store.redis.hset(store.cron_key(name), mapping=state)
        elif action == "delete":
            await store.cron_delete(name)
        else:
            raise ApiError(400, f"Unknown action {action}")

    async def cron_action(self, params: dict, query: Mapping, body: dict) -> dict:
        store = self.store(params["queue"])
        found = await store.cron(params["name"])
        if not found:
            raise ApiError(404, f"Cron job {params['name']} not found")
        await self.cron_run(store, found, params["action"])
        return {}

    async def cron_bulk(self, params: dict, query: Mapping, body: dict) -> dict:
        action = params["action"].removesuffix("-all")
        if action not in CRON_ACTIONS or params["action"] == action:
            raise ApiError(400, f"Unknown action {params['action']}")
        count = 0
        for store in self.stores.values():
            for found in await store.crons():
                await self.cron_run(store, found, action)
                count += 1
        return {"count": count}
