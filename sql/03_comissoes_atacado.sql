/* =============================================================================
   MÓDULO COMISSÕES — ATACADO (mix e faixa)  — SQL Server, banco BI / 192.168.1.146
   -----------------------------------------------------------------------------
   Comissão dos vendedores de ATACADO. Diferente do varejo/serviço (que leem o
   Firebird via OPENQUERY), a base do atacado é o próprio DW (SQL Server):
   a view dbo.vw_analise_vendas, campos mix_custo (1/2/3), faixa_mix (A/B/C/D) e
   liquido_produto. Reproduz a pergunta 422 do Metabase ("Comissão Por Mix e
   Faixa") + as regras extras da intranet (abatimento e média de férias do mix 2/3).

   Vendedor de atacado = ComissaoRepresentante.local_venda = 'ATACADO' (e não
   inativo). Esses reps NÃO entram no bloco de vendedores do varejo (papel <> 'VENDEDOR').

   Regras (alíquotas em TABELAS EDITÁVEIS abaixo):
     - mix 2 e 3: alíquota progressiva sobre o TOTAL de vendas do vendedor
       (mesma tabela "DEMAIS" do varejo). A média de férias projeta esse total
       para a escolha da faixa; a comissão é paga sobre a venda real.
     - mix 1: % FIXO por faixa A/B/C/D. Dobra quando o mix 1 atinge a meta de
       participação (>= 30% do total). NÃO sofre média de férias.
     - abatimento (R$): reduz o total de vendas (escolha da faixa do mix 2/3) e a
       base comissionável, proporcionalmente entre as células.

   ⚠️ Aplicar MANUALMENTE no servidor (não há prisma migrate). Idempotente.
   ============================================================================= */

