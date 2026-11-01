import { Elysia } from 'elysia';
import { AwilixContainer } from 'awilix';
import { executeJobUseCase } from '../use-case-routes';

// The background job endpoints run the same financial maintenance use cases
// as the cron scheduler, but every one of them routes through the shared
// FIFO mutation runtime (origin `job`): one gate slot, one unit of work and
// one atomic PocketBase batch per use case, with local roles recording real
// canonical child intents instead of an opaque pseudo-job. They never
// resolve raw writers.
export const jobController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/jobs' })
    // POST /api/jobs/recurrence
    .post('/recurrence', async () => {
      const reconciliationReport = await executeJobUseCase(container, 'reconcileInvoicesUseCase');
      const recurrenceReport = await executeJobUseCase(container, 'processMonthlyRecurrencesUseCase');
      return { reconciliation: reconciliationReport, recurrence: recurrenceReport };
    })

    // POST /api/jobs/reconcile
    .post('/reconcile', async () => {
      const report = await executeJobUseCase(container, 'reconcileInvoicesUseCase');
      return {
        success: true,
        message: 'Reconciliation executed successfully.',
        report
      };
    });
