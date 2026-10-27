-- Dashboard 22 do Metabase, card 493 (dashcard 531): Despesa Com Pessoal por Conta
-- Gerado por scripts/extrair-cards-metabase.ts. Parâmetros declarados pelo serviço:
--   @de date, @ate_excl date (competência no intervalo [de, ate_excl); NULL = sem filtro)
--   @canal varchar (LOCAL_VENDA; NULL = todos os canais)
SELECT
    DESCRICAO_ANALITICA_DRE,
    SUM(VALOR_CONVERTIDO) *-1 AS valor
FROM BI.dbo.f_dre_base_despesa_com_pessoal
where (@de IS NULL OR (f_dre_base_despesa_com_pessoal.DATA_COMPETENCIA >= @de AND f_dre_base_despesa_com_pessoal.DATA_COMPETENCIA < @ate_excl))
and (@canal IS NULL OR f_dre_base_despesa_com_pessoal.LOCAL_VENDA = @canal)
GROUP BY DESCRICAO_ANALITICA_DRE
ORDER BY valor DESC;
