const SalarySlip = require('../models/salarySlip.model');
const Teacher = require('../models/teacher.model');
const TeacherAttendance = require('../models/teacherAttendance.model');
const ApiError = require('../utils/ApiError');
const ledger = require('./ledger.service');
const sessionService = require('./session.service');
const withTransaction = require('../utils/withTransaction');
const { round2 } = require('../utils/money');
const { isDuplicateKey } = require('../utils/mongoErrors');
const {
    isValidMonthKey,
    isSundayIST,
    sundaysInMonthIST,
    daysInMonthIST,
} = require('../utils/istDate');

// ---------------------------------------------------------------------------
// SALARY CALCULATION RULE
//
// The month is paid on its CALENDAR days — 31 in August, 30 in September,
// 28 in February. Not on working days.
//
//   perDayRate  = monthlySalary / daysInMonth
//   payableDays = Present + (HalfDay x 0.5) + Leave + Sundays + Holidays
//   earned      = perDayRate x payableDays
//
// SUNDAYS ARE PAID DAYS, added automatically. Nobody marks a Sunday; the
// month's Sundays are counted from the calendar and added to the payable
// days. Marking one by mistake cannot change the pay either way.
//
// A DAY THAT WAS NEVER MARKED IS NOT PAID. This is the deliberate half of
// the rule: a teacher with one day marked in September is paid for that one
// day plus the month's 4 Sundays — 5 days, not 30. Paying for unmarked days
// instead would mean a month nobody bothered to fill in pays everybody in
// full, which is exactly the mistake payroll must not make.
//
// So the office marks attendance for every working day. The sheet still
// defaults everyone to Present, so a normal day is one button: Save.
//
// What is paid without being worked: Sunday (weekly off), Holiday (school
// holiday), Leave (approved, paid). What reduces pay: Absent, HalfDay
// at half rate, and late arrivals above the allowance (below).
//
// LATE ARRIVALS
//
// A Late is a PRESENT day — the teacher came — so it is paid in full and
// counts as a worked day. The cost is separate: each teacher has a monthly
// allowance (Teacher.lateAllowance), the lates inside it are free, and every
// LATES_PER_DAY lates ABOVE it cost one day's pay.
//
//   lateChargeable    = max(0, Late - allowance)
//   lateDeductionDays = lateChargeable / 4
//
// So with an allowance of 4 and 8 lates marked: 4 are forgiven, the other 4
// cost exactly one day — the same as one Absent. Two excess lates are half a
// day. Treating the late day itself as absent instead would charge twice for
// one late arrival, which is the mistake this split exists to avoid.
//
// >>> THIS RULE STILL NEEDS THE CLIENT'S CONFIRMATION. <<<
// Every school differs — some allow two free absences a month, some have
// a fixed leave quota, some deduct nothing at all. This is the one
// calculation every teacher checks personally, so an error surfaces
// immediately. Changing the rule means changing computeSlip() and nothing else.
// ---------------------------------------------------------------------------
// Excess lates that add up to one day's pay. The whole late rule is this
// number plus the per-teacher allowance — change it here and nowhere else.
const LATES_PER_DAY = 4;

