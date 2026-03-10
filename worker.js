const CONFIG = {
  GAS_URL: "URL_DO_SEU_GOOGLE_APPS_SCRIPT",
  API_TOKEN: "TOKEN_DIGISAC",
  API_BASE_URL: "https://sua-instancia.digisac.me/api/v1/contacts/",

  TAGS_VALIDAS: [
    "ID_TAG_01",
    "ID_TAG_02",
    "ID_TAG_03"
  ],
  CAMPOS: {
    origem: "ID_CAMPO_ORIGEM",
    anuncio: "ID_CAMPO_ANUNCIO"
  }
};

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("OK", { status: 200 });

    try {
      const payload = await request.json();

      // Ignora mensagens vindas de grupos
      const isGroup = payload.isGroup || payload.data?.isGroup || false;
      if (isGroup) return new Response("Ignorado: Grupo", { status: 200 });

      const contactId = payload.data?.id || payload.id;
      if (!contactId) return new Response("ID não localizado", { status: 200 });

      // Delay para garantir que o Digisac processou os dados customizados
      await new Promise(resolve => setTimeout(resolve, 2000));

      const apiUrl = `${CONFIG.API_BASE_URL}${contactId}?include[]=tags&include[]=customFieldValues`;
      const response = await fetch(apiUrl, {
        method: "GET",
        headers: { "Authorization": `Bearer ${CONFIG.API_TOKEN}` }
      });

      const contactData = await response.json();

      // Validação de Tags e Campos Obrigatórios
      const tags = contactData.tags || [];
      const temTagValida = tags.some(t => CONFIG.TAGS_VALIDAS.includes(t.id));
      
      const campos = contactData.customFieldValues || [];
      const vOrigem = (campos.find(c => c.customFieldId === CONFIG.CAMPOS.origem) || {}).value;
      const vAnuncio = (campos.find(c => c.customFieldId === CONFIG.CAMPOS.anuncio) || {}).value;

      if (!temTagValida || !vOrigem || !vAnuncio) {
        ctx.waitUntil(fetch(CONFIG.GAS_URL, {
          method: "POST", 
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            debug_worker: true, 
            motivo: `Critérios não atendidos (Origem: ${vOrigem ? 'OK' : 'Vazio'} | Anúncio: ${vAnuncio ? 'OK' : 'Vazio'})`, 
            cliente: contactData.name 
          })
        }));
        return new Response("Filtro: Lead incompleto", { status: 200 });
      }

      // Encaminha lead validado para o Google Apps Script
      ctx.waitUntil(fetch(CONFIG.GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(contactData)
      }));

      return new Response("OK: Lead encaminhado", { status: 200 });
    } catch (err) { 
      return new Response("Erro interno", { status: 200 }); 
    }
  }
};