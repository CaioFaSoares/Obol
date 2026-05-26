import { Elysia } from 'elysia';
import { cron } from '@elysiajs/cron';
import { pbPlugin, pb } from '../plugins/pocketbase';
import { processMonthlyRecurrences } from '../services/recurrence';
import { reconcileInvoices } from '../services/reconciliation';

export const jobsRoutes = new Elysia({ prefix: '/api/jobs' })
  .use(pbPlugin)
  
  // 1. Rota de Gatilho Manual (Para você debugar no front ou via cURL)
  .post('/recurrence', async ({ pb }) => {
    // Reconcilia ANTES de gerar novas recorrências
    const reconciliationReport = await reconcileInvoices(pb);
    const recurrenceReport = await processMonthlyRecurrences(pb);
    return { reconciliation: reconciliationReport, recurrence: recurrenceReport };
  })

  // 2. Rota Manual de Reconciliação (apenas curar, sem gerar)
  .post('/reconcile', async ({ pb }) => {
    const report = await reconcileInvoices(pb);
    return { 
      success: true, 
      message: 'Reconciliação executada com sucesso.',
      report 
    };
  })
  
  // 3. Motor Agendado de Background
  .use(
    cron({
      name: 'monthly-recurrence-job',
      pattern: '0 1 * * *', // 01:00 AM todos os dias
      timezone: 'America/Fortaleza',
      async run() {
        try {
          // Reconcilia antes de processar recorrências
          await reconcileInvoices(pb);
          // O cron não tem contexto HTTP, então puxamos o `pb` global que foi exportado!
          await processMonthlyRecurrences(pb);
        } catch (error) {
          console.error(`❌ [CRON ERROR] Falha no job de recorrências:`, error);
        }
      }
    })
  );