SET NOCOUNT ON;
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/* -----------------------------------------------------------------------------
   1) ComissaoAtacadoFaixaMix23  — alíquota progressiva do mix 2/3 (editável)
   Casa quando: total_para_faixa <= valor_max (faixas em ordem crescente; a
   última, "acima de", tem valor_max gigante). valor_min é só informativo/UI.
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.ComissaoAtacadoFaixaMix23', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ComissaoAtacadoFaixaMix23 (
        id           INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_ComAtacFaixaMix23 PRIMARY KEY,
        valor_min    DECIMAL(18,2)  NOT NULL,
        valor_max    DECIMAL(18,2)  NOT NULL,
        percentual   DECIMAL(9,6)   NOT NULL,           -- ex.: 0.008500 = 0,85%
        ativo        BIT            NOT NULL CONSTRAINT DF_ComAtacFaixaMix23_ativo DEFAULT (1)
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM dbo.ComissaoAtacadoFaixaMix23)
BEGIN
    INSERT INTO dbo.ComissaoAtacadoFaixaMix23 (valor_min, valor_max, percentual) VALUES
    (        0.00,        70000.00, 0.008500),
    (    70000.01,       100000.00, 0.010000),
    (   100000.01,       130000.00, 0.011000),
    (   130000.01,       160000.00, 0.011500),
    (   160000.01,       180000.00, 0.012000),
    (   180000.01, 999999999999.00, 0.013000);
END
GO

/* -----------------------------------------------------------------------------
   2) ComissaoAtacadoFaixaMix1  — % fixo do mix 1 por faixa A/B/C/D (editável)
   atingiu_meta = 1 -> % dobrado (mix 1 alcançou a meta de participação).
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.ComissaoAtacadoFaixaMix1', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ComissaoAtacadoFaixaMix1 (
        id            INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_ComAtacFaixaMix1 PRIMARY KEY,
        faixa         CHAR(1)       NOT NULL,            -- A | B | C | D
        atingiu_meta  BIT           NOT NULL,            -- 0 = não atingiu | 1 = atingiu a meta
        percentual    DECIMAL(9,6)  NOT NULL,
        ativo         BIT           NOT NULL CONSTRAINT DF_ComAtacFaixaMix1_ativo DEFAULT (1),
        CONSTRAINT UQ_ComAtacFaixaMix1 UNIQUE (faixa, atingiu_meta)
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM dbo.ComissaoAtacadoFaixaMix1)
BEGIN
    INSERT INTO dbo.ComissaoAtacadoFaixaMix1 (faixa, atingiu_meta, percentual) VALUES
    -- abaixo da meta
    ('A', 0, 0.035000), ('B', 0, 0.030000), ('C', 0, 0.025000), ('D', 0, 0.020000),
    -- atingiu a meta (dobrado)
    ('A', 1, 0.070000), ('B', 1, 0.060000), ('C', 1, 0.050000), ('D', 1, 0.040000);
END
GO

/* -----------------------------------------------------------------------------
   3) ComissaoAtacadoConfig  — parâmetros gerais do atacado (1 linha, editável)
   meta_mix1 = participação mínima do mix 1 que dobra o % do mix 1 (ex.: 0,30).
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.ComissaoAtacadoConfig', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ComissaoAtacadoConfig (
        id          INT           NOT NULL CONSTRAINT PK_ComAtacConfig PRIMARY KEY,
        meta_mix1   DECIMAL(9,6)  NOT NULL CONSTRAINT DF_ComAtacConfig_meta DEFAULT (0.30),
        data_atualizacao DATETIME NOT NULL CONSTRAINT DF_ComAtacConfig_dt DEFAULT (GETDATE())
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM dbo.ComissaoAtacadoConfig WHERE id = 1)
    INSERT INTO dbo.ComissaoAtacadoConfig (id, meta_mix1) VALUES (1, 0.30);
GO

/* -----------------------------------------------------------------------------
   4) ComissaoResultadoAtacado  — snapshot por vendedor/período
   total_vendido = bruto; base_real = total - abatimento; total_faixa = base_real
   + media_ferias (define a faixa do mix 2/3). comissao_bruta = Σ (venda x %);
   valor_comissao = comissao_bruta x fator_abatimento (= base_real/total_vendido).
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.ComissaoResultadoAtacado', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ComissaoResultadoAtacado (
        id               INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_ComResAtacado PRIMARY KEY,
        periodo_id       INT            NOT NULL,
        rep_codigo       INT            NOT NULL,
        nome             VARCHAR(200)   NULL,
        total_vendido    DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResAtac_tv DEFAULT (0),
        total_mix1       DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResAtac_tm1 DEFAULT (0),
        pct_mix1         DECIMAL(9,6)   NOT NULL CONSTRAINT DF_ComResAtac_pm1 DEFAULT (0),  -- participação do mix 1
        atingiu_meta     BIT            NOT NULL CONSTRAINT DF_ComResAtac_meta DEFAULT (0),
        abatimento       DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResAtac_abat DEFAULT (0),
        base_real        DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResAtac_br DEFAULT (0),
        dias_ferias      INT            NOT NULL CONSTRAINT DF_ComResAtac_df DEFAULT (0),
        media_ferias     DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResAtac_mf DEFAULT (0),
        total_faixa      DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResAtac_tf DEFAULT (0),
        pct_mix23        DECIMAL(9,6)   NOT NULL CONSTRAINT DF_ComResAtac_p23 DEFAULT (0),
        comissao_bruta   DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResAtac_cb DEFAULT (0),
        fator_abatimento DECIMAL(9,6)   NOT NULL CONSTRAINT DF_ComResAtac_fa DEFAULT (1),
        valor_comissao   DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComResAtac_vc DEFAULT (0),
        data_calculo     DATETIME       NOT NULL CONSTRAINT DF_ComResAtac_dt DEFAULT (GETDATE()),
        CONSTRAINT UQ_ComResAtacado UNIQUE (periodo_id, rep_codigo),
        CONSTRAINT FK_ComResAtac_periodo FOREIGN KEY (periodo_id)
            REFERENCES dbo.ComissaoPeriodo (id)
    );
END
GO

/* -----------------------------------------------------------------------------
   5) ComissaoAtacadoDetalhe  — quebra por mix x faixa (alimenta o relatório)
   valor_comissao aqui é a comissão BRUTA da célula (venda x %); o abatimento é
   aplicado proporcionalmente no total (ver fator_abatimento no resultado).
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.ComissaoAtacadoDetalhe', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ComissaoAtacadoDetalhe (
        id              BIGINT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_ComAtacDetalhe PRIMARY KEY,
        periodo_id      INT            NOT NULL,
        rep_codigo      INT            NOT NULL,
        mix             TINYINT        NOT NULL,         -- 1 | 2 | 3
        faixa           CHAR(1)        NOT NULL,         -- A | B | C | D
        valor_vendido   DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComAtacDet_vv DEFAULT (0),
        pct_comissao    DECIMAL(9,6)   NOT NULL CONSTRAINT DF_ComAtacDet_pct DEFAULT (0),
        valor_comissao  DECIMAL(18,2)  NOT NULL CONSTRAINT DF_ComAtacDet_vc DEFAULT (0),
        CONSTRAINT FK_ComAtacDet_periodo FOREIGN KEY (periodo_id)
            REFERENCES dbo.ComissaoPeriodo (id)
    );
    CREATE INDEX IX_ComAtacDetalhe_periodo_rep ON dbo.ComissaoAtacadoDetalhe (periodo_id, rep_codigo);
END
GO

PRINT 'Esquema de Comissões — ATACADO criado/atualizado com sucesso.';
GO
