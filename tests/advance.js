// ---------------------------------------------------------------------------
// PAYING AHEAD — two months at a time, or the whole session in one go
//
// A parent who settles the year in September has bought six months that have
// not been raised. There is nowhere to put that money: the demands do not
// exist yet. So it is held on the student and each month's generation settles
// the new bill out of it.
//
// Three things could go wrong quietly, and this suite is built around them:
//
//   1. Double counting. The money reaches the day book the day it arrives. If
//      applying it to October ALSO moved the rollup, the same rupee would be
//      collected twice and only the year-end total would ever show it.
//
//   2. A balance that cannot be rebuilt. Credit is not derivable from the
//      demands the way an outstanding is, so recomputeBalances rebuilds it
//      from receipts, spent credit and refunds. Those three have to agree with
//      the stored figure after every operation, including voids.
//
//   3. A typo becoming a five-figure credit. The old "never more than is
//      outstanding" rule was also catching mistyped amounts; taking it away
//      needs a real ceiling in its place.
//
// Its own database, for the reason dues.js and voidfee.js have one.
// ---------------------------------------------------------------------------

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/sps_advance?directConnection=true';
process.env.ACCESS_TOKEN_SECRET = 'a'.repeat(48);
process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(48);
process.env.FRONTEND_URL = 'http://localhost:5173';

