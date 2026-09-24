import test from "node:test";
import assert from "node:assert/strict";

import { evaluate3ZoneSimilarity, isSamePublisherSource, selectSimilarityCandidate } from "../src/similarity/embedding.js";

test("same publisher requires 97% similarity and never inflates the reported score", () => {
  const bodyNew = "Sorin Grindeanu a anunțat că PSD va vota învestirea Guvernului după consultările de luni. Partidul a cerut clarificări privind programul economic și calendarul reformelor.";
  const bodyOld = "Sorin Grindeanu a spus că PSD va decide după consultările de luni dacă votează învestirea Guvernului. Social-democrații solicită clarificări despre programul economic și calendarul reformelor.";
  const below = evaluate3ZoneSimilarity(.96,
    "Grindeanu anunță poziția PSD la votul pentru Guvern", bodyNew,
    "PSD decide după consultări dacă votează Guvernul", bodyOld, .80, { samePublisher: true });
  assert.equal(below.isDuplicate, false);
  assert.equal(below.score, .96);

  const above = evaluate3ZoneSimilarity(.98,
    "Grindeanu anunță poziția PSD la votul pentru Guvern", bodyNew,
    "PSD decide după consultări dacă votează Guvernul", bodyOld, .80, { samePublisher: true });
  assert.equal(above.isDuplicate, true);
  assert.equal(above.score, .98);
});

test("publisher matching ignores www but distinguishes different publishers", () => {
  assert.equal(isSamePublisherSource("https://www.hotnews.ro/a", "https://hotnews.ro/b"), true);
  assert.equal(isSamePublisherSource("https://hotnews.ro/a", "https://digi24.ro/b"), false);
  assert.equal(isSamePublisherSource(null, "https://hotnews.ro/b"), false);
});

test("different speakers reacting to a proposed coalition remain separate stories", () => {
  const background = "Formarea unei majorități presupune negocieri între partide, discuții parlamentare, susținerea unui program comun și stabilirea unui calendar pentru consultări. Variantele de colaborare depind de voturile parlamentarilor și de acordul conducerilor politice.";
  assert.equal(evaluate3ZoneSimilarity(.810033,
    "Exclusiv Petrișor Peiu reacționează după ce Sorin Grindeanu a vorbit despre un guvern PSD-AUR: Orice este posibil. Ce condiții pune",
    "Petrișor Peiu a declarat că o astfel de variantă este posibilă numai dacă sunt respectate regulile democratice.\n\n" + background,
    "Nicușor Dan mută discuția de la PSD-AUR la testul Mureșan: Mai întâi să vedem dacă trece",
    "Președintele Nicușor Dan a declarat că trebuie să ne concentrăm dacă nominalizarea va avea succes.\n\n" + background).isDuplicate, false);
});

test("an explicitly marked editorial may quote a report without being its duplicate", () => {
  const quotation = "Nicușor Dan a declarat că este responsabilitatea DIICOT să lămurească faptele și că respectă prezumția de nevinovăție. Președintele a explicat că dosarul nu are legătură cu alegerile.";
  assert.equal(evaluate3ZoneSimilarity(.918,
    "Georgescu – DIICOT: De unde știe președintele Nicușor Dan că dosarul nu are legătură cu alegerile?",
    "Coordonator editorial\n\n" + quotation + "\n\nAceastă afirmație ridică o problemă privind separația puterilor.",
    "Nicușor Dan, după reținerea lui Călin Georgescu: Cei care nu au încredere în justiție sunt 75%",
    quotation).isDuplicate, false);
});

test("reversed headline order of two participants does not split the same meeting", () => {
  assert.equal(evaluate3ZoneSimilarity(.95,
    "Maia Sandu discută cu Nicușor Dan despre securitatea energetică",
    "Maia Sandu a declarat după întâlnire că securitatea energetică este prioritară. Cooperarea bilaterală și interconexiunile sunt pe agenda discuțiilor.",
    "Nicușor Dan discută cu Maia Sandu despre securitatea energetică",
    "Nicușor Dan a declarat după întâlnire că securitatea energetică este prioritară. Cooperarea bilaterală și interconexiunile sunt pe agenda discuțiilor.").isDuplicate, true);
});

