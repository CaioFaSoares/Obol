import { Elysia, t } from 'elysia';
import { AwilixContainer } from 'awilix';
import { ForecastQueryDTO, ForecastResponseDTO } from '../validators/forecastSchemas';
import { GenerateForecastUseCase } from '../../application/use-cases/forecast/GenerateForecastUseCase';

export const forecastController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/forecast' })
    .get('/', async ({ query }) => {
      const useCase = container.resolve<GenerateForecastUseCase>('generateForecastUseCase');
      return await useCase.execute(query);
    }, {
      query: ForecastQueryDTO,
      response: {
        200: ForecastResponseDTO,
        500: t.Object({ error: t.String(), details: t.Optional(t.String()) })
      }
    });
