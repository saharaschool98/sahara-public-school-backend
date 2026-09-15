const router = require('express').Router();

const c = require('../../controllers/staff.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const { createTeacherSchema, updateTeacherSchema, listTeachersSchema } = require('../../validators/staff.validator');
const { idParamSchema } = require('../../validators/auth.validator');

router.get('/', can('teacher.view'), validate(listTeachersSchema, 'query'), c.listTeachers);
router.get('/:id', can('teacher.view'), validate(idParamSchema, 'params'), c.getTeacher);

router.post('/', can('teacher.manage'), validate(createTeacherSchema), c.createTeacher);
router.patch('/:id', can('teacher.manage'), validate(idParamSchema, 'params'), validate(updateTeacherSchema), c.updateTeacher);
router.delete('/:id', can('teacher.manage'), validate(idParamSchema, 'params'), c.markTeacherLeft);

module.exports = router;
