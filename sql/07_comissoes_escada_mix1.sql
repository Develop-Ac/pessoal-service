/* =============================================================================
   07) Escada de participação do MIX 1 — vendedores E supervisor do atacado
   BI (SQL Server 192.168.1.146). APLICAÇÃO MANUAL, antes do deploy do pessoal-service
   que lê esta tabela. Idempotente.

   Regra (plano de precificação do atacado, set/26; estendida ao supervisor em
   28/10/2026): a participação do mix 1 na venda do mês comissional (26 a 25)
   define um multiplicador sobre o % BASE da faixa A/B/C/D do mix 1:
       < 22%  -> x1,00   |  >= 22% -> x1,25  |  >= 26% -> x1,50  |  >= 30% -> x2,00
   Vendedor: base = ComissaoAtacadoFaixaMix1 com atingiu_meta = 0 (A 4 / B 3 / C 3 / D 2%).
   Supervisor: base própria embutida na engine (A 1,00 / B 0,86 / C 0,71 / D 0,57%),
   participação do canal inteiro; mix 2/3 segue 0,55% fixo.
   Substitui o "atingiu 30%" binário (meta_mix1 / linhas atingiu_meta = 1), que a
   engine só usa quando NENHUM degrau vige no fim do período (meses antigos).
   venda_min_vs_media3m: trava anti-manipulação PENDENTE de aprovação — a engine
   não a aplica; fica em 1,0.
   ============================================================================= */

-- 1) Parâmetros da escada
IF OBJECT_ID('dbo.ComissaoAtacadoEscadaMix1', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ComissaoAtacadoEscadaMix1 (
        id                   INT IDENTITY(1,1) CONSTRAINT PK_ComAtacEscadaMix1 PRIMARY KEY,
        degrau               TINYINT       NOT NULL,          -- 1, 2, 3
        part_min             DECIMAL(9,6)  NOT NULL,          -- participação mínima do mix 1 (0.22 = 22%)
        multiplicador        DECIMAL(9,4)  NOT NULL,          -- sobre o % base da faixa A-D
        venda_min_vs_media3m DECIMAL(9,4)  NOT NULL CONSTRAINT DF_ComAtacEscadaMix1_vmin DEFAULT (1.0),
        vigente_de           DATE          NOT NULL,          -- período cujo fim (dia 25) >= esta data usa o degrau
        ativo                BIT           NOT NULL CONSTRAINT DF_ComAtacEscadaMix1_ativo DEFAULT (1)
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM dbo.ComissaoAtacadoEscadaMix1)
    INSERT INTO dbo.ComissaoAtacadoEscadaMix1 (degrau, part_min, multiplicador, vigente_de) VALUES
     (1, 0.22, 1.25, '2026-08-26'),
     (2, 0.26, 1.50, '2026-08-26'),
     (3, 0.30, 2.00, '2026-08-26');
GO

-- 2) Snapshots: multiplicador aplicado no cálculo (1 = sem escada ou abaixo do 1º degrau)
IF COL_LENGTH('dbo.ComissaoResultadoAtacado', 'mult_mix1') IS NULL
    ALTER TABLE dbo.ComissaoResultadoAtacado
        ADD mult_mix1 DECIMAL(9,6) NOT NULL CONSTRAINT DF_ComResAtac_mult DEFAULT (1);
GO
IF COL_LENGTH('dbo.ComissaoResultadoSupervisorAtacado', 'mult_mix1') IS NULL
    ALTER TABLE dbo.ComissaoResultadoSupervisorAtacado
        ADD mult_mix1 DECIMAL(9,6) NOT NULL CONSTRAINT DF_ComResSupAtac_mult DEFAULT (1);
GO

-- 3) Conferência
SELECT degrau, part_min, multiplicador, venda_min_vs_media3m, vigente_de, ativo
FROM dbo.ComissaoAtacadoEscadaMix1 ORDER BY part_min;
