/**
 * =============================================================================
 * MÓDULO: extrator-ponto.ts
 * Extrai os dias de FALTA/DISPENSA do "CARTÃO PONTO" (Secullum Ponto, PDF).
 *
 * Layout mapeado do PDF:
 *   Cabeçalho:   "Nome RENAN FERREIRA MAFIOLETTI ..." (a grade de horário de
 *                trabalho fica à direita e vaza para a mesma linha),
 *                "N° Folha 224 CPF 042.380.541-05 ...",
 *                "... DE 26/07/2026 ATÉ 25/08/2026".
 *   Grade:       cabeçalho "DIA ENT. 1 SAÍ. 1 ... NORMAIS FALTAS ... EXTRAS";
 *                uma linha por dia "26/07/26 - dom ..." com as batidas OU os
 *                marcadores FALTA / DISPENS(A) nas colunas de batida, seguidos
 *                dos totalizadores (NORMAIS, FALTAS, DSR...).
 *
 * As colunas de batida e os totalizadores viram texto na MESMA linha, então a
 * separação é feita pela posição X: só o que está à ESQUERDA da coluna
 * "NORMAIS" conta como batida/marcação de presença. Um dia com marcação E
 * batida (abono parcial) volta com `parcial=true` — a decisão de excluir fica
 * com o RH na tela de conferência.
 * =============================================================================
 */

import pdfParse from 'pdf-parse';

export interface PontoDiaExtraido {
  data: string; // YYYY-MM-DD
  motivo: 'FALTA' | 'DISPENSA';
  /** Houve batida no dia além da marcação (presença parcial). */
  parcial: boolean;
}

export interface CartaoPontoExtraido {
  nome: string | null;
  cpf: string | null;
  folha: string | null;
  periodo_inicio: string | null; // YYYY-MM-DD
  periodo_fim: string | null;
  dias: PontoDiaExtraido[];
  avisos: string[];
}

interface ItemBruto {
  /** transform[0]/transform[1] — detectam página rotacionada 90°. */
  a: number;
  b: number;
  x: number;
  y: number;
  s: string;
}

interface ItemTexto {
  /** Posição ao longo da linha (o "x lógico", já corrigida a rotação). */
  pos: number;
  s: string;
}

interface LinhaTexto {
  itens: ItemTexto[];
  texto: string;
}

const RE_DIA = /^(\d{2})\/(\d{2})\/(\d{2,4})\s*-\s*(dom|seg|ter|qua|qui|sex|s[áa]b)\b/i;
const RE_PERIODO = /DE\s+(\d{2})\/(\d{2})\/(\d{4})\s+AT[ÉE]\s+(\d{2})\/(\d{2})\/(\d{4})/i;
const RE_CPF = /CPF\s*:?\s*(\d{3}\.\d{3}\.\d{3}-\d{2})/i;
const RE_FOLHA = /N[º°o.]*\s*Folha\s+(\d+)/i;
// Batida: hh:mm com marcadores opcionais do Secullum (* manual, § abono, ^ pré).
const RE_BATIDA = /^\d{1,2}:\d{2}[*§^¹]*$/;

