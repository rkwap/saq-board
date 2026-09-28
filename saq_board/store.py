"""
Redis keys shared by the worker plugin and the dashboard.

Everything lives under the queue's own SAQ namespace (``saq:<queue>:board:*``),
so deleting a queue's keys also deletes its board data.
"""

from __future__ import annotations

import json
import typing as t

from saq.job import Job
from saq.queue.redis import RedisQueue
from saq.utils import now

if t.TYPE_CHECKING:
    from saq.queue import Queue

FINISHED = ("complete", "failed", "aborted")
LIVE = ("active", "queued", "scheduled")
STATUSES = LIVE + FINISHED
REGISTRY = "saq:board:queues"
CRON_HISTORY = 50

# Saves a finished job's snapshot, indexes it by completion time and trims the
# index (and the trimmed snapshots) down to the history limit.
RECORD = """
redis.call('SET', KEYS[1], ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('HINCRBY', KEYS[5], ARGV[5], 1)
local extra = redis.call('ZCARD', KEYS[2]) - tonumber(ARGV[4])
if extra > 0 then
    for _, key in ipairs(redis.call('ZRANGE', KEYS[2], 0, extra - 1)) do
        redis.call('DEL', ARGV[6] .. key)
    end
    redis.call('ZREMRANGEBYRANK', KEYS[2], 0, extra - 1)
end
"""

# Moves scheduled jobs to the front of the line, like SAQ's own schedule script.
PROMOTE = """
local moved = 0
for _, id in ipairs(ARGV) do
    local score = redis.call('ZSCORE', KEYS[1], id)
    if score and tonumber(score) > 0 then
        redis.call('ZADD', KEYS[1], 0, id)
        redis.call('RPUSH', KEYS[2], id)
        moved = moved + 1
    end
end
return moved
"""


def text(value: bytes | str | None) -> str:
    return value.decode() if isinstance(value, bytes) else value or ""


