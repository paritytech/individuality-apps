#!/usr/bin/env python3
"""Serve one generated game report through the page's real database interface."""

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def build_preview(page_source, documents):
    """Inject a minimal read-only database stub before the report application."""
    payload = json.dumps(documents, ensure_ascii=False).replace("<", "\\u003c")
    stub = f"""<script>
window.claude = {{ use: async (name) => name === "db" ? {{
  collection: () => ({{ onSnapshot: (ready) => ready({{
    docs: {payload}.map((document) => ({{ data: () => document }}))
  }}) }})
}} : null }};
</script>
"""
    marker = "<script>"
    if marker not in page_source:
        raise ValueError("report page has no application script")
    return page_source.replace(marker, stub + marker, 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report_dir", help="folder containing report-publish.json and report-links.json")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    report_dir = Path(args.report_dir)
    page = Path(__file__).resolve().parent.parent / "page" / "game-reports.html"
    documents = [json.loads((report_dir / name).read_text()) for name in ("report-publish.json", "report-links.json")]
    preview = build_preview(page.read_text(), documents).encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.split("?", 1)[0] not in ("/", "/index.html"):
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(preview)))
            self.end_headers()
            self.wfile.write(preview)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Preview: http://127.0.0.1:{args.port}/#links-{documents[0]['game']}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
