const AcademicSession = require('../models/academicSession.model');
const SchoolClass = require('../models/schoolClass.model');
const Student = require('../models/student.model');
const Charge = require('../models/charge.model');
const ChargeDemand = require('../models/chargeDemand.model');
const ChargeHead = require('../models/chargeHead.model');
const ApiError = require('../utils/ApiError');
const withTransaction = require('../utils/withTransaction');
const { Counter } = require('../models/counter.model');
const { round2 } = require('../utils/money');

// ---------------------------------------------------------------------------
// SESSION ROLLOVER — moving the school from one year into the next.
//
// This is the largest thing the app does and the only one that touches every
// student at once, so the shape of it matters more than usual.
//
// WHY A STUDENT IS A NEW DOCUMENT, NOT AN EDITED ONE
//
// `session` is this app's partition key: every transactional collection carries
// it and it leads almost every index. A student therefore belongs to a session
// the same way a fee demand does — last year's record stays exactly as it was,
// with last year's class, last year's fee and last year's balances, and this
// year gets a record of its own. That is what makes "show me 2026-27" still
// answerable in 2030, and it is why sibling linking already refuses to cross
// sessions: "a student from last year is a different record".
//
// So promotion COPIES forward. It does not edit anything in the old session,
// which also means a rollover can never damage a year that is already closed.
//
// WHAT CARRIES, AND WHAT DOES NOT
//
// Only classes and students need moving. Everything else either carries itself
// or genuinely starts empty, and it is worth naming both:
//
//   carries itself  — stock items and their current stock (the cupboard does
//                     not empty in April), vendors and what is owed to them,
//                     teachers, charge heads, expense categories, users,
//                     enquiries. None of these are session-scoped.
//   starts empty    — fee demands, attendance, salary slips, expenses,
//                     purchases, the ledger and the rollups. A new year's books
//                     begin blank; that is the point of a new year.
//
// THE THREE STEPS ARE SEPARATE AND EACH IS IDEMPOTENT
//
// Classes first, then students, and the plan in between is read-only so the
// office can see exactly what is about to happen before anything moves. Every
// step can be run twice safely — the same discipline fee generation follows,
// and it matters far more here, because "did that go through?" on a flaky
// connection is a question somebody WILL ask with 400 students in the balance.
// ---------------------------------------------------------------------------

// The head every carried-forward balance is raised under. One head, created
// once and reused every year, so "how much did we carry in" is a question the
// Other Fees report can answer on its own.
const ARREARS_HEAD = 'Arrears brought forward';

// The session the students are coming FROM: the most recent one that starts
// before the target. Derived rather than asked for, because picking the wrong
// source here would promote the wrong year's roll and there is no useful way
// for somebody to double-check that in a dropdown.
const sourceFor = async (target) =>
    AcademicSession.findOne({ _id: { $ne: target._id }, startDate: { $lt: target.startDate } })
        .sort({ startDate: -1 })
        .lean();

const targetSession = async (id) => {
    const target = await AcademicSession.findById(id).lean();
    if (!target) throw new ApiError(404, 'Session not found');
    return target;
};

// Everything a student still owes, as one number. Fee, uniform and books, and
// other fees all become a single arrears line — the parent owes the school one
// amount, and splitting it across three heads in a year where none of those
// things happened would be bookkeeping for its own sake.
const duesOf = (s) =>
    round2((s.feeOutstanding || 0) + (s.stockOutstanding || 0) + (s.chargeOutstanding || 0));

