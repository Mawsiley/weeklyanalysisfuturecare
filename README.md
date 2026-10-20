# FutureCare Weekly Analysis Dashboard

Single-file Arabic/English dashboard for doctor performance and home-care operational analysis.

## Use

1. Open the deployed site.
2. Drop the Future Care performance report in XLS, XLSX, XLSM, or HTML format.
3. Select the report date and apply filters.
4. Export filtered Excel, Word, PDF, HTML, TXT, duty schedule, and CME analysis.

All generated reports and exports (executive report text/HTML/TXT, Word, PDF, Excel, duty schedule Excel/print, GP Extra report) are in English; the dashboard interface is Arabic.

## Metrics

- DR Plan and DR Done — partial cases (DRP > DRD > 0) are treated as fulfilled: their remaining visits are zeroed out of DR Plan everywhere (listed for audit in the Partial tab)
- Completion and utilization (6 visits/day, excluding Fridays) over a manual analysis period (from–to; default: month start → report date)
- Not visited (DRP > 0, DRD = 0)
- Executive report scope (⚙ ضبط الأطباء في التقرير, top of the Executive Report tab): per doctor **auto** (excluded only when below the minimum patients, default 20), **always keep** or **always exclude**. Defaults keep Dr Islam Mahmoud Mohamed Ahmed, Dr Asjad Abdelazem Mohamed Mustafa and Dr Rawan Yousif Mahadi Hassan. Everything follows it: doctor count, overall utilization = DR Done ÷ (working days × 6 × included doctors), totals, notes, Word/PDF/Excel/text. Saved in `futurecare-report-scope-v1` (synced, in the settings backup).
- Not Done analysed by GP Note: reason categories (patient-related vs operational), per-doctor reasons, unclassified notes and generated recommendations — in the Not Done tab, the executive report/Word, a dedicated Excel sheet and the PDF
- Default analysis period = first → last Last Visit date in the uploaded file
- DRP=0 with other services
- HARP, mobility, hospital admissions, and last visit
- Editable duty schedule and CME planning

## Monthly duty dashboard (October 2026 onward)

Open it from **🗓 المناوبات** in the header (no performance file needed) or the duty-schedule tab.

- Day shift 08:00–20:00, night shift 20:00–08:00.
- 08:00–12:00 on-call + New: Dr Lana by default. The GP rotation for this slot (Aya, Alaa, Rayan, Abdullah, Yousef, Iman) is inactive and can be activated from a chosen date via the rotation bar; single days can also be switched either way.
- New + Cash + cases referred by supervision: Dr Lana (replacing Dr Marwa).
- 12:00–20:00 Saturday–Thursday: the case doctor first, then the specialist on duty, alternating daily between Dr Ruqaya and Dr Islam.
- Fridays 08:00–20:00 (standby, activated on request): rotating GPs excluding Dr Lana, starting with Dr Aya in October 2026.
- Night: Dr Hossam; Friday Dr Samar; Sunday Dr Turki.
- Leave: shifts of a doctor on leave turn red until a replacement is chosen.
- Top menu: **Doctors & names** (rename everywhere, rotation membership, add/remove), **Leave entry**, **Change / exception** (single shift or a date range, optionally replacing one doctor, with a reason), and an **Exceptions log** (undo changes, assign replacements for leave conflicts).
- Every cell is editable; rotation rules and instructions are editable under the dashboard.
- Outputs: formatted RTL Excel (schedule with notes + instructions + exceptions, instructions, exceptions, per-doctor load, leave log) and a print/PDF page with the same exceptions.
- Data is stored in the browser (`futurecare-duty-v4`); use the settings backup button to move it between devices.

Prepared by: Dr ALMAWSILEY ALSAYED

- **Active / De-Active tab:** total patients of the loaded file (including De-Active, which every other statistic excludes) split into Active, Hospital, Traveler and De-Active, per doctor / city / company / group, with % De-Active, the DR visits planned for De-Active patients, filters and an Excel export. The new-patients tab also splits orders by Patient Active (Active / De-Active).