function ddmmyyyyParaYmd(d: string, m: string, a: string): string {
  const ano = a.length === 2 ? `20${a}` : a;
  return `${ano}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * Agrupa os itens de texto da página em linhas (tolerância na coordenada da
 * linha). O CARTÃO PONTO do Secullum sai ROTACIONADO 90° (paisagem): nesse
 * caso a coordenada da linha é o X da matriz e a posição ao longo da linha é
 * o Y — a rotação é detectada pela própria matriz de transformação (|b|>|a|).
 */
function montarLinhas(itens: ItemBruto[]): LinhaTexto[] {
  const uteis = itens.filter((i) => i.s && i.s.trim());
  if (!uteis.length) return [];
  const rotacionados = uteis.filter((i) => Math.abs(i.b) > Math.abs(i.a)).length;
  const rotacionada = rotacionados > uteis.length / 2;

  const TOL = 2;
  // ordem: coordenada que percorre as linhas de cima para baixo (crescente).
  const linhas: { ordem: number; itens: ItemTexto[] }[] = [];
  for (const item of uteis) {
    const ordem = rotacionada ? item.x : -item.y;
    const pos = rotacionada ? item.y : item.x;
    let linha = linhas.find((l) => Math.abs(l.ordem - ordem) <= TOL);
    if (!linha) {
      linha = { ordem, itens: [] };
      linhas.push(linha);
    }
    linha.itens.push({ pos, s: item.s });
  }
  linhas.sort((a, b) => a.ordem - b.ordem);
  return linhas.map((l) => {
    const ordenados = [...l.itens].sort((a, b) => a.pos - b.pos);
    return {
      itens: ordenados,
      texto: ordenados.map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim(),
    };
  });
}

/** Extrai o cartão ponto de um PDF (buffer). Aceita mais de uma página. */
export async function extrairCartaoPonto(
  buffer: Buffer,
  nomeArquivo = 'arquivo.pdf',
): Promise<CartaoPontoExtraido> {
  const paginas: ItemBruto[][] = [];
  await pdfParse(buffer, {
    pagerender: (pageData: any) =>
      pageData
        .getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false })
        .then((tc: any) => {
          paginas.push(
            tc.items.map((it: any) => ({
              a: it.transform[0] as number,
              b: it.transform[1] as number,
              x: it.transform[4] as number,
              y: it.transform[5] as number,
              s: String(it.str ?? ''),
            })),
          );
          return '';
        }),
  });

  const resultado: CartaoPontoExtraido = {
    nome: null,
    cpf: null,
    folha: null,
    periodo_inicio: null,
    periodo_fim: null,
    dias: [],
    avisos: [],
  };

  let achouGrade = false;
  for (const itensPagina of paginas) {
    const linhas = montarLinhas(itensPagina);

    // Posição da coluna NORMAIS (fronteira batidas -> totalizadores).
    let posNormais = Infinity;
    for (const l of linhas) {
      const item = l.itens.find((i) => i.s.trim().toUpperCase() === 'NORMAIS');
      if (item && /\bDIA\b|ENT/i.test(l.texto)) {
        posNormais = item.pos;
        break;
      }
    }

    for (const l of linhas) {
      const texto = l.texto;

      if (!resultado.nome) {
        const mNome = texto.match(/^Nome\s+(.+)$/i);
        if (mNome) {
          // Corta a grade "Horário de Trabalho" que vaza para a mesma linha.
          resultado.nome = mNome[1]
            .replace(/\s+(SEG|TER|QUA|QUI|SEX|S[ÁA]B|DOM)(\s+\d{1,2}:\d{2})*\s*$/i, '')
            .trim() || null;
        }
      }
      if (!resultado.cpf) {
        const mCpf = texto.match(RE_CPF);
        if (mCpf) resultado.cpf = mCpf[1];
      }
      if (!resultado.folha) {
        const mFolha = texto.match(RE_FOLHA);
        if (mFolha) resultado.folha = mFolha[1];
      }
      if (!resultado.periodo_inicio) {
        const mPer = texto.match(RE_PERIODO);
        if (mPer) {
          resultado.periodo_inicio = ddmmyyyyParaYmd(mPer[1], mPer[2], mPer[3]);
          resultado.periodo_fim = ddmmyyyyParaYmd(mPer[4], mPer[5], mPer[6]);
        }
      }

      const mDia = texto.match(RE_DIA);
      if (!mDia) continue;
      achouGrade = true;

      // Só as células à esquerda de NORMAIS são batidas/marcações; sem o
      // cabeçalho da grade nesta página, não dá para separar dos totalizadores
      // (ex.: coluna FALTAS "08:00") — nesse caso não conta batidas.
      const celulas = Number.isFinite(posNormais)
        ? l.itens.filter((i) => i.pos < posNormais - 1)
        : [];
      const textoCelulas = (Number.isFinite(posNormais)
        ? celulas.map((i) => i.s).join(' ')
        : texto
      ).toUpperCase();

      const temDispensa = textoCelulas.includes('DISPENS');
      const temFalta = /\bFALTA\b/.test(textoCelulas);
      if (!temDispensa && !temFalta) continue;

      const data = ddmmyyyyParaYmd(mDia[1], mDia[2], mDia[3]);
      const batidas = celulas.filter(
        (i) => !RE_DIA.test(i.s.trim()) && RE_BATIDA.test(i.s.trim()),
      ).length;
      const dia: PontoDiaExtraido = {
        data,
        motivo: temDispensa ? 'DISPENSA' : 'FALTA',
        parcial: batidas > 0,
      };
      if (dia.parcial) {
        resultado.avisos.push(
          `${mDia[1]}/${mDia[2]}: dia com ${dia.motivo.toLowerCase()} E batida de ponto ` +
            `(presença parcial) — confira se as vendas do dia devem sair da comissão.`,
        );
      }
      resultado.dias.push(dia);
    }
  }

  if (!achouGrade) {
    resultado.avisos.push(
      `Nenhuma linha de dia reconhecida em "${nomeArquivo}" — confirme se é o ` +
        `CARTÃO PONTO do Secullum.`,
    );
  }
  if (!resultado.nome) {
    resultado.avisos.push(`Nome do colaborador não encontrado em "${nomeArquivo}".`);
  }

  return resultado;
}
