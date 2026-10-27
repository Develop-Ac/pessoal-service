// Cliente mínimo da API do Metabase interno (bi.acacessorios.local), usado
// pelos scripts de extração e comparação dos painéis nativos.
// O certificado do Metabase é self-signed: rejectUnauthorized=false.
// A chave vem de METABASE_API_KEY (ambiente) ou, na falta, da ÚLTIMA linha
// METABASE_API_KEY do .env do frontend no workspace da intranet.
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

export const METABASE_URL = process.env.METABASE_SITE_URL || 'https://bi.acacessorios.local';

function lerChave(): string {
  if (process.env.METABASE_API_KEY) return process.env.METABASE_API_KEY;
  const envFront = path.resolve(
    import.meta.dirname,
    '../../../_workspaces/intranet-workspace/cotacao-frontend/.env',
  );
  const linhas = fs
    .readFileSync(envFront, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('METABASE_API_KEY='));
  const ultima = linhas.pop();
  if (!ultima) throw new Error(`METABASE_API_KEY não encontrada em ${envFront}`);
  return ultima.slice('METABASE_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
}

const chave = lerChave();
const agent = new https.Agent({ rejectUnauthorized: false });

export function metabase(metodo: 'GET' | 'POST', rota: string, corpo?: unknown): Promise<any> {
  const body = corpo === undefined ? undefined : JSON.stringify(corpo);
  const u = new URL(rota, METABASE_URL);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: metodo,
        agent,
        headers: {
          'x-api-key': chave,
          'Content-Type': 'application/json',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        let dados = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (dados += c));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode >= 300)
            return reject(new Error(`${metodo} ${rota}: HTTP ${res.statusCode} ${dados.slice(0, 300)}`));
          try {
            resolve(JSON.parse(dados));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
