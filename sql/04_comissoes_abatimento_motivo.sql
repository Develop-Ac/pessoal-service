/* =============================================================================
   HOTFIX — MOTIVO DO ABATIMENTO + ABATIMENTO DO SUPERVISOR DO ATACADO
   -----------------------------------------------------------------------------
   1) Todo abatimento digitado nos parâmetros passa a ter um motivo (texto livre),
      que é carimbado no snapshot de cada bloco (vendedor/técnico/atacado) para
      o relatório de assinatura mostrar POR QUE a base foi reduzida.
   2) O supervisor do atacado passa a aceitar abatimento, com a MESMA mecânica do
      vendedor de atacado: reduz a base proporcionalmente
      (fator = base_real / total_vendido) e escala a comissão.
      comissao_bruta = Σ (venda x %); comissao_total = comissao_bruta x fator.

   Idempotente: pode rodar mais de uma vez.
   ============================================================================= */

/* ------------------ 1) Entrada: parâmetros manuais do período ---------------- */
IF COL_LENGTH('dbo.ComissaoParametroManual', 'abatimento_motivo') IS NULL
    ALTER TABLE dbo.ComissaoParametroManual ADD abatimento_motivo VARCHAR(200) NULL;
GO

/* ------------------ 2) Snapshots: carimbo do motivo no cálculo -------------- */
IF COL_LENGTH('dbo.ComissaoResultadoVendedor', 'abatimento_motivo') IS NULL
    ALTER TABLE dbo.ComissaoResultadoVendedor ADD abatimento_motivo VARCHAR(200) NULL;
GO

IF COL_LENGTH('dbo.ComissaoResultadoTecnico', 'abatimento_motivo') IS NULL
    ALTER TABLE dbo.ComissaoResultadoTecnico ADD abatimento_motivo VARCHAR(200) NULL;
GO

IF COL_LENGTH('dbo.ComissaoResultadoAtacado', 'abatimento_motivo') IS NULL
    ALTER TABLE dbo.ComissaoResultadoAtacado ADD abatimento_motivo VARCHAR(200) NULL;
GO

/* ------------- 3) Supervisor do atacado: abatimento proporcional ------------ */
IF COL_LENGTH('dbo.ComissaoResultadoSupervisorAtacado', 'abatimento') IS NULL
    ALTER TABLE dbo.ComissaoResultadoSupervisorAtacado
        ADD abatimento DECIMAL(18,2) NOT NULL
            CONSTRAINT DF_ComResSupAtac_abat DEFAULT (0);
GO

IF COL_LENGTH('dbo.ComissaoResultadoSupervisorAtacado', 'base_real') IS NULL
    ALTER TABLE dbo.ComissaoResultadoSupervisorAtacado
        ADD base_real DECIMAL(18,2) NOT NULL
            CONSTRAINT DF_ComResSupAtac_br DEFAULT (0);
GO

IF COL_LENGTH('dbo.ComissaoResultadoSupervisorAtacado', 'comissao_bruta') IS NULL
    ALTER TABLE dbo.ComissaoResultadoSupervisorAtacado
        ADD comissao_bruta DECIMAL(18,2) NOT NULL
            CONSTRAINT DF_ComResSupAtac_cb DEFAULT (0);
GO

IF COL_LENGTH('dbo.ComissaoResultadoSupervisorAtacado', 'fator_abatimento') IS NULL
    ALTER TABLE dbo.ComissaoResultadoSupervisorAtacado
        ADD fator_abatimento DECIMAL(9,6) NOT NULL
            CONSTRAINT DF_ComResSupAtac_fa DEFAULT (1);
GO

IF COL_LENGTH('dbo.ComissaoResultadoSupervisorAtacado', 'abatimento_motivo') IS NULL
    ALTER TABLE dbo.ComissaoResultadoSupervisorAtacado
        ADD abatimento_motivo VARCHAR(200) NULL;
GO

/* Períodos já calculados antes do hotfix: comissao_bruta = comissao_total
   (ninguém tinha abatimento, então bruta e líquida coincidem). */
UPDATE dbo.ComissaoResultadoSupervisorAtacado
SET comissao_bruta = comissao_total,
    base_real      = total_vendido
WHERE comissao_bruta = 0 AND comissao_total <> 0;
GO
