const { list, del } = require('@vercel/blob');

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || 'vercel_blob_rw_XeCDHbJl1hpJh7WK_XUQ0FcVLIMA74HgSpO1FrJH1IfhqnW';

module.exports = async function handler(req, res) {

  // DELETE — excluir pedido
  if (req.method === 'DELETE') {
    const { pedido } = req.query;
    if (!pedido) return res.status(400).json({ error: 'Pedido obrigatorio' });
    try {
      const { blobs: xlsx } = await list({ prefix: `Conferencia_${pedido}.xlsx`, token: BLOB_TOKEN });
      const { blobs: meta } = await list({ prefix: `meta_${pedido}.json`, token: BLOB_TOKEN });
      for (const b of [...xlsx, ...meta]) await del(b.url, { token: BLOB_TOKEN });
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // GET — listar
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const { blobs } = await list({ prefix: 'meta_', token: BLOB_TOKEN });

    const arquivos = await Promise.all(blobs.map(async (b) => {
      try {
        const resp = await fetch(b.url);
        const meta = await resp.json();
        return {
          ...meta,
          data: new Date(meta.criadoEm).toLocaleDateString('pt-BR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
          })
        };
      } catch {
        return null;
      }
    }));

    const resultado = arquivos
      .filter(Boolean)
      .sort((a, b) => new Date(b.criadoEm) - new Date(a.criadoEm));

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json(resultado);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
