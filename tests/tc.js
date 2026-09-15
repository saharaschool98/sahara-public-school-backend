// ---------------------------------------------------------------------------
// TRANSFER CERTIFICATES — a numbered document, and a student coming off the
// roster, in one act.
//
// What makes this worth its own suite is the same thing that made ID cards
// worth one: it is TWO things at once. There the pair was a flag and the money;
// here it is the certificate and the ROSTER — the status, the leaving date and
// the class's headcount. The failure that matters is the two disagreeing: a TC
// issued for a child still counted in their class, or a student marked Left by
// a certificate that was then cancelled and never put back.
//
// So most of the assertions here are cross-checks. After every action the flag,
// the status and SchoolClass.studentCount are all read back and compared, and
// the two orders the office actually works in — TC first, and Left first — are
// both driven all the way through.
//
// Its own database, like dues.js, voidfee.js and idcard.js.
// ---------------------------------------------------------------------------

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/sps_tc?directConnection=true';
process.env.ACCESS_TOKEN_SECRET = 'a'.repeat(48);
process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(48);
process.env.FRONTEND_URL = 'http://localhost:5173';

const mongoose = require('mongoose');
const connectDB = require('../server/src/config/db');
const User = require('../server/src/models/user.model');
const Student = require('../server/src/models/student.model');
const SchoolClass = require('../server/src/models/schoolClass.model');
const { Counter } = require('../server/src/models/counter.model');
const permissionService = require('../server/src/services/permission.service');
const sessionService = require('../server/src/services/session.service');
const classService = require('../server/src/services/class.service');
const studentService = require('../server/src/services/student.service');
const feeService = require('../server/src/services/fee.service');
const reportService = require('../server/src/services/report.service');
const { sessionCache, permissionCache } = require('../server/src/utils/ttlCache');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`)); };
const section = (t) => console.log(`\n== ${t}`);
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const doc = (id) => Student.findById(id).lean();
const tcOf = async (id) => (await doc(id)).tc;
const headcount = async (id) => (await SchoolClass.findById(id).lean()).studentCount;

(async () => {
  await connectDB();
  await mongoose.connection.dropDatabase();
  sessionCache.clear(); permissionCache.clear();

  section('Setup');
  await permissionService.seedDefaults();
  const admin = await User.create({ name: 'Admin', username: 'admin', role: 'Admin', password: 'test1234' });
  const actor = { id: admin._id, name: 'Admin', role: 'Admin' };
  const sess = await sessionService.create({
    name: '2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), feeMonths: ['2026-04', '2026-05'],
  });
  await sessionService.activate(sess._id);
  sessionCache.clear();

  const c5 = await classService.create({ name: 'Class 5', section: 'A', order: 5, monthlyFee: 1000 });
  const c6 = await classService.create({ name: 'Class 6', section: 'A', order: 6, monthlyFee: 1200 });

  const mk = (name, cls, phone) => studentService.create(
    { name, class: cls._id, phone, admissionDate: new Date('2026-04-05'), dob: new Date('2015-07-19') }, actor.id);

  const aarav = await mk('Aarav Sharma', c5, '9876543210');   // clean — the simple path
  const bhavna = await mk('Bhavna Rao', c5, '9876543211');    // will owe money
  const chetan = await mk('Chetan Patel', c5, '9876543212');  // marked Left first, TC later
  const divya = await mk('Divya Nair', c6, '9876543213');     // will hold an advance
  const esha = await mk('Esha Gupta', c6, '9876543214');      // stays, to prove nothing leaks

  ok('Class 5 holds 3, Class 6 holds 2', (await headcount(c5._id)) === 3 && (await headcount(c6._id)) === 2);
  ok('Date of birth is stored', Boolean((await doc(aarav._id)).dob), 'a TC without one comes straight back');
  ok('Nobody starts with a certificate', (await tcOf(aarav._id)).given === false);

  section('The simple path — issuing also takes them off the roster');
  const r1 = await studentService.issueTC(String(aarav._id), { reason: 'Family moved to Jaipur' }, actor);
  ok('Numbered from the counter', r1.tcNo === 'TC0001', r1.tcNo);
  ok('It reports that it marked them Left', r1.markedLeft === true);

  const a = await doc(aarav._id);
  ok('Status is Left', a.status === 'Left');
  ok('Leaving date is set', Boolean(a.leftAt));
  ok('The reason is on the student too', a.leftReason === 'Family moved to Jaipur');
  ok('The certificate records that IT moved them', a.tc.markedLeft === true);
  ok('Reason is printed from the TC', a.tc.reason === 'Family moved to Jaipur');
  ok('Conduct always says something', a.tc.conduct === 'Good', 'a blank line there reads as an accusation');
  ok('Class 5 headcount came down to 2', (await headcount(c5._id)) === 2);
  ok('Nothing owed, so nothing frozen onto it', a.tc.duesAtIssue === 0 && a.tc.creditAtIssue === 0);

  section('One certificate per student, and the number is never reused');
  const e1 = await throws(() => studentService.issueTC(String(aarav._id), {}, actor));
  ok('A second TC -> 409', e1 && e1.statusCode === 409 && e1.code === 'TC_ISSUED', e1 && e1.message);
  ok('Headcount did not move again', (await headcount(c5._id)) === 2, 'a refused issue must not decrement twice');

  section('Unpaid dues warn — they do not silently decide');
  await feeService.generateMonth({ month: '2026-04' }, actor.id);
  const bDues = (await doc(bhavna._id)).feeOutstanding;
  ok('Bhavna owes April', bDues === 1000, `₹${bDues}`);

  const e2 = await throws(() => studentService.issueTC(String(bhavna._id), { reason: 'shifted school' }, actor));
  ok('Blocked while dues stand -> 409', e2 && e2.statusCode === 409 && e2.code === 'TC_BLOCKED', e2 && e2.message);
  ok('...and the amount is named in the refusal', e2 && e2.message.includes('1000'));
  ok('...and nothing was written', (await tcOf(bhavna._id)).given === false && (await doc(bhavna._id)).status === 'Active');
  ok('...and the class still counts her', (await headcount(c5._id)) === 2);

  const r2 = await studentService.issueTC(
    String(bhavna._id), { reason: 'shifted school', issueAnyway: true }, actor);
  ok('The override goes through', r2.tcNo === 'TC0002', r2.tcNo);
  ok('The dues are FROZEN onto the certificate', (await tcOf(bhavna._id)).duesAtIssue === 1000);
  ok('The dues themselves are untouched', (await doc(bhavna._id)).feeOutstanding === 1000, 'leaving does not clear them');

  section('An advance still held blocks it too — the school owes THEM');
  await feeService.collect({ studentId: String(divya._id), amount: 3000, mode: 'Cash' }, actor);
  const held = (await doc(divya._id)).creditBalance;
  ok('Divya paid ahead', held > 0, `₹${held} held`);

  const e3 = await throws(() => studentService.issueTC(String(divya._id), {}, actor));
  ok('Blocked while the school holds their money -> 409', e3 && e3.statusCode === 409 && e3.code === 'TC_BLOCKED', e3 && e3.message);
  ok('...and the refusal says the school owes it back', e3 && e3.message.includes('owes that back'));

  await feeService.refundCredit(String(divya._id), { amount: held, mode: 'Cash', reason: 'leaving mid-session' }, actor);
  const r3 = await studentService.issueTC(String(divya._id), { reason: 'moved city' }, actor);
  ok('Once returned, it goes straight through', r3.tcNo === 'TC0003' && r3.creditAtIssue === 0);
  ok('Class 6 headcount came down to 1', (await headcount(c6._id)) === 1);

  section('The other order — marked Left first, certificate later');
  // Cleared first, so this section proves the ORDER and nothing else. The dues
  // path already has its own section above.
  await feeService.collect({ studentId: String(chetan._id), amount: 1000, mode: 'Cash' }, actor);
  const left = await studentService.markLeft(String(chetan._id), { reason: 'completed Class 8' });
  ok('Marked Left', left.alreadyLeft === false && (await doc(chetan._id)).status === 'Left');
  ok('Class 5 is now empty — all three have gone', (await headcount(c5._id)) === 0);
  const leftAtFirst = (await doc(chetan._id)).leftAt;

  const r4 = await studentService.issueTC(String(chetan._id), { reason: 'completed Class 8' }, actor);
  ok('The TC issues fine for someone already gone', r4.tcNo === 'TC0004');
  ok('It reports that it did NOT move them', r4.markedLeft === false);
  ok('...and the certificate records that', (await tcOf(chetan._id)).markedLeft === false);
  ok('The original leaving date is not redated',
    String((await doc(chetan._id)).leftAt) === String(leftAtFirst), 'the TC records the leaving, it does not rewrite it');
  ok('The headcount did NOT come down twice', (await headcount(c5._id)) === 0, 'this is the one that silently breaks a roster');

  section('markLeft twice is a no-op, not a second decrement');
  const again = await studentService.markLeft(String(chetan._id), {});
  ok('Reported as already left', again.alreadyLeft === true);
  ok('It returns the full shape, not a bare student', Boolean(again.student && again.student.name));
  ok('Headcount still 0', (await headcount(c5._id)) === 0);

  section('Cancelling is the exact inverse of THIS issue');
  // Aarav's TC is what marked him Left — cancelling puts him back.
  const x1 = await studentService.cancelTC(String(aarav._id), 'wrong child, admission numbers are adjacent');
  ok('It reports the restore', x1.restoredToRoster === true && x1.tcNo === 'TC0001');
  ok('Back to Active', (await doc(aarav._id)).status === 'Active');
  ok('Leaving date cleared', (await doc(aarav._id)).leftAt === null);
  ok('Class 5 headcount back up to 1', (await headcount(c5._id)) === 1);
  ok('The certificate is cleared off the student', (await tcOf(aarav._id)).given === false && (await tcOf(aarav._id)).no === null);

  // Chetan's TC did NOT mark him Left — cancelling must leave him Left.
  const x2 = await studentService.cancelTC(String(chetan._id), 'issued on the wrong date');
  ok('It reports no restore', x2.restoredToRoster === false);
  ok('He is STILL Left', (await doc(chetan._id)).status === 'Left', 'he left before the certificate existed');
  ok('Headcount unchanged at 1', (await headcount(c5._id)) === 1, 'restoring him here would have inflated the class');

  section('A cancelled number is burnt, never handed out again');
  const r5 = await studentService.issueTC(String(aarav._id), { reason: 'actually leaving this time' }, actor);
  ok('The next certificate is the NEXT number', r5.tcNo === 'TC0005', `${r5.tcNo}, not TC0001`);
  const seq = await Counter.findById('2026-27:tcNo').lean();
  ok('The counter never went backwards', seq.seq === 5, `seq ${seq.seq}`);

  section('Guards');
  const e4 = await throws(() => studentService.cancelTC(String(esha._id), 'nothing to cancel'));
  ok('Cancelling a TC that was never issued -> 409', e4 && e4.statusCode === 409 && e4.code === 'TC_NOT_ISSUED', e4 && e4.message);
  const e5 = await throws(() => studentService.cancelTC(String(bhavna._id), ''));
  ok('Cancelling without a reason -> 400', e5 && e5.statusCode === 400, e5 && e5.message);
  ok('...and it did not go through', (await tcOf(bhavna._id)).given === true);
  const e6 = await throws(() => studentService.issueTC(String(new mongoose.Types.ObjectId()), {}, actor));
  ok('An unknown student -> 404', e6 && e6.statusCode === 404);

  section('The working list — who has gone without a certificate');
  const pending = await studentService.list({ status: 'Left', tc: 'pending' });
  const names = pending.items.map((s) => s.name).sort();
  ok('Chetan alone', names.length === 1 && names[0] === 'Chetan Patel', names.join(', '));
  ok('The count comes with it', pending.pagination.totalItems === 1);
  const given = await studentService.list({ status: 'Left', tc: 'given' });
  ok('And the issued side lists the rest', given.pagination.totalItems === 3, `${given.pagination.totalItems} issued`);
  ok('The list carries what the certificate prints',
    given.items.every((s) => s.dob !== undefined && s.address !== undefined && s.admissionDate !== undefined));

  section('Leaving does not make dues disappear');
  // Bhavna owes ₹1,000 and has left. Every screen that counts money owed has
  // to keep counting it — this is the bug the TC work was built on top of.
  const out = await reportService.outstanding();
  ok('The outstanding report still sees it', out.receivable.total >= 1000, `₹${out.receivable.total}`);
  const cls5 = out.receivable.byClass.find((c) => String(c.classId) === String(c5._id));
  ok('...against her class', Boolean(cls5) && cls5.fee >= 1000, cls5 && `₹${cls5.fee}`);
  ok('...and it says how many of them have gone', Boolean(cls5) && cls5.left >= 1, cls5 && `${cls5.left} left`);

  const dash = await reportService.dashboard();
  ok('The dashboard still counts it', dash.outstanding.fee >= 1000, `₹${dash.outstanding.fee}`);
  ok('...names the part owed by students who left', dash.outstanding.fromLeft >= 1000, `₹${dash.outstanding.fromLeft}`);
  ok('...but the headcount is Active-only', dash.outstanding.activeStudents === 1,
    `${dash.outstanding.activeStudents} active — only Esha, who never left`);

  const def = await studentService.defaulters({});
  ok('The defaulters list still shows her',
    def.items.some((s) => s.name === 'Bhavna Rao' && s.status === 'Left'), 'with her status on the row');

  console.log('\n' + '='.repeat(50));
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH:', e.message, '\n', e); process.exit(1); });
