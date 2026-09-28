import os

import pytest
from saq.queue import Queue

REDIS_URL = os.environ.get("SAQ_BOARD_TEST_REDIS", "redis://localhost:6379/15")


@pytest.fixture
async def queue():
    queue = Queue.from_url(REDIS_URL, name="test")
    await queue.redis.flushdb()
    yield queue
    await queue.redis.flushdb()
    await queue.disconnect()


@pytest.fixture
async def other_queue(queue):
    other = Queue.from_url(REDIS_URL, name="other")
    yield other
    await other.disconnect()
