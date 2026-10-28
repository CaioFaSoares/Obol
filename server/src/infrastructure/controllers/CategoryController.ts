import { Elysia } from 'elysia';
import { AwilixContainer } from 'awilix';
import { CategoryDTO } from '../validators/categorySchemas';
import { executeUseCase } from '../use-case-routes';

export const categoryController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/categories' })
    // GET /api/categories
    .get('/', async () => {
      return await executeUseCase(container, 'listCategoriesUseCase');
    })

    // GET /api/categories/budgets
    .get('/budgets', async () => {
      return await executeUseCase(container, 'getBudgetsUseCase');
    })

    // POST /api/categories
    .post('/', async ({ body, set }) => {
      const category = await executeUseCase(container, 'createCategoryUseCase', body);
      set.status = 201;
      return category;
    }, {
      body: CategoryDTO
    });
