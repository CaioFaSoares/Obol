# 🪙 Obol - Documentação Central

Bem-vindo ao cérebro do projeto **Obol**. Toda a arquitetura, regras de negócio e anotações estão estruturadas aqui.

## 🗺️ Mapa de Todos os Arquivos

Esta lista gera automaticamente um índice de **todos os arquivos** de conteúdo presentes na nossa documentação (ignorando páginas de sistema), em ordem alfabética:

${query[[
  from p = index.contentPages()
  where p.name != "index"
  order by p.name asc
  select templates.pageItem(p)
]]}

---

## 🔄 Arquivos Editados Recentemente

Como a pasta de dinâmicos foi removida, aqui está uma visualização de todos os arquivos modificados recentemente na sua base (do mais novo para o mais antigo), para fácil acesso:

${query[[
  from p = index.contentPages()
  where p.name != "index"
  order by p.lastModified desc
  limit 10
  select templates.pageItem(p)
]]}

---

## 📝 Tarefas Pendentes
Um resumo rápido de tarefas anotadas nos arquivos (usando `[ ]`):

${query[[
  from t = index.tasks()
  where not t.done
  order by t.pageLastModified desc 
  limit 10
  select templates.taskItem(t)
]]}
