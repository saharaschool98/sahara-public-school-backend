const { z } = require('zod');
const { objectId, monthKey, phone, money, positiveMoney, paymentMode, dateish } = require('./common');

// ---- teachers ----

const createTeacherSchema = z.object({
    name: z.string().trim().min(2, "Enter the teacher's name").max(100),
    phone: phone.optional().or(z.literal('')),
    designation: z.string().trim().max(60).optional().or(z.literal('')),
    monthlySalary: positiveMoney,
    // Late arrivals forgiven per month. Capped at 31 — a number above that is
    // a typo, not a policy.
    lateAllowance: z.number().int().nonnegative().max(31).optional(),
    joiningDate: dateish,
    bankDetails: z
        .object({
            accountName: z.string().trim().max(100).optional().or(z.literal('')),
            accountNo: z.string().trim().max(30).optional().or(z.literal('')),
            ifsc: z.string().trim().toUpperCase().max(15).optional().or(z.literal('')),
        })
        .optional(),
});

// `status` is not on the create schema — a new teacher is always Active — but it
// belongs here. Marking somebody Left is a DELETE (teacher.service.markLeft);
// this is the only way back from a mis-click, and without it the mistake was
// permanent.
const updateTeacherSchema = createTeacherSchema
    .partial()
    .extend({ status: z.enum(['Active', 'Left']).optional() });

// The staff register, filtered. Roster screens now offer Active / Left, and an
// unvalidated status went straight into the query as whatever was typed.
const listTeachersSchema = z.object({
    status: z.enum(['Active', 'Left']).optional().or(z.literal('')).transform((v) => v || undefined),
    search: z.string().trim().max(60).optional(),
});

// ---- attendance ----

const markTeacherAttendanceSchema = z.object({
    date: dateish.optional(),
    entries: z
        .array(
            z.object({
                teacher: objectId,
                status: z.enum(['Present', 'Late', 'Absent', 'HalfDay', 'Leave', 'Holiday']),
                note: z.string().trim().max(120).optional().or(z.literal('')),
            })
        )
        .min(1, 'No entries')
        // The whole staff in one call — beyond 200 the client should batch, so a
        // single request does not eat the 10s function limit.
        .max(200),
});

const markClassAttendanceSchema = z.object({
    date: dateish.optional(),
    entries: z
        .array(
            z.object({
                class: objectId,
                present: z.number().int().nonnegative(),
                // If omitted, the class's current roll count is used
                totalStudents: z.number().int().nonnegative().optional(),
            })
        )
        .min(1, 'No entries')
        .max(100),
});

// ---- salary ----

const generateSalarySchema = z.object({ month: monthKey });

const updateSlipSchema = z.object({
    deductions: z
        .array(
            z.object({
                label: z.string().trim().min(1, 'Enter a label for the deduction').max(60),
                amount: positiveMoney,
            })
        )
        .max(10)
        .optional(),
    advance: money.optional(),
    note: z.string().trim().max(200).optional().or(z.literal('')),
});

// Both path params, because validate() assigns the PARSED object back over
// req.params — and zod strips whatever the schema does not mention. Reusing
// idParamSchema here silently deleted req.params.adjustmentId, so the delete
// matched nothing and answered 404.
const adjustmentParamsSchema = z.object({ id: objectId, adjustmentId: objectId });

// A bonus, an arrear, a fine. The reason is required — a number on a salary
// slip with nothing explaining it is what starts the argument.
const adjustmentSchema = z.object({
    kind: z.enum(['Add', 'Deduct']),
    label: z.string().trim().min(2, 'Write the reason').max(60),
    amount: positiveMoney,
});

const paySlipSchema = z.object({
    // If omitted, the full remaining amount is paid
    amount: positiveMoney.optional(),
    mode: paymentMode,
    date: dateish.optional(),
    note: z.string().trim().max(200).optional().or(z.literal('')),
});

module.exports = {
    createTeacherSchema,
    updateTeacherSchema,
    listTeachersSchema,
    markTeacherAttendanceSchema,
    markClassAttendanceSchema,
    generateSalarySchema,
    updateSlipSchema,
    adjustmentSchema,
    adjustmentParamsSchema,
    paySlipSchema,
};
