const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const teacherService = require('../services/teacher.service');
const attendanceService = require('../services/attendance.service');
const salaryService = require('../services/salary.service');
const audit = require('../services/audit.service');
// Only for the BEFORE snapshot on an edit — the write stays in the service.
const Teacher = require('../models/teacher.model');
const SalarySlip = require('../models/salarySlip.model');

// ---- teachers ----

const listTeachers = asyncHandler(async (req, res) => {
    const data = await teacherService.list(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Teachers'));
});

const getTeacher = asyncHandler(async (req, res) => {
    const data = await teacherService.getById(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Teacher'));
});

const createTeacher = asyncHandler(async (req, res) => {
    const data = await teacherService.create(req.body, req.userId);

    audit.logCreate(req, {
        action: 'teacher.create',
        entity: 'Teacher',
        entityId: data._id,
        label: `${data.name} (${data.employeeCode}) joined at ₹${data.monthlySalary}/month`,
        after: data,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Teacher added'));
});

// Salary and lateAllowance both change what a future slip pays, so both are
// worth a name and a date against them. This used to log a salary change only,
// and only as a sentence — now every tracked field carries its before/after.
const updateTeacher = asyncHandler(async (req, res) => {
    const before = await audit.snapshot(Teacher, req.params.id, 'Teacher');
    const data = await teacherService.update(req.params.id, req.body);

    audit.logEdit(req, {
        action: req.body.monthlySalary !== undefined ? 'teacher.salaryChange' : 'teacher.update',
        entity: 'Teacher',
        entityId: data._id,
        label: `${data.name} (${data.employeeCode})`,
        before,
        after: data,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Teacher updated'));
});

const markTeacherLeft = asyncHandler(async (req, res) => {
    const data = await teacherService.markLeft(req.params.id);

    audit.logDelete(req, {
        action: 'teacher.left',
        entity: 'Teacher',
        entityId: data._id,
        label: `${data.name} (${data.employeeCode}) marked as Left`,
        before: data,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Teacher marked as Left'));
});

// ---- attendance ----

const teacherSheet = asyncHandler(async (req, res) => {
    const data = await attendanceService.getTeacherSheet(req.query.date);
    return res.status(200).json(new ApiResponse(200, data, 'Attendance sheet'));
});

// Attendance drives payroll and is sealed the moment it is saved, so this is
// the record of who sealed it. The individual marks are not copied — the sheet
// itself is that record; this says who saved it and how much was already locked.
const markTeacherAttendance = asyncHandler(async (req, res) => {
    const data = await attendanceService.markTeachers(req.body, req.userId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'attendance.teacher.mark',
        entity: 'TeacherAttendance',
        summary: `${new Date(data.date).toISOString().slice(0, 10)}: ${data.saved} teachers marked`
            + (data.locked ? ` · ${data.locked} already locked, left unchanged` : ''),
    });

    return res
        .status(200)
        .json(new ApiResponse(200, data, data.saved ? 'Attendance saved and locked' : 'Nothing to save'));
});

const teacherGrid = asyncHandler(async (req, res) => {
    const data = await attendanceService.teacherMonthlyGrid(req.query.month);
    return res.status(200).json(new ApiResponse(200, data, 'Monthly attendance'));
});

const classSheet = asyncHandler(async (req, res) => {
    const data = await attendanceService.getClassSheet(req.query.date);
    return res.status(200).json(new ApiResponse(200, data, 'Class attendance sheet'));
});

const markClassAttendance = asyncHandler(async (req, res) => {
    const data = await attendanceService.markClasses(req.body, req.userId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'attendance.class.mark',
        entity: 'ClassAttendance',
        summary: `${new Date(data.date).toISOString().slice(0, 10)}: ${data.saved} classes marked`
            + (data.locked ? ` · ${data.locked} already locked, left unchanged` : ''),
    });

    return res
        .status(200)
        .json(new ApiResponse(200, data, data.saved ? 'Attendance saved and locked' : 'Nothing to save'));
});

const classMonthly = asyncHandler(async (req, res) => {
    const data = await attendanceService.classMonthly(req.query.month);
    return res.status(200).json(new ApiResponse(200, data, 'Monthly class attendance'));
});

// ---- salary ----

const generateSalary = asyncHandler(async (req, res) => {
    const data = await salaryService.generate(req.body, req.userId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'salary.generate',
        entity: 'SalarySlip',
        summary: `${data.month}: ${data.created} slips generated`,
    });

    return res.status(200).json(new ApiResponse(200, data, `${data.created} slips generated`));
});

const listSlips = asyncHandler(async (req, res) => {
    const data = await salaryService.list(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Salary slips'));
});

const getSlip = asyncHandler(async (req, res) => {
    const data = await salaryService.getById(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Slip'));
});

const updateSlip = asyncHandler(async (req, res) => {
    const before = await audit.snapshot(SalarySlip, req.params.id, 'SalarySlip');
    const data = await salaryService.update(req.params.id, req.body);

    audit.logEdit(req, {
        action: 'salary.update',
        entity: 'SalarySlip',
        entityId: data._id,
        label: `${data.teacherName} — ${data.month}`,
        before,
        after: data,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Slip updated'));
});

const addAdjustment = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name };
    const data = await salaryService.addAdjustment(req.params.id, req.body, actor);

    audit.log({
        ...audit.fromRequest(req),
        action: 'salary.adjust',
        entity: 'SalarySlip',
        entityId: req.params.id,
        summary: `${req.body.kind === 'Add' ? '+' : '-'}₹${req.body.amount} ${req.body.label}`,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Adjustment added'));
});

// Adding a line is already logged; removing one has to be too, or a bonus
// could be added and quietly taken away with only half the trail.
const removeAdjustment = asyncHandler(async (req, res) => {
    const before = await audit.snapshot(SalarySlip, req.params.id, 'SalarySlip');
    const data = await salaryService.removeAdjustment(req.params.id, req.params.adjustmentId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'salary.adjustRemove',
        entity: 'SalarySlip',
        entityId: data._id,
        summary: `${data.teacherName} — ${data.month}: a line was removed,`
            + ` net ₹${before?.netPayable ?? '?'} → ₹${data.netPayable}`,
        before: { netPayable: before?.netPayable ?? null },
        after: { netPayable: data.netPayable },
    });

    return res.status(200).json(new ApiResponse(200, data, 'Adjustment removed'));
});

const discardSlip = asyncHandler(async (req, res) => {
    const data = await salaryService.discard(req.params.id);

    audit.log({
        ...audit.fromRequest(req),
        action: 'salary.discard',
        entity: 'SalarySlip',
        entityId: req.params.id,
        summary: `Draft slip discarded: ${data.teacherName} ${data.month}`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Draft discarded — generate again to rebuild it'));
});

const approveSlip = asyncHandler(async (req, res) => {
    const data = await salaryService.approve(req.params.id, req.userId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'salary.approve',
        entity: 'SalarySlip',
        entityId: data._id,
        summary: `${data.teacherName} ${data.month}: ₹${data.netPayable} approved`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Slip approved'));
});

const paySlip = asyncHandler(async (req, res) => {
    const data = await salaryService.pay(req.params.id, req.body, req.userId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'salary.pay',
        entity: 'SalarySlip',
        entityId: req.params.id,
        summary: `₹${data.paid} paid · ₹${data.remaining} still to pay`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Salary paid'));
});

module.exports = {
    listTeachers,
    getTeacher,
    createTeacher,
    updateTeacher,
    markTeacherLeft,
    teacherSheet,
    markTeacherAttendance,
    teacherGrid,
    classSheet,
    markClassAttendance,
    classMonthly,
    generateSalary,
    listSlips,
    getSlip,
    updateSlip,
    addAdjustment,
    removeAdjustment,
    discardSlip,
    approveSlip,
    paySlip,
};
