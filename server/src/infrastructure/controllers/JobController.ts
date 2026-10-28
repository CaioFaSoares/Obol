import { Elysia } from 'elysia';
import { AwilixContainer } from 'awilix';
import { resolveUseCase } from '../use-case-routes';

// The background job endpoints compose two use cases into one report payload,
// so they resolve the classes with the typed resolver instead of the single
// `executeUseCase` dispatch. The cron scheduler resolves the same classes
// directly from Awilix and shares nothing with these HTTP routes.
export const jobController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/jobs' })
    // POST /api/jobs/recurrence
    .post('/recurrence', async () => {
      const reconcileUseCase = resolveUseCase(container, 'reconcileInvoicesUseCase');
      const processRecurrencesUseCase = resolveUseCase(container, 'processMonthlyRecurrencesUseCase');
      const reconciliationReport = await reconcileUseCase.execute();
      const recurrenceReport = await processRecurrencesUseCase.execute();
      return { reconciliation: reconciliationReport, recurrence: recurrenceReport };
    })

    // POST /api/jobs/reconcile
    .post('/reconcile', async () => {
      const reconcileUseCase = resolveUseCase(container, 'reconcileInvoicesUseCase');
      const report = await reconcileUseCase.execute();
      return { 
        success: true, 
        message: 'Reconciliação executada com sucesso.',
        report 
      };
    });
