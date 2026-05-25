import { Elysia } from 'elysia';
import { pbPlugin } from './plugins/pocketbase';
import { transactionRoutes } from './routes/transactions';
import { forecastRoutes } from './routes/forecast';
import { jobsRoutes } from './routes/jobs';
import { recurrenceRoutes } from './routes/recurrences';
import { categoryRoutes } from './routes/categories';
import { projectRoutes } from './routes/projects';
import { accountRoutes } from './routes/accounts';
import { cardRoutes } from './routes/cards';

const port = process.env.PORT || 8080;
const app = new Elysia()
  .onError(({ code, error, set }) => {
    if ((error as any).status === 0) {
      set.status = 502;
      return { error: 'Database connection error', details: error.message };
    }
  })
  .use(pbPlugin) // Injeta o contexto { pb } em todas as rotas abaixo
  .use(transactionRoutes) // <-- Rota inteligente acoplada
  .use(forecastRoutes) // <-- Motor de Projeção no ar
  .use(jobsRoutes) // <-- Gatilho e Motor de Recorrência (Cron)
  .use(recurrenceRoutes) // <-- CRUD de Recorrências
  .use(categoryRoutes) // <-- Categorias + Orçamentos calculados
  .use(projectRoutes) // <-- Projetos/Freelas + Pagamentos
  .use(accountRoutes) // <-- Contas
  .use(cardRoutes) // <-- Cartões
  
  // Rota de Health Check para testar a ponte
  .get('/', async ({ pb }) => {
    // Acessamos o banco de forma tipada, confirmando que a ponte funciona
    // NOTA: Em PocketBase v0.23+, usa-se 'record' em vez de 'model'
    const adminEmail = pb.authStore.record?.email;
    return { 
      status: 'Online', 
      message: 'BFF conectado ao PocketBase',
      admin: adminEmail
    };
  })
  
  .listen({ port, hostname: '0.0.0.0' });

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);

// Exportamos o tipo para o Nuxt consumir via Eden Treaty!
export type App = typeof app;
