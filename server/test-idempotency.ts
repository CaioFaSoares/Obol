import PocketBase from 'pocketbase';

const pb = new PocketBase(process.env.POCKETBASE_URL || 'http://localhost:13090');
await pb.collection('_superusers').authWithPassword('caio@copland.studio', 'sua_senha_forte_aqui');

// 1. Limpar
const incomes = await pb.collection('recurring_incomes').getFullList();
for(let i of incomes) await pb.collection('recurring_incomes').delete(i.id);
const txns = await pb.collection('transactions').getFullList();
for(let t of txns) await pb.collection('transactions').delete(t.id);

// 2. Criar Bolsa Teste Idempotência (payday: 31)
await pb.collection('recurring_incomes').create({
  name: "Bolsa Teste Idempotência",
  amount: 500,
  payday: 31,
  status: "active"
});

console.log("Mock data created. Triggering first cron execution...");
const r1 = await fetch('http://localhost:13080/api/jobs/recurrence', { method: 'POST' }).then(r=>r.json());
console.log("Result 1:", r1);

console.log("Triggering second cron execution (Idempotency Test)...");
const r2 = await fetch('http://localhost:13080/api/jobs/recurrence', { method: 'POST' }).then(r=>r.json());
console.log("Result 2:", r2);