test("identical substantial articles do not require proper names", () => {
  const body = "furtuna a doborât copaci pe carosabil și a întrerupt alimentarea cu electricitate în mai multe cartiere. echipele de intervenție au degajat străzile și au reparat cablurile avariate.";
  assert.equal(evaluate3ZoneSimilarity(.98, "furtuna a provocat avarii", body,
    "furtuna a provocat avarii", body).isDuplicate, true);
});

test("shared political background in long articles cannot override different reported developments", () => {
  const background = "Contextul crizei presupune negocieri parlamentare, voturi pentru învestitură, consultări constituționale, majorități fragile, alianțe politice, propuneri pentru portofolii ministeriale, declarații televizate, discuții despre calendarul alegerilor, analize bugetare, măsuri economice, cheltuieli publice, responsabilități instituționale, decizii administrative, obligații fiscale, salarii, pensii, investiții, reforme și încrederea populației.";
  const a = "Traian Băsescu consideră că relațiile europene vor continua normal în cazul unui acord parlamentar.\n\nFostul lider discută despre politica externă și apartenența la Uniunea Europeană.\n\n" + background;
  const b = "Traian Băsescu se îndoiește că premierul desemnat va reuși să își alcătuiască echipa.\n\nEl oferă șanse puține formării cabinetului și explică obstacolele învestirii.\n\n" + background;
  const result = evaluate3ZoneSimilarity(.94,
    "Băsescu: relațiile cu UE nu vor fi afectate de o înțelegere cu AUR", a,
    "Băsescu nu îi dă mari șanse lui Siegfried Mureșan să facă un alt fel de Guvern", b);
  assert.equal(result.isDuplicate, false);
  assert.equal(result.score, .94, "do not manufacture a different semantic score after arbitration");
});

test("different CCR cases are not duplicates just because the articles share institutional background", () => {
  const safeCase = "Data actualizării: 23.09.2026 07:58\n\nUrmărește Digi24 în Google Discover Adaugă Digi24 ca sursă preferată în Google\n\nCurtea Constituțională a României (CCR) ar putea lua o decizie miercuri în cazul sesizării președintelui Camerei Deputaților, Sorin Grindeanu, privind un posibil conflict juridic de natură constituțională între Guvern și Parlament, declanșat prin emiterea Ordonanței de urgență referitoare la Programul SAFE. În sesizare, Grindeanu contestă adoptarea ordonanței după moțiunea de cenzură și cere Curții să verifice limitele constituționale ale Guvernului interimar.";
  const salaryCase = "Data publicării: 23.09.2026 07:51\n\nUrmărește Digi24 în Google Discover Adaugă Digi24 ca sursă preferată în Google\n\nCurtea Constituțională discută miercuri sesizarea depusă de premierul interimar Ilie Bolojan cu privire la soluționarea unui conflict juridic de natură constituțională între Guvern și Înalta Curte de Casație și Justiție în legătură cu plata restanțelor salariale ale magistraților. Litigiul privește obligația Guvernului de a plăti drepturile salariale restante și penalitățile stabilite de instanță.";
  const result = evaluate3ZoneSimilarity(.842977,
    "Sesizarea lui Sorin Grindeanu privind un posibil conflict constituțional între Parlament și Guvern, pe agenda CCR de miercuri",
    safeCase,
    "CCR discută sesizarea lui Bolojan privind conflictul constituțional dintre ÎCCJ și Guvern legat de restanțele salariale din justiție",
    salaryCase);

  assert.equal(result.isDuplicate, false);
  assert.equal(result.score, .842977);

  const updatedSafeTitle = "CCR a amânat pentru 30 septembrie decizia privind sesizarea lui Sorin Grindeanu referitoare la Programul SAFE";
  const updatedSafeLead = "Curtea Constituțională a României (CCR) a amânat miercuri, pentru 30 septembrie, luarea unei decizii în cazul sesizării președintelui Camerei Deputaților, Sorin Grindeanu, privind un posibil conflict juridic de natură constituțională între Guvern și Parlament, declanșat prin emiterea Ordonanței de urgență referitoare la Programul SAFE.\n\nSorin Grindeanu a cerut Curții Constituționale să constate existența acestui conflict juridic de natură constituțională între Parlament și Guvern și să stabilească conduita de urmat în vederea restabilirii ordinii constituționale.";
  const salaryLead = "Curtea Constituţională discută miercuri sesizarea depusă de premierul interimar Ilie Bolojan cu privire la soluţionarea unui conflict juridic de natură constituţională între Guvern şi Înalta Curte de Casaţie şi Justiţie în legătură cu plata restanţelor salariale ale magistraţilor.\n\nSesizarea a fost depusă după ce Instanţa supremă a dat Guvernul în judecată şi a câştigat în primă instanţă, pentru neplata acestor restanţe salariale, apărute ca urmare a unor majorări stabilite retroactiv prin hotărâri judecătoreşti.";
  const updatedResult = evaluate3ZoneSimilarity(.8456137821840438,
    updatedSafeTitle, updatedSafeLead,
    "CCR discută sesizarea lui Bolojan privind conflictul constituțional dintre ÎCCJ și Guvern legat de restanțele salariale din justiție",
    salaryLead);

  assert.equal(updatedResult.isDuplicate, false, "the real 84.6% false positive must be allowed through");
  assert.equal(updatedResult.score, .8456137821840438);
});

