/**
 * parsePdf.js — Parser de pedidos TOTVS/SIGA
 *
 * Dependência: pdf-parse (já no package.json)
 *
 * Formato real dos PDFs TOTVS/SIGA (descoberto por inspeção dos tokens XY):
 *
 *   Cada linha de produto aparece de duas formas:
 *
 *   FORMA A — descrição curta (lote no token direito x≈351):
 *     x=16:  "   8  PN8092 PURO WHEY BAUN - 909 GR"
 *     x=351: "2628138    05/28  129,97 1039,76"
 *
 *   FORMA B — descrição longa (lote junto no mesmo token, x=16):
 *     x=16:  "   2  PN8704 PERFORM SIMPLY WHEY BAUN 1,8 KG    2527204    07/27  179,97  359,94"
 *
 *   FORMA C — lote cortado no meio (última parte no token direito):
 *     x=16 (256039):  "  24  PN8411 MANGANESE CHELATED - 100 TABL.     252"
 *     x=364:          "7038    09/27   34,97  839,28"
 *     → lote = "252" + "7038" = "2527038"
 *
 *   FORMA D — PDF gerado via browser (ex: GNT). Cada linha de produto
 *     chega como UM ÚNICO TOKEN em x≈50, com tudo junto:
 *     x=50: "150  GNT8762 HMB 120 TABL. - GNT               2628097    04/28   37,97 5695,50"
 *     O código pode começar com letras (GNT, PN, etc.) seguidas de dígitos.
 *
 *   O PDF inteiro é renderizado duas vezes (páginas duplicadas).
 *   Deduplicação por número de folha (Folha..: N).
 *
 * Retorno:
 *   { cab: {...}, produtos: [{ cod, descricao, lote, validade, qtde }] }
 */

'use strict';

const pdfParse = require('pdf-parse');

// ── Constantes ────────────────────────────────────────────────────────────────
// X mínimo do token direito (lote/validade/valores)
const X_DIR = 300;

// ── Regex ─────────────────────────────────────────────────────────────────────
const RE_FOLHA    = /Folha\.+\s*(\d+)/;
// Aceita códigos como PN8092 e GNT8762 (letras seguidas de dígitos)
const RE_PROD_ESQ = /^\s*(\d+)\s+([A-Z]{2,4}\d\w*)\s+(.*?)$/i;
const RE_CONT_IND = /^\s{8,}(\S.*)$/;           // continuação: ≥8 espaços de indentação
const RE_LOTE_RE  = /\d[A-Z0-9]{5,7}[A-Z]?/gi;  // extrai todos os lotes candidatos
const RE_LOTE_ONE = /^\d[A-Z0-9]{5,7}[A-Z]?$/i; // valida lote isolado
// Formato D — linha inteira num único token (PDF gerado via browser, ex: GNT)
// Captura: qtde  COD  descricao  lote  validade  preço  total
const RE_LINHA_COMPLETA = /^\s*(\d+)\s+([A-Z]{2,4}\d\w*)\s+(.*?)\s{2,}(\d[A-Z0-9]{5,7}[A-Z]?)\s+(\d{2}\/\d{2})\s+[\d.,]+\s+[\d.,*]+\s*$/i;
const RE_MM_AA    = /\b(\d{2}\/\d{2})\b/;
const RE_MONEY    = /\b\d{1,3}(?:\.\d{3})*,\d{2}\b|\*+,\*+/g;
const RE_IGNORA   = /^[-_]{5,}|^Qtde\s|^Folha|^SIGA\s|^Hora|^Data\s|^Cliente\s|^Endere|^Tipo\s|^CNPJ|^Repres|^Volume\s|^Nat\.|^Frete|^\d+o\s+Vencto|^Transp\.|^Ender\.|^NUM\.CXA|^SEPARADO|^EMBALADO|^CONFERIDO|^FINANCEIRO|^\d{3,}\s+[\d.,]/;

// ── Coleta de tokens por página ───────────────────────────────────────────────

/**
 * Agrupa tokens da página em linhas lógicas { y, esq, dir }.
 * - esq: tokens com x < X_DIR (descrição / início do lote)
 * - dir: tokens com x ≥ X_DIR (restante do lote + validade + valores)
 * Dedup por (x, y, texto) para eliminar tokens duplicados.
 */
function coletarLinhas(pageData) {
  return pageData.getTextContent({ normalizeWhitespace: false }).then(function (tc) {
    const seen = new Set();
    const map  = new Map();

    for (const item of tc.items) {
      if (!item.str) continue;
      const x   = Math.round(item.transform[4]);
      const y   = Math.round(item.transform[5]);
      const key = x + ',' + y + ',' + item.str;
      if (seen.has(key)) continue;
      seen.add(key);

      // Encontra linha existente com Y próximo (tolerância ±3 pt)
      let ky = null;
      for (const [k] of map) { if (Math.abs(k - y) <= 3) { ky = k; break; } }
      if (ky === null) { ky = y; map.set(ky, { esq: [], dir: [] }); }

      if (x >= X_DIR) map.get(ky).dir.push({ x, t: item.str });
      else            map.get(ky).esq.push({ x, t: item.str });
    }

    return [...map.entries()]
      .sort((a, b) => b[0] - a[0])  // Y decrescente (cima → baixo no PDF)
      .map(([y, cols]) => {
        cols.esq.sort((a, b) => a.x - b.x);
        cols.dir.sort((a, b) => a.x - b.x);
        return {
          y,
          esq: cols.esq.map(t => t.t).join(''),
          dir: cols.dir.map(t => t.t).join(''),
        };
      });
  });
}

