# Obol - Estado Atual (Current State)

Este documento descreve as capacidades e funcionalidades atuais do **Obol**, uma plataforma de gestão financeira robusta dividida em Backend-for-Frontend (BFF), Frontend, e Banco de Dados (PocketBase).

## 1. Visão Geral da Arquitetura
A arquitetura do Obol foi desenhada para ser rápida, tipada ponta-a-ponta e escalável:
- **Banco de Dados (PocketBase)**: Atua como a fundação de dados. Armazena contas, cartões, categorias, projetos, transações, recorrências e **faturas (invoices)**.
- **BFF (Backend-for-Frontend com ElysiaJS e Bun)**: Intermedia a comunicação, processa cálculos complexos (como o Motor de Projeção), hospeda tarefas em background (Cron para recorrências) e cuida das regras de negócio pesadas.
- **Frontend (Nuxt 3 + Vue 3 + Nuxt UI)**: Interface rica, com componentes estilizados via TailwindCSS (Nuxt UI) e integração de estado global através do Pinia, comunicando-se com o BFF via `EdenTreaty` para manter tipagem estrita (TypeScript) sem precisar duplicar definições.

## 2. Motor de Lançamentos e Transações
O coração do aplicativo gira em torno do registro e da baixa de transações:
- **Fast Entry (Lançamento Rápido)**: Uma modal unificada que permite registrar despesas, receitas ou transferências entre contas de forma fluida.
- **Tipos de Lançamentos**: O aplicativo suporta transações normais e **transferências** atômicas (onde o dinheiro sai de uma conta de origem e entra em uma conta de destino, com baixa silenciosa, sem afetar o patrimônio/net worth).
- **Mecanismo de "Baixa" (Realize)**: Uma transação nasce como `pending` (pendente) com uma data de previsão (`expected_date`). Ao dar baixa:
  - Pode-se somar/subtrair o valor no saldo real da conta (baixa comum).
  - Pode-se dar uma **Baixa Silenciosa**, onde a transação é marcada como realizada (ganha `realized_date`), mas **não** altera o saldo da conta bancária no banco de dados (ideal para quando o usuário já ajustou o saldo manualmente).

## 3. O Monstro dos Cartões de Crédito (Invoices Engine)
O aplicativo possui um ecossistema blindado para gestão de crédito rotativo:
- **Tabela de Invoices Isolada**: Faturas são persistidas na tabela `invoices` para performance absoluta. Elas fecham, consolidam transações e suportam pagamentos parciais.
- **Cálculo e Offset de Vencimentos**: Interceptador de transações calcula as datas de fechamento (`closing_day`) através de regras de *clamping*, além de lidar com os offsets e faturas futuras.
- **Parcelamentos Finitos e Autodestrutivos**: Regras automatizadas garantem que compras parceladas gerem suas parcelas correspondentes ao longo do tempo (através de filhas de recorrências ou lógica similar) até serem quitadas, desaparecendo sozinhas em seguida.

## 4. Gestão Avançada de Recorrências (Subscriptions & Fixed Costs)
O Obol automatiza os custos fixos:
- **Centro de Controle de Assinaturas (Slideover)**: Uma interface dedicada que lista todas as assinaturas e contratos de forma centralizada.
- **Pausa e Reativação**: Permite pausar uma recorrência para que o sistema pare de gerar lançamentos nos próximos meses, podendo ser reativada a qualquer momento.
- **Lançamento Manual (Lançar Agora)**: Permite ao usuário antecipar o lançamento de uma recorrência que o Cron só iria gerar depois. Graças à "Regra de Idempotência" no banco, o sistema reconhece que o lançamento daquele mês/ano já foi feito e não duplica a cobrança quando o Job Cron roda.

## 5. Motor de Projeção e Dashboard (Forecast Engine)
O cérebro matemático do sistema que ajuda a prever o futuro e analisar o passado:
- **Projeção Futura e Retroativa**: O BFF processa a linha do tempo do dinheiro. Partindo do Saldo Atual bancário:
  - Rola para o **passado** revertendo as transações já consolidadas, descobrindo o saldo de dias atrás.
  - Rola para o **futuro** aplicando contas atrasadas, transações agendadas e simulando o impacto dos dias de pagamento das recorrências.
- **Visão Personalizável**: O gráfico interativo permite escolher períodos no horizonte (ex: 15, 30, 60, 90 dias).
- **Marcações Visuais**: O gráfico possui linhas de guia, destacando visualmente o limite exato correspondente ao "Caixa Atual".

## 6. Orçamentos e Categorias (Budgets)
Controle sobre "potes" e destinação de dinheiro:
- **Custos Fixos (Fixed Budget)**: Categorias onde um limite mensal (`monthly_budget`) é definido. A interface acompanha em tempo real a % de utilização (verde, amarelo, vermelho) somando todos os gastos do mês corrente.
- **Lógica de Performance**: O cálculo das categorias é feito em uma tacada só no Backend, sem N+1.

## 7. Freelances e Projetos
Para recebimentos fragmentados:
- **Tracker de Projetos**: Controle de projetos fechados por um valor total (`total_value`).
- **Pagamentos Parciais**: Conforme o cliente paga em parcelas, o sistema deduz os pagamentos e mostra visualmente quanto falta para bater a meta/quitar o freela.

## 8. Infraestrutura e UX
- **Reatividade com Pinia**: A aba de Gestão Financeira responde instantaneamente (saldos atualizam na hora) após uma baixa de transação.
- **Tratamento de Erros Global**: Tanto o BFF (Elysia) quanto o Frontend possuem escudos que evitam que falhas de rede quebrem a aplicação (transformando `status 0` em retornos graciosos como `502 Bad Gateway`).
