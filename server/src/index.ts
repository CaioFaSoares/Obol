import { Elysia } from 'elysia';
import { pb } from './infrastructure/plugins/pocketbase';
import { container } from './infrastructure/di/container';
import { errorPlugin } from './infrastructure/plugins/errorPlugin';
import { schedulerPlugin } from './infrastructure/scheduler';

// Import Controllers
import { transactionController } from './infrastructure/controllers/TransactionController';
import { forecastController } from './infrastructure/controllers/ForecastController';
import { cardController } from './infrastructure/controllers/CardController';
import { recurrenceController } from './infrastructure/controllers/RecurrenceController';
import { categoryController } from './infrastructure/controllers/CategoryController';
import { projectController } from './infrastructure/controllers/ProjectController';
import { accountController } from './infrastructure/controllers/AccountController';
import { jobController } from './infrastructure/controllers/JobController';

const port = process.env.PORT || 8080;

const app = new Elysia()
  // Mount the global error plugin
  .use(errorPlugin)
  
  // Mount the background scheduler (cron job)
  .use(schedulerPlugin(container))
  
  // Mount controllers passing the DI container
  .use(transactionController(container))
  .use(forecastController(container))
  .use(cardController(container))
  .use(recurrenceController(container))
  .use(categoryController(container))
  .use(projectController(container))
  .use(accountController(container))
  .use(jobController(container))

  // Rota de Health Check
  .get('/', async () => {
    const adminEmail = pb.authStore.record?.email;
    return { 
      status: 'Online', 
      message: 'BFF conectado ao PocketBase',
      admin: adminEmail
    };
  })
  
  .listen({ port, hostname: '0.0.0.0' });

console.log(`🚀 Obol BFF running at ${app.server?.hostname}:${app.server?.port}`);

// Exportamos o tipo para o Nuxt consumir via Eden Treaty!
export type App = typeof app;
