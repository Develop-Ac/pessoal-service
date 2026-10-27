-- Dashboard 22 do Metabase, card 500 (dashcard 538): Indice de Eficiência de Folha
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
Despesa AS (

    SELECT
        SUM(d.VALOR_CONVERTIDO) * -1 AS despesa_total
    FROM BI.dbo.f_dre_base_despesa_com_pessoal d
    INNER JOIN ChavesFiltro f
        ON f.ANO = d.ANO
       AND f.MES = d.MES
       AND f.LOCAL_VENDA = d.LOCAL_VENDA

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
Despesa__ANT AS (

    SELECT
        SUM(d.VALOR_CONVERTIDO) * -1 AS despesa_total
    FROM BI.dbo.f_dre_base_despesa_com_pessoal d
    INNER JOIN ChavesFiltro__ANT f
        ON f.ANO = d.ANO
       AND f.MES = d.MES
       AND f.LOCAL_VENDA = d.LOCAL_VENDA

)
SELECT periodo, ISNULL(valor, 0) AS valor FROM (
    SELECT CAST(DATEFROMPARTS((SELECT MAX(ANO) FROM ChavesSel), 1, 1) AS date) AS periodo,
           qa.indice_eficiencia_folha AS valor
    FROM ( SELECT
    receita_total,
    despesa_total,
    receita_total / NULLIF(despesa_total, 0) AS indice_eficiencia_folha
FROM Receita, Despesa ) qa
    UNION ALL
    SELECT CAST(DATEFROMPARTS((SELECT MAX(ANO) FROM ChavesSel) - 1, 1, 1) AS date),
           qb.indice_eficiencia_folha
    FROM ( SELECT
    receita_total,
    despesa_total,
    receita_total / NULLIF(despesa_total, 0) AS indice_eficiencia_folha
FROM Receita__ANT, Despesa__ANT ) qb
) z ORDER BY periodo
