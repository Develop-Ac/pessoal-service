-- Dashboard 22 do Metabase, card 495 (dashcard 533): Despesas com Pessoal
-- Gerado por scripts/extrair-cards-metabase.ts. Parâmetros declarados pelo serviço:
--   @de date, @ate_excl date (competência no intervalo [de, ate_excl); NULL = sem filtro)
--   @canal varchar (LOCAL_VENDA; NULL = todos os canais)
SELECT
    DATEFROMPARTS(ANO, MES, 1) AS competencia,
    LOCAL_VENDA,
    SUM(VALOR_CONVERTIDO) * -1 AS despesa_com_pessoal
FROM BI.dbo.f_dre_base_despesa_com_pessoal
WHERE (@de IS NULL OR (f_dre_base_despesa_com_pessoal.DATA_COMPETENCIA >= @de AND f_dre_base_despesa_com_pessoal.DATA_COMPETENCIA < @ate_excl))
  AND (@canal IS NULL OR f_dre_base_despesa_com_pessoal.LOCAL_VENDA = @canal)
GROUP BY
    DATEFROMPARTS(ANO, MES, 1),
    LOCAL_VENDA
ORDER BY
    competencia,
    LOCAL_VENDA;
