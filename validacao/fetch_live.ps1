. C:\Users\AcAcessorios\.bi\BI-Helpers.ps1
$ErrorActionPreference = 'Stop'
$outDir = "C:\Users\AcAcessorios\DESENVOLVIMENTO\SPRINT\01-06-2026 a 15-06-2026\rhdp-service\validacao"

# Query VENDAS EXATA do backend (firebird-source.ts), período 26/04-25/05.
$inner = @"
SELECT
      nfs.empresa, nfs.nfs, nfs.nota_fiscal, nfs.serie, nfs.chave_nfe, nfs.dt_emissao,
      nfs.opf_codigo, opf.opf_descricao, nfs.cli_codigo, cli.cli_nome, cli.uf, cli.cidade,
      nfs.indicador_presenca, nfs.base_icms, nfs.valor_icms, nfs.total_produtos, nfs.valor_descto,
      nfs.total_nota, subprod.grp_codigo, gprod.grp_descricao, pro.subgrp_codigo, subprod.subgrp_descricao,
      marc.mar_descricao, nfsi.pro_codigo, pro.pro_descricao, pro.ncm, nfsi.cst, nfsi.cfop,
      nfsi.unidade_comercial, nfsi.quantidade, nfsi.unitario, nfsi.total, nfsi.valor_descto as DESC_PRODUTO,
      nfsi.qtde_devolvida, nfsi.promocao, nfsi.preco_venda, nfsi.preco_custo, nfsi.preco_custo_comercial,
      ord.ordem_servico, nfs.rep_codigo as Vendedor_Nota, ordi.rep_codigo as Vendedor_Item, nfsi.item
FROM nf_saida NFS
JOIN nfs_itens NFSI ON (nfs.empresa = nfsi.empresa) and (nfs.nfs = nfsi.nfs)
JOIN operacoes_fiscais OPF on (opf.empresa = nfs.empresa) and (nfs.opf_codigo = opf.opf_codigo)
JOIN clientes CLI ON (CLI.empresa = nfs.empresa) and (CLI.cli_codigo = nfs.cli_codigo)
left join produtos PRO on (pro.empresa = nfs.empresa) and (pro.pro_codigo = nfsi.pro_codigo)
left join ordens_servico ord on (ord.empresa = nfs.empresa) and (ord.nfs = nfs.nfs)
left join ordem_servico_comissionado ordcom on (ordcom.empresa = nfs.empresa) and (ordcom.item = nfsi.item) and (ordcom.ordem_servico = ord.ordem_servico)
left join os_itens ordi on (ordi.empresa = nfs.empresa) and (ordi.pro_codigo = nfsi.pro_codigo) and (ordi.ordem_servico = ord.ordem_servico)
left join produtos_subgrupos subprod on (pro.empresa = subprod.empresa) and (pro.subgrp_codigo = subprod.subgrp_codigo)
left join produtos_grupos gprod on (pro.empresa = gprod.empresa) and (subprod.grp_codigo = gprod.grp_codigo)
left join marcas marc on (marc.empresa = nfs.empresa) and (marc.mar_codigo = pro.mar_codigo)
WHERE NFS.dt_emissao between '26.04.2026' and '25.05.2026'
AND NFS.empresa = '3' and nfs.dt_cancelamento is null
AND nfs.opf_codigo in (1, 2, 4, 5, 6, 7, 124, 101, 102, 104, 105, 106, 107, 200)
group by nfs.empresa, nfs.nfs, nfs.nota_fiscal, nfs.serie, nfs.chave_nfe, nfs.dt_emissao, nfs.opf_codigo, opf.opf_descricao, nfs.cli_codigo, cli.cli_nome, cli.uf, cli.cidade, nfs.indicador_presenca, nfs.base_icms,
nfs.valor_icms, nfs.total_produtos, nfs.valor_descto, nfs.total_nota, subprod.grp_codigo, gprod.grp_descricao, pro.subgrp_codigo, subprod.subgrp_descricao, marc.mar_descricao, nfsi.pro_codigo, pro.pro_descricao,
pro.ncm, nfsi.cst, nfsi.cfop, nfsi.unidade_comercial, nfsi.quantidade, nfsi.unitario, nfsi.total, nfsi.valor_descto, nfsi.qtde_devolvida, nfsi.promocao, nfsi.preco_venda, nfsi.preco_custo, nfsi.preco_custo_comercial,
ord.ordem_servico, nfs.rep_codigo, ordi.rep_codigo, nfsi.item
"@
$esc = $inner -replace "'", "''"
$sql = "SELECT NFS, ITEM, PRO_CODIGO AS pro, OPF_CODIGO AS opf, ORDEM_SERVICO AS os, VENDEDOR_NOTA AS vnota, VENDEDOR_ITEM AS vitem, QUANTIDADE AS qtd, UNITARIO AS unit, DESC_PRODUTO AS descp, VALOR_DESCTO AS vdescto, PRECO_CUSTO AS custo FROM OPENQUERY(CONSULTA, '$esc')"
$live = Invoke-BISql $sql
Write-Output ("LIVE linhas: " + $live.Count)
$live | Select-Object @{n='nfs';e={$_.NFS}}, @{n='item';e={$_.ITEM}}, pro, opf, os, vnota, vitem, qtd, unit, descp, vdescto, custo |
  ConvertTo-Json -Depth 4 -Compress | Out-File "$outDir\live_rows.json" -Encoding utf8
Write-Output "ok"
