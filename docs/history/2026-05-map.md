## 🗺️ Mapa de Batalha: Projeto Obol

### 🟢 TERRITÓRIO CONQUISTADO (Backend & Frontend - 100%)

* **Fases 1, 2 e 3: As Fundações**
  * Setup do PocketBase, Orquestração em Docker Compose, Migrações e Cadeado de API Pública.
  * Motor de Negócios (BFF) com ElysiaJS e TypeBox (Eden Treaty).
  * Motor de Projeção (Forecast) e Motor do Tempo (Cron Jobs em thread isolada para recorrências).
  * Setup do Frontend: Nuxt 3, UI/ECharts/Pretext, Pinia para estado global.

* **Fase 4: A Vida Real (Telas e Fluxos)**
  * **Dashboard Mestre:** Gráfico Forecast e Cards renderizados em `/`.
  * **Fast-Entry:** Lançamento rápido.
  * **Mini-ERP:** Tela de `/management` modular.
  * **Motor de Transferências:** Baixas silenciosas, transferências atômicas sem afetar o Net Worth.
  * **Centro de Controle:** Slideover para gestão total de assinaturas e custos fixos.

* **Épico 2.1: O Monstro dos Cartões**
  * Motor completo de cálculo de faturas e offset de vencimentos.
  * Suporte a parcelamentos finitos que se autodestroem.
  * Persistência na tabela `invoices` para performance absoluta e suporte a pagamentos parciais.

---

### 🟡 O QUE FALTA (O Caminho para o Go-Live)

📍 **VOCÊ ESTÁ AQUI: A Transição de Caixa para Cenários**

Terminamos de modelar a "Realidade". O sistema agora sabe exatamente o que aconteceu e o que está acontecendo com o seu dinheiro e o seu crédito. O próximo passo é dar a ele o poder da Previsão e Auditoria.

#### 1. Épico 2.2: Master Ledger e Motor de Simulação (Nosso próximo alvo)
* **O Master Ledger**: A página central (`/ledger`) com uma tabela rica e ultra-rápida contendo todo o histórico. Implementação de busca, filtros dinâmicos e UI enriquecida com badges de categoria e conta.
* **A Máquina do Tempo (Simulação)**: Migration para adicionar a flag `is_simulated`. A inserção de um Toggle no Dashboard permitirá brincar com o futuro ("E se eu comprar esse fone mês que vem?") sem sujar o banco de dados real.

#### 2. Épico 2.3: Módulo de Investimentos (Semente)
* A separação física do dinheiro do dia a dia (Conta Corrente) do dinheiro de longo prazo (Corretoras/Poupança).
* Gráfico de rentabilidade passiva. *(Nota: Pode ser empurrado para V2 após o Deploy inicial, dependendo do tempo)*.

#### 3. Épico 1 & Fase 5: Segurança e Go-Live (A Reta Final)
* **O Cadeado**: Criar a tela de Login isolada, Middleware do Nuxt bloqueando rotas internas e trancar de vez as API Rules do PocketBase para que apenas o seu usuário mestre consiga acessar.
* **Infraestrutura**: Empacotar Frontend, BFF e Banco de Dados em containers via Docker Compose final e realizar o deploy no servidor de produção (NixOS/Coolify). Auditoria final de UX Mobile.