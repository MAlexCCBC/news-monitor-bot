import test from "node:test";
import assert from "node:assert/strict";
import {requiresIncidentReview,incidentEvidenceDecision,shouldReviewIncident} from "../src/filter/incident-policy.js";
import {hasStrongRomanianPoliticalContext,hasStrongRomanianContext,hasMajorRomanianEmergencyContext} from "../src/filter/keywords.js";
import {FIRE_AUDIT_CASES} from "./fixtures/fire-cases.js";
const check=(item,category,quotes=[{source:"excerpt",quote:item.excerpt}])=>incidentEvidenceDecision(JSON.stringify({category,evidence:quotes}),{
  ...item,
  hasRomanianContext:proof=>hasStrongRomanianContext(proof,["Bolojan"]),
  hasMajorEmergency:hasMajorRomanianEmergencyContext,
});
test("incident headlines cannot bypass relevance because an official or political building is named",()=>{
  for (const title of ["Incendiu la sediul Guvernului din București","Incendiu în Sibiu. Primarul anunță evacuarea","Ministrul din România a demisionat după incendiul de la spital"]) {
    assert.equal(requiresIncidentReview(title),true);
    assert.equal(hasStrongRomanianPoliticalContext(title,[]),false);
  }
  assert.equal(requiresIncidentReview("Discurs incendiar al premierului despre buget"),false);
});
test("local fires, incidental ministers and burned hectares cannot satisfy emergency/political evidence",()=>{
  for(const item of FIRE_AUDIT_CASES.filter(x=>!x.expected)) {
    assert.equal(check(item,"OTHER").relevant,false);
    assert.equal(check(item,"POLITICAL").relevant,false,item.id);
    assert.equal(check(item,"MAJOR_EMERGENCY").relevant,false,item.id);
    assert.equal(check(item,"SECURITY").relevant,false,item.id);
  }
});
test("genuine political accountability, national security and coordinated emergencies survive",()=>{
  for(const [id,category] of [["political-accountability","POLITICAL"],["security-drone","SECURITY"],["national-mobilization","MAJOR_EMERGENCY"]]) {
    assert.equal(check(FIRE_AUDIT_CASES.find(x=>x.id===id),category).relevant,true,id);
  }
});
test("positive model verdict without literal grounded evidence fails closed",()=>{
  const item=FIRE_AUDIT_CASES.find(x=>x.id==="political-accountability");
  assert.equal(check(item,"POLITICAL",[]).relevant,false);
  assert.equal(check(item,"POLITICAL",[{source:"excerpt",quote:"Guvernul României a adoptat o lege care nu apare în articol."}]).relevant,false);
  assert.equal(check(item,"POLITICAL",[{source:"sidebar",quote:item.excerpt}]).relevant,false);
  assert.equal(check(item,"POLITICAL",[{source:"excerpt",quote:"Guvernul"}]).relevant,false);
  assert.equal(incidentEvidenceDecision("DA",{}).relevant,false);
  assert.equal(incidentEvidenceDecision("null",{}).relevant,false);
});
test("large burned area or a single-county military intervention is not national mobilization",()=>{
  assert.equal(hasMajorRomanianEmergencyContext("Incendiu de vegetație în Sibiu pe peste 500 de hectare; pompierii ISU intervin."),false);
  assert.equal(hasMajorRomanianEmergencyContext("Incendiu de pădure în Sibiu; autoritățile intervin cu un avion militar Spartan."),false);
  assert.equal(hasMajorRomanianEmergencyContext("Incendii de pădure în Franța în două județe; peste 300 de pompieri intervin."),false);
  assert.equal(hasMajorRomanianEmergencyContext(FIRE_AUDIT_CASES.at(-1).title+"\n"+FIRE_AUDIT_CASES.at(-1).excerpt),true);
});

test("fire evidence in the lead also disables an official-statement fast path",()=>{
  const title="Primarul din Sibiu anunță intervenția autorităților";
  const lead="Pompierii intervin la un incendiu într-un depozit din Sibiu.";
  assert.equal(requiresIncidentReview(title,lead),true);
  assert.equal(hasStrongRomanianPoliticalContext(title+"\n"+lead,[]),false);
});
test("negated exceptional resources cannot turn a local fire into a national emergency",()=>{
  assert.equal(hasMajorRomanianEmergencyContext("Incendiu de pădure în Sibiu. Nu există aeronave militare sau o urgență națională."),false);
  assert.equal(hasMajorRomanianEmergencyContext("Incendii de pădure în două județe din România. Nu au fost mobilizați peste 300 de pompieri."),false);
});

test("automatic Digi24 incident review survives channel bypass while manual commands remain explicit overrides",()=>{
  const request={title:"Incendiu la o hală în Sibiu",url:"https://www.digi24.ro/stiri/incendiu-1234567",checkForeignRelevance:false};
  assert.equal(shouldReviewIncident(request),true);
  assert.equal(shouldReviewIncident({...request,forceManual:true}),false);
  assert.equal(shouldReviewIncident({...request,url:"https://digi24.ro.evil.example/story"}),false);
  assert.equal(shouldReviewIncident({...request,title:"PNL prezintă bugetul"}),false);
  assert.equal(shouldReviewIncident({...request,url:"https://example.com/game-news"}),false);
});
