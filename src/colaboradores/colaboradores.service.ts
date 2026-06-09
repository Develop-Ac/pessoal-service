import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AtualizarColaboradorDto,
  ListarColaboradoresQuery,
} from './colaboradores.dto';

/** Campos de percentual por canal (somam 100% quando RATEIO_FIXO). */
const CAMPOS_PERCENTUAL = [
  'percentual_atacado',
  'percentual_varejo',
  'percentual_servico',
  'percentual_varejo_servico',
  'percentual_corporativo',
] as const;

type ColaboradorRow = Prisma.CadastroColaboradoresGetPayload<{}>;

@Injectable()
export class ColaboradoresService {
  constructor(private readonly prisma: PrismaService) {}

  /** Converte Decimal/Date do Prisma para tipos JSON simples. */
  private serializar(c: ColaboradorRow) {
    const num = (v: Prisma.Decimal | null) => (v == null ? 0 : Number(v));
    return {
      id: c.id,
      matricula: c.matricula,
      nome: c.nome,
      departamento_folha: c.departamento_folha,
      cpf: c.cpf,
      centro_custo_padrao: c.centro_custo_padrao,
      tipo_alocacao: c.tipo_alocacao,
      percentual_atacado: num(c.percentual_atacado),
      percentual_varejo: num(c.percentual_varejo),
      percentual_servico: num(c.percentual_servico),
      percentual_varejo_servico: num(c.percentual_varejo_servico),
      percentual_corporativo: num(c.percentual_corporativo),
      ativo: c.ativo,
      observacao: c.observacao,
      vigencia_inicial: c.vigencia_inicial,
      vigencia_final: c.vigencia_final,
      data_cadastro: c.data_cadastro,
      data_atualizacao: c.data_atualizacao,
    };
  }

  async listar(q: ListarColaboradoresQuery) {
    const where: Prisma.CadastroColaboradoresWhereInput = {};

    if (q.ativo !== undefined) where.ativo = q.ativo;
    // Por padrão lista apenas registros vigentes, salvo quando vigentes=false.
    if (q.vigentes !== false) where.vigencia_final = null;
    if (q.semAlocacao) where.tipo_alocacao = null;
    if (q.busca && q.busca.trim()) {
      const termo = q.busca.trim();
      where.OR = [
        { nome: { contains: termo } },
        { matricula: { contains: termo } },
      ];
    }

    const lista = await this.prisma.cadastroColaboradores.findMany({
      where,
      orderBy: [{ nome: 'asc' }],
    });
    return lista.map((c) => this.serializar(c));
  }

  async obter(id: number) {
    const c = await this.prisma.cadastroColaboradores.findUnique({
      where: { id },
    });
    if (!c) throw new NotFoundException('Colaborador não encontrado.');
    return this.serializar(c);
  }

  async atualizar(id: number, dto: AtualizarColaboradorDto) {
    const atual = await this.prisma.cadastroColaboradores.findUnique({
      where: { id },
    });
    if (!atual) throw new NotFoundException('Colaborador não encontrado.');

    // Monta o estado final mesclando valores atuais + alterações recebidas,
    // para validar a regra de soma considerando o registro completo.
    const merge = (
      campo: (typeof CAMPOS_PERCENTUAL)[number],
    ): number => {
      const recebido = (dto as any)[campo];
      if (recebido !== undefined) return Number(recebido);
      const atualVal = (atual as any)[campo] as Prisma.Decimal | null;
      return atualVal == null ? 0 : Number(atualVal);
    };

    const tipoFinal =
      dto.tipo_alocacao !== undefined ? dto.tipo_alocacao : atual.tipo_alocacao;

    if (tipoFinal === 'RATEIO_FIXO') {
      const soma = CAMPOS_PERCENTUAL.reduce((acc, c) => acc + merge(c), 0);
      // Tolerância para arredondamento de decimais (2 casas).
      if (Math.abs(soma - 100) > 0.01) {
        throw new BadRequestException({
          error: 'PERCENTUAIS_INVALIDOS',
          message: `Para tipo_alocacao=RATEIO_FIXO a soma dos percentuais deve ser 100%. Soma atual: ${soma.toFixed(2)}%.`,
        });
      }
    }

    const data: Prisma.CadastroColaboradoresUpdateInput = {
      data_atualizacao: new Date(),
    };
    if (dto.centro_custo_padrao !== undefined)
      data.centro_custo_padrao = dto.centro_custo_padrao;
    if (dto.tipo_alocacao !== undefined) data.tipo_alocacao = dto.tipo_alocacao;
    if (dto.ativo !== undefined) data.ativo = dto.ativo;
    if (dto.observacao !== undefined) data.observacao = dto.observacao;
    for (const campo of CAMPOS_PERCENTUAL) {
      const v = (dto as any)[campo];
      if (v !== undefined) (data as any)[campo] = new Prisma.Decimal(v);
    }

    const atualizado = await this.prisma.cadastroColaboradores.update({
      where: { id },
      data,
    });
    return this.serializar(atualizado);
  }
}
