/*
  Férias por representante (dbo.ComissaoFerias): uma linha por período de férias,
  com início e fim, independente do período de comissões. Qualquer mês comissional
  que a janela cruzar a enxerga, recortada aos seus próprios dias (26 a 25):
    - vendedores (varejo e atacado): os dias recortados alimentam a média de férias;
    - supervisores: a janela recortada tira o movimento daqueles dias da base.
  Antes, as datas (supervisores) e a contagem de dias (vendedores) ficavam na linha
  do período em ComissaoParametroManual e tinham de ser redigitadas quando as
  férias atravessavam a virada do mês comissional.
*/
import { janelaFerias } from './calculo-engine';

/** Linha de dbo.ComissaoFerias (datas em YYYY-MM-DD). */
export interface FeriasRow {
  rep_codigo: number;
  ferias_inicio: string;
  ferias_fim: string;
}

/** Férias de um representante vistas de dentro de um período comissional. */
export interface FeriasPeriodo {
  /** Janela recortada ao período (o que a engine usa). */
  inicio: string;
  fim: string;
  /** Dias de férias dentro do período (soma, se houver mais de uma janela). */
  dias: number;
  /** Janela como foi digitada (sem recorte), para a tela mostrar e editar. */
  janela_inicio: string;
  janela_fim: string;
}

/**
 * Recorta as férias ao período e agrega por representante. Linhas que não cruzam
 * o período são ignoradas. Com mais de uma janela no mesmo período, a janela
 * recortada vai do primeiro ao último dia e `dias` soma só os dias de férias.
 * ponytail: supervisor com duas janelas no mesmo mês perderia da base também os
 * dias entre elas — caso raro; quebrar em várias janelas se acontecer.
 */
export function feriasNoPeriodo(
  rows: FeriasRow[],
  periodoIni: string,
  periodoFim: string,
): Map<number, FeriasPeriodo> {
  const mapa = new Map<number, FeriasPeriodo>();
  for (const r of rows) {
    const j = janelaFerias(
      { tem_ferias: true, ferias_inicio: r.ferias_inicio, ferias_fim: r.ferias_fim },
      periodoIni,
      periodoFim,
    );
    if (!j) continue;
    const ini = r.ferias_inicio.slice(0, 10);
    const fim = r.ferias_fim.slice(0, 10);
    const atual = mapa.get(Number(r.rep_codigo));
    if (!atual) {
      mapa.set(Number(r.rep_codigo), { ...j, janela_inicio: ini, janela_fim: fim });
      continue;
    }
    atual.inicio = atual.inicio < j.inicio ? atual.inicio : j.inicio;
    atual.fim = atual.fim > j.fim ? atual.fim : j.fim;
    atual.dias += j.dias;
    atual.janela_inicio = atual.janela_inicio < ini ? atual.janela_inicio : ini;
    atual.janela_fim = atual.janela_fim > fim ? atual.janela_fim : fim;
  }
  return mapa;
}

/** Campos de férias que o serviço escreve nos parâmetros manuais de um rep. */
export interface CamposFerias {
  tem_ferias: boolean;
  dias_ferias: number;
  ferias_inicio: string | null;
  ferias_fim: string | null;
}

/**
 * Férias efetivas de um rep no período: a tabela de férias manda; sem linha lá,
 * vale só a contagem antiga de dias gravada na linha do período (vendedor de
 * antes da tabela), nunca datas antigas — essas foram migradas para a tabela.
 */
export function camposFerias(
  f: FeriasPeriodo | undefined,
  legado: Partial<CamposFerias> | undefined,
): CamposFerias {
  if (f) return { tem_ferias: true, dias_ferias: f.dias, ferias_inicio: f.inicio, ferias_fim: f.fim };
  const dias = legado?.tem_ferias && !legado.ferias_inicio ? Number(legado.dias_ferias ?? 0) : 0;
  return { tem_ferias: dias > 0, dias_ferias: dias, ferias_inicio: null, ferias_fim: null };
}
