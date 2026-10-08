import os, sys; TESTS = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(TESTS); sys.path.insert(0, TESTS); os.chdir(ROOT); os.makedirs('tests/out/shots', exist_ok=True)
import asyncio, json, subprocess, time, os, statistics
from playwright.async_api import async_playwright
ARGS=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']
ZONES=['foyer','plenary','posters','hallA','hallB','hallC','workshop','promenade','lounge','expo']
async def run_profile(b, mobile, rep, logs):
    ctx=await b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True) if mobile else await b.new_context(viewport={'width':1280,'height':720})
    pg=await ctx.new_page(); tag='mobile' if mobile else 'desktop'
    pg.on('console',lambda m: logs.append((tag,m.type,m.text)) if m.type in ('error','warning') else None)
    pg.on('pageerror',lambda e: logs.append((tag,'pageerror',str(e))))
    await pg.route('**/fonts.googleapis.com/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))
    await pg.route('**/venue-fonts/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))  # EA-SYS: fonts are served by EA-SYS, not by this bare test server
    t0=time.time(); await pg.goto('http://127.0.0.1:8765/test.html'); await pg.wait_for_function('window.__EHC && window.__EHC.ready',timeout=60000)
    ready=await pg.evaluate('__EHC.stats.readyAt'); await pg.evaluate('__EHC.enter()')
    perf={}
    for z in ZONES:
        await pg.evaluate(f'__EHC.teleport("{z}")'); await pg.wait_for_timeout(400)
        m=json.loads(await pg.evaluate('''new Promise(r=>{const E=__EHC,t0=performance.now(),f0=E.stats.frames,sim=[],drw=[];const iv=setInterval(()=>{sim.push(E.stats.simMs);drw.push(E.stats.drawMs)},50);setTimeout(()=>{clearInterval(iv);const med=a=>a.sort((x,y)=>x-y)[a.length>>1];const st=document.getElementById('stats').textContent;r(JSON.stringify({swFps:(E.stats.frames-f0)/((performance.now()-t0)/1000),simMs:med(sim),drawCpuMs:med(drw),hud:st}))},4000)})'''))
        perf[z]={'softwareFps':round(m['swFps'],2),'cpuLogicMs':round(m['simMs'],2),'cpuRenderSubmitMs':round(m['drawCpuMs'],2),'hud':m['hud']}
        await pg.screenshot(path=f'tests/out/shots/v_{tag}_{z}.png')
    rep[tag]={'readyMs':round(ready),'perZone':perf}
    if not mobile:
        # logic cost per frame (hardware independent): time the simulation + crowd update in isolation
        rep['logicMsPerFrame']=await pg.evaluate('''(()=>{const E=__EHC; E.teleport('foyer'); const t=performance.now(); for(let i=0;i<600;i++) E.sim(1,{x:Math.sin(i/40),y:1,run:true}); return +((performance.now()-t)/600).toFixed(3)})()''')
        rep['verify']=json.loads(await pg.evaluate(open('tests/verify.js').read()))
        # interactables: walk next to each and open its panel
        hs=json.loads(await pg.evaluate('JSON.stringify(__EHC.W.interact.map(h=>({id:h.id,x:h.x,z:h.z,r:h.r})))'))
        ok=0; fails=[]
        for h in hs:
            found=await pg.evaluate(f'''(()=>{{const E=__EHC,h={json.dumps(h)};for(let k=0;k<200;k++){{const a=k*2.399,d=Math.min(h.r*0.85,0.3+k*0.02),x=h.x+Math.cos(a)*d,z=h.z+Math.sin(a)*d;if(!E.CW.inside(x,1,z,0.38)&&!E.social.ctx.crowd().list.some(q=>!q.queued&&Math.hypot(q.x-x,q.z-z)<d+0.15)){{E.place(x,z,0);return true}}}}return false}})()''')
            got=await pg.evaluate('__EHC.openNear()'); vis=await pg.evaluate("!document.getElementById('info').hidden")
            await pg.evaluate('__EHC.closeSheets()')
            if found and got==h['id'] and vis: ok+=1
            else: fails.append(h['id'])
        rep['interactables']={'count':len(hs),'opened':ok,'failed':fails}
    await ctx.close()
async def main():
    srv=subprocess.Popen(['python3','-m','http.server','8765','-d','dist'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.6)
    rep={'pageBytes':os.path.getsize('dist/index.html')}; logs=[]
    async with async_playwright() as p:
        b=await p.chromium.launch(args=ARGS)
        await run_profile(b,False,rep,logs); await run_profile(b,True,rep,logs)
        await b.close()
    srv.terminate()
    rep['consoleErrors']=[l for l in logs if l[1] in ('error','pageerror')]; rep['consoleWarnings']=[l for l in logs if l[1]=='warning']
    json.dump(rep,open('tests/out/verify_report.json','w'),indent=1); print(json.dumps(rep,indent=1))
asyncio.run(main())
