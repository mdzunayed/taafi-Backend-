#!/usr/bin/env node
/**
 * One-time migration: materialise a Wallet for every doctor/nurse Account and
 * carry over the cash they were holding under the old single-field ledger.
 *
 * Before the wallet engine, a provider's only money field was
 * `Account.financial_ledger.cash_in_hand`. `Wallet.cashInHand` is now the
 * ledger of record, so any provider mid-way through holding cash when this
 * ships would otherwise appear to have handed it all back.
 *
 * Safe to re-run. Wallet creation is an upsert keyed on `providerId`, and the
 * cash carry-over only applies to wallets that were CREATED by this run — a
 * wallet that already exists has been through the live ledger and its balance
 * is authoritative, so re-running never re-adds cash that was already cleared.
 *
 *   node backend/scripts/backfillWallets.js
 *   node backend/scripts/backfillWallets.js --dry-run
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Account = require('../src/models/Account');
const Wallet = require('../src/models/Wallet');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/taafi';
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log(`[backfill] connected to ${MONGO_URI}`);
  if (DRY_RUN) console.log('[backfill] DRY RUN — no writes will be made');

  const providers = await Account.find(
    { role: { $in: ['doctor', 'nurse'] } },
    '_id full_name role financial_ledger',
  ).lean();
  console.log(`[backfill] ${providers.length} provider account(s) found`);

  let created = 0;
  let carried = 0;
  let carriedTotal = 0;
  let skipped = 0;

  for (const p of providers) {
    const legacyCash = Number(p.financial_ledger?.cash_in_hand) || 0;
    const existing = await Wallet.findOne({ providerId: p._id });

    if (existing) {
      skipped += 1;
      continue;
    }

    if (DRY_RUN) {
      created += 1;
      if (legacyCash > 0) {
        carried += 1;
        carriedTotal += legacyCash;
        console.log(
          `[backfill] would create wallet for ${p.full_name} (${p.role}) ` +
            `carrying ৳${legacyCash}`,
        );
      }
      continue;
    }

    await Wallet.create({
      providerId: p._id,
      providerRole: p.role,
      digitalBalance: 0,
      cashInHand: legacyCash,
      totalEarned: 0,
      totalWithdrawn: 0,
      // Deliberately NOT evaluating the cash ceiling here: locking a provider
      // out of withdrawals as a side effect of a migration would be a nasty
      // surprise. The next earning credit re-evaluates the lock properly.
      isPayoutLocked: false,
      lastCreditAt: p.financial_ledger?.last_collection_at || null,
    });
    created += 1;
    if (legacyCash > 0) {
      carried += 1;
      carriedTotal += legacyCash;
      console.log(
        `[backfill] ${p.full_name} (${p.role}) — carried ৳${legacyCash}`,
      );
    }
  }

  console.log('');
  console.log(`[backfill] wallets created : ${created}`);
  console.log(`[backfill] already present : ${skipped}`);
  console.log(`[backfill] cash carried    : ${carried} provider(s), ৳${carriedTotal}`);
  console.log('[backfill] done');

  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error('[backfill] FAILED:', err);
  try {
    await mongoose.connection.close();
  } catch (_) {
    /* already closed */
  }
  process.exit(1);
});