const computeSlip = ({ teacher, marks, month = null, monthDaysOverride = null }) => {
    // Sundays are taken out of the status counting entirely. They are not
    // Present, not Absent, not a Holiday the school declared — they are added
    // back below, straight from the calendar. Leaving them in would let a
    // Sunday marked Absent by accident dock somebody for their day off.
    const onSunday = (m) => Boolean(m.date && isSundayIST(m.date));
    const weekdayMarks = marks.filter((m) => !onSunday(m));

    const counts = weekdayMarks.reduce(
        (acc, m) => ({ ...acc, [m.status]: (acc[m.status] || 0) + 1 }),
        {}
    );

    const presentDays = counts.Present || 0;
    const lateDays = counts.Late || 0;
    const halfDays = counts.HalfDay || 0;
    const leaveDays = counts.Leave || 0;
    const absentDays = counts.Absent || 0;
    const holidayDays = counts.Holiday || 0;

    // A month with nothing marked would pay only the Sundays — a number that
    // looks like a calculation but means "nobody filled the register".
    if (!marks.length) {
        throw new ApiError(
            400,
            `${teacher.name} has no attendance marked this month — fill in attendance first`
        );
    }

    const monthDays = monthDaysOverride ?? (month ? daysInMonthIST(month) : marks.length);
    const sundayDays = month ? sundaysInMonthIST(month) : 0;

    if (monthDays <= 0) {
        throw new ApiError(400, `Could not work out the days in ${month || 'this month'}`);
    }

    // Shown on the slip for information only — it is NOT the divisor.
    const workingDays = Math.max(0, monthDays - sundayDays - holidayDays);

    // Late arrivals. The allowance is read off the teacher and snapshot onto
    // the slip below — raising it next month must not rewrite this one.
    const lateAllowed = Math.max(0, Math.floor(teacher.lateAllowance || 0));
    const lateChargeable = Math.max(0, lateDays - lateAllowed);
    const lateDeductionDays = round2(lateChargeable / LATES_PER_DAY);

    // Every day that is actually paid for, from both halves: the days worked
    // and the days off that carry pay. A Late sits with the worked days — the
    // teacher was there — and the excess is taken off once, at the end.
    const payableDays = round2(
        Math.max(
            0,
            presentDays + lateDays + halfDays * 0.5 + leaveDays + sundayDays + holidayDays - lateDeductionDays
        )
    );

    // Days in the month that nobody accounted for — neither marked nor a
    // Sunday. Surfaced so an unfilled register looks like an unfilled
    // register on the slip, instead of a silent deduction.
    const unmarkedDays = Math.max(
        0,
        round2(
            monthDays - sundayDays - (presentDays + lateDays + halfDays + leaveDays + absentDays + holidayDays)
        )
    );

    // The rate is rounded for DISPLAY only; the earning is computed from the
    // unrounded one. Multiplying the rounded rate instead would pay
    // 333.33 x 30 = ₹9,999.90 for a full month on a ₹10,000 salary — a slip
    // that fails the one check every teacher makes, which is that a full
    // month pays exactly their salary.
    const exactRate = teacher.monthlySalary / monthDays;
    const perDayRate = round2(exactRate);
    const earned = round2(exactRate * payableDays);

    return {
        grossSalary: round2(teacher.monthlySalary),
        // The divisor: 31, 30 or 28
        monthDays,
        // Paid without being worked
        sundayDays,
        // Information only: what the teaching calendar held
        workingDays,
        perDayRate,
        presentDays,
        halfDays,
        leaveDays,
        absentDays,
        holidayDays,
        unmarkedDays,
        // Late arrivals: marked, forgiven, charged, and what it cost in days
        lateDays,
        lateAllowed,
        lateChargeable,
        lateDeductionDays,
        payableDays,
        earned,
    };
};

// What the teacher actually takes home.
//
//   earned + everything added - everything deducted - advance already given
//
// `deductions` is the pre-adjustments field. It is still subtracted so an old
// slip keeps its numbers; nothing writes to it any more.
const netOf = (slip) => {
    const adjusted = (slip.adjustments || []).reduce(
        (sum, a) => sum + (a.kind === 'Add' ? a.amount : -a.amount),
        0
    );
    const legacy = (slip.deductions || []).reduce((sum, d) => sum + d.amount, 0);

    return round2(slip.earned + adjusted - legacy - (slip.advance || 0));
};

