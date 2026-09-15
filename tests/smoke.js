process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/sps_smoke?directConnection=true';
process.env.ACCESS_TOKEN_SECRET = 'a'.repeat(48);
process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(48);
process.env.CLOUDINARY_CLOUD_NAME = 'demo';
process.env.CLOUDINARY_API_KEY = '123';
process.env.CLOUDINARY_API_SECRET = 'secret';
process.env.FRONTEND_URL = 'http://localhost:5173';

const mongoose = require('mongoose');
const connectDB = require('../server/src/config/db');

const User = require('../server/src/models/user.model');
const Student = require('../server/src/models/student.model');
const MonthlyRollup = require('../server/src/models/monthlyRollup.model');
const StockItem = require('../server/src/models/stockItem.model');
const Vendor = require('../server/src/models/vendor.model');
const SchoolClass = require('../server/src/models/schoolClass.model');
const Charge = require('../server/src/models/charge.model');
const ChargeDemand = require('../server/src/models/chargeDemand.model');

const permissionService = require('../server/src/services/permission.service');
const sessionService = require('../server/src/services/session.service');
const classService = require('../server/src/services/class.service');
const studentService = require('../server/src/services/student.service');
const feeService = require('../server/src/services/fee.service');
const stockService = require('../server/src/services/stock.service');
const saleService = require('../server/src/services/sale.service');
const vendorService = require('../server/src/services/vendor.service');
const purchaseService = require('../server/src/services/purchase.service');
const teacherService = require('../server/src/services/teacher.service');
const attendanceService = require('../server/src/services/attendance.service');
const salaryService = require('../server/src/services/salary.service');
const chargeService = require('../server/src/services/charge.service');
const reportService = require('../server/src/services/report.service');
const { sessionCache, permissionCache } = require('../server/src/utils/ttlCache');
const { monthKeyIST, isSundayIST } = require('../server/src/utils/istDate');
const { round2 } = require('../server/src/utils/money');

// Fees are RAISED for August, but the money is RECEIVED today. Those are two
// different rollup months whenever the suite runs outside August, so the
// month is taken from the clock rather than hardcoded — otherwise the suite
// passes all August and starts failing on the 1st of September.
const NOW = monthKeyIST(new Date());

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};
const section = (t) => console.log(`\n== ${t}`);