test("a later phone call is not merged with an earlier planned meeting just because actors match", () => {
  const earlierTitle = "Bolojan și Grindeanu, discuții despre noul guvern, fără premierul desemnat. Când se întâlnește Siegfried Mureșan cu social-democrații";
  const earlierBody = "Ilie Bolojan și Sorin Grindeanu urmau să discute despre noul Guvern, fără participarea premierului desemnat Siegfried Mureșan. Întâlnirea cu Mureșan era așteptată ulterior, în cadrul negocierilor pentru programul de guvernare.";
  const metTitle = "Grindeanu și Bolojan s-au întâlnit să discute despre premierul desemnat. Liderul PSD a vorbit la telefon cu Siegfried Mureșan";
  const metBody = "Ilie Bolojan și Sorin Grindeanu s-au întâlnit în această dimineață pentru a discuta despre viitorul Guvern. Separat, liderul PSD a vorbit la telefon cu premierul desemnat Siegfried Mureșan despre programul de guvernare.";
  const callTitle = "Sorin Grindeanu a discutat cu premierul desemnat, Siegfried Mureșan";
  const callBody = "Sorin Grindeanu a purtat o convorbire telefonică cu premierul desemnat Siegfried Mureșan despre negocierile pentru guvern și programul de guvernare. Discuția a avut loc după întâlnirea dintre Grindeanu și Ilie Bolojan, la care Mureșan nu a participat.";

  assert.equal(evaluate3ZoneSimilarity(.91997, metTitle, metBody, earlierTitle, earlierBody).isDuplicate, false);
  assert.equal(evaluate3ZoneSimilarity(.90082, callTitle, callBody, earlierTitle, earlierBody).isDuplicate, false);
});

test("the same AUR policy proposals across outlets survive headline, photo-caption, and date furniture", () => {
  const digiTitle = "Ce soluții propune AUR în oglindă cu cele 10 priorități ale PSD pentru guvernare";
  const hotnewsTitle = "„Decalogul” AUR pentru guvernare. Răspuns în oglindă față de PSD, inclusiv „o diplomație de 360 de grade”";
  const digiBody = "Parlamentarii AUR au prezentat, marți, prioritățile formațiunii, sub forma unui răspuns la cele 10 propuneri avansate anterior de PSD pentru un viitor program de guvernare, printre acestea fiind scăderea TVA, a impozitelor pe dividende, reducerea numărului de parlamentari la 300, relansarea sectorului energetic, a agriculturii și o diplomație de 360 de grade.\n\nComisiile de specialitate din cadrul AUR au organizat o conferință cu temele Răspunsul AUR la cele 10 priorități propuse de PSD și PNRR și fonduri europene, moderată de deputata Ramona-Ioana Bruynseels.";
  const hotnewsBody = [
    "Ramona-Ioana Bruynseels, la Palatul Parlamentului. FOTO: Inquam Photos / Codrin Unici",
    hotnewsTitle,
    "Publicat 22.09.2026 20:03",
    "Urmărește-ne în Google Discover",
    "Parlamentarii AUR au prezentat, marți, prioritățile formațiunii, sub forma unui răspuns la cele 10 propuneri avansate anterior de PSD pentru un viitor program de guvernare.",
    "Printre aceste măsuri se află scăderea TVA, a impozitelor pe dividende, reducerea numărului de parlamentari la 300, relansarea sectorului energetic, a agriculturii, precum și o diplomație de 360 de grade.",
  ].join("\n\n");
  const result = evaluate3ZoneSimilarity(.966099,
    digiTitle, digiBody,
    hotnewsTitle, hotnewsBody);

  assert.equal(result.isDuplicate, true);
  assert.equal(result.score, .966099);
});

