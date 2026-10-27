-- Dashboard 22 do Metabase, card 502 (dashcard 540): Custo de Pessoal por Ticket
-- Gerado por scripts/extrair-cards-metabase.ts. Parâmetros declarados pelo serviço:
--   @de date, @ate_excl date (competência no intervalo [de, ate_excl); NULL = sem filtro)
--   @canal varchar (LOCAL_VENDA; NULL = todos os canais)
WITH ChavesSel AS (
    SELECT DISTINCT ANO, MES, LOCAL_VENDA FROM (

    SELECT DISTINCT
        ANO,
        MES,
        LOCAL_VENDA,
        DATA_COMPETENCIA
    FROM dbo.f_dre_base
    WHERE (@de IS NULL OR (f_dre_base.DATA_COMPETENCIA >= @de AND f_dre_base.DATA_COMPETENCIA < @ate_excl))
      AND (@canal IS NULL OR f_dre_base.LOCAL_VENDA = @canal)
      AND DATA_COMPETENCIA >= '2024-01-01'

    ) _rootsel
),
BaseFiltro AS (

    SELECT DISTINCT
        ANO,
        MES,
        LOCAL_VENDA,
        DATA_COMPETENCIA
    FROM dbo.f_dre_base
    WHERE (@de IS NULL OR (f_dre_base.DATA_COMPETENCIA >= @de AND f_dre_base.DATA_COMPETENCIA < @ate_excl))
      AND (@canal IS NULL OR f_dre_base.LOCAL_VENDA = @canal)
      AND DATA_COMPETENCIA >= '2024-01-01'

),
Despesa AS (

    SELECT
        SUM(d.VALOR_CONVERTIDO) * -1 AS despesa_total
    FROM BI.dbo.f_dre_base_despesa_com_pessoal d
    INNER JOIN (
        SELECT DISTINCT ANO, MES, LOCAL_VENDA
        FROM BaseFiltro
    ) f
        ON f.ANO = d.ANO
       AND f.MES = d.MES
       AND f.LOCAL_VENDA = d.LOCAL_VENDA

),
VendasComCanal AS (

    SELECT
        YEAR(TRY_CAST(sv.DT_EMISSAO AS date)) AS ANO,
        MONTH(TRY_CAST(sv.DT_EMISSAO AS date)) AS MES,
        sv.NFS,
        CASE
            WHEN sv.ORDEM_SERVICO IS NOT NULL THEN 'VAREJO-SERVIÇO'
            WHEN ISNULL(sv.VENDEDOR_ITEM, sv.VENDEDOR_NOTA) = 284
                 AND TRY_CAST(sv.DT_EMISSAO AS date) < '2025-03-26' THEN 'ATACADO'
            WHEN ISNULL(sv.VENDEDOR_ITEM, sv.VENDEDOR_NOTA) = 242
                 AND TRY_CAST(sv.DT_EMISSAO AS date) < '2025-03-26' THEN 'VAREJO'
            WHEN UPPER(LTRIM(RTRIM(ISNULL(loc.local_venda, '')))) IN ('BALCÃO', 'BALCAO', '') THEN 'VAREJO'
            ELSE LTRIM(RTRIM(ISNULL(loc.local_venda, 'VAREJO')))
        END AS LOCAL_VENDA
    FROM BI.dbo.Stage_Vendas sv
    LEFT JOIN BI.dbo.d_local_vendedores loc
        ON ISNULL(sv.VENDEDOR_ITEM, sv.VENDEDOR_NOTA) = loc.cod
    WHERE sv.DT_CANCELAMENTO IS NULL
      AND sv.PRO_CODIGO <> 47777
      AND TRY_CAST(sv.DT_EMISSAO AS date) >= '2024-01-01'

),
Tickets AS (

    SELECT
        COUNT(DISTINCT v.NFS) AS total_tickets
    FROM VendasComCanal v
    INNER JOIN (
        SELECT DISTINCT ANO, MES, LOCAL_VENDA
        FROM BaseFiltro
    ) f
        ON f.ANO = v.ANO
       AND f.MES = v.MES
       AND f.LOCAL_VENDA = v.LOCAL_VENDA

),
BaseFiltro__ANT AS (

    SELECT DISTINCT
        ANO,
        MES,
        LOCAL_VENDA,
        DATA_COMPETENCIA
    FROM dbo.f_dre_base
    WHERE EXISTS (SELECT 1 FROM ChavesSel s WHERE s.ANO = f_dre_base.ANO + 1 AND s.MES = f_dre_base.MES AND s.LOCAL_VENDA = f_dre_base.LOCAL_VENDA)
      AND f_dre_base.DATA_COMPETENCIA >= DATEFROMPARTS((SELECT MIN(ANO) FROM ChavesSel) - 1, 1, 1)
      AND f_dre_base.DATA_COMPETENCIA <  DATEFROMPARTS((SELECT MAX(ANO) FROM ChavesSel), 1, 1)
),
Despesa__ANT AS (

    SELECT
        SUM(d.VALOR_CONVERTIDO) * -1 AS despesa_total
    FROM BI.dbo.f_dre_base_despesa_com_pessoal d
    INNER JOIN (
        SELECT DISTINCT ANO, MES, LOCAL_VENDA
        FROM BaseFiltro__ANT
    ) f
        ON f.ANO = d.ANO
       AND f.MES = d.MES
       AND f.LOCAL_VENDA = d.LOCAL_VENDA

),
VendasComCanal__ANT AS (

    SELECT
        YEAR(TRY_CAST(sv.DT_EMISSAO AS date)) AS ANO,
        MONTH(TRY_CAST(sv.DT_EMISSAO AS date)) AS MES,
        sv.NFS,
        CASE
            WHEN sv.ORDEM_SERVICO IS NOT NULL THEN 'VAREJO-SERVIÇO'
            WHEN ISNULL(sv.VENDEDOR_ITEM, sv.VENDEDOR_NOTA) = 284
                 AND TRY_CAST(sv.DT_EMISSAO AS date) < '2025-03-26' THEN 'ATACADO'
            WHEN ISNULL(sv.VENDEDOR_ITEM, sv.VENDEDOR_NOTA) = 242
                 AND TRY_CAST(sv.DT_EMISSAO AS date) < '2025-03-26' THEN 'VAREJO'
            WHEN UPPER(LTRIM(RTRIM(ISNULL(loc.local_venda, '')))) IN ('BALCÃO', 'BALCAO', '') THEN 'VAREJO'
            ELSE LTRIM(RTRIM(ISNULL(loc.local_venda, 'VAREJO')))
        END AS LOCAL_VENDA
    FROM BI.dbo.Stage_Vendas sv
    LEFT JOIN BI.dbo.d_local_vendedores loc
        ON ISNULL(sv.VENDEDOR_ITEM, sv.VENDEDOR_NOTA) = loc.cod
    WHERE sv.DT_CANCELAMENTO IS NULL
      AND sv.PRO_CODIGO <> 47777
      AND TRY_CAST(sv.DT_EMISSAO AS date) >= '2024-01-01'

),
Tickets__ANT AS (

    SELECT
        COUNT(DISTINCT v.NFS) AS total_tickets
    FROM VendasComCanal__ANT v
    INNER JOIN (
        SELECT DISTINCT ANO, MES, LOCAL_VENDA
        FROM BaseFiltro__ANT
    ) f
        ON f.ANO = v.ANO
       AND f.MES = v.MES
       AND f.LOCAL_VENDA = v.LOCAL_VENDA

)
SELECT periodo, ISNULL(valor, 0) AS valor FROM (
    SELECT CAST(DATEFROMPARTS((SELECT MAX(ANO) FROM ChavesSel), 1, 1) AS date) AS periodo,
           qa.custo_pessoal_por_ticket AS valor
    FROM ( SELECT
    despesa_total,
    total_tickets,
    despesa_total / NULLIF(total_tickets, 0) AS custo_pessoal_por_ticket
FROM Despesa, Tickets ) qa
    UNION ALL
    SELECT CAST(DATEFROMPARTS((SELECT MAX(ANO) FROM ChavesSel) - 1, 1, 1) AS date),
           qb.custo_pessoal_por_ticket
    FROM ( SELECT
    despesa_total,
    total_tickets,
    despesa_total / NULLIF(total_tickets, 0) AS custo_pessoal_por_ticket
FROM Despesa__ANT, Tickets__ANT ) qb
) z ORDER BY periodo
