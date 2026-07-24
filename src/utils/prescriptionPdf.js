// Server-side A4 rendering of the Taafi prescription pad.
//
// Builds a self-contained HTML replica of the Flutter pad
// (frontend/lib/features/prescriptions/prescription_pad_widget.dart — keep
// the two layouts in sync when either changes) and compiles it to a PDF
// buffer with puppeteer. Consumed by GET /api/prescriptions/:id/download.

const { loadProviderPair, buildDoctorView } = require('./doctorView');

// puppeteer is resolved LAZILY (inside getBrowser) rather than at module
// load. On slim PaaS runtimes — Render's free native Node environment in
// particular — the ~170MB bundled Chromium is commonly skipped at install
// time (PUPPETEER_SKIP_DOWNLOAD=1) to stay inside the build limits. A
// top-level require there would throw during boot and take down the ENTIRE
// API over one optional endpoint. Deferring it means the server starts
// clean and only GET /api/prescriptions/:id/download degrades.
function loadPuppeteer() {
  try {
    return require('puppeteer');
  } catch (_err) {
    const e = new Error(
      'PDF rendering is unavailable on this deployment (puppeteer/Chromium ' +
        'is not installed). Set PUPPETEER_EXECUTABLE_PATH to a system ' +
        'Chromium, or deploy the Docker image which bundles one.',
    );
    e.status = 503;
    throw e;
  }
}

// ── Pad palette — mirrors the Dart `_pad*` constants in
//    prescription_pad_widget.dart. Update both together.
const PAD_INK = '#1F2937';
const PAD_INK_SOFT = '#6B7280';
const PAD_TEAL = '#0D9488';
const PAD_ROW_ALT = '#F1F5F9';
const PAD_LINE = '#E2E8F0';
// Brand wordmark colour (Taafi sunset orange) — mirrors _padBrand in the
// Flutter pad. The rest of the pad stays teal-accented.
const PAD_BRAND = '#F36512';

const TAAFI_BRAND = 'Taafi';
const TAAFI_TAGLINE = 'Your Trusted Home Healthcare Partner';

// ── Chromium singleton ──────────────────────────────────────────────
// One shared browser, one page per request. A crash/disconnect nulls
// the promise so the next request relaunches instead of failing forever.
let browserPromise = null;

async function getBrowser() {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => null);
    if (existing && existing.connected) return existing;
    browserPromise = null;
  }
  const puppeteer = loadPuppeteer();
  browserPromise = puppeteer.launch({
    headless: true,
    // --disable-dev-shm-usage (containers give /dev/shm only 64MB) and
    // --disable-gpu keep Chromium inside a 512MB memory ceiling; without
    // them it OOM-kills the instance on small plans.
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
    ...(process.env.PUPPETEER_EXECUTABLE_PATH
      ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
      : {}),
  });
  const browser = await browserPromise;
  browser.on('disconnected', () => {
    browserPromise = null;
  });
  return browser;
}

// ── Helpers ─────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Display mappers — mirror the Flutter pad's MedicationForm.label /
// meal-instruction mapping exactly.
const FORM_PREFIX = {
  TAB: 'Tab.',
  CAP: 'Cap.',
  SYR: 'Syr.',
  INJ: 'Inj.',
  CRM: 'Cream',
  DROP: 'Drops',
};

const MEAL_LABEL = {
  before: 'Before Meal',
  after: 'After Meal',
  either: 'With/Without Meal',
};

function freqCode(f) {
  return [f?.morning, f?.afternoon, f?.night]
    .map((b) => (b ? '1' : '0'))
    .join('+');
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function fmtLongDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function trimNum(n) {
  if (n === null || n === undefined) return '';
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(1)));
}

// Pad header credentials: frozen snapshot first (new scripts), then the
// live provider join (legacy rows), then the flat doctor_name. Mirrors
// the Flutter model's pad* fallback getters.
async function resolveDoctorBlock(doc) {
  const snap = doc.doctor_snapshot;
  if (snap && snap.name) {
    return {
      name: snap.name,
      degrees: snap.degrees || '',
      hospitalOrCollege: snap.hospital_or_college || '',
      registration: snap.registration_number || '',
      email: snap.email || '',
    };
  }
  try {
    if (doc.doctor_account_id) {
      const pair = await loadProviderPair(doc.doctor_account_id, 'doctor');
      const view = buildDoctorView(pair);
      if (view) {
        return {
          name: view.full_name || doc.doctor_name || 'Doctor',
          degrees: view.degrees || view.specialization || '',
          hospitalOrCollege: view.hospital_affiliation || '',
          registration: view.bmdc_license || '',
          email: view.email || '',
        };
      }
    }
  } catch (_) {
    /* credential join is best-effort */
  }
  return {
    name: doc.doctor_name || 'Doctor',
    degrees: '',
    hospitalOrCollege: '',
    registration: '',
    email: '',
  };
}

