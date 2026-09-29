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

let saving = Promise.resolve();
let pushPending = false;

async function pushSnapshot(branch) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await runGit(["push", "--force", "origin", `HEAD:${branch}`]);
      pushPending = false;
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1000 * (2 ** attempt)));
    }
  }
  pushPending = true;
  throw lastError;
}

async function persistSnapshot(branch, { throwOnError = false } = {}) {
  try {
    checkpointDb();
    await runGit(["add", "-f", DB_REL]);
    // Limitează commitul la baza de date și nu include accidental fișiere
    // care ar putea fi deja staged în checkout.
    const hasChanges = await runGit(["diff", "--cached", "--quiet", "--", DB_REL]).then(() => false).catch(() => true);
    if (hasChanges) {
      await runGit([
        "-c", "user.name=news-bot",
        "-c", "user.email=news-bot@users.noreply.github.com",
        "commit", "-m", `autosave baza de date ${new Date().toISOString()}`, "--", DB_REL,
      ]);
      pushPending = true;
    }
    if (!hasChanges && !pushPending) return true;
    await pushSnapshot(branch);
    console.log(`[persist] Baza de date salvata in branch '${branch}' (${new Date().toLocaleTimeString("ro-RO")})`);
    return true;
  } catch (e) {
    console.warn(`[persist] Nu am putut salva baza de date: ${e.message}`);
    if (throwOnError) throw e;
    return false;
  }
}

// Serialize snapshots instead of dropping requests that arrive while a push
// is already in flight. Critical approval state is therefore pushed as soon
// as the current autosave finishes.
export function persistNow(branch, options = {}) {
  if (!branch) return Promise.resolve(false);
  saving = saving.catch(() => {}).then(() => persistSnapshot(branch, options));
  return saving;
}