// ---------------------------------------------------------------------------
// Generate the month's slips, as drafts.
//
// Idempotent like fee generation: the unique index on { teacher, month }
// prevents a duplicate slip. Re-running only adds teachers whose slip did
// not exist — slips already generated are left untouched (otherwise the
// Principal's adjustments would be wiped out).
// ---------------------------------------------------------------------------
const generate = async ({ month }, actorId) => {
    if (!isValidMonthKey(month)) throw new ApiError(400, 'Month must be in YYYY-MM format');
    const session = await sessionService.getActiveSessionName();

    const teachers = await Teacher.find({ status: 'Active' })
        .select('name designation monthlySalary lateAllowance')
        .lean();

    if (!teachers.length) throw new ApiError(400, 'There are no active teachers');

    const [existing, allMarks] = await Promise.all([
        SalarySlip.find({ month, teacher: { $in: teachers.map((t) => t._id) } })
            .select('teacher')
            .lean(),
        TeacherAttendance.find({ session, month }).select('teacher status date').lean(),
    ]);

    const already = new Set(existing.map((s) => s.teacher.toString()));

    const marksByTeacher = new Map();
    for (const m of allMarks) {
        const key = m.teacher.toString();
        if (!marksByTeacher.has(key)) marksByTeacher.set(key, []);
        marksByTeacher.get(key).push(m);
    }

    const docs = [];
    const skippedNoAttendance = [];

    for (const teacher of teachers) {
        if (already.has(teacher._id.toString())) continue;

        const marks = marksByTeacher.get(teacher._id.toString()) || [];

        if (!marks.length) {
            // Better to say so than to quietly generate a zero-salary slip
            skippedNoAttendance.push(teacher.name);
            continue;
        }

        const computed = computeSlip({ teacher, marks, month });

        docs.push({
            session,
            month,
            teacher: teacher._id,
            teacherName: teacher.name,
            designation: teacher.designation,
            ...computed,
            adjustments: [],
            deductions: [],
            advance: 0,
            netPayable: computed.earned,
            status: 'Draft',
            generatedBy: actorId,
        });
    }

    let created = [];
    if (docs.length) {
        try {
            created = await SalarySlip.insertMany(docs, { ordered: false });
        } catch (err) {
            // ONLY a duplicate key is a result here — somebody else generated the
            // same month in the gap above, and the unique index on
            // { teacher, month } refused the second row. That is the design
            // working.
            //
            // This used to read `err.code !== 11000 && err.code !== undefined`,
            // and a mongoose ValidationError carries no `code` at all — so every
            // validation failure, and every plain TypeError, was swallowed and
            // reported back to the office as a cheerful "0 slips created".
            if (!isDuplicateKey(err)) throw err;
            created = err.insertedDocs || [];
        }
    }

    return {
        month,
        created: created.length,
        skipped: already.size,
        ...(skippedNoAttendance.length && {
            warning: `Skipped for having no attendance: ${skippedNoAttendance.join(', ')}`,
        }),
    };
};

const list = async ({ month, status }) => {
    const session = await sessionService.getActiveSessionName();

    const filter = { session };
    if (month) filter.month = month;
    if (status) filter.status = status;

    const slips = await SalarySlip.find(filter).sort({ teacherName: 1 }).lean();

    const totals = slips.reduce(
        (acc, s) => ({
            gross: round2(acc.gross + s.grossSalary),
            earned: round2(acc.earned + s.earned),
            deductions: round2(
                acc.deductions + (s.deductions || []).reduce((x, d) => x + d.amount, 0) + (s.advance || 0)
            ),
            net: round2(acc.net + s.netPayable),
            paid: round2(acc.paid + s.paidAmount),
        }),
        { gross: 0, earned: 0, deductions: 0, net: 0, paid: 0 }
    );

    return { slips, totals: { ...totals, pending: round2(totals.net - totals.paid) } };
};

const getById = async (id) => {
    const slip = await SalarySlip.findById(id).lean();
    if (!slip) throw new ApiError(404, 'Slip not found');
    return slip;
};

