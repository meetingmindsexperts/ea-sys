import os, sys; TESTS = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(TESTS); sys.path.insert(0, TESTS); os.chdir(ROOT)
import asyncio, json, subprocess, time
from playwright.async_api import async_playwright
MOCK=open('tests/mock.js').read()
PDFDIR=os.environ.get('PDFJS_DIR')  # optional: a local pdfjs-dist/build folder, so the PDF test runs offline
async def routes(pg):
    await pg.route('**/fonts.googleapis.com/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))
    await pg.route('**/blueprint-fonts/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))  # EA-SYS: fonts are served by EA-SYS, not by this bare test server
    async def cdn(route):
        name=route.request.url.split('/')[-1]
        if not PDFDIR: return await route.continue_()
        await route.fulfill(status=200, body=open(os.path.join(PDFDIR,name),'rb').read(), headers={'content-type':'text/javascript','access-control-allow-origin':'*'})
    # uploads in the mock return /_blob/<id> URLs; serve a tiny image so thumbnails load
    await pg.route('**/_blob/**', lambda r: r.fulfill(status=200, body=open('tests/fixtures/test_plan.png','rb').read(), content_type='image/png'))
    await pg.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.2.108/*', cdn)
async def mk(b, cfg, mobile=False, dark=False):
    kw=dict(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True) if mobile else dict(viewport={'width':1360,'height':900})
    ctx=await b.new_context(color_scheme='dark' if dark else 'light',**kw); pg=await ctx.new_page(); logs=[]
    pg.on('console',lambda m: logs.append((m.type,m.text)) if m.type in ('error','warning') else None)
    pg.on('pageerror',lambda e: logs.append(('pageerror',str(e))))
    await routes(pg)
    if cfg is not None: await pg.add_init_script(f'window.__MOCKCFG={json.dumps(cfg)};'+MOCK)
    await pg.goto('http://127.0.0.1:8766/test.html'); await pg.wait_for_timeout(500)
    return pg, logs
async def main():
    srv=subprocess.Popen(['python3','-m','http.server','8766','-d','dist'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.6)
    R={}
    async with async_playwright() as p:
        b=await p.chromium.launch()
        pg,logs=await mk(b,{'sample':'ok'})
        # 1. talk it through from home
        await pg.click('text=Start by talking it through'); await pg.wait_for_selector('#qfText')
        await pg.fill('#qfText','An awards night for 400 guests in Dubai, black tie, premium and warm. Red carpet then dinner then awards. Acme Bank is gold sponsor. Must be live by 15 Feb 2027, Lina owns it.')
        await pg.set_input_files('#qfFile','tests/fixtures/test_programme.pdf')
        await pg.click('text=Fill the blueprint'); await pg.wait_for_selector('.qlist',timeout=20000)
        R['qfPromptHasWords']='black tie' in (await pg.evaluate('__mock.qf.prompt'))
        R['qfPromptHasPdfText']='Awards ceremony' in (await pg.evaluate('__mock.qf.prompt'))
        R['qfItems']=await pg.evaluate("[...document.querySelectorAll('.qlist .ql')].map(e=>e.textContent)")
        R['languagesFiltered']=await pg.evaluate("[...document.querySelectorAll('.qlist li')].find(li=>li.querySelector('.ql').textContent==='Languages')?.querySelector('.qv').textContent")
        await pg.screenshot(path='shots/s1_qf_review.png')
        await pg.click('.qcard .actions .primary'); await pg.wait_for_timeout(400)
        S=await pg.evaluate('__EB.S')
        R['applied']={'type':S['type'],'title':S['basics']['title'],'spaces':len(S['spaces']),'prog':len(S['programme']['rows']),'partner':S['partners']['list'],'deadline':S['delivery']['deadline'],'notesSaved':'black tie' in S['notes'],'uploadsKept':len(S['files']['uploads']),'avatarsPrefilled':S['avatars']['prefilled'],'abilities':len(S['avatars']['abilities'])}
        # placeholders follow type
        await pg.evaluate('__EB.goto(1)'); R['titlePlaceholder']=await pg.get_attribute('#f_basics_title','placeholder')
        # 2. image in quick fill
        await pg.click('.qfbtn'); await pg.set_input_files('#qfFile','tests/fixtures/test_plan.png'); await pg.click('text=Fill the blueprint'); await pg.wait_for_selector('.qlist',timeout=20000)
        R['imageSent']=await pg.evaluate('__mock.qf.images')
        R['secondPassRowsUnticked']=await pg.evaluate("[...document.querySelectorAll('.qlist li')].filter(li=>li.querySelector('.qo')).map(li=>[li.querySelector('.ql').textContent, li.querySelector('input').checked])")
        await pg.click('.qcard >> text=Back'); await pg.click('#qfClose')
        # 3. avatars section
        await pg.evaluate('__EB.goto(6)'); await pg.wait_for_timeout(200)
        await pg.screenshot(path='shots/s1_avatars.png',full_page=True)
        await pg.click('.card:has-text("Stylised premium")'); await pg.click('button.chip:has-text("Customise (skin, hair, outfit)")'); await pg.click('button.chip:has-text("Only with recorded consent")')
        R['avatarSectionStatus']=await pg.evaluate("__EB.score().sec.avatars")
        # 4. uploads
        await pg.evaluate('__EB.goto(11)'); await pg.wait_for_timeout(200)
        await pg.set_input_files('#upInput','tests/fixtures/test_plan.png'); await pg.wait_for_timeout(500)
        R['uploadsListed']=await pg.evaluate("document.querySelectorAll('.upitem').length")
        await pg.click('.upitem .del >> nth=0'); await pg.click('.upitem .inline-confirm .secondary'); await pg.wait_for_timeout(300)
        R['afterRemove']=await pg.evaluate("document.querySelectorAll('.upitem').length")
        # fill the remaining blockers quickly via state then submit
        await pg.evaluate("""(()=>{const S=__EB.S; S.basics.purpose='Celebrate this year’s best work and the people behind it'; S.basics.audience='Nominees, partners, VIPs'; S.concept.goals=['Celebrate']; S.concept.bigIdea='A night where every winner gets a cinematic moment on stage.'; S.look.brand='no'; S.look.style=['Elegant','Luxury']; S.look.venueKind='imagined'; S.look.setting='Hotel ballroom'; S.online.features=['Walk the venue in 3D','Watch live or recorded sessions']; S.online.access='Invite only'; S.people.hosts=[]; __EB.goto(12);})()""")
        await pg.wait_for_timeout(300)
        R['blockingBeforeSubmit']=await pg.evaluate("__EB.score().blocking.map(x=>x.label)")
        await pg.screenshot(path='shots/s1_review.png',full_page=True)
        await pg.click('text=Submit blueprint'); await pg.wait_for_selector('.ack',timeout=5000)
        R['ack']=await pg.evaluate("({ref:document.querySelector('.ackdl .mono').textContent, title:document.querySelector('.ack h2').textContent, saved:document.querySelector('.ack p').textContent})")
        await pg.screenshot(path='shots/s1_ack.png',full_page=True)
        await pg.click('text=See progress'); await pg.wait_for_timeout(300)
        R['trackerNow']=await pg.evaluate("document.querySelector('.steps-v li.now .tl').textContent")
        # edit after submission -> pending changes
        await pg.evaluate("__EB.goto(3)"); await pg.click('text=+ Add a space'); await pg.fill('.row input >> nth=-3','VIP lounge')
        await pg.evaluate("__EB.goto(1)"); await pg.fill('#f_basics_attendance','450 guests')
        R['pending']=await pg.evaluate("__EB.pending().map(x=>x.text)")
        R['statusBar']=await pg.evaluate("document.getElementById('statusBar').innerText")
        await pg.evaluate('__EB.goto(12)'); await pg.wait_for_timeout(200)
        await pg.click('button.primary:has-text("Send update")'); await pg.wait_for_selector('.ack')
        R['updateAck']=await pg.evaluate("document.querySelector('.ack .eyebrow').textContent")
        R['pendingAfter']=await pg.evaluate("__EB.pending().length")
        await pg.click('text=See progress')
        # build team moves to plan_ready, owner approves
        await pg.select_option('.teamctl select','plan_ready'); await pg.click('.teamctl .secondary'); await pg.wait_for_timeout(200)
        R['approveVisible']=await pg.is_visible('.approve button')
        await pg.click('.approve button'); await pg.wait_for_timeout(300)
        R['afterApprove']=await pg.evaluate("[__EB.S.status, !!__EB.S.approvals.plan]")
        await pg.screenshot(path='shots/s1_tracker.png',full_page=True)
        # template + duplicate
        await pg.click('text=Save as template'); await pg.fill('.inline-form input','Awards night format'); await pg.click('.inline-form .primary'); await pg.wait_for_timeout(300)
        await pg.click('#homeBtn'); await pg.wait_for_timeout(600)
        R['homeRows']=await pg.evaluate("[...document.querySelectorAll('.svrow')].map(r=>r.innerText.replace(/\\n+/g,' | '))")
        await pg.screenshot(path='shots/s1_home.png',full_page=True)
        await pg.click('.svrow:has-text("Awards night format") >> text=Use'); await pg.wait_for_timeout(300)
        S2=await pg.evaluate('__EB.S'); R['fromTemplate']={'title':S2['basics']['title'],'spaces':len(S2['spaces']),'status':S2['status'],'deadline':S2['delivery']['deadline'],'partners':len(S2['partners']['list'])}
        dbkeys=await pg.evaluate("Object.keys(__store)"); R['dbKeys']=dbkeys
        R['errors']=[l for l in logs if l[0] in ('error','pageerror')]
        await pg.context.close()
        # local mode (no claude), mobile dark
        pg,logs=await mk(b,None,mobile=True,dark=True)
        await pg.click('text=Start a new blueprint'); await pg.click('text=Product launch'); await pg.evaluate('__EB.goto(1)')
        R['localPlaceholder']=await pg.get_attribute('#f_basics_title','placeholder')
        R['localSubtitle']=await pg.evaluate("document.getElementById('subTitle').textContent")
        await pg.click('.qfbtn'); await pg.fill('#qfText','test notes'); await pg.click('text=Save as notes'); await pg.wait_for_timeout(300)
        R['localNotes']=await pg.evaluate('__EB.S.notes')
        await pg.evaluate('__EB.goto(12)'); await pg.click('text=Submit blueprint'); await pg.wait_for_selector('.ack')
        R['localAckText']=await pg.evaluate("document.querySelector('.ack p').textContent")
        await pg.screenshot(path='shots/s1_m_ack.png')
        await pg.evaluate('__EB.goto(6)'); await pg.evaluate('window.scrollTo(0,0)'); await pg.screenshot(path='shots/s1_m_avatars.png')
        await pg.evaluate('__EB.goto(11)'); await pg.evaluate('window.scrollTo(0,0)'); await pg.screenshot(path='shots/s1_m_files.png')
        R['hScroll']=await pg.evaluate("document.documentElement.scrollWidth>window.innerWidth")
        R['mErrors']=[l for l in logs if l[0] in ('error','pageerror')]
        await pg.context.close(); await b.close()
    srv.terminate(); print(json.dumps(R,indent=1,ensure_ascii=False))
asyncio.run(main())
