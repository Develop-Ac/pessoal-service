/* =============================================================================
   MÓDULO COMISSÕES — Férias por representante (dbo.ComissaoFerias)
   -----------------------------------------------------------------------------
   Uma linha por período de férias (início e fim), independente do período de
   comissões. O serviço lê as férias que cruzam o mês comissional (26 a 25) e
   recorta aos dias dele:
     - vendedores (varejo e atacado): os dias recortados alimentam a MÉDIA de
       férias (antes a quantidade de dias era digitada na linha do período);
     - supervisores: a janela recortada tira o movimento daqueles dias da base.
   Férias que atravessam a virada do mês comissional valem nos dois meses sem
   redigitar. Na tela, "Férias?" + Início + Fim para todos os papéis.

   ComissaoParametroManual.tem_ferias / dias_ferias / ferias_inicio / ferias_fim
   continuam existindo: o serviço ainda grava o que a tela manda (compatibilidade)
   e usa dias_ferias só como legado, em período antigo sem linha nesta tabela.

   ⚠️ Aplicar MANUALMENTE no SQL Server BI. Idempotente: pode rodar de novo.
   ORDEM: antes de publicar o pessoal-service desta entrega; sem a tabela o
   serviço avisa no log e segue com as férias da linha do período (como hoje).
   ============================================================================= */

SET NOCOUNT ON;
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.ComissaoFerias', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ComissaoFerias (
        id               INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_ComissaoFerias PRIMARY KEY,
        rep_codigo       INT      NOT NULL,
        ferias_inicio    DATE     NOT NULL,
        ferias_fim       DATE     NOT NULL,
        data_atualizacao DATETIME NOT NULL CONSTRAINT DF_ComFerias_dtatu DEFAULT (GETDATE()),
        CONSTRAINT CK_ComFerias_ordem CHECK (ferias_fim >= ferias_inicio)
    );
    CREATE INDEX IX_ComFerias_rep_periodo ON dbo.ComissaoFerias (rep_codigo, ferias_inicio, ferias_fim);
END
GO

/* Migra as janelas já digitadas (supervisores) — uma vez só, sem duplicar. */
INSERT INTO dbo.ComissaoFerias (rep_codigo, ferias_inicio, ferias_fim)
SELECT DISTINCT p.rep_codigo, p.ferias_inicio, p.ferias_fim
FROM dbo.ComissaoParametroManual p
WHERE p.tem_ferias = 1
  AND p.ferias_inicio IS NOT NULL AND p.ferias_fim IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM dbo.ComissaoFerias f
      WHERE f.rep_codigo = p.rep_codigo
        AND f.ferias_inicio = p.ferias_inicio AND f.ferias_fim = p.ferias_fim);
GO

/* Conferência */
SELECT f.rep_codigo, r.nome, f.ferias_inicio, f.ferias_fim
FROM dbo.ComissaoFerias f
LEFT JOIN dbo.ComissaoRepresentante r ON r.rep_codigo = f.rep_codigo
ORDER BY f.ferias_inicio DESC;
GO
