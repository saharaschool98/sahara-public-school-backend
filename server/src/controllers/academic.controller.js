const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const sessionService = require('../services/session.service');
const classService = require('../services/class.service');
const studentService = require('../services/student.service');
const rolloverService = require('../services/rollover.service');
const audit = require('../services/audit.service');
// Only for the BEFORE snapshot on an edit — the write itself stays in the
// service. See audit.service.js for why the snapshot is taken here.
const AcademicSession = require('../models/academicSession.model');
const SchoolClass = require('../models/schoolClass.model');
const Student = require('../models/student.model');

// ---- academic session ----

const listSessions = asyncHandler(async (_req, res) => {
    const data = await sessionService.list();
    return res.status(200).json(new ApiResponse(200, data, 'Sessions'));
});

const getActiveSession = asyncHandler(async (_req, res) => {
    const data = await sessionService.getActiveSession();
    return res.status(200).json(new ApiResponse(200, data, 'Active session'));
});

const createSession = asyncHandler(async (req, res) => {
    const data = await sessionService.create(req.body);

    audit.logCreate(req, {
        action: 'session.create',
        entity: 'AcademicSession',
        entityId: data._id,
        label: `${data.name} created`,
        after: data,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Session created'));
});

const activateSession = asyncHandler(async (req, res) => {
    const data = await sessionService.activate(req.params.id);

    audit.log({
        ...audit.fromRequest(req),
        action: 'session.activate',
        entity: 'AcademicSession',
        entityId: data._id,
        summary: `${data.name} activated`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Session activated'));
});

const updateSession = asyncHandler(async (req, res) => {
    const before = await audit.snapshot(AcademicSession, req.params.id, 'AcademicSession');
    const data = await sessionService.update(req.params.id, req.body);

    audit.logEdit(req, {
        action: 'session.update',
        entity: 'AcademicSession',
        entityId: data._id,
        label: data.name,
        before,
        after: data,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Session updated'));
});

// ---- session rollover ----

// Read-only. Nothing here changes anything — it is the answer to "what would
// happen", which is the question somebody should be able to ask before moving
// a whole school.
const rolloverPlan = asyncHandler(async (req, res) => {
    const data = await rolloverService.plan(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Rollover plan'));
});

const rolloverClasses = asyncHandler(async (req, res) => {
    const data = await rolloverService.copyClasses(req.params.id);

    if (data.created) {
        audit.log({
            ...audit.fromRequest(req),
            action: 'session.rollover.classes',
            entity: 'AcademicSession',
            entityId: req.params.id,
            summary: `${data.created} classes copied forward`,
        });
    }

    return res.status(200).json(new ApiResponse(200, data, data.created ? 'Classes copied' : data.message));
});

// The single largest write in the app, so the audit line carries every figure
// somebody could be asked about later: who moved, what they owed, and what the
// school was holding for them.
const rolloverPromote = asyncHandler(async (req, res) => {
    const data = await rolloverService.promote(req.params.id, req.body, { id: req.userId });

    if (data.promoted) {
        audit.log({
            ...audit.fromRequest(req),
            action: 'session.rollover.promote',
            entity: 'AcademicSession',
            entityId: req.params.id,
            summary: `${data.promoted} students promoted from ${data.from} to ${data.to}`
                + (data.arrears ? ` — ₹${data.arrears.total} of arrears carried for ${data.arrears.students}` : '')
                + (data.creditCarried ? ` — ₹${data.creditCarried} of advance carried` : ''),
            after: {
                promoted: data.promoted,
                arrears: data.arrears?.total || 0,
                creditCarried: data.creditCarried,
            },
        });
    }

    return res.status(200).json(
        new ApiResponse(200, data, data.promoted ? 'Students promoted' : data.message)
    );
});

// ---- classes ----

const listClasses = asyncHandler(async (req, res) => {
    const data = await classService.list(req.query);
    // No Cache-Control here, deliberately.
    //
    // This list is EDITED from the same screen that reads it, and a browser's
    // HTTP cache cannot be invalidated: react-query would refetch on a save, the
    // browser would answer from its own 60-second copy, and the change would
    // simply not appear until it expired. TanStack Query already caches this
    // (staleTime), and that cache CAN be invalidated — which is the whole point.
    // (Classes change rarely, which is what the header was for — but rarely is
    // not never, and the one moment it matters is the moment somebody edits a
    // class fee and the screen keeps showing the old one.)
    return res.status(200).json(new ApiResponse(200, data, 'Classes'));
});

const createClass = asyncHandler(async (req, res) => {
    const data = await classService.create(req.body);

    audit.logCreate(req, {
        action: 'class.create',
        entity: 'SchoolClass',
        entityId: data._id,
        label: `${data.name} – ${data.section} created at ₹${data.monthlyFee}/month`,
        after: data,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Class created'));
});

// The monthly fee is edited straight from a cell on the Settings screen, so
// this is the one place that answers "who put this class on ₹1,200".
const updateClass = asyncHandler(async (req, res) => {
    const before = await audit.snapshot(SchoolClass, req.params.id, 'SchoolClass');
    const data = await classService.update(req.params.id, req.body);

    audit.logEdit(req, {
        action: 'class.update',
        entity: 'SchoolClass',
        entityId: data._id,
        label: `${data.name} – ${data.section}`,
        before,
        after: data,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Class updated'));
});

const deactivateClass = asyncHandler(async (req, res) => {
    const data = await classService.deactivate(req.params.id);

    audit.logDelete(req, {
        action: 'class.deactivate',
        entity: 'SchoolClass',
        entityId: data._id,
        label: `${data.name} – ${data.section} deactivated`,
        before: data,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Class deactivated'));
});

// ---- students ----

const listStudents = asyncHandler(async (req, res) => {
    const data = await studentService.list(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Students'));
});

const getStudent = asyncHandler(async (req, res) => {
    const data = await studentService.getById(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Student'));
});

const getStudentLedger = asyncHandler(async (req, res) => {
    const data = await studentService.getLedger(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Student ledger'));
});

const createStudent = asyncHandler(async (req, res) => {
    const data = await studentService.create(req.body, req.userId);

    audit.logCreate(req, {
        action: 'student.create',
        entity: 'Student',
        entityId: data._id,
        label: `${data.name} (${data.admissionNo}) admitted to ${data.className} at ₹${data.monthlyFee}/month`,
        after: data,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Student added'));
});

// A class change and a fee change both land here, and both are questions
// somebody gets asked later — "why is this child on ₹800" and "when did they
// move to 6-B". The before/after answers them with a name against it.
const updateStudent = asyncHandler(async (req, res) => {
    const before = await audit.snapshot(Student, req.params.id, 'Student');
    const data = await studentService.update(req.params.id, req.body, req.userId);

    audit.logEdit(req, {
        action: 'student.update',
        entity: 'Student',
        entityId: data._id,
        label: `${data.name} (${data.admissionNo})`,
        before,
        after: data,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Student updated'));
});

// Both directions of money get named in the summary line. "₹0 still
// outstanding" reads as settled, and it is not settled when the school is
// holding ₹2,000 of theirs — that is the half nobody chases, because nobody is
// waiting for it.
const leavingSummary = (data) =>
    [
        `₹${data.outstandingCarried} still outstanding`,
        data.creditHeld > 0 ? `₹${data.creditHeld} still held in advance` : null,
    ]
        .filter(Boolean)
        .join(', ');

const markStudentLeft = asyncHandler(async (req, res) => {
    const data = await studentService.markLeft(req.params.id, req.body);

    // Nothing changed — they were already Left. Logging it would fill the
    // history with entries that record nothing, which is how the real ones
    // become hard to find.
    if (!data.alreadyLeft) {
        audit.log({
            ...audit.fromRequest(req),
            action: 'student.left',
            entity: 'Student',
            entityId: req.params.id,
            summary: `${data.student.name} (${data.student.admissionNo}) marked as Left`
                + `${req.body.reason ? ` — ${req.body.reason}` : ''} — ${leavingSummary(data)}`,
        });
    }

    return res.status(200).json(
        new ApiResponse(200, data, data.alreadyLeft ? 'This student had already left' : 'Student marked as Left')
    );
});

// ---- transfer certificate ----

// The audit line carries the TC number and the dues it was issued over. That
// second half is the whole point of the override existing: a certificate handed
// out with ₹5,000 unpaid is a decision, and a decision with nobody's name on it
// is indistinguishable from an accident.
const issueTC = asyncHandler(async (req, res) => {
    const data = await studentService.issueTC(req.params.id, req.body, { id: req.userId });

    audit.log({
        ...audit.fromRequest(req),
        action: 'student.tc.issue',
        entity: 'Student',
        entityId: req.params.id,
        summary: `${data.tcNo} issued to ${data.name} (${data.admissionNo}, ${data.className})`
            + `${data.reason ? ` — ${data.reason}` : ''}`
            + `${data.markedLeft ? ' — also marked as Left' : ''}`
            + `${data.duesAtIssue > 0 ? ` — issued over ₹${data.duesAtIssue} still outstanding` : ''}`
            + `${data.creditAtIssue > 0 ? ` — ₹${data.creditAtIssue} still held in advance` : ''}`,
        after: { tcNo: data.tcNo, duesAtIssue: data.duesAtIssue, creditAtIssue: data.creditAtIssue },
    });

    return res.status(201).json(new ApiResponse(201, data, 'Transfer certificate issued'));
});

const cancelTC = asyncHandler(async (req, res) => {
    const data = await studentService.cancelTC(req.params.id, req.body.reason);

    audit.log({
        ...audit.fromRequest(req),
        action: 'student.tc.cancel',
        entity: 'Student',
        entityId: req.params.id,
        // The number is recorded HERE and nowhere else — the student's own
        // record is cleared so the next certificate can be issued, and the
        // counter never hands this number out again. This line is the only
        // place anybody can be told what TC0007 was.
        summary: `${data.tcNo} cancelled for ${data.name} — ${req.body.reason}`
            + `${data.restoredToRoster ? ' — put back on the roster' : ''}`,
        before: { tcNo: data.tcNo },
    });

    return res.status(200).json(new ApiResponse(200, data, 'Transfer certificate cancelled'));
});

// ---- siblings ----

// Linking is an edit to BOTH records, so it rides on `student.edit` rather than
// adding a 48th permission key for something nobody would grant separately.
const linkSibling = asyncHandler(async (req, res) => {
    const data = await studentService.linkSibling(req.params.id, req.body.siblingId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'student.sibling.link',
        entity: 'Student',
        entityId: req.params.id,
        summary: data.merged
            ? `${data.student.name} and ${data.sibling.name} linked — two families merged, ${data.members.length} siblings now`
            : `${data.student.name} and ${data.sibling.name} (${data.sibling.admissionNo}) linked as siblings`,
        after: { siblings: data.members.map((m) => `${m.name} (${m.admissionNo})`) },
    });

    return res.status(200).json(new ApiResponse(200, data, 'Siblings linked'));
});

const unlinkSibling = asyncHandler(async (req, res) => {
    const data = await studentService.unlinkSibling(req.params.id, req.params.siblingId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'student.sibling.unlink',
        entity: 'Student',
        entityId: req.params.id,
        summary: `${data.removed.name} unlinked from ${data.from}`
            + (data.remaining === 0 ? ' — no siblings left on either side' : ''),
    });

    return res.status(200).json(new ApiResponse(200, data, 'Sibling removed'));
});

// ---- ID cards ----

// Handing a card over and taking the money is one act, so it is one endpoint.
const issueIdCard = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name, role: req.role };
    const data = await studentService.issueIdCard(req.params.id, req.body, actor);

    audit.log({
        ...audit.fromRequest(req),
        action: 'student.idcard.issue',
        entity: 'Student',
        entityId: req.params.id,
        summary: data.amount > 0
            ? `${data.name} (${data.admissionNo}) — ID card issued, ₹${data.amount} (${data.mode})`
            : `${data.name} (${data.admissionNo}) — ID card issued free of charge`,
        after: { issued: true, amount: data.amount },
    });

    return res.status(201).json(new ApiResponse(201, data, 'ID card issued'));
});

const cancelIdCard = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name, role: req.role };
    const data = await studentService.cancelIdCard(req.params.id, req.body.reason, actor);

    audit.log({
        ...audit.fromRequest(req),
        action: 'student.idcard.cancel',
        entity: 'Student',
        entityId: req.params.id,
        summary: `${data.name} — ID card cancelled: ${req.body.reason}`
            + (data.refunded ? ` (₹${data.refunded} reversed)` : ''),
        before: { issued: true, amount: data.refunded },
        after: { issued: false },
    });

    return res.status(200).json(new ApiResponse(200, data, 'ID card cancelled'));
});

// Class-wise: taken, not taken, and what came in.
const idCardSummary = asyncHandler(async (_req, res) => {
    const data = await studentService.idCardSummary();
    return res.status(200).json(new ApiResponse(200, data, 'ID card summary'));
});

const defaulters = asyncHandler(async (req, res) => {
    const data = await studentService.defaulters(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Defaulters'));
});

module.exports = {
    listSessions,
    getActiveSession,
    createSession,
    activateSession,
    rolloverPlan,
    rolloverClasses,
    rolloverPromote,
    updateSession,
    listClasses,
    createClass,
    updateClass,
    deactivateClass,
    listStudents,
    getStudent,
    getStudentLedger,
    createStudent,
    updateStudent,
    markStudentLeft,
    linkSibling,
    unlinkSibling,
    issueIdCard,
    cancelIdCard,
    idCardSummary,
    issueTC,
    cancelTC,
    defaulters,
};
