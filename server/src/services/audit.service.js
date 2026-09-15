const AuditLog = require('../models/auditLog.model');
const { getPaginationParams, fetchPage } = require('../utils/paginate');

// ---------------------------------------------------------------------------
// Writing an audit entry must never fail the real work.
//
// If the audit insert fails (network blip, storage full), failing the fee
// collection would be the wrong trade-off — the money has arrived and the
// receipt is printed. So this is fire-and-forget and errors are only logged.
//
// For the same reason it never runs inside a mongoose transaction: a
// transaction means "all or nothing", and the audit should not be part of
// that "all".
// ---------------------------------------------------------------------------
const log = ({ actor, action, entity, entityId = null, summary = '', before = null, after = null, ip = '' }) => {
    if (!actor) return;

    AuditLog.create({
        actor: actor.id || actor._id,
        actorName: actor.name || '',
        actorRole: actor.role || '',
        action,
        entity,
        entityId,
        summary,
        before,
        after,
        ip,
    }).catch((err) => {
        console.error(`[audit] ${action} could not be logged: ${err.message}`);
    });
};

// Pull actor and IP off the request so controllers can log in one line
const fromRequest = (req) => ({
    actor: { id: req.userId, name: req.user?.name, role: req.role },
    ip: req.ip || '',
});

// ---------------------------------------------------------------------------
// EDIT HISTORY
//
// The fields worth remembering per entity. Deliberately a list rather than
// "the whole document": an audit row that copies every field grows storage at
// the same rate as the real data, and nobody ever asks who changed
// `updatedAt`. These are the fields somebody could be asked to explain.
//
// A field NOT on this list is simply not tracked — so adding one here is all
// it takes to start tracking it.
// ---------------------------------------------------------------------------
const TRACKED = {
    Student: ['name', 'dob', 'phone', 'altPhone', 'guardianName', 'motherName', 'address', 'class', 'className', 'monthlyFee', 'status', 'leftAt', 'leftReason'],
    Teacher: ['name', 'phone', 'designation', 'monthlySalary', 'lateAllowance', 'joiningDate', 'status', 'bankDetails'],
    SchoolClass: ['name', 'section', 'order', 'monthlyFee', 'isActive'],
    StockItem: ['name', 'category', 'unit', 'sellPrice', 'costPrice', 'lowStockAt', 'hasVariants', 'variants', 'isActive'],
    Vendor: ['name', 'phone', 'gstin', 'address', 'isActive'],
    Expense: ['title', 'paidTo', 'note', 'attachments'],
    Purchase: ['billDate', 'note', 'billImage'],
    Lead: ['name', 'guardianName', 'phone', 'altPhone', 'address', 'classInterested', 'source', 'status', 'nextFollowUp', 'note'],
    AcademicSession: ['name', 'startDate', 'endDate', 'feeMonths', 'isActive', 'idCardFee', 'openingBalance'],
    ExpenseCategory: ['name', 'isActive'],
    SalarySlip: ['advance', 'deductions', 'note', 'status', 'paidAmount', 'netPayable'],
    User: ['name', 'email', 'phone', 'role', 'isActive'],
};

// Dates, ObjectIds and plain values all have to compare correctly, or every
// save would look like a change and the history would be noise.
const same = (a, b) => {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
    if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
    return String(a) === String(b);
};

// A value as it should read on the history screen. Long text and arrays are
// summarised — the full value is still in before/after for anyone who expands
// the row.
const describe = (value) => {
    if (value === null || value === undefined || value === '') return '—';
    if (value instanceof Date) return new Date(value).toISOString().slice(0, 10);
    if (Array.isArray(value)) return `${value.length} item(s)`;
    if (typeof value === 'object') return '…';
    const text = String(value);
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
};

