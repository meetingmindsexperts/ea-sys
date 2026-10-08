import asyncio, json, subprocess, time
from playwright.async_api import async_playwright
import os
TESTS=os.path.dirname(os.path.abspath(__file__)); ROOT=os.path.dirname(TESTS)
MOCK=open(os.path.join(TESTS,'mock.js')).read()
PORT=8791
BASE=f'http://127.0.0.1:{PORT}/test.html'
async def mk(b, cfg, mobile=False, dark=False, extra_init=''):
    kw=dict(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True) if mobile else dict(viewport={'width':1360,'height':900})
    ctx=await b.new_context(color_scheme='dark' if dark else 'light',**kw); pg=await ctx.new_page(); logs=[]
    pg.on('console',lambda m: logs.append((m.type,m.text)) if m.type in ('error','warning') and '_blob' not in m.text and 'Failed to load resource' not in m.text else None)
    pg.on('pageerror',lambda e: logs.append(('pageerror',str(e))))
    pg.on('dialog', lambda d: (logs.append(('DIALOG',d.message)), asyncio.ensure_future(d.dismiss())))
    await pg.route('**/fonts.googleapis.com/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))
    init=extra_init
    if cfg is not None: init+=f'window.__MOCKCFG={json.dumps(cfg)};'+MOCK
    if init: await pg.add_init_script(init)
    await pg.goto(BASE); await pg.wait_for_timeout(500)
    return pg, logs
def serve():
    s=subprocess.Popen(['python3','-m','http.server',str(PORT),'-d',os.path.join(ROOT,'dist')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.6); return s
FILL="""(()=>{const S=__EB.S; S.path='both'; S.type='gala'; S.format='Hybrid'; __EB.applyPack();
 S.basics.title='Awards Night 2027'; S.basics.when='4 December 2026'; S.basics.attendance='450 + 2,000 online'; S.basics.purpose='Celebrate the best work of the year'; S.basics.audience='Nominees and partners';
 S.partners.has='yes'; S.partners.list=Array.from({length:12},(_,i)=>({name:'Partner '+(i+1),tier:'Exhibitor',notes:''})); S.online.access='Free registration'; S.delivery.deadline='2026-10-08';
 S.people.hosts=[{name:'Jane Doe',role:'Host',consent:'Not yet'}]; S.look.brand='yes'; S.look.brandLink='javascript:alert(1)'; S.files.drive='javascript:alert(2)';
 S.spaces[2].area='380'; S.spaces[2].cap='450'; __EB.goto(0);})()"""
