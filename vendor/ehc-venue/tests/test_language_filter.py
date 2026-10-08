import os, sys; TESTS = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(TESTS); sys.path.insert(0, TESTS); os.chdir(ROOT); os.makedirs('tests/out/shots', exist_ok=True)
import asyncio, json, subprocess, time
from playwright.async_api import async_playwright
ARGS=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']
MOCK=open('tests/mock.js').read()
async def page(b, cfg, mobile=False):
    ctx=await b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True) if mobile else await b.new_context(viewport={'width':1280,'height':720})
    pg=await ctx.new_page(); logs=[]
    pg.on('pageerror',lambda e: logs.append(str(e))); pg.on('console',lambda m: logs.append(m.text) if m.type=='error' else None)
    await pg.route('**/fonts.googleapis.com/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))
    await pg.route('**/venue-fonts/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))  # EA-SYS: fonts are served by EA-SYS, not by this bare test server
    await pg.add_init_script(f'window.__MOCKCFG={json.dumps(cfg)};'+MOCK)
    await pg.goto('http://127.0.0.1:8765/test.html'); await pg.wait_for_function('window.__EHC && window.__EHC.ready',timeout=60000)
    await pg.evaluate('__EHC.enter()'); await pg.wait_for_timeout(400)
    return pg, logs
SAY=lambda sn,txt: """__mock.setPeers([{peer:'pa',by:'u_a',presence:{v:1,x:1.5,z:24.5,y:0,yaw:3.14,mv:0,gt:0,sn:%d,say:%s}}])""" % (sn, json.dumps(txt))
async def main():
    srv=subprocess.Popen(['python3','-m','http.server','8765','-d','dist'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.6)
    R={}
    async with async_playwright() as p:
        b=await p.chromium.launch(args=ARGS)
        pg,logs=await page(b,{'sample':'ok','room':True,'owner':True}); ev=pg.evaluate
        await ev(SAY(0,'')); await pg.wait_for_timeout(300)
        await ev("__EHC.place(1.5,26,3.14); __EHC.setView(0,0.3,4)"); await pg.wait_for_timeout(300)
        # EA-SYS: wait until the venue offers "Talk to Lina" before pressing E; a fixed 300 ms wait failed about two runs in three.
        await pg.wait_for_function("__EHC.nearP && __EHC.nearP.kind==='peer'", timeout=10000); await pg.keyboard.press('e'); await pg.wait_for_function("!document.getElementById('chat').hidden", timeout=5000)
        for i,t in enumerate(['hello there','you f.u.c.k.i.n.g idiot','ya sharmoota','this is bullshit','see you at the cocktail reception']):
            await ev(SAY(i+1,t)); await pg.wait_for_timeout(350)
        R['logShown']=await ev("[...document.querySelectorAll('#cLog .msg .mt')].map(e=>e.textContent)")
        R['bubbles']=await ev("[...document.querySelectorAll('#bubbles .bubble')].map(e=>e.textContent)")
        R['flagged']=await ev("__EHC.social.peers.get('pa').flagged")
        R['toast']=await ev("document.getElementById('toast3').textContent")
        # outgoing
        await pg.fill('#cInput','what the shit is this'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(300)
        R['outgoingPresence']=await ev("(__mock.presence||[]).slice(-1)[0].say")
        await pg.keyboard.press('Escape')
        # owner sets hide mode + extra word
        await pg.click('#bTeam'); await pg.wait_for_timeout(300); await pg.click('[data-tteam=language]'); await pg.wait_for_timeout(200)
        await pg.check('input[name=lfMode][value=hide]'); await pg.fill('#lfExtra','rubbish'); await pg.fill('.lfTest','what rubbish talk'); await pg.wait_for_timeout(150)
        R['preview']=await ev("document.querySelector('#tLanguage .lfTest').nextElementSibling.textContent")
        await pg.click('#tLanguage .primary'); await pg.wait_for_timeout(300)
        R['saved']=await ev("JSON.stringify(__store['config/filter'])"); R['saveMsg']=await ev("document.querySelector('#tLanguage [role=status]').textContent")
        await pg.screenshot(path='tests/out/shots/lf_panel.png')
        await pg.click('#teamClose')
        store=await ev("JSON.stringify(__store)")
        R['errors']=logs; await pg.context.close()
        # an attendee picks up the owner's settings (hide mode)
        pg,logs=await page(b,{'sample':'ok','room':True,'owner':False}); ev=pg.evaluate
        await ev(f"Object.assign(__store,{store}); __EHC.team.loadFilter()"); await pg.wait_for_timeout(300)
        R['attendeeCfg']=await ev("__EHC.social.filter.cfg.mode")
        await ev(SAY(0,'')); await pg.wait_for_timeout(300); await ev("__EHC.place(1.5,26,3.14); __EHC.setView(0,0.3,4)"); await pg.wait_for_timeout(300)
        R['attendeeNear']=await ev("[(__EHC.nearP||{}).label, document.activeElement.tagName]")
        await ev("__EHC.social.open({kind:'peer', ref:__EHC.social.peers.get('pa'), d:1})"); await pg.wait_for_timeout(300)
        await ev(SAY(1,'total rubbish')); await pg.wait_for_timeout(400)
        R['hiddenLog']=await ev("[...document.querySelectorAll('#cLog .msg .mt')].map(e=>e.textContent)")
        await pg.fill('#cInput','damn this f*ck'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(300)
        R['outgoingBlocked']=await ev("[document.querySelector('#cLog .msg.sys:last-child .mt')?.textContent, (__mock.presence||[]).slice(-1)[0]?.say]")
        R['errors2']=logs
        await pg.context.close()
        pg,logs=await page(b,{'sample':'ok','room':True,'owner':True},mobile=True)
        await pg.tap('#bTeam'); await pg.wait_for_timeout(300); await pg.tap('[data-tteam=language]'); await pg.wait_for_timeout(200)
        R['m_hscroll']=await pg.evaluate("document.documentElement.scrollWidth>innerWidth"); await pg.screenshot(path='tests/out/shots/lf_m_panel.png'); R['m_errors']=logs
        await b.close()
    srv.kill(); print(json.dumps(R,indent=1,ensure_ascii=False))
asyncio.run(main())
