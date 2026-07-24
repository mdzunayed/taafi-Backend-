// Age helpers for dependent / care-recipient profiles. The date of birth is
// stored as a free-form String (a partial "1990" is acceptable input), so
// every consumer must parse defensively — a bad or partial DOB yields null
// rather than a misleading number.

// Derive an integer age in whole years from a DOB string. Accepts full ISO
// dates ("1958-04-12"), year-only ("1958"), or year/month. Returns null when
// the input is empty, unparseable, or in the future.
function ageFromDob(dob) {
  if (dob == null) return null;
  const raw = String(dob).trim();
  if (!raw) return null;

  let birth;
  if (/^\d{4}$/.test(raw)) {
    // Year only — anchor to mid-year so the age is off by at most ~6 months.
    birth = new Date(Number(raw), 6, 1);
  } else {
    birth = new Date(raw);
  }
  if (Number.isNaN(birth.getTime())) return null;

  const now = new Date();
  if (birth.getTime() > now.getTime()) return null;

  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age -= 1;
  return age >= 0 ? age : null;
}

// "62 / F" style compact label for provider offer tiles. Falls back to
// whichever half is known; returns '' when neither age nor gender is present.
function ageSexLabel(dob, gender) {
  const age = ageFromDob(dob);
  const g = (gender || '').toString().trim();
  const sex = g ? g.charAt(0).toUpperCase() : '';
  if (age != null && sex) return `${age} / ${sex}`;
  if (age != null) return `${age}`;
  if (sex) return sex;
  return '';
}

module.exports = { ageFromDob, ageSexLabel };
