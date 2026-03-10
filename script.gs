// --- CONFIGURAÇÕES DO AMBIENTE ---
const SPREADSHEET_ID = "PLANILHA_ID";
const RD_TOKEN       = "TOKEN_RD"; 

const RD_ID_ETAPA_PPV = "ID_DA_ETAPA_NO_CRM"; 
const RD_ID_CAMPO_TAG = "ID_DO_CAMPO_CUSTOMIZADO"; 

const IDS_DIGISAC = {
  data_manual: "ID_CAMPO_DATA",
  origem:      "ID_CAMPO_ORIGEM",
  anuncio:     "ID_CAMPO_ANUNCIO",
  status:      "ID_CAMPO_STATUS",
  modelo:      "ID_CAMPO_MODELO",
  vendedor:    "ID_CAMPO_VENDEDOR"
};

const NOMES_MESES = ["JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO"];

// Recebe os dados do Webhook (vindo do Cloudflare ou Digisac)
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); 

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const log = ss.getSheetByName("LOGS_SCRIPT") || ss.insertSheet("LOGS_SCRIPT");
    const contents = JSON.parse(e.postData.contents);
    
    // Filtro para logs de depuração
    if (contents.debug_worker) {
      log.appendRow([new Date(), "INFO_WORKER", contents.motivo, contents.cliente]);
      return ContentService.createTextOutput("OK");
    }

    const campos = contents.customFieldValues || [];
    const getV = (id) => (campos.find(f => f.customFieldId === id) || {}).value || "";
    
    // Tratamento de telefone para padrão internacional
    let numRaw = contents.data ? contents.data.number : (contents.number || "");
    let telLimpo = String(numRaw).replace(/\D/g, "");
    if (telLimpo.length >= 10 && telLimpo.length <= 11) telLimpo = "55" + telLimpo;

    const nomeInterno = contents.internalName || (contents.data && contents.data.internalName);
    const nomeRaiz = contents.name || (contents.data && contents.data.name) || "Sem Nome";
    
    const dados = {
      nome: nomeInterno || nomeRaiz,
      telefone: telLimpo,
      status: getV(IDS_DIGISAC.status),
      anuncio: getV(IDS_DIGISAC.anuncio),
      dataManual: getV(IDS_DIGISAC.data_manual),
      origem: getV(IDS_DIGISAC.origem),
      vendedor: getV(IDS_DIGISAC.vendedor),
      modelo: getV(IDS_DIGISAC.modelo)
    };

    // Define a data alvo (prioriza data manual se houver)
    let dataAlvo = new Date();
    if (dados.dataManual) {
      let ds = String(dados.dataManual);
      if (ds.length === 10) ds += "T12:00:00"; 
      dataAlvo = new Date(ds); 
    }
    
    // Atualiza a planilha e verifica duplicidade
    const jaSincronizado = atualizarPlanilha(ss, dataAlvo, dados);
    SpreadsheetApp.flush(); 

    // Dispara para o CRM apenas leads novos com status específico
    const statusTrigger = String(dados.status).toUpperCase().trim();
    if (statusTrigger === "AGUARDANDO ATENDIMENTO" && jaSincronizado !== "SINCRO") {
       enviarParaRD(dados, log, ss, dataAlvo);
    }

    return ContentService.createTextOutput("Sucesso");
  } catch (err) {
    console.error("Erro no processamento:", err);
    return ContentService.createTextOutput("Erro");
  } finally {
    lock.releaseLock();
  }
}

function atualizarPlanilha(ss, dataAlvo, dados) {
  const nomeAba = NOMES_MESES[dataAlvo.getMonth()];
  const sheet = ss.getSheetByName(nomeAba) || ss.getSheets()[0];
  
  const valoresA = sheet.getRange("A:A").getValues();
  let proxLinha = 1;
  while (valoresA[proxLinha - 1] && valoresA[proxLinha - 1][0] !== "" && proxLinha < 5000) {
    proxLinha++;
  }

  let linhaExistente = -1;
  let valorSincro = "";
  
  if (proxLinha > 1) {
    const vals = sheet.getRange(1, 3, proxLinha, 7).getValues(); 
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).replace(/\D/g, "") === dados.telefone) { 
        linhaExistente = i + 1; 
        valorSincro = vals[i][6]; 
        break; 
      }
    }
  }

  const linhaDados = [dataAlvo, dados.nome, dados.telefone, dados.origem, dados.anuncio, dados.vendedor, dados.modelo, dados.status];
  
  if (linhaExistente > 0) {
    sheet.getRange(linhaExistente, 1, 1, 8).setValues([linhaDados]);
  } else {
    sheet.getRange(proxLinha, 1, 1, 8).setValues([linhaDados]);
  }
  return valorSincro;
}

function marcarSincro(ss, dataAlvo, telefone) {
  const nomeAba = NOMES_MESES[dataAlvo.getMonth()];
  const sheet = ss.getSheetByName(nomeAba) || ss.getSheets()[0];
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const vals = sheet.getRange(1, 3, lastRow, 1).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).replace(/\D/g, "") === telefone) {
        sheet.getRange(i + 1, 9).setValue("SINCRO");
        break;
      }
    }
  }
}

function enviarParaRD(dados, log, ss, dataAlvo) {
  if (possuiNegociacaoAtiva(dados.telefone)) {
    marcarSincro(ss, dataAlvo, dados.telefone); 
    log.appendRow([new Date(), "CRM_INFO", "Lead já possui negociação ativa", dados.nome]);
    return;
  }

  const url = "https://crm.rdstation.com/api/v1/deals?token=" + RD_TOKEN;
  const payload = {
    "deal": {
      "name": dados.nome,
      "deal_stage_id": RD_ID_ETAPA_PPV,
      "deal_custom_fields": [{ "custom_field_id": RD_ID_CAMPO_TAG, "value": dados.anuncio }]
    },
    "contacts": [{ "name": dados.nome, "phones": [{ "phone": dados.telefone, "type": "cellphone" }] }]
  };

  const res = UrlFetchApp.fetch(url, {
    "method": "POST", "contentType": "application/json",
    "payload": JSON.stringify(payload), "muteHttpExceptions": true
  });

  if (res.getResponseCode() == 200 || res.getResponseCode() == 201) {
    marcarSincro(ss, dataAlvo, dados.telefone);
    log.appendRow([new Date(), "CRM_OK", "Sincronizado com sucesso", dados.nome]);
  } else {
    log.appendRow([new Date(), "CRM_ERRO", "Falha na sincronização: " + res.getResponseCode(), dados.nome]);
  }
}

function possuiNegociacaoAtiva(telefone) {
  try {
    const url = "https://crm.rdstation.com/api/v1/contacts?token=" + RD_TOKEN + "&phone=" + telefone;
    const res = UrlFetchApp.fetch(url, { "muteHttpExceptions": true });
    const json = JSON.parse(res.getContentText());
    
    if (json.contacts && json.contacts.length > 0 && json.contacts[0].deals && json.contacts[0].deals.length > 0) return true;

    if (telefone.startsWith("55")) {
      const telSem55 = telefone.substring(2);
      const url2 = "https://crm.rdstation.com/api/v1/contacts?token=" + RD_TOKEN + "&phone=" + telSem55;
      const res2 = UrlFetchApp.fetch(url2, { "muteHttpExceptions": true });
      const json2 = JSON.parse(res2.getContentText());
      if (json2.contacts && json2.contacts.length > 0 && json2.contacts[0].deals && json2.contacts[0].deals.length > 0) return true;
    }
    return false;
  } catch (e) { return false; }
}
