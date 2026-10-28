import { Elysia } from 'elysia';
import { AwilixContainer } from 'awilix';
import { ProjectCreateDTO, ProjectPaymentDTO } from '../validators/projectSchemas';
import { executeUseCase } from '../use-case-routes';

export const projectController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/projects' })
    // GET /api/projects
    .get('/', async () => {
      return await executeUseCase(container, 'listProjectsUseCase');
    })

    // POST /api/projects
    .post('/', async ({ body, set }) => {
      const project = await executeUseCase(container, 'createProjectUseCase', body);
      set.status = 201;
      return project;
    }, {
      body: ProjectCreateDTO
    })

    // POST /api/projects/:id/payment
    .post('/:id/payment', async ({ params, body, set }) => {
      const transaction = await executeUseCase(container, 'registerPaymentUseCase', params.id, body);
      set.status = 201;
      return transaction;
    }, {
      body: ProjectPaymentDTO
    })

    // PATCH /api/projects/:id/complete
    .patch('/:id/complete', async ({ params }) => {
      return await executeUseCase(container, 'completeProjectUseCase', params.id);
    });