// Only a Draft is editable. After approval the slip is frozen — that is
// exactly what approval means.
const update = async (id, updates) => {
    const slip = await SalarySlip.findById(id);
    if (!slip) throw new ApiError(404, 'Slip not found');

    if (slip.status !== 'Draft') {
        throw new ApiError(
            409,
            'An approved slip is not editable — make a correction with a separate adjustment'
        ).withCode('SLIP_LOCKED');
    }

    if (updates.deductions) slip.deductions = updates.deductions;
    if (updates.advance !== undefined) slip.advance = round2(updates.advance);
    if (updates.note !== undefined) slip.note = updates.note;

    slip.netPayable = netOf(slip);

    if (slip.netPayable < 0) {
        throw new ApiError(400, 'Deductions cannot exceed the earned amount');
    }

    await slip.save();
    return slip;
};

// ---------------------------------------------------------------------------
// Throw a Draft away so it can be generated again.
//
// A slip is a SNAPSHOT: it keeps the numbers it was built from, and an
// attendance correction afterwards deliberately does not rewrite it. That is
// right for an approved slip and wrong for a draft — without this, a draft
// generated before the register was filled in was stuck with its numbers
// forever, and the only fix was editing the database by hand.
//
// Draft only. Approved and Paid stay frozen — that is what approval means.
// ---------------------------------------------------------------------------
const discard = async (id) => {
    const slip = await SalarySlip.findById(id).lean();
    if (!slip) throw new ApiError(404, 'Slip not found');

    if (slip.status !== 'Draft') {
        throw new ApiError(
            409,
            'Only a draft can be discarded — an approved slip is corrected with a separate adjustment'
        ).withCode('SLIP_LOCKED');
    }

    await SalarySlip.deleteOne({ _id: id, status: 'Draft' });

    return { discarded: id, month: slip.month, teacherName: slip.teacherName };
};

// ---------------------------------------------------------------------------
// A hand-entered line: a bonus, an arrear, a fine.
//
// Draft only, for the same reason everything else is: an approved slip is
// what the teacher was told they would be paid. A correction after that is a
// separate entry, not a quiet edit of the original.
// ---------------------------------------------------------------------------
const addAdjustment = async (id, { kind, label, amount }, actor) => {
    const slip = await SalarySlip.findById(id);
    if (!slip) throw new ApiError(404, 'Slip not found');

    if (slip.status !== 'Draft') {
        throw new ApiError(
            409,
            'An approved slip is not editable — make a correction with a separate adjustment'
        ).withCode('SLIP_LOCKED');
    }

    slip.adjustments.push({
        kind,
        label: label.trim(),
        amount: round2(amount),
        at: new Date(),
        by: actor.id,
        byName: actor.name || '',
    });

    slip.netPayable = netOf(slip);

    // A slip cannot pay out less than nothing. Without this a mistyped fine
    // would produce a negative payable that the ledger would then try to pay.
    if (slip.netPayable < 0) {
        throw new ApiError(400, 'That would take the net payable below zero');
    }

    await slip.save();
    return slip;
};

const removeAdjustment = async (id, adjustmentId) => {
    const slip = await SalarySlip.findById(id);
    if (!slip) throw new ApiError(404, 'Slip not found');

    if (slip.status !== 'Draft') {
        throw new ApiError(409, 'An approved slip is not editable').withCode('SLIP_LOCKED');
    }

    const before = slip.adjustments.length;
    slip.adjustments = slip.adjustments.filter((a) => String(a._id) !== String(adjustmentId));

    if (slip.adjustments.length === before) throw new ApiError(404, 'That line is not on this slip');

    slip.netPayable = netOf(slip);
    await slip.save();
    return slip;
};

// Approve = freeze. After this, neither an attendance correction nor a
// salary revision can change this slip.
const approve = async (id, actorId) => {
    const slip = await SalarySlip.findOneAndUpdate(
        { _id: id, status: 'Draft' },
        { $set: { status: 'Approved', approvedBy: actorId, approvedAt: new Date() } },
        { new: true }
    );

    if (!slip) {
        throw new ApiError(409, 'Only a Draft slip can be approved');
    }
    return slip;
};

