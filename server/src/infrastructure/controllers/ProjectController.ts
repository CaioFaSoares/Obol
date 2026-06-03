import { Elysia } from 'elysia';
import { AwilixContainer } from 'awilix';
import { ProjectCreateDTO, ProjectPaymentDTO } from '../validators/projectSchemas';
import { ListProjectsUseCase } from '../../application/use-cases/projects/ListProjectsUseCase';
import { CreateProjectUseCase } from '../../application/use-cases/projects/CreateProjectUseCase';
import { RegisterPaymentUseCase } from '../../application/use-cases/projects/RegisterPaymentUseCase';
import { CompleteProjectUseCase } from '../../application/use-cases/projects/CompleteProjectUseCase';

export const projectController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/projects' })
    // GET /api/projects
    .get('/', async () => {
      const useCase = container.resolve<ListProjectsUseCase>('listProjectsUseCase');
      return await useCase.execute();
    })

    // POST /api/projects
    .post('/', async ({ body, set }) => {
      const useCase = container.resolve<CreateProjectUseCase>('createProjectUseCase');
      const project = await useCase.execute(body);
      set.status = 201;
      return project;
    }, {
      body: ProjectCreateDTO
    })

    // POST /api/projects/:id/payment
    .post('/:id/payment', async ({ params, body, set }) => {
      const useCase = container.resolve<RegisterPaymentUseCase>('registerPaymentUseCase');
      const transaction = await useCase.execute(params.id, body);
      set.status = 201;
      return transaction;
    }, {
      body: ProjectPaymentDTO
    })

    // PATCH /api/projects/:id/complete
    .patch('/:id/complete', async ({ params }) => {
      const useCase = container.resolve<CompleteProjectUseCase>('completeProjectUseCase');
      return await useCase.execute(params.id);
    });
