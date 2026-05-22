# 🏗️ Arquitetura do Sistema (A Tríade)

Nesta configuração, o fluxo de dados passa a ter três camadas estritas.

## Camada 1: Frontend (Nuxt 3 + Nuxt UI)
- **Responsabilidade**: UI/UX responsiva, validação de formulários no cliente, renderização de gráficos (ex: ECharts) e controle de estado global (Pinia).
- **Comunicação**: Não faz nenhuma requisição direta ao PocketBase. Todo o tráfego passa pelo cliente tipado do Elysia (Eden Treaty) via `$fetch`. Isso garante que se houver mudança de campos no backend, o frontend acusa erro de TypeScript imediatamente durante o desenvolvimento.

## Camada 2: O BFF (ElysiaJS + Bun)
- **Responsabilidade**: O cérebro da operação. Aqui reside a lógica de negócios complexa.
  - **Motor de Projeção**: Uma rota `/api/forecast` que agrega saldos, faturas e contas a receber, calcula a matemática e devolve um array temporal limpo para o Nuxt desenhar os gráficos.
  - **Roteador de Faturas**: Intercepta `POST /api/transactions`, calcula a data da transação em relação ao fechamento do cartão (`closing_day`) e projeta a fatura correta no banco.
  - **Agregador**: Expõe `/api/dashboard` para orquestrar e consolidar dados. Em vez do front fazer 5 requisições separadas, o BFF monta o painel e devolve otimizado.

## Camada 3: Data Layer (PocketBase v0.23+)
- **Responsabilidade**: Persistência de dados (SQLite), autenticação e execução estrita de migrações em inicialização.
- **Segurança**: API pública bloqueada (`API Rules = null`). O banco está na rede interna do Docker (`finance_net`) e apenas o Elysia fala com ele via REST/SDK interno.
- **Modelagem Pai-Filho**:
  - **Pai (`recurring_incomes`)**: A "Regra". Define bolsas, salários ou contratos. Possui valor, dia de pagamento e status.
  - **Filho (`transactions`)**: O "Fato". O sistema gera as parcelas/salários do mês apontando para o ID do Pai. O usuário apenas dá "Check" (altera status para `realized`) quando a transferência ocorre.