// ── Extração com controle de folhas ──────────────────────────────────────────

async function extrairLinhas(buffer) {
  const folhasVistas = new Set();
  const todasLinhas  = [];

  await pdfParse(buffer, {
    pagerender: function (pageData) {
      return coletarLinhas(pageData).then(function (linhas) {
        let numFolha = null;
        for (const l of linhas) {
          const m = RE_FOLHA.exec(l.esq + l.dir);
          if (m) { numFolha = m[1]; break; }
        }
        const id = numFolha ?? ('_' + Date.now() + '_' + Math.random());
        if (!folhasVistas.has(id)) {
          folhasVistas.add(id);
          todasLinhas.push(...linhas);
        }
        return linhas.map(l => l.esq + l.dir).join('\n');
      });
    },
  });

  return todasLinhas;
}

// ── Extração de lote+validade de uma string ──────────────────────────────────
//
// Recebe o texto completo da linha (esq + dir) e retorna:
// { lote, validade, descFim }
// descFim = índice onde a descrição termina (antes do lote)

function extrairLoteValidade(esq, dir) {
  // --- CASO A/C: lote no token dir ---
  // dir começa com dígitos (lote inteiro ou final do lote cortado)
  const dirTrim = dir.trim();
  if (dirTrim) {
    // Remove valores monetários para limpar
    const dirLimpo = dirTrim.replace(RE_MONEY, '').trim();
    const partes   = dirLimpo.split(/\s+/).filter(Boolean);

    if (partes.length) {
      const p0 = partes[0];

      // Lote inteiro no dir
      if (RE_LOTE_ONE.test(p0)) {
        const validade = (partes[1] && RE_MM_AA.test(partes[1])) ? partes[1] : '';
        // Sufixo a remover do esq: nenhum (lote está no dir)
        return { lote: p0, validade, sufixoEsq: '' };
      }

      // Lote cortado: sufixo numérico do esq + p0
      const mSuf = esq.match(/(\d{1,7})\s*$/);
      if (mSuf) {
        const candidato = mSuf[1] + p0;
        if (RE_LOTE_ONE.test(candidato)) {
          const validade = (partes[1] && RE_MM_AA.test(partes[1])) ? partes[1] : '';
          return { lote: candidato, validade, sufixoEsq: mSuf[1] };
        }
      }

      // Token(s) de descrição "vazaram" para o dir (ex: "ML", "KG" antes do lote).
      // Procura o primeiro elemento de partes[] que seja um lote válido.
      for (let idx = 1; idx < partes.length; idx++) {
        if (RE_LOTE_ONE.test(partes[idx])) {
          const validade = (partes[idx + 1] && RE_MM_AA.test(partes[idx + 1])) ? partes[idx + 1] : '';
          // Tokens antes do lote (idx) são fragmentos de descrição que vazaram p/ dir
          const descSufixoDir = partes.slice(0, idx).join(' ');
          return { lote: partes[idx], validade, sufixoEsq: '', descSufixoDir };
        }
      }
    }
  }

  // --- CASO B: lote embutido no esq (linha longa num único token) ---
  // Procura padrão "LOTE    MM/AA" dentro do texto do esq
  const RE_LOTE_VAL_ESQ = /(\d[A-Z0-9]{5,7}[A-Z]?)\s+(\d{2}\/\d{2})/i;
  const mLV = RE_LOTE_VAL_ESQ.exec(esq);
  if (mLV) {
    return { lote: mLV[1], validade: mLV[2], sufixoEsq: mLV[1] }; // sufixo = o próprio lote
  }

  // --- Sem lote ---
  const mVal = RE_MM_AA.exec(dir || esq);
  return { lote: '', validade: mVal ? mVal[1] : '', sufixoEsq: '' };
}

// ── Limpa a descrição ─────────────────────────────────────────────────────────

function limparDesc(desc) {
  return desc
    .replace(/\s+/g, ' ')
    .replace(/\b(.{2,30})\s+\1\b/g, '$1')  // "KG KG" → "KG"
    .replace(/\s+[\d,]+\s*$/, '')           // remove número solto no fim
    .trim();
}

// ── Extração do cabeçalho ─────────────────────────────────────────────────────

