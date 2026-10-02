import {arbitrateSimilarity} from "../src/similarity/ai-arbitrator.js";
import {applySimilarityAiReview} from "../src/similarity/embedding.js";
// Explicit opt-in: Gemini-only generation; no GPT or rewrite module.
if(!process.env.GEMINI_API_KEY) {
  console.log("[similarity-audit] BLOCKED: secure Gemini credential unavailable");
  process.exit(0);
}
const incoming={
  title:"Guvernul României a aprobat reducerea TVA pentru alimente de la 9% la 5%",
  content:"Guvernul României a aprobat astăzi reducerea cotei TVA pentru alimente de la 9% la 5%. Decizia fiscală este finală și a fost votată în ședința Executivului. Măsura se aplică produselor alimentare și intră în vigoare la 1 ianuarie. Ministrul Finanțelor a prezentat impactul asupra bugetului."
};
const cases=[
  {id:"same-decision",expected:true,title:"TVA la produsele alimentare scade de la 9% la 5%: decizie aprobată de Executiv",
   content:"Guvernul României a aprobat astăzi reducerea TVA pentru alimente de la 9% la 5%. Decizia a fost votată în ședința Executivului și intră în vigoare la 1 ianuarie. Ministrul Finanțelor a explicat efectul asupra bugetului."},
  {id:"different-object",expected:false,title:"Guvernul României aprobă reducerea TVA pentru combustibil",
   content:"Guvernul României a aprobat astăzi reducerea TVA pentru combustibil de la 19% la 15%. Decizia fiscală privește benzina și motorina, nu produsele alimentare. Măsura a fost votată în ședința Executivului și intră în vigoare la 1 ianuarie."},
  {id:"unrelated-recent-story",expected:false,title:"Senatul votează creșterea salariilor profesorilor",
   content:"Senatul a votat majorarea salariilor profesorilor cu 10%. Proiectul privește salarizarea în educație și va fi trimis Camerei Deputaților pentru votul final. Nu conține modificări ale TVA."},
  {id:"prior-proposal",expected:false,title:"Guvernul propune reducerea TVA la alimente de la 9% la 5%",
   content:"Guvernul României a propus reducerea TVA pentru alimente de la 9% la 5%. Este numai un proiect planificat, fără o decizie aprobată sau votată. Proiectul urmează să fie dezbătut în ședința Executivului, iar forma finală nu a fost adoptată."}
];
const review=await arbitrateSimilarity(incoming,cases);
let failed=0;
for(let i=0;i<cases.length;i++) {
  const item=cases[i], result=review?.results?.[i];
  const prior={...item,url:"https://audit.example/"+item.id,score:.93,isDuplicate:true,embeddingComparable:true};
  const final=applySimilarityAiReview([prior],[prior],{results:[result]});
  const pass=Boolean(result) && final.isDuplicate===item.expected && result.verdict!=="uncertain";
  console.log(JSON.stringify({audit:"similarity-gemini",id:item.id,expectedDuplicate:item.expected,actualDuplicate:final.isDuplicate,verdict:result?.verdict,probability:result?.duplicateProbability,reason:result?.reason,checks:result?.modelChecks?.map(x=>({model:x.model,verdict:x.verdict,validated:x.validatedVerdict,probability:x.duplicateProbability})),pass}));
  if(!pass) failed++;
}
if(failed)process.exitCode=1;
