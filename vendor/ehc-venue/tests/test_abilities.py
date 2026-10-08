import os, sys; TESTS = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(TESTS); sys.path.insert(0, TESTS); os.chdir(ROOT); os.makedirs('tests/out/shots', exist_ok=True)
import asyncio, json, subprocess, time
from playwright.async_api import async_playwright
ARGS=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']
MOCK=open('tests/mock.js').read()
async def page(b, mobile=False):
    ctx=await b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True) if mobile else await b.new_context(viewport={'width':1280,'height':720})
    pg=await ctx.new_page(); logs=[]
    pg.on('console',lambda m: logs.append((m.type,m.text)) if m.type in ('error',) else None)
    pg.on('pageerror',lambda e: logs.append(('pageerror',str(e))))
    await pg.route('**/fonts.googleapis.com/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))
    await pg.route('**/venue-fonts/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))  # EA-SYS: fonts are served by EA-SYS, not by this bare test server
    await pg.add_init_script("window.__MOCKCFG={sample:'ok',room:true};"+MOCK)
    await pg.goto('http://127.0.0.1:8765/test.html'); await pg.wait_for_function('window.__EHC && window.__EHC.ready',timeout=60000)
    await pg.evaluate('__EHC.enter()'); await pg.wait_for_timeout(400)
    return pg, logs
async def main():
    srv=subprocess.Popen(['python3','-m','http.server','8765','-d','dist'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.6)
    R={}
    async with async_playwright() as p:
        b=await p.chromium.launch(args=ARGS)
        pg,logs=await page(b)
        ev=pg.evaluate
        await ev("window.__EHC_HOLD=true")
        # ---- SIT in plenary and lounge sofa
        R['sit']=await ev("""(()=>{const E=__EHC,A=E.abil,out=[];
          for(const zid of ['plenary','lounge','workshop']){ E.teleport(zid); const Z=E.ZONES.find(z=>z.id===zid);
            const s=E.W.seats.filter(s=>{const [x0,z0,x1,z1]=Z.rect;return s.x>x0&&s.x<x1&&s.z>z0&&s.z<z1&&!A.occupied.has(s.x.toFixed(2)+','+s.z.toFixed(2))})[0];
            if(!s){out.push({zid,seat:null});continue;}
            const yaw=s.yaw; E.place(s.x+Math.sin(yaw)*0.9,s.z+Math.cos(yaw)*0.9);
            const before=[E.player.x,E.player.z]; const penBefore=+E.penetration().toFixed(3); A.sit(); const seated=A.mode==='sit', onSeat=Math.hypot(E.player.x-s.x,E.player.z-s.z)<0.01;
            E.tick(60); const still=Math.hypot(E.player.x-s.x,E.player.z-s.z)<0.01;
            const btn=document.getElementById('aSit').textContent;
            A.stand(); const back=Math.hypot(E.player.x-before[0],E.player.z-before[1])<0.01;
            out.push({zid,penBefore,sofa:!!s.sofa,seated,onSeat,heldStill:still,btn,stoodBack:back,mode:A.mode,pen:+E.penetration().toFixed(3)});}
          return out;})()""")
        # occupied seats refused
        R['occupiedSeatsTracked']=await ev("__EHC.abil.occupied.size")
        # sit then press W cancels (stands)
        R['moveStands']=await ev("""(()=>{const E=__EHC,A=E.abil; E.teleport('lounge'); const s=E.W.seats.find(s=>s.sofa); E.place(s.x+Math.sin(s.yaw)*0.9,s.z+Math.cos(s.yaw)*0.9); A.sit(); E.input.keys.add('f'); E.tick(2); E.input.keys.clear(); return A.mode===null})()""")
        # ---- GESTURES
        R['gestures']=await ev("""(()=>{const E=__EHC,A=E.abil,o={}; E.teleport('foyer'); for(const g of ['wave','heart','clap','raise']){A.gesture(g); o[g]=E.player.gesture;} return o;})()""")
        R['clapFoyer']=await ev("__EHC.abil.lastClap")
        await ev("__EHC.teleport('plenary')"); await ev("__EHC.abil.gesture('clap')")
        R['clapPlenary']=await ev("__EHC.abil.lastClap")
        R['crowdInPlenary']=await ev("__EHC.social.ctx.crowd().list.filter(p=>{const Z=__EHC.ZONES[1];return p.x>Z.rect[0]&&p.x<Z.rect[2]&&p.z>Z.rect[1]&&p.z<Z.rect[3]}).length")
        await ev("window.__EHC_HOLD=false")
        await ev("__EHC.abil.gesture('raise')"); await pg.wait_for_timeout(3600)
        R['speakerAnswered']=await ev("__EHC.abil.speakerAnswered||0")
        R['speakerChatOpen']=await ev("!document.getElementById('chat').hidden")
        R['speakerChatTag']=await ev("document.getElementById('cTag').textContent")
        await pg.screenshot(path='tests/out/shots/a_raise.png')
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
        await ev("window.__EHC_HOLD=true")
        # ---- QUEUES
        R['queues']=await ev("""(()=>{const E=__EHC,A=E.abil,out=[];
          for(const q of A.queues){ const zid=q.id==='reg'?'foyer':'lounge'; E.teleport(zid);
            const n=q.members.filter(m=>m.state==='queue').length, tail=q.slots[Math.min(n,q.slots.length-1)];
            E.place(tail[0]+1.2,tail[1]+1.2); E.tick(1); A.updateContext(null);
            const nq=A.nearQueue(); const offered=document.getElementById('aCtx').textContent;
            if(!nq){out.push({id:q.id,offered:false});continue;}
            A.joinQueue(nq); const pos=q.player; let t=0, maxPen=0;
            while(A.mode==='queue'&&t<6000){E.tick(30);t+=30; maxPen=Math.max(maxPen,E.penetration());}
            out.push({id:q.id,offered,startPos:pos,secondsInQueue:+(t/60).toFixed(1),item:q.item==='coffee'?E.player.item:(E.player.badgeCollected?'badge':null),servedBy:A.lastServer,maxPen:+maxPen.toFixed(3),membersCycling:q.members.length});}
          out.served=A.served_; return out;})()""")
        R['served']=await ev("__EHC.abil.served_")
        await ev("window.__EHC_HOLD=false; __EHC.setView(__EHC.player.yaw+2.4,0.2,3.2)"); await pg.wait_for_timeout(1800); await pg.screenshot(path='tests/out/shots/a_coffee.png')
        await ev("(()=>{const E=__EHC,A=E.abil; E.teleport('plenary'); const s=E.W.seats.filter(s=>s.z<-6&&s.z>-12&&Math.abs(s.x)<6&&!A.occupied.has(s.x.toFixed(2)+','+s.z.toFixed(2)))[0]; E.place(s.x,s.z+0.9); A.sit(); E.setView(s.yaw-Math.PI+0.6,0.15,3.4);})()"); await pg.wait_for_timeout(1500); await ev("__EHC.abil.gesture('clap')"); await pg.wait_for_timeout(1200); await pg.screenshot(path='tests/out/shots/a_sit_clap.png')
        await ev("__EHC.abil.stand(); window.__EHC_HOLD=true")
        # ---- WALK ME THERE: foyer -> every zone
        R['walk']=await ev("""(()=>{const E=__EHC,A=E.abil,out=[];
          for(const Z of E.ZONES){ if(Z.id==='foyer')continue; E.teleport('foyer'); A.snaps=0; A.arrived=0; const ok=A.walkToZone(Z); let t=0,maxPen=0,len=0,px=E.player.x,pz=E.player.z;
            while(A.mode==='walk'&&t<60*120){E.tick(15);t+=15; maxPen=Math.max(maxPen,E.penetration()); len+=Math.hypot(E.player.x-px,E.player.z-pz); px=E.player.x; pz=E.player.z;}
            out.push({to:Z.id,path:ok,arrived:A.arrived===1,inZone:E.zone===Z.id,sec:+(t/60).toFixed(1),m:+len.toFixed(1),snaps:A.snaps||0,maxPen:+maxPen.toFixed(3)});}
          return out;})()""")
        R['walkAllPairs']=await ev("""(()=>{const E=__EHC,A=E.abil; let n=0,ok=0,snaps=0,replans=0,maxPen=0,secs=[],fails=[]; A.replanned=0;
          for(const S of E.ZONES) for(const Z of E.ZONES){ if(S===Z) continue; E.teleport(S.id); A.snaps=0; n++; if(!A.walkToZone(Z)){fails.push(S.id+'>'+Z.id+' nopath');continue;} let t=0;
            while(A.mode==='walk'&&t<60*120){E.tick(15);t+=15; maxPen=Math.max(maxPen,E.penetration());}
            if(A.mode===null&&E.zone===Z.id) ok++; else fails.push(S.id+'>'+Z.id); snaps+=A.snaps||0; secs.push(t/60);}
          secs.sort((a,b)=>a-b); return {routes:n,arrived:ok,snaps,replans:A.replanned,maxPen:+maxPen.toFixed(3),medianSec:secs[secs.length>>1],maxSec:secs[secs.length-1],fails};})()""")
        # ---- FOLLOW a walker
        R['follow']=await ev("""(()=>{const E=__EHC,A=E.abil; const w=E.social.ctx.crowd().list.find(p=>p.route&&p.state!=='queue'); E.place(w.x-Math.sin(w.yaw)*2.5,w.z-Math.cos(w.yaw)*2.5); A.follow(w,'Test walker'); const ds=[]; let t=0;
           while(A.mode==='follow'&&t<60*40){E.tick(15);t+=15; ds.push(Math.hypot(w.x-E.player.x,w.z-E.player.z));}
           const s=ds.slice(60).sort((a,b)=>a-b); return {stillFollowing:A.mode==='follow',sec:t/60,medianGap:+s[Math.floor(s.length/2)].toFixed(2),p90Gap:+s[Math.floor(s.length*0.9)].toFixed(2),maxGap:+s[s.length-1].toFixed(2),pill:document.getElementById('modePill').textContent.trim()};})()""")
        await ev("__EHC.input.keys.add('f'); __EHC.tick(2); __EHC.input.keys.clear()")
        R['moveStopsFollow']=await ev("__EHC.abil.mode===null")
        # ---- PHOTO
        await ev("window.__EHC_HOLD=false")
        await ev("""(()=>{const E=__EHC; E.teleport('foyer'); const p=E.social.ctx.crowd().list.find(p=>p.role==='guest'&&!p.route&&p.pose!=='sit'&&p.state!=='queue'); E.place(p.x+1.2,p.z+0.4,Math.atan2(-1.2,-0.4)+Math.PI);})()""")
        await pg.keyboard.press('Digit5'); await pg.wait_for_timeout(1000)
        await pg.screenshot(path='tests/out/shots/a_countdown.png')
        await pg.wait_for_function("__EHC.abil.lastPhoto",timeout=30000); await pg.wait_for_timeout(500)
        R['photo']=await ev("({bytes:__EHC.abil.lastPhoto.bytes,people:__EHC.abil.lastPhoto.people,sheet:!document.getElementById('photoSheet').hidden,mode:__EHC.abil.mode})")
        await pg.screenshot(path='tests/out/shots/a_photo.png')
        await pg.click('#photoSave'); await pg.wait_for_timeout(600)
        R['photoSaved']=await ev("__mock.saved"); R['photoNote']=await ev("document.getElementById('photoNote').textContent")
        await pg.click('#photoClose'); await pg.wait_for_timeout(200)
        R['photoClosed']=await ev("document.getElementById('photoSheet').hidden")
        # agenda walk button
        await pg.click('#bAgenda') if await pg.query_selector('#bAgenda') else None
        R['agendaWalkButtons']=await ev("document.querySelectorAll('.arow .go.walk').length")
        if R['agendaWalkButtons']:
            await pg.screenshot(path='tests/out/shots/a_agenda.png')
            await pg.click('.arow:nth-child(8) .go.walk'); await pg.wait_for_timeout(500)
            R['agendaWalkMode']=await ev("[__EHC.abil.mode,__EHC.abil.dest,document.getElementById('modePill').hidden]")
            await pg.screenshot(path='tests/out/shots/a_walking.png')
            await pg.click('#modeStop'); R['stopPill']=await ev("[__EHC.abil.mode,document.getElementById('modePill').hidden]")
        R['errors']=logs
        await pg.context.close()
        # ---- MOBILE action bar
        pg,logs=await page(b,True)
        await pg.tap('#tActions'); await pg.wait_for_timeout(300)
        R['mobileBarOpen']=await pg.evaluate("document.getElementById('abar').classList.contains('open')")
        R['mobileBarFits']=await pg.evaluate("(()=>{const r=document.getElementById('abar').getBoundingClientRect();return [Math.round(r.left),Math.round(r.right),innerWidth]})()")
        R['mobileHScroll']=await pg.evaluate("document.documentElement.scrollWidth>innerWidth")
        await pg.evaluate("__EHC.teleport('lounge')"); await pg.wait_for_timeout(300)
        await pg.screenshot(path='tests/out/shots/a_mobile.png')
        await pg.tap('#aHeart'); await pg.wait_for_timeout(300)
        R['mobileHeart']=await pg.evaluate("__EHC.player.gesture")
        R['mobileErrors']=logs
        await b.close()
    srv.kill()
    print(json.dumps(R,indent=1))
asyncio.run(main())
