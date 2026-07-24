// Seeds realistic wallet activity for the seeded doctor + nurse so the Wallet
// page and the admin payout queue have something to render during verification.
require('dotenv').config();
const mongoose = require('mongoose');
const Account = require('./src/models/Account');
const CareRequest = require('./src/models/CareRequest');
const Wallet = require('./src/models/Wallet');
const WalletTransaction = require('./src/models/WalletTransaction');
const PayoutRequest = require('./src/models/PayoutRequest');
const ws = require('./src/services/walletService');

const TAG = 'DEMO_WALLET';

async function main() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/taafi');
  await WalletTransaction.syncIndexes();

  const doctor = await Account.findOne({ role: 'doctor' });
  let nurse = await Account.findOne({ role: 'nurse' });
  console.log('doctor:', doctor?.full_name, doctor?._id.toString());

  // Reset any prior demo run so this script is re-runnable.
  const old = await CareRequest.find({ patient_name: { $regex: `^${TAG}` } }, '_id');
  const oldIds = old.map(o => o._id);
  await WalletTransaction.deleteMany({ bookingId: { $in: oldIds } });
  await CareRequest.deleteMany({ _id: { $in: oldIds } });

  if (doctor) {
    await Wallet.updateOne(
      { providerId: doctor._id },
      { $set: { digitalBalance: 0, cashInHand: 0, totalEarned: 0, totalWithdrawn: 0, isPayoutLocked: false } },
      { upsert: false },
    );
    await WalletTransaction.deleteMany({ providerAccountId: doctor._id });
    await PayoutRequest.deleteMany({ providerAccountId: doctor._id });

    // Three digital visits + one cash visit → a realistic mixed ledger.
    const visits = [
      { price: 2500, name: 'Rahim Uddin', type: 'Doctor Visit', cash: false },
      { price: 1800, name: 'Fatima Begum', type: 'Follow-up Visit', cash: false },
      { price: 3200, name: 'Karim Sheikh', type: 'Doctor Visit', cash: false },
      { price: 1500, name: 'Nasreen Akter', type: 'Home Consultation', cash: true },
    ];
    for (const v of visits) {
      const r = await CareRequest.create({
        patient_name: `${TAG} ${v.name}`,
        care_type: v.type,
        status: 'completed',
        final_price: v.price,
        deposit_amount: 100,
        assigned_doctor_id: doctor._id.toString(),
        completed_at: new Date(Date.now() - Math.random() * 6e8),
      });
      if (v.cash) {
        await ws.creditVisitEarnings(null, r, {
          method: 'CASH',
          collectorId: doctor._id.toString(),
          cashCollected: v.price - 100,
        });
      } else {
        await ws.creditVisitEarnings(null, r, { method: 'DIGITAL' });
      }
    }
    const w = await Wallet.findOne({ providerId: doctor._id });
    console.log('doctor wallet →', {
      digital: w.digitalBalance, cash: w.cashInHand,
      earned: w.totalEarned, locked: w.isPayoutLocked,
    });
  }

  // A nurse with a PENDING payout so the admin queue has a row to action.
  if (!nurse) {
    nurse = await Account.create({
      full_name: 'Nurse Shirin Akter',
      phone: '8801700000009',
      password_hash: '$2b$10$abcdefghijklmnopqrstuv',
      role: 'nurse',
      is_verified: true,
    });
    console.log('created demo nurse', nurse._id.toString());
  }
  await Wallet.updateOne(
    { providerId: nurse._id },
    { $set: { digitalBalance: 0, cashInHand: 0, totalEarned: 0, totalWithdrawn: 0, isPayoutLocked: false } },
    { upsert: false },
  );
  await Wallet.forProvider(nurse._id, 'nurse');
  await WalletTransaction.deleteMany({ providerAccountId: nurse._id });
  await PayoutRequest.deleteMany({ providerAccountId: nurse._id });

  const nv = await CareRequest.create({
    patient_name: `${TAG} Shahana Parvin`,
    care_type: 'Nursing Care',
    status: 'completed',
    final_price: 4000,
    deposit_amount: 100,
    assigned_nurse_id: nurse._id.toString(),
    completed_at: new Date(),
  });
  await ws.creditVisitEarnings(null, nv, { method: 'DIGITAL' });

  const held = await ws.holdPayoutFunds(nurse._id, 2000);
  if (held) {
    const pr = await PayoutRequest.create({
      providerAccountId: nurse._id,
      providerName: nurse.full_name,
      providerRole: 'nurse',
      providerPhone: nurse.phone || '',
      amount: 2000,
      method: 'bKash',
      accountDetails: { accountNumber: '01712345678', accountName: nurse.full_name },
      status: 'PENDING',
    });
    await ws.recordPayoutHold(held, pr);
    console.log('nurse pending payout created:', pr._id.toString());
  }

  await mongoose.connection.close();
  console.log('done');
}
main().catch(e => { console.error(e); process.exit(1); });
