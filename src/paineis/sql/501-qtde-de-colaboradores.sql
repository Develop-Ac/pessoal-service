-- Dashboard 22 do Metabase, card 501 (dashcard 539): Qtde de Colaboradores
-- Gerado por scripts/extrair-cards-metabase.ts. Parâmetros declarados pelo serviço:
--   @de date, @ate_excl date (competência no intervalo [de, ate_excl); NULL = sem filtro)
--   @canal varchar (LOCAL_VENDA; NULL = todos os canais)
SELECT
    DATA_COMPETENCIA,
    ANO,
    MES,
    LOCAL_VENDA,
    SUM(qtd_equivalente) AS headcount_equivalente
FROM BI.dbo.f_colaborador_equivalente_mensal
WHERE (@de IS NULL OR (f_colaborador_equivalente_mensal.DATA_COMPETENCIA >= @de AND f_colaborador_equivalente_mensal.DATA_COMPETENCIA < @ate_excl))
  AND (@canal IS NULL OR f_colaborador_equivalente_mensal.LOCAL_VENDA = @canal)
GROUP BY
    DATA_COMPETENCIA,
    ANO,
    MES,
    LOCAL_VENDA
ORDER BY
    DATA_COMPETENCIA,
    LOCAL_VENDA;
