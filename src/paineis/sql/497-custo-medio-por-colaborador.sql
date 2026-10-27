-- Dashboard 22 do Metabase, card 497 (dashcard 535): Custo Médio Por Colaborador
-- Gerado por scripts/extrair-cards-metabase.ts. Parâmetros declarados pelo serviço:
--   @de date, @ate_excl date (competência no intervalo [de, ate_excl); NULL = sem filtro)
--   @canal varchar (LOCAL_VENDA; NULL = todos os canais)
WITH ChavesSel AS (
    SELECT DISTINCT ANO, MES, LOCAL_VENDA FROM (

    SELECT DISTINCT
        ANO,
        MES,
        LOCAL_VENDA
    FROM dbo.f_dre_base
    WHERE (@de IS NULL OR (f_dre_base.DATA_COMPETENCIA >= @de AND f_dre_base.DATA_COMPETENCIA < @ate_excl))
      AND (@canal IS NULL OR f_dre_base.LOCAL_VENDA = @canal)
      AND DATA_COMPETENCIA >= '2024-01-01'

    ) _rootsel
),
ChavesFiltro AS (

    SELECT DISTINCT
        ANO,
        MES,
        LOCAL_VENDA
    FROM dbo.f_dre_base
    WHERE (@de IS NULL OR (f_dre_base.DATA_COMPETENCIA >= @de AND f_dre_base.DATA_COMPETENCIA < @ate_excl))
      AND (@canal IS NULL OR f_dre_base.LOCAL_VENDA = @canal)
      AND DATA_COMPETENCIA >= '2024-01-01'

),
Despesa AS (

    SELECT
        SUM(d.VALOR_CONVERTIDO) * -1 AS despesa_total
    FROM BI.dbo.f_dre_base_despesa_com_pessoal d
    INNER JOIN ChavesFiltro f
        ON f.ANO = d.ANO
       AND f.MES = d.MES
       AND f.LOCAL_VENDA = d.LOCAL_VENDA

),
Headcount AS (

    SELECT
        SUM(h.qtd_equivalente) AS headcount_equivalente
    FROM BI.dbo.f_colaborador_equivalente_mensal h
    INNER JOIN ChavesFiltro f
        ON f.ANO = h.ANO
       AND f.MES = h.MES
       AND f.LOCAL_VENDA = h.LOCAL_VENDA

),
ChavesFiltro__ANT AS (

    SELECT DISTINCT
        ANO,
        MES,
        LOCAL_VENDA
    FROM dbo.f_dre_base
    WHERE EXISTS (SELECT 1 FROM ChavesSel s WHERE s.ANO = f_dre_base.ANO + 1 AND s.MES = f_dre_base.MES AND s.LOCAL_VENDA = f_dre_base.LOCAL_VENDA)
      AND f_dre_base.DATA_COMPETENCIA >= DATEFROMPARTS((SELECT MIN(ANO) FROM ChavesSel) - 1, 1, 1)
      AND f_dre_base.DATA_COMPETENCIA <  DATEFROMPARTS((SELECT MAX(ANO) FROM ChavesSel), 1, 1)
),
Despesa__ANT AS (

    SELECT
        SUM(d.VALOR_CONVERTIDO) * -1 AS despesa_total
    FROM BI.dbo.f_dre_base_despesa_com_pessoal d
    INNER JOIN ChavesFiltro__ANT f
        ON f.ANO = d.ANO
       AND f.MES = d.MES
       AND f.LOCAL_VENDA = d.LOCAL_VENDA

),
Headcount__ANT AS (

    SELECT
        SUM(h.qtd_equivalente) AS headcount_equivalente
    FROM BI.dbo.f_colaborador_equivalente_mensal h
    INNER JOIN ChavesFiltro__ANT f
        ON f.ANO = h.ANO
       AND f.MES = h.MES
       AND f.LOCAL_VENDA = h.LOCAL_VENDA

)
SELECT periodo, ISNULL(valor, 0) AS valor FROM (
    SELECT CAST(DATEFROMPARTS((SELECT MAX(ANO) FROM ChavesSel), 1, 1) AS date) AS periodo,
           qa.custo_medio_colaborador AS valor
    FROM ( SELECT
    despesa_total,
    headcount_equivalente,
    despesa_total / NULLIF(headcount_equivalente, 0) AS custo_medio_colaborador
FROM Despesa, Headcount ) qa
    UNION ALL
    SELECT CAST(DATEFROMPARTS((SELECT MAX(ANO) FROM ChavesSel) - 1, 1, 1) AS date),
           qb.custo_medio_colaborador
    FROM ( SELECT
    despesa_total,
    headcount_equivalente,
    despesa_total / NULLIF(headcount_equivalente, 0) AS custo_medio_colaborador
FROM Despesa__ANT, Headcount__ANT ) qb
) z ORDER BY periodo
