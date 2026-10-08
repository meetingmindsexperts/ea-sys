// Unit test for the language filter (src/filter.js). Run: node tests/filter_unit.js
// The cases deliberately contain offensive words: that is what the filter must catch.
const fs=require('fs'),vm=require('vm'),path=require('path');const ctx={console};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname,'..','src','filter.js'),'utf8')+';this.F=new LangFilter();',ctx);const F=ctx.F;
const cases=[['You are a fucking idiot',1],['f u c k this',1],['f.u.c.k off',1],['sh1t happens',1],['fuuuuck',1],['f*ck you',1],['what a bitch',1],['BULLSHIT',1],['you ass',1],['asss',1],['kos omak',1],['mishmash shipping',0],['bitcoin wallet',0],['kosomak',1],['يا شرموطة',1],['ابن الكلب',1],['كسمك',1],['كُسّ',1],['a7a ya man',1],['Meet at the Scunthorpe stand',0],['Cocktails at 7 in the lounge',0],['Please assess the class pass',0],['We need 3 4 5 chairs',0],['as soon as possible',0],['I am in Hall A',0],['Dickens was a writer',0],['Lovely session on cell therapy',0],['Kosovo delegation arrived',0],['Shiitake risotto at lunch',0],['مرحبا بكم في المؤتمر',0],['كلب',0],['@ 5 pm',0],['class of 2026',0],['he is a dick',1],['you are an a$$',1]];
let bad=0;for(const [t,exp] of cases){const r=F.check(t);const ok=(r.hit?1:0)===exp;if(!ok)bad++;console.log((ok?'ok ':'XX ')+JSON.stringify(t).padEnd(40),'->',r.text);}
F.setConfig({on:true,mode:'mask',extra:['rubbish'],allow:[]});console.log(F.check('what rubbish talk').text, F.check('rubbishy').text);
F.setConfig({on:false});console.log('off:',F.check('fuck').hit);console.log('bad',bad);process.exit(bad?1:0);
