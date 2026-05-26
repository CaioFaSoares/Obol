import { treaty } from '@elysiajs/eden';
import type { App } from './server/src/index';

const api = treaty<App>('http://localhost:8080');

async function test() {
  const payload = {"name":"Conta Claro","amount":233.15,"payday":15,"type":"expense","account_id":"05o4vq7iaudgjal","category_id":"995xppba279bpkb"};
  const res = await api.api.recurrences.post(payload);
  console.log("Result:", JSON.stringify(res, null, 2));
}

test();
