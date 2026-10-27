-- Dashboard 22 do Metabase, card 494 (dashcard 532): Pro-Labore / Retiradas
-- Gerado por scripts/extrair-cards-metabase.ts. Parâmetros declarados pelo serviço:
--   @de date, @ate_excl date (competência no intervalo [de, ate_excl); NULL = sem filtro)
--   @canal varchar (LOCAL_VENDA; NULL = todos os canais)
WITH ChavesSel AS (
    SELECT DISTINCT ANO, MES, LOCAL_VENDA
    FROM dbo.f_dre_base_retirada_lucros
    WHERE (@de IS NULL OR (f_dre_base_retirada_lucros.DATA_COMPETENCIA >= @de AND f_dre_base_retirada_lucros.DATA_COMPETENCIA < @ate_excl))
and (@canal IS NULL OR f_dre_base_retirada_lucros.LOCAL_VENDA = @canal)
)
SELECT periodo, ISNULL(valor, 0) AS valor FROM (
    SELECT CAST(DATEFROMPARTS((SELECT MAX(ANO) FROM ChavesSel), 1, 1) AS date) AS periodo,
           qa.retirada_lucros AS valor
    FROM ( SELECT SUM(VALOR_CONVERTIDO) AS retirada_lucros FROM dbo.f_dre_base_retirada_lucros WHERE (@de IS NULL OR (f_dre_base_retirada_lucros.DATA_COMPETENCIA >= @de AND f_dre_base_retirada_lucros.DATA_COMPETENCIA < @ate_excl))
and (@canal IS NULL OR f_dre_base_retirada_lucros.LOCAL_VENDA = @canal) ) qa
    UNION ALL
    SELECT CAST(DATEFROMPARTS((SELECT MAX(ANO) FROM ChavesSel) - 1, 1, 1) AS date),
           qb.retirada_lucros
    FROM ( SELECT SUM(VALOR_CONVERTIDO) AS retirada_lucros FROM dbo.f_dre_base_retirada_lucros WHERE EXISTS (SELECT 1 FROM ChavesSel s WHERE s.ANO = f_dre_base_retirada_lucros.ANO + 1 AND s.MES = f_dre_base_retirada_lucros.MES AND s.LOCAL_VENDA = f_dre_base_retirada_lucros.LOCAL_VENDA)
      AND f_dre_base_retirada_lucros.DATA_COMPETENCIA >= DATEFROMPARTS((SELECT MIN(ANO) FROM ChavesSel) - 1, 1, 1)
      AND f_dre_base_retirada_lucros.DATA_COMPETENCIA <  DATEFROMPARTS((SELECT MAX(ANO) FROM ChavesSel), 1, 1)
and (1=1) ) qb
) z ORDER BY periodo