test("a roundup and a focused report are duplicates when most of the full report is reused", () => {
  const roundupTitle = "Două conflicte cu mize mari, pe masa CCR. Sesizările făcute de Grindeanu și Bolojan, analizate azi";
  const focusedTitle = "CCR, decizie crucială: Înalta Curte cere plata restanțelor salariale ale magistraților";
  const quotedReport = "În luna martie, Înalta Curte de Casație a sesizat Curtea de Apel București, solicitând obligarea Guvernului să achite 4,8 miliarde lei, sume reprezentând restanțe salariale câștigate prin procese sau penalități la aceste restanțe. Ce am constatat foarte repede este că existau mai multe hotărâri judecătorești care stabileau drepturi salariale restante ale magistraților și obligații de plată pentru Guvern.";
  const roundupBody = [
    "Curtea Constituțională discută miercuri despre două conflicte juridice majore care pun față în față Guvernul, Parlamentul și Înalta Curte de Casație și Justiție. Pe masa judecătorilor se află sesizarea privind programul SAFE, precum și disputa financiară legată de restanțele salariale ale magistraților.",
    "Sorin Grindeanu contestă adoptarea ordonanței SAFE de către Guvernul interimar și cere Curții să verifice limitele constituționale ale Executivului.",
    "CCR discută sesizarea depusă de premierul interimar Ilie Bolojan cu privire la soluționarea unui conflict juridic între Guvern și Înalta Curte de Casație și Justiție, în legătură cu plata restanțelor salariale ale magistraților.",
    quotedReport,
  ].join("\n\n");
  const focusedBody = [
    "Curtea Constituțională discută sesizarea depusă de premierul interimar Ilie Bolojan privind conflictul dintre Guvern și Înalta Curte de Casație și Justiție, în legătură cu plata restanțelor salariale ale magistraților.",
    "Guvernul a depus sesizarea după ce Înalta Curte a dat Executivul în judecată și a câștigat în primă instanță pentru neplata restanțelor salariale, apărute ca urmare a unor majorări stabilite retroactiv prin hotărâri judecătorești.",
    quotedReport,
    "Ministerul de Finanțe consideră că o astfel de decizie ar aduce atingere separației și echilibrului puterilor în stat și ar crea grave prejudicii bugetului de stat.",
  ].join("\n\n");
  const result = evaluate3ZoneSimilarity(.922,
    roundupTitle, roundupBody,
    focusedTitle, focusedBody);

  assert.equal(result.isDuplicate, true);
  assert.equal(result.score, .922);
});

test("separate Nicușor Dan meetings in New York are not merged by repeated site boilerplate", () => {
  const presidentsMeeting = "Data publicării: 23.09.2026 09:06\n\nUrmărește Digi24 în Google Discover Adaugă Digi24 ca sursă preferată în Google\n\nPreședintele Nicușor Dan s-a întâlnit, la New York, cu ocazia participării la Adunarea Generală a Națiunilor Unite, cu președintele Senegalului, Bassírou Diomaye Diakhar Faye, și cu președintele Republicii Guineea, Mamadi Doumbouya. Cei trei au discutat despre relațiile bilaterale și cooperarea economică.";
  const communityEvent = "Data publicării: 22.09.2026 17:36\n\nUrmărește Digi24 în Google Discover Adaugă Digi24 ca sursă preferată în Google\n\nPreședintele Nicușor Dan și partenera lui s-au întâlnit la New York cu membrii comunității românești. Șeful statului a participat și la dezvelirea plăcuței The Queen Marie of Romania Corner, în amintirea vizitei Reginei Maria în Statele Unite.";
  const result = evaluate3ZoneSimilarity(.821341,
    "Foto Nicușor Dan s-a întâlnit la New York cu președinții din Senegal și Guineea. Ce au vorbit șefii de stat",
    presidentsMeeting,
    "Foto Nicușor Dan a dezvelit plăcuța The Queen Marie of Romania Corner și s-a întâlnit cu românii din New York",
    communityEvent);

  assert.equal(result.isDuplicate, false);
  assert.equal(result.score, .821341);
});

