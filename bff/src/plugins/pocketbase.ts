import PocketBase from 'pocketbase';
import { Elysia } from 'elysia';

// Instância global Singleton
export const pb = new PocketBase(process.env.POCKETBASE_URL);

// Autentica no startup do container usando top-level await (suportado no Bun)
let retries = 5;
while (retries > 0) {
  try {
    console.log(`🔄 Autenticando Admin no PocketBase (Tentativas restantes: ${retries})...`);
    await pb.collection('_superusers').authWithPassword(
      process.env.PB_ADMIN_EMAIL!,
      process.env.PB_ADMIN_PASSWORD!
    );
    console.log("✅ Admin autenticado!");
    break;
  } catch (err: any) {
    console.error("❌ Erro ao autenticar no PocketBase:", err.message);
    retries--;
    if (retries === 0) {
      console.error("🚨 Falha crítica: Não foi possível autenticar após várias tentativas.");
    } else {
      console.log("⏳ Aguardando 2 segundos para tentar novamente...");
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// Plugin do Elysia que injeta a instância (pb) de forma estática (mais rápido que derive)
export const pbPlugin = new Elysia({ name: 'pocketbase-plugin' })
  .decorate('pb', pb);