// What actually changed. Fields the update never mentioned are skipped, so a
// PATCH of one field does not record the other twenty as "unchanged".
const diff = (before, after, fields) => {
    const keys = fields?.length
        ? fields
        : [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];

    const from = {};
    const to = {};
    const changed = [];

    for (const key of keys) {
        const was = before?.[key];
        const now = after?.[key];

        if (now === undefined) continue; // the update did not touch this field
        if (same(was, now)) continue;

        from[key] = was === undefined ? null : was;
        to[key] = now;
        changed.push(key);
    }

    return changed.length ? { before: from, after: to, changed } : null;
};

// The state of a document BEFORE an edit. Controllers call this, then the
// service, then logEdit — one extra read on the edit path only, which is not
// a hot path and is worth an answer to "who changed this".
const snapshot = (Model, id, entity) => {
    const fields = TRACKED[entity];
    const query = Model.findById(id);
    return (fields ? query.select(fields.join(' ')) : query).lean();
};

// ---------------------------------------------------------------------------
// Record an edit — but only when something genuinely changed.
//
// Saving a form without touching anything must not produce a history row;
// otherwise the screen fills with entries that say nothing and the real
// changes become hard to find.
// ---------------------------------------------------------------------------
const logEdit = (req, { action, entity, entityId, label = '', before, after }) => {
    const plain = after?.toObject?.() ?? after;
    const change = diff(before, plain, TRACKED[entity]);

    if (!change) return null;

    const detail = change.changed
        .map((key) => `${key}: ${describe(change.before[key])} → ${describe(change.after[key])}`)
        .join(', ');

    log({
        ...fromRequest(req),
        action,
        entity,
        entityId,
        summary: `${label ? `${label} — ` : ''}${detail}`.slice(0, 500),
        before: change.before,
        after: change.after,
    });

    return change;
};

// Only the tracked fields off a document — the same rule as an edit.
const pick = (doc, fields) => {
    const plain = doc?.toObject?.() ?? doc;
    if (!plain) return null;
    if (!fields?.length) return plain;
    return Object.fromEntries(fields.filter((k) => plain[k] !== undefined).map((k) => [k, plain[k]]));
};

// A create or a delete — there is no diff, just the record itself.
const logCreate = (req, { action, entity, entityId, label = '', after = null }) =>
    log({
        ...fromRequest(req),
        action,
        entity,
        entityId,
        summary: label,
        after: after ? pick(after, TRACKED[entity]) : null,
    });

const logDelete = (req, { action, entity, entityId, label = '', before = null }) =>
    log({
        ...fromRequest(req),
        action,
        entity,
        entityId,
        summary: label,
        before: before ? pick(before, TRACKED[entity]) : null,
    });

// ---------------------------------------------------------------------------
// Reading the history. Until this existed the collection was written to and
// never read — the trail was there but nobody could see it.
// ---------------------------------------------------------------------------
const list = async (query = {}) => {
    const { page, limit } = getPaginationParams(query);

    const filter = {};
    if (query.entity) filter.entity = query.entity;
    if (query.entityId) filter.entityId = query.entityId;
    if (query.actor) filter.actor = query.actor;
    // A prefix, so 'fee' brings back fee.collect, fee.discount and fee.void.
    // Anchored, so it can still walk the action index.
    if (query.action) filter.action = new RegExp(`^${String(query.action).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

    if (query.from || query.to) {
        filter.createdAt = {};
        if (query.from) filter.createdAt.$gte = new Date(query.from);
        if (query.to) filter.createdAt.$lte = new Date(query.to);
    }

    return fetchPage(AuditLog.find(filter).sort({ createdAt: -1 }), { page, limit, withTotal: true });
};

// One record's own history — for a "who changed this student" panel.
const forEntity = (entity, entityId, limit = 50) =>
    AuditLog.find({ entity, entityId }).sort({ createdAt: -1 }).limit(limit).lean();

module.exports = {
    log,
    logEdit,
    logCreate,
    logDelete,
    fromRequest,
    snapshot,
    diff,
    list,
    forEntity,
    TRACKED,
};
