require('dotenv').config();

const crypto = require('crypto');
const mongoose = require('mongoose');
const Service = require('./models/Service');
const PromoBanner = require('./models/PromoBanner');
const DynamicSection = require('./models/DynamicSection');
const Account = require('./models/Account');
const Provider = require('./models/Provider');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/taafi';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Demo accounts — mirror the old mock logins so the same credentials work
// against the real DB. Password for all: "password".
// Phones written in canonical (digits-only international) form so they
// match what `normalizePhone()` produces from any reasonable user
// input. The on-boot migration in server.js will also coerce any
// legacy rows that pre-date this convention.
const seedAccounts = [
  { full_name: 'Rumi Ahmed',        email: 'patient@taafi.app', phone: '8801700000003', role: 'user',           address: 'House 42, Road 11A, Dhanmondi, Dhaka' },
  { full_name: 'Dr. Nafisa Rahman', email: 'doctor@taafi.app',  phone: '8801700000001', role: 'doctor',         address: 'Apt 7, Banani C-block, Dhaka' },
  { full_name: 'Arif Khan',         email: 'admin@taafi.app',   phone: '8801700000002', role: 'support_member', address: 'Taafi HQ, Gulshan, Dhaka' },
];

// Demo providers for the admin Assign Team list. The Provider whose
// `email` matches a seeded Account is the linked profile for that
// doctor — `GET /doctor/profile` reads both rows and merges so the
// Profile screen renders professional fields from the Provider and
// identity fields from the Account.
const seedProviders = [
  { full_name: 'Dr. Nafisa Rahman',  email: 'doctor@taafi.app', role: 'doctor', specialization: 'General Surgery',  years_experience: 8,  rating: 4.93, review_count: 127, distance_km: 3.4, fee: 2400, verification_status: 'verified', availability_status: 'online'  },
  { full_name: 'Dr. Kamrul Hasan',                                  role: 'doctor', specialization: 'Orthopedics',      years_experience: 12, rating: 4.87, review_count: 184, distance_km: 5.1, fee: 2600, verification_status: 'verified', availability_status: 'online'  },
  { full_name: 'Dr. Anika Chowdhury',                               role: 'doctor', specialization: 'Internal Medicine', years_experience: 6,  rating: 4.81, review_count: 92,  distance_km: 6.8, fee: 2200, verification_status: 'verified', availability_status: 'offline' },
  { full_name: 'Shahana Begum',                                     role: 'helper', specialty: 'Nursing aide',           years_experience: 5,                                                       fee: 900,  verification_status: 'verified', availability_status: 'online'  },
  { full_name: 'Rina Khatun',                                       role: 'helper', specialty: 'Nursing aide',           years_experience: 3,                                                       fee: 800,  verification_status: 'verified', availability_status: 'online'  },
];

// _id values match the filenames already in backend/uploads/ so the existing
// jpgs render via the /uploads/<id>.jpg static route (see server.js).
const seedDocs = [
  {
    _id: new mongoose.Types.ObjectId('6a0ec2e1e86225a7f36ba9a9'),
    title: 'Post-surgery care',
    price: 2400,
    description: 'At-home wound dressing, vitals monitoring and recovery support.',
    category: 'Recovery',
    duration: '2 hr',
    imageUrl: '6a0ec2e1e86225a7f36ba9a9.jpg',
    status: 'active',
  },
  {
    _id: new mongoose.Types.ObjectId('6a0ec337e86225a7f36ba9ad'),
    title: 'Home physiotherapy',
    price: 1800,
    description: 'Certified physiotherapist visits for mobility and pain management.',
    category: 'Rehabilitation',
    duration: '1 hr',
    imageUrl: '6a0ec337e86225a7f36ba9ad.jpg',
    status: 'active',
  },
  {
    title: 'Doctor home visit',
    price: 1500,
    description: 'General consultation by a licensed doctor at your home.',
    category: 'Consultation',
    duration: '45 min',
    imageUrl: null,
    status: 'active',
  },
  {
    title: 'Nurse on call',
    price: 900,
    description: 'Trained nurse for IV, injections and short-term observation.',
    category: 'Nursing',
    duration: '1 hr',
    imageUrl: null,
    status: 'active',
  },
  {
    title: 'Lab sample collection',
    price: 500,
    description: 'Phlebotomist collects blood / urine samples at your doorstep.',
    category: 'Diagnostics',
    duration: '20 min',
    imageUrl: null,
    status: 'active',
  },
];

// Promo banners for the patient Home slider — mirror the previously
// hardcoded slides so the carousel isn't empty on a fresh DB. Upserted by
// title, so re-running the seed is idempotent.
const seedBanners = [
  {
    tagText: 'FIRST VISIT OFFER',
    title: '৳500 off wound-care\ndressing',
    buttonText: 'Claim offer',
    gradientColors: ['#7C2D12', '#EA580C'],
    priorityOrder: 0,
    isActive: true,
  },
  {
    tagText: 'VERIFIED TEAM',
    title: 'MBBS doctors +\ncertified aides',
    buttonText: 'Meet providers',
    gradientColors: ['#4C1D95', '#8B5CF6'],
    priorityOrder: 1,
    isActive: true,
  },
  {
    tagText: '24/7 SUPPORT',
    title: 'Care team on call,\nanytime',
    buttonText: 'Get help',
    gradientColors: ['#0F766E', '#2DD4BF'],
    priorityOrder: 2,
    isActive: true,
  },
];