function extrairCabecalho(linhas) {
  const txt = linhas.map(l => l.esq + ' ' + l.dir).join('\n');
  const m   = (pat) => { const r = new RegExp(pat, 'i').exec(txt); return r ? r[1].trim() : ''; };
  return {
    pedido:         m('Pedido de Venda\\s*[-–]\\s*(\\d+)'),
    data_emissao:   m('Data Emiss[aã]o\\s*:\\s*(\\d{2}/\\d{2}/\\d{4})'),
    cliente:        m('Cliente\\s*:\\s*(.+?)\\s*\\(\\d'),
    cnpj:           m('CNPJ/CPF\\s*:\\s*([\\d./\\-]+)'),
    representante:  m('Repres\\.\\s*:\\s*\\w+\\s*-\\s*(.+?)(?:\\s{2,}|\\n|$)'),
    tipo_frete:     m('Tipo Frete\\s*:\\s*(\\w+)'),
    cond_pgt:       m('Cond\\.Pgt\\.\\s*:\\s*\\d+\\s*-\\s*(\\d[\\d/]+)'),
    volume:         m('Volume\\s*:\\s*(\\d+\\s*VOLUMES?)'),
    transportadora: m('Transp\\.\\s*:\\s*(.+?)(?:\\s{3,}|\\n|$)'),
  };
}

// ── Extração de produtos ──────────────────────────────────────────────────────

function extrairProdutos(linhas) {
  const raw = [];
  let i     = 0;

  while (i < linhas.length) {
    const { esq, dir } = linhas[i];
    i++;

    const lEsq = esq.trimStart();
    if (!lEsq || RE_IGNORA.test(lEsq)) continue;

    // ── FORMATO D: linha inteira num único token (PDF via browser, ex: GNT) ──
    // A linha tem tudo junto: qtde  COD  descricao  lote  validade  vl.un  v.total
    const mComp = RE_LINHA_COMPLETA.exec(lEsq);
    if (mComp && !dir.trim()) {
      raw.push({
        qtde:      parseInt(mComp[1], 10),
        cod:       mComp[2].toUpperCase(),
        descricao: limparDesc(mComp[3]),
        lote:      mComp[4],
        validade:  mComp[5],
      });
      continue;
    }

    const mProd = RE_PROD_ESQ.exec(lEsq);
    if (!mProd) continue;

    const [, qtdeStr, cod, restoEsq] = mProd;
    const { lote, validade, sufixoEsq, descSufixoDir } = extrairLoteValidade(restoEsq, dir);

    // Remove o sufixo do lote que ficou grudado no fim da descrição
    let descRaw = restoEsq;
    if (sufixoEsq) {
      const pos = descRaw.lastIndexOf(sufixoEsq);
      if (pos >= 0) descRaw = descRaw.slice(0, pos);
    }
    if (descSufixoDir) {
      descRaw += ' ' + descSufixoDir;
    }

    // ── Absorve linhas de continuação (descrição quebrada em linha seguinte) ──
    while (i < linhas.length) {
      const next    = linhas[i];
      const nextEsq = next.esq.trimStart();
      if (!nextEsq) break;
      if (RE_PROD_ESQ.test(nextEsq)) break;
      if (RE_IGNORA.test(nextEsq)) break;
      const mCont = RE_CONT_IND.exec(next.esq);
      if (mCont) { descRaw += ' ' + mCont[1].trim(); i++; continue; }
      break;
    }

    raw.push({
      qtde:      parseInt(qtdeStr, 10),
      cod:       cod.toUpperCase(),
      descricao: limparDesc(descRaw),
      lote,
      validade,
    });
  }

  // ── Agrupa por código (mesmo SKU, lotes diferentes) ──────────────────────
  const grupos = new Map();
  for (const p of raw) {
    if (!grupos.has(p.cod)) grupos.set(p.cod, { qtde: 0, lotes: [], validades: [], descricao: '' });
    const g = grupos.get(p.cod);
    g.qtde += p.qtde;
    if (p.descricao.length > g.descricao.length) g.descricao = p.descricao;
    if (p.lote     && !g.lotes.includes(p.lote))        g.lotes.push(p.lote);
    if (p.validade && !g.validades.includes(p.validade)) g.validades.push(p.validade);
  }

  return [...grupos.entries()].map(([cod, d]) => ({
    cod,
    descricao: d.descricao,
    lote:      d.lotes.join(' / '),
    validade:  d.validades.join(' / '),
    qtde:      d.qtde,
  }));
}

// ── Função principal exportada ────────────────────────────────────────────────

async function lerPdf(buffer) {
  const linhas   = await extrairLinhas(buffer);
  return { cab: extrairCabecalho(linhas), produtos: extrairProdutos(linhas) };
}

module.exports = { lerPdf };

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const fs = require('fs');
  const a  = process.argv[2];
  if (!a) { console.error('Uso: node parsePdf.js <arquivo.pdf>'); process.exit(1); }
  lerPdf(fs.readFileSync(a))
    .then(r  => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error(e.message); process.exit(1); });
}



