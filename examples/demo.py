"""
Demo: two SAQ workers running the saq-board plugin, plus the dashboard, in one process.

    pip install "saq-board[starlette]" uvicorn
    python examples/demo.py

Then open http://localhost:8000/monitor
"""

import asyncio
import random
import time

import uvicorn
from saq import Queue, Worker
from starlette.applications import Starlette
from starlette.routing import Mount

from saq_board import CronJob, saq_board, with_board

REDIS = "redis://localhost:6379"

default = Queue.from_url(REDIS, name="default")
emails = Queue.from_url(REDIS, name="emails")


async def send_email(ctx, *, to, subject="Hello"):
    await asyncio.sleep(random.uniform(0.2, 1.5))
    if random.random() < 0.15:
        raise ConnectionError("SMTP server timed out")
    return {"to": to, "message_id": f"<{random.randint(1000, 9999)}@example.com>"}


async def resize_image(ctx, *, path, width=800):
    for step in range(10):
        await asyncio.sleep(0.5)
        await ctx["job"].update(progress=(step + 1) / 10)
    return {"path": path.replace(".png", f"@{width}.png"), "width": width}


async def generate_invoice(ctx, *, order_id):
    await asyncio.sleep(random.uniform(0.1, 0.6))
    if random.random() < 0.35:
        raise ValueError(f"Order {order_id} has no billing address")
    return {"invoice": f"INV-{order_id}", "total": round(random.uniform(10, 500), 2)}


async def sync_sitemap(ctx):
    await asyncio.sleep(0.5)
    return {"urls": random.randint(900, 1200)}


async def cleanup(ctx, *, older_than_days=30):
    return {"deleted": random.randint(0, 50)}


async def weekly_report(ctx):
    return "sent"


settings = with_board(
    {
        "queue": default,
        "functions": [resize_image, generate_invoice],
        "concurrency": 4,
        "cron_jobs": [
            CronJob(sync_sitemap, cron="* * * * *", description="Rebuild the sitemap"),
            CronJob(cleanup, cron="0 */6 * * *", kwargs={"older_than_days": 30}, retries=3,
                    description="Delete stale uploads"),
            CronJob(weekly_report, cron="0 9 * * 1", description="Email the weekly report",
                    enabled=False),
        ],
    }
)
email_settings = with_board({"queue": emails, "functions": [send_email], "concurrency": 3})

app = Starlette(routes=[Mount("/monitor", saq_board("/monitor", [default, emails]))])


async def traffic():
    """Keep enqueuing jobs so the dashboard has something to show."""
    n = 0
    while True:
        n += 1
        await emails.enqueue("send_email", to=f"user{n}@example.com", subject="Welcome!", retries=2)
        if n % 3 == 0:
            await default.enqueue("generate_invoice", order_id=1000 + n)
        if n % 4 == 0:
            await default.enqueue("resize_image", path=f"/uploads/photo-{n}.png", width=640)
        if n % 6 == 0:
            later = int(time.time()) + random.randint(60, 3600)
            await emails.enqueue("send_email", to=f"later{n}@example.com", scheduled=later)
        await asyncio.sleep(random.uniform(0.3, 1.2))


async def main():
    workers = [Worker(**settings), Worker(**email_settings)]
    for worker in workers:
        worker.SIGNALS = []  # let uvicorn handle Ctrl+C and stop everything below
        await worker.queue.connect()
    tasks = [asyncio.create_task(w.start()) for w in workers] + [asyncio.create_task(traffic())]
    try:
        await uvicorn.Server(uvicorn.Config(app, port=8000)).serve()
    finally:
        for worker in workers:
            await worker.stop()
        for task in tasks:
            task.cancel()


if __name__ == "__main__":
    asyncio.run(main())
