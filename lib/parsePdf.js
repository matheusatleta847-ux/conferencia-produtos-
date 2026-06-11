const pdfParse = require('pdf-parse');

const X_DIR = 300;

function coletarLinhas(pageData) {
  const tokensVistos = new Set();
  const linhasMap = new Map();

  return pageData.getTextContent().then((textContent) => {
    for (const item of textContent.items) {
      const x = Math.round(item.transform[4]);
      const y = Math.round(item.transform[5]);
      const texto = item.str.trim();

      if (!texto) continue;

      const tokenKey = `${x}_${y}_${texto}`;
      if (tokensVistos.has(tokenKey)) continue;
      tokensVistos.add(tokenKey);

      let yChave = y;
      for (const k of linhasMap.keys()) {
        if (Math.abs(k - y) <= 3) {
          yChave = k;
          break;
        }
      }

      if (!linhasMap.has(yChave)) {
        linhasMap.set(yChave, { esq: [], dir: [] });
      }

      const tokenObj = { x, y, texto };
      if (x < X_DIR) {
        linhasMap.get(yChave).esq.push(tokenObj);
      } else {
        linhasMap.get(yChave).dir.push(tokenObj);
      }
    }

    for (const [y, linha] of linhasMap) {
      linha.esq.sort((a, b) => a.x - b.x);
      linha.dir.sort((a, b) => a.x - b.x);
    }

    // Ordena do topo para o fim da página (Y decrescente no PDF padrão)
    return Array.from(linhasMap.entries())
      .sort((a, b) => b[0] - a[0])
      .map(entry => entry[1]);
  });
}

function extrairLoteValidade(esqTokens, dirTokens) {
  let textoEsq = esqTokens.map(t => t.texto).join(" ");
  let lote = "";
  let validade = "";
  let sufixoDescricao = "";

  if (dirTokens.length > 0) {
    let idxLote = 0;
    
    // CORREÇÃO GNT: Varre e recupera sufixos de descrição perdidos na coluna direita
    while (idxLote < dirTokens.length) {
      const txt = dirTokens[idxLote].texto;
      if (/^\d{5,8}/.test(txt) || /\d{2}\/\d{2}/.test(txt)) break;
      sufixoDescricao += " " + txt;
      idxLote++;
    }

    const tokensDadosDir = dirTokens.slice(idxLote);
    const textoDir = tokensDadosDir.map(t => t.texto).join(" ").trim();

    if (/^\d{6,8}/.test(textoDir)) {
      const match = textoDir.match(/^([A-Z0-9]+)\s+(\d{2}\/\d{2})/i);
      if (match) {
        lote = match[1];
        validade = match[2];
      }
    } else if (tokensDadosDir.length > 0 && /^\d{1,5}/.test(textoDir)) {
      const matchEsq = textoEsq.match(/(\d+)$/);
      const matchDir = textoDir.match(/^(\d+)\s+(\d{2}\/\d{2})/);
      
      if (matchEsq && matchDir) {
        lote = matchEsq[1] + matchDir[1];
        validade = matchDir[2];
        textoEsq = textoEsq.replace(/(\d+)$/, "").trim();
      }
    }
  } 
  
  if (!lote) {
    const matchB = textoEsq.match(/([A-Z0-9]{5,8})\s+(\d{2}\/\d{2})/i);
    if (matchB) {
      lote = matchB[1];
      validade = matchB[2];
      textoEsq = textoEsq.replace(matchB[0], "").trim();
    }
  }

  return { lote, validade, textoEsq, sufixoDescricao };
}

async function lerPdf(buffer) {
  const todasLinhas = [];

  await pdfParse(buffer, {
    pagerender: async (pageData) => {
      const linhasPagina = await coletarLinhas(pageData);
      
      // Ignora página se já processada (Evita duplicidade TOTVS)
      const isDuplicada = linhasPagina.some(l => 
        l.esq.some(t => t.texto.includes("Folha.. Ne")) && 
        todasLinhas.some(tl => tl.esq.some(tt => tt.texto === t.texto))
      );

      if (!isDuplicada) {
        todasLinhas.push(...linhasPagina);
      }
      return ""; // Retorno vazio pois usamos apenas dados do pagerender
    }
  });

  const produtosRaw = [];
  
  for (const linha of todasLinhas) {
    const { esq, dir } = linha;
    if (esq.length === 0) continue;

    const textoCompletoEsq = esq.map(t => t.texto).join(" ");
    const ehContinuacao = !/PN\d{4}/i.test(textoCompletoEsq) && esq[0].x >= 25;

    if (ehContinuacao && produtosRaw.length > 0) {
      const ultimoProd = produtosRaw[produtosRaw.length - 1];
      ultimoProd.descricao += " " + textoCompletoEsq;
      continue;
    }

    const matchProd = textoCompletoEsq.match(/^(\d+)\s+(PN\d{4})\s+(.*)/i);
    if (matchProd) {
      const qtd = parseInt(matchProd[1], 10);
      const sku = matchProd[2];
      const descParcial = matchProd[3];

      const { lote, validade, sufixoDescricao } = extrairLoteValidade(esq, dir);
      
      produtosRaw.push({
        codigo: sku,
        descricao: (descParcial + sufixoDescricao).replace(/\s+/g, " ").trim(),
        quantidade: qtd,
        lote: lote || "VAZIO",
        validade: validade || "VAZIO"
      });
    }
  }

  const produtosAgrupados = new Map();
  for (const p of produtosRaw) {
    if (produtosAgrupados.has(p.codigo)) {
      const existente = produtosAgrupados.get(p.codigo);
      existente.quantidade += p.quantidade;
      if (p.lote !== "VAZIO" && !existente.lotes.includes(p.lote)) {
        existente.lotes.push(p.lote);
      }
    } else {
      produtosAgrupados.set(p.codigo, {
        codigo: p.codigo,
        descricao: p.descricao,
        quantidade: p.quantidade,
        lotes: p.lote !== "VAZIO" ? [p.lote] : [],
        validade: p.validade
      });
    }
  }

  const produtosFormatados = Array.from(produtosAgrupados.values()).map(p => ({
    ...p,
    lote: p.lotes.length > 0 ? p.lotes.join(" / ") : "VAZIO"
  }));

  return { produtos: produtosFormatados };
}

module.exports = lerPdf;

