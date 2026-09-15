const SchoolClass = require('../models/schoolClass.model');
const Student = require('../models/student.model');
const FeeDemand = require('../models/feeDemand.model');
const Transaction = require('../models/transaction.model');
const MonthlyRollup = require('../models/monthlyRollup.model');
const ClassAttendance = require('../models/classAttendance.model');
const ApiError = require('../utils/ApiError');
const sessionService = require('./session.service');

// The label every denormalised copy carries. Built in one place so the
// "Class 5 – A" format cannot drift between the class document and the six
// collections that store a copy of it.
const labelOf = (cls) => `${cls.name} – ${cls.section}`;

// A query-string flag arrives as the STRING 'true' or 'false', and 'false' is
// truthy — so `if (!includeInactive)` skipped the isActive filter for
// ?includeInactive=false and returned exactly what the caller asked to exclude.
const isTrue = (v) => v === true || v === 'true';

const list = async (query = {}) => {
    const session = await sessionService.getActiveSessionName();

    const filter = { session };
    if (!isTrue(query.includeInactive)) filter.isActive = true;

    // In the school's own order — "Class 10" sorts before "Class 2"
    // alphabetically, which looks wrong in every dropdown.
    return SchoolClass.find(filter).sort({ order: 1 }).lean();
};

const getById = async (id) => {
    const doc = await SchoolClass.findById(id).lean();
    if (!doc) throw new ApiError(404, 'Class not found');
    return doc;
};

const create = async (payload) => {
    const session = await sessionService.getActiveSessionName();

    // if no order was given, append at the end
    let { order } = payload;
    if (order === undefined || order === null) {
        const last = await SchoolClass.findOne({ session }).sort({ order: -1 }).select('order').lean();
        order = (last?.order || 0) + 1;
    }

    // A duplicate "Class 5 - A" is blocked at the DB level too (unique index),
    // but a clear message here is better.
    const exists = await SchoolClass.exists({
        session,
        name: payload.name,
        section: payload.section.toUpperCase(),
    });
    if (exists) throw new ApiError(409, `${payload.name} – ${payload.section} already exists`);

    return SchoolClass.create({ ...payload, session, order });
};

// ---------------------------------------------------------------------------
// Renaming a class rewrites its label everywhere it was denormalised.
//
// `className` is stored as a copy on Student, FeeDemand, Transaction,
// MonthlyRollup and ClassAttendance — that is what keeps every list and report
// free of a $lookup. The cost is that a rename has to reach all five, or the
// class shows under its new name in the dropdown and its old one on every
// receipt, report and roster ever written.
//
// This is NOT the same thing as a student moving class. There, the old label is
// correct history and is deliberately left alone (see student.service.update).
// Here it is the SAME class with a corrected name, so every copy should follow.
//
// Deliberately outside a transaction: each write is an idempotent $set of a
// derived label over committed data, so a half-finished rename is repaired by
// saving the class again — it never needs to hold a transaction open across
// five collections.
// ---------------------------------------------------------------------------
const update = async (id, updates) => {
    const doc = await SchoolClass.findById(id);
    if (!doc) throw new ApiError(404, 'Class not found');

    const before = labelOf(doc);

    // Changing monthlyFee applies only to FUTURE months. Demands already
    // raised stay as they are — otherwise last month's raised amount would
    // change today and the report would quietly tell a different story.
    Object.assign(doc, updates);
    await doc.save();

    const after = labelOf(doc);

    if (after !== before) {
        const set = { $set: { className: after } };
        await Promise.all([
            Student.updateMany({ class: doc._id }, set),
            FeeDemand.updateMany({ class: doc._id }, set),
            Transaction.updateMany({ class: doc._id }, set),
            MonthlyRollup.updateMany({ class: doc._id }, set),
            ClassAttendance.updateMany({ class: doc._id }, set),
        ]);
    }

    return doc;
};

// A class is never deleted, only deactivated — and only when it holds no
// active students.
const deactivate = async (id) => {
    const doc = await SchoolClass.findById(id);
    if (!doc) throw new ApiError(404, 'Class not found');

    const active = await Student.countDocuments({ class: id, status: 'Active' });
    if (active > 0) {
        throw new ApiError(
            409,
            `This class has ${active} active students — move them elsewhere first`
        );
    }

    doc.isActive = false;
    await doc.save();
    return doc;
};

module.exports = { list, getById, create, update, deactivate };
