/**
 * =============================================================================
 * MÓDULO: sincronizacao.ts
 * Porta src/sincronizar_cadastro.py: sincroniza colaboradores da importação
 * bruta para o cadastro mestre (CadastroColaboradores), com versionamento por
 * vigência. Chave lógica: (matricula, nome em maiúsculas).
 * =============================================================================
 */

import { Prisma, PrismaClient } from '@prisma/client';

export interface ResultadoSincronizacao {
  total_importados: number;
  total_novos: number;
  total_ja_existentes: number;
  total_mudanca_dept: number;
  mensagem: string;
}

/** Mês anterior no formato YYYY-MM (fecha a vigência do registro antigo). */
export function calcularMesAnterior(competencia: string): string {
  const [anoStr, mesStr] = competencia.split('-');
  const ano = parseInt(anoStr, 10);
  const mes = parseInt(mesStr, 10);
  if (mes === 1) return `${ano - 1}-12`;
  return `${ano}-${String(mes - 1).padStart(2, '0')}`;
}

const up = (v: string | null | undefined) => (v ?? '').toString().trim().toUpperCase();

/**
 * Sincroniza o cadastro mestre para uma competência.
 * Deve ser chamada após gravar a ImportacaoFolhaBruta da competência.
 */
export async function sincronizarCadastro(
  prisma: PrismaClient | Prisma.TransactionClient,
  competencia: string,
): Promise<ResultadoSincronizacao> {
  const resultado: ResultadoSincronizacao = {
    total_importados: 0,
    total_novos: 0,
    total_ja_existentes: 0,
    total_mudanca_dept: 0,
    mensagem: '',
  };

  // 1) Colaboradores distintos importados na competência (dedup nome+matrícula,
  //    priorizando registros com departamento preenchido).
  const brutos = await prisma.importacaoFolhaBruta.findMany({
    where: { competencia, nome: { not: '' } },
    select: { matricula: true, nome: true, departamento_folha: true, cpf: true },
  });

  const porChave = new Map<
    string,
    { matricula: string; nome: string; departamento_folha: string; cpf: string | null }
  >();
  for (const b of brutos) {
    const nome = (b.nome ?? '').trim();
    if (!nome) continue;
    const matricula = (b.matricula ?? '').trim();
    const depto = up(b.departamento_folha);
    const chave = `${up(nome)}_${matricula}`;
    const existente = porChave.get(chave);
    // Mantém o que tiver departamento preenchido (peso maior).
    if (!existente || (!existente.departamento_folha && depto)) {
      porChave.set(chave, { matricula, nome, departamento_folha: depto, cpf: b.cpf });
    }
  }
  const importados = Array.from(porChave.values());
  resultado.total_importados = importados.length;

  if (importados.length === 0) {
    resultado.mensagem = 'Nenhum colaborador importado para sincronizar.';
    return resultado;
  }

  // 2) Cadastros vigentes ativos: chave (matricula, nomeUpper) -> departamento.
  const ativos = await prisma.cadastroColaboradores.findMany({
    where: { ativo: true, vigencia_final: null },
    select: { matricula: true, nome: true, departamento_folha: true },
  });
  const ativosMap = new Map<string, { departamento: string }>();
  for (const a of ativos) {
    const mat = (a.matricula ?? '').trim();
    const nome = up(a.nome);
    ativosMap.set(`${mat}|${nome}`, { departamento: up(a.departamento_folha) });
  }

  const mesAnterior = calcularMesAnterior(competencia);
  const novos: typeof importados = [];
  const fecharVigencia: { matricula: string; nome: string }[] = [];

  for (const row of importados) {
    const nomeComp = up(row.nome);
    if (!nomeComp) continue;
    const chave = `${row.matricula}|${nomeComp}`;
    const banco = ativosMap.get(chave);

    if (banco) {
      if (banco.departamento !== row.departamento_folha) {
        // Mudança de departamento: fecha o antigo e cria nova versão.
        fecharVigencia.push({ matricula: row.matricula, nome: row.nome });
        novos.push(row);
        resultado.total_mudanca_dept += 1;
      } else {
        resultado.total_ja_existentes += 1;
      }
    } else {
      novos.push(row);
    }
  }

  // 3) Gravação (fechamento de vigência + inserção dos novos).
  if (novos.length > 0 || fecharVigencia.length > 0) {
    for (const f of fecharVigencia) {
      await prisma.cadastroColaboradores.updateMany({
        where: {
          matricula: f.matricula || null,
          nome: f.nome.trim(),
          vigencia_final: null,
        },
        data: { vigencia_final: mesAnterior, data_atualizacao: new Date() },
      });
    }

    for (const c of novos) {
      await prisma.cadastroColaboradores.create({
        data: {
          matricula: c.matricula || null,
          nome: c.nome.trim(),
          departamento_folha: c.departamento_folha || null,
          cpf: c.cpf ?? null,
          centro_custo_padrao: null,
          tipo_alocacao: null,
          percentual_atacado: new Prisma.Decimal(0),
          percentual_varejo: new Prisma.Decimal(0),
          percentual_servico: new Prisma.Decimal(0),
          percentual_varejo_servico: new Prisma.Decimal(0),
          percentual_corporativo: new Prisma.Decimal(0),
          ativo: true,
          observacao: null,
          data_cadastro: new Date(),
          vigencia_inicial: competencia,
          vigencia_final: null,
        },
      });
    }
  }

  resultado.total_novos = novos.length - resultado.total_mudanca_dept;
  resultado.mensagem = `Sincronização: ${resultado.total_novos} novos, ${resultado.total_mudanca_dept} mudou departamento, ${resultado.total_ja_existentes} mantidos.`;
  return resultado;
}
