import "dotenv/config";
import { arbitrateSimilarity } from "../src/similarity/ai-arbitrator.js";
import { fetchArticle } from "../src/scraper/article.js";

const models = (process.env.SIMILARITY_BENCHMARK_MODELS || process.env.SIMILARITY_BENCHMARK_MODEL || "gemini-3.5-flash-lite")
  .split(",").map((name) => name.trim()).filter(Boolean);
const selectedBatch = Number.parseInt(process.env.SIMILARITY_BENCHMARK_BATCH || "0", 10);
const fetchLiveArticles = process.env.SIMILARITY_BENCHMARK_FETCH_ARTICLES === "1";
const summaryOnly = process.env.SIMILARITY_BENCHMARK_SUMMARY === "1";

async function hydrateArticle(article) {
  if (!fetchLiveArticles || !article.fetchUrl) return article;
  try {
    const fetched = await fetchArticle(article.fetchUrl);
    if (!fetched.title || !fetched.content) throw new Error("empty article body");
    return { ...article, title: fetched.title, content: fetched.content };
  } catch (error) {
    const status = error?.response?.status;
    throw new Error(`article_fetch_failed${status ? `_${status}` : ""}`);
  }
}

const batches = [
  {
    name: "criza politică și nominalizarea premierului",
    incoming: {
      fetchUrl: "https://www.digi24.ro/stiri/actualitate/politica/nicusor-dan-anunta-ca-luni-va-nominaliza-un-nou-nume-de-prim-ministru-dupa-consultari-cu-partidele-3971729",
      title: "Nicușor Dan va consulta partidele luni și va nominaliza un premier",
      content: "Președintele Nicușor Dan a anunțat că va chema partidele la consultări luni dimineață. Luni după-amiază, șeful statului va face o nominalizare pentru funcția de prim-ministru.",
    },
    candidates: [
      {
        url: "https://fixture.invalid/duplicate-same-announcement",
        expected: "duplicate",
        title: "Președintele anunță consultări luni și desemnarea unui nou premier în aceeași zi",
        content: "Nicușor Dan a spus că luni dimineață va discuta cu partidele parlamentare. El a precizat că va nominaliza un candidat la funcția de premier luni după-amiază.",
      },
      {
        url: "https://www.g4media.ro/siegfried-muresan-asteptam-sa-vedem-din-partea-presedintelui-romaniei-care-sunt-urmatorii-pasi-radu-miruta-nu-vom-lasa-ca-psd-sa-se-urce-iarasi-cu-picioarele-pe-finantele-romaniei.html",
        fetchUrl: "https://www.g4media.ro/siegfried-muresan-asteptam-sa-vedem-din-partea-presedintelui-romaniei-care-sunt-urmatorii-pasi-radu-miruta-nu-vom-lasa-ca-psd-sa-se-urce-iarasi-cu-picioarele-pe-finantele-romaniei.html",
        expected: "distinct",
        title: "Siegfried Mureșan: Așteptăm să vedem care sunt pașii următori ai președintelui",
        content: "După votul din Parlament, Siegfried Mureșan a spus că PNL așteaptă să vadă ce va decide președintele. Declarația nu a anunțat o dată de consultări sau o nominalizare.",
      },
      {
        url: "https://fixture.invalid/false-positive-party-reaction",
        expected: "distinct",
        title: "Raluca Turcan spune ce ar trebui să facă PNL dacă Guvernul nu primește votul",
        content: "Raluca Turcan a declarat că partidul trebuie să analizeze opțiunile după votul de învestitură. Ea nu a relatat calendarul consultărilor prezidențiale și nici numele unui premier desemnat.",
      },
      {
        url: "https://fixture.invalid/false-positive-same-person-other-event",
        expected: "distinct",
        title: "Nicușor Dan a discutat cu președintele Cehiei despre securitatea regională",
        content: "În timpul vizitei oficiale la Praga, Nicușor Dan s-a întâlnit cu președintele ceh. Cei doi au discutat cooperarea economică și sprijinul pentru Ucraina.",
      },
    ],
  },
  {
    name: "măsuri fiscale și obiectul concret al măsurii",
    incoming: {
      title: "Guvernul anunță reducerea TVA la alimente",
      content: "Guvernul României a prezentat un proiect care reduce taxa pe valoarea adăugată pentru alimente. Măsura ar urma să intre în vigoare după adoptarea actului normativ.",
    },
    candidates: [
      {
        url: "https://fixture.invalid/duplicate-vat-food",
        expected: "duplicate",
        title: "Proiectul Guvernului prevede TVA mai mică pentru produsele alimentare",
        content: "Executivul a prezentat un proiect prin care taxa pe valoarea adăugată pentru produse alimentare va fi redusă. Aplicarea măsurii este prevăzută după adoptarea actului normativ.",
      },
      {
        url: "https://fixture.invalid/false-positive-vat-fuel",
        expected: "distinct",
        title: "Guvernul analizează reducerea TVA pentru combustibil",
        content: "Guvernul României analizează un proiect privind scăderea taxei pe valoarea adăugată pentru combustibil. Măsura ar urma să intre în vigoare după adoptarea actului normativ.",
      },
    ],
  },
  {
    name: "starea de urgență energetică și hidrologică din Republica Moldova",
    incoming: {
      title: "Maia Sandu anunță stare de urgență energetică și hidrologică în Republica Moldova",
      content: "Președinta Maia Sandu a spus că Guvernul va solicita Parlamentului instituirea stării de urgență în domeniul energetic și hidrologic. Măsura vine pe fondul riscurilor pentru aprovizionarea cu energie și al situației hidrologice.",
    },
    candidates: [
      {
        url: "https://fixture.invalid/duplicate-moldova-state-of-emergency",
        expected: "duplicate",
        title: "Republica Moldova va institui stare de urgență în domeniile energetic și hidrologic",
        content: "Maia Sandu a anunțat că Executivul va cere Parlamentului să declare stare de urgență energetică și hidrologică. Decizia este legată de riscurile de aprovizionare și de evoluția situației hidrologice.",
      },
      {
        url: "https://fixture.invalid/false-positive-romania-crisis-support",
        expected: "distinct",
        title: "România face parte din planul de criză pentru sprijinirea Republicii Moldova",
        content: "Autoritățile române au discutat măsuri de sprijin pentru Republica Moldova în cazul unor probleme de aprovizionare. Articolul descrie contribuția României, nu anunțul Maiei Sandu privind declararea stării de urgență.",
      },
      {
        url: "https://fixture.invalid/false-positive-later-parliamentary-vote",
        expected: "distinct",
        title: "Parlamentul Republicii Moldova votează instituirea stării de urgență energetică",
        content: "După solicitarea Guvernului, deputații au votat instituirea stării de urgență. Articolul relatează votul și durata măsurii, ca etapă ulterioară anunțului prezidențial.",
      },
    ],
  },
  {
    name: "declarațiile lui Siegfried Mureșan despre OUG 13 și criza guvernamentală",
    incoming: {
      title: "Siegfried Mureșan îi spune lui Grindeanu că nu a învățat nimic din OUG 13",
      content: "Siegfried Mureșan a afirmat că Sorin Grindeanu nu a învățat nimic din perioada OUG 13. El a avertizat că Grindeanu nu ar ezita să emită o nouă ordonanță pro-furt dacă PSD ar reveni la guvernare.",
    },
    candidates: [
      {
        url: "https://fixture.invalid/duplicate-muresan-oug13",
        expected: "duplicate",
        title: "Mureșan: Grindeanu nu regretă OUG 13 și ar putea repeta ordonanța pro-furt",
        content: "Liberalul Siegfried Mureșan a declarat că liderul PSD nu a învățat din episodul OUG 13 și că, dacă ar reveni la putere, ar putea adopta din nou o ordonanță pro-furt.",
      },
      {
        url: "https://fixture.invalid/false-positive-muresan-anticipates",
        expected: "distinct",
        title: "Dan Motreanu: alegerile anticipate pot schimba realitatea politică",
        content: "Secretarul general al PNL, Dan Motreanu, a declarat că anticipatele pot schimba realitatea politică. El a vorbit despre alegeri ca mecanism de selecție internă a liderilor.",
      },
      {
        url: "https://fixture.invalid/false-positive-muresan-votes",
        expected: "distinct",
        title: "Siegfried Mureșan spune că se bazează pe 200 de voturi pentru învestirea Guvernului",
        content: "Premierul desemnat a vorbit despre calculele parlamentare și despre numărul de voturi necesare pentru învestirea cabinetului. Articolul nu discută OUG 13 sau declarațiile lui Grindeanu despre proteste.",
      },
      {
        url: "https://fixture.invalid/false-positive-grindeanu-complaint",
        expected: "distinct",
        title: "Sorin Grindeanu anunță că va depune plângere penală împotriva lui Dominic Fritz",
        content: "Liderul PSD a anunțat că se va consulta cu avocații pentru o plângere penală împotriva liderului USR. Disputa privește acuzațiile despre întâlnirea cu ambasadoarea SUA, nu OUG 13.",
      },
    ],
  },
  {
    name: "votul Guvernului Mureșan versus articole despre aceeași criză",
    incoming: {
      fetchUrl: "https://www.mediafax.ro/politic/ce-scrie-presa-straina-dupa-ce-guvernul-muresan-a-picat-la-vot-in-parlament-ce-va-decide-nicusor-dan-si-cand-pot-avea-loc-alegeri-anticipate-23817106",
      title: "Guvernul Mureșan este respins de Parlament cu 182 de voturi",
      content: "Parlamentul a votat miercuri învestirea Guvernului propus de Siegfried Mureșan. Cabinetul a primit 182 de voturi, sub pragul de 233 necesar. Articolul urmărește rezultatul votului și reacțiile imediate ale presei internaționale despre criza politică.",
    },
    candidates: [
      {
        url: "https://www.digi24.ro/stiri/actualitate/politica/cum-titreaza-presa-internationala-respingerea-guvernului-muresan-criza-politica-se-adanceste-si-ameninta-ratingul-de-investitii-3971731",
        fetchUrl: "https://www.digi24.ro/stiri/actualitate/politica/cum-titreaza-presa-internationala-respingerea-guvernului-muresan-criza-politica-se-adanceste-si-ameninta-ratingul-de-investitii-3971731",
        expected: "duplicate",
        title: "Presa internațională despre respingerea Guvernului Mureșan și criza politică",
        content: "Articolul relatează că Guvernul Mureșan a fost respins în Parlament și că votul adâncește criza politică. Sunt prezentate reacții Reuters și Politico despre efectele economice și politice ale rezultatului.",
      },
      {
        url: "https://www.digi24.ro/stiri/actualitate/politica/parlamentul-da-astazi-votul-decisiv-pentru-guvernul-propus-de-siegfried-muresan-3969965",
        expected: "distinct",
        title: "Parlamentul urmează să voteze învestirea Guvernului Mureșan",
        content: "Articolul este publicat înaintea votului și prezintă programul zilei, lista miniștrilor și calculele partidelor privind susținerea Cabinetului. Nu relatează rezultatul votului, care urma să aibă loc la ora 13:00.",
      },
      {
        url: "https://www.mediafax.ro/politic/siegfried-muresan-inainte-de-votul-de-investitura-institutia-parlamentului-trebuie-respectata-23816432",
        expected: "distinct",
        title: "Siegfried Mureșan spune că instituția Parlamentului trebuie respectată",
        content: "Înaintea votului, premierul desemnat a făcut declarații despre respectarea instituției Parlamentului și despre procedura de învestire. Materialul este centrat pe mesajul său anterior rezultatului, nu pe numărătoarea voturilor ori reacțiile de după.",
      },
      {
        url: "https://www.g4media.ro/raluca-turcan-cele-182-de-voturi-din-465-obtinute-pentru-guvernul-siegfried-muesan-reflecta-aspiratiile-unei-majoritati-de-romani-care-vor-modernizarea-tarii-noastre.html",
        fetchUrl: "https://www.g4media.ro/raluca-turcan-cele-182-de-voturi-din-465-obtinute-pentru-guvernul-siegfried-muesan-reflecta-aspiratiile-unei-majoritati-de-romani-care-vor-modernizarea-tarii-noastre.html",
        expected: "distinct",
        title: "Raluca Turcan comentează cele 182 de voturi obținute de Guvernul Mureșan",
        content: "Deputata Raluca Turcan comentează rezultatul votului și susține că cele 182 de voturi pentru cabinet reflectă aspirațiile unei majorități de români. Relatarea este despre interpretarea și reacția ei politică la rezultat.",
      },
    ],
  },
  {
    name: "declarațiile lui Nicușor Dan după vot versus decizii ulterioare și vizita din Cehia",
    incoming: {
      fetchUrl: "https://www.g4media.ro/nicusor-dan-primele-declaratii-dupa-esecul-guvernului-siegfried-muresan.html",
      title: "Nicușor Dan face primele declarații după respingerea Guvernului Mureșan",
      content: "Președintele Nicușor Dan a făcut primele declarații după ce Guvernul Mureșan nu a obținut voturile necesare în Parlament. Șeful statului se afla într-o vizită oficială în Cehia. Relatarea este despre reacția sa imediată după vot.",
    },
    candidates: [
      {
        url: "https://www.mediafax.ro/politic/primul-anunt-al-presedintelui-romaniei-dupa-votul-din-parlament-ce-intentie-are-nicusor-dan-23817125",
        fetchUrl: "https://www.mediafax.ro/politic/primul-anunt-al-presedintelui-romaniei-dupa-votul-din-parlament-ce-intentie-are-nicusor-dan-23817125",
        expected: "duplicate",
        title: "Primul anunț al președintelui după votul din Parlament",
        content: "Materialul prezintă primele declarații ale lui Nicușor Dan după respingerea Guvernului Mureșan și reacția președintelui la votul de învestire. Este același moment de presă de după vot, relatat de o altă publicație.",
      },
      {
        url: "https://www.digi24.ro/stiri/actualitate/politica/nicusor-dan-anunta-ca-luni-va-nominaliza-un-nou-nume-de-prim-ministru-dupa-consultari-cu-partidele-3971729",
        expected: "duplicate",
        title: "Nicușor Dan va nominaliza luni un nou premier după consultări",
        content: "După votul eșuat, președintele a anunțat calendarul următoarei etape: consultări cu partidele luni și nominalizarea unui nou premier în aceeași zi. Articolul urmărește decizia ulterioară și pașii viitori, nu primele declarații făcute imediat după vot.",
      },
      {
        url: "https://www.g4media.ro/presedintele-nicusor-dan-pleaca-in-cehia-intalniri-cu-presedintele-petr-pavel-si-cu-prim-ministrul-andrej-babi.html",
        expected: "distinct",
        title: "Nicușor Dan pleacă în Cehia pentru întâlniri cu Petr Pavel și Andrej Babiš",
        content: "Articolul anunță agenda unei vizite oficiale în Cehia, cu întâlniri bilaterale și teme de cooperare. Vizita este context comun, însă materialul nu relatează reacția la votul de învestire.",
      },
      {
        url: "https://www.mediafax.ro/stirile-zilei/criza-politica-din-romania-subiect-de-discutie-intre-nicusor-dan-si-presedintele-cehiei-nu-s-a-ingrijorat-de-faptul-ca-romania-isi-va-pastra-directia-pro-occidentala-23816954",
        expected: "distinct",
        title: "Criza politică din România, discutată de Nicușor Dan și președintele Cehiei",
        content: "În timpul vizitei la Praga, Nicușor Dan a discutat cu Petr Pavel despre situația politică din România și direcția pro-occidentală a țării. Articolul este centrat pe întrevederea bilaterală și mesajul transmis omologului ceh.",
      },
      {
        url: "https://www.g4media.ro/nicusor-dan-declaratii-de-presa-in-plina-criza-politica.html",
        expected: "distinct",
        title: "Nicușor Dan susține declarații de presă în plină criză politică",
        content: "Președintele a vorbit despre șansele unui acord între partide și despre criza politică, într-o conferință de presă distinctă. Articolul nu este relatarea primelor declarații imediat după vot și nu are drept subiect numărarea voturilor.",
      },
    ],
  },
  {
    name: "Kelemen Hunor: aceeași intervenție versus declarații distincte despre guvern și AUR",
    incoming: {
      fetchUrl: "https://www.mediafax.ro/politic/fara-executiv-vom-fi-sanctionati-cu-totii-kelemen-hunor-spera-la-surprize-la-votul-pentru-guvernul-muresan-23816489",
      title: "Kelemen Hunor spune că Guvernul Mureșan nu are 233 de voturi",
      content: "Înaintea votului de învestire, liderul UDMR Kelemen Hunor a estimat că Guvernul Mureșan nu dispune de cele 233 de voturi necesare. El a spus că lipsa unui executiv cu puteri depline va avea consecințe și că se așteaptă la surprize la vot.",
    },
    candidates: [
      {
        url: "https://www.digi24.ro/amphtml/stiri/actualitate/politica/kelemen-hunor-astazi-facem-procedura-pana-la-capat-dar-nu-vad-acele-voturi-dincolo-de-170-171-3970589",
        fetchUrl: "https://www.digi24.ro/amphtml/stiri/actualitate/politica/kelemen-hunor-astazi-facem-procedura-pana-la-capat-dar-nu-vad-acele-voturi-dincolo-de-170-171-3970589",
        expected: "distinct",
        title: "Kelemen Hunor: Astăzi facem procedura până la capăt, dar nu văd acele voturi dincolo de 170, 171",
        content: "Într-un interviu la RFI, în dimineața votului, Kelemen Hunor a spus că nu vede 233 de voturi pentru Guvernul Mureșan și că procedura va fi dusă până la capăt. Declarația este diferită de estimarea făcută cu o zi înainte la Antena 3 CNN.",
      },
      {
        url: "https://www.g4media.ro/kelemen-hunor-nu-poti-sa-faci-un-guvern-daca-permanent-spui-despre-celalalt-ca-nu-vrea-binele-tarii-atunci-cum-dracu-vrei-dialog-liderul-udmr-nu-crede-in-anticipate.html",
        expected: "distinct",
        title: "Kelemen Hunor critică atacurile dintre partide și discută despre anticipate",
        content: "Liderul UDMR vorbește despre tonul dialogului politic, despre acuzațiile dintre partide și despre oportunitatea alegerilor anticipate. Materialul nu prezintă estimarea sa privind cele 233 de voturi sau surprizele la votul Guvernului Mureșan.",
      },
      {
        url: "https://www.mediafax.ro/politic/kelemen-hunor-despre-calin-georgescu-un-produs-al-fostei-securitati-23816835",
        fetchUrl: "https://www.mediafax.ro/politic/kelemen-hunor-despre-calin-georgescu-un-produs-al-fostei-securitati-23816835",
        expected: "distinct",
        title: "Kelemen Hunor îl descrie pe Călin Georgescu drept un produs al fostei Securități",
        content: "Într-un interviu la RFI, Kelemen Hunor a vorbit despre Călin Georgescu, arestarea preventivă și confruntarea dintre foști reprezentanți ai Securității și sistemul politic actual. Subiectul este Georgescu, nu calculele parlamentare ale votului de învestire.",
      },
      {
        url: "https://www.mediafax.ro/politic/kelemen-hunor-fara-echivoc-linia-rosie-e-aur-la-noi-asta-nu-se-va-schimba-23816813",
        fetchUrl: "https://www.mediafax.ro/politic/kelemen-hunor-fara-echivoc-linia-rosie-e-aur-la-noi-asta-nu-se-va-schimba-23816813",
        expected: "distinct",
        title: "Kelemen Hunor spune că AUR rămâne linia roșie pentru UDMR",
        content: "Liderul UDMR afirmă că partidul nu va guverna alături de AUR și explică poziția formațiunii față de o eventuală coaliție. Declarația privește liniile de colaborare politică, nu șansele cabinetului Mureșan înaintea votului.",
      },
    ],
  },
  {
    name: "aceeași declarație între surse versus declarații diferite în aceeași criză",
    incoming: {
      fetchUrl: "https://www.mediafax.ro/stirile-zilei/siegfried-muresan-ii-da-replica-lui-grindeanu-nu-a-invatat-nimic-nu-va-ezita-sa-dea-o-noua-ordonanta-pro-furt-23816088",
      title: "Siegfried Mureșan îl critică pe Grindeanu pentru OUG 13",
      content: "Siegfried Mureșan a afirmat că Sorin Grindeanu nu a învățat nimic din perioada OUG 13 și că nu ar ezita să dea o nouă ordonanță pro-furt dacă ar reveni la guvernare. Declarația a fost făcută ca reacție la comentariile lui Grindeanu despre protestele din 2017-2018.",
    },
    candidates: [
      {
        url: "https://www.g4media.ro/siegfried-muresan-grindeanu-nu-a-invatat-nimic-din-perioada-oug-13-daca-va-veni-la-guvernare-nu-va-ezita-sa-dea-o-noua-ordonanta-pro-furt-si-sa-guverneze-impotriva-oamenilor-daca-stie-ca-oamenii-n.html",
        fetchUrl: "https://www.g4media.ro/siegfried-muresan-grindeanu-nu-a-invatat-nimic-din-perioada-oug-13-daca-va-veni-la-guvernare-nu-va-ezita-sa-dea-o-noua-ordonanta-pro-furt-si-sa-guverneze-impotriva-oamenilor-daca-stie-ca-oamenii-n.html",
        expected: "duplicate",
        title: "Siegfried Mureșan: Grindeanu nu a învățat nimic din perioada OUG 13",
        content: "Mureșan îl acuză pe Grindeanu că nu regretă ordonanța OUG 13 și avertizează că ar putea adopta o nouă ordonanță pro-furt dacă revine la guvernare. Articolul relatează aceeași declarație despre protestele anticorupție.",
      },
      {
        url: "https://www.mediafax.ro/politic/primarul-lasului-mihai-chirica-pnl-critica-deciziile-guvernului-si-afirma-ca-votul-popular-nu-garanteaza-competenta.html",
        expected: "distinct",
        title: "Mihai Chirica critică politicile guvernamentale și votul popular",
        content: "Primarul Iașului, Mihai Chirica, a discutat despre politicile fiscale, mediul de afaceri și limitele votului popular în cadrul unui forum economic. Nu este vorba despre OUG 13, Grindeanu sau protestele anticorupție.",
      },
      {
        url: "https://www.g4media.ro/grindeanu-afirma-ca-ii-va-face-plangere-penala-lui-dominic-fritz-pentru-ca-l-a-acuzat-ca-ar-fi-luat-spaga-de-la-americani.html",
        expected: "distinct",
        title: "Grindeanu anunță plângere penală împotriva lui Dominic Fritz",
        content: "Sorin Grindeanu spune că se va consulta cu avocații pentru o plângere penală, după ce Dominic Fritz l-a acuzat că ar fi primit bani de la americani. Disputa privește o întâlnire diplomatică și acuzații de corupție, nu OUG 13.",
      },
      {
        url: "https://www.g4media.ro/primarul-iasiului-mihai-chirica-pnl-critica-deciziile-guvernului-si-afirma-ca-votul-popular-nu-garanteaza-competenta-nu-este-suficient-sa-te-aleaga-poporul-poporul-mai-greseste.html",
        expected: "distinct",
        title: "Mihai Chirica afirmă că votul popular nu garantează competența",
        content: "La un forum economic organizat la Iași, Mihai Chirica a criticat modul în care sunt stabilite politicile fiscale și a spus că alegerea de către popor nu garantează competența într-o funcție. Materialul nu relatează declarații despre Guvernul Mureșan sau OUG 13.",
      },
    ],
  },
  {
    name: "incendiile ilegale din Sintești: aceeași decizie versus reacții distincte",
    incoming: {
      fetchUrl: "https://www.g4media.ro/poluarea-din-sintesti-autoritatile-fac-controale-pe-traseele-de-deseuri-se-amana-starea-de-alerta-o-asemenea-masura-trebuie-fundamentata-pe-analiza-factorilor-de-risc.html",
      title: "Autoritățile din Ilfov intensifică verificările pe traseele deșeurilor din Sintești",
      content: "Comitetul Județean pentru Situații de Urgență Ilfov a dispus controale privind gestionarea și transportul deșeurilor în zona Sintești, comuna Vidra. Starea de alertă nu a fost instituită, prefectura spunând că măsura trebuie fundamentată pe analiza riscurilor.",
    },
    candidates: [
      {
        url: "https://www.digi24.ro/stiri/actualitate/ce-masuri-vor-fi-luate-in-cazul-arderilor-ilegale-de-deseuri-in-sintesti-nu-a-fost-instituita-starea-de-alerta-3968855",
        fetchUrl: "https://www.digi24.ro/stiri/actualitate/ce-masuri-vor-fi-luate-in-cazul-arderilor-ilegale-de-deseuri-in-sintesti-nu-a-fost-instituita-starea-de-alerta-3968855",
        expected: "duplicate",
        title: "Ce măsuri se iau după arderile ilegale din Sintești; nu a fost instituită starea de alertă",
        content: "Autoritățile din Ilfov au decis verificarea rutelor de deșeuri și monitorizarea zonelor cu arderi ilegale din Sintești. Starea de alertă nu a fost declarată, iar prefectura cere analiză de risc înaintea unei astfel de măsuri.",
      },
      {
        url: "fixture.invalid/diana-buzoianu-criticizes-ilfov-sintesti-response",
        expected: "distinct",
        title: "Diana Buzoianu critică reacția Prefecturii Ilfov privind arderile din Sintești",
        content: "Ministrul Mediului, Diana Buzoianu, a criticat prefectura pentru ritmul răspunsului la poluarea din Sintești și a cerut măsuri mai rapide. Relatarea este despre reacția și declarațiile ministrului, nu despre decizia Comitetului Județean privind controalele și amânarea stării de alertă.",
      },
      {
        url: "https://www.mediafax.ro/social/un-tata-roman-a-fost-reclamat-in-italia-pentru-ca-si-a-lasat-fetita-in-masina.html",
        expected: "distinct",
        title: "Un român a fost reclamat în Italia după ce și-a lăsat fiica în mașină",
        content: "Articolul relatează o sesizare făcută în Italia după ce un tată român și-a lăsat fiica într-o mașină. Nu are legătură cu poluarea, incendiile sau deciziile autorităților din Sintești.",
      },
      {
        url: "https://fixture.invalid/distinct-romgaz-us-lpg",
        expected: "distinct",
        title: "Ministerul Energiei trimite control la Romgaz după un contract de GPL din SUA",
        content: "Fostul ministru Bogdan Ivan a trimis Corpul de control la Romgaz după refuzul companiei de a semna un contract de achiziție a gazului petrolier lichefiat din SUA. Subiectul privește achiziția de combustibil și controlul companiei, nu deșeurile din Ilfov.",
      },
    ],
  },
  {
    name: "Kelemen Hunor despre Călin Georgescu: interviu sindicalizat versus alte teme",
    incoming: {
      fetchUrl: "https://www.mediafax.ro/politic/kelemen-hunor-despre-calin-georgescu-un-produs-al-fostei-securitati-23816835",
      title: "Kelemen Hunor: Călin Georgescu este un produs al fostei Securități",
      content: "Liderul UDMR Kelemen Hunor a spus într-un interviu la RFI că Călin Georgescu este un produs al fostei Securități. El a descris situația ca pe o confruntare între ce a mai rămas din fosta Securitate și sistemul politic actual.",
    },
    candidates: [
      {
        url: "https://www.g4media.ro/kelemen-hunor-despre-calin-georgescu-un-produs-al-fostei-securitati-e-o-lupta-intre-ce-a-mai-ramas-din-fosta-securitate-cu-sistemul-politic-actual.html",
        fetchUrl: "https://www.g4media.ro/kelemen-hunor-despre-calin-georgescu-un-produs-al-fostei-securitati-e-o-lupta-intre-ce-a-mai-ramas-din-fosta-securitate-cu-sistemul-politic-actual.html",
        expected: "duplicate",
        title: "Kelemen Hunor: Georgescu este un produs al fostei Securități",
        content: "În interviul de la RFI, Kelemen Hunor a spus că Georgescu provine din zona fostei Securități și că politica actuală este o luptă cu ceea ce a rămas din acel sistem. Este aceeași intervenție și aceeași declarație citată de o altă publicație.",
      },
      {
        url: "fixture.invalid/digi24-kelemen-georgescu-former-security-service",
        expected: "duplicate",
        title: "Kelemen Hunor spune că Georgescu este produs al fostei Securități",
        content: "Digi24 relatează declarația lui Kelemen Hunor de la RFI potrivit căreia Călin Georgescu este un produs al fostei Securități și descrie conflictul acesteia cu sistemul politic actual. Tema și intervenția sunt aceleași ca în relatarea G4Media.",
      },
      {
        url: "https://www.mediafax.ro/politic/kelemen-hunor-fara-echivoc-linia-rosie-e-aur-la-noi-asta-nu-se-va-schimba-23816813",
        expected: "distinct",
        title: "Kelemen Hunor spune că AUR este linia roșie pentru UDMR",
        content: "Înaintea votului pentru Guvernul Mureșan, Kelemen Hunor a vorbit despre refuzul UDMR de a guverna împreună cu AUR. Declarația privește negocierile de coaliție, nu afirmațiile sale despre Călin Georgescu și fosta Securitate.",
      },
      {
        url: "https://www.g4media.ro/kelemen-hunor-nu-poti-sa-faci-un-guvern-daca-permanent-spui-despre-celalalt-ca-nu-vrea-binele-tarii-atunci-cum-dracu-vrei-dialog-liderul-udmr-nu-crede-in-anticipate.html",
        fetchUrl: "https://www.g4media.ro/kelemen-hunor-nu-poti-sa-faci-un-guvern-daca-permanent-spui-despre-celalalt-ca-nu-vrea-binele-tarii-atunci-cum-dracu-vrei-dialog-liderul-udmr-nu-crede-in-anticipate.html",
        expected: "distinct",
        title: "Kelemen Hunor critică atacurile politice și nu crede în alegeri anticipate",
        content: "Liderul UDMR vorbește despre dialogul dintre partide și posibilitatea alegerilor anticipate în timpul crizei guvernamentale. Nu este interviul despre Călin Georgescu, fosta Securitate sau sistemul politic actual.",
      },
      {
        url: "fixture.invalid/distinct-kelemen-no-patience-parliament",
        expected: "distinct",
        title: "Kelemen Hunor spune în Parlament că societatea nu mai are răbdare cu politicienii",
        content: "În discursul din Parlament, Kelemen Hunor a avertizat că oamenii și-au pierdut răbdarea cu clasa politică și că reacția va fi pe măsură. Materialul este despre criza guvernamentală și răbdarea publicului, nu despre Georgescu.",
      },
    ],
  },
  {
    name: "Grindeanu și Fritz: aceeași acuzație versus replica ulterioară",
    incoming: {
      fetchUrl: "https://hotnews.ro/grindeanu-anunta-o-plangere-penala-impotriva-lui-fritz-se-depaseste-o-limita-care-pune-in-pericol-parteneriatul-strategic-cu-sua-2360790",
      title: "Grindeanu anunță o plângere penală împotriva lui Dominic Fritz",
      content: "Sorin Grindeanu a spus că se va consulta cu avocații pentru a depune o plângere împotriva lui Dominic Fritz. Liderul PSD a respins acuzația că ar fi primit bani de la americani și a spus că declarațiile pun în pericol parteneriatul strategic cu SUA.",
    },
    candidates: [
      {
        url: "https://www.g4media.ro/grindeanu-afirma-ca-ii-va-face-plangere-penala-lui-dominic-fritz-pentru-ca-l-a-acuzat-ca-ar-fi-luat-spaga-de-la-americani.html",
        fetchUrl: "https://www.g4media.ro/grindeanu-afirma-ca-ii-va-face-plangere-penala-lui-dominic-fritz-pentru-ca-l-a-acuzat-ca-ar-fi-luat-spaga-de-la-americani.html",
        expected: "duplicate",
        title: "Grindeanu spune că îi va face plângere penală lui Fritz pentru acuzațiile despre americani",
        content: "Liderul PSD a anunțat că va discuta cu avocații pentru o plângere penală împotriva lui Dominic Fritz după acuzația că ar fi luat bani de la americani. Grindeanu a susținut că este pus în pericol parteneriatul strategic.",
      },
      {
        url: "https://hotnews.ro/fritz-dupa-ce-a-fost-amenintat-de-grindeanu-cu-o-plangere-penala-parteneriatul-strategic-nu-e-fusta-dupa-care-va-puteti-ascunde-2361896",
        fetchUrl: "https://hotnews.ro/fritz-dupa-ce-a-fost-amenintat-de-grindeanu-cu-o-plangere-penala-parteneriatul-strategic-nu-e-fusta-dupa-care-va-puteti-ascunde-2361896",
        expected: "distinct",
        title: "Fritz îi transmite lui Grindeanu că parteneriatul strategic nu este un paravan",
        content: "După amenințarea cu plângerea penală, Dominic Fritz a răspuns că parteneriatul strategic cu SUA nu poate fi folosit ca paravan. Materialul este despre replica liderului USR la amenințare, nu despre anunțul lui Grindeanu că va depune plângere.",
      },
      {
        url: "fixture.invalid/distinct-grindeanu-russia-america-politics",
        expected: "distinct",
        title: "Grindeanu îl acuză pe Bolojan că a condus un guvern antiamerican",
        content: "Sorin Grindeanu a criticat politica externă a Guvernului Bolojan și a discutat relația cu Statele Unite. Articolul nu privește acuzația lui Fritz, întâlnirea cu ambasadoarea sau plângerea penală.",
      },
    ],
  },
  {
    name: "alerte istorice: votul final versus audieri și reacții economice",
    incoming: {
      fetchUrl: "https://www.digi24.ro/stiri/actualitate/politica/parlamentul-da-astazi-votul-decisiv-pentru-guvernul-propus-de-siegfried-muresan-3969965",
      title: "Parlamentul votează Guvernul propus de Siegfried Mureșan",
      content: "Votul de învestitură asupra Cabinetului Mureșan din plenul Parlamentului.",
    },
    candidates: [
      {
        url: "https://www.mediafax.ro/politic/guvernul-muresan-la-vot-in-parlament-premierul-desemnat-are-nevoie-de-233-de-voturi-pentru-investire-23816690",
        fetchUrl: "https://www.mediafax.ro/politic/guvernul-muresan-la-vot-in-parlament-premierul-desemnat-are-nevoie-de-233-de-voturi-pentru-investire-23816690",
        expected: "duplicate",
        title: "Guvernul Mureșan la vot în Parlament: sunt necesare 233 de voturi",
        content: "Articol despre același vot de învestitură al Cabinetului Mureșan.",
      },
      {
        url: "https://www.digi24.ro/stiri/actualitate/politica/audierile-ministrilor-lui-siegfried-muresan-continua-dupa-o-zi-cu-avize-negative-pe-banda-rulanta-programul-zilei-3968195",
        fetchUrl: "https://www.digi24.ro/stiri/actualitate/politica/audierile-ministrilor-lui-siegfried-muresan-continua-dupa-o-zi-cu-avize-negative-pe-banda-rulanta-programul-zilei-3968195",
        expected: "distinct",
        title: "Audierile miniștrilor continuă înaintea votului",
        content: "Etapă anterioară votului: audieri în comisii și avize consultative.",
      },
      {
        url: "https://www.g4media.ro/harta-de-impact-live-de-la-ora-13-00-votul-din-parlament-pentru-guvernul-muresan-si-consecintele-economice-ale-prelungirii-crizei-politice.html",
        fetchUrl: "https://www.g4media.ro/harta-de-impact-live-de-la-ora-13-00-votul-din-parlament-pentru-guvernul-muresan-si-consecintele-economice-ale-prelungirii-crizei-politice.html",
        expected: "distinct",
        title: "Analiză live a consecințelor economice ale crizei politice",
        content: "Analiză economică despre efectele crizei, nu relatarea propriu-zisă a votului de învestitură.",
      },
    ],
  },
  {
    name: "alerte istorice: dosarul Romgaz și relatările despre gazele americane",
    incoming: {
      fetchUrl: "https://www.g4media.ro/fostul-ministru-bogdan-ivan-a-trimis-corpul-de-control-al-ministerului-energiei-la-romgaz-dupa-ce-compania-de-stat-a-refuzat-sa-semneze-un-contract-pentru-achizitia-de-gpl-din-sua-din-cauza-pretului-c.html",
      title: "Bogdan Ivan trimite Corpul de control la Romgaz după refuzul unui contract de GPL",
      content: "Control ministerial declanșat după ce Romgaz a refuzat contractul din cauza prețului.",
    },
    candidates: [
      {
        url: "https://hotnews.ro/cu-o-luna-inainte-de-iesirea-ambasadoarei-sua-din-atena-la-bucuresti-un-cunoscut-politician-incerca-sa-convinga-romgaz-sa-cumpere-gaze-americane-cum-a-fost-refuzat-2361214",
        fetchUrl: "https://hotnews.ro/cu-o-luna-inainte-de-iesirea-ambasadoarei-sua-din-atena-la-bucuresti-un-cunoscut-politician-incerca-sa-convinga-romgaz-sa-cumpere-gaze-americane-cum-a-fost-refuzat-2361214",
        expected: "distinct",
        title: "Un politician încerca să convingă Romgaz să cumpere gaze americane; compania a refuzat",
        content: "Investigația despre lobby și refuzul inițial al companiei, nu măsura ulterioară de control ministerial.",
      },
      {
        url: "https://www.g4media.ro/grindeanu-reactie-in-scandalul-ambasadoarei-sua-din-grecia-care-s-a-laudat-ca-a-daramat-guvernul-bolojan-am-discutat-cu-ambasadoarea-despre-coridorul-vertical-de-gaze-restul-aspectelor-semnalate-su.html",
        fetchUrl: "https://www.g4media.ro/grindeanu-reactie-in-scandalul-ambasadoarei-sua-din-grecia-care-s-a-laudat-ca-a-daramat-guvernul-bolojan-am-discutat-cu-ambasadoarea-despre-coridorul-vertical-de-gaze-restul-aspectelor-semnalate-su.html",
        expected: "distinct",
        title: "Grindeanu reacționează în scandalul ambasadoarei SUA și vorbește despre Coridorul Vertical de Gaze",
        content: "Declarație separată despre relațiile diplomatice și Coridorul Vertical de Gaze.",
      },
    ],
  },
  {
    name: "alerte istorice: Andrea Chiș și etape diferite ale audierii",
    incoming: {
      fetchUrl: "https://www.digi24.ro/stiri/actualitate/politica/andrea-chis-ar-face-schimbari-majore-in-justitie-vrea-sa-limiteze-puterea-csm-asupra-carierei-judecatorilor-3970081",
      title: "Andrea Chiș ar vrea să limiteze puterea CSM asupra carierei judecătorilor",
      content: "Pozițiile sale despre schimbări în justiție și puterile CSM.",
    },
    candidates: [
      {
        url: "https://hotnews.ro/andrea-chis-am-acceptat-aceasta-functie-pentru-ca-nu-a-fost-politizata-propunerea-asta-nu-inseamna-ca-guvernul-nu-e-politic-2361506",
        fetchUrl: "https://hotnews.ro/andrea-chis-am-acceptat-aceasta-functie-pentru-ca-nu-a-fost-politizata-propunerea-asta-nu-inseamna-ca-guvernul-nu-e-politic-2361506",
        expected: "distinct",
        title: "Andrea Chiș explică de ce a acceptat funcția de ministru al Justiției",
        content: "Declarație despre acceptarea nominalizării și caracterul politic al guvernului, nu despre reforma CSM.",
      },
      {
        url: "https://www.mediafax.ro/politic/ce-pensie-de-serviciu-are-fosta-judecatoare-audiata-pentru-ministerul-justitiei-andrea-chis-nu-banii-m-au-facut-sa-ies-la-pensie-23816409",
        fetchUrl: "https://www.mediafax.ro/politic/ce-pensie-de-serviciu-are-fosta-judecatoare-audiata-pentru-ministerul-justitiei-andrea-chis-nu-banii-m-au-facut-sa-ies-la-pensie-23816409",
        expected: "distinct",
        title: "Andrea Chiș vorbește despre pensia de serviciu",
        content: "Relatare despre pensia fostei judecătoare, nu despre propunerea privind CSM.",
      },
    ],
  },
  {
    name: "alerte istorice: vizita în Cehia, planificare versus întâlniri desfășurate",
    incoming: {
      fetchUrl: "https://www.g4media.ro/presedintele-nicusor-dan-pleaca-in-cehia-intalniri-cu-presedintele-petr-pavel-si-cu-prim-ministrul-andrej-babi.html",
      title: "Nicușor Dan pleacă în Cehia pentru întâlniri cu Petr Pavel și Andrej Babiš",
      content: "Anunțul programului vizitei oficiale și al întâlnirilor planificate.",
    },
    candidates: [
      {
        url: "https://www.digi24.ro/stiri/actualitate/nicusor-dan-a-fost-primit-la-praga-de-presedintele-cehiei-petr-pavel-3970895",
        fetchUrl: "https://www.digi24.ro/stiri/actualitate/nicusor-dan-a-fost-primit-la-praga-de-presedintele-cehiei-petr-pavel-3970895",
        expected: "distinct",
        title: "Nicușor Dan a fost primit la Praga de președintele Cehiei",
        content: "Relatare ulterioară despre desfășurarea întâlnirii, un pas nou față de anunțul programului.",
      },
      {
        url: "https://www.mediafax.ro/stirile-zilei/criza-politica-din-romania-subiect-de-discutie-intre-nicusor-dan-si-presedintele-cehiei-nu-s-a-ingrijorat-de-faptul-ca-romania-isi-va-pastra-directia-pro-occidentala-23816954",
        fetchUrl: "https://www.mediafax.ro/stirile-zilei/criza-politica-din-romania-subiect-de-discutie-intre-nicusor-dan-si-presedintele-cehiei-nu-s-a-ingrijorat-de-faptul-ca-romania-isi-va-pastra-directia-pro-occidentala-23816954",
        expected: "distinct",
        title: "Discuția dintre Nicușor Dan și Petr Pavel despre criza politică din România",
        content: "Conținutul concret al discuției bilaterale, raportat după întâlnire, nu agenda anunțată înaintea vizitei.",
      },
      {
        url: "https://hotnews.ro/nicusor-dan-mesaj-de-la-praga-in-timp-ce-guvernul-siegfried-muresan-cere-votul-parlamentului-2362516",
        fetchUrl: "https://hotnews.ro/nicusor-dan-mesaj-de-la-praga-in-timp-ce-guvernul-siegfried-muresan-cere-votul-parlamentului-2362516",
        expected: "distinct",
        title: "Nicușor Dan transmite un mesaj de la Praga în ziua votului din Parlament",
        content: "Declarațiile din timpul vizitei despre criza politică, distincte de anunțul inițial al itinerarului.",
      },
    ],
  },
  {
    name: "alerte istorice: declarații înaintea votului versus poziții pe alte teme",
    incoming: {
      fetchUrl: "https://www.digi24.ro/stiri/actualitate/politica/siegfried-muresan-mesaj-catre-romani-inaintea-votului-de-miercuri-pentru-investirea-guvernului-vom-vedea-daca-reusim-sa-depasim-criza-3970225",
      title: "Mesajul lui Siegfried Mureșan înaintea votului de învestitură",
      content: "Mesaj transmis înainte de vot despre depășirea crizei politice.",
    },
    candidates: [
      {
        url: "https://www.mediafax.ro/politic/siegfried-muresan-ultimul-mesaj-inainte-de-votul-decisiv-din-parlament-maine-vom-vedea-daca-reusim-sa-depasim-criza-politica-si-daca-ne-apucam-de-treaba-23816603",
        fetchUrl: "https://www.mediafax.ro/politic/siegfried-muresan-ultimul-mesaj-inainte-de-votul-decisiv-din-parlament-maine-vom-vedea-daca-reusim-sa-depasim-criza-politica-si-daca-ne-apucam-de-treaba-23816603",
        expected: "duplicate",
        title: "Ultimul mesaj al lui Mureșan înaintea votului decisiv",
        content: "Același mesaj video transmis înaintea aceluiași vot.",
      },
      {
        url: "https://www.g4media.ro/siegfried-muresan-ultimul-mesaj-inainte-de-votul-decisiv-din-parlament-maine-vom-vedea-daca-reusim-sa-depasim-criza-politica-si-daca-ne-apucam-de-treaba.html",
        fetchUrl: "https://www.g4media.ro/siegfried-muresan-ultimul-mesaj-inainte-de-votul-decisiv-din-parlament-maine-vom-vedea-daca-reusim-sa-depasim-criza-politica-si-daca-ne-apucam-de-treaba.html",
        expected: "duplicate",
        title: "Mureșan: vom vedea dacă depășim criza politică",
        content: "Sindicarea între surse a aceluiași mesaj înaintea votului.",
      },
      {
        url: "https://www.mediafax.ro/politic/siegfried-muresan-romanii-din-diaspora-se-vor-intoarce-cand-vor-gasi-in-tara-locuri-de-munca-bune-23816915",
        fetchUrl: "https://www.mediafax.ro/politic/siegfried-muresan-romanii-din-diaspora-se-vor-intoarce-cand-vor-gasi-in-tara-locuri-de-munca-bune-23816915",
        expected: "distinct",
        title: "Mureșan vorbește despre revenirea românilor din diaspora",
        content: "Declarație despre locurile de muncă și diaspora, nu mesajul video anterior votului.",
      },
    ],
  },
  {
    name: "alerte istorice: aceeași declarație Simion între surse și alte apariții",
    incoming: {
      fetchUrl: "https://www.g4media.ro/george-simion-nu-vom-vota-nici-un-guvern-pana-nu-il-eliberati-si-nu-ii-faceti-dreptate-lui-calin-georgescu.html",
      title: "George Simion spune că AUR nu votează niciun guvern până la eliberarea lui Călin Georgescu",
      content: "Poziția AUR privind condiționarea votului pentru guvern de situația lui Călin Georgescu.",
    },
    candidates: [
      {
        url: "https://www.digi24.ro/stiri/actualitate/politica/george-simion-aur-nu-va-vota-nicio-alta-varianta-de-guvern-pana-cand-nu-l-eliberati-pe-calin-georgescu-3971091",
      fetchUrl: "https://www.digi24.ro/stiri/actualitate/politica/george-simion-aur-nu-va-vota-nicio-alta-varianta-de-guvern-pana-cand-nu-l-eliberati-pe-calin-georgescu-3971091",
        expected: "duplicate",
        title: "Simion: AUR nu va vota niciun guvern până la eliberarea lui Georgescu",
        content: "Aceeași declarație și condiție politică relatate de altă publicație.",
      },
      {
        url: "https://www.mediafax.ro/politic/simion-nu-votam-nicio-alta-varianta-de-guvern-pana-nu-il-eliberati-pe-calin-georgescu-aur-acuza-un-guvern-marioneta-23816939",
        fetchUrl: "https://www.mediafax.ro/politic/simion-nu-votam-nicio-alta-varianta-de-guvern-pana-nu-il-eliberati-pe-calin-georgescu-aur-acuza-un-guvern-marioneta-23816939",
        expected: "duplicate",
        title: "Simion refuză orice variantă de guvern până la eliberarea lui Georgescu",
        content: "Relatare cross-source a aceleiași poziții și a aceluiași anunț.",
      },
      {
        url: "https://hotnews.ro/george-simion-in-parlament-de-ziua-mea-l-ati-arestat-pe-calin-georgescu-liderul-aur-a-recitat-dintr-o-poezie-de-cosbuc-2362541",
        fetchUrl: "https://hotnews.ro/george-simion-in-parlament-de-ziua-mea-l-ati-arestat-pe-calin-georgescu-liderul-aur-a-recitat-dintr-o-poezie-de-cosbuc-2362541",
        expected: "distinct",
        title: "Simion face o declarație în Parlament de ziua sa despre arestarea lui Georgescu",
        content: "Altă intervenție, într-un moment și cadru ulterior; subiectul comun este Georgescu.",
      },
    ],
  },
  {
    name: "alerte istorice: scandalul din Parlament și același discurs Kelemen",
    incoming: {
      fetchUrl: "https://www.mediafax.ro/politic/nu-e-nu-ati-ales-sa-va-tineti-de-scaune-grindeanu-in-plen-la-votul-cabinetului-muresan-23816923",
      title: "Grindeanu îl atacă pe Mureșan în plen la votul Cabinetului",
      content: "Intervenția lui Sorin Grindeanu în timpul votului de învestitură.",
    },
    candidates: [
      {
        url: "https://www.mediafax.ro/politic/scandal-pe-holurile-parlamentului-sosoaca-a-urlat-la-muresan-inainte-de-vot-23816893",
        fetchUrl: "https://www.mediafax.ro/politic/scandal-pe-holurile-parlamentului-sosoaca-a-urlat-la-muresan-inainte-de-vot-23816893",
        expected: "distinct",
        title: "Șoșoacă provoacă un scandal pe holurile Parlamentului înainte de vot",
        content: "Alt protagonist și alt incident, în afara plenului, înaintea votului.",
      },
      {
        url: "https://www.mediafax.ro/politic/nu-din-cauza-extraterestrilor-ci-din-cauza-noastra-kelemen-hunor-lectie-dura-in-parlament-23816953",
        fetchUrl: "https://www.mediafax.ro/politic/nu-din-cauza-extraterestrilor-ci-din-cauza-noastra-kelemen-hunor-lectie-dura-in-parlament-23816953",
        expected: "distinct",
        title: "Kelemen Hunor ține un discurs despre responsabilitatea politicienilor",
        content: "Discurs separat al liderului UDMR în același plen, nu atacul lui Grindeanu.",
      },
      {
        url: "https://www.digi24.ro/stiri/actualitate/politica/kelemen-hunor-in-discursul-din-parlament-societatea-nu-mai-are-rabdare-cu-noi-reactia-va-fi-pe-masura-3971175",
        fetchUrl: "https://www.digi24.ro/stiri/actualitate/politica/kelemen-hunor-in-discursul-din-parlament-societatea-nu-mai-are-rabdare-cu-noi-reactia-va-fi-pe-masura-3971175",
        expected: "distinct",
        title: "Kelemen Hunor: societatea nu mai are răbdare cu noi",
        content: "Alt vorbitor și altă declarație din aceeași ședință parlamentară.",
      },
    ],
  },
  {
    name: "alertă manual acceptată: Băsescu versus Claudiu Manda despre Mureșan",
    incoming: {
      fetchUrl: "https://www.mediafax.ro/politic/basescu-nu-ii-da-mari-sanse-lui-siegfried-muresan-nu-stiu-daca-va-reusi-sa-faca-un-alt-fel-de-guvern-ii-dau-sanse-putine-23811412",
      title: "Băsescu nu îi dă mari șanse lui Siegfried Mureșan să formeze Guvernul",
      content: "Traian Băsescu evaluează șansele premierului desemnat de a atrage voturi și de a forma un guvern.",
    },
    candidates: [
      {
        url: "https://www.mediafax.ro/politic/manda-anunta-cum-va-vota-in-sedinta-psd-in-cazul-lui-siegfried-muresan-avem-de-a-face-doar-cu-un-alt-bolojan-23810520",
        fetchUrl: "https://www.mediafax.ro/politic/manda-anunta-cum-va-vota-in-sedinta-psd-in-cazul-lui-siegfried-muresan-avem-de-a-face-doar-cu-un-alt-bolojan-23810520",
        expected: "distinct",
        title: "Claudiu Manda spune cum va vota PSD privind susținerea lui Mureșan",
        content: "Claudiu Manda își anunță votul din conducerea PSD și îl compară pe Mureșan cu Bolojan. Este o declarație separată, nu evaluarea lui Băsescu despre șansele de formare a guvernului.",
      },
      {
        url: "https://www.aktual24.ro/traian-basescu-da-sanse-putine-unui-guvern-condus-de-siegfried-muresan-dar-sustine-ca-presedintele-are-in-continuare-biciul-anticipatelor-si-va-putea-sa-l-foloseasca/",
        fetchUrl: "https://www.aktual24.ro/traian-basescu-da-sanse-putine-unui-guvern-condus-de-siegfried-muresan-dar-sustine-ca-presedintele-are-in-continuare-biciul-anticipatelor-si-va-putea-sa-l-foloseasca/",
        expected: "duplicate",
        title: "Băsescu dă șanse puține Guvernului Mureșan și vorbește despre anticipate",
        content: "Relatare din altă publicație despre aceleași declarații ale lui Traian Băsescu privind șansele Guvernului Mureșan și rolul anticipatelor.",
      },
    ],
  },
];

