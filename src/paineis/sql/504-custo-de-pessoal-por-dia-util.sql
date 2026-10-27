-- Dashboard 22 do Metabase, card 504 (dashcard 542): Custo de Pessoal Por Dia Útil
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
DiasUteis AS (

    SELECT
        COUNT(*) AS qtd_dias_uteis
    FROM BI.dbo.d_calendario c
    INNER JOIN (
        SELECT DISTINCT ANO, MES
        FROM BaseFiltro
    ) f
        ON f.ANO = c.ano
       AND f.MES = c.mes
    WHERE c.is_dia_util = 1

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
DiasUteis__ANT AS (

    SELECT
        COUNT(*) AS qtd_dias_uteis
    FROM BI.dbo.d_calendario c
    INNER JOIN (
        SELECT DISTINCT ANO, MES
        FROM BaseFiltro__ANT
    ) f
        ON f.ANO = c.ano
       AND f.MES = c.mes
    WHERE c.is_dia_util = 1

)
SELECT periodo, ISNULL(valor, 0) AS valor FROM (
    SELECT CAST(DATEFROMPARTS((SELECT MAX(ANO) FROM ChavesSel), 1, 1) AS date) AS periodo,
           qa.custo_pessoal_por_dia_util AS valor
    FROM ( SELECT
    despesa_total,
    qtd_dias_uteis,
    despesa_total / NULLIF(qtd_dias_uteis, 0) AS custo_pessoal_por_dia_util
FROM Despesa, DiasUteis ) qa
    UNION ALL
    SELECT CAST(DATEFROMPARTS((SELECT MAX(ANO) FROM ChavesSel) - 1, 1, 1) AS date),
           qb.custo_pessoal_por_dia_util
    FROM ( SELECT
    despesa_total,
    qtd_dias_uteis,
    despesa_total / NULLIF(qtd_dias_uteis, 0) AS custo_pessoal_por_dia_util
FROM Despesa__ANT, DiasUteis__ANT ) qb
) z ORDER BY periodo
