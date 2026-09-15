// ---------------------------------------------------------------------------
// SESSION ROLLOVER — moving a whole school into the next year.
//
// This is the largest write the app makes and the one with the most ways to go
// quietly wrong, so this suite is mostly about the quiet ones:
//
//   · a student promoted twice, or a class counted twice;
//   · money that does not survive the boundary — arrears that vanish (the
//     school silently forgives a year of dues) or an advance that vanishes
//     (the school silently keeps a parent's money);
//   · last year's records edited instead of copied, so a closed year stops
//     being a record of what happened;
//   · an admission number handed out twice once the counter restarts;
//   · a sibling group following one child into a year where nobody else is in
//     it.
//
// The last section is the real proof, the same one the README names: after all
// this, recomputeBalances has to rebuild every balance from its sources and
// report no drift. Carrying a balance forward is exactly the kind of change
// that breaks that, because a carried balance has no rows behind it.
//
// Its own database, like the other money suites.
// ---------------------------------------------------------------------------

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/sps_rollover?directConnection=true';
process.env.ACCESS_TOKEN_SECRET = 'a'.repeat(48);
process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(48);
process.env.FRONTEND_URL = 'http://localhost:5173';

const { execFileSync } = require('child_process');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../server/src/config/db');
const User = require('../server/src/models/user.model');
const Student = require('../server/src/models/student.model');
const SchoolClass = require('../server/src/models/schoolClass.model');
const ChargeDemand = require('../server/src/models/chargeDemand.model');
const { Counter } = require('../server/src/models/counter.model');
const permissionService = require('../server/src/services/permission.service');
const sessionService = require('../server/src/services/session.service');
const classService = require('../server/src/services/class.service');
const studentService = require('../server/src/services/student.service');
const feeService = require('../server/src/services/fee.service');
const chargeService = require('../server/src/services/charge.service');
const rollover = require('../server/src/services/rollover.service');
const { monthKeyIST } = require('../server/src/utils/istDate');
const { sessionCache, permissionCache } = require('../server/src/utils/ttlCache');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`)); };
const section = (t) => console.log(`\n== ${t}`);
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const inSession = (name, admissionNo) => Student.findOne({ session: name, admissionNo }).lean();
const headcount = async (id) => (await SchoolClass.findById(id).lean()).studentCount;

(async () => {
  await connectDB();
  await mongoose.connection.dropDatabase();
  sessionCache.clear(); permissionCache.clear();

  section('Setup — a year with money in it');
  await permissionService.seedDefaults();
  const admin = await User.create({ name: 'Admin', username: 'admin', role: 'Admin', password: 'test1234' });
  const actor = { id: admin._id, name: 'Admin', role: 'Admin' };

  const old = await sessionService.create({
    name: '2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'),
    feeMonths: [monthKeyIST()],
  });
  await sessionService.activate(old._id);
  sessionCache.clear();

  const c5 = await classService.create({ name: 'Class 5', section: 'A', order: 5, monthlyFee: 1000 });
  const c6 = await classService.create({ name: 'Class 6', section: 'A', order: 6, monthlyFee: 1200 });
  const c7 = await classService.create({ name: 'Class 7', section: 'A', order: 7, monthlyFee: 1350 });
  // The top of the school — nothing above it, so its students are finishing.
  const c8 = await classService.create({ name: 'Class 8', section: 'A', order: 8, monthlyFee: 1500 });

  const mk = (name, cls, phone) => studentService.create(
    { name, class: cls._id, phone, admissionDate: new Date('2024-04-05'), dob: new Date('2015-07-19') }, actor.id);

  const aarav = await mk('Aarav Sharma', c5, '9876543210');   // will owe money
  const bhavna = await mk('Bhavna Rao', c5, '9876543211');    // will pay ahead
  const chetan = await mk('Chetan Patel', c5, '9876543212');  // clean, and Aarav's sibling
  const divya = await mk('Divya Nair', c6, '9876543213');     // clean
  const esha = await mk('Esha Gupta', c8, '9876543214');      // finishing
  const farhan = await mk('Farhan Khan', c5, '9876543215');   // will LEAVE before rollover

  await studentService.linkSibling(String(aarav._id), String(chetan._id));
  ok('Aarav and Chetan are siblings', Boolean((await inSession('2026-27', 'ADM0001')).siblingGroup));

  // Money: a fee month, one unpaid, one paid ahead, and an other-fee.
  await feeService.generateMonth({ month: monthKeyIST() }, actor.id);
  const headRow = await chargeService.createHead({ name: 'Exam Fee', defaultAmount: 500 }, actor.id);
  await chargeService.raise({ headId: String(headRow._id), title: 'Term 1', amount: 500, scope: 'CLASS', classIds: [String(c5._id)] }, actor.id);

  // Bhavna clears everything and pays ahead. The advance ceiling is one
  // session's fee, and this session bills a single month, so ₹500 over is as
  // far as she can go — which is plenty to prove it survives the boundary.
  await chargeService.collect({ studentId: String(bhavna._id), amount: 500, mode: 'Cash' }, actor);
  await feeService.collect({ studentId: String(bhavna._id), amount: 1500, mode: 'Cash' }, actor);
  // Chetan and Divya settle up.
  await chargeService.collect({ studentId: String(chetan._id), amount: 500, mode: 'Cash' }, actor);
  await feeService.collect({ studentId: String(chetan._id), amount: 1000, mode: 'Cash' }, actor);
  await feeService.collect({ studentId: String(divya._id), amount: 1200, mode: 'Cash' }, actor);
  await feeService.collect({ studentId: String(esha._id), amount: 1500, mode: 'Cash' }, actor);
  // Farhan leaves.
  await studentService.markLeft(String(farhan._id), { reason: 'moved city' });

  const aaravOld = await inSession('2026-27', 'ADM0001');
  const bhavnaOld = await inSession('2026-27', 'ADM0002');
  const aaravDues = r2(aaravOld.feeOutstanding + aaravOld.stockOutstanding + aaravOld.chargeOutstanding);
  ok('Aarav owes fee and exam fee', aaravDues === 1500, `₹${aaravDues}`);
  ok('Bhavna is holding an advance', bhavnaOld.creditBalance > 0, `₹${bhavnaOld.creditBalance}`);

  section('A new session, and the plan before anything moves');
  const next = await sessionService.create({
    name: '2027-28', startDate: new Date('2027-04-01'), endDate: new Date('2028-03-31'),
  });

  let p = await rollover.plan(String(next._id));
  ok('It works out where the students come from', p.from.name === '2026-27', p.from.name);
  ok('The new session has no classes yet', p.targetClasses.length === 0);
  ok('Nothing is suggested while there is nowhere to go',
    p.classes.every((c) => c.suggestedClassId === null));
  ok('It counts only ACTIVE students', p.totals.students === 5,
    `${p.totals.students} — Farhan left and is not promoted`);
  ok('...and totals what they owe', p.totals.dues === aaravDues, `₹${p.totals.dues}`);
  ok('...and what the school owes them', p.totals.credit === bhavnaOld.creditBalance, `₹${p.totals.credit}`);

  ok('NOTHING was written', (await Student.countDocuments({ session: '2027-28' })) === 0,
    'the plan is read-only, and that is the point of it');

  section('Step one — the classes');
  const copied = await rollover.copyClasses(String(next._id));
  ok('All four classes came across', copied.created === 4, `${copied.created} created`);
  const newClasses = await SchoolClass.find({ session: '2027-28' }).sort({ order: 1 }).lean();
  ok('...with their fees', newClasses.find((c) => c.order === 6).monthlyFee === 1200);
  ok('...and an empty roll', newClasses.every((c) => c.studentCount === 0),
    'studentCount is who is on the roll NOW, and nobody has moved yet');

  const again = await rollover.copyClasses(String(next._id));
  ok('Running it twice creates nothing', again.created === 0, again.message);

  section('The plan now knows where everybody goes');
  p = await rollover.plan(String(next._id));
  const from5 = p.classes.find((c) => c.fromClass === 'Class 5 – A');
  const from8 = p.classes.find((c) => c.fromClass === 'Class 8 – A');
  ok('Class 5 is suggested into Class 6', from5.suggestedClass === 'Class 6 – A', from5.suggestedClass);
  ok('Class 8 has nowhere above it', from8.graduating === true && from8.suggestedClassId === null);
  ok('...and its students are counted as finishing', p.totals.graduating === 1, `${p.totals.graduating}`);
  ok('Class 5 carries three students', from5.students === 3, `${from5.students} — not Farhan, who left`);

  section('Step two — the students');
  const mapping = {};
  for (const c of p.classes) if (c.suggestedClassId) mapping[String(c.fromClassId)] = String(c.suggestedClassId);

  const done = await rollover.promote(String(next._id), { mapping }, actor);
  ok('Four promoted, not five', done.promoted === 4,
    `${done.promoted} — Class 8 has nowhere above it, so Esha is not promoted`);
  ok('It says where from and to', done.from === '2026-27' && done.to === '2027-28');

  const aaravNew = await inSession('2027-28', 'ADM0001');
  ok('The admission number is the SAME', Boolean(aaravNew), 'ADM0001 is who this child IS to the school');
  ok('...and moved up a class', aaravNew.className === 'Class 6 – A', aaravNew.className);
  ok('...on the new class\'s fee', aaravNew.monthlyFee === 1200, `₹${aaravNew.monthlyFee}`);
  ok('...keeping their identity', aaravNew.name === 'Aarav Sharma' && aaravNew.phone === '9876543210'
    && String(aaravNew.dob) === String(aaravOld.dob));
  ok('...and the date they joined the SCHOOL', String(aaravNew.admissionDate) === String(aaravOld.admissionDate),
    'not the session — it is what a TC prints');
  ok('...as Active', aaravNew.status === 'Active');

  section('Last year is untouched — it is a record, not a working copy');
  const aaravStill = await inSession('2026-27', 'ADM0001');
  ok('The old record still exists', Boolean(aaravStill));
  ok('...still in Class 5', aaravStill.className === 'Class 5 – A');
  ok('...still on last year\'s fee', aaravStill.monthlyFee === 1000);
  ok('...with last year\'s balances', r2(aaravStill.feeOutstanding + aaravStill.chargeOutstanding) === 1500);
  ok('Last year\'s classes still count their roll', (await headcount(c5._id)) === 3,
    'three active in Class 5 — promotion does not empty the year it came from');

  section('Money crosses the boundary — both directions');
  ok('Arrears came across as a real charge', done.arrears.students === 1 && done.arrears.total === 1500,
    `₹${done.arrears.total} for ${done.arrears.students}`);
  ok('...and are on the student as outstanding', aaravNew.chargeOutstanding === 1500, `₹${aaravNew.chargeOutstanding}`);

  const arrearsDemand = await ChargeDemand.findOne({ session: '2027-28', student: aaravNew._id }).lean();
  ok('...backed by a demand, not a bare number', Boolean(arrearsDemand),
    'so the outstanding report, the collect screen and recompute all treat it like any other money owed');
  ok('...that says where it came from', arrearsDemand.title.includes('2026-27'), arrearsDemand.title);
  ok('A student who owed nothing gets no arrears row',
    (await ChargeDemand.countDocuments({ session: '2027-28' })) === 1);

  const bhavnaNew = await inSession('2027-28', 'ADM0002');
  ok('The advance survived', bhavnaNew.creditBalance === bhavnaOld.creditBalance, `₹${bhavnaNew.creditBalance}`);
  ok('...and is recorded as where the counting starts', bhavnaNew.openingCredit === bhavnaOld.creditBalance,
    'without this the drift check would wipe it');
  ok('Fee and stock balances start clean', bhavnaNew.feeOutstanding === 0 && bhavnaNew.stockOutstanding === 0,
    'what was owed is the arrears charge now, not a fee this year has not raised');

  section('A new year is a new card and a new certificate');
  ok('The ID card resets', aaravNew.idCard.issued === false,
    'starting the year marked "already taken" would hide a whole year of work');
  ok('The TC resets', aaravNew.tc.given === false && aaravNew.tc.no === null);

  section('Headcounts, and the sibling who came alone');
  const new6 = newClasses.find((c) => c.order === 6);
  ok('Class 6 now holds the three from Class 5', (await headcount(new6._id)) === 3, `${await headcount(new6._id)}`);
  const chetanNew = await inSession('2027-28', 'ADM0003');
  ok('Siblings keep their family', String(chetanNew.siblingGroup) === String(aaravNew.siblingGroup)
    && Boolean(chetanNew.siblingGroup), 'both landed together, so the link holds without re-linking');

  section('The counter is pushed past the numbers carried in');
  const seq = await Counter.findById('2027-28:admissionNo').lean();
  ok('It starts above the highest carried number', seq.seq >= 3, `seq ${seq.seq}`);

  // The last step of a real rollover: make the new year the live one. Until
  // this happens every screen still reads last year, and a new admission would
  // be refused because the class it names belongs to a session that is not
  // active — which is correct, and worth a test of its own.
  const before = await throws(() => studentService.create(
    { name: 'Too Early', class: new6._id, phone: '9876543299', admissionDate: new Date('2027-04-05') }, actor.id));
  ok('A new admission into next year is refused while THIS year is live',
    before && before.statusCode === 404, before && before.message);

  await sessionService.activate(next._id);
  sessionCache.clear();
  ok('2027-28 is now the live session', (await sessionService.getActiveSessionName()) === '2027-28');

  const fresh = await studentService.create(
    { name: 'Gauri Joshi', class: new6._id, phone: '9876543216', admissionDate: new Date('2027-04-05') }, actor.id);
  ok('So a new admission cannot collide', fresh.admissionNo !== 'ADM0001' && fresh.admissionNo !== 'ADM0003',
    `${fresh.admissionNo} — without seeding the counter this would have been ADM0001`);

  section('Running it again moves nobody');
  const twice = await rollover.promote(String(next._id), { mapping }, actor);
  ok('Nothing promoted', twice.promoted === 0, twice.message);
  ok('Class 6 still holds four', (await headcount(new6._id)) === 4,
    'three promoted plus Gauri — a second run must not count anybody twice');
  ok('And no second arrears charge', (await ChargeDemand.countDocuments({ session: '2027-28' })) === 1,
    'Aarav is not billed his arrears twice');

  section("A class left as 'finishing' is a decision, not a gap");
  // The screen sends '' for that option and null is equally valid. Both mean
  // "these students are not being promoted", and neither may be mistaken for
  // an id.
  const e0 = await throws(() => rollover.promote(String(next._id), {
    mapping: { [String(c8._id)]: '', [String(c7._id)]: null },
  }, actor));
  ok('Only finishing classes -> nothing to promote', e0 && e0.code === 'NO_MAPPING', e0 && e0.message);

  section('Guards');
  const e1 = await throws(() => rollover.promote(String(next._id), { mapping: {} }, actor));
  ok('An empty mapping -> 400', e1 && e1.statusCode === 400 && e1.code === 'NO_MAPPING', e1 && e1.message);
  const e2 = await throws(() => rollover.plan(String(old._id)));
  ok('The earliest session has nothing before it -> 400', e2 && e2.statusCode === 400 && e2.code === 'NO_SOURCE_SESSION');
  const e3 = await throws(() => rollover.promote(String(next._id), {
    mapping: { [String(c5._id)]: String(new mongoose.Types.ObjectId()) },
  }, actor));
  ok('Promoting into a class that does not exist -> 400', e3 && e3.statusCode === 400, e3 && e3.message);

  section('The real proof — every carried balance rebuilds from its sources');
  // The script checks the ACTIVE session, which is now 2027-28 — the year the
  // carried arrears and the carried advance actually live in, and the one where
  // a balance with nothing behind it would show up as drift.
  const out = execFileSync('node', [path.join(__dirname, '..', 'scripts', 'recomputeBalances.js')], {
    env: { ...process.env, MONGODB_URI: process.env.MONGODB_URI },
    encoding: 'utf8',
  });
  const clean = out.includes('No drift');
  ok('recomputeBalances reports no drift on the new session', clean,
    clean ? 'carried arrears and carried advance both hold up'
          : out.split('\n').filter((l) => l.includes('DRIFT')).slice(0, 5).join(' | '));

  console.log('\n' + '='.repeat(50));
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH:', e.message, '\n', e); process.exit(1); });
