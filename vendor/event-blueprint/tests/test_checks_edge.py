import os, sys; TESTS = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(TESTS); sys.path.insert(0, TESTS); os.chdir(ROOT)
from common import *
async def main():
    srv=serve(); R={}
    async with async_playwright() as p:
        b=await p.chromium.launch()
        pg,logs=await mk(b,{'sample':'ok'},mobile=True); ev=pg.evaluate
        await pg.tap('text=Start a new blueprint'); await pg.wait_for_timeout(300)
        await ev("(()=>{const S=__EB.S; S.path='new'; S.type='gala'; S.format='In person'; __EB.applyPack(); S.spaces[2].cap='450'; S.spaces[2].area='560'; __EB.goto(3);})()"); await pg.wait_for_timeout(500)
        R['toastBox']=await ev("(()=>{const r=document.getElementById('toast').getBoundingClientRect();return [Math.round(r.left),Math.round(r.width),Math.round(r.height), getComputedStyle(document.getElementById('toast')).pointerEvents]})()")
        R['before']=await ev("[...document.querySelectorAll('[data-live=\"reality:spaces\"] .rc .st')].map(e=>e.textContent)")
        await pg.tap('[data-live="reality:spaces"] .rc .rca button:has-text("Accept as is")'); await pg.wait_for_timeout(300)
        R['afterAccept_open']=await ev("document.querySelectorAll('[data-live=\"reality:spaces\"] .rc:not(.acked)').length")
        await ev("(()=>{__EB.S.spaces[2].cap='1200'; __EB.goto(3);})()"); await pg.wait_for_timeout(400)
        R['afterWorse']=await ev("[...document.querySelectorAll('[data-live=\"reality:spaces\"] .rc:not(.acked)')].map(e=>e.querySelector('.st').textContent+' | '+(e.querySelector('.reopen')?.textContent||''))")
        await ev("(()=>{__EB.S.spaces.push({name:'ballroom ',purpose:'',layout:'Theatre',cap:'100',area:'20'}); __EB.goto(3);})()"); await pg.wait_for_timeout(400)
        R['dupes']=await ev("[...document.querySelectorAll('[data-live=\"reality:spaces\"] .rc .st')].map(e=>e.textContent)")
        R['legend']=await ev("[...document.querySelectorAll('.sklegend li')].map(e=>e.textContent)")
        await ev('__EB.goto(1)'); await pg.wait_for_timeout(200)
        for w in ['winter 2026','12/03/2027','We may hold it in 2027']:
            await pg.fill('#f_basics_when',w); await pg.wait_for_timeout(350)
            R['when:'+w]=await ev("document.querySelector('[data-live=when]').textContent")
        R['basicsChecks']=await ev("[...document.querySelectorAll('[data-live=\"reality:basics\"] .rc .st')].map(e=>e.textContent)")
        # duplicate/template clears acceptances
        await ev('__EB.goto(12)'); await pg.wait_for_timeout(300)
        n_ack=await ev("Object.keys(__EB.S.checkAck).length")
        await pg.tap('.actions >> text=Duplicate'); await pg.wait_for_timeout(400)
        R['ackAfterDuplicate']=[n_ack, await ev("Object.keys(__EB.S.checkAck).length")]
        R['hscroll']=await ev("document.documentElement.scrollWidth>innerWidth")
        R['errors']=logs
        await pg.context.close(); await b.close()
    srv.kill(); print(json.dumps(R,indent=1,ensure_ascii=False))
asyncio.run(main())