// Dynamic home sections — two demo sections so the SDUI blocks below
// Banners + Care Services aren't empty on a fresh DB. Item imageUrls are
// bare filenames from backend/uploads/ (the router's decorate() builds the
// absolute URL). `service:<id>` routes point at the fixed-_id seeded
// services above. Upserted by sectionKey, so re-running stays idempotent.
const seedSections = [
  {
    sectionKey: 'trending_doctors',
    titleEn: 'Specialist consultations',
    titleBn: 'বিশেষজ্ঞ পরামর্শ',
    uiTemplate: 'HORIZONTAL_ROUND_AVATAR',
    orderIndex: 0,
    isActive: true,
    contentData: [
      {
        itemId: 'seed_doc_1',
        title: 'Dr. Nafisa Rahman',
        subtitle: 'General Surgery',
        imageUrl: '6a53f26c62c434caaa679968.jpg',
        navigationRoute: 'new_request',
        routeArguments: {},
      },
      {
        itemId: 'seed_doc_2',
        title: 'Dr. Kamrul Hasan',
        subtitle: 'Orthopedics',
        imageUrl: '6a53f26c62c434caaa679969.jpg',
        navigationRoute: 'new_request',
        routeArguments: {},
      },
      {
        itemId: 'seed_doc_3',
        title: 'Dr. Anika Chowdhury',
        subtitle: 'Internal Medicine',
        imageUrl: '6a53f26c62c434caaa67996a.jpg',
        navigationRoute: 'new_request',
        routeArguments: {},
      },
    ],
  },
  {
    sectionKey: 'health_packages',
    titleEn: 'Health packages',
    titleBn: 'স্বাস্থ্য প্যাকেজ',
    uiTemplate: 'HORIZONTAL_PRODUCT_CARD',
    orderIndex: 1,
    isActive: true,
    contentData: [
      {
        itemId: 'seed_pkg_1',
        title: 'Post-surgery care',
        subtitle: 'Wound dressing & vitals',
        imageUrl: '6a0ec2e1e86225a7f36ba9a9.jpg',
        priceTag: '৳2400',
        navigationRoute: 'service:6a0ec2e1e86225a7f36ba9a9',
        routeArguments: {},
      },
      {
        itemId: 'seed_pkg_2',
        title: 'Home physiotherapy',
        subtitle: 'Mobility & pain relief',
        imageUrl: '6a0ec337e86225a7f36ba9ad.jpg',
        priceTag: '৳1800',
        navigationRoute: 'service:6a0ec337e86225a7f36ba9ad',
        routeArguments: {},
      },
    ],
  },
];

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log(`[seed] connected to ${MONGO_URI}`);

  let inserted = 0;
  let skipped = 0;

  for (const doc of seedDocs) {
    if (doc._id) {
      const res = await Service.updateOne(
        { _id: doc._id },
        { $setOnInsert: doc },
        { upsert: true }
      );
      if (res.upsertedCount) inserted++;
      else skipped++;
    } else {
      const exists = await Service.findOne({ title: doc.title });
      if (exists) {
        skipped++;
      } else {
        await Service.create(doc);
        inserted++;
      }
    }
  }

  console.log(`[seed] services: inserted=${inserted} skipped=${skipped} total=${seedDocs.length}`);

  // Promo banners — upsert by title so re-running stays idempotent.
  let banners = 0;
  for (const b of seedBanners) {
    const res = await PromoBanner.updateOne(
      { title: b.title },
      { $setOnInsert: b },
      { upsert: true }
    );
    if (res.upsertedCount) banners++;
  }
  console.log(`[seed] banners: inserted=${banners} total=${seedBanners.length}`);

  // Dynamic home sections — upsert by sectionKey so re-running stays
  // idempotent.
  let sections = 0;
  for (const s of seedSections) {
    const res = await DynamicSection.updateOne(
      { sectionKey: s.sectionKey },
      { $setOnInsert: s },
      { upsert: true }
    );
    if (res.upsertedCount) sections++;
  }
  console.log(`[seed] home sections: inserted=${sections} total=${seedSections.length}`);

  // Accounts — upsert by email so re-running the seed is idempotent.
  // Seeded accounts are pre-verified so demo logins skip the OTP gate
  // that real user-role registrations now go through.
  let acc = 0;
  for (const a of seedAccounts) {
    const res = await Account.updateOne(
      { email: a.email },
      {
        $setOnInsert: {
          ...a,
          password_hash: sha256('password'),
          status: 'active',
          is_verified: true,
        },
      },
      { upsert: true }
    );
    if (res.upsertedCount) acc++;
  }
  // For any account that already existed before this field shipped, flip
  // is_verified true in-place so the demos keep working without a
  // wipe-and-reseed.
  await Account.updateMany(
    { email: { $in: seedAccounts.map((a) => a.email) }, is_verified: { $ne: true } },
    { $set: { is_verified: true } }
  );
  console.log(`[seed] accounts: inserted=${acc} total=${seedAccounts.length}`);

  // Providers — upsert by full_name + role.
  let prov = 0;
  for (const p of seedProviders) {
    const res = await Provider.updateOne(
      { full_name: p.full_name, role: p.role },
      { $setOnInsert: p },
      { upsert: true }
    );
    if (res.upsertedCount) prov++;
  }
  console.log(`[seed] providers: inserted=${prov} total=${seedProviders.length}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