function safeResult(result) {
  return {
    verdict: result?.verdict || "no_result",
    reason: result?.reason || "",
  };
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY lipsește din mediul local/.env; nu s-a trimis nicio cerere.");
    process.exitCode = 2;
    return;
  }

  if (!models.length || models.some((name) => !name.startsWith("gemini-"))) {
    console.error("Benchmark-ul acceptă numai modele Gemini; niciun model non-Gemini nu va fi apelat.");
    process.exitCode = 2;
    return;
  }
  if (!Number.isInteger(selectedBatch) || selectedBatch < 0 || selectedBatch > batches.length) {
    console.error(`SIMILARITY_BENCHMARK_BATCH trebuie să fie între 1 și ${batches.length}, sau 0 pentru toate loturile.`);
    process.exitCode = 2;
    return;
  }

  const batchesToRun = selectedBatch ? [batches[selectedBatch - 1]] : batches;
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let manual = 0;
  let manualExpectedDuplicate = 0;
  let manualExpectedDistinct = 0;
  let failed = 0;
  const rows = [];

  for (const batch of batchesToRun) {
    let incoming;
    let candidates;
    let results = null;
    try {
      incoming = await hydrateArticle(batch.incoming);
      candidates = await Promise.all(batch.candidates.map(hydrateArticle));
      const review = await arbitrateSimilarity(incoming, candidates, {
        models,
        modelFilter: async (requested) => requested,
      });
      results = review?.results || null;
      if (review?.model) batch.usedModel = review.model;
    } catch (error) {
      rows.push({ batch: batch.name, error: fetchLiveArticles ? "article_fetch_failed" : String(error?.message || error) });
    }

    const batchCandidates = candidates || batch.candidates;
    if (!results || results.length !== batchCandidates.length) {
      failed += batchCandidates.length;
      rows.push(...batchCandidates.map((candidate) => ({
        batch: batch.name,
        candidate: candidate.url,
        expected: candidate.expected,
        actual: "request_failed",
        modelsTried: models,
      })));
      continue;
    }

    results.forEach((result, index) => {
      const candidate = candidates[index];
      const actual = safeResult(result);
      const isPositive = actual.verdict === "duplicate";
      if (actual.verdict === "uncertain") {
        manual++;
        if (candidate.expected === "duplicate") manualExpectedDuplicate++;
        else manualExpectedDistinct++;
      }
      else if (candidate.expected === "duplicate" && isPositive) truePositive++;
      else if (candidate.expected === "duplicate") falseNegative++;
      else if (isPositive) falsePositive++;
      rows.push({
        batch: batch.name,
        model: batch.usedModel || null,
        candidate: candidate.url,
        expected: candidate.expected,
        actual: actual.verdict,
        reason: actual.reason,
      });
    });
  }

  const report = { models, selectedBatch: selectedBatch || "all", tested: rows.filter((row) => row.actual && row.actual !== "request_failed").length, rows, metrics: { truePositive, falsePositive, falseNegative, manual, manualExpectedDuplicate, manualExpectedDistinct, failed } };
  if (summaryOnly) {
    report.rows = rows.filter((row) => row.actual === "uncertain" || row.actual === "request_failed" ||
      (row.expected === "duplicate" && !["duplicate", "uncertain", "request_failed"].includes(row.actual)) ||
      (row.expected !== "duplicate" && row.actual === "duplicate"));
  }
  console.log(JSON.stringify(report, null, 2));
  if (falsePositive || falseNegative || failed) process.exitCode = 1;
}

await main();
