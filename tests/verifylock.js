// ---------------------------------------------------------------------------
// THE VERIFICATION LOCK
//
// Two states, one flag. While a collected payment is UNVERIFIED the office can
// still correct what it wrote down. The moment somebody has counted the cash
// box against it and signed it off, the row is sealed: no edit, no void, from
// any screen and through any module.
//
// What makes this worth its own suite is the SPREAD. The seal is not a rule
// inside the fee module — it has to hold for an other-fee receipt, a stock
// bill and an ID card too, each of which reaches the ledger down a different
// path. A test that only voided a fee receipt would pass while three doors
// stood open.
//
// So the shape here is: prove the correction works and moves no money, then
// seal the row and try every door.
//
// Its own database, for the reason dues.js and voidfee.js have one.
// ---------------------------------------------------------------------------

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/sps_verifylock?directConnection=true';
process.env.ACCESS_TOKEN_SECRET = 'a'.repeat(48);
process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(48);
process.env.FRONTEND_URL = 'http://localhost:5173';

const mongoose = require('mongoose');
const connectDB = require('../server/src/config/db');
const User = require('../server/src/models/user.model');
const Student = require('../server/src/models/student.model');
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
const expenseService = require('../server/src/services/expense.service');
const paymentService = require('../server/src/services/payment.service');
const ledger = require('../server/src/services/ledger.service');
const { DEFAULT_GRANTS, PERMISSION_KEYS } = require('../server/src/utils/permissions');
const { monthKeyIST } = require('../server/src/utils/istDate');
const { sessionCache, permissionCache } = require('../server/src/utils/ttlCache');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`)); };
const section = (t) => console.log(`\n== ${t}`);
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const NOW = monthKeyIST();
const txnOf = (id) => Transaction.findById(id).lean();
const feeOf = async (id) => (await Student.findById(id).select('feeOutstanding').lean()).feeOutstanding;
const school = () => MonthlyRollup.findOne({ session: '2026-27', month: NOW, scope: 'SCHOOL', class: null }).lean();

// The receipt a stock bill wrote — the one row with no receipt number, the same
// filter voidSale uses.
const billTxn = (saleId) =>
    Transaction.findOne({ refModel: 'StockSale', refId: saleId, receiptNo: null }).sort({ createdAt: 1 }).lean();

(async () => {
  await connectDB();
  await mongoose.connection.dropDatabase();
  sessionCache.clear(); permissionCache.clear();

  section('Setup');
  await permissionService.seedDefaults();
  const admin = await User.create({ name: 'Admin', username: 'admin', role: 'Admin', password: 'test1234' });
  const actor = { id: admin._id, name: 'Admin', role: 'Admin' };
  const sess = await sessionService.create({
    name: '2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), idCardFee: 150,
  });
  await sessionService.activate(sess._id);
  sessionCache.clear();

  const cls = await classService.create({ name: 'Class 5', section: 'A', order: 5, monthlyFee: 1000 });
  const mk = (name, phone) => studentService.create(
    { name, class: cls._id, phone, admissionDate: new Date('2026-04-05') }, actor.id);

  const aarav = await mk('Aarav Sharma', '9876543210');
  const bhavna = await mk('Bhavna Rao', '9876543211');
  for (const m of ['2026-04', '2026-05', '2026-06', '2026-07']) await feeService.generateMonth({ month: m }, actor.id);
  ok('Two students, four months raised', (await feeOf(aarav._id)) === 4000, `₹${await feeOf(aarav._id)}`);

  // -------------------------------------------------------------------------
  section('The permission is its own key, and the counter holds it');
  ok('payment.edit is a real key', PERMISSION_KEYS.has('payment.edit'));
  ok('The Accountant can correct', DEFAULT_GRANTS.Accountant.includes('payment.edit'));
  ok('The Principal can correct', DEFAULT_GRANTS.Principal.includes('payment.edit'));
  ok('...but the Accountant cannot sign money off — that is the whole separation',
     !DEFAULT_GRANTS.Accountant.includes('payment.verify'));
  ok('A read-only role holds neither', !DEFAULT_GRANTS.Watcher.includes('payment.edit'));

  // -------------------------------------------------------------------------
  section('An unverified receipt can be corrected');
  const r1 = await feeService.collect({ studentId: String(aarav._id), amount: 1000, mode: 'Cash' }, actor);
  const dueBefore = await feeOf(aarav._id);
  const rollupBefore = await school();

  const edited = await paymentService.update(String(r1.transactionId), { mode: 'UPI', note: 'UPI ref 4471' }, actor);
  ok('The mode is corrected', edited.payment.mode === 'UPI', `Cash -> ${edited.payment.mode}`);
  ok('The reference is written', edited.payment.note === 'UPI ref 4471');
  ok('`before` comes back for the history', edited.before.mode === 'Cash');

  const t1 = await txnOf(r1.transactionId);
  ok('The amount is untouched', t1.amount === 1000, `₹${t1.amount}`);
  ok('The receipt number is untouched', t1.receiptNo === r1.receiptNo, t1.receiptNo);
  ok('The month is untouched', t1.month === NOW, t1.month);
  ok('The student owes exactly what they did', (await feeOf(aarav._id)) === dueBefore, `₹${dueBefore}`);

  const rollupAfter = await school();
  ok('No rupee moved in the rollup — a correction is not a collection',
     rollupAfter.feeCollected === rollupBefore.feeCollected && rollupAfter.cashIn === rollupBefore.cashIn,
     `collected ₹${rollupAfter.feeCollected}`);

  // -------------------------------------------------------------------------
  section('What a correction refuses');
  const e1 = await throws(() => paymentService.update(String(r1.transactionId), {}, actor));
  ok('An empty change is told so', e1?.statusCode === 400, e1?.message);

  const cat = await expenseService.createCategory({ name: 'Repairs' }, actor.id);
  const exp = await expenseService.create(
    { categoryId: String(cat._id), title: 'Fan repair', amount: 300, mode: 'Cash' }, actor.id);
  const expTxn = await Transaction.findOne({ refModel: 'Expense', refId: exp._id }).lean();
  const e2 = await throws(() => paymentService.update(String(expTxn._id), { mode: 'UPI' }, actor));
  ok('An expense is not a counter slip', e2?.code === 'NOT_VERIFIABLE', e2?.message);

  // -------------------------------------------------------------------------
  section('Verifying seals the row');
  const { changed } = await paymentService.setVerified(String(r1.transactionId), true, actor);
  ok('It ticks', changed && (await txnOf(r1.transactionId)).verified === true);

  const e3 = await throws(() => paymentService.update(String(r1.transactionId), { mode: 'Cash' }, actor));
  ok('It can no longer be corrected', e3?.code === 'PAYMENT_VERIFIED' && e3.statusCode === 409, e3?.message);
  ok('...and the mode really did not move', (await txnOf(r1.transactionId)).mode === 'UPI');

  const e4 = await throws(() => feeService.voidReceipt(String(r1.transactionId), 'changed my mind', actor));
  ok('It can no longer be voided', e4?.code === 'PAYMENT_VERIFIED', e4?.message);
  ok('...and nothing was half-done', !(await txnOf(r1.transactionId)).voided);
  ok('...the student still owes the same', (await feeOf(aarav._id)) === dueBefore, `₹${await feeOf(aarav._id)}`);
  ok('...and no stray reversal was written', (await Transaction.countDocuments({ type: 'REVERSAL' })) === 0);

  // -------------------------------------------------------------------------
  section('The way out is the tick itself, and it is recorded');
  await paymentService.setVerified(String(r1.transactionId), false, actor);
  const reopened = await paymentService.update(String(r1.transactionId), { mode: 'Cash' }, actor);
  ok('Unticked, it is correctable again', reopened.payment.mode === 'Cash');

  const undone = await feeService.voidReceipt(String(r1.transactionId), 'cheque bounced', actor);
  ok('...and voidable again', Boolean(undone.reversalId) && (await txnOf(r1.transactionId)).voided);
  ok('The money went back on the student', (await feeOf(aarav._id)) === dueBefore + 1000, `₹${await feeOf(aarav._id)}`);

  const e5 = await throws(() => paymentService.update(String(r1.transactionId), { mode: 'UPI' }, actor));
  ok('A voided row is not corrected, it is replaced', e5?.code === 'NOT_VERIFIABLE', e5?.message);

  // -------------------------------------------------------------------------
  section('The seal holds on an other-fee receipt');
  const head = await chargeService.createHead({ name: 'Exam Fee', defaultAmount: 500 }, actor.id);
  await chargeService.raise({ headId: head._id, title: 'Term 1', amount: 500, scope: 'CLASS', classIds: [cls._id] }, actor.id);
  const cr = await chargeService.collect({ studentId: String(bhavna._id), amount: 500, mode: 'Cash' }, actor);

  await paymentService.setVerified(String(cr.transactionId), true, actor);
  const e6 = await throws(() => chargeService.voidReceipt(String(cr.transactionId), 'wrong student', actor));
  ok('An exam-fee receipt is sealed too', e6?.code === 'PAYMENT_VERIFIED', e6?.message);
  ok('...its demand was not unwound',
     (await Student.findById(bhavna._id).select('chargeOutstanding').lean()).chargeOutstanding === 0);

  // -------------------------------------------------------------------------
  section('The seal holds on a stock bill');
  const shirt = await stockService.createItem(
    { name: 'Uniform Shirt', category: 'Uniform', sellPrice: 500, costPrice: 300, currentStock: 100 }, actor.id);
  const sale = await saleService.create(
    { studentId: String(bhavna._id), lines: [{ item: String(shirt._id), qty: 2 }], paidAmount: 1000, mode: 'Cash' },
    actor.id
  );
  const saleTxn = await billTxn(sale._id);
  await paymentService.setVerified(String(saleTxn._id), true, actor);

  const e7 = await throws(() => saleService.voidSale(String(sale._id), 'wrong size', actor));
  ok('The bill cannot be voided', e7?.code === 'PAYMENT_VERIFIED', e7?.message);
  ok('...the bill is still live', !(await StockSale.findById(sale._id).lean()).voided);
  ok('...and the stock did NOT come back on the shelf — the guard runs before the work',
     (await stockService.getById(shirt._id)).currentStock === 98,
     `${(await stockService.getById(shirt._id)).currentStock} in stock`);

  // -------------------------------------------------------------------------
  section('The seal holds on an ID card');
  const card = await studentService.issueIdCard(String(aarav._id), { mode: 'Cash' }, actor);
  await paymentService.setVerified(String(card.transactionId), true, actor);

  const e8 = await throws(() => studentService.cancelIdCard(String(aarav._id), 'wrong photo', actor));
  ok('The card cannot be cancelled', e8?.code === 'PAYMENT_VERIFIED', e8?.message);
  ok('...the student still holds a card', (await Student.findById(aarav._id).lean()).idCard.issued === true);

  // A free card has no transaction at all, so there is nothing to seal. It must
  // still be undoable — a null must not be treated as verified.
  const free = await studentService.issueIdCard(String(bhavna._id), { amount: 0, note: 'staff child' }, actor);
  ok('A free card writes no transaction', !free.transactionId);
  await studentService.cancelIdCard(String(bhavna._id), 'left the school', actor);
  ok('...and can still be undone', (await Student.findById(bhavna._id).lean()).idCard.issued === false);

  // -------------------------------------------------------------------------
  section('The backstop — the ledger itself refuses, whatever calls it');
  const sealed = await txnOf(card.transactionId);
  const e9 = await throws(() => ledger.reverse({ original: sealed, reason: 'x', actorId: actor.id }));
  ok('A void path added tomorrow is covered without knowing about it',
     e9?.code === 'PAYMENT_VERIFIED', e9?.message);
  ok('assertUnsealed lets an unverified row through', !(await throws(async () => ledger.assertUnsealed(await txnOf(expTxn._id)))));
  ok('...and a missing row too — nothing to seal', !(await throws(async () => ledger.assertUnsealed(null))));

  // -------------------------------------------------------------------------
  section('And the books still add up');
  const demands = await require('../server/src/models/feeDemand.model')
    .find({ student: aarav._id }).lean();
  const derived = demands.reduce((s, d) => s + Math.max(0, d.amount - d.discount - d.paidAmount), 0);
  ok('No drift on the student whose receipt was corrected, sealed and finally voided',
     derived === (await feeOf(aarav._id)), `derived ₹${derived} vs stored ₹${await feeOf(aarav._id)}`);

  console.log('\n' + '='.repeat(50));
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH:', e.message, '\n', e); process.exit(1); });