test("generic Romanian headline overlap does not mark unrelated coverage as duplicate", () => {
  const result = evaluate3ZoneSimilarity(
    0.77,
    "Guvernul anunță sprijin pentru agricultori",
    "",
    "Guvernul anunță sancțiuni pentru companii",
    "",
    0.8
  );

  assert.equal(result.isDuplicate, false);
  assert.equal(result.zone, "GRI (Permis)");
});

test("shared named subject and matching headline terms still catch likely duplicates", () => {
  const result = evaluate3ZoneSimilarity(
    0.77,
    "Bolojan anunță reforma pensiilor pentru 2026",
    "",
    "Bolojan anunță reforma sistemului de pensii în 2026",
    "",
    0.8
  );

  assert.equal(result.isDuplicate, true);
  assert.equal(result.zone, "GRI (Duplicat confirmat)");
});

test("high semantic score with matching person and event terms still identifies a duplicate", () => {
  const result = evaluate3ZoneSimilarity(
    0.93,
    "Ilie Bolojan anunță reforma pensiilor din 2026",
    "",
    "Bolojan anunță reforma sistemului de pensii în 2026",
    "",
    0.8
  );

  assert.equal(result.isDuplicate, true);
  assert.equal(result.zone, "VERDE");
});

test("different newsroom wording still catches the same Moldova emergency story", () => {
  const result = evaluate3ZoneSimilarity(
    0.94,
    "Republica Moldova va institui stare de urgență energetică și hidrologică. România, parte din planul de criză",
    "Republica Moldova va institui stare de urgență în sectoarele energetic și hidrologic din cauza situației de pe Nistru. Președinta Maia Sandu a anunțat măsura după ședința CNS.",
    "Maia Sandu anunță stare de urgență în domeniul energetic și hidrologic. Nu o să vă spun că va fi ușor",
    "Consiliul Național de Securitate al Republicii Moldova a convenit asupra necesității declarării stării de urgență în domeniul energetic și hidrologic. Anunțul a fost făcut de președinta Maia Sandu după ședință.",
    0.80
  );

  assert.equal(result.isDuplicate, true);
  assert.equal(result.zone, "VERDE");
});

test("full-article evidence catches the same Moldova emergency despite rewritten headlines", () => {
  const result = evaluate3ZoneSimilarity(
    0.865976,
    "Republica Moldova instituie stare de urgență în sectoarele energetic și hidrologic pentru 60 de zile. Aproape 60% din energia electrică va fi importată",
    "Propunerea Guvernului care vizează o stare de urgență de 60 de zile urmează să fie înaintată Parlamentului Republicii Moldova pentru examinare și aprobare. Potrivit Guvernului, aproximativ 59% din necesarul de energie electrică al Republicii Moldova va trebui acoperit din import în această iarnă. În sectorul hidrologic, Guvernul invocă deficitul sever de apă de pe râurile Nistru și Prut, care poate afecta alimentarea populației cu apă potabilă.",
    "Video Maia Sandu anunță stare de urgență în domeniul energetic și hidrologic. Nu o să vă spun că va fi ușor",
    "Consiliul Național de Securitate al Republicii Moldova a convenit asupra necesității declarării stării de urgență în domeniul energetic și hidrologic în contextul creșterii prețurilor la energie și combustibili, dar și al situației critice de pe Nistru. Anunțul a fost făcut de președinta Maia Sandu după ședința Consiliului. Măsura este necesară pentru ca autoritățile să poată interveni rapid în cazul unor probleme de aprovizionare cu carburanți sau al agravării situației hidrologice.",
    0.80
  );

  assert.equal(result.isDuplicate, true);
  assert.equal(result.score, 0.865976);
});