class Store:
    """Board data for one SAQ Redis queue."""

    def __init__(self, queue: Queue) -> None:
        if not isinstance(queue, RedisQueue):
            raise TypeError(f"saq-board only supports Redis queues, got {queue!r}")
        self.queue = queue
        self.redis = queue.redis
        self._record = self.redis.register_script(RECORD)
        self._promote = self.redis.register_script(PROMOTE)

    def key(self, *parts: str) -> str:
        return self.queue.namespace(":".join(("board", *parts)))

    def snap_key(self, job_key: str) -> str:
        return self.key("snap", job_key)

    # ---- finished job history ----

    async def record(self, job: Job, limit: int) -> None:
        status = job.status.value
        if status not in FINISHED or job.ttl < 0:
            return
        others = [self.key("done", s) for s in FINISHED if s != status]
        await self._record(
            keys=[self.snap_key(job.key), self.key("done", status), *others, self.key("totals")],
            args=[job.key, job.completed or now(), self.queue.serialize(job), max(limit, 1),
                  status, self.snap_key("")],
        )

    async def forget(self, *job_keys: str) -> None:
        if not job_keys:
            return
        async with self.redis.pipeline(transaction=True) as pipe:
            for status in FINISHED:
                pipe.zrem(self.key("done", status), *job_keys)
            pipe.delete(*(self.snap_key(k) for k in job_keys))
            await pipe.execute()

    async def snapshot(self, job_key: str) -> Job | None:
        return self.queue.deserialize(await self.redis.get(self.snap_key(job_key)))

    async def history(self, status: str, offset: int, limit: int) -> tuple[list[Job], int]:
        index = self.key("done", status)
        async with self.redis.pipeline(transaction=False) as pipe:
            keys, total = await pipe.zrevrange(index, offset, offset + limit - 1).zcard(index).execute()
        keys = [text(k) for k in keys]
        payloads = await self.redis.mget([self.snap_key(k) for k in keys]) if keys else []
        jobs = [self.queue.deserialize(p) for p in payloads]
        missing = [k for k, j in zip(keys, jobs) if j is None]
        if missing:
            await self.redis.zrem(index, *missing)
        return [j for j in jobs if j], total

    async def history_keys(self, status: str) -> list[str]:
        return [text(k) for k in await self.redis.zrange(self.key("done", status), 0, -1)]

    # ---- live jobs ----

    async def live_ids(self, status: str, offset: int = 0, limit: int = -1) -> tuple[list, int]:
        q = self.queue
        end = -1 if limit < 0 else offset + limit - 1
        async with self.redis.pipeline(transaction=False) as pipe:
            if status == "scheduled":
                incomplete = q.namespace("incomplete")
                page = {} if limit < 0 else {"start": offset, "num": limit}
                pipe.zrangebyscore(incomplete, 1, "+inf", **page)
                pipe.zcount(incomplete, 1, "+inf")
            else:
                pipe.lrange(q.namespace(status), offset, end).llen(q.namespace(status))
            ids, total = await pipe.execute()
        return ids, total

    async def live(self, status: str, offset: int, limit: int) -> tuple[list[Job], int]:
        ids, total = await self.live_ids(status, offset, limit)
        payloads = await self.redis.mget(ids) if ids else []
        return [j for j in map(self.queue.deserialize, payloads) if j], total

    async def promote(self, job_ids: list) -> int:
        moved = 0
        for i in range(0, len(job_ids), 500):
            moved += await self._promote(
                keys=[self.queue.namespace("incomplete"), self.queue.namespace("queued")],
                args=job_ids[i : i + 500],
            )
        return moved

    # ---- queue state ----

    async def summary(self) -> dict[str, t.Any]:
        q = self.queue
        async with self.redis.pipeline(transaction=False) as pipe:
            pipe.llen(q.namespace("active")).llen(q.namespace("queued"))
            pipe.zcount(q.namespace("incomplete"), 1, "+inf")
            for status in FINISHED:
                pipe.zcard(self.key("done", status))
            pipe.exists(self.key("paused")).hgetall(self.key("totals"))
            *counts, paused, totals = await pipe.execute()
        return {
            "counts": dict(zip(STATUSES, counts)),
            "paused": bool(paused),
            "totals": dict.fromkeys(FINISHED, 0) | {text(k): int(v) for k, v in totals.items()},
        }

    async def paused(self) -> bool:
        return bool(await self.redis.exists(self.key("paused")))

    async def set_paused(self, paused: bool) -> None:
        if paused:
            await self.redis.set(self.key("paused"), 1)
        else:
            await self.redis.delete(self.key("paused"))

    async def register(self, functions: t.Iterable[str]) -> None:
        async with self.redis.pipeline(transaction=False) as pipe:
            pipe.sadd(REGISTRY, self.queue.name)
            functions = list(functions)
            if functions:
                pipe.sadd(self.key("functions"), *functions)
            await pipe.execute()

    async def functions(self) -> list[str]:
        return sorted(text(f) for f in await self.redis.smembers(self.key("functions")))

    # ---- cron ----

    def cron_key(self, name: str, *parts: str) -> str:
        return self.key("cron", name, *parts)

    async def cron_names(self) -> list[str]:
        return sorted(text(n) for n in await self.redis.smembers(self.key("crons")))

    async def cron_states(self, names: list[str]) -> list[dict[str, str]]:
        async with self.redis.pipeline(transaction=False) as pipe:
            for name in names:
                pipe.hgetall(self.cron_key(name))
            states = await pipe.execute()
        return [{text(k): text(v) for k, v in s.items()} for s in states]

    async def crons(self) -> list[dict[str, t.Any]]:
        names = await self.cron_names()
        states = await self.cron_states(names)
        return [cron_dict(self.queue.name, s) for s in states if s.get("def")]

    async def cron(self, name: str) -> dict[str, t.Any] | None:
        state, history = await (
            self.redis.pipeline(transaction=False)
            .hgetall(self.cron_key(name))
            .lrange(self.cron_key(name, "history"), 0, CRON_HISTORY - 1)
            .execute()
        )
        state = {text(k): text(v) for k, v in state.items()}
        if not state.get("def"):
            return None
        return {**cron_dict(self.queue.name, state), "history": [json.loads(h) for h in history]}

    async def cron_log(self, name: str, entry: dict[str, t.Any], **state: t.Any) -> None:
        async with self.redis.pipeline(transaction=True) as pipe:
            if state:
                pipe.hset(self.cron_key(name), mapping=state)
            pipe.lpush(self.cron_key(name, "history"), json.dumps(entry))
            pipe.ltrim(self.cron_key(name, "history"), 0, CRON_HISTORY - 1)
            await pipe.execute()

    async def cron_delete(self, name: str) -> None:
        await (
            self.redis.pipeline(transaction=True)
            .delete(self.cron_key(name), self.cron_key(name, "history"))
            .srem(self.key("crons"), name)
            .execute()
        )


def cron_dict(queue: str, state: dict[str, str]) -> dict[str, t.Any]:
    return {
        **json.loads(state["def"]),
        "queue": queue,
        "enabled": state.get("enabled") == "1",
        "last_enqueued": int(state.get("last_enqueued") or 0),
        "last_key": state.get("last_key") or None,
        "next_run": int(state.get("next_run") or 0),
    }
