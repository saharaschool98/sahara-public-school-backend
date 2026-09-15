// ---------------------------------------------------------------------------
// THE CASH BOOK — what the school actually has in hand.
//
// This suite exists because the cash book is a set of numbers that must ADD UP,
// and every way of getting one of them wrong is silent. The dangerous failures
// are not crashes:
//
//   · a purchase bill counted as spending, so the school looks poorer every
//     month by the size of its credit purchases;
//   · a receipt corrected from Cash to UPI moving the row but not the drawer,
//     so the cash box never reconciles again;
//   · a void taking money off the wrong month, or the wrong drawer;
//   · an opening balance that quietly stops being part of the total.
//
// So almost every assertion here is an IDENTITY rather than a value: the mode
// columns must sum to the totals, the income heads must sum to money in, the
// spend heads to money out, and the last month's closing balance must be the
// same number as "in hand". A cash book whose columns do not add up is worse
// than no cash book, because somebody will trust it.
//
// The last section runs recomputeBalances as a child process — the README's own
// "real proof" — so the rollups these screens read are checked against the
// ledger they were built from.
//
// Its own database, like the other money suites.
// ---------------------------------------------------------------------------

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/sps_cashbook?directConnection=true';
process.env.ACCESS_TOKEN_SECRET = 'a'.repeat(48);
process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(48);
process.env.FRONTEND_URL = 'http://localhost:5173';