// ---------------------------------------------------------------------------
// THE PLAN — what would happen, without anything happening.
//
// Read-only on purpose. A rollover that shows its working first is one somebody
// can be talked through; one that just reports "done, 412 students moved" is
// one nobody can check.
// ---------------------------------------------------------------------------
const plan = async (sessionId) => {
    const target = await targetSession(sessionId);
    const source = await sourceFor(target);

    if (!source) {
        throw new ApiError(
            400,
            `${target.name} is the earliest session on record — there is nothing before it to roll forward from`
        ).withCode('NO_SOURCE_SESSION');
    }

    const [fromClasses, toClasses, students, alreadyThere] = await Promise.all([
        SchoolClass.find({ session: source.name }).sort({ order: 1 }).lean(),
        SchoolClass.find({ session: target.name }).sort({ order: 1 }).lean(),
        Student.find({ session: source.name, status: 'Active' })
            .select('admissionNo class feeOutstanding stockOutstanding chargeOutstanding creditBalance')
            .lean(),
        Student.find({ session: target.name }).select('admissionNo').lean(),
    ]);

    const moved = new Set(alreadyThere.map((s) => s.admissionNo));

    // Per source class: how many are on its roll, and where they would land.
    const byClass = new Map(
        fromClasses.map((c) => [String(c._id), { students: 0, pending: 0, dues: 0, credit: 0 }])
    );
    let pending = 0;

    for (const s of students) {
        const bucket = byClass.get(String(s.class));
        if (!bucket) continue;
        bucket.students += 1;
        bucket.dues = round2(bucket.dues + duesOf(s));
        bucket.credit = round2(bucket.credit + (s.creditBalance || 0));
        // Counted per class as well as overall. After a partial rollover the
        // screen has to be able to say how many are LEFT in each class — a
        // button offering to promote seven who are already promoted is a button
        // nobody should press.
        if (!moved.has(s.admissionNo)) {
            bucket.pending += 1;
            pending += 1;
        }
    }

    // ---- the suggested mapping ----
    //
    // One year up, same section: order 5 goes to order 6. `order` exists
    // precisely because "Class 10" sorts before "Class 2" alphabetically, and it
    // is the only field that knows the school's real sequence.
    //
    // It is a SUGGESTION. The office confirms or changes every line before
    // anything moves, because a promotion rule guessed from a number is exactly
    // how a whole year ends up in the wrong class.
    const classes = fromClasses.map((c) => {
        const bucket = byClass.get(String(c._id)) || { students: 0, pending: 0, dues: 0, credit: 0 };
        const sameSection = toClasses.find((t) => t.order === c.order + 1 && t.section === c.section);
        const anySection = toClasses.find((t) => t.order === c.order + 1);
        const suggested = sameSection || anySection || null;

        return {
            fromClassId: c._id,
            fromClass: `${c.name} – ${c.section}`,
            order: c.order,
            students: bucket.students,
            pending: bucket.pending,
            dues: bucket.dues,
            credit: bucket.credit,
            suggestedClassId: suggested?._id || null,
            suggestedClass: suggested ? `${suggested.name} – ${suggested.section}` : null,
            // Nothing above them in the new session. These are the students who
            // are finishing, and they need saying out loud rather than being
            // silently left behind.
            graduating: !suggested,
        };
    });

    return {
        from: { name: source.name, startDate: source.startDate },
        to: { name: target.name, startDate: target.startDate, isActive: Boolean(target.isActive) },
        classes,
        // The new session's classes — the list the office picks from when it
        // confirms or changes a suggestion, and (as a count) how the screen
        // knows whether to offer the copy step at all.
        targetClasses: toClasses.map((c) => ({
            id: c._id,
            label: `${c.name} – ${c.section}`,
            order: c.order,
            monthlyFee: c.monthlyFee,
        })),
        totals: {
            students: students.length,
            // Not yet in the new session. On a second run this is 0 and the
            // screen can say so instead of offering to do it again.
            pending,
            dues: round2(classes.reduce((a, c) => a + c.dues, 0)),
            credit: round2(classes.reduce((a, c) => a + c.credit, 0)),
            graduating: classes.filter((c) => c.graduating).reduce((a, c) => a + c.students, 0),
        },
    };
};

// ---------------------------------------------------------------------------
// STEP ONE — the new session's classes.
//
// A straight copy of last year's, including the monthly fee, because a school's
// class list changes far less often than it stays the same. Anything already
// there is left alone, so this is safe to press twice and safe to press after
// hand-creating a class or two.
// ---------------------------------------------------------------------------
const copyClasses = async (sessionId) => {
    const target = await targetSession(sessionId);
    const source = await sourceFor(target);

    if (!source) {
        throw new ApiError(400, 'There is no earlier session to copy classes from')
            .withCode('NO_SOURCE_SESSION');
    }

    const [fromClasses, toClasses] = await Promise.all([
        SchoolClass.find({ session: source.name }).sort({ order: 1 }).lean(),
        SchoolClass.find({ session: target.name }).select('name section').lean(),
    ]);

    const have = new Set(toClasses.map((c) => `${c.name}|${c.section}`));
    const missing = fromClasses.filter((c) => !have.has(`${c.name}|${c.section}`));

    if (!missing.length) {
        return { created: 0, skipped: fromClasses.length, message: `${target.name} already has these classes` };
    }

    // studentCount deliberately starts at zero rather than being copied — it is
    // a count of who is on the roll NOW, and nobody has been promoted yet.
    const created = await SchoolClass.insertMany(
        missing.map((c) => ({
            session: target.name,
            name: c.name,
            section: c.section,
            order: c.order,
            monthlyFee: c.monthlyFee,
            studentCount: 0,
            isActive: true,
        })),
        { ordered: true }
    );

    return { created: created.length, skipped: fromClasses.length - created.length };
};

