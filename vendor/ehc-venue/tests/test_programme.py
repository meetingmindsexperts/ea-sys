# EA-SYS (phase 6 step 4): the event's programme inside the venue, sent as window.EHC_PROGRAMME.
# A generated venue (the congress fixture) and EHC's own rooms each get sessions placed in rooms and
# sponsors; the venue clock is set so one session is on now. Checked: screens show the session on now
# or next, stands carry sponsors (logo and website in the card), the guide lists the day's sessions
# and the ones that name no room, offline answers know what's on, and nothing logs an error.
import os, sys; TESTS = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(TESTS); sys.path.insert(0, TESTS); os.chdir(ROOT)
import asyncio, base64, json, subprocess, time
from playwright.async_api import async_playwright
ARGS=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']
MOCK=open('tests/mock.js').read()
PORT=8797
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
NOW='2026-10-24T05:30:00Z'  # 09:30 in Dubai
def programme(plenary, hall):
    return {'v': 1, 'tz': 'Asia/Dubai', 'sessions': [
        {'room': plenary, 'title': 'Opening plenary', 'start': '2026-10-24T05:00:00Z', 'end': '2026-10-24T06:30:00Z', 'track': 'Plenary Hall'},
        {'room': hall, 'title': 'Thrombosis update', 'start': '2026-10-24T07:00:00Z', 'end': '2026-10-24T08:00:00Z', 'track': 'Haematology'},
        {'room': None, 'title': 'Satellite symposium', 'start': '2026-10-24T09:00:00Z', 'end': '2026-10-24T10:00:00Z', 'where': 'Al Majlis'},
        {'room': plenary, 'title': 'Day two keynote', 'start': '2026-10-25T05:00:00Z', 'end': '2026-10-25T06:00:00Z'},
    ], 'sponsors': [
        {'name': 'Novartis Middle East', 'tier': 'platinum', 'logo': '/uploads/logos/novartis.png', 'website': 'https://www.novartis.example/me', 'about': 'Platinum sponsor of the congress.'},
        {'name': 'AstraZeneca Gulf', 'tier': 'gold'},
        {'name': 'Bad Link Co', 'website': 'javascript:alert(1)', 'logo': 'http://plain.example/x.png'},
    ]}
CHECK='''(async () => {
  const E = __EHC, now = Date.parse(NOW_ISO); E.setNow(now); E.tick(2); await new Promise(r => setTimeout(r, 400));
  const scr = (zone) => E.W.screens.filter(s => s.base.zone === zone).map(s => ({ kicker: s.spec.kicker, title: s.spec.title, sub: s.spec.sub, pill: s.spec.pill || '' }));
  const hot = (id) => { const h = E.W.interact.find(i => i.id === id); return h ? { title: h.title, prompt: h.prompt, sponsor: h.sponsor ? h.sponsor.name : null, logo: h.sponsor ? h.sponsor.logo : null, website: h.sponsor ? h.sponsor.website : null } : null; };
  const out = { plenary: scr(PLENARY), hall: scr(HALL), stand1: hot('stand-1'), stand3: hot('stand-3'), stand5: hot('stand-5') };
  // the stand card: logo and website
  const s1 = E.W.interact.find(i => i.id === 'stand-1');
  if (s1) { E.place(s1.x, s1.z); E.tick(1); out.opened = E.openNear(); await new Promise(r => setTimeout(r, 300)); const box = document.getElementById('ispon'); out.card = box ? { img: (box.querySelector('img') || {}).getAttribute ? box.querySelector('img').getAttribute('src') : null, link: box.querySelector('a') ? box.querySelector('a').getAttribute('href') : null, rel: box.querySelector('a') ? box.querySelector('a').rel : null } : null; out.tags = [...document.querySelectorAll('#itags .tag')].map(t => t.textContent); E.closeSheets(); }
  document.getElementById('bAgenda').click(); await new Promise(r => setTimeout(r, 200));
  out.guide = document.getElementById('alist').innerText; out.guideKicker = document.getElementById('ak').textContent; E.closeSheets();
  out.answerRoom = E.social.programmeAnswer('what is on in the ' + PLENARY_NAME + '?');
  out.answerAny = E.social.programmeAnswer('what session is next?');
  out.answerStands = E.social.programmeAnswer('which sponsors have a stand?');
  return JSON.stringify(out);
})()'''
async def run(b, layout, plenary, hall, plenary_name, name, logs):
    ctx=await b.new_context(viewport={'width':1280,'height':720}); pg=await ctx.new_page()
    pg.on('console',lambda m: logs.append((name,m.type,m.text)) if m.type == 'error' else None)
    pg.on('pageerror',lambda e: logs.append((name,'pageerror',str(e))))
    await pg.route('**/fonts.googleapis.com/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))
    await pg.route('**/venue-fonts/**',lambda r: r.fulfill(status=200,body='',content_type='text/css'))
    await pg.route('**/uploads/**',lambda r: r.fulfill(status=200,body=PNG,content_type='image/png'))
    init=('window.EHC_LAYOUT='+(layout or 'null')+';window.EHC_EVENT={short:"BHS2026"};window.EHC_PROGRAMME='+json.dumps(programme(plenary, hall))+';'
          'window.__MOCKCFG={sample:"ok",room:true,owner:true};'+MOCK)
    await pg.add_init_script(init)
    await pg.goto(f'http://127.0.0.1:{PORT}/test.html'); await pg.wait_for_function('window.__EHC && window.__EHC.ready',timeout=60000)
    await pg.evaluate('__EHC.enter()'); await pg.wait_for_timeout(300)
    js=CHECK.replace('NOW_ISO',json.dumps(NOW)).replace('PLENARY_NAME',json.dumps(plenary_name)).replace('PLENARY',json.dumps(plenary)).replace('HALL',json.dumps(hall))
    rep=json.loads(await pg.evaluate(js))
    await ctx.close()
    return rep
async def main():
    srv=subprocess.Popen(['python3','-m','http.server',str(PORT),'-d','dist'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.6)
    R={}; logs=[]
    try:
        async with async_playwright() as p:
            b=await p.chromium.launch(args=ARGS)
            R['generated']=await run(b, open('tests/fixtures/layouts/congress.json').read(), 'plenary', 'hall-a', 'Plenary Hall', 'generated', logs)
            R['ehc']=await run(b, None, 'plenary', 'hallA', 'Plenary Ballroom', 'ehc', logs)
            await b.close()
    finally: srv.kill()
    R['errors']=logs
    print(json.dumps(R))
asyncio.run(main())
