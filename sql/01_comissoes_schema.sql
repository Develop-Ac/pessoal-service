/* =============================================================================
   MÓDULO COMISSÕES — Esquema (SQL Server, banco BI / 192.168.1.146)
   -----------------------------------------------------------------------------
   Converte a planilha "COMISSÕES - MM-AAAA.xlsx" para o backend rhdp-service.

   Fonte do movimento: linked server CONSULTA (Firebird Celta.fdb) via OPENQUERY.
   Estas tabelas guardam APENAS configuração, parâmetros manuais e o snapshot
   calculado de cada competência (auditoria + relatórios de assinatura).

   ⚠️ Aplicar MANUALMENTE no servidor (não há prisma migrate neste projeto).
   Idempotente: usa IF NOT EXISTS; rode quantas vezes precisar.
   ============================================================================= */

SET NOCOUNT ON;
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/* -----------------------------------------------------------------------------
   1) ComissaoRepresentante
   Cadastro de quem comissiona. As colunas rep_codigo/nome/calcula_comissao/
   inativo são SINCRONIZADAS do Firebird (tabela representantes). As colunas
   especial / local_venda / papel são MANTIDAS AQUI (config de comissão) e NÃO
   devem ser sobrescritas pela sincronização.
   papel: VENDEDOR | TECNICO | SUPERVISOR (supervisor = linha 0,65% do serviço).
   local_venda: BALCÃO | ATACADO | SERVIÇO.
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.ComissaoRepresentante', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ComissaoRepresentante (
        rep_codigo        INT           NOT NULL
            CONSTRAINT PK_ComissaoRepresentante PRIMARY KEY,
        nome              VARCHAR(200)  NULL,
        calcula_comissao  BIT           NOT NULL CONSTRAINT DF_ComRep_calcula DEFAULT (0),
        inativo           BIT           NOT NULL CONSTRAINT DF_ComRep_inativo DEFAULT (0),
        especial          BIT           NOT NULL CONSTRAINT DF_ComRep_especial DEFAULT (0),
        local_venda       VARCHAR(20)   NULL,
        papel             VARCHAR(20)   NULL,
        data_atualizacao  DATETIME      NOT NULL CONSTRAINT DF_ComRep_dtatu DEFAULT (GETDATE())
    );
    CREATE INDEX IX_ComissaoRepresentante_papel ON dbo.ComissaoRepresentante (papel);
END
GO

/* -----------------------------------------------------------------------------
   2) ComissaoFaixaPercentual  (a aba "TABELA %")
   Faixas progressivas do % de comissão do VENDEDOR sobre a Base Geral.
   tipo_tabela: ESPECIAL (rep com especial=1) | DEMAIS (rep normal).
   A faixa casa quando: valor_min < BaseGeral <= valor_max  (ver engine).
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.ComissaoFaixaPercentual', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ComissaoFaixaPercentual (
        id           INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_ComissaoFaixaPercentual PRIMARY KEY,
        tipo_tabela  VARCHAR(20)    NOT NULL,           -- ESPECIAL | DEMAIS
        valor_min    DECIMAL(18,2)  NOT NULL,
        valor_max    DECIMAL(18,2)  NOT NULL,
        percentual   DECIMAL(9,6)   NOT NULL,           -- ex.: 0.008500 = 0,85%
        ativo        BIT            NOT NULL CONSTRAINT DF_ComFaixa_ativo DEFAULT (1)
    );
    CREATE INDEX IX_ComissaoFaixaPercentual_tipo ON dbo.ComissaoFaixaPercentual (tipo_tabela, ativo);
END
GO

/* -----------------------------------------------------------------------------
   3) ComissaoTipoProduto  (mapa PRO_CODIGO -> TIPO, mantido na BASE)
   Classifica o produto para tirar frete/mão-de-obra/pintura/impostos da base.
   Guardamos o mapa EFETIVO (já com a precedência da planilha):
     opf=2 -> DEVOLUÇÃO  (tratado no engine, não aqui)
     9711  -> PINTURA    (a fórmula força PINTURA antes do lookup)
     47777 -> IMPOSTOS
     13497, 46784 -> FRETE
     4174  -> MAO DE OBRA
   Qualquer pro_codigo ausente => VENDAS.
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.ComissaoTipoProduto', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ComissaoTipoProduto (
        pro_codigo  INT           NOT NULL
            CONSTRAINT PK_ComissaoTipoProduto PRIMARY KEY,
        tipo        VARCHAR(20)   NOT NULL,             -- FRETE|MAO DE OBRA|PINTURA|IMPOSTOS
        descricao   VARCHAR(250)  NULL
    );
END
GO

/* -----------------------------------------------------------------------------
   4) ComissaoPeriodo  (uma competência comissional = 26 do mês-1 a 25 do mês)
   status: ABERTO -> CALCULADO -> FECHADO.
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.ComissaoPeriodo', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ComissaoPeriodo (
        id             INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_ComissaoPeriodo PRIMARY KEY,
        ano            INT          NOT NULL,
        mes            INT          NOT NULL,           -- competência (mês do dia 25)
        data_inicio    DATE         NOT NULL,           -- 26 do mês anterior
        data_fim       DATE         NOT NULL,           -- 25 do mês
        dias_corridos  INT          NOT NULL,
        status         VARCHAR(20)  NOT NULL CONSTRAINT DF_ComPer_status DEFAULT ('ABERTO'),
        data_calculo   DATETIME     NULL,
        data_criacao   DATETIME     NOT NULL CONSTRAINT DF_ComPer_dtcri DEFAULT (GETDATE()),
        CONSTRAINT UQ_ComissaoPeriodo_competencia UNIQUE (ano, mes)
    );
END
GO

/* -----------------------------------------------------------------------------
   5) ComissaoParametroManual  (entradas que o usuário digita por período/rep)
   Vendedor: abatimento, tem_ferias, dias_ferias (a média de férias é CALCULADA).
   Técnico:  abatimento, pct_bonus.
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.ComissaoParametroManual', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ComissaoParametroManual (
        id           INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_ComissaoParametroManual PRIMARY KEY,
        periodo_id   INT            NOT NULL,
        rep_codigo   INT            NOT NULL,
        abatimento   DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComParam_abat DEFAULT (0),
        tem_ferias   BIT            NOT NULL CONSTRAINT DF_ComParam_temfer DEFAULT (0),
        dias_ferias  INT            NOT NULL CONSTRAINT DF_ComParam_diasfer DEFAULT (0),
        pct_bonus    DECIMAL(9,6)   NOT NULL CONSTRAINT DF_ComParam_bonus DEFAULT (0),
        data_atualizacao DATETIME   NOT NULL CONSTRAINT DF_ComParam_dtatu DEFAULT (GETDATE()),
        CONSTRAINT UQ_ComissaoParametroManual UNIQUE (periodo_id, rep_codigo),
        CONSTRAINT FK_ComParam_periodo FOREIGN KEY (periodo_id)
            REFERENCES dbo.ComissaoPeriodo (id)
    );
END
GO

/* -----------------------------------------------------------------------------
   6) ComissaoResultadoVendedor  (snapshot calculado — aba DINAMICA, bloco VENDEDORES)
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.ComissaoResultadoVendedor', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ComissaoResultadoVendedor (
        id              INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_ComissaoResultadoVendedor PRIMARY KEY,
        periodo_id      INT            NOT NULL,
        rep_codigo      INT            NOT NULL,
        nome            VARCHAR(200)   NULL,
        especial        BIT            NOT NULL CONSTRAINT DF_ComResV_esp DEFAULT (0),
        vendas          DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResV_vendas DEFAULT (0),
        devolucao       DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResV_dev DEFAULT (0),
        frete           DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResV_frete DEFAULT (0),
        mao_obra        DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResV_mo DEFAULT (0),
        impostos        DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResV_imp DEFAULT (0),
        pintura         DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResV_pint DEFAULT (0),
        abatimento      DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResV_abat DEFAULT (0),
        media_ferias    DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResV_mf DEFAULT (0),
        dias_ferias     INT            NOT NULL CONSTRAINT DF_ComResV_df DEFAULT (0),
        base_real       DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResV_br DEFAULT (0),
        base_geral      DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResV_bg DEFAULT (0),
        percentual      DECIMAL(9,6)   NOT NULL CONSTRAINT DF_ComResV_pct DEFAULT (0),
        valor_comissao  DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResV_vc DEFAULT (0),
        custo           DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResV_custo DEFAULT (0),
        lucratividade   DECIMAL(18,6)  NULL,
        data_calculo    DATETIME       NOT NULL CONSTRAINT DF_ComResV_dt DEFAULT (GETDATE()),
        CONSTRAINT UQ_ComissaoResultadoVendedor UNIQUE (periodo_id, rep_codigo),
        CONSTRAINT FK_ComResV_periodo FOREIGN KEY (periodo_id)
            REFERENCES dbo.ComissaoPeriodo (id)
    );
END
GO

/* -----------------------------------------------------------------------------
   7) ComissaoResultadoTecnico  (snapshot calculado — aba DINAMICA, bloco TÉCNICOS)
   is_supervisor=1 => linha 0,65% sobre toda a base de serviço.
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.ComissaoResultadoTecnico', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ComissaoResultadoTecnico (
        id              INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_ComissaoResultadoTecnico PRIMARY KEY,
        periodo_id      INT            NOT NULL,
        rep_codigo      INT            NULL,            -- NULL na linha "sem apontamento"
        nome            VARCHAR(200)   NULL,
        is_supervisor   BIT            NOT NULL CONSTRAINT DF_ComResT_sup DEFAULT (0),
        valor_base      DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResT_vb DEFAULT (0),
        abatimento      DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResT_abat DEFAULT (0),
        base_calculo    DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResT_bc DEFAULT (0),
        percentual      DECIMAL(9,6)   NOT NULL CONSTRAINT DF_ComResT_pct DEFAULT (0),
        valor_comissao  DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResT_vc DEFAULT (0),
        pct_bonus       DECIMAL(9,6)   NOT NULL CONSTRAINT DF_ComResT_pb DEFAULT (0),
        valor_bonus     DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResT_vbon DEFAULT (0),
        total           DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResT_tot DEFAULT (0),
        data_calculo    DATETIME       NOT NULL CONSTRAINT DF_ComResT_dt DEFAULT (GETDATE()),
        CONSTRAINT FK_ComResT_periodo FOREIGN KEY (periodo_id)
            REFERENCES dbo.ComissaoPeriodo (id)
    );
    CREATE INDEX IX_ComissaoResultadoTecnico_periodo ON dbo.ComissaoResultadoTecnico (periodo_id);
END
GO

/* -----------------------------------------------------------------------------
   8) ComissaoMovimento  (snapshot item-a-item — alimenta os relatórios sintéticos
   de assinatura). origem: VENDAS | SERVICO | OS.
   Guarda o líquido/base já calculado por item e o TIPO classificado.
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.ComissaoMovimento', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ComissaoMovimento (
        id              BIGINT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_ComissaoMovimento PRIMARY KEY,
        periodo_id      INT            NOT NULL,
        origem          VARCHAR(10)    NOT NULL,        -- VENDAS | SERVICO | OS
        rep_codigo      INT            NULL,
        nfs             BIGINT         NULL,
        nota_fiscal     VARCHAR(50)    NULL,
        dt_emissao      DATE           NULL,
        ordem_servico   VARCHAR(50)    NULL,
        cli_codigo      INT            NULL,
        cli_nome        VARCHAR(200)   NULL,
        pro_codigo      INT            NULL,
        pro_descricao   VARCHAR(250)   NULL,
        opf_codigo      INT            NULL,
        quantidade      DECIMAL(18,4)  NULL,
        unitario        DECIMAL(18,6)  NULL,
        total_produtos2 DECIMAL(18,2)  NULL,
        desconto        DECIMAL(18,2)  NULL,
        liquido         DECIMAL(18,2)  NULL,            -- vendas: LIQUIDO_PRODUTO; serviço: BASE_COMISSÃO; OS: total
        custo           DECIMAL(18,2)  NULL,
        tipo            VARCHAR(20)    NULL,            -- VENDAS/DEVOLUÇÃO/FRETE/MAO DE OBRA/PINTURA/IMPOSTOS
        CONSTRAINT FK_ComMov_periodo FOREIGN KEY (periodo_id)
            REFERENCES dbo.ComissaoPeriodo (id)
    );
    CREATE INDEX IX_ComissaoMovimento_periodo_rep ON dbo.ComissaoMovimento (periodo_id, rep_codigo, origem);
END
GO

/* =============================================================================
   SEEDS de configuração (idempotentes)
   ============================================================================= */