## Cloud sync (Firestore)

The header button **☁️ ربط المزامنة** signs in with the team password and syncs app settings (duty schedule, leave, exceptions, doctor directory, staff list, CME plan) across devices through a Netlify Function and Firestore. Patient data is never uploaded. See `docs/db-schema.md`.

## iCare connection (Chrome extension)

The **FutureCare Weekly — iCare Reports & Tasks** extension (separate from the exit-list iCare Connector; source in , installed copy in the Desktop folder "FutureCare Weekly iCare"; load it via `chrome://extensions` → Developer mode → Load unpacked) uses the signed-in iCare session to fetch reports directly. The iCare token stays inside the extension; pages only receive the requested rows.

| Page | Source in iCare | How the data is handled |
|---|---|---|
| Dashboard (`index.html`) | Performance Follow-up report (`/performance-follow-up/report`) — month + cities Jeddah, Makkah, Yanbu | Rebuilt as iCare's own `performance-report_<month>` export and passed through the normal upload path (Deactive excluded, partial cases zeroed, period from Last Visit) |
| DR Not Done (`dr-not-done.html`) | Same performance report | Normal upload path: DR NOT DONE = DRP > 0 and DRD = 0, Deactive excluded |
| GP Extra (`gp-extra-requests.html`) | `gp-extra-req-list` | Not connected yet — upload the file manually |

The per-page mapping lives in `icare-connect.js` (`PAGES`, `SOURCES`).

**Inside the extension (1.2.0+):** a 📊 التحليل tab with the report summary, doctors and the same task builder; it starts the run in the extension. The site keeps it in sync automatically: the report loaded on the site (fetched or uploaded) and the task rules (newer copy wins).

**🆕 New patients tab (site; extension 1.6.0+):** previous month vs current month only, from `icare.com.sa/new-file?cdm_siss=non_cdm`. The extension reads the same API the page uses (daily with the performance fetch, and on demand; local copy kept); a CSV/Excel exported from the page can be loaded instead. **The month selector (both / previous / current) drives everything**: numbers, tables (only that month's columns), filter lists, alerts, chart, the Excel export and all reports; filters that do not exist in the selected month are cleared. **Base of every percentage = files opened (File Open Time), and each file belongs to the month its file was opened** (choosing previous/current shows only files opened in that month; an order not opened yet belongs to its creation month); the new-patient orders are shown only as the larger reference number ("/ N orders"). Shows orders, files opened, visited (CSheet ≥ 1), visit rate (of opened files), not visited and pending ≥ 3 days, approvals, appointments, referrals, VIP, duplicate-mobile orders, average days to file open, a daily chart, tables by doctor / city / company / status / referral source, a collapsible **box of the visited patients (CSheet ≥ 1) with the services done for them** (per-service done/planned, patients who received each, average per patient, visits with no service done, per-patient list, Excel sheet), a **comparison with the loaded performance report by PTID** (each opened file's status there — Active / Hospital / Traveler / De-Active / not in the report — and its services as P/D = planned/done, per-service totals, a prioritised patient list, alerts and Excel sheets), the not-yet-visited patients analysed **by the Project column** (both months, share not visited, pending ≥ 3 days; click a project to filter the list; Project filter; own Excel sheet), the list of not-yet-visited patients, alerts, and an English Excel export. **Names, mobile numbers, national IDs and nationality are never read or stored** (only PTID and analysis fields). Open it from the 🆕 المرضى الجدد button in the header or the tab.

**📑 New patients report (Word / PDF / Excel / PowerPoint):** for the selected period (previous / current / both) and the doctor / city / project filters, in English: orders (reference) → total cases converted (files opened) and conversion rate, referral cases, Active / De-Active / Traveler / Hospital (status from the performance report by PTID, Patient Active flag as fallback), visited cases, the services done for each visited case (D/P) with per-service totals, tables by doctor / city / project and notes. PowerPoint (PptxGenJS, loaded on demand with an integrity hash) has key-figure cards, a status chart, a services chart and paged case tables. No names, mobile numbers or IDs.

