/**
 * parsePdf.js — Parser de pedidos TOTVS/SIGA v2.0
 *
 * Dependência: pdf-parse (já no package.json)
 *
 * Formatos suportados:
 *   FORMA A — descrição curta (lote no token dir, x≈351)
 *   FORMA B — linha longa (tudo num token, x=16)
 *   FORMA C — lote cortado entre dois tokens (256039, x_dir≈364)
 *   FORMA D — PDF via browser/GNT (linha única com tudo junto, x≈50)
 *
 * Comportamentos tratados:
 *   - Deduplicação por (x, y, texto) — elimina renderização dupla do TOTVS
 *   - Continuações de descrição (KG, GR, "NADE - 909 GR", letra única "R")
 *   - Lotes com letras no meio/fim (262803A, 2607073B)
 *   - Mesmo SKU com múltiplos lotes → qtde somada, lotes concatenados
 *   - Tokens de unidade (ML, KG, GR) que "vazam" para o token dir antes do lote
 *   - Produtos sem lote/validade (ex: PN8182)
 */

'use strict';

const pdfParse = require('pdf-parse');

// ── Constantes ────────────────────────────────────────────────────────────────
const X_DIR = 300; // Limiar esq/dir — funciona p/ 256297 (x=351) e 256039 (x=364)

// ── Regex ─────────────────────────────────────────────────────────────────────
const RE_FOLHA        = /Folha\.+\s*(\d+)/;
// Código: letras seguidas de dígitos (PN8092, GNT8762, etc.)
const RE_PROD_ESQ     = /^\s*(\d+)\s+([A-Z]{2,4}\d\w*)\s+(.*?)$/i;
// Continuação: ≥8 espaços à esquerda E sem código de produto
const RE_CONT_IND     = /^\s{8,}(\S.*)$/;
// Lote válido: começa com dígito, 6–8 chars alfanuméricos, pode terminar em 1–2 letras
const RE_LOTE_ONE     = /^\d[A-Z0-9]{5,7}[A-Z]{0,2}$/i;
// Lote + validade embutidos num único token (Formato B)
const RE_LOTE_VAL_ESQ = /(\d[A-Z0-9]{5,7}[A-Z]{0,2})\s+(\d{2}\/\d{2})/i;
// Data de validade MM/AA
const RE_MM_AA        = /\b(\d{2}\/\d{2})\b/;
// Valores monetários a remover antes de parsear o dir
const RE_MONEY        = /\b\d{1,3}(?:\.\d{3})*,\d{2}\b|\*+,\*+/g;
// Formato D (PDF via browser): tudo em um único token
// qtde  COD  descrição  lote  validade  vl.un  v.total
const RE_LINHA_COMPLETA = /^\s*(\d+)\s+([A-Z]{2,4}\d\w*)\s+(.*?)\s{2,}(\d[A-Z0-9]{5,7}[A-Z]{0,2})\s+(\d{2}\/\d{2})\s+[\d.,]+\s+[\d.,*]+\s*$/i;
// Linhas a ignorar (cabeçalho, rodapé, separadores, totais)
const RE_IGNORA       = /^[-_]{5,}|^Qtde\s|^Folha|^SIGA\s|^Hora|^Data\s|^Cliente\s|^Endere|^Tipo\s|^CNPJ|^Repres|^Volume\s|^Nat\.|^Frete|^\d+o\s+Vencto|^Transp\.|^Ender\.|^NUM\.CXA|^SEPARADO|^EMBALADO|^CONFERIDO|^FINANCEIRO|^\d{3,}\s+[\d.,]/;

// ── Coleta de tokens por página ───────────────────────────────────────────────

