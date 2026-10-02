# FutureCare Weekly Analysis Dashboard

Single-file Arabic/English dashboard for doctor performance and home-care operational analysis.

## Use

1. Open the deployed site.
2. Drop the Future Care performance report in XLS, XLSX, XLSM, or HTML format.
3. Select the report date and apply filters.
4. Export filtered Excel, Word, PDF, HTML, TXT, duty schedule, and CME analysis.

## Metrics

- DR Plan and DR Done — partial cases (DRP > DRD > 0) are treated as fulfilled: their remaining visits are zeroed out of DR Plan everywhere (listed for audit in the Partial tab)
- Completion and utilization (6 visits/day, excluding Fridays) over a manual analysis period (from–to; default: month start → report date)
- Not visited (DRP > 0, DRD = 0)
- Executive report scope: doctors with fewer than 20 patients are excluded (name, patients and totals) and listed in a note; overall utilization = DR Done ÷ (working days × 6 × included doctors)
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
