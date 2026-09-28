from __future__ import annotations

import html
import json
import pathlib

from saq_board import __version__

STATIC_PATH = pathlib.Path(__file__).parent.resolve() / "static"

BODY = """
<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>SAQ Board</title>
        <link rel="icon" href="{root}/static/favicon.svg" type="image/svg+xml">
        <link rel="preload" href="{root}/static/fonts/geist.woff2" as="font" type="font/woff2" crossorigin>
        <link rel="stylesheet" href="{root}/static/board.css?v={version}">
        <script>
            window.SAQ_BOARD = {config};
            try {{
                const theme = localStorage.getItem("saq-board:theme");
                if (theme) document.documentElement.dataset.theme = JSON.parse(theme);
            }} catch (e) {{}}
        </script>
        <script type="module" src="{root}/static/app.js?v={version}"></script>
    </head>
    <body>
        <div id="app"></div>
    </body>
</html>
""".strip()


def render(root_path: str, read_only: bool) -> str:
    root = root_path.rstrip("/")
    config = json.dumps({"root": root, "readOnly": read_only, "version": __version__})
    return BODY.format(
        root=html.escape(root), version=__version__, config=config.replace("<", "\\u003c")
    )
