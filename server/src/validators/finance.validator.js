const { z } = require('zod');
const {
    objectId,
    monthKey,
    money,
    positiveMoney,
    paymentMode,
    imageRef,
    dateish,
    pagination,
    reason,
    phone,
} = require('./common');

// ---- fees ----

const generateFeesSchema = z.object({
    month: monthKey,
    // To run it for a single class
    classId: objectId.optional(),
});

const collectFeeSchema = z.object({
    studentId: objectId,
    amount: positiveMoney,
    mode: paymentMode,
    txnDate: dateish.optional(),
    note: z.string().trim().max(200).optional(),
});

const discountSchema = z.object({
    amount: positiveMoney,
    reason,
});

const voidSchema = z.object({ reason });

// Handing an advance back. A mode because the money physically leaves by some
// route, and a reason because it always does for money going out.
const refundCreditSchema = z.object({
    amount: positiveMoney,
    mode: paymentMode,
    reason,
});

// /fees/pending/:studentId names its param studentId, so idParamSchema (which
// only mentions `id`) cannot validate it — and because validate() assigns the
// PARSED object back over req.params, reusing it would have deleted the param
// outright.
const studentIdParamSchema = z.object({ studentId: objectId });

// The month is the whole query. Without it the aggregation matched
// `month: undefined`, which serialises to null, matches nothing, and answered
// an empty report instead of saying what was missing.
const byCategorySchema = z.object({ month: monthKey });

// The dashboard's period. Anything else — or nothing — means the month, which
// is what this screen has always shown.
const dashboardSchema = z.object({
    period: z.enum(['today', 'week', 'month']).optional().or(z.literal('')).transform((v) => v || undefined),
});

// The day book, over a date range. Both ends optional: nothing at all means
// today (the dashboard's "Today" card relies on that), and one end alone means
// that single day. The service caps how wide the range may be — see
// MAX_DAYBOOK_DAYS.
const daybookSchema = z.object({
    from: dateish.optional(),
    to: dateish.optional(),
});

// The cash book. `session` is optional — left out, the active one is used;
// given, it opens that year's book. The empty string is turned into "not
// given", because a <select> whose first option is "current session" sends one.
const cashbookSchema = z.object({
    session: z
        .string()
        .trim()
        .regex(/^\d{4}-\d{2}$/, 'Session must be in 2026-27 format')
        .optional()
        .or(z.literal(''))
        .transform((v) => v || undefined),
});

// The picker asks for live heads only; the management list asks for all of them.
const listCategoriesSchema = z.object({
    includeInactive: z.enum(['true', 'false']).optional(),
});

const listDemandsSchema = z.object({
    ...pagination,
    month: monthKey.optional(),
    class: objectId.optional(),
    student: objectId.optional(),
    status: z.enum(['Unpaid', 'Partial', 'Paid']).optional(),
});

// ---- payment verification ----

// Every filter optional: no date means today, no status means the whole day.
// An empty string comes from a <select> set back to "all" and means "no filter",
// not "invalid" — so it is turned into undefined rather than rejected.
const listPaymentsSchema = z.object({
    ...pagination,
    date: dateish.optional(),
    status: z
        .enum(['all', 'pending', 'verified'])
        .optional()
        .or(z.literal(''))
        .transform((v) => v || undefined),
});

// Correcting an entry nobody has signed off yet. Every field optional, but at
// least one has to be there — a PATCH that changes nothing should be told so
// rather than quietly writing an empty history row.
//
// `paymentMode` and not the Transaction enum: 'Adjustment' is a bookkeeping
// mode for money that never moved, and no counter slip is ever one.
//
// The amount has no ceiling here, deliberately. What a receipt may be raised to
// depends on what the student still owes or what the bill comes to, and only
// the module holding those records knows it — a number invented in a validator
// would either be wrong or would have to be kept in step with four services.
// They refuse with the real figure instead.
const updatePaymentSchema = z
    .object({
        mode: paymentMode.optional(),
        note: z.string().trim().max(200).optional().or(z.literal('')),
        amount: positiveMoney.optional(),
    })
    .refine((d) => Object.keys(d).length > 0, 'Change the amount, the mode or the note');