const { execFileSync } = require('child_process');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../server/src/config/db');
const User = require('../server/src/models/user.model');
const Transaction = require('../server/src/models/transaction.model');
const MonthlyRollup = require('../server/src/models/monthlyRollup.model');
const permissionService = require('../server/src/services/permission.service');
const sessionService = require('../server/src/services/session.service');
const classService = require('../server/src/services/class.service');
const studentService = require('../server/src/services/student.service');
const feeService = require('../server/src/services/fee.service');
const expenseService = require('../server/src/services/expense.service');
const vendorService = require('../server/src/services/vendor.service');
const purchaseService = require('../server/src/services/purchase.service');
const stockService = require('../server/src/services/stock.service');
const paymentService = require('../server/src/services/payment.service');
const reportService = require('../server/src/services/report.service');
const { monthKeyIST, daysBetweenIST } = require('../server/src/utils/istDate');
const { sessionCache, permissionCache } = require('../server/src/utils/ttlCache');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`)); };
const section = (t) => console.log(`\n== ${t}`);
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const book = () => reportService.cashbook({});
const modeOf = (b, m) => b.byMode.find((x) => x.mode === m);

// Every identity the screen depends on, asserted in one place so each section
// can re-check them after whatever it just did. A cash book is only ever one
// bad write away from not adding up.
const assertAddsUp = async (label) => {
    const b = await book();

    const modeIn = r2(b.byMode.reduce((a, m) => a + m.in, 0) + b.adjustments.in);
    const modeOut = r2(b.byMode.reduce((a, m) => a + m.out, 0) + b.adjustments.out);
    const modeBal = r2(b.byMode.reduce((a, m) => a + m.balance, 0));

    const incomeHeads = r2(b.income.fees + b.income.stock + b.income.idCards + b.income.otherFees + b.income.other);
    const spendHeads = r2(b.spend.expenses + b.spend.salaries + b.spend.vendorPaid + b.spend.refunds);
    const lastClosing = b.months.length ? b.months[b.months.length - 1].closing : b.totals.opening;

    ok(`${label}: the mode columns sum to money in`, modeIn === b.totals.in, `${modeIn} vs ${b.totals.in}`);
    ok(`${label}: the mode columns sum to money out`, modeOut === b.totals.out, `${modeOut} vs ${b.totals.out}`);
    ok(`${label}: the mode balances sum to in hand`, modeBal === b.totals.inHand, `${modeBal} vs ${b.totals.inHand}`);
    ok(`${label}: the income heads sum to money in`, incomeHeads === b.income.total, `${incomeHeads} vs ${b.income.total}`);
    ok(`${label}: the spend heads sum to money out`, spendHeads === b.spend.total, `${spendHeads} vs ${b.spend.total}`);
    ok(`${label}: opening + in − out is in hand`,
        r2(b.totals.opening + b.totals.in - b.totals.out) === b.totals.inHand,
        `${r2(b.totals.opening + b.totals.in - b.totals.out)} vs ${b.totals.inHand}`);
    ok(`${label}: the last month closes on in hand`, lastClosing === b.totals.inHand, `${lastClosing} vs ${b.totals.inHand}`);

    return b;
};

(async () => {
  await connectDB();
  await mongoose.connection.dropDatabase();
  sessionCache.clear(); permissionCache.clear();

  section('Setup — a session does not begin at zero');
  await permissionService.seedDefaults();
  const admin = await User.create({ name: 'Admin', username: 'admin', role: 'Admin', password: 'test1234' });
  const actor = { id: admin._id, name: 'Admin', role: 'Admin' };

  const sess = await sessionService.create({
    name: '2026-27',
    startDate: new Date('2026-04-01'),
    endDate: new Date('2027-03-31'),
    idCardFee: 150,
    openingBalance: { Cash: 5000, Bank: 20000 },
  });
  await sessionService.activate(sess._id);
  sessionCache.clear();

  const opened = await book();
  ok('Opening cash is carried', opened.opening.Cash === 5000);
  ok('Opening bank is carried', opened.opening.Bank === 20000);
  ok('UPI and cheque default to zero', opened.opening.UPI === 0 && opened.opening.Cheque === 0);
  ok('Opening total is the sum of the drawers', opened.opening.total === 25000, `₹${opened.opening.total}`);
  ok('Nothing has moved, so in hand IS the opening', opened.totals.inHand === 25000, `₹${opened.totals.inHand}`);

  const c5 = await classService.create({ name: 'Class 5', section: 'A', order: 5, monthlyFee: 1000 });
  const mk = (name, phone) => studentService.create(
    { name, class: c5._id, phone, admissionDate: new Date('2026-04-05') }, actor.id);
  const aarav = await mk('Aarav Sharma', '9876543210');
  const bhavna = await mk('Bhavna Rao', '9876543211');
  await feeService.generateMonth({ month: monthKeyIST() }, actor.id);

  section('Money in lands in the drawer it came through');
  const rcp1 = await feeService.collect({ studentId: String(aarav._id), amount: 1000, mode: 'Cash' }, actor);
  await feeService.collect({ studentId: String(bhavna._id), amount: 1000, mode: 'UPI' }, actor);

  let b = await book();
  ok('Cash went up by 1000', modeOf(b, 'Cash').in === 1000, `₹${modeOf(b, 'Cash').in}`);
  ok('UPI went up by 1000', modeOf(b, 'UPI').in === 1000, `₹${modeOf(b, 'UPI').in}`);
  ok('Bank did not move', modeOf(b, 'Bank').in === 0);
  ok('Cash in hand is opening + what came in', modeOf(b, 'Cash').balance === 6000, `₹${modeOf(b, 'Cash').balance}`);
  ok('In hand across the school', b.totals.inHand === 27000, `₹${b.totals.inHand}`);
  await assertAddsUp('two receipts');

  section('Every kind of income reaches its own head');
  await studentService.issueIdCard(String(aarav._id), { mode: 'Cash' }, actor);
  b = await book();
  ok('ID cards have their own line', b.income.idCards === 150, `₹${b.income.idCards}`);
  ok('...and it is in the cash drawer', modeOf(b, 'Cash').in === 1150, `₹${modeOf(b, 'Cash').in}`);
  await assertAddsUp('after an ID card');

  section('Money out — an expense leaves the drawer it was paid from');
  const cat = await expenseService.createCategory({ name: 'Stationery' }, actor.id);
  await expenseService.create({ categoryId: String(cat._id), title: 'Chalk & registers', amount: 400, mode: 'Cash' }, actor.id);

  b = await book();
  ok('Expenses have their own line', b.spend.expenses === 400, `₹${b.spend.expenses}`);
  ok('Cash out is 400', modeOf(b, 'Cash').out === 400);
  ok('Cash in hand came down', modeOf(b, 'Cash').balance === 5750, `₹${modeOf(b, 'Cash').balance}`);
  await assertAddsUp('after an expense');

  section('A PURCHASE BILL IS NOT SPENDING — only paying the vendor is');
  const vendor = await vendorService.create({ name: 'Gupta Stationers', phone: '9812345678' }, actor.id);
  const notebook = await stockService.createItem(
    { name: 'Notebook', category: 'Notebook', unit: 'pc', sellPrice: 40, costPrice: 30 }, actor.id);
  const beforeBill = await book();

  // A bill taken entirely on credit: nothing has left the school yet.
  await purchaseService.create({
    vendorId: String(vendor._id), billNo: 'B-1', billDate: new Date(),
    lines: [{ item: String(notebook._id), qty: 100, rate: 30 }], paidAmount: 0,
  }, actor.id);

  b = await book();
  ok('The bill is recorded', b.purchaseBills === 3000, `₹${b.purchaseBills}`);
  ok('...and it changed NOTHING in hand', b.totals.inHand === beforeBill.totals.inHand,
    `₹${b.totals.inHand} — counting the bill as well would subtract the same rupee twice`);
  ok('...and nothing went out', b.totals.out === beforeBill.totals.out);

  // Now actually pay the vendor, by bank.
  await vendorService.pay({ vendorId: String(vendor._id), amount: 3000, mode: 'Bank' }, actor.id);
  b = await book();
  ok('Paying the vendor DOES leave the bank', modeOf(b, 'Bank').out === 3000, `₹${modeOf(b, 'Bank').out}`);
  ok('Vendor payments have their own line', b.spend.vendorPaid === 3000);
  ok('Bank in hand came down', modeOf(b, 'Bank').balance === 17000, `₹${modeOf(b, 'Bank').balance}`);
  await assertAddsUp('after paying a vendor');

  section('Returning an advance — out of the drawer, and off the collection');
  await feeService.collect({ studentId: String(aarav._id), amount: 2000, mode: 'Cash' }, actor);
  const grossBefore = (await book()).income.fees;
  await feeService.refundCredit(String(aarav._id), { amount: 500, mode: 'Cash', reason: 'leaving' }, actor);

  b = await book();
  ok('Refunds have their own line on the way out', b.spend.refunds === 500, `₹${b.spend.refunds}`);
  ok('The gross fee that came in is unchanged', b.income.fees === grossBefore,
    `₹${b.income.fees} — the money did arrive; it left again as its own line`);
  ok('The NET collection is 500 lower', b.netFeeCollection === r2(b.income.fees - 500),
    `net ₹${b.netFeeCollection} vs gross ₹${b.income.fees}`);
  await assertAddsUp('after a refund');

  section('Correcting the DRAWER moves the money, and nothing else');
  const held = (await book()).totals.inHand;
  const beforeCash = modeOf(await book(), 'Cash').in;

  await paymentService.update(String(rcp1.transactionId), { mode: 'UPI' }, actor);

  b = await book();
  ok('It left the cash drawer', modeOf(b, 'Cash').in === r2(beforeCash - 1000), `₹${modeOf(b, 'Cash').in}`);
  ok('...and arrived in UPI', modeOf(b, 'UPI').in === 2000, `₹${modeOf(b, 'UPI').in}`);
  ok('The total in hand did not change', b.totals.inHand === held,
    `₹${b.totals.inHand} — it is the same money, through a different door`);
  ok('The row itself agrees', (await Transaction.findById(rcp1.transactionId).lean()).mode === 'UPI');
  await assertAddsUp('after a mode correction');

  section('Correcting the AMOUNT and the drawer together');
  const rcp3 = await feeService.collect({ studentId: String(bhavna._id), amount: 300, mode: 'Cash' }, actor);
  const cashIn3 = modeOf(await book(), 'Cash').in;
  const upiIn3 = modeOf(await book(), 'UPI').in;

  await paymentService.update(String(rcp3.transactionId), { amount: 700, mode: 'Bank' }, actor);

  b = await book();
  ok('The whole original left Cash', modeOf(b, 'Cash').in === r2(cashIn3 - 300), `₹${modeOf(b, 'Cash').in}`);
  ok('The whole NEW figure entered Bank', modeOf(b, 'Bank').in === 700, `₹${modeOf(b, 'Bank').in}`);
  ok('UPI is untouched', modeOf(b, 'UPI').in === upiIn3);
  await assertAddsUp('after an amount + mode correction');

  section('Voiding takes it back off the drawer it went into');
  const rcp4 = await feeService.collect({ studentId: String(bhavna._id), amount: 250, mode: 'Cheque' }, actor);
  ok('Cheque went up', modeOf(await book(), 'Cheque').in === 250);

  await feeService.voidReceipt(String(rcp4.transactionId), 'entered twice', actor);
  b = await book();
  ok('The cheque column came back to zero', modeOf(b, 'Cheque').in === 0,
    `₹${modeOf(b, 'Cheque').in} — off the bucket it went into, not onto the opposite one`);
  ok('...and so did the cheque balance', modeOf(b, 'Cheque').balance === 0);
  await assertAddsUp('after a void');

  section('A void lands in the RECEIPT\'s month, never the day it was voided');
  // Collected in a month gone by, voided today. The live rollup has always
  // done this correctly; it is the recompute at the end of this file that
  // used to rebuild it against the wrong month.
  const past = '2026-04';
  const backdated = await feeService.collect(
    { studentId: String(bhavna._id), amount: 800, mode: 'Cash', txnDate: new Date('2026-04-10T06:00:00Z') }, actor);

  const pastRow = () => MonthlyRollup.findOne({ session: '2026-27', month: past, scope: 'SCHOOL', class: null }).lean();
  ok('It landed in April', (await pastRow()).inByMode.Cash === 800, `₹${(await pastRow()).inByMode.Cash}`);

  const thisMonthBefore = (await MonthlyRollup.findOne({ session: '2026-27', month: monthKeyIST(), scope: 'SCHOOL', class: null }).lean()).inByMode.Cash;
  await feeService.voidReceipt(String(backdated.transactionId), 'wrong student', actor);

  ok('The void came off APRIL', (await pastRow()).inByMode.Cash === 0, `₹${(await pastRow()).inByMode.Cash}`);
  ok('...and this month was not touched',
    (await MonthlyRollup.findOne({ session: '2026-27', month: monthKeyIST(), scope: 'SCHOOL', class: null }).lean()).inByMode.Cash === thisMonthBefore);
  await assertAddsUp('after a cross-month void');

  section('The mode split stays out of the class rollups');
  const classRow = await MonthlyRollup.findOne({ session: '2026-27', scope: 'CLASS' }).lean();
  ok('A class rollup exists', Boolean(classRow));
  ok('...and carries no drawer of its own',
    !classRow.inByMode || Object.values(classRow.inByMode).every((v) => !v),
    'a class does not have a cash box');

  section('Last year\'s book is still readable');
  const old = await sessionService.create({
    name: '2025-26', startDate: new Date('2025-04-01'), endDate: new Date('2026-03-31'),
    openingBalance: { Cash: 100 },
  });
  const prev = await reportService.cashbook({ session: '2025-26' });
  ok('It opens by name', prev.session === '2025-26');
  ok('...with its own opening balance', prev.totals.inHand === 100, `₹${prev.totals.inHand}`);
  ok('...and is marked inactive', prev.isActive === false);
  const e1 = await throws(() => reportService.cashbook({ session: '2019-20' }));
  ok('An unknown session -> 404', e1 && e1.statusCode === 404, e1 && e1.message);

  section('Correcting the opening balance touches only what was sent');
  const heldBeforeOpening = (await book()).totals.inHand;
  await sessionService.update(String(sess._id), { openingBalance: { Cash: 7000 } });
  sessionCache.clear();
  b = await book();
  ok('Cash moved to 7000', b.opening.Cash === 7000);
  ok('The bank was NOT wiped', b.opening.Bank === 20000,
    `₹${b.opening.Bank} — $set on the object would have replaced the whole thing`);
  ok('In hand moved by exactly the correction', b.totals.inHand === r2(heldBeforeOpening + 2000),
    `₹${heldBeforeOpening} -> ₹${b.totals.inHand}`);
  await assertAddsUp('after an opening correction');

  section('The day book reads a RANGE, not just one day');
  // This database has entries on two far-apart dates — a backdated April
  // receipt and its void, plus everything collected today — which is exactly
  // the shape a range has to handle.
  const todayOnly = await reportService.daybook({});
  ok('No dates at all means today', todayOnly.span === 1,
    'the dashboard\'s "Today" card passes nothing and depends on this');
  ok('...and it breaks nothing down', todayOnly.byDay.length === 0, 'there is only one day in it');
  ok('...but it still totals', typeof todayOnly.totals.net === 'number', `net ₹${todayOnly.totals.net}`);

  const oneEnd = await reportService.daybook({ from: new Date('2026-04-10T06:00:00Z') });
  ok('One end alone means that single day', oneEnd.span === 1);
  ok('...and it finds April\'s entries', oneEnd.rows.length > 0, `${oneEnd.rows.length} rows`);

  const week = await reportService.daybook({
    from: new Date(Date.now() - 6 * 86400000),
    to: new Date(),
  });
  ok('A seven-day range spans seven days', week.span === 7, `span ${week.span}`);
  ok('...and breaks down by day', week.byDay.length > 0, `${week.byDay.length} days with movement`);
  ok('The day subtotals add up to the range total',
    r2(week.byDay.reduce((a, d) => a + d.in, 0)) === week.totals.in
    && r2(week.byDay.reduce((a, d) => a + d.out, 0)) === week.totals.out,
    `${r2(week.byDay.reduce((a, d) => a + d.in, 0))} vs ${week.totals.in}`);
  ok('The mode split still adds up across the range',
    r2(week.byMode.reduce((a, m) => a + m.in, 0)) === week.totals.in,
    'one pass builds both, so they cannot drift apart');
  ok('Only days that moved money appear', week.byDay.every((d) => d.in > 0 || d.out > 0),
    'a row of zeroes is not a reconciliation');

  const e2 = await throws(() => reportService.daybook({ from: new Date(), to: new Date('2026-04-01') }));
  ok('End before start -> 400', e2 && e2.statusCode === 400 && e2.code === 'BAD_RANGE', e2 && e2.message);

  const e3 = await throws(() => reportService.daybook({
    from: new Date('2026-04-01'), to: new Date('2027-03-31'),
  }));
  ok('A whole year -> 400', e3 && e3.statusCode === 400 && e3.code === 'RANGE_TOO_WIDE', e3 && e3.message);
  ok('...and it points at the cash book instead', e3 && e3.message.includes('Cash Book'));

  section('The dashboard reads a PERIOD');
  const asMonth = await reportService.dashboard({});
  ok('No period at all means the month', asMonth.period === 'month',
    'every caller that passed nothing before still gets what it always got');
  ok('...and the month knows what was expected', typeof asMonth.fees.expected === 'number');
  ok('...and gives a collection rate', typeof asMonth.fees.rate === 'number', `${asMonth.fees.rate}%`);

  const asToday = await reportService.dashboard({ period: 'today' });
  ok('Today is its own period', asToday.period === 'today');
  ok('...and refuses to invent an expected figure', asToday.fees.expected === null,
    'a demand is raised per month — there is no "expected today"');
  ok('...so there is no rate either', asToday.fees.rate === null, 'a rate against a made-up target reads as a fact');
  ok('...but the money is real', typeof asToday.fees.collected === 'number', `₹${asToday.fees.collected}`);

  const asWeek = await reportService.dashboard({ period: 'week' });
  ok('A week spans seven days', daysBetweenIST(asWeek.from, asWeek.to) === 6,
    `${daysBetweenIST(asWeek.from, asWeek.to) + 1} days`);
  ok('...and covers at least what today covers', asWeek.fees.collected >= asToday.fees.collected,
    `week ₹${asWeek.fees.collected} vs today ₹${asToday.fees.collected}`);

  // The one that matters. Everything in this database was written today, so a
  // period covering today must total to the same figures the MONTH's rollup
  // holds — two entirely different code paths, one answer. If these ever
  // disagree, the dashboard and the class-wise report are telling a school two
  // different stories about the same rupees.
  ok('Today matches the rollup on fees', asToday.fees.collected === asMonth.fees.collected,
    `range ₹${asToday.fees.collected} vs rollup ₹${asMonth.fees.collected}`);
  ok('...on expenses', asToday.spend.expenses === asMonth.spend.expenses,
    `₹${asToday.spend.expenses} vs ₹${asMonth.spend.expenses}`);
  ok('...on vendor payments', asToday.spend.vendorPaid === asMonth.spend.vendorPaid);
  ok('...on ID cards', asToday.idCards.collected === asMonth.idCards.collected);
  ok('...on purchase bills', asToday.spend.purchases === asMonth.spend.purchases,
    `₹${asToday.spend.purchases} vs ₹${asMonth.spend.purchases} — bills are totalled from the bills either way`);
  ok('...and on cash in and out', asToday.cash.in === asMonth.cash.in && asToday.cash.out === asMonth.cash.out,
    `in ₹${asToday.cash.in}/₹${asMonth.cash.in}, out ₹${asToday.cash.out}/₹${asMonth.cash.out}`);

  ok('A refund is netted off collection the same way in both',
    r2(asMonth.fees.collected) === r2(asToday.fees.collected),
    'FEE_REFUND moves its head against the cash in rollupFieldsFor, and both paths call it');

  // Balances are NOT period-scoped — what is owed is owed whatever is showing.
  ok('Outstanding does not move with the period',
    asToday.outstanding.total === asMonth.outstanding.total && asWeek.outstanding.total === asMonth.outstanding.total,
    `₹${asMonth.outstanding.total} on all three`);
  ok('Neither does the advance held', asToday.advanceHeld === asMonth.advanceHeld);
  ok('Nor what vendors are owed', asToday.vendors.outstanding === asMonth.vendors.outstanding);

  // Two layers, two right answers. Over HTTP the zod enum REFUSES an unknown
  // period with a 400 — a typo in a URL should not quietly show something else.
  // Called directly, the service falls back to the month rather than returning
  // a screen with no numbers on it.
  const asJunk = await reportService.dashboard({ period: 'fortnight' });
  ok('An unknown period falls back to the month in the service', asJunk.period === 'month');

  section('The real proof — the ledger rebuilds these rollups exactly');
  const out = execFileSync('node', [path.join(__dirname, '..', 'scripts', 'recomputeBalances.js')], {
    env: { ...process.env, MONGODB_URI: process.env.MONGODB_URI },
    encoding: 'utf8',
  });
  const clean = out.includes('No drift');
  ok('recomputeBalances reports no drift', clean,
    clean ? 'every mode, head and total matches the ledger' : out.split('\n').filter((l) => l.includes('DRIFT')).slice(0, 6).join(' | '));

  console.log('\n' + '='.repeat(50));
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH:', e.message, '\n', e); process.exit(1); });
