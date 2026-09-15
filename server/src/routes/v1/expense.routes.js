const router = require('express').Router();

const c = require('../../controllers/misc.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const {
    createExpenseSchema,
    updateExpenseSchema,
    categorySchema,
    voidSchema,
    byCategorySchema,
    updateCategorySchema,
    listCategoriesSchema,
} = require('../../validators/finance.validator');
const { idParamSchema } = require('../../validators/auth.validator');

// ---- categories ----
router.get('/categories', can('expense.view'), validate(listCategoriesSchema, 'query'), c.listCategories);
router.post('/categories', can('expense.create'), validate(categorySchema), c.createCategory);
router.patch('/categories/:id', can('expense.edit'), validate(idParamSchema, 'params'), validate(updateCategorySchema), c.updateCategory);

// ---- expenses ----
router.get('/', can('expense.view'), c.listExpenses);
router.get('/by-category', can('expense.view'), validate(byCategorySchema, 'query'), c.expensesByCategory);
router.get('/:id', can('expense.view'), validate(idParamSchema, 'params'), c.getExpense);

router.post('/', can('expense.create'), validate(createExpenseSchema), c.createExpense);
router.patch('/:id', can('expense.edit'), validate(idParamSchema, 'params'), validate(updateExpenseSchema), c.updateExpense);

// Delete writes a reversal into the ledger, so a reason is mandatory
router.delete('/:id', can('expense.delete'), validate(idParamSchema, 'params'), validate(voidSchema), c.deleteExpense);

module.exports = router;
