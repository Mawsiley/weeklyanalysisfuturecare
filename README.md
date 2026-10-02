# FutureCare Weekly Analysis Dashboard

Single-file Arabic/English dashboard for doctor performance and home-care operational analysis.

## Use

1. Open the deployed site.
2. Drop the Future Care performance report in XLS, XLSX, XLSM, or HTML format.
3. Select the report date and apply filters.
4. Export filtered Excel, Word, PDF, HTML, TXT, duty schedule, and CME analysis.

## Metrics

- DR Plan and DR Done
- Completion and utilization (6 visits/day, excluding Fridays)
- Not visited and partial visits
- GP Note documentation
- DRP=0 with other services
- HARP, mobility, hospital admissions, and last visit
- Editable duty schedule and CME planning

## Monthly duty dashboard (October 2026 onward)

Open it from **🗓 المناوبات** in the header (no performance file needed) or the duty-schedule tab.

- Day shift 08:00–20:00, night shift 20:00–08:00.
- 08:00–12:00 on-call + New: Dr Lana by default; any day (or the whole month) can switch to a rotating GP who continues daily visits.
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
