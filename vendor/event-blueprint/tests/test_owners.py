import os, sys; TESTS = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(TESTS); sys.path.insert(0, TESTS); os.chdir(ROOT)
from common import *
async def main():
    srv=serve(); R={}
    async with async_playwright() as p:
        b=await p.chromium.launch()
        for mobile in (False,True):
            pg,logs=await mk(b,{'sample':'ok'},mobile=mobile); ev=pg.evaluate; k='m_' if mobile else ''
            await pg.click('text=Start a new blueprint'); await pg.wait_for_timeout(300)
            await ev(FILL); await pg.wait_for_timeout(300); await ev('__EB.goto(3)'); await pg.wait_for_timeout(300)
            await pg.click('.ownerline button:has-text("Assign an owner")'); await pg.fill('.owner-form input[type=text]','Lina Alaa'); await pg.fill('.owner-form input[type=email]','not-an-email'); await pg.click('.owner-form .primary'); await pg.wait_for_timeout(150)
            R[k+'badEmail']=await ev("document.querySelector('.owner-form .note')?.textContent")
            await pg.fill('.owner-form input[type=email]','lina@example.com'); await pg.click('.owner-form .primary'); await pg.wait_for_timeout(200)
            R[k+'line']=await ev("document.querySelector('.ownerline').textContent")
            R[k+'badge']=await ev("[...document.querySelectorAll('.step .oav, #rail .oav')].map(e=>e.textContent)")
            await ev('__EB.goto(4)'); await pg.wait_for_timeout(200); await pg.click('.ownerline button:has-text("Assign an owner")'); await pg.fill('.owner-form input[type=text]','Karim'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(200)
            await ev('__EB.goto(12)'); await pg.wait_for_timeout(400)
            R[k+'table']=await ev("[...document.querySelectorAll('.otable tbody tr')].filter(r=>!r.textContent.includes('—')).map(r=>r.textContent)")
            R[k+'md']='## Section owners' in await ev('__EB.toMarkdown()')
            if not mobile:
                await pg.click('text=Submit blueprint'); await pg.wait_for_timeout(600)
                await ev("(()=>{__EB.S.owners.spaces={name:'Medhat',email:''}; delete __EB.S.owners.programme;})()")
                R['pending']=await ev("__EB.pending().map(x=>x.text)")
                R['sanitised']=await ev("(()=>{const s=JSON.parse(JSON.stringify(__EB.S)); s.owners={spaces:{name:'<b>x</b>',email:'javascript:x'},bogus:{name:'y'},files:'str'}; __EB.openBlueprint(s); return JSON.stringify(__EB.S.owners)})()")
            R[k+'hscroll']=await ev("document.documentElement.scrollWidth>innerWidth")
            if mobile: await ev('__EB.goto(3)'); await pg.wait_for_timeout(200)
            R[k+'errors']=logs
            await pg.context.close()
        await b.close()
    srv.kill(); print(json.dumps(R,indent=1))
asyncio.run(main())
