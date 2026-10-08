import os, sys; TESTS = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(TESTS); sys.path.insert(0, TESTS); os.chdir(ROOT); os.makedirs('tests/out/shots', exist_ok=True)
import asyncio, json, subprocess, time
from playwright.async_api import async_playwright
ARGS=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']
MOCK=open('tests/mock.js').read()
VOICES="""(()=>{const mk=(name,lang,local=true)=>({name,lang,localService:local,default:false,voiceURI:name});
 const list=[mk('Zarvox','en-US'),mk('Fred','en-US'),mk('Samantha (Compact)','en-US'),mk('Daniel','en-GB'),mk('Microsoft David - English (United States)','en-US'),
   mk('Microsoft Aria Online (Natural) - English (United States)','en-US',false),mk('Microsoft Guy Online (Natural) - English (United States)','en-US',false),mk('Microsoft Sonia Online (Natural) - English (United Kingdom)','en-GB',false),mk('Microsoft Ryan Online (Natural) - English (United Kingdom)','en-GB',false),mk('Microsoft Hamed Online (Natural) - Arabic (Saudi Arabia)','ar-SA',false)];
 window.__spoken=[]; const ss={getVoices:()=>list, speak:(u)=>{window.__spoken.push({text:u.text,voice:u.voice&&u.voice.name,pitch:u.pitch,rate:u.rate}); setTimeout(()=>{u.onstart&&u.onstart(); setTimeout(()=>u.onend&&u.onend(),30)},5)}, cancel:()=>{}, onvoiceschanged:null, speaking:false};
 Object.defineProperty(window,'speechSynthesis',{value:ss,configurable:true}); window.SpeechSynthesisUtterance=function(t){this.text=t;};})();"""
