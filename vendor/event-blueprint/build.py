"""Build the Event Blueprint into one self-contained page.

    python3 build.py

Writes dist/index.html (the page to host) and dist/test.html (the same page in a bare
HTML shell, used by the browser tests). No dependencies beyond Python 3.
"""
import os
ROOT = os.path.dirname(os.path.abspath(__file__))
src = lambda f: open(os.path.join(ROOT, 'src', f), encoding='utf-8').read()
js = '\n'.join(src(f) for f in ('data.js', 'bench.js', 'platform.js', 'app.js'))
page = src('part1.html') + '\n<script>\n' + js + '\n</script>\n'
os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
open(os.path.join(ROOT, 'dist', 'index.html'), 'w', encoding='utf-8').write(page)
open(os.path.join(ROOT, 'dist', 'test.html'), 'w', encoding='utf-8').write(
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
    '<style>body{margin:0}[hidden]{display:none!important}</style></head><body>' + page + '</body></html>')
print(len(page.encode()), 'bytes -> dist/index.html')
