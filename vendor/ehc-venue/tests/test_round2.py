import os, sys; TESTS = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(TESTS); sys.path.insert(0, TESTS); os.chdir(ROOT); os.makedirs('tests/out/shots', exist_ok=True)
import asyncio, json, subprocess, time
from playwright.async_api import async_playwright
ARGS=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required']
MOCK=open('tests/mock.js').read(); VID=open('tests/fixtures/test.webm','rb').read()
async def page(b, cfg, mobile=False):
    ctx=await b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True) if mobile else await b.new_context(viewport={'width':1280,'height':720})
    pg=await ctx.new_page(); logs=[]
    pg.on('pageerror',lambda e: logs.append(str(e))); pg.on('console',lambda m: logs.append(m.text) if m.type=='error' else None)
    await pg.route('**/fonts.googleapis.com/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))
    await pg.route('**/screens.json',lambda r: r.fulfill(status=200,body=json.dumps({'plenary-main':{'url':'rec/opening.webm','title':'Opening'}}),content_type='application/json'))
    await pg.route('**/rec/opening.webm',lambda r: r.fulfill(status=200,body=VID,content_type='video/webm'))
    await pg.add_init_script(f'window.__MOCKCFG={json.dumps(cfg)};'+MOCK)
    await pg.goto('http://127.0.0.1:8765/test.html'); await pg.wait_for_function('window.__EHC && window.__EHC.ready',timeout=60000)
    await pg.evaluate('__EHC.enter()'); await pg.wait_for_timeout(400)
    return pg, logs
async def main():
    srv=subprocess.Popen(['python3','-m','http.server','8765','-d','dist'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.6)
    R={}
    async with async_playwright() as p:
        b=await p.chromium.launch(args=ARGS)
        pg,logs=await page(b,{'sample':'ok','room':False,'owner':True}); ev=pg.evaluate
        # 3. hostile activity records
        st=await ev("__EHC.W.interact.find(h=>/booth-Gold/.test(h.id)).id")
        await ev("""(st)=>{__store['analytics/u_a']={named:true,name:{x:1},stands:{toString:{visits:9},'%s':null,valueOf:5},zones:{constructor:5,foyer:'x',expo:120},questions:{__proto__:{a:1},expo:-3}};
          __store['analytics/u_b']={named:true,name:'Dana',stands:{[st]:{visits:2,sec:60,opens:1}},zones:{expo:300},questions:{expo:2}}; __store['analytics/u_c']='junk';}""".replace("'%s'","[st]"), st)
        await pg.click('#bTeam'); await pg.wait_for_timeout(600)
        R['activityRows']=await ev("[...document.querySelectorAll('#tActivity table tbody tr')].map(r=>r.textContent)")
        R['summary']=await ev("document.querySelector('#tActivity p').textContent.slice(0,60)")
        await pg.click('#teamClose')
        R['errors3']=list(logs)
        # 5. plenary side position: shared video keeps playing
        await ev("__EHC.teleport('plenary'); __EHC.place(-21,-40,0)"); await pg.wait_for_timeout(6000)
        R['sideVideo']=await ev("(()=>{const v=Object.values(__EHC.team.videos)[0]; return v&&{paused:v.el.paused, frames:__EHC.team.framesDrawn||0}})()")
        # 4. sound on, then teleport away
        await ev("__EHC.place(0,-30,3.14)"); await pg.wait_for_timeout(1500)
        R['soundOn']=await ev("__EHC.team.toggleSound(0)")
        await ev("__EHC.teleport('expo')"); await pg.wait_for_timeout(9000)
        R['afterLeaving']=await ev("(()=>{const v=Object.values(__EHC.team.videos)[0]; return {paused:v.el.paused, muted:v.el.muted, sound:v.sound}})()")
        # sound toggled during a paused panel is not cancelled when the panel closes
        await ev("__EHC.teleport('plenary'); __EHC.place(0,-34,3.14)"); await pg.wait_for_timeout(2500)
        await ev("(()=>{const T=__EHC.team,v=Object.values(T.videos)[0]; if(v.sound) T.toggleSound(0);})()"); await ev("document.getElementById('info').hidden=false"); await ev("__EHC.team.toggleSound(0)"); await pg.wait_for_timeout(2000); await ev("__EHC.closeSheets()"); await pg.wait_for_timeout(2000)
        R['soundSurvivesPanel']=await ev("(()=>{const v=Object.values(__EHC.team.videos)[0]; return {sound:v.sound, muted:v.el.muted, paused:v.el.paused}})()")
        # 6. photo while queuing
        await ev("window.__EHC_HOLD=true")
        R['queuePhoto']=await ev("""(async()=>{const E=__EHC,A=E.abil,q=A.queues.find(q=>q.id==='coffee'); E.teleport('lounge'); const tail=q.slots[Math.min(q.line.length,q.slots.length-1)]; E.place(tail[0]+1.2,tail[1]+1.2); E.tick(1);
          A.joinQueue(q); E.tick(60); window.__EHC_HOLD=false; await A.photo(); document.getElementById('photoClose').click(); window.__EHC_HOLD=true;
          const modeAfter=A.mode, inLine=q.line.includes('P'); let t=0; while(A.mode==='queue'&&t<6000){E.tick(30);t+=30;}
          return {modeAfterPhoto:modeAfter, stillInLine:inLine, served:A.served_||0, item:E.player.item, secs:t/60};})()""")
        R['stopLeavesQueue']=await ev("""(()=>{const E=__EHC,A=E.abil,q=A.queues.find(q=>q.id==='reg'); E.teleport('foyer'); const tail=q.slots[Math.min(q.line.length,q.slots.length-1)]; E.place(tail[0]+1.2,tail[1]+1.2); E.tick(1); A.joinQueue(q); E.tick(30); A.mode='photo'; A.stop(); return {inLine:q.line.includes('P'), player:q.player, canRejoin:!!(E.tick(1), A.nearQueue())};})()""")
        await ev("window.__EHC_HOLD=false")
        # 7. venue guide
        await ev("__EHC.teleport('plenary')"); await pg.wait_for_timeout(300)
        await pg.click('#bAgenda'); await pg.wait_for_timeout(300)
        R['guide']=await ev("""(()=>{const cur=document.querySelector('.arow.cur'), rows=[...document.querySelectorAll('.arow')]; const r=rows[1]; const w=r.querySelector('.go.walk').getBoundingClientRect(), g=r.querySelector('.go:not(.walk)').getBoundingClientRect(); const cs=getComputedStyle(r.querySelector('.go.walk'));
          return {curRow:cur&&cur.querySelector('.t').textContent, curPosition:getComputedStyle(cur).position, sameLine:Math.abs(w.top-g.top)<2, walkColor:cs.color, intro:document.querySelector('#agenda p.small').textContent.slice(0,60)}})()""")
        await pg.screenshot(path='tests/out/shots/r2_guide.png')
        R['errors']=logs; await pg.context.close()
        pg,logs=await page(b,{'sample':'ok','room':False},mobile=True)
        await pg.tap('#bAgenda'); await pg.wait_for_timeout(300)
        R['m_guide']=await pg.evaluate("(()=>{const r=[...document.querySelectorAll('.arow')][1]; const w=r.querySelector('.go.walk').getBoundingClientRect(), g=r.querySelector('.go:not(.walk)').getBoundingClientRect(); return {sameLine:Math.abs(w.top-g.top)<2, hscroll:document.documentElement.scrollWidth>innerWidth, walkH:Math.round(w.height)}})()")
        await pg.screenshot(path='tests/out/shots/r2_m_guide.png'); R['m_errors']=logs
        await b.close()
    srv.kill(); print(json.dumps(R,indent=1))
asyncio.run(main())
