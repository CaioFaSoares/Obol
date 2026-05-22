import PocketBase from 'pocketbase';
const pb = new PocketBase('http://database:8090');
await pb.collection('_superusers').authWithPassword('caio@copland.studio', 'sua_senha_forte_aqui');

const accs = await pb.collection('accounts').getFullList();
for(let a of accs) await pb.collection('accounts').delete(a.id);
const txns = await pb.collection('transactions').getFullList();
for(let t of txns) await pb.collection('transactions').delete(t.id);

await pb.collection('accounts').create({ name: 'Nubank', type: 'checking', initial_balance: 1000 });
await pb.collection('transactions').create({ title: 'Compra', amount: 200, type: 'expense', status: 'pending', expected_date: '2026-05-25T12:00:00.000Z' });

const r = await fetch('http://localhost:8080/api/forecast?startDate=2026-05-22&endDate=2026-05-26').then(r=>r.text());
console.log(r);
