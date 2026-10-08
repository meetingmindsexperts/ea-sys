"""Build the EHC 2026 online venue into one self-contained page.

    python3 build.py

Writes dist/index.html (the page to host), dist/test.html (the same page with the test API
switched on, used by the browser tests) and dist/screens.json (recordings per screen).
No dependencies beyond Python 3. Module order matters: each file uses what the ones before define.
"""
import os, shutil
ROOT = os.path.dirname(os.path.abspath(__file__))
ORDER = ['engine', 'textures', 'world', 'chars', 'physics', 'audio', 'filter', 'social', 'abilities', 'team', 'game']
src = lambda f: open(os.path.join(ROOT, 'src', f), encoding='utf-8').read()
js = '\n'.join(src(n + '.js') for n in ORDER)
page = src('shell.html') + '\n<script>\n' + js + '\n</script>\n'
dist = os.path.join(ROOT, 'dist'); os.makedirs(dist, exist_ok=True)
open(os.path.join(dist, 'index.html'), 'w', encoding='utf-8').write(page)
open(os.path.join(dist, 'test.html'), 'w', encoding='utf-8').write(
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
    '<style>body{margin:0}[hidden]{display:none!important}</style><script>window.__EHC_TEST=1</script></head><body>' + page + '</body></html>')
screens = os.path.join(ROOT, 'screens.json')
if not os.path.exists(screens): open(screens, 'w').write('{}\n')
shutil.copy(screens, os.path.join(dist, 'screens.json'))
print(len(page.encode()), 'bytes -> dist/index.html')
