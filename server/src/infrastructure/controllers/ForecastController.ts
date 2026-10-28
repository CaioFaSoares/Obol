import { Elysia, t } from 'elysia';
import { AwilixContainer } from 'awilix';
import { ForecastQueryDTO, ForecastResponseDTO } from '../validators/forecastSchemas';
import { executeUseCase } from '../use-case-routes';

export const forecastController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/forecast' })
    .get('/', async ({ query }) => {
      return await executeUseCase(container, 'generateForecastUseCase', query);
    }, {
      query: ForecastQueryDTO,
      response: {
        200: ForecastResponseDTO,
        500: t.Object({ error: t.String(), details: t.Optional(t.String()) })
      }
    });
