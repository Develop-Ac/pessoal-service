-- Dashboard 22 do Metabase, card 503 (dashcard 541): Crescimento de Receita x Folha
-- Gerado por scripts/extrair-cards-metabase.ts. Parâmetros declarados pelo serviço:
--   @de date, @ate_excl date (competência no intervalo [de, ate_excl); NULL = sem filtro)
--   @canal varchar (LOCAL_VENDA; NULL = todos os canais)
WITH BaseReceita AS
(
    SELECT
        DATEFROMPARTS(ANO, MES, 1) AS competencia,
        SUM(CASE
            WHEN GRUPO_SINTETICO_DRE = 'Receita Bruta'
            THEN VALOR_CONVERTIDO ELSE 0
        END) AS receita_bruta
    FROM dbo.f_dre_base
    WHERE (@de IS NULL OR (f_dre_base.DATA_COMPETENCIA >= @de AND f_dre_base.DATA_COMPETENCIA < @ate_excl))
      AND (@canal IS NULL OR f_dre_base.LOCAL_VENDA = @canal)
      AND DATA_COMPETENCIA >= '2024-01-01'
    GROUP BY
        DATEFROMPARTS(ANO, MES, 1)
),

BaseDespesa AS
(
    SELECT
        DATEFROMPARTS(d.ANO, d.MES, 1) AS competencia,
        SUM(d.VALOR_CONVERTIDO) * -1 AS despesa_pessoal
    FROM BI.dbo.f_dre_base_despesa_com_pessoal d
    INNER JOIN (
        SELECT DISTINCT ANO, MES, LOCAL_VENDA
        FROM dbo.f_dre_base
        WHERE (@de IS NULL OR (f_dre_base.DATA_COMPETENCIA >= @de AND f_dre_base.DATA_COMPETENCIA < @ate_excl))
          AND (@canal IS NULL OR f_dre_base.LOCAL_VENDA = @canal)
          AND DATA_COMPETENCIA >= '2024-01-01'
    ) f
        ON f.ANO = d.ANO
       AND f.MES = d.MES
       AND f.LOCAL_VENDA = d.LOCAL_VENDA
    GROUP BY
        DATEFROMPARTS(d.ANO, d.MES, 1)
)

SELECT
    r.competencia,
    r.receita_bruta,
    LAG(r.receita_bruta) OVER (ORDER BY r.competencia) AS receita_mes_anterior,
    (r.receita_bruta - LAG(r.receita_bruta) OVER (ORDER BY r.competencia))
        / NULLIF(LAG(r.receita_bruta) OVER (ORDER BY r.competencia), 0) AS crescimento_receita,

    d.despesa_pessoal,
    LAG(d.despesa_pessoal) OVER (ORDER BY d.competencia) AS despesa_mes_anterior,
    (d.despesa_pessoal - LAG(d.despesa_pessoal) OVER (ORDER BY d.competencia))
        / NULLIF(LAG(d.despesa_pessoal) OVER (ORDER BY d.competencia), 0) AS crescimento_folha
FROM BaseReceita r
LEFT JOIN BaseDespesa d
    ON d.competencia = r.competencia
ORDER BY r.competencia;
