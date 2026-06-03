import { Elysia } from 'elysia';
import { AwilixContainer } from 'awilix';
import { ReconcileInvoicesUseCase } from '../../application/use-cases/reconciliation/ReconcileInvoicesUseCase';
import { ProcessMonthlyRecurrencesUseCase } from '../../application/use-cases/recurrences/ProcessMonthlyRecurrencesUseCase';

export const jobController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/jobs' })
    // POST /api/jobs/recurrence
    .post('/recurrence', async () => {
      const reconcileUseCase = container.resolve<ReconcileInvoicesUseCase>('reconcileInvoicesUseCase');
      const processRecurrencesUseCase = container.resolve<ProcessMonthlyRecurrencesUseCase>('processMonthlyRecurrencesUseCase');
      const reconciliationReport = await reconcileUseCase.execute();
      const recurrenceReport = await processRecurrencesUseCase.execute();
      return { reconciliation: reconciliationReport, recurrence: recurrenceReport };
    })

    // POST /api/jobs/reconcile
    .post('/reconcile', async () => {
      const reconcileUseCase = container.resolve<ReconcileInvoicesUseCase>('reconcileInvoicesUseCase');
      const report = await reconcileUseCase.execute();
      return { 
        success: true, 
        message: 'Reconciliação executada com sucesso.',
        report 
      };
    });
