const { z } = require('zod');
const { objectId, phone } = require('./common');
const { ROLES, PERMISSION_KEYS } = require('../utils/permissions');

const loginSchema = z.object({
    username: z.string().trim().toLowerCase().min(3, 'Enter your username'),
    password: z.string().min(1, 'Enter your password'),
});

// Minimum 8 characters. Stricter rules (uppercase + symbol + number) are
// deliberately not imposed — they push people towards predictable patterns
// like "Password@123" and onto sticky notes. Length is the real strength.
const passwordField = z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128);

const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: passwordField,
});

const createUserSchema = z.object({
    name: z.string().trim().min(2, 'Enter a name'),
    username: z
        .string()
        .trim()
        .toLowerCase()
        .min(3, 'Username must be at least 3 characters')
        .regex(/^[a-z0-9._-]+$/, 'Username may only contain letters, numbers, . _ and -'),
    email: z.string().trim().toLowerCase().email('Email is not valid').optional().or(z.literal('')),
    phone: phone.optional().or(z.literal('')),
    role: z.enum(ROLES),
});

const updateUserSchema = z
    .object({
        name: z.string().trim().min(2).optional(),
        email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
        phone: phone.optional().or(z.literal('')),
        role: z.enum(ROLES).optional(),
        isActive: z.boolean().optional(),
    })
    .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

// Permission update — unknown keys stop here and never reach the service.
const updatePermissionsSchema = z.object({
    permissions: z
        .array(z.string())
        .max(200)
        .refine(
            (list) => list.every((k) => PERMISSION_KEYS.has(k)),
            'None of these permission keys are valid'
        ),
});

// History filters. Everything optional — an unfiltered call is the default
// view, and an empty string from a <select> means "no filter", not a bad one.
const listAuditSchema = z.object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
    entity: z.string().trim().max(40).optional().or(z.literal('')).transform((v) => v || undefined),
    entityId: z.union([objectId, z.literal('')]).optional().transform((v) => v || undefined),
    actor: z.union([objectId, z.literal('')]).optional().transform((v) => v || undefined),
    // A module prefix ('fee') or a full key ('fee.discount')
    action: z.string().trim().max(40).optional().or(z.literal('')).transform((v) => v || undefined),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
});

const entityHistoryParamsSchema = z.object({
    entity: z.string().trim().min(2).max(40),
    id: objectId,
});

const idParamSchema = z.object({ id: objectId });

module.exports = {
    loginSchema,
    changePasswordSchema,
    createUserSchema,
    updateUserSchema,
    updatePermissionsSchema,
    listAuditSchema,
    entityHistoryParamsSchema,
    idParamSchema,
};
