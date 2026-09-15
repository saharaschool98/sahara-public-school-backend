const { z } = require('zod');
const { objectId, optionalId, money, positiveMoney, paymentMode, dateish, pagination, reason } = require('./common');

// ---- heads ----

const createHeadSchema = z.object({
    name: z.string().trim().min(2, 'Enter the head name').max(60),
    defaultAmount: money.optional(),
});

const updateHeadSchema = z
    .object({
        name: z.string().trim().min(2).max(60).optional(),
        defaultAmount: money.optional(),
        isActive: z.boolean().optional(),
    })
    .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

const listHeadsSchema = z.object({
    includeInactive: z.enum(['true', 'false']).optional(),
});

// ---- raising ----

// The three ways a charge lands, and each carries exactly what it needs:
// SCHOOL takes nothing, CLASS takes classes, STUDENT takes students. Validating
// that pairing here means the service never has to guess what the caller meant.
const raiseSchema = z
    .object({
        headId: objectId,
        title: z.string().trim().min(2, 'Say what this is for').max(120),
        // 0 is allowed: a charge recorded for the roll without money attached
        // (a free trip somebody still has to be listed for).
        amount: money,
        dueDate: dateish.optional(),
        scope: z.enum(['SCHOOL', 'CLASS', 'STUDENT']),
        classIds: z.array(objectId).max(50).optional(),
        studentIds: z.array(objectId).max(500).optional(),
        note: z.string().trim().max(300).optional().or(z.literal('')),
    })
    .refine((d) => d.scope !== 'CLASS' || (d.classIds && d.classIds.length > 0), {
        message: 'Choose at least one class',
        path: ['classIds'],
    })
    .refine((d) => d.scope !== 'STUDENT' || (d.studentIds && d.studentIds.length > 0), {
        message: 'Choose at least one student',
        path: ['studentIds'],
    });

const listChargesSchema = z.object({
    ...pagination,
    head: optionalId,
    status: z.enum(['open', 'all']).optional().or(z.literal('')).transform((v) => v || undefined),
});

const listDemandsSchema = z.object({
    ...pagination,
    status: z.enum(['Unpaid', 'Partial', 'Paid']).optional().or(z.literal('')).transform((v) => v || undefined),
});

// ---- money ----

const collectSchema = z.object({
    studentId: objectId,
    amount: positiveMoney,
    mode: paymentMode,
    txnDate: dateish.optional(),
    note: z.string().trim().max(200).optional().or(z.literal('')),
});

const discountSchema = z.object({ amount: positiveMoney, reason });

const cancelSchema = z.object({ reason });

const studentIdParamSchema = z.object({ studentId: objectId });

module.exports = {
    createHeadSchema,
    updateHeadSchema,
    listHeadsSchema,
    raiseSchema,
    listChargesSchema,
    listDemandsSchema,
    collectSchema,
    discountSchema,
    cancelSchema,
    studentIdParamSchema,
};
