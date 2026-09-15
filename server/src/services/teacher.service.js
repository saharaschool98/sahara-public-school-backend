const Teacher = require('../models/teacher.model');
const ApiError = require('../utils/ApiError');
const { getNextSequence, formatCode } = require('../models/counter.model');
const { prefixMatch } = require('../utils/search');

const list = async (query = {}) => {
    const filter = { status: query.status || 'Active' };
    const rx = prefixMatch(query.search);
    if (rx) filter.nameLower = rx;

    // From the status + nameLower index — both filter and sort
    return Teacher.find(filter)
        .select('employeeCode name phone designation monthlySalary lateAllowance joiningDate status')
        .sort({ nameLower: 1 })
        .lean();
};

const getById = async (id) => {
    const doc = await Teacher.findById(id).lean();
    if (!doc) throw new ApiError(404, 'Teacher not found');
    return doc;
};

const create = async (payload, actorId) => {
    const seq = await getNextSequence('employeeCode');

    return Teacher.create({
        ...payload,
        employeeCode: formatCode('EMP', seq, 3),
        nameLower: payload.name.toLowerCase().trim(),
        createdBy: actorId,
    });
};

// Changing salary affects FUTURE months only. Slips already generated hold
// the old salary as a snapshot — see salarySlip.model.js.
const update = async (id, updates) => {
    const teacher = await Teacher.findById(id);
    if (!teacher) throw new ApiError(404, 'Teacher not found');

    Object.assign(teacher, updates);

    // Bringing somebody back has to clear the date they left, or the record
    // reads Active with a leaving date sitting beside it.
    if (updates.status === 'Active') teacher.leftAt = null;
    if (updates.status === 'Left' && !teacher.leftAt) teacher.leftAt = new Date();

    await teacher.save();
    return teacher;
};

const markLeft = async (id) => {
    const teacher = await Teacher.findById(id);
    if (!teacher) throw new ApiError(404, 'Teacher not found');

    teacher.status = 'Left';
    teacher.leftAt = new Date();
    await teacher.save();
    return teacher;
};

module.exports = { list, getById, create, update, markLeft };
