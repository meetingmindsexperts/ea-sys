import os, sys; TESTS = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(TESTS); sys.path.insert(0, TESTS); os.chdir(ROOT)
import subprocess, time
from common import *
SETUP="""(()=>{const S=__EB.S; S.path='new'; S.type='expo'; S.format='Hybrid'; S.basics.attendance='8000 + 20,000 online'; S.basics.when='May 2027';
 const L=['Theatre','Classroom','Banquet rounds','Standing reception','Exhibition stands','Standing crowd','Boardroom','U-shape'];
 S.spaces=Array.from({length:40},(_,i)=>({name:'Room '+(i+1),purpose:'p',layout:L[i%8],cap:String(200+i*137),area:i%3?'':String(300+i*50)}));
 S.programme.rows=Array.from({length:60},(_,i)=>({time:(8+i%12)+':00',title:'Session '+i,space:'Room '+(1+i%40),who:''}));
 S.partners.has='yes'; S.partners.list=Array.from({length:300},(_,i)=>({name:'Company '+i,tier:'Exhibitor',notes:''}));
 S.people.segments=[{label:'a',pct:'50'},{label:'b',pct:'50'}]; __EB.goto(3);})()"""
TYPE="""async ()=>{const el=document.querySelector('.rows .row input'); el.scrollIntoView({block:'center'}); await new Promise(r=>setTimeout(r,300)); const d0=__EB.sketchDraws; const lt=[]; const po=new PerformanceObserver(l=>l.getEntries().forEach(e=>lt.push(Math.round(e.duration)))); po.observe({type:'longtask'});
  for(let i=0;i<10;i++){el.value+='y'; el.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,300));} await new Promise(r=>setTimeout(r,1200)); po.disconnect(); return {longtasks:lt, sketchRedraws:__EB.sketchDraws-d0}}"""
async def main():
    srv=serve()
    R={}
    async with async_playwright() as p:
        b=await p.chromium.launch()
        # 1. typing with a big expo, phone at 4x slower CPU
        pg,logs=await mk(b,{'sample':'ok'},mobile=True); ev=pg.evaluate
        cdp=await pg.context.new_cdp_session(pg); await cdp.send('Emulation.setCPUThrottlingRate',{'rate':4})
        await ev('__EB.newBlueprint()'); await pg.wait_for_timeout(300); await ev(SETUP); await pg.wait_for_timeout(2500)
        R['typing']=await ev(TYPE)
        await ev("document.querySelector('[data-live=sketch]').scrollIntoView({block:'center'})"); await pg.wait_for_timeout(2500)
        R['sketchCatchesUp']=await ev("document.querySelector('[data-live=sketch]').textContent.includes('Room 1yyyyyyyyyy')")
        R['errors1']=logs
        await pg.context.close()
        # 2. owners
        pg,logs=await mk(b,{'sample':'ok'}); ev=pg.evaluate
        await pg.click('text=Start a new blueprint'); await pg.wait_for_timeout(300)
        await ev(FILL); await pg.wait_for_timeout(300); await ev('__EB.goto(3)'); await pg.wait_for_timeout(300)
        await pg.click('.ownerline button:has-text("Assign an owner")'); await pg.wait_for_timeout(100)
        R['formFocus']=await ev("document.activeElement.getAttribute('aria-label')")
        await pg.keyboard.type('Temp'); await pg.keyboard.press('Escape'); await pg.wait_for_timeout(100)
        R['escape']=await ev("({formGone:!document.querySelector('.owner-form'), focus:document.activeElement.textContent, noOwner:!__EB.S.owners.spaces})")
        await pg.keyboard.press('Enter'); await pg.wait_for_timeout(100)
        await pg.fill('.owner-form input[type=text]','Lina'); await pg.fill('.owner-form input[type=email]','lina.a@example.com'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(150)
        R['afterSaveFocus']=await ev("document.activeElement.textContent")
        await ev('__EB.goto(4)'); await pg.wait_for_timeout(200); await pg.click('.ownerline button:has-text("Assign an owner")'); await pg.fill('.owner-form input[type=text]','Lina'); await pg.fill('.owner-form input[type=email]','lina.k@example.com'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(150)
        await ev('__EB.goto(12)'); await pg.wait_for_timeout(400)
        R['table']=await ev("[...document.querySelectorAll('.otable tbody tr td.oname')].map(e=>e.textContent).filter(t=>t!=='—')")
        await pg.context.grant_permissions(['clipboard-read','clipboard-write'])
        await pg.click('text=Copy the list for the team'); await pg.wait_for_timeout(200)
        R['copied']=await ev("navigator.clipboard.readText()")
        await pg.click('text=Submit blueprint'); await pg.wait_for_timeout(600)
        await ev("(()=>{__EB.S.owners.spaces={name:'Lina',email:'lina.alaa@example.com'};})()")
        R['pendingEmail']=await ev("__EB.pending().map(x=>x.text)")
        R['errors2']=logs
        await pg.context.close()
        # 3. phone: long owner name wraps, source links and tap targets
        pg,logs=await mk(b,{'sample':'ok'},mobile=True); ev=pg.evaluate
        await pg.click('text=Start a new blueprint'); await pg.wait_for_timeout(300); await ev(FILL); await pg.wait_for_timeout(300)
        await ev("(()=>{__EB.S.owners.spaces={name:'Dr Alexandrina Konstantinopoulou-Abdelrahman Al Mansouri',email:'alexandrina.konstantinopoulou.abdelrahman@verylongdomain-example.com'}; __EB.goto(3)})()"); await pg.wait_for_timeout(400)
        R['m_ownerOverflow']=await ev("(()=>{const o=document.querySelector('.ownerline'); return o.scrollWidth>o.clientWidth+1 || document.documentElement.scrollWidth>innerWidth})()")
        await ev('__EB.goto(12)'); await pg.wait_for_timeout(600)
        R['m_small']=await ev("""[...document.querySelectorAll('main button, main a, main summary')].filter(e=>e.offsetParent && !e.closest('svg')).map(e=>{const r=e.getBoundingClientRect(); return [e.textContent.trim().slice(0,30), Math.round(r.height)]}).filter(x=>x[1]<40)""")
        R['m_hscroll']=await ev("document.documentElement.scrollWidth>innerWidth")
        R['m_errors']=logs
        await pg.context.close(); await b.close()
    srv.kill(); print(json.dumps(R,indent=1,ensure_ascii=False))
asyncio.run(main())
