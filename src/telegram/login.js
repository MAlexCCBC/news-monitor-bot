// Ruleaza O SINGURA DATA local: npm run login
// Iti va cere codul SMS primit pe Telegram. Genereaza un TG_SESSION
// pe care il copiezi in .env / in variabilele de mediu de pe Railway.
// Dupa asta NU mai trebuie sa rulezi asta niciodata (sesiunea tine minte).

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import dotenv from "dotenv";
dotenv.config();

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

if (!apiId || !apiHash) {
  console.error("Lipsesc TG_API_ID / TG_API_HASH din .env");
  console.error("Ia-le de pe https://my.telegram.org -> API Development Tools");
  process.exit(1);
}

const stringSession = new StringSession("");

(async () => {
  console.log("Pornesc login Telegram (MTProto)...");
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("Numarul tau de telefon (+40...): "),
    password: async () => await input.text("Parola 2FA (daca ai, altfel Enter): "),
    phoneCode: async () => await input.text("Codul primit pe Telegram: "),
    onError: (err) => console.error(err),
  });

  console.log("\n✅ Logat cu succes!\n");
  console.log("Copiaza linia de mai jos in fisierul .env (sau in variabilele de mediu Railway):\n");
  console.log(`TG_SESSION=${client.session.save()}\n`);

  await client.disconnect();
  process.exit(0);
})();
