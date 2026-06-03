import { Elysia } from 'elysia';
import { cron } from '@elysiajs/cron';
import { AwilixContainer } from 'awilix';
import { ReconcileInvoicesUseCase } from '../../application/use-cases/reconciliation/ReconcileInvoicesUseCase';
import { ProcessMonthlyRecurrencesUseCase } from '../../application/use-cases/recurrences/ProcessMonthlyRecurrencesUseCase';

export const schedulerPlugin = (container: AwilixContainer) => {
  return new Elysia({ name: 'scheduler' })
    .use(
      cron({
        name: 'monthly-recurrence-job',
        pattern: '0 1 * * *', // 01:00 AM todos os dias
        timezone: 'America/Fortaleza',
        async run() {
          try {
            console.log(`⏰ [SCHEDULER] Iniciando execução diária agendada...`);
            const reconcileUseCase = container.resolve<ReconcileInvoicesUseCase>('reconcileInvoicesUseCase');
            const processMonthlyRecurrencesUseCase = container.resolve<ProcessMonthlyRecurrencesUseCase>('processMonthlyRecurrencesUseCase');
            
            await reconcileUseCase.execute();
            await processMonthlyRecurrencesUseCase.execute();
          } catch (error) {
            console.error(`❌ [SCHEDULER ERROR] Falha no job de recorrências:`, error);
          }
        }
      })
    );
};