**🔔 Notification box (site + extension):** a hideable box (— minimise, ✕ hide until tomorrow, 🔔 in the header brings it back; state in `futurecare-notify-v1`) showing who is on duty right now (08–12 on-call + New, 12–20 specialist, 20–08 night; after midnight the previous day's night doctor; next shift; leave conflicts flagged) and, for every doctor, the cases visited yesterday and the visits still remaining (DR Plan − DR Done, partial cases zeroed). "Visited yesterday" = the doctor's patients whose Last Visit is yesterday with a DR visit done; in the extension (1.5.0+) it uses the exact increase of DR Done since yesterday's daily copy when available. The current shift is also highlighted in the duty schedule table with a banner.

**Daily fetch and local copy (extension 1.4.0+):** the extension fetches the current month once a day automatically (when an iCare session exists; checked hourly and as soon as iCare is opened; switch in the 📊 tab), keeps the latest iCare report plus 14 days of compact snapshots locally, and a fetch can also be run on demand at any time. Its screen shows alerts (freshness, no iCare session, failed fetch, Not Done and its change since the last day, Not Done without GP Note, low-completion doctors, cases ready for tasks, running/remaining jobs) and key tables (cities, top Not Done doctors, daily trend). The site gets a **📦 نسخة محلية** button that loads the saved copy without fetching again.

**Custom rules and one task per case (extension 1.3.0+):** besides the GP Note rules, you can add ★ custom rules — a filter (case status, doctor, city, GP Note empty/contains) with its own recipient, title and message; they are checked first and are shared between the site and the extension. Every case gets one task only: once the extension's send log has a task for a PTID (since the report month) it shows ✓ with the date, is no longer offered or selectable, and can be shown with "إظهارها". The site reads this log from the extension (read-only).

**Tasks tab (📨 التاسكات) in the dashboard:** cases come from the loaded report under the current dashboard filters; GP Note rules (Acute → 45, refused → 632, rescheduled → case doctor, not available → 709, extra visit → 45, optional Not Done without GP Note → case doctor) with editable recipient / title (≤ 35) / message and placeholders {DR_P} {DR_D} {NOTE} {DOCTOR} {PTID}; filter by reason/doctor/search, tick cases, preview every task; then **send to the extension** (or download the task Excel). The extension window opens with the list and the run is started there — the page never starts a run. Rules are saved in `futurecare-task-rules-v1` (synced).

**Task automation (icare-tasks engine, extension 1.1.0+):** the **📨 فتح تاسكات iCare من هذا التقرير** button hands the report loaded in the page (fetched or uploaded) to the extension, which opens its task window with the report imported as the GP Note profile (Acute → 45, refused → 632, rescheduled → case doctor, not available → 709, extra visit → 45). The user picks the reason, reviews the cases and starts the run there; nothing is sent to iCare before that. Tests: `node icare-extension-tests/background.test.js`, `import-exit-list.test.js`, `weekly-handoff.test.js`, `sw-load.test.js`. Local preview: `node scripts/dev-server.js` (add `?mockConnector=1`), `node icare-extension-tests/make-dash-preview.js` for the extension window.

### New patients: pulled together with the performance report (extension 1.7.0)
"Fetch from iCare" (and the daily automatic fetch) now pulls the new-patient files **and** the performance report of the same two months (previous + current) for Jeddah, Makkah and Yanbu, keeping only compact, identity-free records (status, services P/D, GP note) for the new patients. The dashboard uses them to explain **every** new case: the latest month decides the status (Active / De-Active / Traveler / Hospital), services are summed over the months, and each case gets a written explanation (visited / justified not visited / no justification / Acute / SABIC specialist). The Word, PDF, Excel and PowerPoint reports include a "Case-by-case explanation" section for all converted cases.

### New patients: tasks by filter + automatic SABIC routing
Section ④ of the 🆕 tab builds one task per new patient from rules over the page filters (month, doctor, city, Project, company, visit status, performance status), each with its own title/message (`{PTID} {CITY} {PROJECT} {COMPANY} {DOCTOR} {DAYS} {STATUS} {VISITS} {SERVICES} {SPECIALIST} {EXPLAIN}`). A new **SABIC** patient (company or Project) is routed automatically to the city's specialist - Jeddah/Makkah: ISLAM MAHMOUD MOHAMED AHMED, Yanbu: RAWAN YOUSIF MAHADI HASSAN (editable) - with an editable message. One task per case: a patient who already has a sent task in the extension history is never offered again. The list opens in the extension window; the run starts there. Rules are saved with the task rules (`taskCfg.np`) and synced.

### New patients: PTID links and drill-down
Every PTID in the 🆕 tab opens the patient in iCare (`https://icare.com.sa/patient-info?ptid=<PTID>`). Clicking any indicator chip or any row of the doctor / city / company / status / Active-De-Active / referral / Project / patient-status tables opens a "patients under the filter" list (with the explanation of each case and an Excel export); click again to close.

### New patients: notes on not-visited patients
Each not-visited patient gets a note (a classification from an editable list + free text) in the "Not visited" list and in the "patients under the filter" list. Notes are saved and synced with the task rules (`taskCfg.np.notes`), summarised by classification in 🗒 (click a row to list its patients), shown in the case explanation, exported in the Not visited sheet, and sent inside the task: `{NOTE}` in the message, or appended as "ملاحظة: ..." when the message has no `{NOTE}`. A custom task rule can target a note classification (or "with / without note").

### New patients: tasks for the active filter + automation (extension 1.8.0)
⚡ "Task for the active filter" (section ④): the cases of the active filter - page filters (month / doctor / city / Project) plus the open "patients under the filter" list - get a task with an editable recipient, title and message (`{NOTE}` carries the patient note). 📨 opens the extension window for review; ⚡ **Automation** opens it and, after you confirm inside the extension window, starts the run automatically (the extension's usual skip-already-sent settings apply). Both buttons also exist for the rules list. Automation needs extension 1.8.0+.

### New patients: files closed by status
A not-visited patient whose file is already closed by its status (last action / status: Removed, Refused, Does not require service, Not applicable) is split from the "no justification" cases: the funnel has "open follow-up" and "closed by status" chips (clickable), the justification column shows "ملف مغلق بحالته", the explanation says the file should be confirmed and archived, the reports show both counts, and **no task is created for them** (SABIC rule, quick tasks, and the "no justification" rules skip closed files).

### New patients: organised in tabs
The 🆕 tab keeps the filters and the percentage chips (and the "patients under the filter" list) at the top, and splits the analysis into sub-tabs with counters: 📊 Summary · 🚫 Not visited (by Project, SABIC / Acute, notes classification, list with justification) · 📨 Tasks · ✅ Visited & services · 📈 Analysis (doctor / city / company / status / referral) · 🔎 Case explanations. The Word / PDF / Excel / PowerPoint reports follow the same order (summary → not visited → visited & services → doctor / city / project → case explanations).

### New patients: De-Active split by CSheet
De-Active patients are split into **stopped after a visit** (CSheet visits >= 1) and **stopped before any visit** (CSheet = 0): two clickable chips under De-Active, a "De-Active - after / before the visit" table in the Summary tab, the case explanation, and the two extra KPI rows + finding line in the Word / PDF / Excel / PowerPoint reports.

### Yesterday's visits: exact (extension 1.8.1)
The "visited yesterday" figure per doctor was approximate: the report's *Last Visit* mixes every service (nursing, PT, lab...) and the doctor was the patient's assigned doctor. Now, after each fetch the extension takes the patients whose Last Visit is yesterday or later, reads each patient file's `recent_visits.gp` (the last **doctor** visit date and the **visiting doctor**) and counts the patients whose doctor visit was yesterday, per visiting doctor. Only counts per doctor are kept (no names, mobiles or IDs). The notification box in the extension and on the site shows "دقيق" with the number of files checked, or "تقريبي" until the first fetch with extension 1.8.1+. Limit: only the *last* doctor visit date is available, so a patient visited by the doctor yesterday **and** again today is not counted for yesterday.