async def main():
    srv=subprocess.Popen(['python3','-m','http.server','8765','-d','dist'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.6)
    R={}
    async with async_playwright() as p:
        b=await p.chromium.launch(args=ARGS)
        ctx=await b.new_context(viewport={'width':1280,'height':720}); pg=await ctx.new_page(); logs=[]
        pg.on('pageerror',lambda e: logs.append(str(e))); pg.on('console',lambda m: logs.append(m.text) if m.type=='error' else None)
        await pg.route('**/fonts.googleapis.com/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))
        await pg.add_init_script("window.__MOCKCFG={sample:'ok',room:false};"+MOCK+VOICES)
        await pg.goto('http://127.0.0.1:8765/test.html'); await pg.wait_for_function('window.__EHC && window.__EHC.ready',timeout=60000)
        await pg.evaluate('__EHC.enter()'); await pg.wait_for_timeout(300); ev=pg.evaluate
        R['defaultView']=await ev("__EHC.camView")
        # cycle with V and button
        seq=[]
        for _ in range(4): await pg.keyboard.press('v'); await pg.wait_for_timeout(120); seq.append(await ev("[__EHC.camView, document.getElementById('bView').textContent]"))
        R['cycle']=seq
        # camera safety per view: random poses in every zone
        R['camSafety']=await ev("""(()=>{const E=__EHC,out={}; window.__EHC_HOLD=true;
          for(const v of ['behind','eye','close','wide']){ E.setCamView(v); let bad=0,n=0,outside=0;
            for(const Z of E.ZONES){ E.teleport(Z.id); for(let k=0;k<30;k++){ E.cam.yaw=Math.random()*6.283; const [lo,hi]= v==='eye'?[-1.1,1.1]:[-0.2,1.1]; E.cam.pitch=lo+Math.random()*(hi-lo); E.tick(2); n++; if(E.camInside())bad++; } }
            out[v]={poses:n,lensInsideGeometry:bad}; }
          window.__EHC_HOLD=false; return out;})()""")
        # eye view: eye height, forward motion follows look direction, body faces look
        R['eye']=await ev("""(()=>{const E=__EHC; window.__EHC_HOLD=true; E.setCamView('eye'); E.teleport('foyer'); E.cam.yaw=1.0; E.cam.pitch=0.0; E.tick(2);
          const p0=[E.player.x,E.player.z], camY=E.cam.pos[1]-E.player.y; E.input.keys.add('f'); E.tick(60); E.input.keys.clear(); E.tick(10);
          const mv=[E.player.x-p0[0],E.player.z-p0[1]], ang=Math.atan2(-mv[0],-mv[1]); const bodyFaces=Math.abs(Math.atan2(Math.sin(E.player.yaw-Math.PI-E.cam.yaw),Math.cos(E.player.yaw-Math.PI-E.cam.yaw)));
          window.__EHC_HOLD=false; return {eyeHeight:+camY.toFixed(2), moved:+Math.hypot(...mv).toFixed(2), moveDirErr:+Math.abs(Math.atan2(Math.sin(ang-1.0),Math.cos(ang-1.0))).toFixed(3), bodyFacingErr:+bodyFaces.toFixed(3)};})()""")
        await ev("__EHC.teleport('plenary')"); await pg.wait_for_timeout(1500)
        await pg.screenshot(path='tests/out/shots/v_eye_plenary.png')
        # seated eye view
        R['eyeSeated']=await ev("""(()=>{const E=__EHC,A=E.abil; const s=E.W.seats.find(s=>s.z<-8&&s.z>-12&&Math.abs(s.x)<5&&!A.occupied.has(s.x.toFixed(2)+','+s.z.toFixed(2))); E.place(s.x,s.z+0.9); A.sit(); return [A.mode, +(E.cam.pos[1]).toFixed(2)];})()""")
        await pg.wait_for_timeout(1500); await pg.screenshot(path='tests/out/shots/v_eye_seated.png')
        await ev("__EHC.abil.stand()")
        # walk me there in eye view: camera turns to the route
        R['eyeWalk']=await ev("""(()=>{const E=__EHC,A=E.abil; window.__EHC_HOLD=true; E.teleport('foyer'); E.cam.yaw=0; A.walkToZone(E.ZONES.find(z=>z.id==='lounge')); let t=0; while(A.mode==='walk'&&t<7200){E.tick(15);t+=15;} window.__EHC_HOLD=false; return {arrived:A.mode===null&&E.zone==='lounge', sec:t/60};})()""")
        await ev("__EHC.setCamView('close'); __EHC.teleport('lounge')"); await pg.wait_for_timeout(1500); await pg.screenshot(path='tests/out/shots/v_close.png')
        await ev("__EHC.setCamView('wide'); __EHC.teleport('expo')"); await pg.wait_for_timeout(1500); await pg.screenshot(path='tests/out/shots/v_wide.png')
        # photo in eye view shows the avatar and restores eye view
        await ev("__EHC.setCamView('eye'); __EHC.teleport('foyer')"); await pg.wait_for_timeout(300)
        await pg.keyboard.press('Digit5'); await pg.wait_for_function("__EHC.abil.lastPhoto",timeout=30000); await pg.wait_for_timeout(300)
        R['photoInEye']=await ev("[__EHC.abil.lastPhoto.bytes, __EHC.camView]")
        await pg.click('#photoClose')
        # wheel: zoom in from close -> eye; out from eye -> close
        await ev("__EHC.setCamView('close')"); await pg.mouse.move(640,360)
        for _ in range(8): await pg.mouse.wheel(0,-200); await pg.wait_for_timeout(60)
        R['wheelIn']=await ev("__EHC.camView"); await pg.mouse.wheel(0,200); await pg.wait_for_timeout(100); R['wheelOut']=await ev("__EHC.camView")
        # persisted
        await ev("__EHC.setCamView('eye')"); await pg.reload(); await pg.wait_for_function('window.__EHC && window.__EHC.ready',timeout=60000)
        R['persisted']=await ev("__EHC.camView"); await ev("__EHC.setCamView('behind')")
        # voices
        await ev('__EHC.enter()'); await pg.wait_for_timeout(300)
        R['voiceTier']=await ev("__EHC.social.voiceTier()")
        R['picks']=await ev("""(()=>{const S=__EHC.social; return [['Dr Sara Khan','f'],['Omar Haddad','m'],['Lina Aziz','f'],['James Walker','m'],['Arabic','m']].map(([n,g])=>S.pickVoice({name:n,g}, n==='Arabic'?'مرحبا بكم':'Hello there').name)})()""")
        await ev("window.__spoken=[]; __EHC.social.speak({persona:{name:'Dr Sara Khan',g:'f'}}, 'Welcome to the venue. The coffee bar is in the lounge — just past the promenade! Enjoy *the* day.')"); await pg.wait_for_timeout(200)
        R['spoken']=await ev("window.__spoken")
        R['errors']=logs
        await ctx.close()
        # basic-voice device shows a tip (iPhone UA)
        ctx=await b.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'); pg=await ctx.new_page()
        await pg.route('**/fonts.googleapis.com/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))
        await pg.add_init_script("window.__MOCKCFG={sample:'ok',room:false};"+MOCK+VOICES.replace("mk('Microsoft Aria","0&&mk('x").replace("mk('Microsoft Guy","0&&mk('x").replace("mk('Microsoft Sonia","0&&mk('x").replace("mk('Microsoft Ryan","0&&mk('x").replace("mk('Microsoft Hamed","0&&mk('x"))
        await pg.goto('http://127.0.0.1:8765/test.html'); await pg.wait_for_function('window.__EHC && window.__EHC.ready',timeout=60000)
        await pg.evaluate('__EHC.enter()'); await pg.wait_for_timeout(300)
        R['m_tier']=await pg.evaluate("__EHC.social.voiceTier()")
        R['m_tip']=await pg.evaluate("__EHC.social.voiceTip()")
        R['m_viewBtn']=await pg.evaluate("(()=>{const r=document.getElementById('bView').getBoundingClientRect();return [Math.round(r.width),Math.round(r.height), document.documentElement.scrollWidth>innerWidth]})()")
        await pg.tap('#bView'); await pg.wait_for_timeout(200); R['m_afterTap']=await pg.evaluate("__EHC.camView")
        await pg.wait_for_timeout(1200); await pg.screenshot(path='tests/out/shots/v_m_eye.png')
        await ctx.close(); await b.close()
    srv.kill(); print(json.dumps(R,indent=1,ensure_ascii=False))
asyncio.run(main())
