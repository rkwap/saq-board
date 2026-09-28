import asyncio
from datetime import datetime, timedelta, timezone

from saq import Worker
from saq.job import Status

from saq_board import CronJob, __version__, track, with_board
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
    assert settings["metadata"] == {"team": "core", "saq_board": __version__}

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


async def sleepy(ctx):
    await asyncio.sleep(30)


async def test_worker_finishes_a_ui_abort(queue):
    worker = Worker(**with_board({"queue": queue, "functions": [sleepy]}))
    task = asyncio.create_task(worker.start())
    try:
        job = await queue.enqueue("sleepy", retries=3)
        while (await queue.job(job.key)).status != Status.ACTIVE:
            await asyncio.sleep(0.05)
        store = Store(queue)
        assert await store.abort_job(await queue.job(job.key), 1000)
        await job.refresh(until_complete=5)
        assert job.status == Status.ABORTED and job.error == "aborted from ui"
        assert (await store.history("aborted", 0, 10))[1] == 1
        assert await queue.count("active") == 0 and await queue.count("queued") == 0
    finally:
        await worker.stop()
        task.cancel()


async def test_repeated_abort_cannot_retry_until_worker_acknowledges(queue):
    entered, cancelling, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    executions = 0

    async def slow_cancel(ctx):
        nonlocal executions
        executions += 1
        if executions == 1:
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelling.set()
                await release.wait()
                raise

    worker = Worker(**with_board({
        "queue": queue, "functions": [slow_cancel], "concurrency": 2,
        "timers": {"abort": 60},
    }))
    runner = asyncio.create_task(worker.start())
    abort = None
    try:
        job = await queue.enqueue(slow_cancel.__qualname__, key="same-key")
        await asyncio.wait_for(entered.wait(), 5)
        store = Store(queue)
        assert await store.abort_job(await queue.job(job.key), 1000)
        abort = asyncio.create_task(worker.abort(0))
        await asyncio.wait_for(cancelling.wait(), 5)
        # The worker is alive and performing cancellation cleanup.
        assert await store.abort_job(await queue.job(job.key), 1000)
        pending = await queue.job(job.key)
        assert pending.status == Status.ABORTING
        assert not await store.retry_terminal(pending)
        assert await queue.enqueue(slow_cancel.__qualname__, key=job.key) is None
        assert executions == 1
        assert (await store.summary())["counts"]["active"] == 1
        release.set()
        await asyncio.wait_for(abort, 5)
        await job.refresh(until_complete=5)
        assert job.status == Status.ABORTED
        assert await queue.count("incomplete") == 0
        assert await store.redis.zcard(store.key("aborting")) == 0
        assert await store.retry_terminal(job)
        await job.refresh(until_complete=5)
        assert job.status == Status.COMPLETE and executions == 2
    finally:
        release.set()
        if abort:
            await asyncio.gather(abort, return_exceptions=True)
        await worker.stop()
        await runner


async def test_abort_ack_clears_pending_even_when_history_is_disabled(queue):
    track(queue)
    job = await queue.enqueue("noop", key="no-history", ttl=-1)
    job = await queue.dequeue(timeout=1)
    await job.update(status=Status.ACTIVE)
    store = Store(queue)
    assert await store.abort_job(job, 1000)
    await job.finish(Status.ABORTED)
    assert await queue.job(job.key) is None
    assert await store.redis.zcard(store.key("aborting")) == 0
    assert (await store.history("aborted", 0, 10))[1] == 0


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
