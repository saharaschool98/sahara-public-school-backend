// ---------------------------------------------------------------------------
// CORRECTING THE AMOUNT ON AN UNVERIFIED PAYMENT
//
// The one place in this app where a ledger row is edited instead of reversed.
// Everything behind the figure has to move with it, and the failure that would
// matter is a total that still adds up while the ATTRIBUTION is wrong — the
// same class of bug voidfee.js exists for. A suite that only checked the
// student's outstanding would pass with every month marked against the wrong
// receipt.
//
// So the assertions here are per month, per charge and per bill, and the
// stored balance is compared against what the demands themselves say on every
// step. The rollup is read back too: a correction that moves a demand but not
// the month's collection figure is a dashboard that quietly lies.
//
// Its own database, for the reason dues.js and voidfee.js have one.
// ---------------------------------------------------------------------------

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/sps_reviseamount?directConnection=true';
process.env.ACCESS_TOKEN_SECRET = 'a'.repeat(48);
process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(48);
process.env.FRONTEND_URL = 'http://localhost:5173';

const mongoose = require('mongoose');
const connectDB = require('../server/src/config/db');
const User = require('../server/src/models/user.model');
const Student = require('../server/src/models/student.model');
const FeeDemand = require('../server/src/models/feeDemand.model');
const ChargeDemand = require('../server/src/models/chargeDemand.model');
const Charge = require('../server/src/models/charge.model');
const StockSale = require('../server/src/models/stockSale.model');
const Transaction = require('../server/src/models/transaction.model');
const MonthlyRollup = require('../server/src/models/monthlyRollup.model');
const permissionService = require('../server/src/services/permission.service');
const sessionService = require('../server/src/services/session.service');
const classService = require('../server/src/services/class.service');
const studentService = require('../server/src/services/student.service');
const stockService = require('../server/src/services/stock.service');
const saleService = require('../server/src/services/sale.service');
const feeService = require('../server/src/services/fee.service');
const chargeService = require('../server/src/services/charge.service');
const paymentService = require('../server/src/services/payment.service');
const ledger = require('../server/src/services/ledger.service');
const { monthKeyIST } = require('../server/src/utils/istDate');
const { sessionCache, permissionCache } = require('../server/src/utils/ttlCache');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`)); };
const section = (t) => console.log(`\n== ${t}`);
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const NOW = monthKeyIST();
const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07'];

// One student's months as { "2026-04": { paid, status } } — so an assertion can
// name the month it is talking about, the way voidfee.js does.
const sheet = async (studentId) => {
  const rows = await FeeDemand.find({ student: studentId }).sort({ month: 1 }).lean();
  return Object.fromEntries(rows.map((d) => [d.month, { paid: d.paidAmount, status: d.status }]));
};
const feeOf = async (id) => (await Student.findById(id).select('feeOutstanding').lean()).feeOutstanding;
const chargeOf = async (id) => (await Student.findById(id).select('chargeOutstanding').lean()).chargeOutstanding;
const stockOf = async (id) => (await Student.findById(id).select('stockOutstanding').lean()).stockOutstanding;

// What the demands themselves say is owed. The stored balance must equal this
// or recomputeBalances would report drift.
const derivedFee = async (studentId) => {
  const rows = await FeeDemand.find({ student: studentId }).lean();
  return rows.reduce((s, d) => s + Math.max(0, d.amount - d.discount - d.paidAmount), 0);
};
const school = () => MonthlyRollup.findOne({ session: '2026-27', month: NOW, scope: 'SCHOOL', class: null }).lean();

const actorOf = (u) => ({ id: u._id, name: u.name, role: u.role });

(async () => {
  await connectDB();
  await mongoose.connection.dropDatabase();
  sessionCache.clear(); permissionCache.clear();

  section('Setup');
  await permissionService.seedDefaults();
  const admin = await User.create({ name: 'Admin', username: 'admin', role: 'Admin', password: 'test1234' });
  const actor = actorOf(admin);
  const sess = await sessionService.create({
    name: '2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), idCardFee: 150,
  });
  await sessionService.activate(sess._id);
  sessionCache.clear();

  const cls = await classService.create({ name: 'Class 5', section: 'A', order: 5, monthlyFee: 1000 });
  const stu = await studentService.create(
    { name: 'Aarav Sharma', class: cls._id, phone: '9876543210', admissionDate: new Date('2026-04-05') }, actor.id);
  const two = await studentService.create(
    { name: 'Bhavna Rao', class: cls._id, phone: '9876543211', admissionDate: new Date('2026-04-05') }, actor.id);

  for (const m of MONTHS) await feeService.generateMonth({ month: m }, actor.id);
  ok('Four months at ₹1000', (await feeOf(stu._id)) === 4000, `₹${await feeOf(stu._id)}`);

  // -------------------------------------------------------------------------
  section('₹500 was typed, ₹2,500 was taken');
  const r1 = await feeService.collect({ studentId: String(stu._id), amount: 500, mode: 'Cash' }, actor);
  ok('It only reaches April', r1.covered.length === 1 && r1.covered[0].month === '2026-04');
  ok('Outstanding ₹3,500', (await feeOf(stu._id)) === 3500, `₹${await feeOf(stu._id)}`);

  const beforeRollup = await school();
  const up = await paymentService.update(String(r1.transactionId), { amount: 2500 }, actor);
  ok('The row now reads ₹2,500', up.payment.amount === 2500, `₹${up.payment.amount}`);
  ok('The receipt number did NOT change', up.payment.receiptNo === r1.receiptNo, up.payment.receiptNo);

  let s = await sheet(stu._id);
  ok('April is fully Paid', s['2026-04'].status === 'Paid' && s['2026-04'].paid === 1000, `${s['2026-04'].status}, ₹${s['2026-04'].paid}`);
  ok('May is fully Paid — it reached a month the receipt never touched',
     s['2026-05'].status === 'Paid' && s['2026-05'].paid === 1000, `${s['2026-05'].status}, ₹${s['2026-05'].paid}`);
  ok('June is Partial at ₹500', s['2026-06'].status === 'Partial' && s['2026-06'].paid === 500, `${s['2026-06'].status}, ₹${s['2026-06'].paid}`);
  ok('July is untouched', s['2026-07'].status === 'Unpaid' && s['2026-07'].paid === 0);
  ok('Outstanding ₹1,500', (await feeOf(stu._id)) === 1500, `₹${await feeOf(stu._id)}`);
  ok('Stored balance matches the demands — no drift',
     (await derivedFee(stu._id)) === (await feeOf(stu._id)),
     `derived ₹${await derivedFee(stu._id)} vs stored ₹${await feeOf(stu._id)}`);

  const afterRollup = await school();
  ok("The month's collection moved by the DIFFERENCE, not the whole figure",
     afterRollup.feeCollected - beforeRollup.feeCollected === 2000, `+₹${afterRollup.feeCollected - beforeRollup.feeCollected}`);
  ok('...and so did cash in', afterRollup.cashIn - beforeRollup.cashIn === 2000);

  const t1 = await Transaction.findById(r1.transactionId).lean();
  ok('The receipt now records all three months it paid',
     t1.covered.map((c) => `${c.month}:${c.amount}`).join(',') === '2026-04:1000,2026-05:1000,2026-06:500',
     t1.covered.map((c) => `${c.month}:${c.amount}`).join(','));
  ok('Still exactly one ledger row — nothing was reversed',
     (await Transaction.countDocuments({ type: 'FEE' })) === 1 && (await Transaction.countDocuments({ type: 'REVERSAL' })) === 0);

  // -------------------------------------------------------------------------
  section('And back down again — the newest months give it back first');
  await paymentService.update(String(r1.transactionId), { amount: 800 }, actor);
  s = await sheet(stu._id);
  ok('April is Partial at ₹800', s['2026-04'].status === 'Partial' && s['2026-04'].paid === 800, `${s['2026-04'].status}, ₹${s['2026-04'].paid}`);
  ok('May went back to Unpaid', s['2026-05'].status === 'Unpaid' && s['2026-05'].paid === 0);
  ok('June went back to Unpaid', s['2026-06'].status === 'Unpaid' && s['2026-06'].paid === 0);
  ok('Outstanding ₹3,200', (await feeOf(stu._id)) === 3200, `₹${await feeOf(stu._id)}`);
  ok('No drift', (await derivedFee(stu._id)) === (await feeOf(stu._id)));

  // -------------------------------------------------------------------------
  section('A corrected receipt is still voidable, and the void is still exact');
  const r2 = await feeService.collect({ studentId: String(stu._id), amount: 1000, mode: 'Cash' }, actor);
  ok('A second receipt takes the rest of April and some of May',
     r2.covered.map((c) => `${c.month}:${c.amount}`).join(',') === '2026-04:200,2026-05:800');

  await feeService.voidReceipt(String(r1.transactionId), 'the first one was wrong', actor);
  s = await sheet(stu._id);
  ok('Voiding the CORRECTED receipt gives back exactly ₹800 off April',
     s['2026-04'].paid === 200 && s['2026-04'].status === 'Partial', `₹${s['2026-04'].paid}, ${s['2026-04'].status}`);
  ok("...and leaves the second receipt's May alone",
     s['2026-05'].paid === 800 && s['2026-05'].status === 'Partial', `₹${s['2026-05'].paid}`);
  ok('No drift after the void', (await derivedFee(stu._id)) === (await feeOf(stu._id)),
     `derived ₹${await derivedFee(stu._id)} vs stored ₹${await feeOf(stu._id)}`);

  // -------------------------------------------------------------------------
  section('What the amount refuses');
  const e1 = await throws(() => paymentService.update(String(r2.transactionId), { amount: 999999 }, actor));
  ok('More than the student owes, and it says the real figure',
     e1?.statusCode === 400 && /₹\d/.test(e1.message), e1?.message);

  const e2 = await throws(() => paymentService.update(String(r2.transactionId), { amount: 0 }, actor));
  ok('Zero is not a payment', e2?.statusCode === 400, e2?.message);

  const e3 = await throws(() => paymentService.update(String(r1.transactionId), { amount: 100 }, actor));
  ok('A voided receipt is replaced, not corrected', e3?.code === 'NOT_VERIFIABLE', e3?.message);

  // Somebody else corrected the same row between the read and the write.
  const stale = { ...(await Transaction.findById(r2.transactionId).lean()), amount: 12345 };
  const e4 = await throws(() => ledger.reviseAmount({ original: stale, amount: 50 }));
  ok('A figure that moved underneath the edit is refused, not overwritten',
     e4?.code === 'STALE_PAYMENT', e4?.message);
  ok('...and the row is untouched', (await Transaction.findById(r2.transactionId).lean()).amount === 1000);

  // -------------------------------------------------------------------------
  section('Verified means verified — the amount is sealed with everything else');
  await paymentService.setVerified(String(r2.transactionId), true, actor);
  const e5 = await throws(() => paymentService.update(String(r2.transactionId), { amount: 600 }, actor));
  ok('The figure cannot be moved', e5?.code === 'PAYMENT_VERIFIED', e5?.message);
  ok('...and it really did not move', (await Transaction.findById(r2.transactionId).lean()).amount === 1000);
  ok('...nor did the months', (await sheet(stu._id))['2026-05'].paid === 800);
  await paymentService.setVerified(String(r2.transactionId), false, actor);

  // -------------------------------------------------------------------------
  section('Mode and amount in one go');
  const both = await paymentService.update(String(r2.transactionId), { amount: 600, mode: 'UPI', note: 'UPI 7741' }, actor);
  ok('Both landed', both.payment.amount === 600 && both.payment.mode === 'UPI' && both.payment.note === 'UPI 7741',
     `₹${both.payment.amount} ${both.payment.mode}`);
  ok('No drift', (await derivedFee(stu._id)) === (await feeOf(stu._id)));

  // -------------------------------------------------------------------------
  section('An other-fee receipt');
  const head = await chargeService.createHead({ name: 'Exam Fee', defaultAmount: 500 }, actor.id);
  const raised = await chargeService.raise(
    { headId: head._id, title: 'Term 1', amount: 500, scope: 'CLASS', classIds: [cls._id] }, actor.id);
  const cr = await chargeService.collect({ studentId: String(two._id), amount: 500, mode: 'Cash' }, actor);
  ok('Exam fee cleared', (await chargeOf(two._id)) === 0);

  await paymentService.update(String(cr.transactionId), { amount: 300 }, actor);
  const cd = await ChargeDemand.findOne({ student: two._id }).lean();
  ok('The demand is Partial at ₹300', cd.paidAmount === 300 && cd.status === 'Partial', `₹${cd.paidAmount}, ${cd.status}`);
  ok('The student owes ₹200 again', (await chargeOf(two._id)) === 200, `₹${await chargeOf(two._id)}`);
  ok("The parent charge's running total followed",
     (await Charge.findById(raised.charge._id).lean()).totalCollected === 300,
     `₹${(await Charge.findById(raised.charge._id).lean()).totalCollected}`);

  const e6 = await throws(() => paymentService.update(String(cr.transactionId), { amount: 9999 }, actor));
  ok('More than the charges come to is refused', e6?.statusCode === 400, e6?.message);

  // -------------------------------------------------------------------------
  section('A stock bill — only the counter payment moves, never the bill');
  const shirt = await stockService.createItem(
    { name: 'Uniform Shirt', category: 'Uniform', sellPrice: 500, costPrice: 300, currentStock: 100 }, actor.id);
  const sale = await saleService.create(
    { studentId: String(two._id), lines: [{ item: String(shirt._id), qty: 2 }], paidAmount: 400, mode: 'Cash' }, actor.id);
  ok('₹600 of the bill is on credit', (await stockOf(two._id)) === 600, `₹${await stockOf(two._id)}`);

  const saleTxn = await Transaction.findOne({ refModel: 'StockSale', refId: sale._id, receiptNo: null }).lean();
  await paymentService.update(String(saleTxn._id), { amount: 900 }, actor);

  const bill = await StockSale.findById(sale._id).lean();
  ok('Paid is ₹900 and due is ₹100', bill.paidAmount === 900 && bill.dueAmount === 100, `paid ₹${bill.paidAmount}, due ₹${bill.dueAmount}`);
  ok('Paid + due still equals the bill', bill.paidAmount + bill.dueAmount === bill.total);
  ok('The bill total is untouched — this corrects a payment, not a sale', bill.total === 1000, `₹${bill.total}`);
  ok('The student now owes ₹100', (await stockOf(two._id)) === 100, `₹${await stockOf(two._id)}`);
  ok('The shelf never moved', (await stockService.getById(shirt._id)).currentStock === 98);

  const e7 = await throws(() => paymentService.update(String(saleTxn._id), { amount: 1500 }, actor));
  ok('More than the bill is refused', e7?.statusCode === 400, e7?.message);

  // -------------------------------------------------------------------------
  section('An ID card — the flag and the ledger move together');
  const card = await studentService.issueIdCard(String(stu._id), { mode: 'Cash' }, actor);
  ok('Issued at the session fee', (await Student.findById(stu._id).lean()).idCard.amount === 150);

  const rollupBeforeCard = await school();
  await paymentService.update(String(card.transactionId), { amount: 200 }, actor);
  ok('The card says ₹200', (await Student.findById(stu._id).lean()).idCard.amount === 200);
  ok('...and so does the ledger row', (await Transaction.findById(card.transactionId).lean()).amount === 200);
  ok('...and the ID card head moved by ₹50',
     (await school()).idCardCollected - rollupBeforeCard.idCardCollected === 50);

  // -------------------------------------------------------------------------
  section('Nothing else in the ledger is editable this way');
  const rev = await Transaction.findOne({ type: 'REVERSAL' }).lean();
  const e8 = await throws(() => paymentService.update(String(rev._id), { amount: 10 }, actor));
  ok('A reversal is not a counter slip', e8?.code === 'NOT_VERIFIABLE', e8?.message);

  console.log('\n' + '='.repeat(50));
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH:', e.message, '\n', e); process.exit(1); });
