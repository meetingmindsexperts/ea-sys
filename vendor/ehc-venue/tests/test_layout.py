# EA-SYS (phase 6): venues generated from an event's rooms, walked by the venue's own checks.
# Each layout in tests/fixtures/layouts/ (written by EA-SYS: npm run venue:fixtures) is loaded as
# window.EHC_LAYOUT and checked by tests/layout_verify.js: random walk, wall push, every doorway,
# every room-to-room route, camera, every hotspot opened; and no console errors.
import os, sys; TESTS = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(TESTS); sys.path.insert(0, TESTS); os.chdir(ROOT)
import asyncio, glob, json, subprocess, time
from playwright.async_api import async_playwright
ARGS=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']
MOCK=open('tests/mock.js').read()
VERIFY=open('tests/layout_verify.js').read()
PORT=8796
async def run(b, path, logs):
    name=os.path.basename(path)[:-5]
    ctx=await b.new_context(viewport={'width':1280,'height':720}); pg=await ctx.new_page()
    # Errors only, as in test_abilities and test_social: with the mock runtime loaded, EHC's own venue also
    # logs SwiftShader driver warnings ("GPU stall due to ReadPixels"), so they say nothing about a layout.
    pg.on('console',lambda m: logs.append((name,m.type,m.text)) if m.type == 'error' else None)
    pg.on('pageerror',lambda e: logs.append((name,'pageerror',str(e))))
    await pg.route('**/fonts.googleapis.com/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))
    await pg.route('**/venue-fonts/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))
    await pg.add_init_script('window.EHC_LAYOUT='+open(path).read()+';window.__MOCKCFG={sample:"ok",room:true,owner:true};'+MOCK)
    await pg.goto(f'http://127.0.0.1:{PORT}/test.html'); await pg.wait_for_function('window.__EHC && window.__EHC.ready',timeout=60000)
    # The start sheet names this venue's own rooms, not EHC's ballroom and three halls.
    intro=await pg.evaluate("document.getElementById('startIntro').textContent")
    rooms=[z['name'] for z in json.load(open(path))['zones'] if z['kind']!='corridor']
    introOk=all(r in intro for r in rooms) and 'ballroom' not in intro
    await pg.evaluate('__EHC.enter()'); await pg.wait_for_timeout(300)
    rep=json.loads(await pg.evaluate(VERIFY))
    rep['zonesMatch']=await pg.evaluate('JSON.stringify(ZONES.map(z=>z.id))')==json.dumps([z['id'] for z in json.load(open(path))['zones']],separators=(',',':'))
    rep['introNamesRooms']=introOk
    await ctx.close()
    return name, rep
async def main():
    srv=subprocess.Popen(['python3','-m','http.server',str(PORT),'-d','dist'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.6)
    R={'layouts':{}}; logs=[]
    try:
        async with async_playwright() as p:
            b=await p.chromium.launch(args=ARGS)
            for path in sorted(glob.glob('tests/fixtures/layouts/*.json')):
                name, rep = await run(b, path, logs); R['layouts'][name]=rep
            await b.close()
    finally: srv.kill()
    R['errors']=logs
    print(json.dumps(R))
asyncio.run(main())
