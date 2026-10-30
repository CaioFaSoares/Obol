import { Elysia, t } from 'elysia';
import { AwilixContainer } from 'awilix';
import { ValidationError } from '../../domain/errors';
import { executeUseCase } from '../use-case-routes';

/** The exact phrase the client must echo before a destructive reset runs. */
export const RESET_CONFIRMATION = 'LIMPAR';

export const adminController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/admin' })
    // POST /api/admin/reset
    .post(
      '/reset',
      async ({ body }) => {
        if (body.confirm.trim().toUpperCase() !== RESET_CONFIRMATION) {
          throw new ValidationError(
            `Confirmação inválida. Digite ${RESET_CONFIRMATION} para apagar os dados.`,
          );
        }
        return await executeUseCase(container, 'resetFinancialDataUseCase');
      },
      {
        body: t.Object({
          confirm: t.String({ minLength: 1, maxLength: 32 }),
        }),
      },
    );
