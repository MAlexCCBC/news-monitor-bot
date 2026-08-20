import { execFile } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { checkpointDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "../..");
const DB_REL = "data.sqlite";

// Salveaza periodic data.sqlite in git (branch-ul "data"), ca baza de date sa
// nu se piarda cand botul se opreste / ruleaza pe GitHub Actions (unde
// filesystem-ul e efemer intre rulari). Se declanseaza automat cu
// DB_PERSIST_BRANCH setat (ex: "data"). Local nu se seteaza - DB-ul local
// ramane oricum pe disc.
function runGit(args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: REPO_ROOT, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

let saving = null;

export async function persistNow(branch) {
  if (!branch || saving) return;
  saving = (async () => {
    try {
      checkpointDb();
      await runGit(["add", "-f", DB_REL]);
      try {
        await runGit([
          "-c", "user.name=news-bot",
          "-c", "user.email=news-bot@users.noreply.github.com",
          "commit", "-m", `autosave baza de date ${new Date().toISOString()}`,
        ]);
      } catch (e) {
        if (/nothing to commit|no changes added to commit|unable to create|empty ident/i.test(e.message)) {
          return; // nimic de salvat inca, nu e o eroare
        }
        throw e;
      }
      await runGit(["push", "--force", "origin", `HEAD:${branch}`]);
      console.log(`[persist] Baza de date salvata in branch '${branch}' (${new Date().toLocaleTimeString("ro-RO")})`);
    } catch (e) {
      console.warn(`[persist] Nu am putut salva baza de date: ${e.message}`);
    } finally {
      saving = null;
    }
  })();
  return saving;
}