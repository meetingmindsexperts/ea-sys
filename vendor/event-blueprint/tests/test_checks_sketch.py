import os, sys; TESTS = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(TESTS); sys.path.insert(0, TESTS); os.chdir(ROOT)
import asyncio, json, subprocess, time
from playwright.async_api import async_playwright
exec(open('tests/test_flow.py').read().split('async def main():')[0])
async def main():
    srv=subprocess.Popen(['python3','-m','http.server','8766','-d','dist'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.6)
    R={}
    async with async_playwright() as p:
        b=await p.chromium.launch()
        pg,logs=await mk(b,{'sample':'ok'})
        ev=pg.evaluate
        await pg.click('text=Start a new blueprint'); await pg.wait_for_timeout(300)
        await pg.click('text=Design a new event'); await pg.click('.type:has-text("Awards night or gala dinner")'); await pg.click('.chip:has-text("Hybrid")')
        await pg.wait_for_selector('.pack')
        R['packText']=await ev("document.querySelector('.pack .cd').textContent")
        await pg.screenshot(path='shots/s3_pack.png',full_page=False)
        await pg.click('.pack .primary'); await pg.wait_for_timeout(300)
        S=await ev('__EB.S')
        R['packFilled']={'spaces':[(x['name'],x['layout']) for x in S['spaces']],'prog':len(S['programme']['rows']),'segs':len(S['people']['segments']),'feats':S['online']['features'],'food':S['basics']['food'],'avatars':S['avatars']['prefilled']}
        R['toast']=await ev("document.getElementById('toast').textContent")
        R['packAppliedBtn']=await ev("document.querySelector('.pack button').textContent")
        # basics: attendance read-back + food
        await ev('__EB.goto(1)'); await pg.fill('#f_basics_title','Excellence Awards Night 2027'); await pg.fill('#f_basics_when','4 December 2026'); await pg.fill('#f_basics_attendance','450 + 2,000 online'); await pg.wait_for_timeout(400)
        R['attReadback']=await ev("document.querySelector('[data-live=att]').textContent")
        R['basicsReality']=await ev("[...document.querySelectorAll('[data-live=\"reality:basics\"] .rc .st')].map(e=>e.textContent)")
        await pg.screenshot(path='shots/s3_basics.png',full_page=True)
        # spaces: set ballroom area too small, see live check + sketch
        await ev('__EB.goto(3)'); await pg.wait_for_timeout(300)
        rows=await pg.query_selector_all('.rows .row')
        names=[await (await r.query_selector('input')).input_value() for r in rows]
        bi=names.index('Ballroom'); row=rows[bi]; ins=await row.query_selector_all('input')
        await ins[2].fill('450'); await ins[3].fill('380'); await pg.wait_for_timeout(500)
        R['spaceChecks']=await ev("[...document.querySelectorAll('[data-live=\"reality:spaces\"] .rc')].map(e=>[e.className,e.querySelector('.st').textContent,e.querySelector('.src')?.textContent||''])")
        R['sketchRooms']=await ev("document.querySelectorAll('.skwrap g.room').length")
        R['sketchRed']=await ev("document.querySelector('.sktools .bad')?.textContent||''")
        R['planSpaces']=await ev("[...document.querySelectorAll('[data-live=\"plan:spaces\"] .pn')].map(e=>e.querySelector('.st').textContent+' = '+e.querySelector('.pv').textContent)")
        await pg.screenshot(path='shots/s3_spaces.png',full_page=True)
        # accept a check
        await pg.click('[data-live="reality:spaces"] .rc .rca button:has-text("Accept as is")'); await pg.wait_for_timeout(300)
        R['afterAccept']=await ev("[document.querySelectorAll('[data-live=\"reality:spaces\"] .rc:not(.acked)').length, document.querySelector('[data-live=\"reality:spaces\"] details.accepted summary')?.textContent]")
        R['ackSaved']=await ev("Object.keys(__EB.S.checkAck)")
        # sketch: select + rotate + drag (mouse)
        await ev("document.querySelector('.skwrap').scrollIntoView({block:'center'})"); await pg.wait_for_timeout(200); g=await pg.query_selector('.skwrap g.room[data-room="ballroom"]'); bb=await g.bounding_box()
        await pg.mouse.click(bb['x']+bb['width']/2, bb['y']+bb['height']/2); await pg.wait_for_timeout(200)
        R['selected']=await ev("document.querySelector('.sktools .skrow .st')?.textContent")
        await pg.click('.sktools button:has-text("Rotate")'); await pg.wait_for_timeout(200)
        R['rotSaved']=await ev("__EB.S.sketch.rooms.ballroom")
        await ev("document.querySelector('.skwrap').scrollIntoView({block:'center'})"); await pg.wait_for_timeout(200); g=await pg.query_selector('.skwrap g.room[data-room="reception"]'); bb=await g.bounding_box()
        x0,y0=bb['x']+20,bb['y']+20
        await pg.mouse.move(x0,y0); await pg.mouse.down(); await pg.mouse.move(x0+60,y0+40,steps=6); await pg.mouse.up(); await pg.wait_for_timeout(200)
        R['dragSaved']=await ev("__EB.S.sketch.rooms.reception")
        # keyboard move
        await pg.focus('.skwrap g.room[data-room="reception"]'); await pg.keyboard.press('ArrowRight'); await pg.wait_for_timeout(150)
        R['keySaved']=await ev("__EB.S.sketch.rooms.reception")
        # PNG download
        await pg.click('.sktools button:has-text("Download PNG")'); await pg.wait_for_timeout(1200)
        R['png']=await ev("window.__EB_lastSketch||null")
        # programme: wrong space + clash + small room
        await ev('__EB.goto(4)'); await pg.wait_for_timeout(200)
        await ev("(()=>{const S=__EB.S; S.programme.rows.push({time:'21:00',title:'Awards ceremony',space:'Ballroom',who:''},{time:'22:00',title:'Speeches',space:'Terrace',who:''}); __EB.goto(4);})()"); await pg.wait_for_timeout(300)
        R['progChecks']=await ev("[...document.querySelectorAll('[data-live=\"reality:programme\"] .rc .st')].map(e=>e.textContent)")
        # partners: 12 exhibitors, no stands space
        await ev("(()=>{const S=__EB.S; S.partners.has='yes'; S.partners.list=Array.from({length:12},(_,i)=>({name:'Partner '+(i+1),tier:'Exhibitor',notes:''})); __EB.goto(7);})()"); await pg.wait_for_timeout(300)
        R['partnerChecks']=await ev("[...document.querySelectorAll('[data-live=\"reality:partners\"] .rc .st')].map(e=>e.textContent)")
        # online: registration
        await ev("(()=>{const S=__EB.S; S.online.access='Free registration'; __EB.goto(9);})()"); await pg.wait_for_timeout(300)
        R['onlineChecks']=await ev("[...document.querySelectorAll('[data-live=\"reality:online\"] .rc .st')].map(e=>e.textContent)")
        # delivery deadline too close
        await ev('__EB.goto(10)'); await pg.fill('#f_delivery_deadline','2026-10-08'); await pg.wait_for_timeout(400)
        R['deliveryChecks']=await ev("[...document.querySelectorAll('[data-live=\"reality:delivery\"] .rc .st')].map(e=>e.textContent)")
        # review page
        await ev('__EB.goto(12)'); await pg.wait_for_timeout(400)
        R['reviewChecks']=await ev("document.querySelectorAll('[data-live=\"reality:*\"] .rc').length")
        R['reviewPlan']=await ev("[...document.querySelectorAll('[data-live=plan] .pn')].map(e=>e.querySelector('.st').textContent+' = '+e.querySelector('.pv').textContent)")
        R['reviewSketch']=await ev("document.querySelectorAll('.skwrap g.room').length")
        md=await ev('__EB.toMarkdown()')
        R['mdHasChecks']='## Reality checks' in md and '## Numbers to plan with' in md
        R['mdLayoutCol']='| Space | Purpose | Layout | Capacity | Area m² |' in md
        await pg.screenshot(path='shots/s3_review.png',full_page=True)
        R['sideChecks']=await ev("document.querySelectorAll('.sidechk li').length")
        R['hscroll']=await ev("document.documentElement.scrollWidth>innerWidth")
        R['errors']=logs
        await pg.context.close()
        # mobile: spaces + sketch arrange with touch
        pg,logs=await mk(b,{'sample':'ok'},mobile=True)
        await pg.tap('text=Start a new blueprint'); await pg.wait_for_timeout(300)
        await pg.tap('text=Design a new event'); await pg.tap('.type:has-text("Trade show or expo")'); await pg.tap('.chip:has-text("In person")'); await pg.wait_for_timeout(200)
        await pg.tap('.pack .primary'); await pg.wait_for_timeout(300)
        await pg.evaluate("(()=>{const S=__EB.S; S.basics.attendance='3000'; S.spaces[1].area='2400'; S.partners.has='yes'; S.partners.list=Array.from({length:60},(_,i)=>({name:'Co '+(i+1),tier:'Exhibitor',notes:''})); __EB.goto(3);})()"); await pg.wait_for_timeout(400)
        R['m_hscroll']=await pg.evaluate("document.documentElement.scrollWidth>innerWidth")
        R['m_checks']=await pg.evaluate("[...document.querySelectorAll('[data-live=\"reality:spaces\"] .rc .st')].map(e=>e.textContent)")
        sk=await pg.query_selector('.skwrap'); await sk.scroll_into_view_if_needed()
        await pg.screenshot(path='shots/s3_m_sketch.png')
        await pg.tap('.sktools button:has-text("Arrange rooms")'); await pg.wait_for_timeout(200)
        R['m_arranging']=await pg.evaluate("document.querySelector('.skwrap').classList.contains('arranging')")
        await pg.screenshot(path='shots/s3_m_spaces.png',full_page=True)
        R['m_errors']=logs
        await b.close()
    srv.kill(); print(json.dumps(R,indent=1,ensure_ascii=False))
asyncio.run(main())
