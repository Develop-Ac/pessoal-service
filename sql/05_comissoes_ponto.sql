/* =============================================================================
   MÓDULO COMISSÕES — Cartão ponto (Sécullum): dias de FALTA/DISPENSA
   -----------------------------------------------------------------------------
   O RH importa o "CARTÃO PONTO" (PDF do Secullum Ponto) de cada vendedor do
   varejo. Nos dias marcados como FALTA ou DISPENSA o vendedor não estava na
   loja, então as VENDAS (e mão de obra) desses dias saem da base de comissão.
   As DEVOLUÇÕES continuam contando. O item excluído fica carimbado no
   ComissaoMovimento (excluido_ponto/excluido_motivo) e sai discriminado no
   demonstrativo de assinatura.

   ⚠️ Aplicar MANUALMENTE no servidor (não há prisma migrate neste projeto).
   Idempotente: usa IF NOT EXISTS / COL_LENGTH; rode quantas vezes precisar.
   ============================================================================= */

SET NOCOUNT ON;
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/* -----------------------------------------------------------------------------
   1) ComissaoPontoDia — um registro por (período, vendedor, dia excluído)
   motivo: FALTA | DISPENSA. nome_cartao/arquivo = auditoria da importação.
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.ComissaoPontoDia', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ComissaoPontoDia (
        id               INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_ComissaoPontoDia PRIMARY KEY,
        periodo_id       INT           NOT NULL,
        rep_codigo       INT           NOT NULL,
        data             DATE          NOT NULL,
        motivo           VARCHAR(20)   NOT NULL,          -- FALTA | DISPENSA
        nome_cartao      VARCHAR(200)  NULL,              -- nome impresso no PDF
        arquivo          VARCHAR(255)  NULL,              -- PDF de origem
        data_importacao  DATETIME      NOT NULL CONSTRAINT DF_ComPonto_dtimp DEFAULT (GETDATE()),
        CONSTRAINT UQ_ComissaoPontoDia UNIQUE (periodo_id, rep_codigo, data),
        CONSTRAINT FK_ComPonto_periodo FOREIGN KEY (periodo_id)
            REFERENCES dbo.ComissaoPeriodo (id)
    );
    CREATE INDEX IX_ComissaoPontoDia_periodo_rep
        ON dbo.ComissaoPontoDia (periodo_id, rep_codigo);
END
GO

/* -----------------------------------------------------------------------------
   2) ComissaoMovimento — carimbo do item excluído pelo ponto
----------------------------------------------------------------------------- */
IF COL_LENGTH('dbo.ComissaoMovimento', 'excluido_ponto') IS NULL
    ALTER TABLE dbo.ComissaoMovimento
        ADD excluido_ponto BIT NOT NULL CONSTRAINT DF_ComMov_exclponto DEFAULT (0);
GO
IF COL_LENGTH('dbo.ComissaoMovimento', 'excluido_motivo') IS NULL
    ALTER TABLE dbo.ComissaoMovimento
        ADD excluido_motivo VARCHAR(20) NULL;             -- FALTA | DISPENSA
GO

/* -----------------------------------------------------------------------------
   3) ComissaoResultadoVendedor — totais das exclusões (snapshot da dinâmica)
----------------------------------------------------------------------------- */
IF COL_LENGTH('dbo.ComissaoResultadoVendedor', 'excluido_ponto') IS NULL
    ALTER TABLE dbo.ComissaoResultadoVendedor
        ADD excluido_ponto DECIMAL(18,2) NOT NULL CONSTRAINT DF_ComResV_exclponto DEFAULT (0);
GO
IF COL_LENGTH('dbo.ComissaoResultadoVendedor', 'itens_excluidos_ponto') IS NULL
    ALTER TABLE dbo.ComissaoResultadoVendedor
        ADD itens_excluidos_ponto INT NOT NULL CONSTRAINT DF_ComResV_itexcl DEFAULT (0);
GO
IF COL_LENGTH('dbo.ComissaoResultadoVendedor', 'dias_falta') IS NULL
    ALTER TABLE dbo.ComissaoResultadoVendedor
        ADD dias_falta INT NOT NULL CONSTRAINT DF_ComResV_dfalta DEFAULT (0);
GO
IF COL_LENGTH('dbo.ComissaoResultadoVendedor', 'dias_dispensa') IS NULL
    ALTER TABLE dbo.ComissaoResultadoVendedor
        ADD dias_dispensa INT NOT NULL CONSTRAINT DF_ComResV_ddisp DEFAULT (0);
GO

PRINT 'Cartão ponto (comissões): esquema criado/atualizado com sucesso.';
GO