/**
 * Agrupa tokens XY da página em linhas lógicas { y, esq, dir }.
 * Deduplicação por chave (x, y, texto) — elimina renderização dupla do TOTVS.
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

      // Tolera ±3pt de variação no Y para agrupar na mesma linha lógica
      let ky = null;
      for (const [k] of map) { if (Math.abs(k - y) <= 3) { ky = k; break; } }
      if (ky === null) { ky = y; map.set(ky, { esq: [], dir: [] }); }

      if (x >= X_DIR) map.get(ky).dir.push({ x, t: item.str });
      else            map.get(ky).esq.push({ x, t: item.str });
    }

    return [...map.entries()]
      .sort((a, b) => b[0] - a[0])  // Y decrescente = top→bottom
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

// ── Extração com deduplicação de folhas ───────────────────────────────────────

async function extrairLinhas(buffer) {
  const folhasVistas = new Set();
  const todasLinhas  = [];

  await pdfParse(buffer, {
    pagerender: function (pageData) {
      return coletarLinhas(pageData).then(function (linhas) {
        // Detecta número de folha para evitar duplicação
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

// ── Extração de lote + validade ───────────────────────────────────────────────
//
// Recebe esq (token esquerdo) e dir (token direito) de uma linha de produto.
// Retorna { lote, validade, sufixoEsq, descSufixoDir }
//   - sufixoEsq:    trecho a remover do fim da descrição (lote que ficou no esq)
//   - descSufixoDir: tokens do dir que são na verdade descrição (ML, KG, GR...)

function extrairLoteValidade(esq, dir) {
  const dirTrim = dir.trim();

  // ── CASO A / C: há algo no token dir ──
  if (dirTrim) {
    const dirLimpo = dirTrim.replace(RE_MONEY, '').trim();
    const partes   = dirLimpo.split(/\s+/).filter(Boolean);

    if (partes.length) {
      const p0 = partes[0];

      // Caso A: lote inteiro no início do dir
      if (RE_LOTE_ONE.test(p0)) {
        const validade = (partes[1] && RE_MM_AA.test(partes[1])) ? partes[1] : '';
        return { lote: p0, validade, sufixoEsq: '', descSufixoDir: '' };
      }

      // Caso C: lote cortado — sufixo numérico do esq + início do dir
      const mSuf = esq.match(/(\d{1,7})\s*$/);
      if (mSuf) {
        const candidato = mSuf[1] + p0;
        if (RE_LOTE_ONE.test(candidato)) {
          const validade = (partes[1] && RE_MM_AA.test(partes[1])) ? partes[1] : '';
          return { lote: candidato, validade, sufixoEsq: mSuf[1], descSufixoDir: '' };
        }
      }

      // Caso "vazamento": tokens de unidade (ML, KG, GR...) vieram antes do lote no dir.
      // Varre partes[] até achar o primeiro lote válido.
      for (let idx = 1; idx < partes.length; idx++) {
        if (RE_LOTE_ONE.test(partes[idx])) {
          const validade     = (partes[idx + 1] && RE_MM_AA.test(partes[idx + 1])) ? partes[idx + 1] : '';
          const descSufixoDir = partes.slice(0, idx).join(' ');
          return { lote: partes[idx], validade, sufixoEsq: '', descSufixoDir };
        }
      }
    }
  }

  // ── CASO B: lote embutido no esq (linha longa num único token) ──
  const mLV = RE_LOTE_VAL_ESQ.exec(esq);
  if (mLV) {
    return { lote: mLV[1], validade: mLV[2], sufixoEsq: mLV[1], descSufixoDir: '' };
  }

  // ── Sem lote ──
  const mVal = RE_MM_AA.exec(dir || esq);
  return { lote: '', validade: mVal ? mVal[1] : '', sufixoEsq: '', descSufixoDir: '' };
}

// ── Limpeza da descrição ──────────────────────────────────────────────────────

function limparDesc(desc) {
  return desc
    .replace(/\s+/g, ' ')
    .replace(/\b(.{2,30})\s+\1\b/g, '$1')  // remove duplicação "KG KG" → "KG"
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
    endereco:       m('Endere[cç]o\\s*:\\s*(.+?)(?:\\s{2,}|\\n|$)'),
    cnpj:           m('CNPJ/CPF\\s*:\\s*([\\d./\\-]+)'),
    representante:  m('Repres\\.\\s*:\\s*\\w+\\s*-\\s*(.+?)(?:\\s{2,}|\\n|$)'),
    tipo_frete:     m('Tipo Frete\\s*:\\s*(\\w+)'),
    cond_pgt:       m('Cond\\.Pgt\\.\\s*:\\s*\\d+\\s*-\\s*(\\d[\\d/]+)'),
    volume:         m('Volume\\s*:\\s*(\\d+)'),
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

    // ── FORMATO D: linha única completa (PDF GNT/browser) ──
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

    // ── FORMATOS A / B / C ──
    const mProd = RE_PROD_ESQ.exec(lEsq);
    if (!mProd) continue;

    const [, qtdeStr, cod, restoEsq] = mProd;
    const { lote, validade, sufixoEsq, descSufixoDir } = extrairLoteValidade(restoEsq, dir);

    // Remove sufixo do lote que ficou colado no fim da descrição
    let descRaw = restoEsq;
    if (sufixoEsq) {
      const pos = descRaw.lastIndexOf(sufixoEsq);
      if (pos >= 0) descRaw = descRaw.slice(0, pos);
    }
    // Reanexa tokens de descrição que "vazaram" para o dir (ML, KG, GR...)
    if (descSufixoDir) {
      descRaw += ' ' + descSufixoDir;
    }

    // ── Absorve continuações de descrição (linhas seguintes indentadas) ──
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
    if (!grupos.has(p.cod)) {
      grupos.set(p.cod, { qtde: 0, lotes: [], validades: [], descricao: '' });
    }
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
  const linhas = await extrairLinhas(buffer);
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
