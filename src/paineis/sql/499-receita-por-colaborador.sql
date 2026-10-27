-- Dashboard 22 do Metabase, card 499 (dashcard 537): Receita Por Colaborador
-- Gerado por scripts/extrair-cards-metabase.ts. Parâmetros declarados pelo serviço:
--   @de date, @ate_excl date (competência no intervalo [de, ate_excl); NULL = sem filtro)
--   @canal varchar (LOCAL_VENDA; NULL = todos os canais)
WITH ChavesSel AS (
    SELECT DISTINCT ANO, MES, LOCAL_VENDA FROM (

    SELECT
        ANO,
        MES,
        LOCAL_VENDA,
        DATA_COMPETENCIA,
        GRUPO_SINTETICO_DRE,
        VALOR_CONVERTIDO
    FROM dbo.f_dre_base
    WHERE (@de IS NULL OR (f_dre_base.DATA_COMPETENCIA >= @de AND f_dre_base.DATA_COMPETENCIA < @ate_excl))
      AND (@canal IS NULL OR f_dre_base.LOCAL_VENDA = @canal)
      AND DATA_COMPETENCIA >= '2024-01-01'

    ) _rootsel
),
BaseFiltro AS (

    SELECT
        ANO,
        MES,
        LOCAL_VENDA,
        DATA_COMPETENCIA,
        GRUPO_SINTETICO_DRE,
        VALOR_CONVERTIDO
    FROM dbo.f_dre_base
    WHERE (@de IS NULL OR (f_dre_base.DATA_COMPETENCIA >= @de AND f_dre_base.DATA_COMPETENCIA < @ate_excl))
      AND (@canal IS NULL OR f_dre_base.LOCAL_VENDA = @canal)
      AND DATA_COMPETENCIA >= '2024-01-01'

),
Receita AS (

    SELECT SUM(rc.RECEITA_BRUTA_CONTABIL) AS receita_total
    FROM dbo.f_receita_bruta_contabil_canal_mensal rc
    INNER JOIN (SELECT DISTINCT ANO, MES, LOCAL_VENDA FROM BaseFiltro) f
        ON f.ANO = rc.ANO AND f.MES = rc.MES AND f.LOCAL_VENDA = rc.LOCAL_VENDA

),
ChavesFiltro AS (

    SELECT DISTINCT
        ANO,
        MES,
        LOCAL_VENDA
    FROM BaseFiltro

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
BaseFiltro__ANT AS (

    SELECT
        ANO,
        MES,
        LOCAL_VENDA,
        DATA_COMPETENCIA,
        GRUPO_SINTETICO_DRE,
        VALOR_CONVERTIDO
    FROM dbo.f_dre_base
    WHERE EXISTS (SELECT 1 FROM ChavesSel s WHERE s.ANO = f_dre_base.ANO + 1 AND s.MES = f_dre_base.MES AND s.LOCAL_VENDA = f_dre_base.LOCAL_VENDA)
      AND f_dre_base.DATA_COMPETENCIA >= DATEFROMPARTS((SELECT MIN(ANO) FROM ChavesSel) - 1, 1, 1)
      AND f_dre_base.DATA_COMPETENCIA <  DATEFROMPARTS((SELECT MAX(ANO) FROM ChavesSel), 1, 1)
),
Receita__ANT AS (

    SELECT SUM(rc.RECEITA_BRUTA_CONTABIL) AS receita_total
    FROM dbo.f_receita_bruta_contabil_canal_mensal rc
    INNER JOIN (SELECT DISTINCT ANO, MES, LOCAL_VENDA FROM BaseFiltro__ANT) f
        ON f.ANO = rc.ANO AND f.MES = rc.MES AND f.LOCAL_VENDA = rc.LOCAL_VENDA

),
ChavesFiltro__ANT AS (

    SELECT DISTINCT
        ANO,
        MES,
        LOCAL_VENDA
    FROM BaseFiltro__ANT

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
           qa.receita_por_colaborador_equivalente AS valor
    FROM ( SELECT
    receita_total,
    headcount_equivalente,
    receita_total / NULLIF(headcount_equivalente, 0) AS receita_por_colaborador_equivalente
FROM Receita, Headcount ) qa
    UNION ALL
    SELECT CAST(DATEFROMPARTS((SELECT MAX(ANO) FROM ChavesSel) - 1, 1, 1) AS date),
           qb.receita_por_colaborador_equivalente
    FROM ( SELECT
    receita_total,
    headcount_equivalente,
    receita_total / NULLIF(headcount_equivalente, 0) AS receita_por_colaborador_equivalente
FROM Receita__ANT, Headcount__ANT ) qb
) z ORDER BY periodo
