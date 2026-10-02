import {isRelevantToRomania} from "../src/ai/relevance.js";
import {fetchArticle} from "../src/scraper/article.js";
import {FIRE_AUDIT_CASES} from "../test/fixtures/fire-cases.js";

// Explicit, bounded opt-in benchmark. Never imports/calls rewrite or OpenAI.
if (!process.env.GEMINI_API_KEY) {
  console.log("[fire-audit] BLOCKED: secure Gemini credential unavailable");
  process.exit(0);
}
let failures=0;
for(const item of FIRE_AUDIT_CASES) {
  const actual=await isRelevantToRomania(item.title,item.excerpt,{incident:true,personalities:["Bolojan"]});
  const pass=actual===item.expected;
  console.log(JSON.stringify({audit:"fire-gemini",id:item.id,expected:item.expected,actual,pass}));
  if(!pass) failures++;
}
// Live publisher extraction is reported separately from model verdict accuracy.
for(const url of [
  "https://www.digi24.ro/stiri/externe/protestele-elevilor-din-franta-iau-amploare-un-liceu-din-nantes-a-fost-incendiat-400-de-scoli-sunt-afectate-3972755",
  "https://www.digi24.ro/stiri/actualitate/incendiu-cu-degajari-mari-de-fum-la-o-statie-de-sortare-reciclare-deseuri-din-apropiere-de-sibiu-a-fost-emis-mesaj-ro-alert-3973937"
]) {
  try {
    const article=await fetchArticle(url);
    const contamination=/Nicușor Dan|Guvernul Mureșan|Bolojan|Nazare/.test(article.content);
    const incidentPresent=/incendi/i.test(article.content);
    console.log(JSON.stringify({audit:"fire-publisher",url,chars:article.content.length,contamination,incidentPresent}));
    if(contamination || !incidentPresent || article.content.length<200) failures++;
    else {
      const actual=await isRelevantToRomania(article.title,article.content.slice(0,1500),{incident:true,personalities:["Bolojan"]});
      console.log(JSON.stringify({audit:"fire-live-article",url,expected:false,actual,pass:actual===false}));
      if(actual!==false) failures++;
    }
  } catch(error) {
    console.log(JSON.stringify({audit:"fire-publisher",url,status:"blocked",reason:error.code || "publisher_fetch_failed"}));
    failures++;
  }
}
if(failures) process.exitCode=1;
