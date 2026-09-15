const mongoose = require('mongoose');

// A teacher is a RECORD, not a login. Only three people (Admin, Principal,
// Accountant) sign in. That removes an entire auth surface and twenty-odd
// user documents.
const teacherSchema = new mongoose.Schema(
    {
        employeeCode: { type: String, required: true }, // EMP0012, from the counter
        name: { type: String, required: true, trim: true },
        nameLower: { type: String, required: true, lowercase: true, trim: true },
        phone: { type: String, default: '', trim: true },
        designation: { type: String, default: '', trim: true },

        // This value is SNAPSHOT onto the slip when it is generated, so a raise
        // given in June does not rewrite April's paid slip.
        monthlySalary: { type: Number, required: true, min: 0 },

        // How many late arrivals a month are forgiven. Lates inside this cost
        // nothing; above it every 4 lates cost a day's pay (see
        // salary.service.computeSlip). Per teacher, because seniority and
        // distance from school are exactly why one blanket number does not work.
        lateAllowance: { type: Number, default: 0, min: 0 },

        joiningDate: { type: Date, required: true },
        status: { type: String, enum: ['Active', 'Left'], default: 'Active' },
        leftAt: { type: Date, default: null },

        bankDetails: {
            accountName: { type: String, default: '' },
            accountNo: { type: String, default: '' },
            ifsc: { type: String, default: '' },
        },
        photo: {
            publicId: { type: String, default: '' },
            width: Number,
            height: Number,
        },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true }
);

// The attendance screen — all active staff in one read, in name order
teacherSchema.index({ status: 1, nameLower: 1 });
teacherSchema.index({ employeeCode: 1 }, { unique: true });

teacherSchema.pre('validate', function syncNameLower(next) {
    if (this.isModified('name') && this.name) this.nameLower = this.name.toLowerCase().trim();
    next();
});

module.exports = mongoose.models.Teacher || mongoose.model('Teacher', teacherSchema);
