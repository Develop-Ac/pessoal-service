# rhdp-service — RH/DP · Folha para DRE

Backend NestJS do módulo **Pessoal** da intranet. Importa o PDF da folha
(Relatório de Líquidos), mantém o cadastro de colaboradores com rateio por canal
e expõe a despesa com pessoal rateada para a DRE.

Segue o mesmo padrão do `entregas-ac-backend` (NestJS 11, Prisma, ValidationPipe
global, AllExceptionsFilter, auth JWT + APP_TOKEN legado, Swagger).

## Banco de dados

Reaproveita o SQL Server **`BI`** (DW, 192.168.1.146) — as tabelas já existem.
Prisma com `provider = "sqlserver"`, **somente introspecção** (`npm run db:pull`).

> ⚠️ **Nunca rodar `prisma migrate`.** Mudanças de estrutura são entregues como
> SQL manual para o time aplicar no servidor.

Tabelas usadas: `ImportacaoFolhaBruta`, `FolhaValoresMensais`,
`CadastroColaboradores`, `LogImportacao`. O rateio já existe pronto no DW:
view `vw_dre_base_despesa_com_pessoal` (materializada por
`sp_refresh_f_dre_base_despesa_com_pessoal` na fato `f_dre_base_despesa_com_pessoal`).

## Como rodar

```bash
cp .env.example .env      # preencha DATABASE_URL, JWT_SECRET e APP_TOKEN
npm install               # roda prisma generate no postinstall
npm run db:pull           # introspecta o banco BI (gera os models)
npm run dev               # desenvolvimento (porta 8000)
# ou
npm run build && npm start
```

A porta padrão é **8000** (convenção: todos os serviços escutam na 8000
internamente; o proxy reverso roteia por hostname). Swagger em `/docs` quando
`SWAGGER_ENABLED=true`.

### Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | `sqlserver://192.168.1.146:1433;database=BI;user=BI_AC;password={SENHA};encrypt=true;trustServerCertificate=true` — a senha vai entre `{}` por conter `@`. |
| `JWT_SECRET` | **Deve ser o mesmo segredo com que a intranet (sistema-service) assina o `auth_token`.** Senão o token do login não valida aqui. |
| `APP_TOKEN` | Token estático legado (fallback de autenticação, sem identidade). |
| `LEGACY_APP_TOKEN_ENABLED` | `true` mantém o APP_TOKEN funcionando. |
| `PORT` | 8000 |
| `CORS_ORIGIN` | Origens permitidas, separadas por vírgula. |

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Saúde + conexão com o banco (público) |
| GET | `/colaboradores` | Lista (filtros: `ativo`, `vigentes`, `semAlocacao`, `busca`) |
| GET | `/colaboradores/:id` | Detalhe |
| GET | `/colaboradores/pendencias/sem-alocacao` | Vigentes sem tipo de alocação |
| PATCH | `/colaboradores/:id` | Atualiza alocação e percentuais (valida soma=100% se `RATEIO_FIXO`) |
| POST | `/importacao/processar-arquivos` | Upload de PDF(s) → processa em background |
| GET | `/importacao/status/:jobId` | Progresso do job |
| GET | `/importacao/logs` | Histórico (`LogImportacao`) |
| GET | `/rateio` | Despesa com pessoal por canal/competência (filtros `ano`, `mes`, `canal`) |
| POST | `/rateio/atualizar` | Recalcula o rateio (`EXEC sp_refresh_...`) |
| GET/POST | `/comissoes/periodos` | Lista / abre competências (datas 26 → 25) |
| POST | `/comissoes/periodos/:id/calcular` | Lê o Firebird (OPENQUERY) e calcula em background |
| GET | `/comissoes/jobs/:jobId` | Progresso do cálculo |
| GET | `/comissoes/periodos/:id/resultado` | Dinâmica (vendedores + técnicos) |
| GET | `/comissoes/periodos/:id/relatorio/{vendas\|servicos}/:rep` | Relatório sintético p/ assinatura |
| GET/PATCH | `/comissoes/periodos/:id/parametros[/:rep]` | Abatimento, férias, %bônus por rep |
| GET/PATCH | `/comissoes/representantes[/:rep]` | Cadastro (especial/local_venda/papel) |
| POST | `/comissoes/representantes/sincronizar` | Sincroniza nome/comissiona/inativo do Firebird |
| GET | `/comissoes/{faixas\|tipos-produto}` | Configuração (TABELA % e PRO→TIPO) |

## Módulo Comissões

