// Regeneraza sesiunea Telegram (StringSession) pentru bot.
// Ruleaza:  npm run session
// Iti cere numarul de telefon si codul primit in Telegram, apoi:
//  1. scrie automat noul TG_SESSION in .env
//  2. afiseaza string-ul ca sa-l pui si in GitHub Secret "TG_SESSION"
import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import readline from "node:readline/promises";
import fs from "node:fs";

const API_ID = Number(process.env.TG_API_ID);
const API_HASH = process.env.TG_API_HASH;
if (!API_ID || !API_HASH) {
  console.error("Lipsesc TG_API_ID / TG_API_HASH din .env");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, {
  connectionRetries: 3,
});

await client.start({
  phoneNumber: async () => rl.question("Numarul de telefon (format +40xxxxxxxxx): "),
  password: async () => rl.question("Parola 2FA (daca ai; Enter daca nu ai): "),
  phoneCode: async () => rl.question("Codul primit in Telegram: "),
  onError: (err) => console.log("Eroare:", err.message),
});

const session = client.session.save();
console.log("\n=== SESIUNE NOA GENERATA CU SUCCES ===\n");

// Scriem direct in .env (inlocuim linia TG_EXISTENTA sau adaugam la final)
const envPath = new URL("../.env", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
const line = `TG_SESSION=${session}`;
if (/^TG_SESSION=/m.test(env)) {
  env = env.replace(/^TG_SESSION=.*$/m, line);
} else {
  env += (env.endsWith("\n") || env === "" ? "" : "\n") + line + "\n";
}
fs.writeFileSync(envPath, env);
console.log("OK: noul TG_SESSION a fost scris in .env\n");
console.log("PASUL 2 (manual): copiaza string-ul de mai jos in GitHub:");
console.log("  Settings -> Secrets and variables -> Actions -> TG_SESSION (Update)\n");
console.log(session);

await client.disconnect();
rl.close();
process.exit(0);
