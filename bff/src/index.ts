import { Elysia } from 'elysia';
import { pbPlugin } from './plugins/pocketbase';
import { transactionRoutes } from './routes/transactions';
import { forecastRoutes } from './routes/forecast';

const port = process.env.PORT || 8080;
const app = new Elysia()
  .use(pbPlugin) // Injeta o contexto { pb } em todas as rotas abaixo
  .use(transactionRoutes) // <-- Rota inteligente acoplada
  .use(forecastRoutes) // <-- Motor de Projeção no ar
  
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
  
  .listen(port);

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);

// Exportamos o tipo para o Nuxt consumir via Eden Treaty!
export type App = typeof app;
