import { Elysia } from 'elysia';
import { cron } from '@elysiajs/cron';
import { pbPlugin, pb } from '../plugins/pocketbase';
import { processMonthlyRecurrences } from '../services/recurrence';

export const jobsRoutes = new Elysia({ prefix: '/api/jobs' })
  .use(pbPlugin)
  
  // 1. Rota de Gatilho Manual (Para você debugar no front ou via cURL)
  .post('/recurrence', async ({ pb }) => {
    return await processMonthlyRecurrences(pb);
  })
  
  // 2. Motor Agendado de Background
  .use(
    cron({
      name: 'monthly-recurrence-job',
      pattern: '0 1 * * *', // 01:00 AM todos os dias
      timezone: 'America/Fortaleza',
      async run() {
        try {
          // O cron não tem contexto HTTP, então puxamos o `pb` global que foi exportado!
          await processMonthlyRecurrences(pb);
        } catch (error) {
          console.error(`❌ [CRON ERROR] Falha no job de recorrências:`, error);
        }
      }
    })
  );