// ── HTML template ───────────────────────────────────────────────────
// Fully self-contained (inline CSS, no external assets) so setContent
// with waitUntil:'load' never stalls on network fetches.

function buildPrescriptionHtml(doc, doctor) {
  const v = doc.vitals_snapshot || null;

  const displayName = /^dr\b/i.test(doctor.name)
    ? doctor.name
    : `Dr. ${doctor.name}`;

  // Prefer the frozen branding snapshot (new scripts); fall back to the
  // live constants for legacy rows.
  const brand = doc.branding_snapshot || null;
  const brandName = (brand && brand.brand_name) || TAAFI_BRAND;
  const brandTagline = (brand && brand.tagline) || TAAFI_TAGLINE;

  const vitalsPairs = [
    ['Date', fmtDate(doc.issued_at)],
    ['Diagnosis', doc.diagnosis || ''],
    ['Weight', v && v.weight_kg != null ? `${trimNum(v.weight_kg)} kg` : ''],
    ['Height', v && v.height_cm != null ? `${trimNum(v.height_cm)} cm` : ''],
    ['BP', v && v.blood_pressure ? v.blood_pressure : ''],
  ].filter(([, val]) => val !== '');

  const vitalsHtml = vitalsPairs
    .map(
      ([k, val]) =>
        `<span class="vital"><span class="vk">${esc(k)}:</span> ` +
        `<span class="vv">${esc(val)}</span></span>`,
    )
    .join('');

  const rowsHtml = (doc.items || [])
    .map((it) => {
      const prefix = FORM_PREFIX[it.form] || '';
      const medName = `${prefix ? `${esc(prefix)} ` : ''}${esc(it.drug_name)}`;
      const notes = it.notes
        ? `<div class="notes">${esc(it.notes)}</div>`
        : '';
      const meal = MEAL_LABEL[it.meal_context] || MEAL_LABEL.either;
      return (
        '<tr>' +
        `<td><div class="med">${medName}</div>${notes}</td>` +
        `<td><div class="dose">${esc(it.dosage)} — ${freqCode(it.frequency)}</div>` +
        `<div class="meal">${esc(meal)}</div></td>` +
        `<td class="dur">${Number(it.duration_days) || 0} days</td>` +
        '</tr>'
      );
    })
    .join('');

  const adviceHtml = doc.advice
    ? `<div class="flabel">ADVICE GIVEN</div>` +
      `<div class="advice">${esc(doc.advice)}</div>`
    : '';

  const followUpHtml = doc.follow_up_date
    ? `<div class="flabel">FOLLOW-UP</div>` +
      `<div class="followup">${esc(fmtLongDate(doc.follow_up_date))}</div>`
    : '';

  const reviewCorner = doc.follow_up_date
    ? `<div class="review">Review on: ${esc(fmtDate(doc.follow_up_date))}</div>`
    : '<div></div>';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: A4; margin: 15mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
    color: ${PAD_INK};
    font-size: 12px;
  }
  .header { display: flex; justify-content: space-between; align-items: flex-start; }
  .doc-name { font-size: 19px; font-weight: 800; line-height: 1.2; }
  .doc-degrees { color: ${PAD_INK_SOFT}; font-size: 13px; font-weight: 600; margin-top: 3px; }
  .doc-hospital { color: ${PAD_INK}; font-size: 12px; font-weight: 600; margin-top: 2px; }
  .doc-meta { color: ${PAD_INK_SOFT}; font-size: 12px; margin-top: 2px; }
  .brand { text-align: right; }
  .brand-name { color: ${PAD_BRAND}; font-size: 26px; font-weight: 900; letter-spacing: .5px; line-height: 1.1; }
  .brand-tag { color: ${PAD_INK_SOFT}; font-size: 10.5px; font-weight: 600; letter-spacing: .2px; margin-top: 3px; }
  .rule { height: 1.5px; background: ${PAD_INK}; margin: 12px 0 14px; }
  .vitals { background: ${PAD_ROW_ALT}; border-radius: 8px; padding: 10px 14px; }
  .vital { display: inline-block; margin-right: 20px; line-height: 1.7; }
  .vk { color: ${PAD_INK_SOFT}; font-size: 11.5px; font-weight: 700; }
  .vv { font-size: 12px; font-weight: 600; }
  .rx { color: ${PAD_TEAL}; font-size: 38px; font-weight: 900; font-style: italic; margin: 18px 0 8px; }
  table { width: 100%; border-collapse: collapse; border-top: 1px solid ${PAD_LINE}; border-bottom: 1px solid ${PAD_LINE}; }
  th { color: ${PAD_INK_SOFT}; font-size: 10.5px; font-weight: 800; letter-spacing: 1px; text-align: left; padding: 9px 10px; }
  td { padding: 10px; border-top: 0.6px solid ${PAD_LINE}; vertical-align: middle; }
  th:nth-child(1), td:nth-child(1) { width: 50%; }
  th:nth-child(2), td:nth-child(2) { width: 34%; }
  th:nth-child(3), td:nth-child(3) { width: 16%; }
  tbody tr:nth-child(even) td { background: ${PAD_ROW_ALT}; }
  .med { font-size: 13.5px; font-weight: 700; line-height: 1.3; }
  .notes { color: ${PAD_INK_SOFT}; font-size: 11px; margin-top: 2px; line-height: 1.3; }
  .dose { font-size: 12.5px; font-weight: 600; line-height: 1.3; }
  .meal { color: ${PAD_INK_SOFT}; font-size: 11px; line-height: 1.4; }
  .dur { font-size: 12.5px; font-weight: 600; }
  .footer { margin-top: 22px; }
  .flabel { color: ${PAD_TEAL}; font-size: 10.5px; font-weight: 800; letter-spacing: 1px; margin-top: 12px; }
  .advice { font-size: 12.5px; line-height: 1.5; margin-top: 4px; }
  .followup { font-size: 12.5px; font-weight: 600; margin-top: 4px; }
  .corners { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 42px; }
  .review { color: ${PAD_INK_SOFT}; font-size: 11.5px; }
  .sig { text-align: right; }
  /* Script font where available; italic keeps the serif/cursive
     fallback reading as a signature on font-poor servers. */
  .sig-name { font-family: 'Segoe Script', 'Brush Script MT', cursive; font-style: italic; font-size: 24px; line-height: 1.2; }
  .sig-rule { width: 170px; height: 1px; background: ${PAD_INK_SOFT}; margin: 4px 0 5px auto; }
  .sig-caption { color: ${PAD_INK_SOFT}; font-size: 10px; font-weight: 600; letter-spacing: .8px; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="doc-name">${esc(displayName)}</div>
      ${doctor.degrees ? `<div class="doc-degrees">${esc(doctor.degrees)}</div>` : ''}
      ${doctor.hospitalOrCollege ? `<div class="doc-hospital">${esc(doctor.hospitalOrCollege)}</div>` : ''}
      ${doctor.registration ? `<div class="doc-meta">BMDC Reg. No: ${esc(doctor.registration)}</div>` : ''}
      ${doctor.email ? `<div class="doc-meta">${esc(doctor.email)}</div>` : ''}
    </div>
    <div class="brand">
      <div class="brand-name">${esc(brandName)}</div>
      <div class="brand-tag">${esc(brandTagline)}</div>
    </div>
  </div>
  <div class="rule"></div>
  <div class="vitals">${vitalsHtml}</div>
  <div class="rx">Rx</div>
  <table>
    <thead>
      <tr><th>MEDICINE</th><th>DOSAGE</th><th>DURATION</th></tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="footer">
    ${adviceHtml}
    ${followUpHtml}
    <div class="corners">
      ${reviewCorner}
      <div class="sig">
        <div class="sig-name">${esc(displayName)}</div>
        <div class="sig-rule"></div>
        <div class="sig-caption">Digital Signature</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

// ── Entry point ─────────────────────────────────────────────────────

/**
 * Render a prescription document into an A4 PDF buffer. Throws when
 * Chromium can't launch or the render fails — the route maps that to
 * a 503 so a renderer outage never masquerades as a data error.
 */
async function renderPrescriptionPdf(doc) {
  const doctor = await resolveDoctorBlock(doc);
  const html = buildPrescriptionHtml(doc, doctor);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { renderPrescriptionPdf };
