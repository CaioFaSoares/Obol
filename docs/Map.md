Como seu PO, aqui está o **Status Report Executivo** do nosso projeto.

Nós desenhamos a fundação estrutural e definimos as regras do jogo. Ao adotarmos a abordagem de Infraestrutura como Código no Sprint Zero, garantimos que o alicerce está sólido.

Aqui está o mapa geral da nossa trilha, consolidando o que já temos e os próximos passos, sem aprofundar no código ainda.

---

## 📊 Status Geral do Projeto: Fase de Fundação (Concluída)

### ✅ O Que Já Está Feito (Sprint 0)

* **Inicialização dos Repositórios:** Projetos base criados para o Frontend (Nuxt) e BFF (Elysia).
* **Orquestração (Docker Compose):** Ambiente de desenvolvimento definido com isolamento de rede, englobando:
  * Frontend (Nuxt exposto na porta 3000).
  * BFF (ElysiaJS rodando isolado).
  * Database (PocketBase isolado e persistente).
  * Laboratório de Docs (SilverBullet/Markdown exposto na porta 3030).

* **Modelagem de Dados & IaC (PocketBase):** Script de migração automática escrito para criar o usuário Admin via variáveis de ambiente e gerar as seguintes coleções, todas com acesso público bloqueado:
  * `accounts` (Contas Bancárias)
  * `cards` (Cartões de Crédito com regras de fechamento)
  * `categories` (Potes e orçamentos)
  * `projects` (Freelas/Contratos)
  * `recurring_incomes` (Bolsas e Salários fixos)
  * `transactions` (O coração do sistema, linkando tudo)

---

## 🗺️ Roadmap de Desenvolvimento (O Que Falta e Como Será Feito)

### ⏳ Fase 1: O Motor de Negócios (ElysiaJS / BFF)

*Nesta fase, criamos o cérebro do sistema. O frontend ainda não existe visualmente.*

1. **Conexão Segura:** Configurar o Elysia para conversar com o PocketBase usando o token administrativo gerado na migração.
2. **Definição de Contratos (Tipagem):** Criar as rotas de CRUD básicas e validar todas as entradas/saídas para que o TypeScript saiba exatamente o formato dos dados.
3. **Lógica de Faturas de Cartão:** Implementar o interceptador que avalia se uma transação no cartão cai no mês atual ou no próximo, baseando-se no "closing_day".
4. **Algoritmo de Projeção:** Desenvolver o endpoint de "Forecast", que varre as transações futuras, as faturas e saldos atuais, e cospe um array contínuo de saldos diários.

### ⏳ Fase 2: Automação do Tempo (Cron Jobs)

*Nesta fase, ensinamos o sistema a lidar com a passagem dos meses.*

1. **O "Motor do Tempo":** Criar um script agendado no Elysia (rodando diariamente) para varrer a tabela `recurring_incomes`.
2. **Geração Automática:** Se estivermos perto do dia de pagamento de uma Bolsa/Salário e não houver transação gerada para aquele mês, o script cria uma transaction pendente automaticamente.

### ⏳ Fase 3: Infraestrutura Visual (Nuxt 3)

*Nesta fase, conectamos o frontend ao cérebro e preparamos as ferramentas de UI.*

1. **Integração RPC (Eden Treaty):** Conectar o Nuxt ao Elysia para termos tipagem ponta a ponta. Se o backend mudar, o Nuxt aponta o erro na hora.
2. **Configuração do Design System:** Injetar o Nuxt UI e definir os tokens de design (cores, espaçamentos).
3. **Motores Visuais:** Configurar o pretext (no client-side) para tipografia avançada e o vue-echarts para o gráfico responsivo.
4. **Gestão de Estado:** Criar as stores do Pinia para guardar em cache o saldo atual das contas, evitando carregamentos lentos.

### ⏳ Fase 4: Interfaces e Fluxos de Usuário (Nuxt UI)

*Nesta fase, construímos as telas que você usará no dia a dia.*

1. **Dashboard de Previsão:** A tela principal consumindo o endpoint de Forecast e desenhando o ECharts.
2. **Modal "Fast-Entry":** O formulário de atrito zero para lançar um café ou Uber em menos de 3 segundos, acessível de qualquer lugar do app.
3. **Painel de Contratos e Bolsas:** A tela para visualizar seus freelas ativos, suas bolsas (pais) e dar o "Check" de recebido nos pagamentos (filhos).
4. **Painel de Potes:** Interface para visualizar quanto do limite de cada categoria foi consumido no mês atual.

### ⏳ Fase 5: Go-Live

*O polimento final.*

1. **Auditoria Mobile:** Testar o uso das telas e modais em proporção de celular.
2. **Deploy Produtivo:** Subir os containers finais na sua infraestrutura self-hosted via NixOS/Coolify.