/* =============================================================================
   MÓDULO COMISSÕES — Férias dos SUPERVISORES (oficina e atacado)
   -----------------------------------------------------------------------------
   Os dois supervisores comissionam sobre a base de OUTRAS pessoas (toda a base
   de serviço / todo o canal de atacado), que continua girando enquanto eles
   estão de férias. Por isso, para eles, férias é uma JANELA DE DATAS: o
   movimento emitido dentro dela sai da base de comissão. Não há média de férias
   (o % deles é fixo), só a exclusão.

   Para os vendedores nada muda: continuam com tem_ferias + dias_ferias (média
   projetada sobre a venda real). As colunas de data ficam NULL para eles.

   ⚠️ Aplicar MANUALMENTE no servidor (não há prisma migrate neste projeto).
   Idempotente: usa COL_LENGTH; rode quantas vezes precisar.
   ============================================================================= */

SET NOCOUNT ON;
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/* ------------------ 1) Entrada: parâmetros manuais do período ---------------- */
IF COL_LENGTH('dbo.ComissaoParametroManual', 'ferias_inicio') IS NULL
    ALTER TABLE dbo.ComissaoParametroManual ADD ferias_inicio DATE NULL;
GO
IF COL_LENGTH('dbo.ComissaoParametroManual', 'ferias_fim') IS NULL
    ALTER TABLE dbo.ComissaoParametroManual ADD ferias_fim DATE NULL;
GO

/* ------------- 2) Snapshot do supervisor da oficina (linha is_supervisor=1) -- */
IF COL_LENGTH('dbo.ComissaoResultadoTecnico', 'excluido_ferias') IS NULL
    ALTER TABLE dbo.ComissaoResultadoTecnico
        ADD excluido_ferias DECIMAL(18,2) NOT NULL
            CONSTRAINT DF_ComResT_exfer DEFAULT (0);
GO
IF COL_LENGTH('dbo.ComissaoResultadoTecnico', 'dias_ferias') IS NULL
    ALTER TABLE dbo.ComissaoResultadoTecnico
        ADD dias_ferias INT NOT NULL
            CONSTRAINT DF_ComResT_diasfer DEFAULT (0);
GO
IF COL_LENGTH('dbo.ComissaoResultadoTecnico', 'ferias_inicio') IS NULL
    ALTER TABLE dbo.ComissaoResultadoTecnico ADD ferias_inicio DATE NULL;
GO
IF COL_LENGTH('dbo.ComissaoResultadoTecnico', 'ferias_fim') IS NULL
    ALTER TABLE dbo.ComissaoResultadoTecnico ADD ferias_fim DATE NULL;
GO

/* ------------- 3) Snapshot do supervisor do atacado ------------------------- */
IF COL_LENGTH('dbo.ComissaoResultadoSupervisorAtacado', 'excluido_ferias') IS NULL
    ALTER TABLE dbo.ComissaoResultadoSupervisorAtacado
        ADD excluido_ferias DECIMAL(18,2) NOT NULL
            CONSTRAINT DF_ComResSupAtac_exfer DEFAULT (0);
GO
IF COL_LENGTH('dbo.ComissaoResultadoSupervisorAtacado', 'dias_ferias') IS NULL
    ALTER TABLE dbo.ComissaoResultadoSupervisorAtacado
        ADD dias_ferias INT NOT NULL
            CONSTRAINT DF_ComResSupAtac_diasfer DEFAULT (0);
GO
IF COL_LENGTH('dbo.ComissaoResultadoSupervisorAtacado', 'ferias_inicio') IS NULL
    ALTER TABLE dbo.ComissaoResultadoSupervisorAtacado ADD ferias_inicio DATE NULL;
GO
IF COL_LENGTH('dbo.ComissaoResultadoSupervisorAtacado', 'ferias_fim') IS NULL
    ALTER TABLE dbo.ComissaoResultadoSupervisorAtacado ADD ferias_fim DATE NULL;
GO