// ---- expenses ----

const createExpenseSchema = z.object({
    categoryId: objectId,
    title: z.string().trim().min(2, 'Describe what this expense is for').max(120),
    amount: positiveMoney,
    date: dateish.optional(),
    mode: paymentMode,
    paidTo: z.string().trim().max(100).optional().or(z.literal('')),
    attachments: z.array(imageRef).max(5).optional(),
    note: z.string().trim().max(300).optional().or(z.literal('')),
});

const updateExpenseSchema = z.object({
    title: z.string().trim().min(2).max(120).optional(),
    paidTo: z.string().trim().max(100).optional().or(z.literal('')),
    note: z.string().trim().max(300).optional().or(z.literal('')),
    attachments: z.array(imageRef).max(5).optional(),
});

const categorySchema = z.object({
    name: z.string().trim().min(2, 'Enter the category name').max(60),
});

// Renaming a head, or retiring one. `isActive: false` keeps it off the picker
// while every expense already filed under it stays exactly where it is.
const updateCategorySchema = z
    .object({
        name: z.string().trim().min(2, 'Enter the category name').max(60).optional(),
        isActive: z.boolean().optional(),
    })
    .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

// ---- vendors ----

const createVendorSchema = z.object({
    name: z.string().trim().min(2, 'Enter the vendor name').max(120),
    phone: phone.optional().or(z.literal('')),
    gstin: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'GSTIN is not valid')
        .optional()
        .or(z.literal('')),
    address: z.string().trim().max(300).optional().or(z.literal('')),
});

const updateVendorSchema = createVendorSchema.partial();

const payVendorSchema = z.object({
    vendorId: objectId,
    amount: positiveMoney,
    mode: paymentMode,
    refNo: z.string().trim().max(60).optional().or(z.literal('')),
    date: dateish.optional(),
    // If omitted, it allocates oldest-first automatically
    allocations: z
        .array(z.object({ purchase: objectId, amount: positiveMoney }))
        .max(50)
        .optional(),
    attachment: imageRef.optional(),
    note: z.string().trim().max(200).optional().or(z.literal('')),
});

// ---- purchases ----

const purchaseLineSchema = z.object({
    item: objectId,
    variantId: objectId.optional().nullable(),
    qty: z.number().int().positive('Quantity must be at least 1'),
    rate: money,
});

const createPurchaseSchema = z.object({
    vendorId: objectId,
    billNo: z.string().trim().min(1, 'Enter the bill number').max(40),
    billDate: dateish,
    lines: z.array(purchaseLineSchema).min(1, 'At least one item is required').max(100),
    tax: money.optional(),
    otherCharges: money.optional(),
    paidAmount: money.optional(),
    mode: paymentMode.optional(),
    billImage: imageRef.optional(),
    note: z.string().trim().max(300).optional().or(z.literal('')),
});

const updatePurchaseSchema = z.object({
    note: z.string().trim().max(300).optional(),
    billImage: imageRef.optional(),
    billDate: dateish.optional(),
});

const listPurchasesSchema = z.object({
    ...pagination,
    vendor: objectId.optional(),
    status: z.enum(['Unpaid', 'Partial', 'Paid']).optional(),
    from: dateish.optional(),
    to: dateish.optional(),
});

module.exports = {
    refundCreditSchema,
    listPaymentsSchema,
    updatePaymentSchema,
    studentIdParamSchema,
    byCategorySchema,
    dashboardSchema,
    daybookSchema,
    cashbookSchema,
    generateFeesSchema,
    collectFeeSchema,
    discountSchema,
    voidSchema,
    listDemandsSchema,
    createExpenseSchema,
    updateExpenseSchema,
    categorySchema,
    updateCategorySchema,
    listCategoriesSchema,
    createVendorSchema,
    updateVendorSchema,
    payVendorSchema,
    createPurchaseSchema,
    updatePurchaseSchema,
    listPurchasesSchema,
};