(async () => {
  await connectDB();
  await mongoose.connection.dropDatabase();
  sessionCache.clear(); permissionCache.clear();

  // ---------- setup ----------
  section('Setup');
  await permissionService.seedDefaults();
  const admin = await User.create({ name: 'Admin', username: 'admin', role: 'Admin', password: 'test1234' });
  const actor = { id: admin._id, name: 'Admin', role: 'Admin' };

  const grants = await permissionService.getGrants('Accountant');
  ok('Accountant grants seeded', grants.size > 0, `${grants.size} keys`);
  ok('Accountant has no salary access', !grants.has('salary.view'));
  ok('Accountant has no fee.discount', !grants.has('fee.discount'));
  ok('Principal has salary.pay', (await permissionService.getGrants('Principal')).has('salary.pay'));

  const sess = await sessionService.create({
    name: '2026-27',
    startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'),
    feeMonths: ['2026-04','2026-05','2026-06','2026-07','2026-08'],
  });
  await sessionService.activate(sess._id);
  ok('Session active', (await sessionService.getActiveSessionName()) === '2026-27');

  const cls = await classService.create({ name: 'Class 5', section: 'A', monthlyFee: 1200 });
  const cls2 = await classService.create({ name: 'Class 6', section: 'B', monthlyFee: 1300 });

  // ---------- students ----------
  section('Students');
  const s1 = await studentService.create({ name: 'Aarav Sharma', phone: '9825041234', class: cls._id, admissionDate: new Date('2026-04-02') }, admin._id);
  const s2 = await studentService.create({ name: 'Diya Patel', phone: '9910477777', class: cls._id, admissionDate: new Date('2026-04-02') }, admin._id);
  const s3 = await studentService.create({ name: 'Rohan Verma', phone: '9873012345', class: cls2._id, admissionDate: new Date('2026-04-02'), monthlyFee: 1000 }, admin._id);

  ok('Admission numbers sequential', s1.admissionNo === 'ADM0001' && s2.admissionNo === 'ADM0002', `${s1.admissionNo}, ${s2.admissionNo}`);
  ok('Class default fee applied', s1.monthlyFee === 1200, `₹${s1.monthlyFee}`);

  // Both parents and a second number — an admission form asks for all of it, and
  // it has to survive the round trip rather than being quietly dropped.
  //
  // Created, checked and REMOVED again: every count from here on (the class
  // roster, the demands raised, the rollup, the attendance percentage) is
  // asserted exactly, so an extra student left lying around fails five later
  // assertions that have nothing to do with parents' names.
  {
    const full = await studentService.create({
      name: 'Full Record',
      guardianName: 'Rajesh Sharma',
      motherName: 'Sunita Sharma',
      phone: '9811100011',
      altPhone: '9811100022',
      address: '12 Station Road',
      class: cls._id,
      admissionDate: new Date('2026-04-01'),
    }, admin._id);

    ok("The mother's name is stored", full.motherName === 'Sunita Sharma', full.motherName);
    ok('The second number is stored', full.altPhone === '9811100022', full.altPhone);
    ok('The father / guardian is stored', full.guardianName === 'Rajesh Sharma');

    const readBack = (await studentService.getLedger(full._id)).student;
    ok('...and all of it comes back on the profile',
       readBack.motherName === 'Sunita Sharma'
       && readBack.altPhone === '9811100022'
       && readBack.guardianName === 'Rajesh Sharma');

    await studentService.update(full._id, { motherName: 'Sunita Devi Sharma' }, admin._id);
    ok("The mother's name is editable",
       (await Student.findById(full._id).select('motherName').lean()).motherName === 'Sunita Devi Sharma');

    await Student.deleteOne({ _id: full._id });
    await SchoolClass.updateOne({ _id: cls._id }, { $inc: { studentCount: -1 } });
  }
  ok('Per-student override applied', s3.monthlyFee === 1000, `₹${s3.monthlyFee}`);
  ok('Class studentCount went up', (await classService.getById(cls._id)).studentCount === 2);

  // ---------- fee generation + IDEMPOTENCY ----------
  section('Fee generation (idempotency)');
  const g1 = await feeService.generateMonth({ month: '2026-08' }, admin._id);
  ok('3 demands raised', g1.created === 3, `₹${g1.totalRaised} raised`);

  const g2 = await feeService.generateMonth({ month: '2026-08' }, admin._id);
  ok('Re-running created 0 (IDEMPOTENT)', g2.created === 0, `skipped ${g2.skipped}`);

  const st1 = await Student.findById(s1._id).lean();
  ok('Student outstanding = fee', st1.feeOutstanding === 1200, `₹${st1.feeOutstanding}`);

  let roll = await MonthlyRollup.findOne({ month: '2026-08', scope: 'SCHOOL' }).lean();
  ok('Rollup feeExpected is correct', roll.feeExpected === 3400, `₹${roll.feeExpected}`);

  // ---------- fee collect ----------
  section('Fee collect');
  const receipt = await feeService.collect({ studentId: s1._id, amount: 700, mode: 'Cash' }, actor);
  ok('Receipt number issued', receipt.receiptNo === 'RCP00001', receipt.receiptNo);
  ok('Balance after is correct', receipt.balanceAfter === 500, `₹${receipt.balanceAfter}`);

  const st1b = await Student.findById(s1._id).lean();
  ok('Outstanding came down', st1b.feeOutstanding === 500, `₹${st1b.feeOutstanding}`);

  roll = await MonthlyRollup.findOne({ month: NOW, scope: 'SCHOOL' }).lean();
  ok('Rollup feeCollected went up', roll.feeCollected === 700, `₹${roll.feeCollected}`);
  ok('Rollup cashIn went up', roll.cashIn === 700);

  const clsRoll = await MonthlyRollup.findOne({ month: NOW, scope: 'CLASS', class: cls._id }).lean();
  ok('Class rollup updated too', clsRoll.feeCollected === 700, `₹${clsRoll.feeCollected}`);

  // Paying ahead is allowed; paying a fantasy figure is not. The ceiling is
  // what the rest of the session actually costs — see fee.service.advanceRoom.
  let overpayBlocked = false;
  try { await feeService.collect({ studentId: s1._id, amount: 99999, mode: 'Cash' }, actor); }
  catch { overpayBlocked = true; }
  ok('Collecting far past the whole session is blocked', overpayBlocked);

  // ---------- discount ----------
  section('Discount');
  const { demands } = await feeService.pendingForStudent(s2._id);
  await feeService.applyDiscount(demands[0]._id, { amount: 200, reason: 'Sibling concession' }, actor);
  const st2 = await Student.findById(s2._id).lean();
  ok('Discount reduced the outstanding', st2.feeOutstanding === 1000, `₹${st2.feeOutstanding}`);
  roll = await MonthlyRollup.findOne({ month: '2026-08', scope: 'SCHOOL' }).lean();
  ok('Discount tracked separately', roll.feeDiscount === 200, `₹${roll.feeDiscount}`);
  const cashRoll = await MonthlyRollup.findOne({ month: NOW, scope: 'SCHOOL' }).lean();
  ok('Discount does not hide inside collections', cashRoll.feeCollected === 700);

  // ---------- void ----------
  section('Void receipt');
  await feeService.voidReceipt(receipt.transactionId, 'Wrong student', actor);
  const st1c = await Student.findById(s1._id).lean();
  ok('Void put the outstanding back', st1c.feeOutstanding === 1200, `₹${st1c.feeOutstanding}`);
  roll = await MonthlyRollup.findOne({ month: NOW, scope: 'SCHOOL' }).lean();
  ok('Rollup came down too', roll.feeCollected === 0, `₹${roll.feeCollected}`);

  // ---------- stock ----------
  section('Stock & sale');
  const shirt = await stockService.createItem({
    name: 'School Shirt', category: 'Uniform', hasVariants: true,
    variants: [
      { label: 'Size 26', sellPrice: 420, costPrice: 310, currentStock: 10, lowStockAt: 5 },
      { label: 'Size 30', sellPrice: 440, costPrice: 320, currentStock: 4, lowStockAt: 5 },
    ],
  }, admin._id);
  const v26 = shirt.variants[0], v30 = shirt.variants[1];

  const sale = await saleService.create({
    studentId: s2._id, lines: [{ item: shirt._id, variantId: v26._id, qty: 2 }],
    paidAmount: 840, mode: 'Cash',
  }, admin._id);
  ok('Sale created', sale.total === 840, `₹${sale.total}`);

  const shirtAfter = await StockItem.findById(shirt._id).lean();
  ok('The right variant lost stock', shirtAfter.variants[0].currentStock === 8, `Size 26: ${shirtAfter.variants[0].currentStock}`);
  ok('The other variant was untouched', shirtAfter.variants[1].currentStock === 4);

  // credit sale
  await saleService.create({ studentId: s2._id, lines: [{ item: shirt._id, variantId: v30._id, qty: 1 }], paidAmount: 0, mode: 'Cash' }, admin._id);
  const st2b = await Student.findById(s2._id).lean();
  ok('Credit went to stockOutstanding', st2b.stockOutstanding === 440, `₹${st2b.stockOutstanding}`);

  let oversell = false;
  try { await saleService.create({ studentId: s2._id, lines: [{ item: shirt._id, variantId: v30._id, qty: 99 }], paidAmount: 0, mode: 'Cash' }, admin._id); }
  catch { oversell = true; }
  ok('Selling more than stock is blocked', oversell);

  const low = await stockService.lowStock();
  ok('Low stock detected', low.some(l => l.variantLabel === 'Size 30'), `${low.length} low`);

  // ---------- vendor & purchase ----------
  section('Vendor & purchase');
  const vend = await vendorService.create({ name: 'Shree Textiles', phone: '9822011111' }, admin._id);
  const pur = await purchaseService.create({
    vendorId: vend._id, billNo: 'ST-2291', billDate: new Date('2026-08-10'),
    lines: [{ item: shirt._id, variantId: v30._id, qty: 20, rate: 320 }],
    paidAmount: 2000, mode: 'Bank',
  }, admin._id);
  ok('Purchase total is correct', pur.total === 6400, `₹${pur.total}`);
  ok('Due is correct', pur.dueAmount === 4400, `₹${pur.dueAmount}`);

  const shirtAfterPur = await StockItem.findById(shirt._id).lean();
  ok('Purchase increased the stock', shirtAfterPur.variants[1].currentStock === 23, `Size 30: ${shirtAfterPur.variants[1].currentStock}`);

  const vendAfter = await Vendor.findById(vend._id).lean();
  ok('Vendor outstanding raised', vendAfter.outstanding === 4400, `₹${vendAfter.outstanding}`);

  let dupBill = false;
  try {
    await purchaseService.create({ vendorId: vend._id, billNo: 'ST-2291', billDate: new Date(), lines: [{ item: shirt._id, variantId: v30._id, qty: 1, rate: 320 }] }, admin._id);
  } catch { dupBill = true; }
  ok('Duplicate bill number blocked', dupBill);

  const payment = await vendorService.pay({ vendorId: vend._id, amount: 3000, mode: 'Bank' }, admin._id);
  ok('Payment allocated to the bill', payment.allocations.length === 1 && payment.allocations[0].billNo === 'ST-2291');
  const vendAfterPay = await Vendor.findById(vend._id).lean();
  ok('Vendor outstanding came down', vendAfterPay.outstanding === 1400, `₹${vendAfterPay.outstanding}`);

  const age = await vendorService.ageing();
  ok('Ageing report built', age.totals.total === 1400, `₹${age.totals.total}`);

  // ---------- teacher, attendance, salary ----------
  section('Attendance & salary');
  const t1 = await teacherService.create({ name: 'Sunita Rao', monthlySalary: 22000, joiningDate: new Date('2021-06-01'), designation: 'PRT' }, admin._id);
  const t2 = await teacherService.create({ name: 'Rajesh Kumar', monthlySalary: 30000, joiningDate: new Date('2019-04-01'), designation: 'TGT' }, admin._id);

  // 20 WORKING days: Sundays are skipped, because a Sunday is a paid weekly
  // off and never counts as a working day. Marking 20 calendar days instead
  // would silently include 3 Sundays and cut the per-day rate.
  // t1 is fully present, t2 has 2 absents + 1 half day.
  let markedDays = 0;
  for (let d = 1; markedDays < 20; d++) {
    const date = new Date(Date.UTC(2026, 7, d, 6, 0, 0));
    if (isSundayIST(date)) continue;
    markedDays++;
    await attendanceService.markTeachers({
      date,
      entries: [
        { teacher: t1._id, status: 'Present' },
        { teacher: t2._id, status: d === 5 || d === 12 ? 'Absent' : d === 8 ? 'HalfDay' : 'Present' },
      ],
    }, admin._id);
  }

  const sheet = await attendanceService.getTeacherSheet(new Date(Date.UTC(2026, 7, 5, 6)));
  ok('Attendance sheet read back', sheet.rows.length === 2 && sheet.rows.find(r => r.name === 'Rajesh Kumar').status === 'Absent');

  const grid = await attendanceService.teacherMonthlyGrid('2026-08');
  const rajesh = grid.rows.find(r => r.name === 'Rajesh Kumar');
  ok('Monthly grid counts are correct', rajesh.present === 17 && rajesh.absent === 2 && rajesh.halfDay === 1,
     `P${rajesh.present} A${rajesh.absent} H${rajesh.halfDay}`);

  const gen = await salaryService.generate({ month: '2026-08' }, admin._id);
  ok('2 slips created', gen.created === 2);

  const gen2 = await salaryService.generate({ month: '2026-08' }, admin._id);
  ok('Salary generation is idempotent too', gen2.created === 0);

  const slips = await salaryService.list({ month: '2026-08' });
  const rSlip = slips.slips.find(s => s.teacherName === 'Rajesh Kumar');
  // August has 31 calendar days, so 30000/31 = ₹967.74 a day.
  // 20 working days were marked: 17 Present + 1 HalfDay (+ 2 Absent).
  // Payable = 17 + 0.5 + 5 Sundays = 22.5 days. The 6 working days nobody
  // marked are NOT paid — that is the rule, and this is what proves it.
  ok('Divisor is the calendar month', rSlip.monthDays === 31, `${rSlip.monthDays} days`);
  ok('Salary calculation is correct', rSlip.earned === 21774.19, `₹${rSlip.earned} (${rSlip.payableDays} days x ₹${rSlip.perDayRate})`);
  ok('Gross salary snapshotted', rSlip.grossSalary === 30000);

  let payBeforeApprove = false;
  try { await salaryService.pay(rSlip._id, { mode: 'Bank' }, admin._id); } catch { payBeforeApprove = true; }
  ok('Paying before approval is blocked', payBeforeApprove);

  await salaryService.approve(rSlip._id, admin._id);
  let editAfterApprove = false;
  try { await salaryService.update(rSlip._id, { advance: 500 }); } catch { editAfterApprove = true; }
  ok('Editing after approval is blocked (FROZEN)', editAfterApprove);

  const paid = await salaryService.pay(rSlip._id, { mode: 'Bank' }, admin._id);
  ok('Salary paid', paid.paid === 21774.19 && paid.remaining === 0, `₹${paid.paid}`);

  // changing salary does not rewrite an old slip
  await teacherService.update(t2._id, { monthlySalary: 35000 });
  const rSlipAfter = await salaryService.getById(rSlip._id);
  ok('A salary revision did not change the paid slip', rSlipAfter.grossSalary === 30000, `₹${rSlipAfter.grossSalary}`);

  // ---------- class attendance ----------
  await attendanceService.markClasses({
    date: new Date(Date.UTC(2026, 7, 20, 6)),
    entries: [{ class: cls._id, present: 2 }, { class: cls2._id, present: 1 }],
  }, admin._id);
  const cSheet = await attendanceService.getClassSheet(new Date(Date.UTC(2026, 7, 20, 6)));
  ok('Class attendance marked', cSheet.totals.present === 3 && cSheet.totals.roll === 3, `${cSheet.totals.percent}%`);

  // A fixed weekday, not new Date() — a Sunday is refused outright now, so
  // "today" would have made this assertion pass for the wrong reason.
  let tooMany = false;
  try {
    await attendanceService.markClasses(
      { date: new Date(Date.UTC(2026, 7, 21, 6)), entries: [{ class: cls._id, present: 99 }] },
      admin._id
    );
  } catch { tooMany = true; }
  ok('Present exceeding roll is blocked', tooMany);

  // ---------- the attendance lock ----------
  //
  // Once a day is saved it is sealed. These four assertions are the whole rule:
  // a second save changes nothing, it is reported rather than thrown, a teacher
  // with no row yet can still be marked, and a Sunday is refused outright.
  section('Attendance is locked once marked');

  const lockDate = new Date(Date.UTC(2026, 7, 20, 6)); // the Thursday marked above

  const relock = await attendanceService.markClasses({
    date: lockDate,
    entries: [{ class: cls._id, present: 1 }],
  }, admin._id);
  ok('Re-marking a class writes nothing', relock.saved === 0 && relock.locked === 1, JSON.stringify(relock.warning));

  const afterRelock = await attendanceService.getClassSheet(lockDate);
  ok('The original figure survived', afterRelock.totals.present === 3, `${afterRelock.totals.present}`);
  ok('The sheet reports itself locked', afterRelock.rows.every((r) => r.locked), `${afterRelock.lockedCount} locked`);

  const tLock = new Date(Date.UTC(2026, 7, 3, 6)); // a Monday, marked in the loop above
  const tRelock = await attendanceService.markTeachers({
    date: tLock,
    entries: [{ teacher: t1._id, status: 'Absent' }],
  }, admin._id);
  ok('Re-marking a teacher writes nothing', tRelock.saved === 0 && tRelock.locked === 1);

  const tSheet = await attendanceService.getTeacherSheet(tLock);
  ok('The teacher keeps the status they were marked with',
     tSheet.rows.find((r) => r.name === 'Sunita Rao').status === 'Present');

  // A teacher who joined after the sheet was saved has no row for that day, so
  // their day can still be marked — the lock is per teacher, not per sheet.
  const t3 = await teacherService.create(
    { name: 'Late Joiner', monthlySalary: 12000, joiningDate: new Date('2026-08-10') },
    admin._id
  );
  const partial = await attendanceService.markTeachers({
    date: tLock,
    entries: [{ teacher: t1._id, status: 'Absent' }, { teacher: t3._id, status: 'Present' }],
  }, admin._id);
  ok('A teacher with no row yet can still be marked', partial.saved === 1 && partial.locked === 1);

  let sundayRefused = false;
  try {
    await attendanceService.markTeachers(
      { date: new Date(Date.UTC(2026, 7, 2, 6)), entries: [{ teacher: t1._id, status: 'Present' }] },
      admin._id
    );
  } catch (e) { sundayRefused = e.code === 'SUNDAY_NOT_MARKED'; }
  ok('A Sunday is refused outright', sundayRefused);

  // ---------- other fees ----------
  //
  // Admission, exams, trips. The assertions that matter are the ones that make
  // it safe: raising is idempotent, the money lands in its own rollup head and
  // not in the fee figure, a void is the exact inverse of its own collection,
  // and a cancel is refused once anybody has paid.
  section('Other fees');

  const examHead = await chargeService.createHead({ name: 'Exam Fee', defaultAmount: 500 }, admin._id);
  ok('A head is created', examHead.name === 'Exam Fee' && examHead.defaultAmount === 500);

  let dupeHead = false;
  try { await chargeService.createHead({ name: 'exam fee' }, admin._id); } catch { dupeHead = true; }
  ok('A duplicate head is refused, case-insensitively', dupeHead);

  const before = await Student.findById(s1._id).select('chargeOutstanding feeOutstanding').lean();

  const raised = await chargeService.raise({
    headId: examHead._id, title: 'Term 1', amount: 500, scope: 'CLASS', classIds: [cls._id],
  }, admin._id);
  ok('Raised on the class', raised.raisedFor === 2 && raised.totalRaised === 1000, `${raised.raisedFor} students`);

  const afterRaise = await Student.findById(s1._id).select('chargeOutstanding feeOutstanding').lean();
  ok('It lands on chargeOutstanding', afterRaise.chargeOutstanding === before.chargeOutstanding + 500,
     `₹${afterRaise.chargeOutstanding}`);
  ok('...and NOT on the monthly fee outstanding', afterRaise.feeOutstanding === before.feeOutstanding);

  // Idempotency, the same guarantee fee generation has.
  const topUpAgain = await chargeService.topUp(raised.charge._id, admin._id);
  ok('Topping up adds nobody who already has it', topUpAgain.added === 0);

  // A student admitted after it went out.
  const late = await studentService.create(
    { name: 'Late Admission', phone: '9844444444', class: cls._id, admissionDate: new Date('2026-09-01') },
    admin._id
  );
  const topUp2 = await chargeService.topUp(raised.charge._id, admin._id);
  ok('Topping up picks up a later admission', topUp2.added === 1, `${topUp2.added} added`);
  ok('Their balance moved too',
     (await Student.findById(late._id).select('chargeOutstanding').lean()).chargeOutstanding === 500);

  // Collecting — its own rollup head, the shared receipt series.
  const rollupBefore = await MonthlyRollup.findOne({ month: NOW, scope: 'SCHOOL', class: null }).lean();

  const rcpt = await chargeService.collect(
    { studentId: s1._id, amount: 500, mode: 'Cash' },
    { id: admin._id, name: 'Admin' }
  );
  ok('A receipt is issued off the shared series', /^RCP\d{5}$/.test(rcpt.receiptNo), rcpt.receiptNo);
  ok('It records what it paid', rcpt.covered.length === 1 && rcpt.covered[0].amount === 500);

  const rollupAfter = await MonthlyRollup.findOne({ month: NOW, scope: 'SCHOOL', class: null }).lean();
  ok('It reaches its OWN rollup head',
     round2((rollupAfter.chargeCollected || 0) - (rollupBefore?.chargeCollected || 0)) === 500,
     `₹${rollupAfter.chargeCollected}`);
  ok('...and not the fee head',
     round2((rollupAfter.feeCollected || 0) - (rollupBefore?.feeCollected || 0)) === 0);
  ok('Cash in moved', round2((rollupAfter.cashIn || 0) - (rollupBefore?.cashIn || 0)) === 500);

  ok('The student no longer owes it',
     (await Student.findById(s1._id).select('chargeOutstanding').lean()).chargeOutstanding
       === before.chargeOutstanding);

  let tooMuch = false;
  try { await chargeService.collect({ studentId: s1._id, amount: 100, mode: 'Cash' }, { id: admin._id }); }
  catch { tooMuch = true; }
  ok('Collecting with nothing outstanding is refused', tooMuch);

  // Cancelling is refused once money has come in — those receipts would be
  // left pointing at nothing.
  let cancelBlocked = false;
  try { await chargeService.cancel(raised.charge._id, 'wrong amount', admin._id); }
  catch (e) { cancelBlocked = e.code === 'ALREADY_COLLECTED'; }
  ok('A charge with money against it cannot be cancelled', cancelBlocked);

  // Voiding: the exact inverse of the collection that wrote it.
  const voided = await chargeService.voidReceipt(rcpt.transactionId, 'cheque bounced', { id: admin._id });
  ok('The receipt is voided', voided.amount === 500 && voided.reversed === 500);
  ok('The money goes back on the student',
     (await Student.findById(s1._id).select('chargeOutstanding').lean()).chargeOutstanding
       === before.chargeOutstanding + 500);

  const rollupVoid = await MonthlyRollup.findOne({ month: NOW, scope: 'SCHOOL', class: null }).lean();
  ok('The rollup came back down too',
     round2((rollupVoid.chargeCollected || 0) - (rollupBefore?.chargeCollected || 0)) === 0,
     `₹${rollupVoid.chargeCollected}`);

  // A waiver is tracked, not hidden.
  const oneDemand = await ChargeDemand.findOne({ charge: raised.charge._id, student: late._id }).lean();
  await chargeService.applyDiscount(oneDemand._id, { amount: 500, reason: 'staff child' }, { id: admin._id });
  const waived = await ChargeDemand.findById(oneDemand._id).lean();
  ok('A waiver clears the demand', waived.status === 'Paid' && waived.discount === 500);
  ok('...and comes off the balance',
     (await Student.findById(late._id).select('chargeOutstanding').lean()).chargeOutstanding === 0);
  ok('...and is counted as a waiver, not a collection',
     (await Charge.findById(raised.charge._id).lean()).totalDiscount === 500);

  // A charge raised by mistake, before anybody paid.
  const oops = await chargeService.raise({
    headId: examHead._id, title: 'Wrong amount', amount: 999, scope: 'SCHOOL',
  }, admin._id);
  const owedBefore = (await Student.findById(late._id).select('chargeOutstanding').lean()).chargeOutstanding;
  ok('The mistake landed', owedBefore === 999);

  const undone = await chargeService.cancel(oops.charge._id, 'wrong amount entered', admin._id);
  ok('Cancelling withdraws every demand', undone.withdrawn === oops.raisedFor, `${undone.withdrawn} withdrawn`);
  ok('...and every balance comes back down',
     (await Student.findById(late._id).select('chargeOutstanding').lean()).chargeOutstanding === 0);
  ok('The charge itself is kept, with a reason',
     (await Charge.findById(oops.charge._id).lean()).cancelReason === 'wrong amount entered');

  // ---------- siblings ----------
  //
  // Siblinghood is an equivalence relation, and these assertions are the whole
  // reason it is stored as a group id instead of a list of links: the third
  // relationship must appear WITHOUT anybody recording it, two families must be
  // able to merge, and a family must never be left with one member in it.
  section('Siblings');

  const sibA = await studentService.create({ name: 'Aarav Gupta', phone: '9811111111', class: cls._id, admissionDate: new Date('2026-04-01') }, admin._id);
  const sibB = await studentService.create({ name: 'Diya Gupta', phone: '9811111111', class: cls._id, admissionDate: new Date('2026-04-01') }, admin._id);
  const sibC = await studentService.create({ name: 'Kabir Gupta', phone: '9811111111', class: cls2._id, admissionDate: new Date('2026-04-01') }, admin._id);
  const sibD = await studentService.create({ name: 'Meera Gupta', phone: '9822222222', class: cls2._id, admissionDate: new Date('2026-04-01') }, admin._id);

  const siblingsOf = async (id) => (await studentService.getLedger(id)).siblings;

  let selfLink = false;
  try { await studentService.linkSibling(sibA._id, sibA._id); } catch { selfLink = true; }
  ok('A student cannot be their own sibling', selfLink);

  const l1 = await studentService.linkSibling(sibA._id, sibB._id);
  ok('Two students link into a new family', l1.members.length === 2 && l1.merged === false);

  ok('The link works from the other side too', (await siblingsOf(sibB._id)).some((s) => s.name === 'Aarav Gupta'));

  let dupe = false;
  try { await studentService.linkSibling(sibA._id, sibB._id); } catch (e) { dupe = e.code === 'ALREADY_SIBLINGS'; }
  ok('Linking the same pair twice is refused', dupe);

  // The transitive case: C joins B, and A — who nobody mentioned — gains a
  // sibling. This is the one a list-of-pairs model gets wrong.
  await studentService.linkSibling(sibB._id, sibC._id);
  const aFamily = await siblingsOf(sibA._id);
  ok('A third child joins the whole family at once', aFamily.length === 2,
     aFamily.map((s) => s.name).join(', '));
  ok('...including the sibling nobody linked directly', aFamily.some((s) => s.name === 'Kabir Gupta'));

  // Two separate families merging.
  const other1 = await studentService.create({ name: 'Ishaan Rao', phone: '9833333333', class: cls._id, admissionDate: new Date('2026-04-01') }, admin._id);
  await studentService.linkSibling(sibD._id, other1._id);
  ok('A second, separate family exists', (await siblingsOf(sibD._id)).length === 1);

  const merge = await studentService.linkSibling(sibA._id, sibD._id);
  ok('Linking across two families merges them', merge.merged === true && merge.members.length === 5,
     `${merge.members.length} members`);
  ok('Everybody ends up in one family', (await siblingsOf(other1._id)).length === 4);

  // Unlinking one person leaves the rest together.
  await studentService.unlinkSibling(sibA._id, other1._id);
  ok('An unlinked child leaves the family', (await siblingsOf(other1._id)).length === 0);
  ok('The rest stay together', (await siblingsOf(sibA._id)).length === 3);

  let notSiblings = false;
  try { await studentService.unlinkSibling(sibA._id, other1._id); } catch (e) { notSiblings = e.code === 'NOT_SIBLINGS'; }
  ok('Unlinking somebody who is not linked is refused', notSiblings);

  // Down to two, then one: the group has to dissolve rather than leave a
  // single student flagged as being in a family.
  await studentService.unlinkSibling(sibA._id, sibC._id);
  await studentService.unlinkSibling(sibA._id, sibD._id);
  const pair = await siblingsOf(sibA._id);
  ok('Two are left', pair.length === 1, pair.map((s) => s.name).join(', '));

  const last = await studentService.unlinkSibling(sibA._id, sibB._id);
  ok('Removing the second of two dissolves the family', last.remaining === 0);
  ok('Neither of them is left in a group', (await siblingsOf(sibA._id)).length === 0 && (await siblingsOf(sibB._id)).length === 0);

  const orphan = await Student.findById(sibA._id).select('siblingGroup').lean();
  ok('The group id is cleared, not left dangling', orphan.siblingGroup === null, String(orphan.siblingGroup));

  // ---------- reports ----------
  section('Reports');
  const dash = await reportService.dashboard();
  ok('Dashboard built', dash.month === NOW && dash.outstanding.total > 0,
     `outstanding ₹${dash.outstanding.total}, vendors ₹${dash.vendors.outstanding}`);
  ok('Salary reached the rollup', dash.spend.salaries === 21774.19, `₹${dash.spend.salaries}`);

  const summary = await feeService.summary({ month: '2026-08' });
  ok('Class-wise summary built', summary.classes.length === 2, `${summary.classes.length} classes`);

  const db2 = await reportService.daybook({ from: new Date(), to: new Date() });
  ok('Day book ran', typeof db2.totals.net === 'number');

  console.log(`\n${'='.repeat(50)}`);
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nCRASH:', e.message, '\n', e.stack); process.exit(1); });
