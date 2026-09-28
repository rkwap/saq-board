import redis

from saq_board.__main__ import discover
from tests.conftest import REDIS_URL


def test_discover_prefers_registry_then_scans():
    r = redis.Redis.from_url(REDIS_URL)
    try:
        r.flushdb()
        assert discover(REDIS_URL) == []
        r.zadd("saq:scanned:incomplete", {"saq:job:scanned:x": 0})
        assert discover(REDIS_URL) == ["scanned"]
        r.sadd("saq:board:queues", "emails", "default")
        assert discover(REDIS_URL) == ["default", "emails"]
    finally:
        r.flushdb()
        r.close()
