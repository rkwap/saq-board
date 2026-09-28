import time

import httpx
import pytest
from saq.job import Status

from saq_board import CronJob, create_app, saq_board
from saq_board.cron import Scheduler
from saq_board.store import Store


async def noop(ctx):
    return None


@pytest.fixture
async def client(queue, other_queue):
    app = saq_board("/monitor", [queue, other_queue])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        yield c


async def finish_next(queue, status, **kwargs):
    job = await queue.dequeue(timeout=1)
    await job.finish(status, **kwargs)
    return job


async def test_views_and_static(client):
    for path in ("/", "/queues/test", "/queues/test/jobs/abc", "/cron", "/cron/test/x"):
        r = await client.get(path)
        assert r.status_code == 200 and '"root": "/monitor"' in r.text
    assert (await client.get("/static/app.js")).status_code == 200
    assert (await client.get("/health")).text == "OK"


async def test_saq_compatible_routes(client, queue):
    await queue.enqueue("add", key="k1", a=1)
    queues = (await client.get("/api/queues")).json()["queues"]
    assert [q["name"] for q in queues] == ["test", "other"]
    assert {"workers", "queued", "active", "scheduled", "jobs"} <= set(queues[0])
    assert queues[0]["counts"]["queued"] == 1 and queues[0]["paused"] is False

    detail = (await client.get("/api/queues/test")).json()["queue"]
    assert [j["key"] for j in detail["jobs"]] == ["k1"]
    job = (await client.get("/api/queues/test/jobs/k1")).json()["job"]
    assert job["kwargs"] == {"a": 1} and job["status"] == "queued"

    assert (await client.post("/api/queues/test/jobs/k1/abort")).json() == {}
    assert (await queue.job("k1")).status == Status.ABORTED
    assert (await client.post("/api/queues/test/jobs/k1/retry")).json() == {}
    assert (await queue.job("k1")).status == Status.QUEUED


async def test_list_jobs_by_status(client, queue):
    await queue.enqueue("add", key="soon", scheduled=int(time.time()) + 3600)
    for i in range(3):
        await queue.enqueue("add", key=f"q{i}")
    await finish_next(queue, Status.COMPLETE, result={"n": 1})
    await finish_next(queue, Status.FAILED, error="Traceback: boom")

    async def keys(status, **params):
        data = (await client.get("/api/queues/test/jobs", params={"status": status, **params})).json()
        return [j["key"] for j in data["jobs"]], data["total"]

    assert await keys("scheduled") == (["soon"], 1)
    assert await keys("queued") == (["q2"], 1)
    assert await keys("complete") == (["q0"], 1)
    assert await keys("failed") == (["q1"], 1)
    assert await keys("active") == ([], 0)
    assert (await client.get("/api/queues/test/jobs", params={"status": "nope"})).status_code == 400
    assert (await client.get("/api/queues/test/jobs", params={"limit": "x"})).status_code == 400


async def test_job_actions(client, queue):
    await queue.enqueue("add", key="later", scheduled=int(time.time()) + 3600)
    assert (await client.post("/api/queues/test/jobs/later/promote")).json() == {}
    assert (await queue.dequeue(timeout=1)).key == "later"
    r = await client.post("/api/queues/test/jobs/later/promote")
    assert r.status_code == 400

    await queue.enqueue("add", key="sched", scheduled=int(time.time()) + 3600)
    await client.post("/api/queues/test/jobs/sched/abort")
    assert (await queue.job("sched")).status == Status.ABORTED, "scheduled jobs finish as aborted"
    assert (await client.post("/api/queues/test/jobs/sched/abort")).status_code == 400

    r = await client.post("/api/queues/test/jobs/sched/remove")
    assert r.json() == {} and await queue.job("sched") is None
    assert (await client.get("/api/queues/test/jobs/sched")).status_code == 404

    await queue.enqueue("add", key="waiting")
    assert (await client.post("/api/queues/test/jobs/waiting/remove")).status_code == 400
    assert (await client.post("/api/queues/test/jobs/waiting/nope")).status_code == 400


async def test_finished_job_outlives_saq_ttl(client, queue):
    await queue.enqueue("add", key="short", ttl=1)
    await finish_next(queue, Status.FAILED, error="x")
    await queue.redis.delete(queue.job_id("short"))  # what SAQ's ttl does
    job = (await client.get("/api/queues/test/jobs/short")).json()["job"]
    assert job["status"] == "failed"
    assert (await client.post("/api/queues/test/jobs/short/retry")).json() == {}
    assert (await queue.job("short")).status == Status.QUEUED
    assert (await Store(queue).summary())["counts"]["failed"] == 0


async def test_add_job(client, queue):
    body = {"function": "add", "kwargs": {"a": 1}, "options": {"key": "mine", "retries": 3}}
    job = (await client.post("/api/queues/test/jobs", json=body)).json()["job"]
    assert job["key"] == "mine" and job["retries"] == 3 and job["status"] == "queued"
    assert (await client.post("/api/queues/test/jobs", json=body)).status_code == 409
    assert (await client.post("/api/queues/test/jobs", json={})).status_code == 400
    bad = {"function": "add", "options": {"queue": "x"}}
    assert (await client.post("/api/queues/test/jobs", json=bad)).status_code == 400
    assert (await client.post("/api/queues/test/jobs", content=b"[1]")).status_code == 400
    assert (await client.post("/api/queues/test/jobs", content=b"{")).status_code == 400


