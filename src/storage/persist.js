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
      if (err) reject(new Error([stdout, stderr].filter(Boolean).join("\n") || err.message));
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
      // Verificam daca e ceva nou inainte de a rula commit (evitam eroarea
      // "nothing to commit" care pe Windows nu e capturata corect in stderr).
      const hasChanges = await runGit(["diff", "--cached", "--quiet"]).then(() => false).catch(() => true);
      if (!hasChanges) return;
      await runGit([
        "-c", "user.name=news-bot",
        "-c", "user.email=news-bot@users.noreply.github.com",
        "commit", "-m", `autosave baza de date ${new Date().toISOString()}`,
      ]);
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