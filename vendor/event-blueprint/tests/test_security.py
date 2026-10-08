import os, sys; TESTS = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(TESTS); sys.path.insert(0, TESTS); os.chdir(ROOT)
from common import *
EVIL='0)"/><foreignObject width="9" height="9"><img xmlns="http://www.w3.org/1999/xhtml" src="x" onerror="window.__pwned=1"/></foreignObject><g transform="translate(0'
async def main():
    srv=serve(); R={}
    async with async_playwright() as p:
        b=await p.chromium.launch()
        pg,logs=await mk(b,{'sample':'ok'}); ev=pg.evaluate
        await pg.click('text=Start a new blueprint'); await pg.wait_for_timeout(300)
        await ev(FILL); await pg.wait_for_timeout(300); await ev('__EB.goto(12)'); await pg.wait_for_timeout(300)
        await pg.click('text=Save as template'); await pg.fill('.inline-form input','Gala format'); await pg.click('.inline-form .primary'); await pg.wait_for_timeout(300)
        tkey=await ev("Object.keys(__store).find(k=>k.startsWith('templates/'))")
        # tamper: own template + another owner's template, both with injection in sketch + odd types
        await ev("""([k,evil])=>{const st=JSON.parse(JSON.stringify(__store[k].state)); const rk=st.spaces[1].name.trim().toLowerCase(); st.sketch.rooms[rk]={x:evil,y:{a:1},aspect:'9;'}; st.spaces[0].cap={x:1}; st.concept='broken'; st.partners.list='nope';
          __store[k].state=st; __store['templates/tp_evil']={id:'tp_evil',name:'Evil shared template',type:'gala',ownerId:'u_other',created:Date.now()+1e6,state:st}; localStorage.setItem('__mockdb',JSON.stringify(__store));}""",[tkey,EVIL])
        await pg.click('text=All blueprints'); await pg.wait_for_timeout(600)
        R['otherOwnersTemplateListed']=await ev("!!document.body.innerText.includes('Evil shared template')")
        await pg.click('.svrow:has-text("Gala format") >> text=Use'); await pg.wait_for_timeout(400)
        for i in range(13): await ev(f'__EB.goto({i})'); await pg.wait_for_timeout(120)
        await ev('__EB.goto(3)'); await pg.wait_for_timeout(500)
        R['pwned_template']=await ev('window.__pwned||0')
        R['sketchRooms']=await ev("document.querySelectorAll('.skwrap g.room').length")
        R['savedSketch']=await ev("JSON.stringify(__EB.S.sketch.rooms)")
        R['concept']=await ev("typeof __EB.S.concept.bigIdea"); R['partners']=await ev("Array.isArray(__EB.S.partners.list)")
        # tampered blueprint doc in db, opened from the list
        bid=await ev("__EB.S.id")
        await ev("""([id,evil])=>{const k='blueprints/'+id; const d=__store[k]||JSON.parse(localStorage.getItem('eb-'+id)); d.sketch={rooms:{}}; d.sketch.rooms[d.spaces[0].name.trim().toLowerCase()]={x:evil,y:0}; d.updated=Date.now()+1e7; d.checkAck='x'; d.submissions=[null,'a',{at:'<b>'}]; __store[k]=d; localStorage.setItem('__mockdb',JSON.stringify(__store)); localStorage.setItem('eb-'+id, JSON.stringify(d));}""",[bid,EVIL])
        await pg.reload(); await pg.wait_for_timeout(800); await ev('__EB.goto(3)'); await pg.wait_for_timeout(500); await ev('__EB.goto(12)'); await pg.wait_for_timeout(500)
        R['pwned_blueprint']=await ev('window.__pwned||0')
        R['errors']=[l for l in logs]
        await pg.context.close(); await b.close()
    srv.kill(); print(json.dumps(R,indent=1))
asyncio.run(main())