test("Basescu's assessment and PSD's vote plan are distinct Muresan stories", () => {
  const result = evaluate3ZoneSimilarity(
    0.786743,
    "Băsescu nu îi dă mari șanse lui Siegfried Mureșan: Nu știu dacă va reuși să facă un alt fel de Guvern. Îi dau șanse puține",
    "Într-o intervenție la B1 TV, Traian Băsescu a vorbit despre șansele premierului Siegfried Mureșan de a alcătui viitorul Guvern. «Eu nu-i dau mari șanse lui Siegfried Mureșan», a transmis fostul președinte.",
    "Manda anunță cum va vota în ședința PSD în cazul lui Siegfried Mureșan: Avem de-a face doar cu un alt Bolojan",
    "Biroul Permanent Național al PSD se reunește pentru a stabili poziția partidului față de premierul desemnat Siegfried Mureșan. Manda a spus că nu se așteaptă ca PSD să își schimbe poziția potrivit căreia nu va susține un guvern din care nu face parte.",
    0.80
  );

  assert.equal(result.isDuplicate, false);
  assert.match(result.zone, /Permis/);
});

test("two separate events from the same New York visit are not duplicate news", () => {
  const result = evaluate3ZoneSimilarity(
    0.846,
    "Investitorii americani l-au întrebat pe Nicușor Dan când va avea România Guvern. Ce le-a răspuns președintele",
    "Nicușor Dan a participat la New York la o întâlnire organizată de JPMorgan cu reprezentanți ai unor companii, bănci și fonduri de investiții care investesc în obligațiuni românești. Investitorii au adresat întrebări despre situația politică și financiară a României.",
    "Planul prezentat de Nicușor Dan în SUA: infrastructura de care România are nevoie și atragerea capitalului american",
    "Șeful statului a prezentat la un eveniment organizat de Atlantic Council la New York prioritățile României în materie de infrastructură civilă și militară. Nicușor Dan a transmis că discuțiile au vizat infrastructura și modalitățile de finanțare.",
    0.80
  );

  assert.equal(result.isDuplicate, false);
  assert.match(result.zone, /Permis/);
});

test("a question about a proposed child social-media ban differs from an AI-safety event", () => {
  const result = evaluate3ZoneSimilarity(
    0.786,
    "Ce spune președintele Nicușor Dan, întrebat dacă este de acord cu interzicerea rețelelor sociale pentru copii",
    "Președintele Nicușor Dan a fost întrebat la New York cum comentează propunerea Comisiei Europene de a interzice accesul la social media pentru copiii sub 13 ani și dacă România ar putea susține proiectul. Declarațiile au fost făcute la o întâlnire cu reprezentanții comunității românești.",
    "Mirabela Grădinaru, la New York, într-o dezbatere despre noile tehnologii, AI și siguranța copiilor",
    "Mirabela Grădinaru, partenera președintelui Nicușor Dan, a participat la New York la o dezbatere despre noile tehnologii, AI și siguranța copiilor. Inteligența artificială face parte din viața copiilor și schimbă felul în care învață.",
    0.80
  );

  assert.equal(result.isDuplicate, false);
});

test("different people making statements about the same breaking event are distinct stories", () => {
  const result = evaluate3ZoneSimilarity(
    0.841,
    "Nicuşor Dan, mesaj de înţelegere, chiar de simpatie, pentru cei care consideră că fostul candidat Călin Georgescu e o victimă a sistemului: E atributul şi responsabilitatea DIICOT să lămurească faptele",
    "Preşedintele Nicuşor Dan a declarat, la New York, pe tema reţinerii lui Călin Georgescu, că este responsabilitatea DIICOT să lămurească faptele şi că respectă prezumţia de nevinovăţie.",
    "Traian Băsescu, despre reținerea lui Călin Georgescu: Este un spectacol care are la bază ceva. Parcă ar fi ordonat",
    "Fostul preşedinte Traian Băsescu a acuzat spectacolul oferit de Justiţie în cazul lui Călin Georgescu, ridicat luni şi reţinut de procurorii DIICOT. Băsescu a spus că este un spectacol pe care l-a respins şi în trecut.",
    0.80
  );

  assert.equal(result.isDuplicate, false);
});

