import asyncio
from datetime import datetime, timedelta, timezone

from saq import Worker
from saq.job import Status

from saq_board import CronJob, track, with_board
from saq_board.cron import Scheduler
from saq_board.store import Store
from saq_board.worker import pausable


async def add(ctx, a, b):
    return a + b


async def boom(ctx):
    raise ValueError("boom")


async def noop(ctx):
    return None


async def finish_next(queue, status, **kwargs):
    job = await queue.dequeue(timeout=1)
    await job.finish(status, **kwargs)
    return job


async def test_track_records_finished_jobs(queue):
    track(queue, history_limit=2)
    store = Store(queue)
    for i in range(3):
        await queue.enqueue("add", key=f"ok{i}", a=i, b=1)
        await finish_next(queue, Status.COMPLETE, result=i + 1)
    await queue.enqueue("add", key="bad")
    await finish_next(queue, Status.FAILED, error="nope")

    jobs, total = await store.history("complete", 0, 10)
    assert total == 2
    assert [j.key for j in jobs] == ["ok2", "ok1"]
    assert jobs[0].result == 3
    assert not await store.snapshot("ok0"), "trimmed snapshots are deleted"

    failed, _ = await store.history("failed", 0, 10)
    assert [j.error for j in failed] == ["nope"]
    assert (await store.summary())["totals"] == {"complete": 3, "failed": 1, "aborted": 0}


async def test_track_moves_job_between_statuses(queue):
    track(queue)
    store = Store(queue)
    job = await queue.enqueue("add", key="k")
    await finish_next(queue, Status.FAILED, error="x")
    await job.retry("again")
    await finish_next(queue, Status.COMPLETE)
    counts = (await store.summary())["counts"]
    assert (counts["failed"], counts["complete"]) == (0, 1)


async def test_track_is_idempotent_and_respects_disabled_ttl(queue):
    track(queue)
    track(queue)
    await queue.enqueue("add", key="gone", ttl=-1)
    await finish_next(queue, Status.COMPLETE)
    assert (await Store(queue).summary())["totals"]["complete"] == 0


async def test_pause_stops_dequeue(queue):
    pausable(queue)
    store = Store(queue)
    await queue.enqueue("add", key="k")
    await store.set_paused(True)
    assert await queue.dequeue(timeout=1.2) is None
    await store.set_paused(False)
    assert (await queue.dequeue(timeout=1)).key == "k"


async def test_pause_blocks_forever_without_timeout(queue):
    pausable(queue)
    await Store(queue).set_paused(True)
    await queue.enqueue("add", key="k")
    task = asyncio.create_task(queue.dequeue())
    await asyncio.sleep(1.5)
    assert not task.done()
    await Store(queue).set_paused(False)
    assert (await asyncio.wait_for(task, 3)).key == "k"


async def test_with_board_runs_a_real_worker(queue):
    settings = with_board(
        {
            "queue": queue,
            "functions": [add, boom],
            "cron_jobs": [CronJob(noop, cron="* * * * *", name="tick", description="every minute")],
            "metadata": {"team": "core"},
        }
    )
    assert "cron_jobs" not in settings
    assert settings["metadata"] == {"team": "core", "saq_board": "0.1.0"}

    worker = Worker(**settings)
    task = asyncio.create_task(worker.start())
    try:
        ok = await queue.enqueue("add", a=1, b=2)
        bad = await queue.enqueue("boom", retries=1)
        await ok.refresh(until_complete=5)
        await bad.refresh(until_complete=5)
        assert ok.result == 3

        store = Store(queue)
        await worker.worker_info()
        summary = await store.summary()
        assert summary["counts"]["complete"] == 1 and summary["counts"]["failed"] == 1
        assert {"add", "boom", "noop"} <= set(await store.functions())
        [cron] = await store.crons()
        assert cron["name"] == "tick" and cron["enabled"] and cron["function"] == "noop"
        info = await queue.info()
        assert any("saq_board" in w["metadata"] for w in info["workers"].values())
    finally:
        await worker.stop()
        task.cancel()


def scheduler(queue, *crons, **kwargs):
    return Scheduler(Store(queue), crons, **kwargs)


async def test_cron_fires_once_per_run(queue):
    s = scheduler(queue, CronJob(noop, cron="* * * * *", kwargs={"x": 1}))
    other_process = scheduler(queue, CronJob(noop, cron="* * * * *", kwargs={"x": 1}))
    await s.sync()
    later = datetime.now(timezone.utc) + timedelta(minutes=1)

    [fired] = await s.tick(later)
    assert fired["key"].startswith("cron:noop:")
    assert await s.tick(later) == []
    assert await other_process.tick(later) == []

    job = await queue.job(fired["key"])
    assert job.kwargs == {"x": 1} and job.meta == {"cron": "noop"}
    cron = await Store(queue).cron("noop")
    assert cron["last_key"] == fired["key"] and cron["next_run"] > cron["last_enqueued"]
    assert len(cron["history"]) == 1


async def test_cron_skips_new_disabled_deleted_and_late_runs(queue):
    s = scheduler(queue, CronJob(noop, cron="0 * * * *"))
    await s.sync()
    store = Store(queue)
    now = datetime.now(timezone.utc)
    top = (now + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
    assert await s.tick(now) == [], "runs before the job existed don't fire"

    await store.redis.hset(store.cron_key("noop"), "enabled", 0)
    assert await s.tick(top + timedelta(seconds=5)) == [], "disabled"

    await store.redis.hset(store.cron_key("noop"), "enabled", 1)
    assert await s.tick(top + timedelta(minutes=2)) == [], "past the grace period"
    assert len(await s.tick(top + timedelta(seconds=5))) == 1

    await store.cron_delete("noop")
    assert await s.tick(top + timedelta(hours=1, seconds=5)) == [], "deleted"


async def test_cron_sync_keeps_disabled_state(queue):
    await scheduler(queue, CronJob(noop, cron="0 * * * *")).sync()
    store = Store(queue)
    await store.redis.hset(store.cron_key("noop"), "enabled", 0)
    await scheduler(queue, CronJob(noop, cron="*/5 * * * *")).sync()
    cron = await store.cron("noop")
    assert cron["cron"] == "*/5 * * * *" and not cron["enabled"]


async def test_cron_unique_skips_while_previous_run_pending(queue):
    s = scheduler(queue, CronJob(noop, cron="* * * * *"))
    await s.sync()
    later = datetime.now(timezone.utc) + timedelta(minutes=1)
    [first] = await s.tick(later)
    [second] = await s.tick(later + timedelta(minutes=1))
    assert "still queued" in second["skipped"]
    assert (await Store(queue).cron("noop"))["last_key"] == first["key"]


async def test_cron_rejects_duplicates_and_bad_crons(queue):
    for crons in (
        [CronJob(noop, cron="* * * * *"), CronJob(noop, cron="0 * * * *")],
        [CronJob(noop, cron="not a cron")],
    ):
        try:
            scheduler(queue, *crons)
        except ValueError:
            continue
        raise AssertionError(f"expected ValueError for {crons}")
