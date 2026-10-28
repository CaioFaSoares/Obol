import { Elysia } from 'elysia';
import type PocketBase from 'pocketbase';
import { createPocketBaseClient } from './infrastructure/plugins/pocketbase';
import { createContainer } from './infrastructure/di/container';
import { errorPlugin } from './infrastructure/plugins/errorPlugin';
import { schedulerPlugin } from './infrastructure/scheduler';
import { transactionController } from './infrastructure/controllers/TransactionController';
import { forecastController } from './infrastructure/controllers/ForecastController';
import { cardController } from './infrastructure/controllers/CardController';
import { recurrenceController } from './infrastructure/controllers/RecurrenceController';
import { categoryController } from './infrastructure/controllers/CategoryController';
import { projectController } from './infrastructure/controllers/ProjectController';
import { accountController } from './infrastructure/controllers/AccountController';
import { jobController } from './infrastructure/controllers/JobController';


/** Builds the BFF around an already authenticated PocketBase client. */
export function createServer(pb: PocketBase) {
  const container = createContainer(pb);

  return new Elysia()
    .use(errorPlugin)
    .use(schedulerPlugin(container))
    .use(transactionController(container))
    .use(forecastController(container))
    .use(cardController(container))
    .use(recurrenceController(container))
    .use(categoryController(container))
    .use(projectController(container))
    .use(accountController(container))
    .use(jobController(container))
    .get('/', () => ({
      status: 'Online',
      message: 'BFF connected to PocketBase',
      admin: pb.authStore.record?.email
    }));
}

export type App = ReturnType<typeof createServer>;

export async function startHostedServer() {
  const pb = await createPocketBaseClient({
    url: process.env.POCKETBASE_URL ?? '',
    adminEmail: process.env.PB_ADMIN_EMAIL ?? '',
    adminPassword: process.env.PB_ADMIN_PASSWORD ?? ''
  });
  const app = createServer(pb);
  const port = Number(process.env.PORT) || 8080;
  app.listen({ port, hostname: '0.0.0.0' });
  console.log(`🚀 Obol BFF running at ${app.server?.hostname}:${app.server?.port}`);
  return app;
}

if (import.meta.main) await startHostedServer();
