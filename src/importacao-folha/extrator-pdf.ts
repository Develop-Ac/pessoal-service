/**
 * =============================================================================
 * MÓDULO: extrator-pdf.ts
 * Porta o extrator do projeto Python (extrator_pdf.py) para Node.
 *
 * Layout mapeado do PDF "Relatório de Líquidos":
 *   Cabeçalho de departamento:  "Departamento: N - NOME DO DEPARTAMENTO"
 *   Categorias:                 "Empregados" | "Contribuintes" | "Estagiários"
 *   Linha de colaborador:       "CODIGO NOME CPF VALOR"
 *                               ex: "17 ADRIANO KIESEL ZANIN 086.117.571-90 3.190,99"
 *   Competência (por página):   "Competência: 01/2024"
 *   Rodapés/cabeçalhos:         ignorados.
 *
 * Reconstrói as linhas a partir das posições (Y) dos itens de texto, imitando
 * o comportamento do pdfplumber.extract_text().
 * =============================================================================
 */

import pdfParse from 'pdf-parse';

export type TipoRegistro = 'Empregado' | 'Contribuinte' | 'Estagiario';

export interface RegistroFolha {
  competencia: string | null; // YYYY-MM
  matricula: string;
  nome: string;
  departamento_folha: string | null;
  departamento_codigo: string | null;
  cpf: string;
  valor_liquido: number | null;
  tipo_registro: TipoRegistro;
}

export interface ResultadoExtracao {
  registros: RegistroFolha[];
  total_paginas: number;
  inconsistencias: string[];
}

// --- Expressões regulares (espelham o Python) ---
const RE_DEPARTAMENTO = /^Departamento:\s*(\d+)\s*-\s*(.+)$/i;
const RE_CATEGORIA = /^(Empregados|Contribuintes|Estagi[aá]rios)$/i;
const RE_RODAPE_DEPARTAMENTO = /^Empregados:\s*\d+.*Total do Departamento/i;
const RE_RODAPE_EMPRESA = /^Empregados:\s*\d+.*Total da Empresa/i;
const RE_CABECALHO_PAGINA =
  /^(Empresa:|CNPJ:|C[aá]lculo:|RELA[CÇ][AÃ]O GERAL|C[oó]digo\s+Nome\s+do\s+empregado|P[aá]gina:|SORRISO,|Sistema licenciado)/i;
const RE_COMPETENCIA = /^Compet[eê]ncia:\s*(\d{2})\/(\d{4})/i;
const RE_COLABORADOR =
  /^(\d+)\s+([A-ZÀ-Ú][A-ZÀ-Ú\s]+?)\s+(\d{3}\.\d{3}\.\d{3}-\d{2})\s+([\d.,]+)$/;

/** Converte "3.190,99" -> 3190.99 ; "876,43" -> 876.43. */
export function normalizarValor(valorStr: string): number | null {
  try {
    const limpo = valorStr.trim().replace(/\./g, '').replace(',', '.');
    const v = parseFloat(limpo);
    return Number.isNaN(v) ? null : v;
  } catch {
    return null;
  }
}

/**
 * pagerender customizado: reconstrói linhas agrupando itens de texto por Y
 * (com tolerância), ordenando por X dentro da linha. Páginas separadas por \f.
 */
function renderPagina(pageData: any): Promise<string> {
  return pageData
    .getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false })
    .then((textContent: any) => {
      const linhas: { y: number; itens: { x: number; s: string }[] }[] = [];
      const TOL = 2; // tolerância vertical para considerar a mesma linha

      for (const item of textContent.items) {
        const str = item.str;
        if (!str) continue;
        const x = item.transform[4];
        const y = item.transform[5];
        let linha = linhas.find((l) => Math.abs(l.y - y) <= TOL);
        if (!linha) {
          linha = { y, itens: [] };
          linhas.push(linha);
        }
        linha.itens.push({ x, s: str });
      }

      // Ordena linhas de cima para baixo (Y decrescente no PDF) e itens por X.
      linhas.sort((a, b) => b.y - a.y);
      const texto = linhas
        .map((l) =>
          l.itens
            .sort((a, b) => a.x - b.x)
            .map((i) => i.s)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .join('\n');
      return texto + '\n\f';
    });
}

/** Extrai os registros de colaboradores de um PDF (buffer). */
export async function extrairDadosPdf(
  buffer: Buffer,
  nomeArquivo = 'arquivo.pdf',
): Promise<ResultadoExtracao> {
  const inconsistencias: string[] = [];
  const data = await pdfParse(buffer, { pagerender: renderPagina });

  const registros: RegistroFolha[] = [];
  let departamentoAtual: string | null = null;
  let codigoDeptoAtual: string | null = null;
  let categoriaAtual: TipoRegistro = 'Empregado';
  let competenciaAtual: string | null = null;

  const paginas = data.text.split('\f');
  const totalPaginas = data.numpages || paginas.length;

  let numPagina = 0;
  for (const pagina of paginas) {
    numPagina += 1;
    const linhas = pagina.split('\n');
    let numLinha = 0;
    for (let linha of linhas) {
      numLinha += 1;
      linha = linha.trim();
      if (!linha) continue;

      const mComp = linha.match(RE_COMPETENCIA);
      if (mComp) {
        competenciaAtual = `${mComp[2]}-${mComp[1]}`;
        continue;
      }

      if (RE_CABECALHO_PAGINA.test(linha)) continue;
      if (RE_RODAPE_DEPARTAMENTO.test(linha) || RE_RODAPE_EMPRESA.test(linha))
        continue;

      const mDepto = linha.match(RE_DEPARTAMENTO);
      if (mDepto) {
        codigoDeptoAtual = mDepto[1].trim();
        departamentoAtual = mDepto[2].trim();
        categoriaAtual = 'Empregado';
        continue;
      }

      const mCat = linha.match(RE_CATEGORIA);
      if (mCat) {
        const cat = mCat[1].toLowerCase();
        if (cat.includes('contribu')) categoriaAtual = 'Contribuinte';
        else if (cat.includes('estagi')) categoriaAtual = 'Estagiario';
        else categoriaAtual = 'Empregado';
        continue;
      }

      const mColab = linha.match(RE_COLABORADOR);
      if (mColab) {
        if (departamentoAtual === null) {
          inconsistencias.push(
            `Colaborador sem departamento (pág ${numPagina}, linha ${numLinha}): '${linha}'`,
          );
        }
        const matricula = mColab[1].trim();
        const nome = mColab[2].trim();
        const cpf = mColab[3].trim();
        const valorStr = mColab[4].trim();
        const valorLiquido = normalizarValor(valorStr);

        if (valorLiquido === null) {
          inconsistencias.push(
            `Valor inválido '${valorStr}' para '${nome}' (pág ${numPagina})`,
          );
        }
        if (!competenciaAtual) {
          inconsistencias.push(
            `Colaborador sem competência (pág ${numPagina}, linha ${numLinha}): '${linha}'`,
          );
        }

        registros.push({
          competencia: competenciaAtual,
          matricula,
          nome,
          departamento_folha: departamentoAtual,
          departamento_codigo: codigoDeptoAtual,
          cpf,
          valor_liquido: valorLiquido,
          tipo_registro: categoriaAtual,
        });
        continue;
      }

      // Linha não reconhecida — registra inconsistência (não interrompe).
      inconsistencias.push(
        `Linha não reconhecida (pág ${numPagina}, linha ${numLinha}): '${linha}'`,
      );
    }
  }

  return { registros, total_paginas: totalPaginas, inconsistencias };
}