Converte a planilha "COMISSÕES - MM-AAAA.xlsx". O movimento (vendas de varejo,
serviços de montagem e OS externas) é lido do **Firebird** (ERP Celta) através do
**linked server `CONSULTA`** do próprio SQL Server BI, via `OPENQUERY` — o backend
não conecta direto no Firebird. As fórmulas (rateio de desconto, líquido,
classificação por TIPO, faixas de %, média de férias do vendedor, 1,75% + bônus do
técnico, 0,65% do supervisor) estão em `src/comissoes/calculo-engine.ts` e foram
**validadas à vírgula** contra a planilha de 05/2026 (ver `validacao/`).

### Passos para colocar no ar (uma vez)

```sql
-- 1) No SQL Server BI, aplicar manualmente (nesta ordem):
--    sql/01_comissoes_schema.sql      (tabelas + seeds de faixas/PRO→TIPO)
--    sql/02_comissoes_seed_representantes.sql   (cadastro inicial da BASE)
```

```bash
# 2) Atualizar o cliente Prisma se for usar os models (opcional — o módulo usa SQL cru):
npm run db:pull && npm run db:generate
```

3. `POST /comissoes/representantes/sincronizar` — traz nome/comissiona/inativo do
   Firebird (preserva as colunas manuais `especial`/`local_venda`/`papel`).
4. Marcar o **supervisor** (BRUNO) com `papel = SUPERVISOR` no cadastro.
5. `POST /comissoes/periodos {ano, mes}` → `POST /comissoes/periodos/:id/calcular`.

> ⚠️ O login do backend (BI_AC) precisa de permissão para executar `OPENQUERY`
> no linked server `CONSULTA`. Se faltar, o cálculo falha ao ler o Firebird.

### Regras de inclusão (decididas com o usuário)

- **Quem entra:** representante com `papel` (VENDEDOR/TECNICO/SUPERVISOR), não
  inativo e com movimento no período. **Não** se filtra por `calcula_comissao`
  (montadores são `N` no ERP e mesmo assim recebem).
- **Escopo de vendedor = varejo (BALCÃO).** Atacado fica fora por padrão
  (`papel` nulo); habilite caso a caso no cadastro.
- Vendedores sem venda real (ou só devolução) aparecem para revisão; remova o
  `papel` de quem não é vendedor de fato para tirá-lo do cálculo.

## Comportamento da importação (igual ao sistema Python anterior)

- Idempotente por **(competência + arquivo)**: reimportar um PDF remove e
  regrava as linhas daquele arquivo, sem duplicar.
- A sincronização do cadastro roda por **competência inteira** — reimportar um
  arquivo re-sincroniza todos os colaboradores daquela competência (cria os que
  faltam e versiona por mudança de departamento via `vigencia_final`).

## Integração com o frontend (cotacao-frontend)

O módulo **Pessoal** foi adicionado ao `cotacao-frontend`:

- Menu lateral em `app/(private)/layout.tsx` (seção **Pessoal**, submenus
  Folha para DRE / Colaboradores / Rateio).
- Telas em `app/(private)/pessoal/{folha-dre,colaboradores,rateio}`.
- Cliente de API em `lib/pessoal/` e proxy server-side em
  `app/api/proxy/pessoal/[...path]` (lê o cookie `auth_token` e repassa ao
  backend com `Authorization: Bearer`).
- `NEXT_PUBLIC_PESSOAL_SERVICE_BASE` no `.env` do frontend aponta para o host
  do serviço (ex: `http://pessoal-service.acacessorios.local`).

### Liberação de acesso (já incluída na tela de Usuários)

O módulo **Pessoal** foi adicionado ao catálogo de permissões em
`app/(private)/usuario/page.tsx` (`PERMISSOES_SETORES`): aparece no modal de
permissões com as telas `/pessoal`, `/pessoal/folha-dre`,
`/pessoal/colaboradores`, `/pessoal/rateio`. Foram criados os perfis **RH** e
**DP** (e a Pessoal também consta no perfil **Admin**). O sistema de permissões
é data-driven — o admin marca Visualizar/Editar nas telas e o sistema-service
grava via `POST/PUT /permissoes/:userId?modulo=Pessoal&tela=...`. Ao logar, o
`/api/auth/me` devolve essas permissões e o menu Pessoal aparece. **Nenhuma
mudança no backend sistema-service é necessária.**

### ⚠️ Ponto que ainda depende do ambiente

1. **`JWT_SECRET` compartilhado.** O proxy repassa o `auth_token` da intranet;
   o rhdp-service o valida com `JWT_SECRET`. Esse segredo precisa ser o mesmo
   usado pelo login da intranet para assinar o token. (No `.env` atual foi
   copiado do `entregas-ac-backend`; confirme que bate com o sistema-service.)