async def test_queue_actions(client, queue):
    store = Store(queue)
    assert (await client.post("/api/queues/test/pause")).json() == {}
    assert await store.paused()
    await client.post("/api/queues/test/resume")
    assert not await store.paused()

    for i in range(2):
        await queue.enqueue("add", key=f"s{i}", scheduled=int(time.time()) + 3600)
    assert (await client.post("/api/queues/test/promote-all")).json() == {"count": 2}

    await queue.enqueue("add", key="s2", scheduled=int(time.time()) + 3600)
    r = await client.post("/api/queues/test/abort-all", json={"status": "scheduled"})
    assert r.json() == {"count": 1}
    assert (await client.post("/api/queues/test/abort-all", json={"status": "queued"})).json() == {"count": 2}
    assert (await store.summary())["counts"]["aborted"] == 3

    r = await client.post("/api/queues/test/retry-all", json={"status": "aborted"})
    assert r.json() == {"count": 3}
    assert (await store.summary())["counts"]["queued"] == 3

    await finish_next(queue, Status.COMPLETE)
    assert (await client.post("/api/queues/test/clean", json={"status": "complete"})).json() == {"count": 1}
    assert (await client.post("/api/queues/test/clean", json={"status": "queued"})).status_code == 400
    assert (await client.post("/api/queues/nope/pause")).status_code == 404


async def test_cron_endpoints(client, queue):
    await Scheduler(Store(queue), [CronJob(noop, cron="0 * * * *", description="hourly")]).sync()

    [cron] = (await client.get("/api/cron")).json()["cron"]
    assert cron["queue"] == "test" and cron["enabled"] and cron["description"] == "hourly"

    assert (await client.post("/api/cron/test/noop/disable")).json() == {}
    assert not (await client.get("/api/cron/test/noop")).json()["cron"]["enabled"]
    await client.post("/api/cron/test/noop/enable")

    assert (await client.post("/api/cron/test/noop/enqueue")).json() == {}
    detail = (await client.get("/api/cron/test/noop")).json()["cron"]
    assert detail["history"][0]["manual"] and detail["last_key"].startswith("cron:noop:now:")
    assert (await queue.job(detail["last_key"])).function == "noop"

    assert (await client.post("/api/cron/disable-all")).json() == {"count": 1}
    assert (await client.post("/api/cron/nope-all")).status_code == 400
    assert (await client.post("/api/cron/delete-all")).json() == {"count": 1}
    assert (await client.get("/api/cron")).json() == {"cron": []}
    assert (await client.post("/api/cron/test/noop/enable")).status_code == 404


async def test_redis_info(client):
    info = (await client.get("/api/redis")).json()["redis"]
    assert info["redis_version"]


async def test_read_only(queue):
    app = saq_board("", [queue], read_only=True)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        assert '"readOnly": true' in (await c.get("/")).text
        assert (await c.post("/api/queues/test/pause")).status_code == 403
        assert (await c.get("/api/queues")).status_code == 200


async def test_root_path_is_escaped(queue):
    app = saq_board('/x"</script>', [queue])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        page = (await c.get("/")).text
    assert "</script><" not in page.split("window.SAQ_BOARD", 1)[1].split(";", 1)[0]


async def test_aiohttp_app(aiohttp_client, queue, monkeypatch):
    await queue.enqueue("add", key="k1")
    client = await aiohttp_client(create_app([queue]))
    assert (await (await client.get("/api/queues")).json())["queues"][0]["counts"]["queued"] == 1
    assert (await client.post("/api/queues/test/jobs/k1/abort")).status == 200
    assert (await client.get("/api/queues/nope")).status == 404
    assert (await client.get("/queues/test")).status == 200
    assert (await client.get("/static/board.css")).status == 200

    monkeypatch.setenv("AUTH_PASSWORD", "secret")
    secured = await aiohttp_client(create_app([queue]))
    assert (await secured.get("/api/queues")).status == 401


async def test_slashes_in_job_keys_and_cron_names(client, queue):
    await queue.enqueue("add", key="team/a b?", scheduled=int(time.time()) + 3600)
    path = "/api/queues/test/jobs/team%2Fa%20b%3F"
    assert (await client.get(path)).json()["job"]["key"] == "team/a b?"
    assert (await client.post(path + "/promote")).json() == {}
    assert (await client.get("/queues/test/jobs/team%2Fa%20b%3F")).status_code == 200

    await Scheduler(Store(queue), [CronJob(noop, cron="0 * * * *", name="team/nightly")]).sync()
    assert (await client.get("/api/cron/test/team%2Fnightly")).json()["cron"]["name"] == "team/nightly"
    assert (await client.post("/api/cron/test/team%2Fnightly/disable")).json() == {}
    assert (await client.get("/cron/test/team%2Fnightly")).status_code == 200


async def test_aiohttp_slashes_in_job_keys(aiohttp_client, queue):
    await queue.enqueue("add", key="team/a b?")
    client = await aiohttp_client(create_app([queue]))
    path = "/api/queues/test/jobs/team%2Fa%20b%3F"
    assert (await (await client.get(path)).json())["job"]["key"] == "team/a b?"
    assert (await client.post(path + "/abort")).status == 200
    assert (await client.get("/queues/test/jobs/team%2Fa%20b%3F")).status == 200