// ---------------------------------------------------------------------------
// STEP TWO — the students.
//
// One transaction: every student, their balances and the classes' headcounts
// move together or none of them do. A rollover that half-ran is the worst
// possible state to be in — some children on the new roll and some not, with no
// way to tell which without reading 400 records.
//
// Size: a few hundred students is well inside a transaction's limits, and the
// same reasoning fee generation records for its own batch. A very large school
// can promote one class at a time by mapping a single class per run, which
// works because this is idempotent.
// ---------------------------------------------------------------------------
const promote = async (sessionId, { mapping = {}, carryDues = true, carryCredit = true }, actor) => {
    const target = await targetSession(sessionId);
    const source = await sourceFor(target);

    if (!source) {
        throw new ApiError(400, 'There is no earlier session to promote students from')
            .withCode('NO_SOURCE_SESSION');
    }
    if (source.name === target.name) {
        throw new ApiError(400, 'A session cannot be rolled over into itself');
    }

    // Only classes the office actually mapped. An unmapped class is a decision
    // not yet made, and a class mapped to null is a decision made: those
    // students are finishing and stay where they are.
    const routes = new Map(
        Object.entries(mapping)
            .filter(([, to]) => to)
            .map(([from, to]) => [String(from), String(to)])
    );

    if (!routes.size) {
        throw new ApiError(400, 'No classes have been mapped — nothing to promote').withCode('NO_MAPPING');
    }

    const toClasses = await SchoolClass.find({
        session: target.name,
        _id: { $in: [...routes.values()] },
    }).lean();

    const classById = new Map(toClasses.map((c) => [String(c._id), c]));

    for (const to of routes.values()) {
        if (!classById.has(to)) {
            throw new ApiError(400, `A class being promoted into does not exist in ${target.name}`);
        }
    }

    const [students, alreadyThere] = await Promise.all([
        Student.find({
            session: source.name,
            status: 'Active',
            class: { $in: [...routes.keys()].map(String) },
        }).lean(),
        Student.find({ session: target.name }).select('admissionNo').lean(),
    ]);

    // Already promoted. The unique index on { session, admissionNo } is the real
    // guarantee — this pre-filter just keeps the ordinary second run off the
    // error path, exactly as fee generation does.
    const moved = new Set(alreadyThere.map((s) => s.admissionNo));
    const pending = students.filter((s) => !moved.has(s.admissionNo));

    if (!pending.length) {
        return {
            promoted: 0,
            skipped: students.length,
            message: `Every one of these students is already on the ${target.name} roll`,
        };
    }

    const head = carryDues ? await arrearsHead(actor.id) : null;
    const withDues = carryDues ? pending.filter((s) => duesOf(s) > 0) : [];
    const totalDues = round2(withDues.reduce((a, s) => a + duesOf(s), 0));

    return withTransaction(async (mongoSession) => {
        const docs = pending.map((s) => {
            const cls = classById.get(routes.get(String(s.class)));
            const credit = carryCredit ? round2(s.creditBalance || 0) : 0;

            return {
                session: target.name,
                // The SAME admission number. It is how the school, the parent and
                // every receipt already refer to this child; a number that
                // changed every April would not be an identity at all. Safe
                // because the unique index is per session — and the counter is
                // pushed past these below, so a new admission cannot collide.
                admissionNo: s.admissionNo,
                name: s.name,
                nameLower: s.name.toLowerCase().trim(),
                guardianName: s.guardianName,
                motherName: s.motherName,
                dob: s.dob,
                phone: s.phone,
                altPhone: s.altPhone,
                address: s.address,

                class: cls._id,
                className: `${cls.name} – ${cls.section}`,
                // The NEW class's fee, not the old student's. A concession is a
                // decision about one year and is re-made, not inherited — and
                // carrying ₹800 into a class that charges ₹1,200 would
                // undercharge silently, which is the worse of the two mistakes.
                monthlyFee: cls.monthlyFee,

                status: 'Active',
                // When they joined the SCHOOL, not this session. It is the date
                // a transfer certificate prints.
                admissionDate: s.admissionDate,
                photo: s.photo,

                // Balances start clean. What was owed comes back below as a
                // single arrears charge — a real demand with a document behind
                // it, so the outstanding report, the collect screen and
                // recompute:balances all treat it like any other money owed.
                feeOutstanding: 0,
                stockOutstanding: 0,
                chargeOutstanding: 0,

                // An advance the school is holding survives the boundary: a
                // parent who paid in March for April's fee has bought next year.
                creditBalance: credit,
                openingCredit: credit,

                // Brothers and sisters keep their family. The group is just an
                // id, and both members land in the new session together, so the
                // relation holds without re-linking anybody.
                siblingGroup: s.siblingGroup || null,

                // NOT carried: the ID card and the transfer certificate are
                // facts about a particular year, and starting the new one with
                // "card already taken" would hide a whole year's worth of work.
                createdBy: actor.id,
            };
        });

        const created = await Student.insertMany(docs, { session: mongoSession, ordered: true });

        // Each new class's headcount, in one write rather than one per student.
        const counts = new Map();
        for (const d of created) {
            const key = String(d.class);
            counts.set(key, (counts.get(key) || 0) + 1);
        }
        await SchoolClass.bulkWrite(
            [...counts.entries()].map(([id, n]) => ({
                updateOne: { filter: { _id: id }, update: { $inc: { studentCount: n } } },
            })),
            { session: mongoSession, ordered: false }
        );

        // ---- the admission-number counter ----
        //
        // Carrying ADM0412 forward means the new session's counter, which starts
        // at zero, would eventually hand ADM0412 to somebody else and the unique
        // index would refuse the admission. $max pushes it past everything
        // carried in and never backwards, so running this twice is harmless.
        const highest = pending.reduce((max, s) => {
            const n = parseInt(String(s.admissionNo).replace(/\D/g, ''), 10);
            return Number.isFinite(n) && n > max ? n : max;
        }, 0);

        if (highest > 0) {
            await Counter.findByIdAndUpdate(
                `${target.name}:admissionNo`,
                { $max: { seq: highest } },
                { upsert: true, session: mongoSession }
            );
        }

        // ---- what they still owed ----
        let arrears = null;

        if (carryDues && withDues.length) {
            const byAdmissionNo = new Map(created.map((d) => [d.admissionNo, d]));

            const [charge] = await Charge.create(
                [
                    {
                        session: target.name,
                        head: head._id,
                        headName: head.name,
                        title: `Brought forward from ${source.name}`,
                        // The amount on the charge is the per-student figure
                        // everywhere else; here every student owes something
                        // different, so it holds the total and each demand
                        // carries its own.
                        amount: 0,
                        scope: 'STUDENT',
                        studentCount: withDues.length,
                        totalRaised: totalDues,
                        note: `Unpaid fees, uniform and other charges carried over from ${source.name}`,
                        raisedBy: actor.id,
                    },
                ],
                { session: mongoSession }
            );

            const demands = withDues.map((s) => {
                const fresh = byAdmissionNo.get(s.admissionNo);
                return {
                    session: target.name,
                    charge: charge._id,
                    headName: head.name,
                    title: `Brought forward from ${source.name}`,
                    student: fresh._id,
                    studentName: fresh.name,
                    class: fresh.class,
                    className: fresh.className,
                    amount: duesOf(s),
                    status: 'Unpaid',
                };
            });

            await ChargeDemand.insertMany(demands, { session: mongoSession, ordered: true });

            // The demands and the balances move together — the lesson fee
            // generation learned the hard way.
            await Student.bulkWrite(
                demands.map((d) => ({
                    updateOne: { filter: { _id: d.student }, update: { $inc: { chargeOutstanding: d.amount } } },
                })),
                { session: mongoSession, ordered: false }
            );

            arrears = { chargeId: charge._id, students: withDues.length, total: totalDues };
        }

        // A family of one is not a family. If only one of two siblings was
        // promoted — the other left, or is finishing — the group would follow
        // them into the new session with nobody else in it, and the next student
        // linked to them would silently join that stale family.
        const groups = [...new Set(created.map((d) => String(d.siblingGroup || '')).filter(Boolean))];
        let unlinked = 0;

        for (const group of groups) {
            const members = await Student.find({ session: target.name, siblingGroup: group })
                .select('_id')
                .session(mongoSession)
                .lean();

            if (members.length === 1) {
                await Student.updateOne(
                    { _id: members[0]._id },
                    { $set: { siblingGroup: null } },
                    { session: mongoSession }
                );
                unlinked += 1;
            }
        }

        return {
            from: source.name,
            to: target.name,
            promoted: created.length,
            skipped: students.length - created.length,
            creditCarried: round2(created.reduce((a, d) => a + (d.openingCredit || 0), 0)),
            arrears,
            siblingGroupsCleared: unlinked,
        };
    });
};

// The arrears head, created once and reused every year. `isActive` is left
// alone if somebody has retired it — a retired head still accepts what was
// already raised under it, and re-raising is what this is.
const arrearsHead = async (actorId) => {
    const nameLower = ARREARS_HEAD.toLowerCase();
    const existing = await ChargeHead.findOne({ nameLower }).lean();
    if (existing) return existing;

    return ChargeHead.create({
        name: ARREARS_HEAD,
        nameLower,
        defaultAmount: 0,
        createdBy: actorId,
    });
};

module.exports = { plan, copyClasses, promote, ARREARS_HEAD };