test("cross-outlet headlines for the same quoted Grindeanu statement remain duplicates", () => {
  const result = evaluate3ZoneSimilarity(
    0.82,
    "În ce condiții este scos Călin Georgescu din politică, după Grindeanu",
    "Sorin Grindeanu a declarat că, dacă va fi găsit vinovat, Călin Georgescu va fi scos din politică. Liderul PSD a comentat și cazul fostului candidat pro-rus.",
    "Grindeanu: Dacă va fi găsit vinovat, Călin Georgescu va fi scos din politică",
    "Sorin Grindeanu a spus că, dacă va fi găsit vinovat, Călin Georgescu va fi scos din politică. El a făcut declarația despre fostul candidat pro-rus.",
    0.80
  );

  assert.equal(result.isDuplicate, true);
});

test("shared politician and broad topic do not merge distinct Maia Sandu developments", () => {
  const result = evaluate3ZoneSimilarity(
    0.94,
    "Maia Sandu a convocat Consiliul Național de Securitate. Temele de pe agenda ședinței",
    "Președinta Republicii Moldova, Maia Sandu, a convocat CNS privind impactul crizei energetice.",
    "Maia Sandu anunță stare de urgență în domeniul energetic și hidrologic. Nu o să vă spun că va fi ușor",
    "Consiliul Național de Securitate a decis declararea stării de urgență în contextul crizei energetice.",
    0.80
  );

  assert.equal(result.isDuplicate, false);
  assert.match(result.zone, /Permis/);
});

test("high semantic similarity cannot alone block unrelated titles", () => {
  const result = evaluate3ZoneSimilarity(
    0.9,
    "Cutremur puternic în Japonia",
    "",
    "Rezultatele alegerilor locale din România",
    "",
    0.8
  );

  assert.equal(result.isDuplicate, false);
});

test("a shared public figure without shared event terms is not enough", () => {
  const result = evaluate3ZoneSimilarity(
    0.91,
    "Bolojan anunță reforma pensiilor",
    "",
    "Bolojan vizitează fabrica din Iași după incendiu",
    "",
    0.8
  );

  assert.equal(result.isDuplicate, false);
});

test("two overlapping title words cannot validate a high semantic score on their own", () => {
  const result = evaluate3ZoneSimilarity(
    0.91,
    "Consultanții analizează impactul taxelor asupra exporturilor agricole din România",
    "",
    "Economiștii analizează efectele taxelor asupra investițiilor străine în România",
    "",
    0.8
  );

  assert.equal(result.isDuplicate, false);
});

test("names and a shared calendar year in the leads do not make unrelated headlines duplicates", () => {
  const result = evaluate3ZoneSimilarity(
    0.77,
    "Spital nou pentru orașul Iași",
    "În 2026, Ilie Bolojan și Cătălin Predoiu au discutat despre deschiderea spitalului.",
    "Reforma pensiilor și indexarea punctului",
    "În 2026, Ilie Bolojan și Cătălin Predoiu au discutat despre reforma pensiilor.",
    0.8
  );

  assert.equal(result.isDuplicate, false);
});

test("a shared politician name plus generic wording is not enough to mark unrelated news duplicate", () => {
  const result = evaluate3ZoneSimilarity(
    0.77,
    "Bolojan anunță noi reguli pentru pensii",
    "",
    "Bolojan anunță noi fonduri pentru spitale",
    "",
    0.8
  );

  assert.equal(result.isDuplicate, false);
});

test("a non-duplicate high score cannot hide a lower-scoring duplicate candidate", () => {
  const selected = selectSimilarityCandidate([
    { isDuplicate: false, score: 0.9, url: "https://example.com/unrelated" },
    { isDuplicate: true, score: 0.77, url: "https://example.com/same-event" },
  ]);

  assert.equal(selected.isDuplicate, true);
  assert.equal(selected.url, "https://example.com/same-event");
});
