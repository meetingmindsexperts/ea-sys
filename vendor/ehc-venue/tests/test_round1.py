import os, sys; TESTS = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(TESTS); sys.path.insert(0, TESTS); os.chdir(ROOT); os.makedirs('tests/out/shots', exist_ok=True)
import asyncio, json, subprocess, time
from playwright.async_api import async_playwright
ARGS=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']
MOCK=open('tests/mock.js').read()
async def page(b, cfg, init=''):
    ctx=await b.new_context(viewport={'width':1280,'height':720}); pg=await ctx.new_page(); logs=[]
    pg.on('pageerror',lambda e: logs.append(str(e))); pg.on('console',lambda m: logs.append(m.text) if m.type=='error' else None)
    await pg.route('**/fonts.googleapis.com/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))
    await pg.add_init_script(init+f'window.__MOCKCFG={json.dumps(cfg)};'+MOCK)
    await pg.goto('http://127.0.0.1:8765/test.html'); await pg.wait_for_function('window.__EHC && window.__EHC.ready',timeout=60000)
    await pg.evaluate('__EHC.enter()'); await pg.wait_for_timeout(400)
    return pg, logs
async def main():
    srv=subprocess.Popen(['python3','-m','http.server','8765','-d','dist'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.6)
    R={}
    async with async_playwright() as p:
        b=await p.chromium.launch(args=ARGS)
        # A. impersonation
        pg,logs=await page(b,{'sample':'ok','room':True}); ev=pg.evaluate
        await ev("""__mock.setPeers([{peer:'pa',by:'u_a',presence:{v:1,x:1.5,z:24.5,y:0,yaw:3.14,mv:0,gt:0,sn:0,say:''}},{peer:'px',by:null,guest:true,presence:{v:1,uid:'u_a',x:-2,z:23,y:0,yaw:1.2,mv:0,gt:0,sn:0,say:''}}])""")
        await pg.wait_for_timeout(500)
        R['names']=await ev("[...__EHC.social.peers.values()].map(p=>[p.peer,p.id,p.name])")
        await ev("__EHC.social.setBlocked(__EHC.social.peers.get('px'), true)")
        await ev("""__mock.setPeers([{peer:'pa',by:'u_a',presence:{v:1,x:1.5,z:24.5,y:0,yaw:3.14,mv:0,gt:0,sn:0,say:''}},{peer:'px',by:null,guest:true,presence:{v:1,uid:'u_a',x:-2,z:23,y:0,yaw:1.2,mv:0,gt:0,sn:0,say:''}}])"""); await pg.wait_for_timeout(300)
        R['afterBlockingImpostor']=await ev("[[...__EHC.social.peers.values()].map(p=>p.name), [...__EHC.social.blocked]]")
        R['errorsA']=logs; await pg.context.close()
        # B. contributor under owner-only read rules: report + activity history
        seed="if(!localStorage.getItem('ehc-act-u_me'))localStorage.setItem('ehc-act-u_me', JSON.stringify({v:1,sessions:4,first:1,zones:{foyer:500,plenary:120},questions:{plenary:2},stands:{},speakerQs:1,chats:3,photos:1}));"
        pg,logs=await page(b,{'sample':'ok','room':True,'owner':False,'rules':True},seed); ev=pg.evaluate
        await pg.wait_for_timeout(300)
        R['loadedSessions']=await ev("__EHC.team.act.sessions")
        await ev("(async()=>{__EHC.team.dirty=true; await __EHC.team.saveNow();})()"); await pg.wait_for_timeout(200)
        R['savedDoc']=await ev("(()=>{const d=__store['analytics/u_me']; return d&&{sessions:d.sessions,zones:d.zones,questions:d.questions,chats:d.chats}})()")
        await ev("""__mock.setPeers([{peer:'pa',by:'u_a',presence:{v:1,x:1.5,z:24.5,y:0,yaw:3.14,mv:0,gt:0,sn:1,say:'rude words'}}])"""); await pg.wait_for_timeout(400)
        await ev("__EHC.team.openReport(__EHC.social.peers.get('pa'))"); await pg.check('input[value="Offensive language"]'); await pg.click('#reportSend'); await pg.wait_for_timeout(400)
        await ev("__EHC.team.openReport(__EHC.social.peers.get('pa'))"); await pg.check('input[value="Spam or selling"]'); await pg.click('#reportSend'); await pg.wait_for_timeout(400)
        R['reportMsg']=await ev("document.getElementById('reportMsg').textContent")
        R['reportKeys']=await ev("Object.keys(__store).filter(k=>k.startsWith('reports'))")
        store=await ev("JSON.stringify(__store)")
        R['presenceKeys']=await ev("Object.keys((__mock.presence||[]).slice(-1)[0]||{})")
        await ev("__EHC.team.saveNow()"); await pg.reload(); await pg.wait_for_function('window.__EHC && window.__EHC.ready',timeout=60000); await pg.wait_for_timeout(500)
        R['secondVisitSessions']=await ev("__EHC.team.act.sessions")
        R['errorsB']=logs; await pg.context.close()
        # C. owner reads reports (new structure + a legacy one)
        pg,logs=await page(b,{'sample':'ok','room':True,'owner':True},f"window.__seed={store};"); ev=pg.evaluate
        await ev("Object.assign(__store, window.__seed); __store['reports/u_old']={uid:'u_old',items:[{at:1,reason:'Something else',who:{name:'Old'},said:[]}]}")
        await pg.click('#bTeam'); await pg.wait_for_timeout(300); await pg.click('[data-tteam=reports]'); await pg.wait_for_timeout(500)
        R['ownerReports']=await ev("[...document.querySelectorAll('#tReports .rcard .pn')].map(e=>e.textContent.split(' · ')[0])")
        R['errorsC']=logs
        await b.close()
    srv.kill(); print(json.dumps(R,indent=1))
asyncio.run(main())
