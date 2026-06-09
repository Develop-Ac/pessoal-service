. C:\Users\AcAcessorios\.bi\BI-Helpers.ps1
$ErrorActionPreference = 'Stop'
$outDir = "C:\Users\AcAcessorios\DESENVOLVIMENTO\SPRINT\01-06-2026 a 15-06-2026\rhdp-service\validacao"

function Open-FB([string]$inner) {
  $esc = $inner -replace "'", "''"
  return "SELECT * FROM OPENQUERY(CONSULTA, '$esc')"
}

# ---------- VENDAS (26/04 - 25/05) ----------
$vendasInner = @"
SELECT nfs.nfs, nfs.opf_codigo, nfs.cli_codigo, nfsi.pro_codigo,
  nfsi.quantidade, nfsi.unitario, nfsi.valor_descto as DESC_PRODUTO, nfs.valor_descto,
  nfsi.preco_custo, ord.ordem_servico, nfs.rep_codigo as Vendedor_Nota,
  ordi.rep_codigo as Vendedor_Item, nfsi.item
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
group by nfs.empresa, nfs.nfs, nfs.nota_fiscal, nfs.serie, nfs.chave_nfe, nfs.dt_emissao, nfs.opf_codigo, opf.opf_descricao, nfs.cli_codigo, cli.cli_nome, cli.uf, cli.cidade, nfs.indicador_presenca, nfs.base_icms, nfs.valor_icms, nfs.total_produtos, nfs.valor_descto, nfs.total_nota, subprod.grp_codigo, gprod.grp_descricao, pro.subgrp_codigo, subprod.subgrp_descricao, marc.mar_descricao, nfsi.pro_codigo, pro.pro_descricao, pro.ncm, nfsi.cst, nfsi.cfop, nfsi.unidade_comercial, nfsi.quantidade, nfsi.unitario, nfsi.total, nfsi.valor_descto, nfsi.qtde_devolvida, nfsi.promocao, nfsi.preco_venda, nfsi.preco_custo, nfsi.preco_custo_comercial, ord.ordem_servico, nfs.rep_codigo, ordi.rep_codigo, nfsi.item
"@
Write-Output "Lendo VENDAS..."
$vendas = Invoke-BISql (Open-FB $vendasInner)
$vendas | Select-Object NFS,OPF_CODIGO,CLI_CODIGO,PRO_CODIGO,QUANTIDADE,UNITARIO,DESC_PRODUTO,VALOR_DESCTO,PRECO_CUSTO,ORDEM_SERVICO,VENDEDOR_NOTA,VENDEDOR_ITEM |
  ConvertTo-Json -Depth 4 -Compress | Out-File "$outDir\vendas.json" -Encoding utf8
Write-Output ("VENDAS linhas: " + $vendas.Count)

# ---------- SERVIÇO (26/04 - 25/05) ----------
$servInner = @"
SELECT nfs.nfs, nfsi.pro_codigo, nfsi.quantidade, nfsi.unitario,
  nfsi.valor_descto as DESC_PRODUTO, nfs.valor_descto,
  ord.rep_codigo as COMICIONADO_VENDEDOR, ordcom.rep_codigo as COMICIONADO_ITEM
FROM nf_saida NFS
JOIN nfs_itens NFSI ON (nfs.empresa = nfsi.empresa) and (nfs.nfs = nfsi.nfs)
JOIN operacoes_fiscais OPF on (opf.empresa = nfs.empresa) and (nfs.opf_codigo = opf.opf_codigo)
JOIN clientes CLI ON (CLI.empresa = nfs.empresa) and (CLI.cli_codigo = nfs.cli_codigo)
LEFT join produtos PRO on (pro.empresa = nfs.empresa) and (pro.pro_codigo = nfsi.pro_codigo)
left join ordens_servico ord on (ord.empresa = nfs.empresa) and (ord.nfs = nfs.nfs)
left join os_itens ordi on (ordi.empresa = nfs.empresa) and (ordi.pro_codigo = nfsi.pro_codigo) and (ordi.ordem_servico = ord.ordem_servico)
left join ordem_servico_comissionado ordcom on (ordcom.empresa = nfs.empresa) and (ordcom.item = ordi.item) and (ordcom.ordem_servico = ord.ordem_servico)
WHERE NFS.dt_emissao between '26.04.2026' and '25.05.2026'
AND NFS.empresa = '3' AND ord.ordem_servico is not null AND nfs.dt_cancelamento is null
AND nfs.opf_codigo in (1, 2, 4, 5, 6, 7, 124, 101, 102, 104, 105, 106, 107, 200)
AND ord.categoria_codigo not in ('3','7','10','9')
"@
Write-Output "Lendo SERVICO..."
$serv = Invoke-BISql (Open-FB $servInner)
$serv | Select-Object NFS,PRO_CODIGO,QUANTIDADE,UNITARIO,DESC_PRODUTO,VALOR_DESCTO,COMICIONADO_VENDEDOR,COMICIONADO_ITEM |
  ConvertTo-Json -Depth 4 -Compress | Out-File "$outDir\servico.json" -Encoding utf8
Write-Output ("SERVICO linhas: " + $serv.Count)

# ---------- OS_SERVICOS (26/02 - 25/03, como a planilha salva) ----------
$osInner = @"
select OS.nfs, os.ordem_servico, osi.pro_codigo, osi.total, osi.rep_codigo
from os_itens OSI
left join ordens_servico OS on (osi.ordem_servico = os.ordem_servico) and (os.empresa = osi.empresa)
WHERE osi.pro_codigo in (37560, 4174) and os.dt_emissao between '26.02.2026' and '25.03.2026' and os.status = 4
"@
Write-Output "Lendo OS..."
$os = Invoke-BISql (Open-FB $osInner)
$os | Select-Object NFS,ORDEM_SERVICO,PRO_CODIGO,TOTAL,REP_CODIGO |
  ConvertTo-Json -Depth 4 -Compress | Out-File "$outDir\os.json" -Encoding utf8
Write-Output ("OS linhas: " + $os.Count)
Write-Output "OK"
