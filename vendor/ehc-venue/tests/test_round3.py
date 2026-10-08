import os, sys; TESTS = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(TESTS); sys.path.insert(0, TESTS); os.chdir(ROOT); os.makedirs('tests/out/shots', exist_ok=True)
import asyncio, json, subprocess, time
from playwright.async_api import async_playwright
ARGS=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']
MOCK=open('tests/mock.js').read()
FAKE_TTS="""(()=>{const q=[]; const S={get speaking(){return q.length>0}, get pending(){return q.length>1}, speak(u){q.push(u); (window.__spoken=window.__spoken||[]).push(u.text)}, cancel(){q.length=0}, getVoices(){return []}, onvoiceschanged:null};
 Object.defineProperty(window,'speechSynthesis',{value:S,configurable:true}); window.__ttsQ=q;})();"""
async def page(b, cfg, mobile=False):
    ctx=await b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True) if mobile else await b.new_context(viewport={'width':1280,'height':720})
    pg=await ctx.new_page(); logs=[]
    pg.on('pageerror',lambda e: logs.append(str(e))); pg.on('console',lambda m: logs.append(m.text) if m.type=='error' else None)
    await pg.route('**/fonts.googleapis.com/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))
    await pg.add_init_script(FAKE_TTS+f'window.__MOCKCFG={json.dumps(cfg)};'+MOCK)
    await pg.goto('http://127.0.0.1:8765/test.html'); await pg.wait_for_function('window.__EHC && window.__EHC.ready',timeout=60000)
    await pg.evaluate('__EHC.enter()'); await pg.wait_for_timeout(400)
    return pg, logs
ACT="JSON.stringify(Object.fromEntries(Object.entries(__EHC.team.act.zones).map(([k,v])=>[k,Math.round(v)])))"
async def main():
    srv=subprocess.Popen(['python3','-m','http.server','8765','-d','dist'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.6)
    R={}
    async with async_playwright() as p:
        b=await p.chromium.launch(args=ARGS)
        pg,logs=await page(b,{'sample':'ok','room':True,'owner':True}); ev=pg.evaluate
        inside="(id)=>{const a=document.activeElement; return !!a && document.getElementById(id).contains(a)}"
        # 1. Escape + focus for each panel
        res={}
        await pg.click('#bAgenda'); await pg.wait_for_timeout(150); res['agendaFocusIn']=await ev(inside,'agenda')
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(150); res['agendaClosed']=await ev("document.getElementById('agenda').hidden")
        await pg.click('#bTeam'); await pg.wait_for_timeout(400); res['teamFocusIn']=await ev(inside,'team')
        for _ in range(25): await pg.keyboard.press('Tab')
        res['teamTabStaysIn']=await ev(inside,'team')
        await pg.keyboard.press('Shift+Tab'); res['teamShiftTabStaysIn']=await ev(inside,'team')
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(150); res['teamClosed']=await ev("document.getElementById('team').hidden")
        await ev("__mock.setPeers([{peer:'pa',by:'u_a',presence:{v:1,x:1.5,z:24.5,y:0,yaw:3.14,mv:0,gt:0,sn:0,say:''}}])"); await pg.wait_for_timeout(300)
        await pg.click('#here'); await pg.wait_for_timeout(200); res['peopleFocusIn']=await ev(inside,'people')
        await pg.click('#peopleList .chip.warn'); await pg.wait_for_timeout(200); res['reportFocusIn']=await ev(inside,'report')
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(150); res['reportClosed']=await ev("document.getElementById('report').hidden")
        await ev("__EHC.team.openPeople()"); await pg.wait_for_timeout(100); await pg.mouse.click(5,5); await pg.wait_for_timeout(150); res['peopleBackdropClose']=await ev("document.getElementById('people').hidden")
        R['panels']=res
        # 2. device check cancel, and no activity counted
        await ev("__EHC.teleport('foyer')"); await pg.wait_for_timeout(300)
        before=json.loads(await ev(ACT)); pos=await ev("[__EHC.player.x,__EHC.player.z]")
        await ev("void(window.__chk=__EHC.team.deviceCheck())"); await pg.wait_for_timeout(1400)
        R['cancelLabel']=await ev("document.getElementById('checkClose').textContent")
        R['cancelVisible']=await ev("(()=>{const r=document.getElementById('checkClose').getBoundingClientRect(); return r.height>0 && r.bottom<=innerHeight && getComputedStyle(document.querySelector('#check .card')).pointerEvents})()")
        t0=time.time(); await pg.keyboard.press('Escape'); await pg.wait_for_function("!__EHC.team.checking",timeout=5000); R['cancelSeconds']=round(time.time()-t0,2)
        R['afterCancel']=await ev("({hidden:document.getElementById('check').hidden, label:document.getElementById('checkClose').textContent, toast:document.getElementById('toast3').textContent})")
        R['posRestored']=(await ev("[__EHC.player.x,__EHC.player.z]"))==pos
        await ev("void(window.__chk=__EHC.team.deviceCheck())"); await pg.wait_for_timeout(300); await pg.wait_for_function("!__EHC.team.checking",timeout=40000)
        after=json.loads(await ev(ACT))
        R['zonesGainedDuringCheck']={k:after.get(k,0)-before.get(k,0) for k in set(after)|set(before) if after.get(k,0)-before.get(k,0)>2}
        R['checkDone']=await ev("({verdict:__EHC.team.lastCheck&&__EHC.team.lastCheck.verdict, areas:__EHC.team.lastCheck&&__EHC.team.lastCheck.results.length})")
        await pg.click('#checkClose')
        # 3. many talkers: bubbles capped, voice queue capped, the person you're talking to always voiced
        peers=[{'peer':'p%d'%i,'by':'u%d'%i,'presence':{'v':1,'x':-4+(i%6)*1.6,'z':22+(i//6)*1.6,'y':0,'yaw':3.14,'mv':0,'gt':0,'sn':1,'say':'Hello number %d, a sentence.'%i}} for i in range(20)]
        await ev("__EHC.teleport('foyer'); __EHC.place(0,30,3.14)"); await ev("window.__spoken=[]; window.__ttsQ.length=0")
        quiet=json.loads(json.dumps(peers))
        for q in quiet: q['presence']['sn']=0; q['presence']['say']=''
        await ev(f"__mock.setPeers({json.dumps(quiet)})"); await pg.wait_for_timeout(400)
        await ev(f"__mock.setPeers({json.dumps(peers)})"); await pg.wait_for_timeout(600)
        await pg.wait_for_timeout(2500); R['bubblesTotal']=await ev("__EHC.social.bubbles.length"); R['shownVar']=await ev("__EHC.social.bubblesShown"); R['bubblesShown']=await ev("[...document.querySelectorAll('#bubbles .bubble')].filter(e=>e.style.display!=='none').length")
        R['voicesQueued']=await ev("window.__spoken.length"); R['voiceSkipped']=await ev("__EHC.social.voiceSkipped||0")
        R['targetVoiced']=await ev("(()=>{const S=__EHC.social, P=S.peers.get('p19'); S.open({kind:'peer',ref:P}); const n=__spoken.length; S.speak(P,'Over here.'); const ok=__spoken.length>n; S.close(); return ok})()")
        R['sizesCached']=await ev("__EHC.social.bubbles.filter(b=>b.shown).every(b=>b.w>0)")
        R['errors']=list(logs)
        await pg.close()
        # 4. phone: tap targets, consent wording, name sharing toggle in the guide, report failure wording
        pg,logs=await page(b,{'sample':'ok','room':True,'owner':False,'dbDeny':True},mobile=True); ev=pg.evaluate
        await ev("__mock.setPeers([{peer:'pa',by:'u_a',presence:{v:1,x:1.5,z:24.5,y:0,yaw:3.14,mv:0,gt:0,sn:1,say:'hi'}}])"); await pg.wait_for_timeout(400)
        R['m_consent']=await ev("document.querySelector('.consent').textContent.trim().slice(0,140)")
        R['m_hudHeights']=await ev("[...document.querySelectorAll('.tools .chip:not([hidden]), #here')].map(e=>[e.id,Math.round(e.getBoundingClientRect().height)])")
        await ev("__EHC.place(1.5,26,3.14)"); await pg.wait_for_timeout(300); await ev("__EHC.social.open({kind:'peer', ref:[...__EHC.social.peers.values()][0]})"); await pg.wait_for_timeout(300)
        R['m_chatHeights']=await ev("[...document.querySelectorAll('#cClose, .cfoot .chip:not([hidden]), .qchip, #cMod .chip')].map(e=>[e.id||e.textContent.slice(0,12),Math.round(e.getBoundingClientRect().height)])")
        await ev("__EHC.social.close()")
        await ev("__EHC.abil.walkToZone(__EHC.ZONES.find(z=>z.id==='plenary'))"); await pg.wait_for_timeout(300)
        R['m_stopHeight']=await ev("(()=>{const e=document.getElementById('modeStop'); return document.getElementById('modePill').hidden?null:Math.round(e.getBoundingClientRect().height)})()")
        await ev("__EHC.abil.stop()")
        await pg.click('#bAgenda'); await pg.wait_for_timeout(200)
        await pg.click('#shareName2'); await pg.wait_for_timeout(200)
        R['m_share']=await ev("({first:document.getElementById('shareName').checked, second:document.getElementById('shareName2').checked, saved:localStorage.getItem('ehc-share-name'), toast:document.getElementById('toast3').textContent})")
        R['m_guideHScroll']=await ev("document.querySelector('#agenda .card').scrollWidth>document.querySelector('#agenda .card').clientWidth+1")
        await pg.click('#aclose')
        await ev("__EHC.team.openReport([...__EHC.social.peers.values()][0])"); await pg.check('input[value="Spam or selling"]'); await pg.click('#reportSend'); await pg.wait_for_timeout(400)
        R['m_reportFail']=await ev("({msg:document.getElementById('reportMsg').textContent, copyShown:!document.getElementById('reportCopy').hidden})")
        R['m_reportText']=await ev("__EHC.team.reportText().split('\\n').slice(0,3)")
        R['m_hscroll']=await ev("document.documentElement.scrollWidth>innerWidth")
        R['m_errors']=list(logs)
        await b.close()
    srv.terminate(); print(json.dumps(R,indent=1,ensure_ascii=False)); json.dump(R,open('tests/out/round3.json','w'),indent=1,ensure_ascii=False)
asyncio.run(main())
