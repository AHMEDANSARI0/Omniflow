# GitHub Cleanup and Remaining Work (§264)

_Dated 2026-10-10. Run the steps from the laptop (`...whatsapp-ai-bot\Omniflow` and `...OmniFlow-Control-Plane`). All pushes happen from the laptop._

---

## 1. Remaining work (complete list)

### A. Apply and deploy (code ready, waiting for the laptop)
1. **`finish_263.mjs`** - apply on the laptop, then `npx tsc --noEmit` and `node tools/cp-testrig/finish_harness_263.mjs` (9 checks), deploy the website. Adds Client billing to the admin nav and fixes the analytics privacy wording.
2. **Push billing §261 to GitHub** - billing is applied on the laptop but GitHub (origin/main) has zero §261 files. Commit + push the website changes from the batch.
3. **Push the Control Plane side of §261** - the `OmniFlow-Control-Plane` repo needs its own commit + push: `portal_billing.py` (new), `portal_plans.py`, `app.py`. Deploy CP first, then the website. Verify by opening `/admin/customers/billing` after deploy.
4. **Push §263** after it is applied (9 files, website only).

### B. GitHub hygiene (this batch fixes the files; the `git rm` commands are in section 3)
5. Remove tracked local junk from the index: `venv/` (1204 files), `whatsapp_session/` (533), `_archive/` (184), `backups/` (8 DB dumps), `runtime_locks/` (4), `data/` (2), `.agents/` (2), `verify-script/` (1).
6. Remove the `OmniFlow-Control-Plane` gitlink entry from the website repo (it shows as a broken submodule on GitHub; the real CP code lives in its own repo).
7. Restore `eslint.config.mjs` (it was dropped; `npm run lint` cannot run without it).
8. Land the final `.gitignore` (this batch writes it).

### C. Security follow-ups (important)
9. **Rotate the WhatsApp Web link**: `whatsapp_session/` (including 24 cookie/storage files) was committed to GitHub history. On the phone: WhatsApp > Linked devices > log the session out, then relink.
10. **Check repo visibility**: `backups/pre_migration_00*.dump` are full database dumps and `data/conversations.json` holds chat data. If the repo is PUBLIC, make it private first, then consider purging history (GitHub support / `git filter-repo`). If it is already private, removing the files from tracking plus the session rotation is enough for most cases.
11. No `.env` or service key was ever committed (verified); `.env*` is ignored.

### D. Owner decisions (no code until decided)
12. **Currency**: billing defaults to PKR. Confirm PKR or name another currency.
13. **Invoices**: excluded from billing by decision; new batch if/when needed.
14. **Payment gateway**: manual payments for now; gateway is a later batch.

### E. Verify after deploy
15. `/admin` sidebar and Sections grid show Client billing; `/admin/customers/billing` highlights only Client billing; `/admin/analytics` shows the scoped privacy card.
16. Confirm batches 255-260 applied status on the laptop is fully pushed (GitHub already shows §243-§260 markers).

---

## 2. What GitHub has today (origin/main = `99d0c72 "admin dashboard polish"`)

| State | Detail |
|---|---|
| Batches on GitHub | §243 to §260 are present (marker scan: 243, 244, 245, 246, 247, 250, 255, 256, 257, 258, 259, 260 all found) |
| Missing on GitHub | §261 billing (0 files) and §263 finish batch (0 files) - applied/pending on the laptop, not pushed |
| Junk tracked | `venv/` 1204 files, `whatsapp_session/` 533, `_archive/` 184, `backups/` 8, `runtime_locks/` 4, `data/` 2, `.agents/` 2, `verify-script/` 1 |
| Broken entry | `OmniFlow-Control-Plane` committed as a gitlink (mode 160000) - GitHub renders it as an unreadable folder |
| Deleted file | `eslint.config.mjs` gone from GitHub (lint broken) |
| Secrets | no `.env` / service keys committed; but session cookies + DB dumps in history (section C) |

---

## 3. Cleanup steps on the laptop (run AFTER `github_clean_264.mjs`)

The patcher writes the final `.gitignore`, restores `eslint.config.mjs`, and drops this guide. Then, at the website root:

```bat
git rm -r --cached --ignore-unmatch venv whatsapp_session _archive backups runtime_locks data .agents verify-script
git rm --cached --ignore-unmatch OmniFlow-Control-Plane
git add .gitignore eslint.config.mjs docs/GITHUB_CLEANUP_264.md
git commit -m "GitHub cleanup: untrack local junk, restore eslint config, final gitignore"
git push origin main
```

Notes:
- `git rm --cached` only removes the files from the index; the local copies on the laptop stay on disk.
- The `.gitignore` written by this batch keeps them out forever.
- The commit stays in history with the old junk; the security steps in section C cover that.

Then commit + push the pending work:

```bat
:: billing 261 + finish 263 website changes (adjust message as needed)
git add -A
git commit -m "Client billing (261) and finish batch (263): billing nav, privacy wording"
git push origin main

:: Control Plane repo (billing 261)
cd OmniFlow-Control-Plane
git add portal_billing.py portal_plans.py app.py
git commit -m "Client billing: ledger, expiry rule, blueprint registration (261)"
git push origin main
```

---

## 4. Definition of clean

After the steps above, GitHub is clean when:
- `git status` on the laptop shows nothing to commit (working tree clean).
- GitHub shows no `venv/`, `whatsapp_session/`, `_archive/`, `backups/`, `runtime_locks/`, `data/`, `.agents/`, `verify-script/` folders and no `OmniFlow-Control-Plane` gitlink.
- §261 and §263 markers are present on origin/main.
- `npm run lint` runs (eslint.config.mjs restored).
- The WhatsApp session is relinked and the repo visibility decision is made.
