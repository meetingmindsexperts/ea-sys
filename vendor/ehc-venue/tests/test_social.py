import os, sys; TESTS = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(TESTS); sys.path.insert(0, TESTS); os.chdir(ROOT); os.makedirs('tests/out/shots', exist_ok=True)
import asyncio, json, subprocess, time, os, sys
from playwright.async_api import async_playwright
ARGS=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']
MOCK=open('tests/mock.js').read()
async def page(b, cfg, mobile=False):
    ctx=await b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True) if mobile else await b.new_context(viewport={'width':1280,'height':720})
    pg=await ctx.new_page(); logs=[]
    pg.on('console',lambda m: logs.append((m.type,m.text)) if m.type in ('error','warning') else None)
    pg.on('pageerror',lambda e: logs.append(('pageerror',str(e))))
    await pg.route('**/fonts.googleapis.com/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))
    await pg.route('**/venue-fonts/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))  # EA-SYS: fonts are served by EA-SYS, not by this bare test server
    if cfg is not None: await pg.add_init_script(f'window.__MOCKCFG={json.dumps(cfg)};'+MOCK)
    await pg.goto('http://127.0.0.1:8765/test.html'); await pg.wait_for_function('window.__EHC && window.__EHC.ready',timeout=60000)
    await pg.evaluate('__EHC.enter()'); await pg.wait_for_timeout(300)
    return pg, logs
FIND_NPC='''(()=>{const E=__EHC; E.teleport('foyer'); const L=E.social.ctx.crowd().list.filter(p=>p.pose!=='sit'&&!p.route&&p.role==='guest');
 for(const p of L){ for(let a=0;a<12;a++){ const ang=a/12*6.283, x=p.x+Math.sin(ang)*1.5, z=p.z+Math.cos(ang)*1.5; if(E.CW.inside(x,1,z,0.4)) continue; const near=E.social.ctx.crowd().list.some(q=>q!==p&&Math.hypot(q.x-x,q.z-z)<0.7); if(near) continue; E.place(x,z,Math.atan2(p.x-x,p.z-z)); E.setView(Math.atan2(p.x-x,p.z-z)+Math.PI-0.5,0.25,3.6); const t=E.nearP; if(t&&t.ref===p) return true; } } return false;})()'''
async def main():
    srv=subprocess.Popen(['python3','-m','http.server','8765','-d','dist'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.6)
    R={}
    async with async_playwright() as p:
        b=await p.chromium.launch(args=ARGS)
        # 1. AI attendee conversation
        pg,logs=await page(b,{'sample':'ok','room':True})
        R['npcFound']=await pg.evaluate(FIND_NPC)
        await pg.wait_for_timeout(300)
        R['promptLabel']=await pg.evaluate("document.getElementById('ptext').textContent")
        await pg.keyboard.press('e'); await pg.wait_for_timeout(400)
        R['chatOpen']=await pg.evaluate("!document.getElementById('chat').hidden")
        R['greeting']=await pg.evaluate("document.querySelector('#cLog .msg .mt')?.textContent")
        R['npcHeld']=await pg.evaluate("__EHC.social.target.ref.hold===true")
        await pg.fill('#cInput','Where can I get a coffee?'); await pg.keyboard.press('Enter')
        await pg.wait_for_timeout(250); await pg.screenshot(path='tests/out/shots/s_thinking.png')
        await pg.wait_for_function("document.querySelectorAll('#cLog .msg').length>=3 && !document.querySelector('#cLog .thinking')",timeout=20000)
        await pg.wait_for_timeout(500)
        R['reply']=await pg.evaluate("[...document.querySelectorAll('#cLog .msg .mt')].pop().textContent")
        R['tagsStripped']='[' not in R['reply']
        R['goButton']=await pg.evaluate("document.querySelector('#cLog .gobtn')?.textContent")
        c=await pg.evaluate("__mock.calls[0]")
        R['promptHasVenue']='Conrad Dubai' in c['input'][0]['content'] and 'Never invent' in c['input'][0]['content']
        R['sampleOpts']=c['opts']; R['turnsSent']=len(c['input'])
        R['npcGesture']=await pg.evaluate("__EHC.social.target.ref.gesture")
        await pg.screenshot(path='tests/out/shots/s_npc_chat.png')
        await pg.fill('#cInput','What brings you here?'); await pg.keyboard.press('Enter')
        await pg.wait_for_function("__mock.calls.length>=2 && !document.querySelector('#cLog .thinking')",timeout=20000); await pg.wait_for_timeout(400)
        c2=await pg.evaluate("__mock.calls[1]"); R['secondCallTurns']=len(c2['input']); R['memoryKept']='coffee' in json.dumps(c2['input'])
        pres=await pg.evaluate("__mock.presence[__mock.presence.length-1]")
        R['myPresence']=pres; R['presenceBytes']=len(json.dumps(pres))
        await pg.click('#gobtnX') if False else None
        await pg.evaluate("document.querySelector('#cLog .gobtn').click()"); await pg.wait_for_timeout(900)
        R['afterGoZone']=await pg.evaluate("__EHC.zone"); R['chatClosedAfterGo']=await pg.evaluate("document.getElementById('chat').hidden")
        # 2. real people
        await pg.evaluate("__EHC.teleport('foyer')"); await pg.wait_for_timeout(200)
        await pg.evaluate("""__mock.setPeers([{peer:'pa',by:'u_a',presence:{v:1,x:1.5,z:24.5,y:0,yaw:3.14,mv:0,col:'#2e9e6b',gt:0,sn:0,say:''}},{peer:'pb',by:'u_b',presence:{v:1,x:-3,z:22,y:0,yaw:1.2,mv:1.2,col:'#d08a2c',gt:0,sn:0,say:''}}])""")
        await pg.wait_for_timeout(600)
        R['peersRendered']=await pg.evaluate("__EHC.social.peers.size"); R['peerNames']=await pg.evaluate("[...__EHC.social.peers.values()].map(p=>p.name)")
        R['hereChip']=await pg.evaluate("document.getElementById('here').textContent")
        await pg.evaluate("__EHC.place(1.5,26,3.14); __EHC.setView(0,0.3,4)"); await pg.wait_for_timeout(300)
        R['peerTarget']=await pg.evaluate("(__EHC.nearP||{}).label")
        await pg.keyboard.press('e'); await pg.wait_for_timeout(300)
        R['peerChatTag']=await pg.evaluate("document.getElementById('cTag').textContent")
        await pg.fill('#cInput','Coffee?'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(300)
        pres=await pg.evaluate("__mock.presence[__mock.presence.length-1]"); R['sayInPresence']=(pres.get('say'),pres.get('sn'))
        await pg.evaluate("""__mock.setPeers([{peer:'pa',by:'u_a',presence:{v:1,x:1.5,z:24.5,y:0,yaw:3.14,mv:0,col:'#2e9e6b',g:'wave',gt:1,sn:1,say:'Yes! Meet you in the lounge.'}},{peer:'pb',by:'u_b',presence:{v:1,x:-2,z:21,y:0,yaw:1.2,mv:1.2,col:'#d08a2c',gt:0,sn:0,say:''}}])""")
        await pg.wait_for_timeout(500)
        R['peerReplyLogged']=await pg.evaluate("[...document.querySelectorAll('#cLog .msg .mt')].map(e=>e.textContent)")
        R['peerGesture']=await pg.evaluate("[...__EHC.social.peers.values()][0].gesture")
        R['bubbleCount']=await pg.evaluate("document.querySelectorAll('#bubbles .bubble').length")
        await pg.screenshot(path='tests/out/shots/s_peer_chat.png')
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
        R['escCloses']=await pg.evaluate("document.getElementById('chat').hidden")
        # hostile presence is clamped / rendered as text
        await pg.evaluate("""__mock.setPeers([{peer:'px',by:null,presence:{x:1e9,z:'<img src=x onerror=alert(1)>',yaw:NaN,col:'red;background:url(x)',sn:5,say:'<b>hi</b>'}}])""")
        await pg.wait_for_timeout(300)
        R['hostileClamped']=await pg.evaluate("(()=>{const P=[...__EHC.social.peers.values()][0]; return [P.tx,P.tz,P.col||null,P.name]})()")
        R['noInjectedImg']=await pg.evaluate("document.querySelectorAll('#bubbles img, #cLog img').length===0")
        R['consoleErrors']=[l for l in logs if l[0] in ('error','pageerror')]
        await pg.context.close()
        # 3. Claude declined -> scripted
        pg,logs=await page(b,{'sample':'deny','room':False})
        await pg.evaluate(FIND_NPC); await pg.keyboard.press('e'); await pg.wait_for_timeout(300)
        await pg.fill('#cInput','Where are the posters?'); await pg.keyboard.press('Enter')
        await pg.wait_for_function("document.querySelectorAll('#cLog .msg').length>=3 && !document.querySelector('#cLog .thinking')",timeout=20000); await pg.wait_for_timeout(300)
        R['declinedNote']=await pg.evaluate("document.getElementById('cNote').textContent")
        R['declinedReply']=await pg.evaluate("[...document.querySelectorAll('#cLog .msg .mt')].pop().textContent")
        R['declinedErrors']=[l for l in logs if l[0] in ('error','pageerror')]
        await pg.context.close()
        # 4. no capabilities at all (outside Claude) + mobile layout
        pg,logs=await page(b,None,mobile=True)
        await pg.evaluate(FIND_NPC); await pg.wait_for_timeout(300)
        await pg.screenshot(path='tests/out/shots/s_m_prompt.png')
        await pg.evaluate("document.getElementById('prompt').click()"); await pg.wait_for_timeout(300)
        await pg.fill('#cInput','What are you working on?'); await pg.evaluate("document.getElementById('cSend').click()")
        await pg.wait_for_function("document.querySelectorAll('#cLog .msg').length>=3 && !document.querySelector('#cLog .thinking')",timeout=20000); await pg.wait_for_timeout(500)
        R['offlineNote']=await pg.evaluate("document.getElementById('cNote').textContent")
        R['offlineReply']=await pg.evaluate("[...document.querySelectorAll('#cLog .msg .mt')].pop().textContent")
        await pg.screenshot(path='tests/out/shots/s_m_chat.png')
        R['mobileErrors']=[l for l in logs if l[0] in ('error','pageerror')]
        await pg.context.close(); await b.close()
    srv.terminate()
    print(json.dumps(R,indent=1,ensure_ascii=False))
asyncio.run(main())
