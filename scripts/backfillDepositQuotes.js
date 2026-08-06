#!/usr/bin/env node
/**
 * One-shot backfill: stamp `deposit_quoted_amount` on every in-flight booking
 * that is still awaiting its confirmation deposit.
 *
 * The deposit used to be a compiled-in constant (৳100). It is now
 * `Settings.booking_deposit_amount`, admin-editable at any time, and each new
 * booking snapshots the configured value at creation so a later fee change can
 * never re-price a checkout a patient is already standing in.
 *
 * Rows created BEFORE that field existed carry nothing. They fall back to the
 * live configured amount — which is correct only for as long as nobody has
 * changed it. The moment an admin sets the deposit to ৳250, every unpaid legacy
 * booking silently starts demanding ৳250 for a slot the patient was quoted
 * ৳100 for.
 *
 *   node backend/scripts/backfillDepositQuotes.js            # report only
 *   node backend/scripts/backfillDepositQuotes.js --apply    # write
 *
 * DRY RUN IS THE DEFAULT.
 *
 * !! RUN THIS BEFORE THE DEPOSIT IS EVER CHANGED FROM 100 !! It is the only
 * thing standing between an in-flight booking and a silent re-price. Running it
 * while the configured value is still 100 is semantically a no-op, which is
 * exactly why it is safe to run immediately and unsafe to defer.
 *
 * Paid bookings are never touched: `deposit_amount` already records what they
 * settled, and that always wins over the quote.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const CareRequest = require('../src/models/CareRequest');
const { DEFAULT_BOOKING_DEPOSIT } = require('../src/utils/money');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/taafi';
const APPLY = process.argv.includes('--apply');

// The amount legacy rows were quoted under the old hardcoded constant. NOT the
// currently-configured value — these bookings predate configurability, so by
// definition they were quoted the compiled-in figure.
const LEGACY_DEPOSIT = DEFAULT_BOOKING_DEPOSIT;

// Host + database only — an Atlas URI carries its password inline and this
// output ends up in screenshots and tickets.
function safeUri(uri) {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(unparseable MONGO_URI)';
  }
}

// Unpaid bookings with no usable quote. `$lte: 0` catches a 0 written by an
// older build as well as a genuine null/missing field.
const FILTER = {
  status: 'awaiting_deposit',
  $or: [
    { deposit_quoted_amount: null },
    { deposit_quoted_amount: { $exists: false } },
    { deposit_quoted_amount: { $lte: 0 } },
  ],
};

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log(`\n  Mongo: ${safeUri(MONGO_URI)}`);
  console.log(`  Mode:  ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}\n`);

  const rows = await CareRequest.find(FILTER, '_id patient_name care_type created_at').lean();

  console.log(`  Bookings awaiting a deposit with no quote: ${rows.length}\n`);
  for (const r of rows) {
    const when = r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '?';
    console.log(`    [quote ৳${LEGACY_DEPOSIT}]  ${when}  ${r.patient_name} — ${r.care_type}`);
  }

  if (!rows.length) {
    console.log('  Nothing to do.\n');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (!APPLY) {
    console.log('\n  Dry run — re-run with --apply to write.\n');
    await mongoose.disconnect();
    process.exit(0);
  }

  const result = await CareRequest.updateMany(FILTER, {
    $set: { deposit_quoted_amount: LEGACY_DEPOSIT },
  });
  console.log(`\n  Stamped ${result.modifiedCount} booking(s) at ৳${LEGACY_DEPOSIT}.\n`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
