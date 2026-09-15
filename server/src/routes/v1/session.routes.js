const router = require('express').Router();

const c = require('../../controllers/academic.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const { createSessionSchema, updateSessionSchema, rolloverSchema, idParamSchema } = require('../../validators/academic.validator');
const { heavyLimiter } = require('../../middlewares/rateLimiter');

// Every module reads the active session, so this is open to all
router.get('/active', c.getActiveSession);

router.get('/', can('session.manage'), c.listSessions);
router.post('/', can('session.manage'), validate(createSessionSchema), c.createSession);
router.patch('/:id', can('session.manage'), validate(idParamSchema, 'params'), validate(updateSessionSchema), c.updateSession);
router.post('/:id/activate', can('session.manage'), validate(idParamSchema, 'params'), c.activateSession);

// ---------------------------------------------------------------------------
// ROLLOVER — the new year.
//
// Three steps, deliberately separate. The plan is READ-ONLY and comes first, so
// the office sees what is about to happen to 400 children before any of it
// does; the classes are copied next, because nobody can be promoted into a
// class that does not exist; the students move last.
//
// All of it rides on `session.manage` — this is the same authority that creates
// and activates a session, and promoting the whole school is not a smaller
// decision than either.
// ---------------------------------------------------------------------------
router.get('/:id/rollover', can('session.manage'), validate(idParamSchema, 'params'), c.rolloverPlan);
router.post('/:id/rollover/classes', can('session.manage'), validate(idParamSchema, 'params'), c.rolloverClasses);
router.post('/:id/rollover', can('session.manage'), heavyLimiter, validate(idParamSchema, 'params'), validate(rolloverSchema), c.rolloverPromote);

module.exports = router;