/* TABELA % — faixas (valor_min exclusivo, valor_max inclusivo no engine) ------ */
IF NOT EXISTS (SELECT 1 FROM dbo.ComissaoFaixaPercentual)
BEGIN
    INSERT INTO dbo.ComissaoFaixaPercentual (tipo_tabela, valor_min, valor_max, percentual) VALUES
    -- ESPECIAL
    ('ESPECIAL',        0.01,       110000.00, 0.010000),
    ('ESPECIAL',   110000.01,       140000.00, 0.012000),
    ('ESPECIAL',   140000.01,       170000.00, 0.015000),
    ('ESPECIAL',   170000.01,       200000.00, 0.017000),
    ('ESPECIAL',   200000.01, 999999999999.00, 0.020000),
    -- DEMAIS
    ('DEMAIS',          0.01,        70000.00, 0.008500),
    ('DEMAIS',      70000.01,       100000.00, 0.010000),
    ('DEMAIS',     100000.01,       130000.00, 0.011000),
    ('DEMAIS',     130000.01,       160000.00, 0.011500),
    ('DEMAIS',     160000.01,       180000.00, 0.012000),
    ('DEMAIS',     180000.01, 999999999999.00, 0.013000);
END
GO

/* PRO_CODIGO -> TIPO (mapa efetivo) ------------------------------------------- */
MERGE dbo.ComissaoTipoProduto AS alvo
USING (VALUES
    (13497, 'FRETE',       'FRETE - TRANSPORTE'),
    (46784, 'FRETE',       'MAO DE OBRA - TAXA ROTA SINISTRO'),
    ( 4174, 'MAO DE OBRA',  'MAO DE OBRA - DIVERSOS'),
    ( 9711, 'PINTURA',     'MAO DE OBRA - PINTURA'),
    (47777, 'IMPOSTOS',    'IMPOSTOS')
) AS fonte (pro_codigo, tipo, descricao)
   ON alvo.pro_codigo = fonte.pro_codigo
WHEN NOT MATCHED BY TARGET THEN
    INSERT (pro_codigo, tipo, descricao) VALUES (fonte.pro_codigo, fonte.tipo, fonte.descricao);
GO

PRINT 'Esquema de Comissões criado/atualizado com sucesso.';
GO
