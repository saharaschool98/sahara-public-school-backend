const router = require('express').Router();

const c = require('../../controllers/academic.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const {
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
    idParamSchema,
} = require('../../validators/academic.validator');

router.get('/', can('student.view'), validate(listStudentsSchema, 'query'), c.listStudents);
router.get('/defaulters', can('fee.view'), c.defaulters);
// Two segments, so neither can be swallowed by '/:id' below.
router.get('/id-cards/summary', can('student.view'), c.idCardSummary);
router.get('/:id', can('student.view'), validate(idParamSchema, 'params'), c.getStudent);
router.get('/:id/ledger', can('fee.view'), validate(idParamSchema, 'params'), c.getStudentLedger);

router.post('/', can('student.create'), validate(createStudentSchema), c.createStudent);
router.patch('/:id', can('student.edit'), validate(idParamSchema, 'params'), validate(updateStudentSchema), c.updateStudent);

// ---- siblings ----
// Brothers and sisters share one family group — linking is an edit to both
// records, so it rides on `student.edit`. The family itself is read with the
// profile (GET /students/:id/ledger), so there is no list route here.
router.post('/:id/siblings', can('student.edit'), validate(idParamSchema, 'params'), validate(linkSiblingSchema), c.linkSibling);
router.delete('/:id/siblings/:siblingId', can('student.edit'), validate(siblingParamsSchema, 'params'), c.unlinkSibling);

// ---- ID cards ----
// Issuing takes money at the counter, so it has its own permission rather than
// riding on student.edit.
router.post('/:id/id-card', can('student.idcard'), validate(idParamSchema, 'params'), validate(issueIdCardSchema), c.issueIdCard);
// Cancel, not delete — if money was taken it is reversed in the ledger.
router.delete('/:id/id-card', can('student.idcard'), validate(idParamSchema, 'params'), validate(cancelIdCardSchema), c.cancelIdCard);

// ---- transfer certificate ----
//
// Issuing is ONE act: the certificate is numbered and the student comes off the
// roster together, in one transaction — the same reasoning that puts the ID
// card and its money in one request. Its own permission, because handing a TC
// over while fees are unpaid is a decision, and not the counter's to make by
// default.
router.post('/:id/tc', can('student.tc'), validate(idParamSchema, 'params'), validate(issueTcSchema), c.issueTC);
// Cancel, not delete — and the exact inverse of THIS issue: a TC that took the
// student off the roster puts them back, one that did not leaves them alone.
router.delete('/:id/tc', can('student.tc'), validate(idParamSchema, 'params'), validate(cancelTcSchema), c.cancelTC);

// Never deleted — status becomes Left. The history never goes away.
router.delete('/:id', can('student.delete'), validate(idParamSchema, 'params'), validate(markLeftSchema), c.markStudentLeft);

module.exports = router;
