import { Elysia } from 'elysia';
import { AwilixContainer } from 'awilix';
import { CategoryDTO } from '../validators/categorySchemas';
import { ListCategoriesUseCase } from '../../application/use-cases/categories/ListCategoriesUseCase';
import { GetBudgetsUseCase } from '../../application/use-cases/categories/GetBudgetsUseCase';
import { CreateCategoryUseCase } from '../../application/use-cases/categories/CreateCategoryUseCase';

export const categoryController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/categories' })
    // GET /api/categories
    .get('/', async () => {
      const useCase = container.resolve<ListCategoriesUseCase>('listCategoriesUseCase');
      return await useCase.execute();
    })

    // GET /api/categories/budgets
    .get('/budgets', async () => {
      const useCase = container.resolve<GetBudgetsUseCase>('getBudgetsUseCase');
      return await useCase.execute();
    })

    // POST /api/categories
    .post('/', async ({ body, set }) => {
      const useCase = container.resolve<CreateCategoryUseCase>('createCategoryUseCase');
      const category = await useCase.execute(body);
      set.status = 201;
      return category;
    }, {
      body: CategoryDTO
    });
