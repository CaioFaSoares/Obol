# 🏗️ Arquitetura do Sistema (A Tríade)

> [!NOTE] 
> **Status da Arquitetura:**
> - **Backend (Data + BFF)**: 🟢 **CONCLUÍDO (SEALED)**
> - **Frontend (Nuxt)**: 🟡 **EM ANDAMENTO (FASE 3)**

Nesta configuração, o fluxo de dados possui três camadas estritas:

## Camada 1: Frontend (Nuxt 3 + Nuxt UI) - *Em Desenvolvimento*
- **Responsabilidade**: UI/UX responsiva, validação de formulários no cliente, renderização de gráficos (ex: ECharts) e controle de estado global (Pinia).
- **Comunicação**: Não faz nenhuma requisição direta ao PocketBase. Todo o tráfego passa pelo cliente tipado do Elysia (Eden Treaty) via `$fetch`. Isso garante que se houver mudança de campos no backend, o frontend acusa erro de TypeScript imediatamente durante o desenvolvimento.

## Camada 2: O BFF (ElysiaJS + Bun) - *Concluído*
- **Responsabilidade**: O cérebro da operação. Aqui reside a lógica de negócios complexa e as operações autônomas.
  - **Motor de Projeção (Forecast)**: Rota `/api/forecast` que agrega saldos e faturas, calcula a matemática via loop diário (CPU bound no Bun) e devolve um array temporal limpo para os gráficos.
  - **Interceptador de Transações**: Intercepta `POST /api/transactions`, calcula datas de fechamento/vencimento do cartão (`closing_day`) via regra de *clamping* e projeta a fatura correta.
  - **Motor do Tempo (Cron Jobs)**: Relógio em background utilizando `@elysiajs/cron` isolado da thread HTTP, responsável por aplicar regras rigorosas de idempotência e gerar cobranças mensais automáticas.
  - **Validação Estrita**: Utilização massiva de TypeBox (DTOs) garantindo que nenhum lixo ou requisição mal formada consiga encostar no banco.

**Módulos e Rotas Principais**:
- `transactionRoutes`: CRUD e listagem de transações, lidando com lógica de pagamentos e transferências.
- `forecastRoutes`: O Motor de projeção financeira focado em previsões futuras.
- `jobsRoutes`: O Motor do tempo/cron, disparando a avaliação de recorrências.
- `recurrenceRoutes`: CRUD de entidades repetitivas (assinaturas, contas mensais).
- `categoryRoutes`, `projectRoutes`, `accountRoutes`, `cardRoutes`: CRUDs das entidades de apoio.
O BFF injeta a instância do PocketBase autenticada via `pbPlugin` para todas essas rotas.

## Camada 3: Data Layer (PocketBase v0.23+) - *Concluído*
- **Responsabilidade**: Persistência de dados (SQLite), autenticação superuser silenciosa e execução de migrações DDL em inicialização.
- **Segurança**: API pública rigorosamente bloqueada (`API Rules = null`). O banco está ilhado na rede interna do Docker (`finance_net`) e apenas o container do Elysia fala com ele.
- **Modelagem Pai-Filho**:
  - **Pai (`recurrences`)**: A "Regra". Define assinaturas, bolsas, salários ou contratos (valor, vencimento e origem/destino de pagamento).
  - **Filho (`transactions`)**: O "Fato". O sistema gera as parcelas do mês apontando para o ID do Pai. O usuário apenas dá "Check" quando a transferência ocorre.

**Coleções Principais**:
- `accounts`: Contas bancárias/investimento (`name`, `type`, `initial_balance`).
- `cards`: Cartões de crédito (`name`, `closing_day`, `due_day`, `limit`).
- `categories`: Organização de gastos (`name`, `type`, `monthly_budget`).
- `projects`: Agrupamento de freelas (`name`, `total_value`, `status`).
- `recurrences`: Regras para receitas/despesas automáticas (`status: active/paused/ended`).
- `transactions`: Entradas e saídas de dinheiro, interligadas com as coleções acima usando relations (IDs dinâmicos).