// ---------------------------------------------------------------------------
// Paying salary — this is where money leaves the cash book.
// ---------------------------------------------------------------------------
const pay = async (id, { amount, mode, date, note = '' }, actorId) => {
    const slip = await SalarySlip.findById(id).lean();
    if (!slip) throw new ApiError(404, 'Slip not found');

    if (slip.status === 'Draft') {
        throw new ApiError(409, 'Approve the slip before paying it').withCode('NOT_APPROVED');
    }

    const value = round2(amount ?? round2(slip.netPayable - slip.paidAmount));
    const remaining = round2(slip.netPayable - slip.paidAmount);

    if (!(value > 0)) throw new ApiError(400, 'Amount must be greater than zero');
    if (value > remaining) throw new ApiError(400, `Only ₹${remaining} remains`);

    const session = await sessionService.getActiveSessionName();

    return withTransaction(async (mongoSession) => {
        const payDate = date || new Date();

        // ---------------------------------------------------------------------
        // The new total is computed BY THE DATABASE, from the row's own current
        // value, under a filter that refuses to overpay.
        //
        // This used to read the slip outside the transaction and then write an
        // absolute `$set: { paidAmount: slip.paidAmount + value }`. Two partial
        // payments started in the same second both read paidAmount 0, both wrote
        // their own value, and the slip ended up recording one of them — while
        // the cash book correctly recorded two rows going out. The books
        // disagreed, and nothing on any screen said so.
        //
        // A pipeline update runs its stages in order, so the second $set sees the
        // paidAmount the first one just wrote — status and paidAt therefore
        // follow the real total, not the stale one.
        // ---------------------------------------------------------------------
        const updated = await SalarySlip.findOneAndUpdate(
            {
                _id: id,
                status: { $in: ['Approved', 'Paid'] },
                // Never more than the slip promises, whatever else is in flight.
                $expr: { $lte: [{ $add: ['$paidAmount', value] }, '$netPayable'] },
            },
            [
                { $set: { paidAmount: { $round: [{ $add: ['$paidAmount', value] }, 2] } } },
                {
                    $set: {
                        // Paid only when fully paid — on a partial payment the slip
                        // stays Approved so it keeps showing on the pending list.
                        status: { $cond: [{ $gte: ['$paidAmount', '$netPayable'] }, 'Paid', 'Approved'] },
                        paidAt: { $cond: [{ $gte: ['$paidAmount', '$netPayable'] }, payDate, '$paidAt'] },
                    },
                },
            ],
            { new: true, session: mongoSession }
        );

        // The guard refused. Somebody paid this slip between the read above and
        // this write, so the ledger row must not be written either — and the
        // transaction rolls back whatever else was in flight.
        if (!updated) {
            throw new ApiError(
                409,
                'This slip was paid from somewhere else a moment ago — reopen it to see what is left'
            ).withCode('SLIP_ALREADY_PAID');
        }

        const paidAmount = round2(updated.paidAmount);

        await ledger.record(
            {
                session,
                direction: 'OUT',
                type: 'SALARY',
                amount: value,
                mode,
                txnDate: payDate,
                party: { kind: 'Teacher', ref: slip.teacher, name: slip.teacherName },
                refModel: 'SalarySlip',
                refId: slip._id,
                note: note || `Salary ${slip.month}`,
                recordedBy: actorId,
            },
            mongoSession
        );

        return {
            slipId: id,
            paid: value,
            totalPaid: paidAmount,
            remaining: round2(updated.netPayable - paidAmount),
        };
    });
};

module.exports = {
    generate,
    list,
    getById,
    update,
    addAdjustment,
    removeAdjustment,
    discard,
    approve,
    pay,
    computeSlip,
};
