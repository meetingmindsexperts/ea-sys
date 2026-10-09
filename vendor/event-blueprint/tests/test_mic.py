# EA-SYS (Oct 9 2026): the Speak button in "Talk it through". The browser's speech recognition is
# replaced by a fake that the test drives, so it runs without a microphone: words appear as they are
# heard, a pause does not stop listening, Stop and closing the box stop it, the language is passed,
# a blocked microphone says so and does not loop, the spoken words reach the AI, and a browser with
# no speech recognition gets the dictation hint instead of the button.
import os, sys; TESTS = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(TESTS); sys.path.insert(0, TESTS); os.chdir(ROOT)
import asyncio, json, subprocess, time
from playwright.async_api import async_playwright
MOCK=open('tests/mock.js').read()
PORT=8768
FAKE="""(()=>{window.__recs=[];
 class FakeRec{constructor(){this.lang='';this.continuous=false;this.interimResults=false;this.started=0;this.stopped=0;window.__recs.push(this);}
  start(){this.started++; if(window.__micBlocked) setTimeout(()=>{this.onerror&&this.onerror({error:'not-allowed'}); this.onend&&this.onend();},10);}
  stop(){this.stopped++;}
  emit(list){const results=list.map(([t,f])=>{const r=[{transcript:t}]; r.isFinal=f; return r;}); this.onresult&&this.onresult({resultIndex:0,results});}}
 window.webkitSpeechRecognition=FakeRec; window.SpeechRecognition=undefined;})();"""
NONE="delete window.webkitSpeechRecognition; delete window.SpeechRecognition;"
async def mk(b, init):
    ctx=await b.new_context(viewport={'width':1360,'height':900}); pg=await ctx.new_page(); logs=[]
    pg.on('console',lambda m: logs.append((m.type,m.text)) if m.type in ('error','warning') else None)
    pg.on('pageerror',lambda e: logs.append(('pageerror',str(e))))
    await pg.route('**/fonts.googleapis.com/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))
    await pg.route('**/blueprint-fonts/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))
    await pg.add_init_script(init+'window.__MOCKCFG='+json.dumps({'sample':'ok'})+';'+MOCK)
    await pg.goto(f'http://127.0.0.1:{PORT}/test.html'); await pg.wait_for_timeout(500)
    await pg.click('text=Start by talking it through'); await pg.wait_for_selector('#qfText')
    return ctx, pg, logs
STATE="(()=>{const b=document.getElementById('qfMic'),r=window.__recs[window.__recs.length-1]||{};return {btn:b&&b.textContent,pressed:b&&b.getAttribute('aria-pressed'),langOff:document.getElementById('qfLang')&&document.getElementById('qfLang').disabled,text:document.getElementById('qfText')&&document.getElementById('qfText').value,note:(document.getElementById('qfMicNote')||{}).textContent,recs:window.__recs.length,lang:r.lang,continuous:r.continuous,interim:r.interimResults,started:r.started,stopped:r.stopped};})()"
async def main():
    srv=subprocess.Popen(['python3','-m','http.server',str(PORT),'-d','dist'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.6)
    R={}; errs=[]
    try:
        async with async_playwright() as p:
            b=await p.chromium.launch()
            ctx,pg,logs=await mk(b,FAKE)
            await pg.fill('#qfText','Gala dinner.')
            await pg.click('#qfMic'); R['listening']=await pg.evaluate(STATE)
            await pg.evaluate("__recs[0].emit([['for four hundred',false]])"); R['interim']=await pg.evaluate(STATE)
            await pg.evaluate("__recs[0].emit([['for four hundred guests in Dubai',true]])"); R['final']=await pg.evaluate(STATE)
            await pg.evaluate("__recs[0].onend()"); R['afterPause']=await pg.evaluate(STATE)
            await pg.click('#qfMic'); R['stopped']=await pg.evaluate(STATE)
            await pg.click('#qfBody .actions .primary')
            await pg.wait_for_function('window.__mock && window.__mock.qf', timeout=20000)
            R['promptHasSpeech']='four hundred guests in Dubai' in (await pg.evaluate('__mock.qf.prompt'))
            errs+=logs; await ctx.close()
            # Arabic, and closing the box while listening
            ctx,pg,logs=await mk(b,FAKE)
            await pg.select_option('#qfLang','ar-AE'); await pg.click('#qfMic'); R['arabic']=await pg.evaluate(STATE)
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(100); R['closed']=await pg.evaluate("({stopped:__recs[0].stopped,hidden:document.getElementById('qf').hidden})")
            errs+=logs; await ctx.close()
            # a blocked microphone
            ctx,pg,logs=await mk(b,FAKE+'window.__micBlocked=true;')
            await pg.click('#qfMic'); await pg.wait_for_timeout(200); R['blocked']=await pg.evaluate(STATE)
            errs+=logs; await ctx.close()
            # no speech recognition in this browser
            ctx,pg,logs=await mk(b,NONE)
            R['unsupported']=await pg.evaluate("({button:!!document.getElementById('qfMic'),hint:document.getElementById('qfBody').innerText.includes('Fn twice on a Mac')})")
            errs+=logs; await ctx.close()
            await b.close()
    finally: srv.kill()
    R['errors']=errs
    print(json.dumps(R))
asyncio.run(main())
