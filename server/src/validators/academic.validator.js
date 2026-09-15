const { z } = require('zod');
const { objectId, optionalId, monthKey, phone, money, paymentMode, dateish, pagination, reason } = require('./common');

// ---- session ----

// What the school already had when the session opened, per mode. Every field
// optional: most schools know the cash and the bank on day one and fill the
// rest in later.
const openingBalance = z.object({
    Cash: money.optional(),
    UPI: money.optional(),
    Bank: money.optional(),
    Cheque: money.optional(),
});

const createSessionSchema = z.object({
    name: z
        .string()
        .trim()
        .regex(/^\d{4}-\d{2}$/, 'Session must be in 2026-27 format'),
    startDate: dateish,
    endDate: dateish,
    feeMonths: z.array(monthKey).max(12).optional(),
    idCardFee: money.optional(),
    openingBalance: openingBalance.optional(),
});

const updateSessionSchema = z.object({
    startDate: dateish.optional(),
    endDate: dateish.optional(),
    feeMonths: z.array(monthKey).max(12).optional(),
    idCardFee: money.optional(),
    // A partial object is fine — the service flattens it to dotted paths, so
    // sending only { Cash } cannot wipe the bank balance. See session.service.
    openingBalance: openingBalance.partial().optional(),
});

// ---- class ----

const createClassSchema = z.object({
    name: z.string().trim().min(1, 'Enter the class name'),
    section: z.string().trim().min(1, 'Enter the section').max(4).toUpperCase(),
    monthlyFee: money,
    order: z.number().int().nonnegative().optional(),
});

const updateClassSchema = z.object({
    name: z.string().trim().min(1).optional(),
    section: z.string().trim().min(1).max(4).toUpperCase().optional(),
    monthlyFee: money.optional(),
    order: z.number().int().nonnegative().optional(),
    isActive: z.boolean().optional(),
});

// ---- student ----

const createStudentSchema = z.object({
    name: z.string().trim().min(2, "Enter the student's name"),
    guardianName: z.string().trim().max(100).optional().or(z.literal('')),
    motherName: z.string().trim().max(100).optional().or(z.literal('')),
    // Optional on admission — the office often does not have the certificate in
    // hand that day — but a transfer certificate prints it, so it is asked for.
    dob: dateish.optional(),
    phone,
    altPhone: phone.optional().or(z.literal('')),
    address: z.string().trim().max(300).optional().or(z.literal('')),
    class: objectId,
    // If omitted, the class default applies
    monthlyFee: money.optional(),
    admissionDate: dateish,
});

const updateStudentSchema = z
    .object({
        name: z.string().trim().min(2).optional(),
        guardianName: z.string().trim().max(100).optional().or(z.literal('')),
        motherName: z.string().trim().max(100).optional().or(z.literal('')),
        dob: dateish.optional(),
        phone: phone.optional(),
        altPhone: phone.optional().or(z.literal('')),
        address: z.string().trim().max(300).optional().or(z.literal('')),
        class: objectId.optional(),
        monthlyFee: money.optional(),
    })
    .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

const listStudentsSchema = z.object({
    ...pagination,
    class: optionalId,
    status: z.enum(['Active', 'Left']).optional(),
    search: z.string().trim().max(60).optional(),
    hasDues: z.enum(['true', 'false']).optional(),
    // 'issued' / 'pending' — who has taken their ID card and who has not
    idCard: z.enum(['issued', 'pending']).optional().or(z.literal('')).transform((v) => v || undefined),
    // The same, for transfer certificates. With status=Left this is the whole
    // TC working list: who has gone and has not been given theirs.
    tc: z.enum(['given', 'pending']).optional().or(z.literal('')).transform((v) => v || undefined),
});

// Amount is optional: left out, the session's idCardFee applies. 0 is valid and
// means a free card — the flag is set and no ledger row is written.
const issueIdCardSchema = z.object({
    amount: money.optional(),
    mode: paymentMode.optional(),
    date: dateish.optional(),
    note: z.string().trim().max(200).optional().or(z.literal('')),
});

const cancelIdCardSchema = z.object({ reason });

// ---- transfer certificate ----

// Marking a student left. The reason is optional, because the office does not
// always know it on the day — but when they do, it is what the TC prints.
const markLeftSchema = z.object({
    reason: z.string().trim().max(300).optional().or(z.literal('')),
    leftAt: dateish.optional(),
});

// `issueAnyway` is the override for unpaid dues or an advance still held. It is
// a deliberate tick, never a default — see studentService.issueTC.
const issueTcSchema = z.object({
    reason: z.string().trim().max(300).optional().or(z.literal('')),
    conduct: z.string().trim().max(60).optional().or(z.literal('')),
    note: z.string().trim().max(300).optional().or(z.literal('')),
    issuedAt: dateish.optional(),
    issueAnyway: z.boolean().optional(),
});

const cancelTcSchema = z.object({ reason });

// ---- siblings ----

const linkSiblingSchema = z.object({ siblingId: objectId });

// Both params, because validate() assigns the PARSED object back over
// req.params and zod strips whatever the schema does not mention — reusing
// idParamSchema here would silently delete req.params.siblingId.
const siblingParamsSchema = z.object({ id: objectId, siblingId: objectId });

// ---- session rollover ----
//
// `mapping` is { sourceClassId: targetClassId | null }. A null is a decision —
// those students are finishing — and an absent key is a decision not yet made;
// the service treats them differently, so the schema allows both.
const rolloverSchema = z.object({
    // The VALUE may be an id, null, or the empty string a <select> sends for
    // its "Finishing — do not promote" option. All three mean the same thing to
    // the service, and the schema meets the form where it actually is — the
    // same reason `optionalId` accepts '' rather than making every list screen
    // strip it first.
    mapping: z.record(objectId, z.union([objectId, z.literal(''), z.null()])),
    carryDues: z.boolean().optional(),
    carryCredit: z.boolean().optional(),
});

const idParamSchema = z.object({ id: objectId });

module.exports = {
    createSessionSchema,
    updateSessionSchema,
    createClassSchema,
    updateClassSchema,
    createStudentSchema,
    updateStudentSchema,
    listStudentsSchema,
    issueIdCardSchema,
    cancelIdCardSchema,
    markLeftSchema,
    issueTcSchema,
    cancelTcSchema,
    linkSiblingSchema,
    siblingParamsSchema,
    rolloverSchema,
    idParamSchema,
};