const mongoose = require('mongoose');
const connectDB = require('../server/src/config/db');
const User = require('../server/src/models/user.model');
const Student = require('../server/src/models/student.model');
const FeeDemand = require('../server/src/models/feeDemand.model');
const Transaction = require('../server/src/models/transaction.model');
const MonthlyRollup = require('../server/src/models/monthlyRollup.model');
const permissionService = require('../server/src/services/permission.service');
const sessionService = require('../server/src/services/session.service');
const classService = require('../server/src/services/class.service');
const studentService = require('../server/src/services/student.service');
const feeService = require('../server/src/services/fee.service');
const paymentService = require('../server/src/services/payment.service');
const { ROLLUP_MAP } = require('../server/src/services/ledger.service');
const { DEFAULT_GRANTS, PERMISSION_KEYS } = require('../server/src/utils/permissions');
const { monthKeyIST } = require('../server/src/utils/istDate');
const { sessionCache, permissionCache } = require('../server/src/utils/ttlCache');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`)); };
const section = (t) => console.log(`\n== ${t}`);
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const NOW = monthKeyIST();
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const bal = async (id) => {
  const s = await Student.findById(id).select('feeOutstanding creditBalance').lean();
  return { due: s.feeOutstanding, credit: s.creditBalance };
};
const sheet = async (studentId) => {
  const rows = await FeeDemand.find({ student: studentId }).sort({ month: 1 }).lean();
  return Object.fromEntries(rows.map((d) => [d.month, { paid: d.paidAmount, fromCredit: d.paidFromCredit, status: d.status }]));
};
// Zeros rather than null before the first entry of the month exists, so a
// before/after comparison reads the same on the first day as on the twentieth.
const school = async () =>
  (await MonthlyRollup.findOne({ session: '2026-27', month: NOW, scope: 'SCHOOL', class: null }).lean())
  || { feeCollected: 0, feeExpected: 0, cashIn: 0, cashOut: 0 };

// What the demands say is owed — the stored feeOutstanding must equal it.
const derivedDue = async (studentId) => {
  const rows = await FeeDemand.find({ student: studentId }).lean();
  return round2(rows.reduce((s, d) => s + Math.max(0, d.amount - d.discount - d.paidAmount), 0));
};

// Exactly how recomputeBalances rebuilds a credit balance: fee money no month
// claimed, less what later months ate, less what was handed back.
const derivedCredit = async (studentId) => {
  const [paidAhead, usedAhead, givenBack] = await Promise.all([
    Transaction.aggregate([
      { $match: { type: 'FEE', voided: { $ne: true }, 'party.ref': studentId, advance: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$advance' } } },
    ]),
    FeeDemand.aggregate([
      { $match: { student: studentId, paidFromCredit: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$paidFromCredit' } } },
    ]),
    Transaction.aggregate([
      { $match: { type: 'FEE_REFUND', voided: { $ne: true }, 'party.ref': studentId } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);
  return round2((paidAhead[0]?.total || 0) - (usedAhead[0]?.total || 0) - (givenBack[0]?.total || 0));
};

const noDrift = async (label, id) => {
  const stored = await bal(id);
  ok(`${label} — no drift on either balance`,
     stored.due === (await derivedDue(id)) && stored.credit === (await derivedCredit(id)),
     `due ${stored.due}/${await derivedDue(id)}, credit ${stored.credit}/${await derivedCredit(id)}`);
};

(async () => {
  await connectDB();
  await mongoose.connection.dropDatabase();
  sessionCache.clear(); permissionCache.clear();

  section('Setup — a full twelve-month session');
  await permissionService.seedDefaults();
  const admin = await User.create({ name: 'Admin', username: 'admin', role: 'Admin', password: 'test1234' });
  const actor = { id: admin._id, name: 'Admin', role: 'Admin' };
  const sess = await sessionService.create({
    name: '2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'),
  });
  await sessionService.activate(sess._id);
  sessionCache.clear();
  // Deliberately created WITHOUT a declared fee-month list, so the ceiling has
  // to fall back on the session's own span — the state a school that never
  // opened Settings is actually in.
  ok('No fee months were declared', !(await sessionService.getActiveSession()).feeMonths.length);

  const cls = await classService.create({ name: 'Class 5', section: 'A', order: 5, monthlyFee: 1000 });
  const stu = await studentService.create(
    { name: 'Aarav Sharma', class: cls._id, phone: '9876543210', admissionDate: new Date('2026-04-05') }, actor.id);
  // Billed alongside the first all the way through, and never paid, so by the
  // end of this file they are the case the office actually hits: every month of
  // the session raised, money still owed, and a parent rounding up.
  const over = await studentService.create(
    { name: 'Chetan Patel', class: cls._id, phone: '9876543212', admissionDate: new Date('2026-04-05') }, actor.id);

  // The third slot in a rollup mapping. scripts/recomputeBalances.js rebuilds
  // every rollup from the ledger and reads this same entry — it once read only
  // the first two and rebuilt a refund as if it had ADDED to collection, so
  // every school that had handed an advance back showed drift it did not have.
  // Both sides depend on this, so it is pinned here.
  ok('A refund takes its head DOWN while its cash goes out',
     ROLLUP_MAP.FEE_REFUND[0] === 'feeCollected' && ROLLUP_MAP.FEE_REFUND[1] === 'cashOut'
     && ROLLUP_MAP.FEE_REFUND[2] === -1);

  ok('The refund is its own permission', PERMISSION_KEYS.has('fee.refund'));
  ok('The Principal can return an advance', DEFAULT_GRANTS.Principal.includes('fee.refund'));
  ok('The Accountant cannot — money out is not counter work',
     !DEFAULT_GRANTS.Accountant.includes('fee.refund'));

  await feeService.generateMonth({ month: '2026-04' }, actor.id);
  ok('April raised, ₹1000 owed', (await bal(stu._id)).due === 1000);

  // -------------------------------------------------------------------------
  section('Two months handed over when only one has been raised');
  const before = await school();
  const r1 = await feeService.collect({ studentId: String(stu._id), amount: 2000, mode: 'Cash' }, actor);

  ok('April is settled', r1.covered.length === 1 && r1.covered[0].amount === 1000);
  ok('The other ₹1000 is held as advance', r1.advance === 1000, `₹${r1.advance}`);
  ok('The receipt says what is held', r1.creditAfter === 1000, `₹${r1.creditAfter}`);

  let b = await bal(stu._id);
  ok('Nothing is owed', b.due === 0, `₹${b.due}`);
  ok('₹1000 is being held', b.credit === 1000, `₹${b.credit}`);

  const after = await school();
  ok('The WHOLE ₹2000 reached the day book — the drawer has to tally',
     after.cashIn - before.cashIn === 2000, `+₹${after.cashIn - before.cashIn}`);
  ok('...and the month\'s fee collection', after.feeCollected - before.feeCollected === 2000);
  ok('The ledger row records the advance', (await Transaction.findById(r1.transactionId).lean()).advance === 1000);
  await noDrift('After paying ahead', stu._id);

  // -------------------------------------------------------------------------
  section('Raising May settles it out of what was already paid');
  const mayRoll = await school();
  const gen = await feeService.generateMonth({ month: '2026-05' }, actor.id);

  ok('Generation says what it settled', gen.settledFromAdvance === 1000 && gen.settledFor === 1,
     `₹${gen.settledFromAdvance} for ${gen.settledFor}`);

  let s = await sheet(stu._id);
  ok('May is Paid', s['2026-05'].status === 'Paid' && s['2026-05'].paid === 1000, `${s['2026-05'].status}`);
  ok('...and it says the money came from the advance', s['2026-05'].fromCredit === 1000);

  b = await bal(stu._id);
  ok('Nothing owed, nothing held', b.due === 0 && b.credit === 0, `due ₹${b.due}, credit ₹${b.credit}`);

  const afterMay = await school();
  ok('NOT collected a second time — the rupee was banked in April',
     afterMay.feeCollected === mayRoll.feeCollected && afterMay.cashIn === mayRoll.cashIn,
     `₹${afterMay.feeCollected}`);
  // May's bill lands in MAY's rollup, not this month's — expected is filed by
  // the month being billed, collected by the month the money arrived.
  const mayOwn = await MonthlyRollup.findOne({ session: '2026-27', month: '2026-05', scope: 'SCHOOL', class: null }).lean();
  ok('The month was still billed — both students, at ₹1000 each',
     mayOwn.feeExpected === 2000, `₹${mayOwn?.feeExpected}`);
  await noDrift('After the month settled itself', stu._id);

  // Generation is re-run constantly — it must not settle twice.
  const again = await feeService.generateMonth({ month: '2026-05' }, actor.id);
  ok('Re-running settles nothing a second time', (again.settledFromAdvance || 0) === 0);

  // -------------------------------------------------------------------------
  section('The whole rest of the session in one payment');
  await feeService.generateMonth({ month: '2026-06' }, actor.id);
  const room = await feeService.advanceRoom(await Student.findById(stu._id).lean());
  ok('Nine months are still to be billed — the session span supplied the list',
     room.months === 9, `${room.months} months`);
  ok('The ceiling is one session\'s fee, not the unbilled part of it',
     room.ceiling === 12000 && room.amount === 12000, `ceiling ₹${room.ceiling}, room ₹${room.amount}`);

  const r2 = await feeService.collect({ studentId: String(stu._id), amount: 10000, mode: 'UPI' }, actor);
  ok('June is settled and ₹9000 held', r2.covered[0].amount === 1000 && r2.advance === 9000, `₹${r2.advance}`);
  await noDrift('After clearing the year', stu._id);

  const room2 = await feeService.advanceRoom(await Student.findById(stu._id).lean());
  ok('The headroom is what is left of a session fee', room2.amount === 3000, `₹${room2.amount}`);

  const e1 = await throws(() => feeService.collect({ studentId: String(stu._id), amount: 3001, mode: 'Cash' }, actor));
  ok('A rupee past a whole session fee held is refused', e1?.code === 'ADVANCE_TOO_LARGE', e1?.message);

  const e2 = await throws(() => feeService.collect({ studentId: String(stu._id), amount: 99999, mode: 'Cash' }, actor));
  ok('...and so is a mistyped figure', e2?.code === 'ADVANCE_TOO_LARGE', e2?.message);
  ok('A refusal leaves the balances alone', (await bal(stu._id)).credit === 9000);

  // -------------------------------------------------------------------------
  section('Every remaining month settles itself as it is raised');
  for (const m of ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12',
                   '2027-01', '2027-02', '2027-03']) {
    await feeService.generateMonth({ month: m }, actor.id);
  }
  b = await bal(stu._id);
  ok('The year is paid off and nothing is left held', b.due === 0 && b.credit === 0, `due ₹${b.due}, credit ₹${b.credit}`);

  const all = await sheet(stu._id);
  ok('All twelve months are Paid', Object.values(all).every((m) => m.status === 'Paid'), `${Object.keys(all).length} months`);
  await noDrift('At the end of the session', stu._id);

  // -------------------------------------------------------------------------
  section('Voiding a receipt whose advance has already been spent');
  // r2 held ₹9000; nine months have since eaten all of it.
  const t2 = await Transaction.findById(r2.transactionId).lean();
  const undo = await feeService.voidReceipt(String(t2._id), 'cheque bounced', actor);

  ok('It says how much advance came back', undo.advanceTakenBack === 9000, `₹${undo.advanceTakenBack}`);
  b = await bal(stu._id);
  ok('The whole ₹10000 is owed again', b.due === 10000, `₹${b.due}`);
  ok('Nothing is held any more', b.credit === 0, `₹${b.credit}`);

  s = await sheet(stu._id);
  ok('The newest months gave it back first — March is Unpaid', s['2027-03'].status === 'Unpaid' && s['2027-03'].fromCredit === 0);
  ok('...and April, paid by the FIRST receipt, is untouched', s['2026-04'].status === 'Paid' && s['2026-04'].paid === 1000);
  ok('...and May, settled from the first receipt\'s advance, is untouched',
     s['2026-05'].status === 'Paid' && s['2026-05'].fromCredit === 1000);
  await noDrift('After voiding a spent advance', stu._id);

  // -------------------------------------------------------------------------
  section('Correcting the amount of a receipt that left an advance');
  const r3 = await feeService.collect({ studentId: String(stu._id), amount: 10000, mode: 'Cash' }, actor);
  ok('Ten months settled outright, nothing held', r3.advance === 0 && r3.covered.length === 10, `${r3.covered.length} months`);

  await paymentService.update(String(r3.transactionId), { amount: 4000 }, actor);
  b = await bal(stu._id);
  ok('Six thousand goes back on the student', b.due === 6000, `₹${b.due}`);
  ok('Still nothing held', b.credit === 0);
  await noDrift('After correcting it down', stu._id);

  // -------------------------------------------------------------------------
  section('Rounding up when the WHOLE session is already billed');
  // The case that broke the first version of this ceiling. Every month raised,
  // ₹12,000 still owed, and the parent hands over ₹13,000. The old rule made
  // the room "unbilled months x fee" — zero here — so the payment was refused
  // outright and the extra ₹1,000 went into a drawer, off the books.
  const stillOwes = await bal(over._id);
  ok('Every month is billed and nothing is paid', stillOwes.due === 12000, `₹${stillOwes.due}`);

  const overRoom = await feeService.advanceRoom(await Student.findById(over._id).lean());
  ok('Nothing is left to bill this session', overRoom.months === 0, `${overRoom.months} months`);
  ok('...and there is STILL room to round up', overRoom.amount === 12000, `₹${overRoom.amount}`);

  const r5 = await feeService.collect({ studentId: String(over._id), amount: 13000, mode: 'Cash' }, actor);
  ok('The whole year is settled', r5.covered.length === 12, `${r5.covered.length} months`);
  ok('...and the extra ₹1000 is held rather than refused', r5.advance === 1000, `₹${r5.advance}`);
  ok('The student owes nothing and holds ₹1000',
     (await bal(over._id)).due === 0 && (await bal(over._id)).credit === 1000);
  await noDrift('After rounding up on a fully billed session', over._id);

  // -------------------------------------------------------------------------
  section('Giving an advance back');
  // A different child, admitted now and not yet billed for anything — which is
  // exactly the case where the whole payment is advance.
  const late = await studentService.create(
    { name: 'Bhavna Rao', class: cls._id, phone: '9876543211', admissionDate: new Date('2027-01-10') }, actor.id);

  const r4 = await feeService.collect({ studentId: String(late._id), amount: 2000, mode: 'Cash' }, actor);
  ok('Nothing was owed, so the whole payment is held',
     r4.advance === 2000 && (await bal(late._id)).credit === 2000, `₹${r4.advance}`);
  ok('...and it settled no month', r4.covered.length === 0);

  const beforeRefund = await school();
  const ref = await feeService.refundCredit(String(late._id),
    { amount: 1500, mode: 'Cash', reason: 'leaving the school' }, actor);

  ok('₹500 is still held', ref.creditAfter === 500, `₹${ref.creditAfter}`);
  const refTxn = await Transaction.findById(ref.transactionId).lean();
  ok('It is money OUT, on its own head', refTxn.direction === 'OUT' && refTxn.type === 'FEE_REFUND');

  const afterRefund = await school();
  ok('The month\'s fee collection came DOWN — a returned rupee was never collected',
     beforeRefund.feeCollected - afterRefund.feeCollected === 1500,
     `-₹${beforeRefund.feeCollected - afterRefund.feeCollected}`);
  ok('...and the cash going out went up', afterRefund.cashOut - beforeRefund.cashOut === 1500);
  await noDrift('After the refund', late._id);

  const e3 = await throws(() => feeService.refundCredit(String(late._id),
    { amount: 9999, mode: 'Cash', reason: 'too much' }, actor));
  ok('More than is held is refused, and it says the figure',
     e3?.code === 'NO_CREDIT' && /500/.test(e3.message), e3?.message);

  const e4 = await throws(() => feeService.refundCredit(String(late._id),
    { amount: 100, mode: 'Cash', reason: '' }, actor));
  ok('A refund without a reason is refused', e4?.statusCode === 400, e4?.message);

  // -------------------------------------------------------------------------
  section('A refund is not a counter slip');
  const e5 = await throws(() => paymentService.update(String(ref.transactionId), { amount: 10 }, actor));
  ok('It cannot be corrected on the payments screen', e5?.code === 'NOT_VERIFIABLE', e5?.message);
  ok('...and it never enters the verification queue',
     !Transaction.isVerifiable(await Transaction.findById(ref.transactionId).lean()));

  console.log('\n' + '='.repeat(50));
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH:', e.message, '\n', e); process.exit(1); });
