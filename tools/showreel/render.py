#!/usr/bin/env python3
"""Render showreel.html frames to PNG with Playwright (deterministic, frame-indexed).

usage: render.py [--step N] [--start A] [--end B] [--frames 0,30,60] [--out DIR] [--workers 6]

The page is served from a loopback-only HTTP server (127.0.0.1, this directory). Each worker
(one headless Chromium) calls window.renderFrame(i), encodes with canvas.toBlob('image/png')
(async, off the main thread, several in flight) and POSTs the raw PNG bytes back to the same
server, which writes out/frames/%04d.png. This avoids pushing ~4 MB base64 strings per frame
through the DevTools protocol, which was the bottleneck (not drawing).
"""
import argparse, json, os, sys, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from multiprocessing import get_context

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = {'dir': os.path.join(HERE, 'out', 'frames')}

DRIVER = """async ({frames, inflight}) => {
  const cv = document.getElementById('c'); const pending = new Set();
  for (const i of frames) {
    window.renderFrame(i);
    const p = new Promise(res => cv.toBlob(res, 'image/png'))
      .then(b => fetch('/frame/' + i, { method: 'POST', body: b }))
      .then(r => { if (!r.ok) throw new Error('post ' + i + ' ' + r.status); });
    pending.add(p); p.finally(() => pending.delete(p));
    if (pending.size >= inflight) await Promise.race(pending);
  }
  await Promise.all(pending); return frames.length;
}"""


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=HERE, **k)
    def log_message(self, *a): pass
    def do_POST(self):
        if not self.path.startswith('/frame/'):
            self.send_error(404); return
        i = int(self.path.rsplit('/', 1)[1]); n = int(self.headers['Content-Length'])
        data = self.rfile.read(n)
        with open(os.path.join(OUT['dir'], '%04d.png' % i), 'wb') as f: f.write(data)
        self.send_response(204); self.end_headers()


def worker(args):
    frames, url, inflight, dump_events, ev_name = args
    from playwright.sync_api import sync_playwright
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1)
        pg.on('console', lambda m: errors.append(m.text) if m.type in ('error', 'warning') else None)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.goto(url)
        pg.wait_for_function('window.READY === true', timeout=60000)
        pg.evaluate(DRIVER, {'frames': frames, 'inflight': inflight})
        if dump_events:
            ev = pg.evaluate('window.EVENTS')
            for name in ev_name:
                with open(os.path.join(HERE, 'out', name), 'w') as f:
                    json.dump(ev, f, indent=1)
        b.close()
    return len(frames), errors


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--step', type=int, default=1)
    ap.add_argument('--start', type=int, default=0)
    ap.add_argument('--end', type=int, default=450)
    ap.add_argument('--frames', default=None)
    ap.add_argument('--out', default=OUT['dir'])
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--inflight', type=int, default=4)
    ap.add_argument('--query', default='', help='extra page query string, e.g. grain=1')
    ap.add_argument('--html', default='showreel.html', help='page to render (showreel.html = v1)')
    a = ap.parse_args()
    frames = [int(x) for x in a.frames.split(',') if x] if a.frames else list(range(a.start, a.end, a.step))
    OUT['dir'] = os.path.abspath(a.out)
    os.makedirs(OUT['dir'], exist_ok=True); os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
    srv = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = 'http://127.0.0.1:%d/%s%s' % (srv.server_address[1], a.html, ('?' + a.query) if a.query else '')
    stem = os.path.splitext(os.path.basename(a.html))[0]
    ev_name = ['events-%s.json' % stem] + (['events.json'] if a.html == 'showreel.html' else [])
    nw = max(1, min(a.workers, len(frames) // 5 or 1))
    jobs = [(frames[w::nw], url, a.inflight, w == 0, ev_name) for w in range(nw)]

    t0 = time.time()
    with get_context('spawn').Pool(nw) as pool:
        res = pool.map(worker, jobs)
    srv.shutdown()
    errs = [e for _, es in res for e in es]
    missing = [i for i in frames if not os.path.exists(os.path.join(OUT['dir'], '%04d.png' % i))]
    print('rendered %d frames with %d workers in %.1fs (missing: %d)' % (sum(n for n, _ in res), nw, time.time() - t0, len(missing)))
    if errs or missing:
        print('PAGE ERRORS:'); [print('  ', e) for e in errs[:20]]; sys.exit(1)
