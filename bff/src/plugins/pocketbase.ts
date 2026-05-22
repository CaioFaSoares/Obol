import PocketBase from 'pocketbase';
import { Elysia } from 'elysia';

// Instância global Singleton
const pb = new PocketBase(process.env.POCKETBASE_URL);

// Autentica no startup do container usando top-level await (suportado no Bun)
try {
  console.log("🔄 Autenticando Admin no PocketBase (Startup)...");
  await pb.collection('_superusers').authWithPassword(
    process.env.PB_ADMIN_EMAIL!,
    process.env.PB_ADMIN_PASSWORD!
  );
  console.log("✅ Admin autenticado!");
} catch (err) {
  console.error("❌ Erro ao autenticar no PocketBase:", err);
}

// Plugin do Elysia que injeta a instância (pb) de forma estática (mais rápido que derive)
export const pbPlugin = new Elysia({ name: 'pocketbase-plugin' })
  .decorate('pb', pb);
