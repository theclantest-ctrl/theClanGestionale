/**
 * GESTIONALE SERVICE - disponibilità, assegnazioni, convocazioni, materiale per evento, magazzino,
 * furgoni con liste di carico e scarico, spese da rimborsare, entrate e uscite di magazzino, riparazioni
 *
 * Archivio dati: questo Foglio Google.
 * Interfaccia: applicazione web (Esegui il deployment > Nuovo deployment > App web).
 * Questo è l'unico file da incollare in Apps Script: la pagina (HTML) è in fondo, nella costante INDEX_HTML.
 *
 * Tre viste, scelte dal link:
 *   .../exec           -> coordinatore (chiede il codice scritto nella scheda Config)
 *   .../exec?t=TOKEN   -> pagina personale del tecnico (disponibilità + convocazioni + cosa si monta)
 *   .../exec?c=TOKEN   -> scheda di una convocazione: evento, fase, materiale, conferma con un tocco
 *
 * Le funzioni il cui nome finisce con _ sono private: il browser non può chiamarle.
 */

const TZ = 'Europe/Rome';
const ROLES = ['fonico', 'luci', 'video', 'aiutante'];
const STAGES = ['richiesta', 'sopralluogo', 'preventivo', 'confermato', 'concluso', 'annullato'];
const STAGES_PROVVISORIE = ['richiesta', 'sopralluogo', 'preventivo'];   // il cliente non ha ancora accettato
const STAGE_LABEL = { richiesta: 'Richiesta', sopralluogo: 'Sopralluogo', preventivo: 'Preventivo',
  confermato: 'Confermato', concluso: 'Concluso', annullato: 'Annullato' };
const ASG_STATES = ['in attesa', 'confermato', 'rifiutato'];
const TIME_FIELDS = ['orarioArrivo', 'orarioMontaggio', 'orarioPausa', 'orarioInizioEvento',
  'orarioFineEvento', 'orarioSmontaggio'];
const MAX_PIN_FAILS = 5;
const PIN_LOCK_SECONDS = 900;
const MAX_DAYS_AHEAD = 180;
const MAX_QTY = 9999;
const MAX_MONEY = 100000;
const RECENT_DAYS = 30;          // eventi appena passati che il tecnico vede ancora (scarico da fare, spese)
const EXP_CATS = ['carburante', 'pedaggi', 'parcheggio', 'pasti', 'alloggio', 'chilometri', 'noleggio', 'materiale', 'altro'];
const MOV_CAUSE_IN = ['acquisto', 'reso', 'altro'];
const MOV_CAUSE_OUT = ['venduto', 'perso', 'consumato', 'dismesso', 'prestato', 'altro'];
const REP_OPEN = ['da riparare', 'in riparazione'];
const REP_CLOSED = ['riparato', 'non riparabile'];
const LIST_KINDS = ['carico', 'scarico'];

// Colonne attese in ogni scheda. setup() aggiunge quelle mancanti, non ne toglie mai.
const COLS = {
  Config: ['chiave', 'valore', 'note'],
  Tecnici: ['id', 'nome', 'ruoli', 'telefono', 'email', 'note', 'cvLink', 'attivo', 'token'],
  Eventi: ['id', 'cliente', 'data', 'ora', 'luogo', 'stato', 'fonico', 'luci', 'video', 'aiutante',
    'telefonoCliente', 'emailCliente', 'noteSopralluogo', 'fotoLink', 'noteModifiche',
    'preventivoImporto', 'clienteIncassato', 'orarioArrivo', 'orarioMontaggio', 'orarioPausa',
    'orarioInizioEvento', 'orarioFineEvento', 'orarioSmontaggio', 'noteTecnici',
    'statoPrecedente', 'statoNota', 'statoAggiornato', 'materialePrima', 'materialeDopo',
    'caricoQuando', 'caricoChi', 'scaricoQuando', 'scaricoChi'],
  Disponibilita: ['technician_id', 'tecnico', 'data', 'disponibile', 'oraDa'],
  Assegnazioni: ['id', 'event_id', 'evento', 'technician_id', 'tecnico', 'ruoli', 'stato', 'compenso',
    'pagato', 'token', 'calendarEventId', 'calendarRisposta'],
  // Magazzino: un articolo per riga, con la quantità posseduta e quanti pezzi sono fuori uso
  Materiali: ['id', 'nome', 'categoria', 'marca', 'quantita', 'fuoriServizio', 'stato', 'peso_kg',
    'larghezza_mm', 'altezza_mm', 'profondita_mm', 'altezzaInstallazioneMm', 'consumabile', 'note', 'scortaMinima'],
  // Materiale di ogni evento: una riga per articolo e per evento. caricato = pezzi messi sul furgone;
  // scaricato / danneggiato / mancante = come sono rientrati; van_id = su quale furgone va
  Carico: ['id', 'event_id', 'evento', 'equipment_id', 'materiale', 'quantita', 'subnoleggio',
    'caricato', 'scaricato', 'note', 'danneggiato', 'mancante', 'van_id'],
  // Mezzi dell'azienda, e quali furgoni vanno a quale evento (con chi guida)
  Furgoni: ['id', 'nome', 'targa', 'note', 'portata_kg', 'volume_m3', 'attivo'],
  FurgoniEvento: ['id', 'event_id', 'evento', 'van_id', 'furgone', 'autista_id', 'autista'],
  // Guasti: un biglietto per ogni gruppo di pezzi da riparare
  Riparazioni: ['id', 'equipment_id', 'materiale', 'quantita', 'stato', 'difetto', 'aperto', 'apertoDa',
    'event_id', 'evento', 'fornitore', 'previsto', 'costo', 'chiuso', 'nota'],
  // Registro delle entrate e uscite di magazzino (solo aggiunte, mai modifiche)
  Movimenti: ['id', 'quando', 'equipment_id', 'materiale', 'tipo', 'causale', 'delta', 'giacenzaDopo',
    'event_id', 'evento', 'chi', 'nota'],
  // Spese di ogni evento: chi ha pagato, se va rimborsata, se si addebita al cliente
  Spese: ['id', 'event_id', 'evento', 'data', 'categoria', 'descrizione', 'importo', 'pagatoDa',
    'technician_id', 'tecnico', 'rimborsatoIl', 'addebitoCliente', 'km', 'nota', 'creataDa'],
  // Registro dei cambi di stato degli eventi (solo aggiunte, mai modifiche)
  Storico: ['quando', 'event_id', 'evento', 'tipo', 'da', 'a', 'nota'],
};

// Colonne che devono restare testo. Senza, Fogli trasforma "2026-10-24" e "18:30" in date/ore vere,
// "1/2" in una data, "=qualcosa" in una formula e toglie lo zero iniziale da un codice come "0123".
const TEXT_COLS = ['id', 'event_id', 'technician_id', 'token', 'calendarEventId', 'calendarRisposta',
  'data', 'ora', 'oraDa', 'telefono', 'telefonoCliente', 'valore', 'nome', 'ruoli', 'email',
  'note', 'cvLink', 'cliente', 'luogo', 'stato', 'emailCliente', 'noteSopralluogo', 'fotoLink',
  'noteModifiche', 'noteTecnici', 'tecnico', 'evento', 'categoria', 'marca', 'materiale', 'equipment_id',
  'statoPrecedente', 'statoNota', 'statoAggiornato', 'quando', 'tipo', 'da', 'a', 'nota',
  'caricoQuando', 'caricoChi', 'scaricoQuando', 'scaricoChi', 'van_id', 'targa', 'furgone', 'autista_id', 'autista',
  'difetto', 'aperto', 'apertoDa', 'fornitore', 'previsto', 'chiuso', 'causale', 'chi', 'descrizione',
  'pagatoDa', 'rimborsatoIl', 'creataDa'].concat(TIME_FIELDS);
const TIME_COLS = ['ora', 'oraDa'].concat(TIME_FIELDS);
const DATETIME_COLS = ['quando', 'statoAggiornato', 'caricoQuando', 'scaricoQuando'];

// ---------------------------------------------------------------------------
// Ingresso web
// ---------------------------------------------------------------------------

function doGet(e) {
  const p = (e && e.parameter) || {};
  const t = HtmlService.createTemplate(INDEX_HTML);
  if (p.c) { t.mode = 'confirm'; t.token = String(p.c); }
  else if (p.t) { t.mode = 'tech'; t.token = String(p.t); }
  else { t.mode = 'coord'; t.token = ''; }
  return t.evaluate()
    .setTitle('Gestionale service')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Indirizzo da mettere nei link dei tecnici e negli inviti: se in Config c'e' url_pagina (la pagina pubblicata
// fuori da Google, vedi doPost) uso quello, altrimenti l'indirizzo /exec di questa app.
function appUrl_() {
  let u = '';
  try { u = String(config_().url_pagina || '').trim(); } catch (e) { u = ''; }
  if (/^https:\/\/[^\s?#]+$/.test(u)) return u;
  return ScriptApp.getService().getUrl() || '';
}

// ---------------------------------------------------------------------------
// Ingresso "API": la pagina pubblicata fuori da Google (web/index.html) chiama qui con fetch, senza cookie.
// Cosi' non conta quanti account Google ha il telefono: per Google e' una richiesta anonima.
// Corpo: {"fn": "api_...", "args": [...]}. Risposta: {"ok": true, "v": ...} oppure {"ok": false, "e": "messaggio"}.
// Si possono chiamare solo le funzioni api_ elencate qui sotto (setup e le funzioni private no).
// ---------------------------------------------------------------------------

const API_TABLE_ = {
  api_coordInit: api_coordInit,
  api_saveEvent: api_saveEvent,
  api_saveTech: api_saveTech,
  api_assignMany: api_assignMany,
  api_unassign: api_unassign,
  api_setStato: api_setStato,
  api_saveMateriale: api_saveMateriale,
  api_cadd: api_cadd,
  api_cset: api_cset,
  api_cdel: api_cdel,
  api_cclear: api_cclear,
  api_ccopy: api_ccopy,
  api_saveVan: api_saveVan,
  api_vanAssign: api_vanAssign,
  api_vanUnassign: api_vanUnassign,
  api_linesVan: api_linesVan,
  api_listSet: api_listSet,
  api_listAll: api_listAll,
  api_loadClose: api_loadClose,
  api_eventLists: api_eventLists,
  api_unloadPreview: api_unloadPreview,
  api_unloadClose: api_unloadClose,
  api_stockMove: api_stockMove,
  api_inventory: api_inventory,
  api_movList: api_movList,
  api_repOpen: api_repOpen,
  api_repUpdate: api_repUpdate,
  api_repClose: api_repClose,
  api_expSave: api_expSave,
  api_expDel: api_expDel,
  api_expReimburse: api_expReimburse,
  api_techListSet: api_techListSet,
  api_techListAll: api_techListAll,
  api_techLoadClose: api_techLoadClose,
  api_techEventLists: api_techEventLists,
  api_techExpSave: api_techExpSave,
  api_techExpDel: api_techExpDel,
  api_calendarInvite: api_calendarInvite,
  api_syncCalendar: api_syncCalendar,
  api_techInit: api_techInit,
  api_techSetAvailability: api_techSetAvailability,
  api_confirmInit: api_confirmInit,
  api_respond: api_respond
};

function doPost(e) {
  let out;
  try {
    const raw = (e && e.postData && e.postData.contents) || '';
    let req = null;
    try { req = JSON.parse(raw); } catch (err) { req = null; }
    if (!req || typeof req !== 'object') throw new Error('Richiesta non valida.');
    const fn = String(req.fn || '');
    if (!Object.prototype.hasOwnProperty.call(API_TABLE_, fn)) throw new Error('Funzione non trovata: ' + fn);
    const args = Array.isArray(req.args) ? req.args : [];
    const v = API_TABLE_[fn].apply(null, args);
    out = { ok: true, v: v === undefined ? null : v };
  } catch (err) {
    out = { ok: false, e: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Preparazione (da lanciare una volta dall'editor: scegli "setup" nel menu a tendina > Esegui)
// ---------------------------------------------------------------------------

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  ss.setSpreadsheetTimeZone(TZ);
  Object.keys(COLS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const header = sh.getLastColumn() > 0
      ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
    const missing = COLS[name].filter(function (col) { return header.indexOf(col) < 0; });
    if (missing.length) {
      // Una scheda nuova ha 26 colonne (A-Z): se ne servono di più vanno aggiunte, altrimenti Fogli dà errore
      const need = header.length + missing.length;
      if (sh.getMaxColumns() < need) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
      sh.getRange(1, header.length + 1, 1, missing.length).setValues([missing]);
      missing.forEach(function (col) { header.push(col); });
    }
    header.forEach(function (h, i) {
      if (TEXT_COLS.indexOf(h) >= 0) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  });
  ['Tecnici', 'Eventi', 'Assegnazioni', 'Materiali', 'Carico', 'Furgoni', 'FurgoniEvento', 'Riparazioni', 'Spese']
    .forEach(function (n) { fixRows_(table_(n)); });
  ensureConfig_();
  Logger.log('Setup completato. Se è la prima volta: Esegui il deployment > Nuovo deployment > App web. ' +
    "Se stai aggiornando l'app: Gestisci i deployment > matita > Nuova versione.");
}

// Impostazioni facoltative introdotte dopo la prima versione: se manca la riga la aggiungo (non tocco quelle che ci sono)
function ensureConfig_() {
  const t = table_('Config');
  const have = {};
  t.rows.forEach(function (r) { have[String(r.chiave).trim()] = true; });
  const wanted = [
    ['tariffa_km', '', 'Facoltativo: euro per ogni km, per il rimborso chilometrico (es. 0,35). Se è vuoto scrivi tu l\'importo.'],
    ['url_pagina', '', 'Facoltativo: indirizzo della pagina pubblicata fuori da Google (web/index.html). Se c\'e\', i link dei tecnici e degli inviti usano questo.'],
  ];
  const fresh = wanted.filter(function (w) { return !have[w[0]]; })
    .map(function (w) { return { chiave: w[0], valore: w[1], note: w[2] }; });
  appendMany_('Config', fresh);
}

// ---------------------------------------------------------------------------
// Accesso ai fogli
// ---------------------------------------------------------------------------

function ss_() {
  let s = null;
  try { s = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { s = null; }
  if (!s) {
    const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
    if (!id) throw new Error("Foglio non collegato: esegui la funzione setup dall'editor.");
    s = SpreadsheetApp.openById(id);
  }
  return s;
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error("Nel foglio manca la scheda '" + name + "'. Esegui prima la funzione setup.");
  return sh;
}

function cell_(h, v) {
  if (v instanceof Date) {
    if (DATETIME_COLS.indexOf(h) >= 0) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm');
    return TIME_COLS.indexOf(h) >= 0
      ? Utilities.formatDate(v, TZ, 'HH:mm')
      : Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }
  return v;
}

function table_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const header = (values[0] || []).map(String);
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every(function (v) { return v === '' || v === null; })) continue;
    const o = { _row: r + 1 };
    for (let c = 0; c < header.length; c++) if (header[c]) o[header[c]] = cell_(header[c], row[c]);
    rows.push(o);
  }
  return { sh: sh, header: header, rows: rows };
}

// Come table_, ma se la scheda non esiste restituisce una tabella vuota (per le pagine dei tecnici:
// non devono rompersi se il coordinatore ha aggiornato il codice e non ha ancora lanciato setup)
function tableOpt_(name) {
  if (!ss_().getSheetByName(name)) return { sh: null, header: [], rows: [] };
  return table_(name);
}

// Le scritture su colonne nuove hanno senso solo se la colonna c'è: altrimenti i dati sparirebbero in silenzio
function needCols_(t, cols) {
  const miss = cols.filter(function (c) { return t.header.indexOf(c) < 0; });
  if (miss.length) {
    throw new Error('Nel foglio mancano delle colonne (' + miss.join(', ') + "). Apri l'editor di Apps Script, " +
      'scegli la funzione setup e premi Esegui.');
  }
}

// Cosa manca nel foglio rispetto a quello che il codice si aspetta (schede e colonne)
function schemaGaps_(tables) {
  const gaps = [];
  Object.keys(tables).forEach(function (name) {
    if (!tables[name].sh) { gaps.push(name); return; }   // intera scheda mancante
    COLS[name].forEach(function (c) { if (tables[name].header.indexOf(c) < 0) gaps.push(name + '.' + c); });
  });
  // Le schede che non ho letto: controllo almeno che ci siano (es. Storico, Movimenti)
  Object.keys(COLS).forEach(function (name) {
    if (!tables[name] && !ss_().getSheetByName(name)) gaps.push(name);
  });
  return gaps;
}

function clean_(o) {
  const out = {};
  Object.keys(o).forEach(function (k) {
    if (k === '_row') return;
    const v = o[k];
    out[k] = (v === undefined || v === null) ? '' : v;
  });
  return out;
}

function toInt_(v, def) {
  const n = parseInt(v, 10);
  return isNaN(n) ? def : n;
}

// Importo in euro: accetta "12,5", "12.50" e "1.234,50". Restituisce un numero con al massimo 2 decimali.
function money_(v, label) {
  let s = String(v === undefined || v === null ? '' : v).trim().replace(/[\s€]/g, '');
  if (s === '') throw new Error('Manca ' + label.toLowerCase() + '.');
  if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  if (!isFinite(n) || n < 0 || n > MAX_MONEY) throw new Error(label + ' non è valido: scrivi una cifra in euro (es. 12,50).');
  return Math.round(n * 100) / 100;
}
// Un importo facoltativo: vuoto resta vuoto
function moneyOpt_(v, label) { return (v === '' || v === null || v === undefined) ? '' : money_(v, label); }
// Una data facoltativa: vuota resta vuota, altrimenti AAAA-MM-GG valida
function dateOpt_(v, label) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (s === '') return '';
  if (!validDate_(s)) throw new Error(label + ': data non valida.');
  return s;
}

function evOut_(e) {
  const o = clean_(e);
  ROLES.forEach(function (r) { o[r] = Number(o[r]) || 0; });
  o.materialePrima = Math.min(3, Math.max(0, toInt_(o.materialePrima, 0)));
  o.materialeDopo = Math.min(3, Math.max(0, toInt_(o.materialeDopo, 0)));
  return o;
}

// Quello che può vedere un tecnico di un evento: niente prezzi, niente contatti del cliente
function evPublic_(e) {
  const o = {
    id: e.id, cliente: e.cliente, data: e.data, ora: e.ora, luogo: e.luogo, stato: e.stato,
    noteTecnici: e.noteTecnici, statoPrecedente: e.statoPrecedente, statoNota: e.statoNota,
    statoAggiornato: e.statoAggiornato,
  };
  ROLES.forEach(function (r) { o[r] = Number(e[r]) || 0; });
  TIME_FIELDS.forEach(function (f) { o[f] = e[f]; });
  return clean_(o);
}

// Articolo di magazzino come lo vede il coordinatore (quantità sempre numeri interi)
function matOut_(m) {
  const o = clean_(m);
  o.quantita = Math.max(0, toInt_(o.quantita, 0));
  o.fuoriServizio = Math.min(o.quantita, Math.max(0, toInt_(o.fuoriServizio, 0)));
  o.consumabile = isTrue_(o.consumabile);
  o.categoria = String(o.categoria || '').trim().toLowerCase();
  o.scortaMinima = Math.max(0, toInt_(o.scortaMinima, 0));
  return o;
}

// Riga del materiale di un evento. I conteggi di carico e rientro sono sempre numeri coerenti
// (mai più dei pezzi previsti, mai più del carico).
function carOut_(c) {
  const o = clean_(c);
  o.quantita = Math.max(0, toInt_(o.quantita, 0));
  o.subnoleggio = Math.min(o.quantita, Math.max(0, toInt_(o.subnoleggio, 0)));
  o.caricato = Math.min(o.quantita, Math.max(0, toInt_(o.caricato, 0)));
  o.scaricato = Math.max(0, toInt_(o.scaricato, 0));
  o.danneggiato = Math.max(0, toInt_(o.danneggiato, 0));
  o.mancante = Math.max(0, toInt_(o.mancante, 0));
  o.van_id = String(o.van_id || '');
  return o;
}

// Quello che vede un tecnico del materiale: nome, categoria, quanti pezzi, quanti a noleggio, a che punto sono carico e
// rientro, su quale furgone va. Niente giacenze.
function carPublic_(c, catById) {
  const m = c.equipment_id ? catById[String(c.equipment_id)] : null;
  const o = carOut_(c);
  return clean_({
    id: o.id,
    nome: m ? m.nome : c.materiale,
    categoria: m ? String(m.categoria || '').trim().toLowerCase() : '',
    consumabile: m ? isTrue_(m.consumabile) : false,
    quantita: o.quantita,
    subnoleggio: o.subnoleggio,
    caricato: o.caricato, scaricato: o.scaricato, danneggiato: o.danneggiato, mancante: o.mancante,
    van_id: o.van_id,
    note: c.note,
  });
}

function vanOut_(v) {
  const o = clean_(v);
  o.attivo = String(o.attivo).toLowerCase() !== 'false';
  return o;
}
function feOut_(f) { return clean_(f); }
function repOut_(r) {
  const o = clean_(r);
  o.quantita = Math.max(0, toInt_(o.quantita, 0));
  return o;
}
function movOut_(m) {
  const o = clean_(m);
  o.delta = toInt_(o.delta, 0);
  o.giacenzaDopo = toInt_(o.giacenzaDopo, 0);
  return o;
}
// Una spesa come la vede il coordinatore
function expOut_(s) {
  const o = clean_(s);
  o.importo = Number(o.importo) || 0;
  o.km = Number(o.km) || 0;
  o.addebitoCliente = isTrue_(o.addebitoCliente);
  o.pagatoDa = String(o.pagatoDa) === 'azienda' ? 'azienda' : 'tecnico';
  return o;
}
// ...e come la vede il tecnico che l'ha fatta (niente addebito al cliente)
function expPublic_(s) {
  const o = expOut_(s);
  return { id: o.id, event_id: o.event_id, data: o.data, categoria: o.categoria, descrizione: o.descrizione,
    importo: o.importo, km: o.km, pagatoDa: o.pagatoDa, rimborsatoIl: o.rimborsatoIl, nota: o.nota };
}

function asgPublic_(a) {
  return clean_({ id: a.id, event_id: a.event_id, ruoli: a.ruoli, stato: a.stato, token: a.token });
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { throw new Error('Il foglio è occupato, riprova tra qualche secondo.'); }
  try { return fn(); } finally { lock.releaseLock(); }
}

function headerOf_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

// Aggiunge più righe in una sola scrittura (molto più veloce di una riga alla volta)
function appendMany_(name, objs) {
  if (!objs.length) return;
  const sh = sheet_(name);
  const header = headerOf_(sh);
  const rows = objs.map(function (o) {
    return header.map(function (h) { return (o[h] === undefined || o[h] === null) ? '' : o[h]; });
  });
  const start = sh.getLastRow() + 1;
  const missing = start + rows.length - 1 - sh.getMaxRows();
  if (missing > 0) sh.insertRowsAfter(sh.getMaxRows(), missing);
  sh.getRange(start, 1, rows.length, header.length).setValues(rows);
}

function appendObj_(name, obj) { appendMany_(name, [obj]); }

// Scrive solo le celle che cambiano davvero: veloce, e non tocca eventuali formule altrove nella riga
function updateRow_(name, row, patch) {
  const sh = sheet_(name);
  const header = headerOf_(sh);
  const cur = sh.getRange(row, 1, 1, header.length).getValues()[0];
  Object.keys(patch).forEach(function (k) {
    const c = header.indexOf(k);
    if (c < 0) return;
    const v = (patch[k] === null || patch[k] === undefined) ? '' : patch[k];
    if (String(cur[c]) !== String(v)) sh.getRange(row, c + 1).setValue(v);
  });
}

// Modifica molte righe in un colpo solo: per ogni colonna scrive i valori cambiati a blocchi di righe consecutive
// (una sola chiamata a Fogli per blocco, non una per cella). items: [{row: riga letta con table_, patch: {colonna: valore}}]
function patchRows_(t, items) {
  const perCol = {};
  items.forEach(function (it) {
    Object.keys(it.patch).forEach(function (k) {
      const c = t.header.indexOf(k);
      if (c < 0) return;
      const v = (it.patch[k] === null || it.patch[k] === undefined) ? '' : it.patch[k];
      if (String(it.row[k] === undefined ? '' : it.row[k]) === String(v)) return;
      (perCol[c] = perCol[c] || []).push({ r: it.row._row, v: v });
    });
  });
  Object.keys(perCol).forEach(function (c) {
    const list = perCol[c].sort(function (a, b) { return a.r - b.r; });
    let i = 0;
    while (i < list.length) {
      let j = i;
      while (j + 1 < list.length && list[j + 1].r === list[j].r + 1) j++;
      const vals = [];
      for (let k = i; k <= j; k++) vals.push([list[k].v]);
      t.sh.getRange(list[i].r, Number(c) + 1, vals.length, 1).setValues(vals);
      i = j + 1;
    }
  });
}

function find_(name, id) {
  const rows = table_(name).rows;
  for (let i = 0; i < rows.length; i++) if (String(rows[i].id) === String(id)) return rows[i];
  throw new Error('Non trovato: ' + name + ' ' + id);
}

// La lettera iniziale impedisce a Fogli di scambiare un id fatto di sole cifre (o tipo "12e5") per un numero
function newToken_() { return 't' + Utilities.getUuid().replace(/-/g, '').slice(0, 31); }
function newId_() { return 'i' + Utilities.getUuid().replace(/-/g, '').slice(0, 23); }
function todayStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function nowStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }
// Parte da mezzogiorno così il cambio ora legale/solare (giorni di 23 o 25 ore) non sposta la data
function addDaysStr_(n) {
  const noon = Utilities.parseDate(todayStr_() + ' 12:00', TZ, 'yyyy-MM-dd HH:mm');
  return Utilities.formatDate(new Date(noon.getTime() + n * 86400000), TZ, 'yyyy-MM-dd');
}
function roles_(s) {
  return String(s || '').split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
}
function isTrue_(v) { return v === true || String(v).toLowerCase() === 'true'; }

// Se qualcuno aggiunge righe a mano nel foglio, qui gli diamo id e token mancanti
function fixRows_(t) {
  const cId = t.header.indexOf('id');
  const cTok = t.header.indexOf('token');
  const todo = t.rows.filter(function (r) {
    return (cId >= 0 && !r.id) || (cTok >= 0 && !r.token);
  });
  if (!todo.length) return;
  withLock_(function () {
    todo.forEach(function (r) {
      if (cId >= 0 && !r.id) { r.id = newId_(); t.sh.getRange(r._row, cId + 1).setValue(r.id); }
      if (cTok >= 0 && !r.token) { r.token = newToken_(); t.sh.getRange(r._row, cTok + 1).setValue(r.token); }
    });
  });
}

// ---------------------------------------------------------------------------
// Configurazione e accesso coordinatore
// ---------------------------------------------------------------------------

function config_() {
  const o = {};
  table_('Config').rows.forEach(function (r) { o[String(r.chiave).trim()] = r.valore; });
  return o;
}

// Controlli di forma: AAAA-MM-GG con un giorno che esiste davvero, HH:MM tra 00:00 e 23:59
function validDate_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
function validTime_(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s)); }

// Il codice è un cancello, non una cassaforte: per questo dopo 5 errori si blocca per 15 minuti
function checkPin_(pin) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pin_fails') || 0);
  if (fails >= MAX_PIN_FAILS) throw new Error('Troppi tentativi errati. Riprova tra 15 minuti.');
  const cfgPin = config_().pin_coordinatore;
  const real = String(cfgPin === undefined || cfgPin === null ? '' : cfgPin).trim();
  if (real.length < 4) {
    throw new Error('Codice coordinatore non impostato: scrivilo (almeno 4 caratteri) nella scheda Config del foglio.');
  }
  const given = String(pin === undefined || pin === null ? '' : pin).trim();
  if (given !== real) {
    cache.put('pin_fails', String(fails + 1), PIN_LOCK_SECONDS);
    throw new Error('Codice coordinatore errato.');
  }
  if (fails) cache.remove('pin_fails');
}

// ---------------------------------------------------------------------------
// API coordinatore (chiamate dal browser con google.script.run)
// ---------------------------------------------------------------------------

function api_coordInit(pin) {
  checkPin_(pin);
  const cfg = config_();
  const tec = table_('Tecnici');
  const eventi = table_('Eventi');
  const asg = table_('Assegnazioni');
  const mat = tableOpt_('Materiali');
  const car = tableOpt_('Carico');
  const fur = tableOpt_('Furgoni');
  const fe = tableOpt_('FurgoniEvento');
  const rip = tableOpt_('Riparazioni');
  const mov = tableOpt_('Movimenti');
  const spe = tableOpt_('Spese');
  fixRows_(tec); fixRows_(eventi); fixRows_(asg); fixRows_(mat); fixRows_(car);
  fixRows_(fur); fixRows_(fe); fixRows_(rip); fixRows_(spe);

  // Del materiale servono le righe degli eventi di oggi e futuri (e di quelli di pochi giorni fa), più quelle degli
  // eventi passati con lo scarico ancora da chiudere: gli altri servono solo per "copia da un altro evento", che lavora sul server
  const nByEv = {}, dateOf = {}, loaded = {};
  eventi.rows.forEach(function (e) { dateOf[String(e.id)] = String(e.data); });
  car.rows.forEach(function (c) {
    if (!c.event_id) return;
    nByEv[c.event_id] = (nByEv[c.event_id] || 0) + 1;
    if (toInt_(c.caricato, 0) > 0) loaded[String(c.event_id)] = true;
  });
  const openUnload = {};
  eventi.rows.forEach(function (e) {
    if (e.stato !== 'annullato' && !String(e.scaricoQuando || '') && (String(e.caricoQuando || '') || loaded[String(e.id)])) openUnload[String(e.id)] = true;
  });
  const since = addDaysStr_(-7), unloadSince = addDaysStr_(-60), repSince = addDaysStr_(-120), expSince = addDaysStr_(-180);
  return {
    url: appUrl_(),
    oggi: todayStr_(),
    config: {
      prefisso_telefono: String(cfg.prefisso_telefono || '39'),
      durata_evento_ore: Number(cfg.durata_evento_ore) || 4,
      nome_azienda: String(cfg.nome_azienda || ''),
      tariffa_km: kmRate_(),
    },
    tecnici: tec.rows.map(clean_),
    eventi: eventi.rows.map(function (e) { const o = evOut_(e); o.nMateriali = nByEv[e.id] || 0; return o; }),
    disponibilita: table_('Disponibilita').rows
      .filter(function (d) { return String(d.data) >= since; }).map(clean_),
    assegnazioni: asg.rows.map(clean_),
    materiali: mat.rows.map(matOut_),
    carico: car.rows.filter(function (c) {
      const d = dateOf[String(c.event_id)] || '';
      return d >= since || (openUnload[String(c.event_id)] && d >= unloadSince);
    }).map(carOut_),
    furgoni: fur.rows.map(vanOut_),
    furgoniEvento: fe.rows.map(feOut_),
    riparazioni: rip.rows.filter(function (r) {
      return REP_OPEN.indexOf(String(r.stato)) >= 0 || String(r.chiuso || '') >= repSince;
    }).map(repOut_),
    movimenti: mov.rows.slice(-300).map(movOut_),
    spese: spe.rows.filter(function (x) {
      return (String(x.pagatoDa) !== 'azienda' && !String(x.rimborsatoIl || '')) || String(x.data || '') >= expSince;
    }).map(expOut_),
    mancano: schemaGaps_({ Tecnici: tec, Eventi: eventi, Assegnazioni: asg, Materiali: mat, Carico: car,
      Furgoni: fur, FurgoniEvento: fe, Riparazioni: rip, Movimenti: mov, Spese: spe }),
  };
}

// Annota nel registro un cambio di stato. Se il registro non c'è non blocca il lavoro: avvisa soltanto.
function logStato_(id, evento, tipo, da, a, nota, avvisi) {
  try {
    appendObj_('Storico', { quando: nowStr_(), event_id: id, evento: evento, tipo: tipo, da: da, a: a, nota: nota });
  } catch (err) {
    avvisi.push('Registro dei cambi di stato non aggiornato: ' + err.message);
  }
}

function validStage_(s) { return STAGES.indexOf(s) >= 0; }

function api_saveEvent(pin, ev) {
  checkPin_(pin);
  return withLock_(function () {
    const cliente = String(ev.cliente || '').trim();
    const data = String(ev.data || '').trim();
    const ora = String(ev.ora || '').trim();
    if (!cliente) throw new Error('Manca il nome del cliente.');
    if (!validDate_(data)) throw new Error('Data non valida: usa il selettore.');
    if (ora && !validTime_(ora)) throw new Error('Orario non valido.');
    const cur = ev.id ? find_('Eventi', ev.id) : null;
    const rec = {
      cliente: cliente, data: data, ora: ora,
      luogo: String(ev.luogo || '').trim(),
      stato: validStage_(ev.stato) ? ev.stato : ((cur && validStage_(cur.stato)) ? cur.stato : 'richiesta'),
      noteTecnici: String(ev.noteTecnici || '').trim(),
      materialePrima: Math.min(3, Math.max(0, toInt_(ev.materialePrima, 0))),
      materialeDopo: Math.min(3, Math.max(0, toInt_(ev.materialeDopo, 0))),
    };
    TIME_FIELDS.forEach(function (f) {
      const v = String(ev[f] || '').trim();
      if (v && !validTime_(v)) throw new Error('Orario non valido (' + f + ').');
      rec[f] = v;
    });
    ROLES.forEach(function (r) { rec[r] = Math.max(0, parseInt(ev[r], 10) || 0); });

    // Se lo stato cambia lo ricordo: i tecnici vedono quando e perché (e la nota che scrive il coordinatore)
    const nota = String(ev.notaStato || '').trim().slice(0, 300);
    const stageChanged = !cur || String(cur.stato) !== rec.stato;
    if (stageChanged) {
      rec.statoPrecedente = cur ? String(cur.stato) : '';
      rec.statoNota = nota;
      rec.statoAggiornato = nowStr_();
    }

    const avvisi = [];
    let id = ev.id;
    if (cur) {
      updateRow_('Eventi', cur._row, rec);
      const fresh = find_('Eventi', id);
      const cfg = config_();
      const tecnici = table_('Tecnici').rows;
      table_('Assegnazioni').rows.filter(function (a) { return a.event_id === id; }).forEach(function (a) {
        updateRow_('Assegnazioni', a._row, { evento: cliente });
        if (!a.calendarEventId) return;
        try {
          if (rec.stato === 'annullato') {
            deleteCalendarEvent_(a.calendarEventId);
            updateRow_('Assegnazioni', a._row, { calendarEventId: '', calendarRisposta: '' });
          } else {
            const t = tecnici.filter(function (x) { return x.id === a.technician_id; })[0];
            if (t) upsertCalendarEvent_(a, fresh, t, cfg);
          }
        } catch (err) {
          avvisi.push("Invito Calendar di " + a.tecnico + " non aggiornato: " + err.message);
        }
      });
      if (String(cur.cliente) !== cliente) {
        // il nome dell'evento è ripetuto in altre schede: lo tengo allineato (il registro dei movimenti no: è uno storico)
        ['Carico', 'FurgoniEvento', 'Spese', 'Riparazioni'].forEach(function (name) {
          const t = tableOpt_(name);
          patchRows_(t, t.rows.filter(function (r) { return String(r.event_id) === String(id); })
            .map(function (r) { return { row: r, patch: { evento: cliente } }; }));
        });
      }
      if (stageChanged) logStato_(id, cliente, 'stato', rec.statoPrecedente, rec.stato, nota, avvisi);
    } else {
      id = newId_();
      rec.id = id;
      rec.clienteIncassato = false;
      appendObj_('Eventi', rec);
      logStato_(id, cliente, 'creato', '', rec.stato, nota, avvisi);
    }
    return {
      evento: evOut_(find_('Eventi', id)),
      assegnazioni: table_('Assegnazioni').rows.filter(function (a) { return a.event_id === id; }).map(clean_),
      avvisi: avvisi,
    };
  });
}

function api_saveTech(pin, t) {
  checkPin_(pin);
  return withLock_(function () {
    const nome = String(t.nome || '').trim();
    if (!nome) throw new Error('Manca il nome del tecnico.');
    const ruoli = roles_(Array.isArray(t.ruoli) ? t.ruoli.join(',') : t.ruoli)
      .filter(function (r) { return ROLES.indexOf(r) >= 0; });
    if (!ruoli.length) throw new Error('Scegli almeno una mansione.');
    const email = String(t.email || '').trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Indirizzo email non valido.');
    const rec = {
      nome: nome,
      ruoli: ruoli.join(','),
      telefono: String(t.telefono || '').replace(/[^\d+]/g, ''),
      email: email,
      note: String(t.note || '').trim(),
      cvLink: String(t.cvLink || '').trim(),
      attivo: t.attivo !== false,
    };
    let id = t.id;
    if (id) {
      const cur = find_('Tecnici', id);
      updateRow_('Tecnici', cur._row, rec);
      table_('Disponibilita').rows.filter(function (d) { return d.technician_id === id; })
        .forEach(function (d) { updateRow_('Disponibilita', d._row, { tecnico: nome }); });
      table_('Assegnazioni').rows.filter(function (a) { return a.technician_id === id; })
        .forEach(function (a) { updateRow_('Assegnazioni', a._row, { tecnico: nome }); });
      const spe = tableOpt_('Spese');
      patchRows_(spe, spe.rows.filter(function (r) { return String(r.technician_id) === String(id); })
        .map(function (r) { return { row: r, patch: { tecnico: nome } }; }));
      const fe = tableOpt_('FurgoniEvento');
      patchRows_(fe, fe.rows.filter(function (r) { return String(r.autista_id) === String(id); })
        .map(function (r) { return { row: r, patch: { autista: nome } }; }));
    } else {
      id = newId_();
      rec.id = id;
      rec.token = newToken_();
      appendObj_('Tecnici', rec);
    }
    return clean_(find_('Tecnici', id));
  });
}

// items: [{techId, ruoli:[...]}]. Crea o aggiorna le assegnazioni di un evento in un colpo solo.
function api_assignMany(pin, eventId, items) {
  checkPin_(pin);
  return withLock_(function () {
    const ev = find_('Eventi', eventId);
    if (ev.stato === 'annullato') throw new Error("L'evento è annullato: riportalo a un altro stato prima di assegnare.");
    const cfg = config_();
    const tecnici = table_('Tecnici').rows;
    const asg = table_('Assegnazioni').rows;
    const avvisi = [];
    const out = [];
    const fresh = [];

    // Se lo stesso tecnico compare due volte nella richiesta, unisco i suoi ruoli
    const byTech = {};
    const order = [];
    (items || []).forEach(function (it) {
      const rl = roles_(Array.isArray(it.ruoli) ? it.ruoli.join(',') : it.ruoli)
        .filter(function (r) { return ROLES.indexOf(r) >= 0; });
      const key = String(it.techId);
      if (!byTech[key]) { byTech[key] = []; order.push(key); }
      rl.forEach(function (r) { if (byTech[key].indexOf(r) < 0) byTech[key].push(r); });
    });

    order.forEach(function (techId) {
      const tec = tecnici.filter(function (t) { return String(t.id) === techId; })[0];
      if (!tec) throw new Error('Tecnico non trovato.');
      const rl = byTech[techId];
      if (!rl.length) throw new Error('Scegli almeno un ruolo per ' + tec.nome + '.');
      const existing = asg.filter(function (a) {
        return String(a.event_id) === String(eventId) && String(a.technician_id) === techId;
      })[0];
      if (existing) {
        const before = roles_(existing.ruoli);
        const added = rl.filter(function (r) { return before.indexOf(r) < 0; });
        updateRow_('Assegnazioni', existing._row, { ruoli: rl.join(',') });
        existing.ruoli = rl.join(',');
        if (added.length && String(existing.stato) === 'confermato') {
          avvisi.push(tec.nome + ' aveva già confermato: manda di nuovo la convocazione per il ruolo in più (' + added.join(' + ') + ').');
        }
        if (existing.calendarEventId) {
          try { upsertCalendarEvent_(existing, ev, tec, cfg); }
          catch (err) { avvisi.push('Invito Calendar di ' + tec.nome + ' non aggiornato: ' + err.message); }
        }
        out.push(clean_(existing));
      } else {
        const rec = {
          id: newId_(), event_id: eventId, evento: ev.cliente, technician_id: techId, tecnico: tec.nome,
          ruoli: rl.join(','), stato: 'in attesa', compenso: '', pagato: false, token: newToken_(),
          calendarEventId: '',
        };
        fresh.push(rec);
        out.push(clean_(rec));
      }
    });
    appendMany_('Assegnazioni', fresh);
    return { assegnazioni: out, avvisi: avvisi };
  });
}

function api_unassign(pin, assignmentId) {
  checkPin_(pin);
  return withLock_(function () {
    const a = find_('Assegnazioni', assignmentId);
    if (a.calendarEventId) {
      try { deleteCalendarEvent_(a.calendarEventId); } catch (err) { /* già cancellato a mano: ignoro */ }
    }
    sheet_('Assegnazioni').deleteRow(a._row);
    clearDriver_(a.event_id, a.technician_id);
    return true;
  });
}

function api_setStato(pin, assignmentId, stato) {
  checkPin_(pin);
  if (ASG_STATES.indexOf(stato) < 0) throw new Error('Stato non valido.');
  return withLock_(function () {
    const a = find_('Assegnazioni', assignmentId);
    updateRow_('Assegnazioni', a._row, { stato: stato });
    if (stato === 'rifiutato') clearDriver_(a.event_id, a.technician_id);
    return clean_(find_('Assegnazioni', assignmentId));
  });
}

// ---------------------------------------------------------------------------
// Magazzino (articoli) e materiale degli eventi (carico)
// ---------------------------------------------------------------------------

// Un numero facoltativo (peso, misure): vuoto resta vuoto, il resto deve essere un numero >= 0
function optNumber_(v, label) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(String(v).replace(',', '.'));
  if (!isFinite(n) || n < 0) throw new Error(label + ' deve essere un numero (oppure lascialo vuoto).');
  return Math.round(n * 100) / 100;
}

// Crea o modifica un articolo del magazzino. Non si cancella mai: un articolo che non c'è più si segna "dismesso".
function api_saveMateriale(pin, m) {
  checkPin_(pin);
  return withLock_(function () {
    const t = table_('Materiali');
    needCols_(t, ['id', 'nome', 'categoria', 'quantita', 'fuoriServizio', 'stato', 'scortaMinima']);
    const nome = String(m.nome || '').trim();
    if (!nome) throw new Error("Scrivi il nome dell'articolo.");
    const quantita = toInt_(m.quantita, NaN);
    if (isNaN(quantita) || quantita < 0 || quantita > MAX_QTY) throw new Error('La quantità deve essere un numero da 0 in su.');
    const fuori = toInt_(m.fuoriServizio, 0);
    if (fuori < 0 || fuori > quantita) throw new Error('I pezzi fuori uso non possono essere più di quelli che hai.');
    const id = m.id ? String(m.id) : '';
    const cur = id ? t.rows.filter(function (r) { return String(r.id) === id; })[0] : null;
    if (id && !cur) throw new Error('Articolo non trovato.');
    const dismesso = !!m.dismesso;
    const dup = t.rows.filter(function (r) {
      return String(r.id) !== id && String(r.stato) !== 'dismesso' &&
        String(r.nome).trim().toLowerCase() === nome.toLowerCase();
    })[0];
    if (dup && !dismesso) throw new Error('Esiste già un articolo con questo nome.');
    const rec = {
      nome: nome,
      categoria: String(m.categoria || '').trim().toLowerCase() || 'generale',
      marca: String(m.marca || '').trim(),
      quantita: quantita,
      fuoriServizio: fuori,
      stato: dismesso ? 'dismesso' : ((cur && cur.stato && String(cur.stato) !== 'dismesso') ? String(cur.stato) : 'ok'),
      peso_kg: optNumber_(m.peso_kg, 'Il peso'),
      larghezza_mm: optNumber_(m.larghezza_mm, 'La larghezza'),
      altezza_mm: optNumber_(m.altezza_mm, "L'altezza"),
      profondita_mm: optNumber_(m.profondita_mm, 'La profondità'),
      altezzaInstallazioneMm: optNumber_(m.altezzaInstallazioneMm, "L'altezza di installazione"),
      consumabile: !!m.consumabile,
      note: String(m.note || '').trim(),
      scortaMinima: Math.max(0, Math.min(MAX_QTY, toInt_(m.scortaMinima, 0))) || '',
    };
    let outId = id;
    let delta = 0;
    if (cur) {
      updateRow_('Materiali', cur._row, rec);
      delta = quantita - Math.max(0, toInt_(cur.quantita, 0));
      if (String(cur.nome) !== nome) {
        // il nome compare anche nelle righe di materiale degli eventi e delle riparazioni: lo tengo allineato
        const car = tableOpt_('Carico');
        patchRows_(car, car.rows.filter(function (c) { return String(c.equipment_id) === id; })
          .map(function (c) { return { row: c, patch: { materiale: nome } }; }));
        const rip = tableOpt_('Riparazioni');
        patchRows_(rip, rip.rows.filter(function (r) { return String(r.equipment_id) === id; })
          .map(function (r) { return { row: r, patch: { materiale: nome } }; }));
      }
    } else {
      outId = newId_();
      rec.id = outId;
      appendObj_('Materiali', rec);
      delta = quantita;
    }
    const saved = find_('Materiali', outId);
    // Ogni cambio di giacenza lascia una traccia nel registro dei movimenti (anche cambiando il numero nella scheda)
    if (delta !== 0) {
      logMoveSoft_(saved, delta, cur ? 'rettifica' : 'entrata', cur ? 'modifica scheda' : 'nuovo articolo', '', 'Coordinatore');
    }
    return matOut_(saved);
  });
}

function linesOf_(eventId) {
  return tableOpt_('Carico').rows.filter(function (c) { return String(c.event_id) === String(eventId); }).map(carOut_);
}

function liveEvent_(eventId) {
  const ev = planEvent_(eventId, 'il materiale');
  return ev;
}

// Aggiunge righe di materiale a un evento. Lo stesso articolo due volte si somma, non si duplica.
// lenient = true (copia da un altro evento): un articolo sparito dal magazzino resta come riga libera.
function addLines_(ev, items, lenient) {
  const cat = table_('Materiali');
  const car = table_('Carico');
  needCols_(car, ['id', 'event_id', 'evento', 'equipment_id', 'materiale', 'quantita', 'subnoleggio', 'note']);
  const byId = {};
  cat.rows.forEach(function (m) { byId[String(m.id)] = m; });
  const lines = car.rows.filter(function (r) { return String(r.event_id) === String(ev.id); });
  const vans = vansOfEvent_(ev.id);
  const defVan = vans.length === 1 ? String(vans[0].van_id) : '';     // con un solo furgone, tutto il materiale va su quello
  const fresh = [], dirty = [];
  let n = 0;
  (items || []).forEach(function (it) {
    const q = toInt_(it.quantita, 0);
    if (q < 1 || q > MAX_QTY) throw new Error('La quantità deve essere almeno 1.');
    const sub = Math.min(q, Math.max(0, toInt_(it.subnoleggio, 0)));
    const note = String(it.note || '').trim();
    let name = String(it.nome || '').trim();
    let eqId = '';
    if (it.equipment_id) {
      const m = byId[String(it.equipment_id)];
      if (m && String(m.stato) !== 'dismesso') { eqId = String(m.id); name = String(m.nome); }
      else if (!lenient) throw new Error(m ? m.nome + ' non è più in magazzino.' : 'Articolo non trovato in magazzino.');
    }
    if (!name) throw new Error('Scrivi il nome del materiale.');
    const key = name.toLowerCase();
    const same = lines.concat(fresh).filter(function (r) {
      return eqId ? String(r.equipment_id) === eqId
        : (!r.equipment_id && String(r.materiale).trim().toLowerCase() === key);
    })[0];
    if (same) {
      same.quantita = Math.min(MAX_QTY, toInt_(same.quantita, 0) + q);
      same.subnoleggio = Math.min(same.quantita, toInt_(same.subnoleggio, 0) + sub);
      if (note && String(same.note || '').indexOf(note) < 0) same.note = (same.note ? same.note + '; ' : '') + note;
      if (same._row && dirty.indexOf(same) < 0) dirty.push(same);
    } else {
      fresh.push({
        id: newId_(), event_id: ev.id, evento: ev.cliente, equipment_id: eqId, materiale: name,
        quantita: q, subnoleggio: sub, caricato: 0, scaricato: 0, note: note, danneggiato: 0, mancante: 0, van_id: defVan,
      });
    }
    n++;
  });
  dirty.forEach(function (r) {
    updateRow_('Carico', r._row, { quantita: r.quantita, subnoleggio: r.subnoleggio, note: r.note });
  });
  appendMany_('Carico', fresh);
  return n;
}

// items: [{equipment_id, quantita, subnoleggio, note}] oppure, per un articolo non in magazzino, [{nome, quantita, subnoleggio}]
function api_cadd(pin, eventId, items) {
  checkPin_(pin);
  return withLock_(function () {
    const ev = liveEvent_(eventId);
    addLines_(ev, items, false);
    touchLoad_(ev);
    return { righe: linesOf_(eventId), liste: listsOf_(ev) };
  });
}

function api_cset(pin, lineId, patch) {
  checkPin_(pin);
  patch = patch || {};
  return withLock_(function () {
    const t = table_('Carico');
    needCols_(t, ['id', 'event_id', 'quantita', 'subnoleggio', 'note']);
    const c = t.rows.filter(function (r) { return String(r.id) === String(lineId); })[0];
    if (!c) throw new Error('Riga non trovata (forse l\'ha tolta qualcun altro). Aggiorna la pagina.');
    const ev = liveEvent_(c.event_id);
    const q = patch.quantita === undefined ? toInt_(c.quantita, 0) : toInt_(patch.quantita, NaN);
    if (isNaN(q) || q < 1 || q > MAX_QTY) throw new Error('La quantità deve essere almeno 1.');
    let sub = patch.subnoleggio === undefined ? toInt_(c.subnoleggio, 0) : toInt_(patch.subnoleggio, NaN);
    if (isNaN(sub) || sub < 0) throw new Error('I pezzi a noleggio devono essere un numero da 0 in su.');
    sub = Math.min(sub, q);
    const upd = { quantita: q, subnoleggio: sub };
    if (patch.note !== undefined) upd.note = String(patch.note || '').trim();
    if (q !== toInt_(c.quantita, 0)) {
      // il numero di pezzi è cambiato: il carico non può superarlo e il rientro già registrato non vale più
      upd.caricato = Math.min(q, Math.max(0, toInt_(c.caricato, 0)));
      upd.scaricato = 0; upd.danneggiato = 0; upd.mancante = 0;
      touchLoad_(ev);
    }
    updateRow_('Carico', c._row, upd);
    return { righe: linesOf_(c.event_id), liste: listsOf_(ev) };
  });
}

function api_cdel(pin, lineId) {
  checkPin_(pin);
  return withLock_(function () {
    const t = table_('Carico');
    const c = t.rows.filter(function (r) { return String(r.id) === String(lineId); })[0];
    if (!c) throw new Error('Riga non trovata (forse l\'ha tolta qualcun altro). Aggiorna la pagina.');
    const ev = liveEvent_(c.event_id);
    t.sh.deleteRow(c._row);
    touchLoad_(ev);
    return { righe: linesOf_(c.event_id), liste: listsOf_(ev) };
  });
}

// Toglie tutto il materiale di un evento (le righe si cancellano dal basso per non spostare quelle ancora da togliere)
function api_cclear(pin, eventId) {
  checkPin_(pin);
  return withLock_(function () {
    const ev = liveEvent_(eventId);
    const t = table_('Carico');
    t.rows.filter(function (c) { return String(c.event_id) === String(eventId); })
      .sort(function (a, b) { return b._row - a._row; })
      .forEach(function (c) { t.sh.deleteRow(c._row); });
    touchLoad_(ev);
    return { righe: linesOf_(eventId), liste: listsOf_(ev) };
  });
}

// Copia il materiale di un altro evento (anche passato). I pezzi a noleggio non si copiano: ogni evento ha le sue
// disponibilità, quindi le mancanze vanno rivalutate.
function api_ccopy(pin, fromId, toId) {
  checkPin_(pin);
  return withLock_(function () {
    if (String(fromId) === String(toId)) throw new Error("Scegli un altro evento da cui copiare.");
    find_('Eventi', fromId);
    const to = liveEvent_(toId);
    const src = linesOf_(fromId).filter(function (c) { return c.quantita >= 1; });
    if (!src.length) throw new Error("Quell'evento non ha materiale da copiare.");
    const n = addLines_(to, src.map(function (c) {
      return { equipment_id: c.equipment_id, nome: c.materiale, quantita: c.quantita, subnoleggio: 0, note: c.note };
    }), true);
    touchLoad_(to);
    return { righe: linesOf_(toId), copiate: n, liste: listsOf_(to) };
  });
}

// ---------------------------------------------------------------------------
// Furgoni, liste di carico e di scarico
// ---------------------------------------------------------------------------

// Un evento su cui si può ancora pianificare: non annullato e con lo scarico non ancora chiuso
function planEvent_(eventId, what) {
  const ev = find_('Eventi', eventId);
  if (ev.stato === 'annullato') {
    throw new Error("L'evento è annullato: riportalo a un altro stato prima di cambiare " + what + '.');
  }
  if (String(ev.scaricoQuando || '')) throw new Error('Lo scarico di questo evento è già chiuso: ' + what + ' non si cambia più.');
  return ev;
}

// Cambiando il piano dopo che il carico era stato chiuso, il carico si riapre: va ricontrollato
function touchLoad_(ev) {
  if (String(ev.caricoQuando || '') || String(ev.caricoChi || '')) {
    updateRow_('Eventi', ev._row, { caricoQuando: '', caricoChi: '' });
    ev.caricoQuando = ''; ev.caricoChi = '';
  }
}

function vansOfEvent_(eventId) {
  return tableOpt_('FurgoniEvento').rows.filter(function (f) { return String(f.event_id) === String(eventId); });
}

// Regola: con un solo furgone tutto il materiale dell'evento è su quello; senza furgoni nessuna riga ne ha uno;
// con più furgoni le righe restano dove sono (e se puntavano a un furgone tolto tornano "da assegnare").
function normalizeVans_(eventId) {
  const car = tableOpt_('Carico');
  if (car.header.indexOf('van_id') < 0) return;
  const ids = vansOfEvent_(eventId).map(function (f) { return String(f.van_id); });
  const items = [];
  car.rows.forEach(function (c) {
    if (String(c.event_id) !== String(eventId)) return;
    const cur = String(c.van_id || '');
    let want = cur;
    if (!ids.length) want = '';
    else if (ids.length === 1) want = ids[0];
    else if (cur && ids.indexOf(cur) < 0) want = '';
    if (want !== cur) items.push({ row: c, patch: { van_id: want } });
  });
  patchRows_(car, items);
}

function vanState_(eventId, ev) {
  return { fe: vansOfEvent_(eventId).map(feOut_), righe: linesOf_(eventId), liste: listsOf_(ev || find_('Eventi', eventId)) };
}

// Chi guidava e ora non è più in squadra (tolto, o ha detto di no): il furgone resta ma senza autista
function clearDriver_(eventId, techId) {
  const t = tableOpt_('FurgoniEvento');
  if (!t.sh || t.header.indexOf('autista_id') < 0) return;
  const items = t.rows.filter(function (f) {
    return String(f.event_id) === String(eventId) && String(f.autista_id) === String(techId);
  }).map(function (f) { return { row: f, patch: { autista_id: '', autista: '' } }; });
  patchRows_(t, items);
}

function api_saveVan(pin, v) {
  checkPin_(pin);
  v = v || {};
  return withLock_(function () {
    const t = table_('Furgoni');
    needCols_(t, ['id', 'nome', 'targa', 'portata_kg', 'volume_m3', 'attivo']);
    const nome = String(v.nome || '').trim();
    if (!nome) throw new Error('Scrivi il nome del furgone.');
    if (nome.length > 60) throw new Error('Il nome del furgone è troppo lungo.');
    const id = v.id ? String(v.id) : '';
    const cur = id ? t.rows.filter(function (r) { return String(r.id) === id; })[0] : null;
    if (id && !cur) throw new Error('Furgone non trovato.');
    const dup = t.rows.filter(function (r) {
      return String(r.id) !== id && String(r.nome).trim().toLowerCase() === nome.toLowerCase();
    })[0];
    if (dup) throw new Error('Esiste già un furgone con questo nome.');
    const rec = {
      nome: nome,
      targa: String(v.targa || '').trim().toUpperCase().slice(0, 12),
      note: String(v.note || '').trim(),
      portata_kg: optNumber_(v.portata_kg, 'La portata'),
      volume_m3: optNumber_(v.volume_m3, 'Il volume'),
      attivo: v.attivo !== false,
    };
    let outId = id;
    if (cur) {
      updateRow_('Furgoni', cur._row, rec);
      if (String(cur.nome) !== nome) {
        const fe = tableOpt_('FurgoniEvento');
        patchRows_(fe, fe.rows.filter(function (f) { return String(f.van_id) === id; })
          .map(function (f) { return { row: f, patch: { furgone: nome } }; }));
      }
    } else {
      outId = newId_();
      rec.id = outId;
      appendObj_('Furgoni', rec);
    }
    return vanOut_(find_('Furgoni', outId));
  });
}

// Un furgone (con chi guida, facoltativo) va a un evento. driverId deve essere in squadra e non aver rifiutato.
function api_vanAssign(pin, eventId, vanId, driverId) {
  checkPin_(pin);
  return withLock_(function () {
    const ev = planEvent_(eventId, 'i furgoni');
    const fe = table_('FurgoniEvento');
    needCols_(fe, ['id', 'event_id', 'evento', 'van_id', 'furgone', 'autista_id', 'autista']);
    needCols_(table_('Carico'), ['van_id']);
    const van = find_('Furgoni', vanId);
    if (String(van.attivo).toLowerCase() === 'false') throw new Error('Questo furgone non è più in uso.');
    let autId = '', autName = '';
    if (driverId) {
      const a = table_('Assegnazioni').rows.filter(function (r) {
        return String(r.event_id) === String(eventId) && String(r.technician_id) === String(driverId) && r.stato !== 'rifiutato';
      })[0];
      if (!a) throw new Error('Chi guida deve essere in squadra per questo evento (e non aver detto di no).');
      autId = String(driverId);
      autName = String(a.tecnico);
      const other = fe.rows.filter(function (f) {
        return String(f.event_id) === String(eventId) && String(f.van_id) !== String(vanId) && String(f.autista_id) === autId;
      })[0];
      if (other) throw new Error(autName + ' guida già ' + other.furgone + ' per questo evento.');
    }
    const cur = fe.rows.filter(function (f) { return String(f.event_id) === String(eventId) && String(f.van_id) === String(vanId); })[0];
    if (cur) {
      updateRow_('FurgoniEvento', cur._row, { evento: ev.cliente, furgone: van.nome, autista_id: autId, autista: autName });
    } else {
      appendObj_('FurgoniEvento', {
        id: newId_(), event_id: eventId, evento: ev.cliente, van_id: vanId, furgone: van.nome, autista_id: autId, autista: autName,
      });
    }
    normalizeVans_(eventId);
    if (!cur) touchLoad_(ev);
    return vanState_(eventId, ev);
  });
}

function api_vanUnassign(pin, feId) {
  checkPin_(pin);
  return withLock_(function () {
    const fe = table_('FurgoniEvento');
    const f = fe.rows.filter(function (r) { return String(r.id) === String(feId); })[0];
    if (!f) throw new Error('Furgone non trovato per questo evento (forse l\'ha tolto qualcun altro). Aggiorna la pagina.');
    const ev = planEvent_(f.event_id, 'i furgoni');
    fe.sh.deleteRow(f._row);
    normalizeVans_(f.event_id);
    touchLoad_(ev);
    return vanState_(f.event_id, ev);
  });
}

// Mette sul furgone le righe indicate. Le righe che erano su quel furgone e non sono nell'elenco tornano "da assegnare".
function api_linesVan(pin, eventId, vanId, lineIds) {
  checkPin_(pin);
  return withLock_(function () {
    const ev = planEvent_(eventId, 'i furgoni');
    const car = table_('Carico');
    needCols_(car, ['id', 'event_id', 'van_id']);
    const onEvent = vansOfEvent_(eventId);
    if (!onEvent.some(function (f) { return String(f.van_id) === String(vanId); })) {
      throw new Error('Prima aggiungi questo furgone all\'evento.');
    }
    const want = {};
    (lineIds || []).forEach(function (id) { want[String(id)] = true; });
    const items = [];
    car.rows.forEach(function (c) {
      if (String(c.event_id) !== String(eventId)) return;
      const cur = String(c.van_id || '');
      let next = cur;
      if (want[String(c.id)]) next = String(vanId);
      else if (cur === String(vanId)) next = '';
      if (next !== cur) items.push({ row: c, patch: { van_id: next } });
    });
    Object.keys(want).forEach(function (id) {
      const c = car.rows.filter(function (r) { return String(r.id) === id; })[0];
      if (!c || String(c.event_id) !== String(eventId)) throw new Error('Una delle righe non c\'è più. Aggiorna la pagina.');
    });
    patchRows_(car, items);
    if (items.length) touchLoad_(ev);
    return vanState_(eventId, ev);
  });
}

// ---------------------------------------------------------------------------
// Liste di carico (cosa si mette sul furgone) e di scarico (cosa rientra)
// ---------------------------------------------------------------------------

function rawLines_(eventId) {
  return tableOpt_('Carico').rows.filter(function (c) { return String(c.event_id) === String(eventId); });
}

// Se nell'evento si è usata la lista di carico, al rientro ci si aspettano i pezzi caricati; altrimenti tutti quelli previsti
function loadUsed_(lines) {
  return lines.some(function (c) { return toInt_(c.caricato, 0) > 0; });
}
function retBase_(c, used) {
  const q = Math.max(0, toInt_(c.quantita, 0));
  return used ? Math.min(q, Math.max(0, toInt_(c.caricato, 0))) : q;
}
function retDone_(c) { return Math.max(0, toInt_(c.scaricato, 0)) + Math.max(0, toInt_(c.danneggiato, 0)) + Math.max(0, toInt_(c.mancante, 0)); }

function listsOf_(ev) {
  return {
    caricoQuando: String(ev.caricoQuando || ''), caricoChi: String(ev.caricoChi || ''),
    scaricoQuando: String(ev.scaricoQuando || ''), scaricoChi: String(ev.scaricoChi || ''),
  };
}

function lineFor_(eventId, lineId) {
  const c = rawLines_(eventId).filter(function (r) { return String(r.id) === String(lineId); })[0];
  if (!c) throw new Error('Riga non trovata (forse l\'ha tolta qualcun altro). Aggiorna la pagina.');
  return c;
}

// Controlla che la lista si possa ancora cambiare
function listOpen_(ev, kind) {
  if (LIST_KINDS.indexOf(kind) < 0) throw new Error('Lista non valida.');
  if (kind === 'carico') {
    if (ev.stato === 'annullato') throw new Error("L'evento è annullato: non si carica più.");
    if (String(ev.caricoQuando || '')) throw new Error('Il carico è chiuso: riaprilo per cambiarlo.');
  } else if (String(ev.scaricoQuando || '')) {
    throw new Error('Lo scarico è già chiuso: per correggere usa le schede Movimenti e Riparazioni del magazzino.');
  }
}

// Un conteggio di pezzi: vuoto vale `def`, altrimenti dev'essere un numero intero da 0 in su (altrimenti NaN)
function cnt_(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  return (isFinite(n) && Math.floor(n) === n && n >= 0) ? n : NaN;
}

// Calcola come cambia una riga. vals: carico {caricato}; scarico {tutto} | {reset} | {scaricato, danneggiato, mancante}
function listPatch_(c, lines, kind, vals, catById) {
  vals = vals || {};
  const q = Math.max(0, toInt_(c.quantita, 0));
  if (kind === 'carico') {
    const n = cnt_(vals.caricato, NaN);
    if (isNaN(n) || n > q) throw new Error('I pezzi caricati vanno da 0 a ' + q + '.');
    if (retDone_(c) > n) throw new Error('Di questa voce hai già registrato il rientro: azzera prima lo scarico.');
    return { caricato: n };
  }
  const base = retBase_(c, loadUsed_(lines));
  if (base < 1) throw new Error('Questa voce non è stata caricata: non c\'è niente da far rientrare.');
  if (vals.reset) return { scaricato: 0, danneggiato: 0, mancante: 0 };
  if (vals.tutto) return { scaricato: base, danneggiato: 0, mancante: 0 };
  const d = cnt_(vals.danneggiato, 0), m = cnt_(vals.mancante, 0);
  if (isNaN(d) || isNaN(m)) throw new Error('I numeri non sono validi.');
  const tooMany = 'Tra rientrati, danneggiati e mancanti non possono essere più di ' + base + '.';
  if (d + m > base) throw new Error(tooMany);
  const s = cnt_(vals.scaricato, base - d - m);          // se non lo dici, il resto è rientrato regolarmente
  if (isNaN(s)) throw new Error('I numeri non sono validi.');
  if (s + d + m > base) throw new Error(tooMany);
  const art = c.equipment_id ? catById[String(c.equipment_id)] : null;
  if (d > 0 && art && isTrue_(art.consumabile)) throw new Error('Il materiale di consumo non si ripara: segnalo come consumato.');
  return { scaricato: s, danneggiato: d, mancante: m };
}

function setListLine_(eventId, kind, lineId, vals, pub) {
  const ev = find_('Eventi', eventId);
  listOpen_(ev, kind);
  needCols_(table_('Carico'), ['id', 'caricato', 'scaricato', 'danneggiato', 'mancante']);
  const lines = rawLines_(eventId);
  const c = lines.filter(function (r) { return String(r.id) === String(lineId); })[0];
  if (!c) throw new Error('Riga non trovata (forse l\'ha tolta qualcun altro). Aggiorna la pagina.');
  const cat = catalogById_();
  const patch = listPatch_(c, lines, kind, vals, cat);
  updateRow_('Carico', c._row, patch);
  Object.keys(patch).forEach(function (k) { c[k] = patch[k]; });
  return pub ? carPublic_(c, cat) : carOut_(c);
}

// mode: 'all' tutto fatto, 'none' si azzera, 'rest' (solo scarico) segna come rientrato quello che non è stato ancora controllato
function setListAll_(eventId, kind, mode) {
  const ev = find_('Eventi', eventId);
  listOpen_(ev, kind);
  if (['all', 'none', 'rest'].indexOf(mode) < 0) throw new Error('Operazione non valida.');
  if (mode === 'rest' && kind !== 'scarico') throw new Error('Operazione non valida.');
  const t = table_('Carico');
  needCols_(t, ['id', 'caricato', 'scaricato', 'danneggiato', 'mancante']);
  const lines = t.rows.filter(function (c) { return String(c.event_id) === String(eventId); });
  const items = [];
  if (kind === 'carico') {
    if (mode === 'none' && lines.some(function (c) { return retDone_(c) > 0; })) {
      throw new Error('Il rientro è già iniziato: azzera prima lo scarico.');
    }
    lines.forEach(function (c) {
      const q = Math.max(0, toInt_(c.quantita, 0));
      if (q < 1) return;
      items.push({ row: c, patch: { caricato: mode === 'all' ? q : 0 } });
    });
  } else {
    const used = loadUsed_(lines);
    lines.forEach(function (c) {
      const base = retBase_(c, used);
      if (base < 1) return;
      if (mode === 'none') items.push({ row: c, patch: { scaricato: 0, danneggiato: 0, mancante: 0 } });
      else if (mode === 'all') items.push({ row: c, patch: { scaricato: base, danneggiato: 0, mancante: 0 } });
      else if (retDone_(c) !== base) {
        // «il resto è rientrato»: i danneggiati e i mancanti già registrati restano, il resto dei pezzi è tornato regolarmente
        const bad = Math.max(0, toInt_(c.danneggiato, 0)) + Math.max(0, toInt_(c.mancante, 0));
        items.push({ row: c, patch: { scaricato: Math.max(0, base - bad) } });
      }
    });
  }
  patchRows_(t, items);
}

function api_listSet(pin, eventId, kind, lineId, vals) {
  checkPin_(pin);
  return withLock_(function () { return { riga: setListLine_(eventId, kind, lineId, vals, false) }; });
}

function api_listAll(pin, eventId, kind, mode) {
  checkPin_(pin);
  return withLock_(function () {
    setListAll_(eventId, kind, mode);
    return { righe: linesOf_(eventId) };
  });
}

// Chiude (o riapre) la lista di carico: solo un'annotazione di chi ha finito e quando, non cambia il magazzino
function closeLoad_(eventId, close, who) {
  const ev = find_('Eventi', eventId);
  needCols_(table_('Eventi'), ['caricoQuando', 'caricoChi']);
  if (ev.stato === 'annullato') throw new Error("L'evento è annullato: non si carica più.");
  if (String(ev.scaricoQuando || '')) throw new Error('Lo scarico è già chiuso.');
  if (close) {
    if (!rawLines_(eventId).some(function (c) { return toInt_(c.quantita, 0) >= 1; })) throw new Error('Non c\'è materiale in elenco da caricare.');
    updateRow_('Eventi', ev._row, { caricoQuando: nowStr_(), caricoChi: who });
  } else {
    updateRow_('Eventi', ev._row, { caricoQuando: '', caricoChi: '' });
  }
  return listsOf_(find_('Eventi', eventId));
}

function api_loadClose(pin, eventId, close) {
  checkPin_(pin);
  return withLock_(function () { return { liste: closeLoad_(eventId, !!close, 'Coordinatore') }; });
}

// Rilegge le righe e lo stato delle liste di un evento: la finestra della lista lo fa ogni tanto, perché due persone
// possono caricare lo stesso furgone nello stesso momento e ognuna deve vedere quello che spunta l'altra
function api_eventLists(pin, eventId) {
  checkPin_(pin);
  const ev = find_('Eventi', eventId);
  return { righe: linesOf_(eventId), liste: listsOf_(ev) };
}

// ---- cosa succede al magazzino quando si chiude lo scarico ----

function unloadPlan_(lines, catById) {
  const used = loadUsed_(lines);
  const items = [];
  let unresolved = 0, checked = 0, total = 0;
  lines.forEach(function (c) {
    const base = retBase_(c, used);
    if (base < 1) return;
    total++;
    if (retDone_(c) !== base) { unresolved++; return; }
    checked++;
    const d = Math.max(0, toInt_(c.danneggiato, 0)), m = Math.max(0, toInt_(c.mancante, 0));
    if (!d && !m) return;
    const art = c.equipment_id ? catById[String(c.equipment_id)] : null;
    const q = Math.max(0, toInt_(c.quantita, 0));
    const own = Math.max(0, q - Math.min(q, Math.max(0, toInt_(c.subnoleggio, 0))));   // pezzi nostri della riga
    const ownD = art ? Math.min(d, own) : 0;
    const ownM = art ? Math.min(m, own - ownD) : 0;
    items.push({
      line_id: String(c.id), equipment_id: art ? String(art.id) : '', nome: art ? String(art.nome) : String(c.materiale),
      consumabile: !!(art && isTrue_(art.consumabile)), danneggiato: d, mancante: m, ownD: ownD, ownM: ownM,
      noleggio: (d - ownD) + (m - ownM), libera: !art,
    });
  });
  return { items: items, unresolved: unresolved, total: total, checked: checked };
}

function api_unloadPreview(pin, eventId) {
  checkPin_(pin);
  const ev = find_('Eventi', eventId);
  const plan = unloadPlan_(rawLines_(eventId), catalogById_());
  plan.chiuso = String(ev.scaricoQuando || '');
  plan.evento = String(ev.cliente);
  return plan;
}

// Chiude lo scarico e applica quello che è emerso: i pezzi danneggiati diventano riparazioni, i mancanti escono dal
// magazzino (perso), i consumati pure (consumato). I pezzi a noleggio non toccano il nostro magazzino.
function api_unloadClose(pin, eventId) {
  checkPin_(pin);
  return withLock_(function () {
    needCols_(table_('Eventi'), ['scaricoQuando', 'scaricoChi']);
    const ev = find_('Eventi', eventId);
    if (String(ev.scaricoQuando || '')) throw new Error('Lo scarico è già chiuso.');
    const lines = rawLines_(eventId);
    const catById = catalogById_();
    const plan = unloadPlan_(lines, catById);
    if (plan.unresolved) {
      throw new Error('Ci sono ancora ' + plan.unresolved + (plan.unresolved === 1 ? ' voce' : ' voci') + ' da controllare: segna come rientrate quelle che mancano o controllale una per una.');
    }
    const ctx = stockCtx_();
    const rip = table_('Riparazioni');
    const mov = table_('Movimenti');
    const tickets = [], moves = [], touched = {};
    plan.items.forEach(function (it) {
      if (!it.equipment_id) return;
      const m = matRow_(ctx, it.equipment_id);
      if (it.ownD > 0 && !rip.rows.some(function (r) {
        return String(r.event_id) === String(ev.id) && String(r.equipment_id) === it.equipment_id && String(r.apertoDa) === 'Rientro';
      })) {
        const usable = Math.max(0, toInt_(m.quantita, 0) - toInt_(m.fuoriServizio, 0));
        const q = Math.min(it.ownD, usable);
        if (q > 0) {
          setMat_(ctx, m, { fuoriServizio: toInt_(m.fuoriServizio, 0) + q });
          tickets.push(newTicket_(m, q, 'Danneggiato al rientro da «' + ev.cliente + '»', 'Rientro', ev));
          touched[it.equipment_id] = true;
        }
      }
      const causale = it.consumabile ? 'consumato' : 'perso';
      if (it.ownM > 0 && !mov.rows.some(function (r) {
        return String(r.event_id) === String(ev.id) && String(r.equipment_id) === it.equipment_id &&
          String(r.chi) === 'Scarico furgone' && String(r.causale) === causale;
      })) {
        const q = Math.min(it.ownM, toInt_(m.quantita, 0));
        if (q > 0) {
          const nq = toInt_(m.quantita, 0) - q;
          setMat_(ctx, m, { quantita: nq, fuoriServizio: Math.min(nq, toInt_(m.fuoriServizio, 0)) });
          moves.push(logMove_(m, -q, 'uscita', causale, (it.consumabile ? 'Consumato' : 'Non rientrato') + ' all\'evento «' + ev.cliente + '»', 'Scarico furgone', ev));
          touched[it.equipment_id] = true;
        }
      }
    });
    updateRow_('Eventi', ev._row, { scaricoQuando: nowStr_(), scaricoChi: 'Coordinatore' });
    return {
      evento: evOut_(find_('Eventi', eventId)), righe: linesOf_(eventId),
      materiali: Object.keys(touched).map(function (id) { return matOut_(ctx.byId[id]); }),
      riparazioni: tickets, movimenti: moves,
    };
  });
}

// ---------------------------------------------------------------------------
// Magazzino: entrate, uscite, inventario
// ---------------------------------------------------------------------------

// Articoli del magazzino letti una volta sola e tenuti aggiornati mentre si fanno più modifiche di fila
function stockCtx_() {
  const t = table_('Materiali');
  needCols_(t, ['id', 'nome', 'quantita', 'fuoriServizio', 'stato']);
  const byId = {};
  t.rows.forEach(function (m) { byId[String(m.id)] = m; });
  return { t: t, byId: byId };
}
function matRow_(ctx, id) {
  const m = ctx.byId[String(id)];
  if (!m) throw new Error('Articolo non trovato in magazzino.');
  return m;
}
function setMat_(ctx, m, patch) {
  updateRow_('Materiali', m._row, patch);
  Object.keys(patch).forEach(function (k) { m[k] = patch[k]; });
}

// Scrive una riga nel registro dei movimenti
function logMove_(m, delta, tipo, causale, nota, chi, ev) {
  const rec = {
    id: newId_(), quando: nowStr_(), equipment_id: String(m.id), materiale: String(m.nome), tipo: tipo, causale: causale,
    delta: delta, giacenzaDopo: toInt_(m.quantita, 0), event_id: ev ? String(ev.id) : '', evento: ev ? String(ev.cliente) : '',
    chi: chi, nota: String(nota || '').trim(),
  };
  appendObj_('Movimenti', rec);
  return movOut_(rec);
}

// Come logMove_ ma senza bloccare il lavoro se la scheda Movimenti non c'è ancora (foglio non aggiornato)
function logMoveSoft_(m, delta, tipo, causale, nota, chi) {
  try { return logMove_(m, delta, tipo, causale, nota, chi, null); } catch (err) { return null; }
}

function newTicket_(m, q, difetto, chi, ev) {
  const rec = {
    id: newId_(), equipment_id: String(m.id), materiale: String(m.nome), quantita: q, stato: 'da riparare',
    difetto: difetto, aperto: todayStr_(), apertoDa: chi, event_id: ev ? String(ev.id) : '', evento: ev ? String(ev.cliente) : '',
    fornitore: '', previsto: '', costo: '', chiuso: '', nota: '',
  };
  appendObj_('Riparazioni', rec);
  return repOut_(rec);
}

function api_stockMove(pin, o) {
  checkPin_(pin);
  o = o || {};
  return withLock_(function () {
    const tipo = String(o.tipo || '');
    if (tipo !== 'entrata' && tipo !== 'uscita') throw new Error('Scegli se è un\'entrata o un\'uscita.');
    const causale = String(o.causale || 'altro');
    if ((tipo === 'entrata' ? MOV_CAUSE_IN : MOV_CAUSE_OUT).indexOf(causale) < 0) throw new Error('Scegli il motivo.');
    const q = toInt_(o.quantita, NaN);
    if (isNaN(q) || q < 1 || q > MAX_QTY) throw new Error('La quantità deve essere almeno 1.');
    const ctx = stockCtx_();
    needCols_(table_('Movimenti'), ['id', 'quando', 'equipment_id', 'delta']);
    const m = matRow_(ctx, o.equipment_id);
    if (String(m.stato) === 'dismesso') throw new Error('Questo articolo è dismesso: riattivalo dalla sua scheda prima di muoverlo.');
    const have = Math.max(0, toInt_(m.quantita, 0)), fuori = Math.min(have, Math.max(0, toInt_(m.fuoriServizio, 0)));
    let ev = null;
    if (o.event_id) ev = find_('Eventi', o.event_id);
    if (tipo === 'entrata') {
      if (have + q > MAX_QTY) throw new Error('Il magazzino non può contenere più di ' + MAX_QTY + ' pezzi di un articolo.');
      setMat_(ctx, m, { quantita: have + q });
    } else {
      if (q > have - fuori) {
        throw new Error('Hai solo ' + (have - fuori) + (have - fuori === 1 ? ' pezzo utilizzabile' : ' pezzi utilizzabili') +
          '. I pezzi rotti si tolgono chiudendo la loro riparazione come «non riparabile».');
      }
      setMat_(ctx, m, { quantita: have - q });
    }
    const mv = logMove_(m, tipo === 'entrata' ? q : -q, tipo, causale, o.nota, 'Coordinatore', ev);
    return { materiale: matOut_(m), movimento: mv };
  });
}

// counts: [{equipment_id, quantita}] = quanti pezzi hai contato davvero. Registra la differenza come rettifica.
function api_inventory(pin, counts, nota) {
  checkPin_(pin);
  return withLock_(function () {
    if (!Array.isArray(counts) || !counts.length) throw new Error('Non c\'è niente da salvare.');
    const ctx = stockCtx_();
    needCols_(table_('Movimenti'), ['id', 'quando', 'equipment_id', 'delta']);
    const changed = [], moves = [], plan = [], seen = {};
    let same = 0;
    // Prima controllo tutto, poi scrivo: se una riga non va, non si salva niente a metà
    counts.forEach(function (c) {
      c = c || {};
      const m = matRow_(ctx, c.equipment_id);
      if (seen[String(m.id)]) throw new Error(m.nome + ' è nell\'elenco due volte.');
      seen[String(m.id)] = true;
      const n = cnt_(c.quantita, NaN);
      if (isNaN(n) || n > MAX_QTY) throw new Error('La quantità di ' + m.nome + ' non è valida.');
      const have = Math.max(0, toInt_(m.quantita, 0)), fuori = Math.max(0, toInt_(m.fuoriServizio, 0));
      if (n === have) { same++; return; }
      if (n < fuori) throw new Error(m.nome + ': ne hai contati ' + n + ' ma ' + fuori + ' risultano fuori uso. Conta anche i pezzi rotti o dal riparatore, oppure sistema prima le riparazioni.');
      plan.push({ m: m, n: n, have: have });
    });
    plan.forEach(function (p) {
      setMat_(ctx, p.m, { quantita: p.n });
      moves.push(logMove_(p.m, p.n - p.have, 'rettifica', 'inventario', nota, 'Coordinatore', null));
      changed.push(String(p.m.id));
    });
    return {
      materiali: changed.map(function (id) { return matOut_(ctx.byId[id]); }),
      movimenti: moves, invariati: same,
    };
  });
}

// Gli ultimi movimenti (il registro cresce nel tempo: all'avvio se ne caricano solo i più recenti)
function api_movList(pin, n) {
  checkPin_(pin);
  const lim = Math.min(5000, Math.max(1, toInt_(n, 300)));
  return tableOpt_('Movimenti').rows.slice(-lim).map(movOut_);
}

// ---------------------------------------------------------------------------
// Riparazioni
// ---------------------------------------------------------------------------

function openPieces_(rip, equipId) {
  return rip.rows.filter(function (r) { return String(r.equipment_id) === String(equipId) && REP_OPEN.indexOf(String(r.stato)) >= 0; })
    .reduce(function (s, r) { return s + Math.max(0, toInt_(r.quantita, 0)); }, 0);
}

// Segnala un guasto. giaFuoriUso = i pezzi risultavano già fuori uso nella scheda dell'articolo, senza una riparazione aperta.
function api_repOpen(pin, r) {
  checkPin_(pin);
  r = r || {};
  return withLock_(function () {
    const ctx = stockCtx_();
    const rip = table_('Riparazioni');
    needCols_(rip, ['id', 'equipment_id', 'quantita', 'stato', 'difetto', 'aperto']);
    const m = matRow_(ctx, r.equipment_id);
    if (String(m.stato) === 'dismesso') throw new Error('Questo articolo è dismesso.');
    const q = toInt_(r.quantita, NaN);
    if (isNaN(q) || q < 1 || q > MAX_QTY) throw new Error('Quanti pezzi sono guasti? Almeno 1.');
    const have = Math.max(0, toInt_(m.quantita, 0)), fuori = Math.min(have, Math.max(0, toInt_(m.fuoriServizio, 0)));
    if (r.giaFuoriUso) {
      const orphan = Math.max(0, fuori - openPieces_(rip, m.id));
      if (q > orphan) throw new Error('I pezzi fuori uso senza una riparazione aperta sono ' + orphan + '.');
    } else {
      if (q > have - fuori) {
        throw new Error('Hai solo ' + (have - fuori) + (have - fuori === 1 ? ' pezzo utilizzabile' : ' pezzi utilizzabili') + ': non puoi segnalarne ' + q + ' come guasti.');
      }
      setMat_(ctx, m, { fuoriServizio: fuori + q });
    }
    let ev = null;
    if (r.event_id) ev = find_('Eventi', r.event_id);
    const t = newTicket_(m, q, String(r.difetto || '').trim().slice(0, 200) || 'Non specificato', 'Coordinatore', ev);
    return { riparazione: t, materiale: matOut_(m) };
  });
}

// Aggiorna un biglietto: dettagli, passaggio tra «da riparare» e «in riparazione», costo e nota anche a cose fatte
function api_repUpdate(pin, id, patch) {
  checkPin_(pin);
  patch = patch || {};
  return withLock_(function () {
    const rip = table_('Riparazioni');
    needCols_(rip, ['id', 'stato', 'difetto', 'fornitore', 'previsto', 'costo', 'nota']);
    const r = rip.rows.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!r) throw new Error('Riparazione non trovata. Aggiorna la pagina.');
    const open = REP_OPEN.indexOf(String(r.stato)) >= 0;
    const upd = {};
    if (patch.costo !== undefined) upd.costo = moneyOpt_(patch.costo, 'Il costo');
    if (patch.nota !== undefined) upd.nota = String(patch.nota || '').trim().slice(0, 300);
    if (open) {
      if (patch.difetto !== undefined) upd.difetto = String(patch.difetto || '').trim().slice(0, 200) || 'Non specificato';
      if (patch.fornitore !== undefined) upd.fornitore = String(patch.fornitore || '').trim().slice(0, 100);
      if (patch.previsto !== undefined) upd.previsto = dateOpt_(patch.previsto, 'La data prevista');
      if (patch.stato !== undefined) {
        if (REP_OPEN.indexOf(String(patch.stato)) < 0) throw new Error('Per chiuderla usa «Riparato» o «Non riparabile».');
        upd.stato = String(patch.stato);
      }
    } else if (patch.difetto !== undefined || patch.fornitore !== undefined || patch.previsto !== undefined || patch.stato !== undefined) {
      throw new Error('È già chiusa: puoi cambiare solo il costo e la nota.');
    }
    updateRow_('Riparazioni', r._row, upd);
    return { riparazione: repOut_(find_('Riparazioni', id)) };
  });
}

// Chiude (tutta o in parte) una riparazione. esito: 'riparato' | 'non riparabile'.
function api_repClose(pin, id, o) {
  checkPin_(pin);
  o = o || {};
  return withLock_(function () {
    const rip = table_('Riparazioni');
    needCols_(rip, ['id', 'stato', 'quantita', 'chiuso', 'costo', 'nota']);
    const r = rip.rows.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!r) throw new Error('Riparazione non trovata. Aggiorna la pagina.');
    if (REP_OPEN.indexOf(String(r.stato)) < 0) throw new Error('Questa riparazione è già chiusa.');
    const esito = String(o.esito || '');
    if (REP_CLOSED.indexOf(esito) < 0) throw new Error('Scegli come è finita: riparato o non riparabile.');
    const tot = Math.max(0, toInt_(r.quantita, 0));
    const q = (o.quantita === undefined || o.quantita === null || o.quantita === '') ? tot : toInt_(o.quantita, NaN);
    if (isNaN(q) || q < 1 || q > tot) throw new Error('I pezzi da chiudere vanno da 1 a ' + tot + '.');
    const costo = moneyOpt_(o.costo, 'Il costo');
    const nota = (o.nota === undefined || o.nota === null) ? String(r.nota || '') : String(o.nota).trim().slice(0, 300);
    const ctx = stockCtx_();
    const m = matRow_(ctx, r.equipment_id);
    const have = Math.max(0, toInt_(m.quantita, 0)), fuori = Math.max(0, toInt_(m.fuoriServizio, 0));
    let mv = null;
    if (esito === 'riparato') {
      setMat_(ctx, m, { fuoriServizio: Math.max(0, fuori - q) });
    } else {
      needCols_(table_('Movimenti'), ['id', 'quando', 'equipment_id', 'delta']);
      const nq = Math.max(0, have - q);
      setMat_(ctx, m, { quantita: nq, fuoriServizio: Math.min(nq, Math.max(0, fuori - q)) });
      const ev = r.event_id ? { id: r.event_id, cliente: r.evento } : null;
      mv = logMove_(m, -(have - nq), 'uscita', 'dismesso', 'Non riparabile: ' + (r.difetto || ''), 'Coordinatore', ev);
    }
    const out = [];
    if (q === tot) {
      updateRow_('Riparazioni', r._row, { stato: esito, chiuso: todayStr_(), costo: costo === '' ? r.costo : costo, nota: nota });
      out.push(repOut_(find_('Riparazioni', id)));
    } else {
      updateRow_('Riparazioni', r._row, { quantita: tot - q });
      const part = {
        id: newId_(), equipment_id: r.equipment_id, materiale: r.materiale, quantita: q, stato: esito, difetto: r.difetto,
        aperto: r.aperto, apertoDa: r.apertoDa, event_id: r.event_id, evento: r.evento, fornitore: r.fornitore, previsto: '',
        costo: costo, chiuso: todayStr_(), nota: nota,
      };
      appendObj_('Riparazioni', part);
      out.push(repOut_(find_('Riparazioni', id)), repOut_(part));
    }
    return { riparazioni: out, materiale: matOut_(m), movimento: mv };
  });
}

// ---------------------------------------------------------------------------
// Spese e rimborsi
// ---------------------------------------------------------------------------

// Euro per km dalla scheda Config (vuoto = nessuna tariffa)
function kmRate_() {
  const raw = config_().tariffa_km;
  const v = Number(String(raw === undefined || raw === null ? '' : raw).replace(',', '.'));
  return isFinite(v) && v > 0 ? v : 0;
}

// Controlla e sistema i campi di una spesa (uguali per coordinatore e tecnico)
function expFields_(e, rate) {
  const categoria = String(e.categoria || '').trim().toLowerCase();
  if (EXP_CATS.indexOf(categoria) < 0) throw new Error('Scegli di che spesa si tratta.');
  const data = String(e.data || '').trim() || todayStr_();
  if (!validDate_(data)) throw new Error('La data della spesa non è valida.');
  const km = categoria === 'chilometri' ? optNumber_(e.km, 'I chilometri') : '';
  const raw = e.importo;
  let importo;
  if ((raw === '' || raw === null || raw === undefined) && km !== '' && Number(km) > 0 && rate > 0) {
    importo = Math.round(Number(km) * rate * 100) / 100;     // rimborso chilometrico: km per tariffa
  } else {
    importo = money_(raw, "L'importo");
  }
  if (!(importo > 0)) throw new Error("L'importo deve essere più di zero.");
  return {
    data: data, categoria: categoria, descrizione: String(e.descrizione || '').trim().slice(0, 120),
    importo: importo, km: km, pagatoDa: String(e.pagatoDa) === 'azienda' ? 'azienda' : 'tecnico',
    nota: String(e.nota || '').trim().slice(0, 200),
  };
}

function expById_(t, id) {
  const s = t.rows.filter(function (r) { return String(r.id) === String(id); })[0];
  if (!s) throw new Error('Spesa non trovata (forse l\'ha tolta qualcun altro). Aggiorna la pagina.');
  return s;
}

// Crea o corregge una spesa (coordinatore). Una spesa già rimborsata si può correggere solo nella descrizione, nella nota
// e nell'addebito al cliente: per cambiare importo o chi ha pagato va prima tolto il rimborso.
function api_expSave(pin, e) {
  checkPin_(pin);
  e = e || {};
  return withLock_(function () {
    const t = table_('Spese');
    needCols_(t, ['id', 'event_id', 'evento', 'data', 'categoria', 'importo', 'pagatoDa', 'technician_id', 'tecnico',
      'rimborsatoIl', 'addebitoCliente', 'km', 'creataDa']);
    const ev = find_('Eventi', e.event_id);
    const f = expFields_(e, kmRate_());
    let tecId = '', tecName = '';
    if (e.technician_id) {
      const tec = table_('Tecnici').rows.filter(function (r) { return String(r.id) === String(e.technician_id); })[0];
      if (!tec) throw new Error('Tecnico non trovato.');
      tecId = String(tec.id); tecName = String(tec.nome);
    }
    if (f.pagatoDa === 'tecnico' && !tecId) throw new Error('Scegli chi ha pagato.');
    const cur = e.id ? expById_(t, e.id) : null;
    if (cur && String(cur.rimborsatoIl || '')) {
      const same = Number(cur.importo) === f.importo && String(cur.pagatoDa) === f.pagatoDa &&
        String(cur.technician_id) === tecId && String(cur.categoria) === f.categoria && String(cur.data) === f.data;
      if (!same) throw new Error('È già stata rimborsata: per cambiare importo, data o chi ha pagato togli prima il rimborso.');
    }
    const rec = {
      event_id: String(ev.id), evento: String(ev.cliente), data: f.data, categoria: f.categoria, descrizione: f.descrizione,
      importo: f.importo, pagatoDa: f.pagatoDa, technician_id: tecId, tecnico: tecName, km: f.km, nota: f.nota,
      addebitoCliente: !!e.addebitoCliente,
    };
    let id;
    if (cur) {
      id = String(cur.id);
      updateRow_('Spese', cur._row, rec);
    } else {
      id = newId_();
      rec.id = id; rec.rimborsatoIl = ''; rec.creataDa = 'Coordinatore';
      appendObj_('Spese', rec);
    }
    return { spesa: expOut_(find_('Spese', id)) };
  });
}

function api_expDel(pin, id) {
  checkPin_(pin);
  return withLock_(function () {
    const t = table_('Spese');
    const s = expById_(t, id);
    if (String(s.rimborsatoIl || '')) throw new Error('È già stata rimborsata: togli prima il rimborso.');
    t.sh.deleteRow(s._row);
    return true;
  });
}

// Segna come rimborsate (on = true, alla data indicata o a oggi) o toglie il rimborso (on = false). Solo le spese pagate
// da un tecnico si rimborsano.
function api_expReimburse(pin, ids, on, date) {
  checkPin_(pin);
  return withLock_(function () {
    const t = table_('Spese');
    needCols_(t, ['id', 'pagatoDa', 'rimborsatoIl']);
    if (!Array.isArray(ids) || !ids.length) throw new Error('Scegli almeno una spesa.');
    const day = on ? (dateOpt_(date, 'La data del rimborso') || todayStr_()) : '';
    const items = [];
    ids.forEach(function (id) {
      const s = expById_(t, id);
      if (on && String(s.pagatoDa) !== 'tecnico') throw new Error('Una delle spese è stata pagata dall\'azienda: non c\'è niente da rimborsare.');
      items.push({ row: s, patch: { rimborsatoIl: day } });
    });
    patchRows_(t, items);
    const want = {};
    ids.forEach(function (id) { want[String(id)] = true; });
    return { spese: table_('Spese').rows.filter(function (r) { return want[String(r.id)]; }).map(expOut_) };
  });
}

// ---------------------------------------------------------------------------
// API tecnico: liste di carico e scarico, spese (identificato dal suo link personale)
// ---------------------------------------------------------------------------

// Il tecnico può lavorare solo sugli eventi dove è in squadra e non ha detto di no
function techEvent_(token, eventId) {
  const t = techByToken_(token);
  const ev = find_('Eventi', eventId);
  const a = table_('Assegnazioni').rows.filter(function (r) {
    return String(r.event_id) === String(eventId) && String(r.technician_id) === String(t.id);
  })[0];
  if (!a || a.stato === 'rifiutato') throw new Error('Non sei in squadra per questo evento.');
  return { t: t, ev: ev, a: a };
}

function api_techListSet(token, eventId, kind, lineId, vals) {
  techByToken_(token);
  return withLock_(function () {
    techEvent_(token, eventId);
    return { riga: setListLine_(eventId, kind, lineId, vals, true) };
  });
}

function api_techListAll(token, eventId, kind, mode) {
  techByToken_(token);
  return withLock_(function () {
    techEvent_(token, eventId);
    setListAll_(eventId, kind, mode);
    return { materiale: publicLines_(eventId, tableOpt_('Carico'), catalogById_()) };
  });
}

// Il tecnico può dire «carico finito» (o riaprirlo). Lo scarico lo chiude il coordinatore: ha effetto sul magazzino.
function api_techLoadClose(token, eventId, close) {
  techByToken_(token);
  return withLock_(function () {
    const g = techEvent_(token, eventId);
    return { liste: closeLoad_(eventId, !!close, String(g.t.nome)) };
  });
}

function api_techEventLists(token, eventId) {
  techEvent_(token, eventId);
  const ev = find_('Eventi', eventId);
  return { materiale: publicLines_(eventId, tableOpt_('Carico'), catalogById_()), liste: listsOf_(ev) };
}

function api_techExpSave(token, eventId, e) {
  techByToken_(token);
  e = e || {};
  return withLock_(function () {
    const g = techEvent_(token, eventId);
    const t = table_('Spese');
    needCols_(t, ['id', 'event_id', 'evento', 'data', 'categoria', 'importo', 'pagatoDa', 'technician_id', 'tecnico',
      'rimborsatoIl', 'addebitoCliente', 'km', 'creataDa']);
    const f = expFields_(e, kmRate_());
    if (f.data > todayStr_()) throw new Error('La data della spesa non può essere nel futuro.');
    const cur = e.id ? expById_(t, e.id) : null;
    if (cur && (String(cur.technician_id) !== String(g.t.id) || String(cur.event_id) !== String(eventId))) {
      throw new Error('Questa spesa non è tua.');
    }
    if (cur && String(cur.rimborsatoIl || '')) throw new Error('È già stata rimborsata: non si può più cambiare.');
    const rec = {
      event_id: String(g.ev.id), evento: String(g.ev.cliente), data: f.data, categoria: f.categoria, descrizione: f.descrizione,
      importo: f.importo, pagatoDa: f.pagatoDa, technician_id: String(g.t.id), tecnico: String(g.t.nome), km: f.km, nota: f.nota,
    };
    let id;
    if (cur) {
      id = String(cur.id);
      updateRow_('Spese', cur._row, rec);
    } else {
      id = newId_();
      rec.id = id; rec.rimborsatoIl = ''; rec.addebitoCliente = false; rec.creataDa = String(g.t.nome);
      appendObj_('Spese', rec);
    }
    return { spesa: expPublic_(find_('Spese', id)) };
  });
}

function api_techExpDel(token, id) {
  const t0 = techByToken_(token);
  return withLock_(function () {
    const t = table_('Spese');
    const s = expById_(t, id);
    if (String(s.technician_id) !== String(t0.id)) throw new Error('Questa spesa non è tua.');
    if (String(s.rimborsatoIl || '')) throw new Error('È già stata rimborsata: non si può più togliere.');
    t.sh.deleteRow(s._row);
    return true;
  });
}

// I furgoni di un evento come li vede un tecnico: nome, targa, chi guida, e se guida lui
function vansPublic_(eventId, fe, fur, techId) {
  const furById = {};
  fur.rows.forEach(function (v) { furById[String(v.id)] = v; });
  return fe.rows.filter(function (f) { return String(f.event_id) === String(eventId); }).map(function (f) {
    const v = furById[String(f.van_id)];
    return clean_({
      id: String(f.van_id), nome: v ? v.nome : f.furgone, targa: v ? v.targa : '', autista: f.autista || '',
      tuo: !!(techId && String(f.autista_id) === String(techId)),
    });
  });
}

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------

// Giorno dopo una data AAAA-MM-GG (calcolato a mezzogiorno per non sbagliare nei cambi d'ora legale)
function nextDay_(dateStr) {
  const noon = Utilities.parseDate(dateStr + ' 12:00', TZ, 'yyyy-MM-dd HH:mm');
  return Utilities.formatDate(new Date(noon.getTime() + 86400000), TZ, 'yyyy-MM-dd');
}

// Finestra dell'invito: da arrivo/montaggio/ora fino a fine evento (o durata di Config).
// Se la fine è "prima" dell'inizio (es. inizio 21:00, fine 01:00) si intende dopo mezzanotte.
function eventWindow_(ev, durataOre) {
  const startStr = ev.orarioArrivo || ev.orarioMontaggio || ev.ora || ev.orarioInizioEvento || '09:00';
  const start = Utilities.parseDate(ev.data + ' ' + startStr, TZ, 'yyyy-MM-dd HH:mm');
  let end = null;
  if (ev.orarioFineEvento) {
    end = Utilities.parseDate(ev.data + ' ' + ev.orarioFineEvento, TZ, 'yyyy-MM-dd HH:mm');
    if (end.getTime() <= start.getTime()) {
      const next = Utilities.parseDate(nextDay_(ev.data) + ' ' + ev.orarioFineEvento, TZ, 'yyyy-MM-dd HH:mm');
      end = (next.getTime() - start.getTime() <= 18 * 3600 * 1000) ? next : null;
    }
  }
  if (!end) end = new Date(start.getTime() + durataOre * 3600 * 1000);
  return { start: start, end: end };
}

function deleteCalendarEvent_(calendarEventId) {
  const ce = CalendarApp.getDefaultCalendar().getEventById(String(calendarEventId));
  if (ce) ce.deleteEvent();   // annulla anche l'invito del tecnico
}

// Crea (o aggiorna) l'evento Calendar con il tecnico come invitato. Restituisce l'id dell'evento.
function upsertCalendarEvent_(a, ev, tec, cfg) {
  const email = String(tec.email || '').trim();
  if (!email) throw new Error(tec.nome + ' non ha un indirizzo email nella scheda Tecnici.');
  const w = eventWindow_(ev, Number(cfg.durata_evento_ore) || 4);
  // Finché il cliente non ha accettato, l'invito lo dice nel titolo: così nessuno lo scambia per un impegno sicuro
  const prov = STAGES_PROVVISORIE.indexOf(ev.stato) >= 0;
  const title = (prov ? '(da confermare) ' : '') + ev.cliente + ' - ' + a.ruoli;
  const desc = 'Convocazione: ' + ev.cliente + '\nStato: ' + (STAGE_LABEL[ev.stato] || ev.stato) +
    (prov ? ' (il cliente non ha ancora confermato)' : '') + '\nRuolo: ' + a.ruoli +
    (ev.luogo ? '\nLuogo: ' + ev.luogo : '') +
    (ev.noteTecnici ? '\nNote: ' + ev.noteTecnici : '') +
    '\n\nEvento, materiale da montare e risposta con un tocco: ' + appUrl_() + '?c=' + a.token;
  const cal = CalendarApp.getDefaultCalendar();
  let ce = null;
  if (a.calendarEventId) { try { ce = cal.getEventById(String(a.calendarEventId)); } catch (err) { ce = null; } }
  if (ce) {
    ce.setTitle(title);
    ce.setTime(w.start, w.end);
    ce.setLocation(ev.luogo || '');
    ce.setDescription(desc);
    return ce.getId();
  }
  ce = cal.createEvent(title, w.start, w.end, {
    guests: email, sendInvites: true, location: ev.luogo || '', description: desc,
  });
  return ce.getId();
}

function api_calendarInvite(pin, assignmentId) {
  checkPin_(pin);
  return withLock_(function () {
    const cfg = config_();
    const a = find_('Assegnazioni', assignmentId);
    const ev = find_('Eventi', a.event_id);
    if (ev.stato === 'annullato') throw new Error("L'evento è annullato: non posso mandare l'invito.");
    const tec = find_('Tecnici', a.technician_id);
    const ceId = upsertCalendarEvent_(a, ev, tec, cfg);
    if (String(a.calendarEventId) !== String(ceId)) {
      updateRow_('Assegnazioni', a._row, { calendarEventId: ceId, calendarRisposta: '' });
    }
    return clean_(find_('Assegnazioni', assignmentId));
  });
}

// Risposta di un invitato in Calendar: 'YES', 'NO' oppure '' (nessuna risposta, oppure "forse")
function guestAnswer_(status) {
  if (status === CalendarApp.GuestStatus.YES || String(status) === 'YES') return 'YES';
  if (status === CalendarApp.GuestStatus.NO || String(status) === 'NO') return 'NO';
  return '';
}

// Legge le risposte sì/no date dai tecnici dentro Google Calendar e le riporta nella scheda Assegnazioni.
// Ricorda l'ultima risposta di Calendar già letta (colonna calendarRisposta): così una risposta vecchia
// ("Sì" in Calendar) non scavalca una decisione più recente presa dal tecnico dal suo link ("Non posso").
function api_syncCalendar(pin) {
  checkPin_(pin);
  const cal = CalendarApp.getDefaultCalendar();
  const tecnici = table_('Tecnici').rows;
  const recent = addDaysStr_(-1);
  const live = {};   // eventi ancora da fare: guardo solo quelli, i passati non servono e rallentano
  table_('Eventi').rows.forEach(function (e) {
    if (String(e.data) >= recent && e.stato !== 'annullato') live[e.id] = true;
  });
  let n = 0;
  table_('Assegnazioni').rows.forEach(function (a) {
    if (!a.calendarEventId || !live[a.event_id]) return;
    const tec = tecnici.filter(function (t) { return t.id === a.technician_id; })[0];
    if (!tec || !tec.email) return;
    let ce = null;
    try { ce = cal.getEventById(String(a.calendarEventId)); } catch (err) { ce = null; }
    if (!ce) return;
    const g = ce.getGuestByEmail(String(tec.email).trim());
    if (!g) return;
    const answer = guestAnswer_(g.getGuestStatus());
    if (answer === String(a.calendarRisposta || '')) return;    // niente di nuovo su Calendar
    // Mentre parlavo con Calendar il foglio può essere cambiato (es. una convocazione tolta):
    // ritrovo la riga per id, dentro il blocco, invece di fidarmi del numero di riga letto prima.
    withLock_(function () {
      const cur = table_('Assegnazioni').rows.filter(function (r) { return String(r.id) === String(a.id); })[0];
      if (!cur) return;
      const patch = { calendarRisposta: answer };
      const ns = answer === 'YES' ? 'confermato' : (answer === 'NO' ? 'rifiutato' : '');
      if (ns && ns !== cur.stato) { patch.stato = ns; n++; }
      updateRow_('Assegnazioni', cur._row, patch);
      if (ns === 'rifiutato') clearDriver_(cur.event_id, cur.technician_id);
    });
  });
  return n;
}

// ---------------------------------------------------------------------------
// API tecnico (identificato dal suo link personale)
// ---------------------------------------------------------------------------

function techByToken_(token) {
  token = String(token || '').trim();
  if (!token) throw new Error('Link non valido.');
  const t = table_('Tecnici').rows.filter(function (r) { return String(r.token) === token; })[0];
  if (!t || String(t.attivo).toLowerCase() === 'false') throw new Error('Link non valido o tecnico non attivo.');
  return t;
}

// Materiale di un evento come lo vede un tecnico (un elenco di righe senza giacenze né prezzi)
function publicLines_(eventId, car, catById) {
  return car.rows.filter(function (c) { return String(c.event_id) === String(eventId) && toInt_(c.quantita, 0) >= 1; })
    .map(function (c) { return carPublic_(c, catById); });
}

function catalogById_() {
  const byId = {};
  tableOpt_('Materiali').rows.forEach(function (m) { byId[String(m.id)] = m; });
  return byId;
}

function api_techInit(token) {
  const t = techByToken_(token);
  const oggi = todayStr_();
  const recentFrom = addDaysStr_(-RECENT_DAYS), veryRecent = addDaysStr_(-3);
  const eventi = table_('Eventi').rows;
  const catById = catalogById_();
  const car = tableOpt_('Carico');
  const fe = tableOpt_('FurgoniEvento'), fur = tableOpt_('Furgoni');
  // Le spese: il tecnico vede solo le sue
  const mineExp = {};
  tableOpt_('Spese').rows.forEach(function (x) {
    if (String(x.technician_id) !== String(t.id)) return;
    (mineExp[String(x.event_id)] = mineExp[String(x.event_id)] || []).push(expPublic_(x));
  });
  const mie = [], recenti = [], annullati = [];
  table_('Assegnazioni').rows.forEach(function (a) {
    if (a.technician_id !== t.id) return;
    const ev = eventi.filter(function (e) { return e.id === a.event_id; })[0];
    if (!ev) return;
    const past = String(ev.data) < oggi;
    if (past && String(ev.data) < recentFrom) return;
    if (ev.stato === 'annullato') {
      // Un evento annullato non sparisce in silenzio: il tecnico deve saperlo (a meno che avesse già detto di no)
      if (!past && a.stato !== 'rifiutato') annullati.push({ evento: evPublic_(ev), ruoli: String(a.ruoli || '') });
      return;
    }
    const item = {
      assegnazione: asgPublic_(a), evento: evPublic_(ev), materiale: publicLines_(ev.id, car, catById),
      furgoni: vansPublic_(ev.id, fe, fur, t.id), liste: listsOf_(ev), spese: mineExp[String(ev.id)] || [],
    };
    if (!past) { mie.push(item); return; }
    // Evento appena passato: lo si vede se c'è ancora qualcosa da fare (scarico, spese da rimborsare) o è di pochissimi giorni fa
    if (a.stato === 'rifiutato') return;
    const loaded = !!item.liste.caricoQuando || item.materiale.some(function (l) { return l.caricato > 0; });
    const needsUnload = loaded && !item.liste.scaricoQuando;
    const unpaid = item.spese.some(function (x) { return x.pagatoDa === 'tecnico' && !x.rimborsatoIl; });
    if (String(ev.data) >= veryRecent || needsUnload || unpaid) recenti.push(item);
  });
  const key = function (e) { return String(e.data) + String(e.ora); };
  mie.sort(function (x, y) { return key(x.evento).localeCompare(key(y.evento)); });
  recenti.sort(function (x, y) { return key(y.evento).localeCompare(key(x.evento)); });
  annullati.sort(function (x, y) { return key(x.evento).localeCompare(key(y.evento)); });
  const disp = table_('Disponibilita').rows
    .filter(function (d) { return d.technician_id === t.id && String(d.data) >= oggi; })
    .map(function (d) { return clean_({ data: d.data, disponibile: isTrue_(d.disponibile), oraDa: d.oraDa }); });
  return {
    tecnico: { nome: t.nome, ruoli: String(t.ruoli || '') }, oggi: oggi, mie: mie, recenti: recenti, annullati: annullati,
    disponibilita: disp, tariffa_km: kmRate_(), durata_evento_ore: Number(config_().durata_evento_ore) || 4,
  };
}

// disponibile: true / false / null (null = cancella la risposta di quel giorno)
function api_techSetAvailability(token, data, disponibile, oraDa) {
  const t = techByToken_(token);
  data = String(data || '');
  if (!validDate_(data)) throw new Error('Data non valida.');
  if (data < todayStr_() || data > addDaysStr_(MAX_DAYS_AHEAD)) throw new Error('Data fuori dal periodo consentito.');
  const clear = disponibile === null || disponibile === undefined;
  oraDa = (!clear && disponibile) ? String(oraDa || '') : '';
  if (oraDa && !validTime_(oraDa)) throw new Error('Orario non valido.');
  return withLock_(function () {
    const cur = table_('Disponibilita').rows.filter(function (d) {
      return d.technician_id === t.id && d.data === data;
    })[0];
    if (clear) {
      if (cur) sheet_('Disponibilita').deleteRow(cur._row);
    } else if (cur) {
      updateRow_('Disponibilita', cur._row, { disponibile: !!disponibile, oraDa: oraDa });
    } else {
      appendObj_('Disponibilita', {
        technician_id: t.id, tecnico: t.nome, data: data, disponibile: !!disponibile, oraDa: oraDa,
      });
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Conferma / rifiuto di una convocazione (link ?c=TOKEN o pagina personale)
// ---------------------------------------------------------------------------

function assignmentByToken_(token) {
  token = String(token || '').trim();
  if (!token) throw new Error('Link non valido.');
  const a = table_('Assegnazioni').rows.filter(function (r) { return String(r.token) === token; })[0];
  if (!a) throw new Error('Convocazione non trovata (forse è stata annullata).');
  return a;
}

function api_confirmInit(token) {
  const a = assignmentByToken_(token);
  const ev = find_('Eventi', a.event_id);
  return {
    nome: String(a.tecnico || ''), ruoli: String(a.ruoli || ''), stato: String(a.stato || ''),
    evento: evPublic_(ev),
    materiale: ev.stato === 'annullato' ? [] : publicLines_(ev.id, tableOpt_('Carico'), catalogById_()),
    furgoni: ev.stato === 'annullato' ? [] : vansPublic_(ev.id, tableOpt_('FurgoniEvento'), tableOpt_('Furgoni'), a.technician_id),
  };
}

function api_respond(token, stato) {
  if (['confermato', 'rifiutato'].indexOf(stato) < 0) throw new Error('Risposta non valida.');
  return withLock_(function () {
    const a = assignmentByToken_(token);
    const ev = find_('Eventi', a.event_id);
    if (ev.stato === 'annullato') throw new Error('Questo evento è stato annullato.');
    updateRow_('Assegnazioni', a._row, { stato: stato });
    if (stato === 'rifiutato') clearDriver_(a.event_id, a.technician_id);
    return stato;
  });
}

// ---------------------------------------------------------------------------
// Pagina dell'applicazione (HTML). Non serve toccarla: sta qui per avere un solo file da incollare.
// ---------------------------------------------------------------------------
const INDEX_HTML = `<!DOCTYPE html>
<html lang="it">
<head>
<base target="_top">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Gestionale service</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Barlow+Condensed:wght@600;700&display=swap" rel="stylesheet">
<style>
:root{
  --cond:'Barlow Condensed','Arial Narrow','Roboto Condensed','Helvetica Neue',Arial,sans-serif;
  --sans:'Barlow','Segoe UI',system-ui,-apple-system,Roboto,'Helvetica Neue',Arial,sans-serif;
  --bg:#e5e8ec; --card:#ffffff; --ink:#12151a; --ink2:#454b57; --line:#c5cad2; --line2:#dde1e6; --rule:#12151a;
  --tape:#ffd000; --on-tape:#12151a; --focus:#1a56e8;
  --mast:#12151a;
  --ok:#0c7044; --okbg:#d5f0e3; --warn:#8a5700; --warnbg:#ffefc0; --bad:#b3261e; --badbg:#fbdad6;
  --go:#0e7a4b; --go-ink:#ffffff; --bad-solid:#b3261e;
  --btn-line:#12151a; --pri-line:#12151a;
  --r-fonico:#2457d6; --r-fonico-bg:#dce6fb;
  --r-luci:#b45f00; --r-luci-bg:#fde5c6;
  --r-video:#a1288d; --r-video-bg:#f5d9f0;
  --r-aiutante:#12805a; --r-aiutante-bg:#d3efe2;
  --st-richiesta:#7a8393; --st-sopralluogo:#2457d6; --st-preventivo:#b45f00;
  --st-confermato:#12805a; --st-concluso:#454b57; --st-annullato:#b3261e;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0f1114; --card:#181b20; --ink:#f1f2f4; --ink2:#a6acb7; --line:#363c46; --line2:#242932; --rule:#6a7280;
    --focus:#ffd000;
    --mast:#000000;
    --ok:#4fd9a0; --okbg:#123528; --warn:#ffc24d; --warnbg:#3a2c0a; --bad:#ff8a80; --badbg:#431b18;
    --go:#2fbf86; --go-ink:#04180f; --bad-solid:#d9382d;
    --btn-line:#6a7280; --pri-line:#ffd000;
    --r-fonico:#7ea6ff; --r-fonico-bg:#1b2745;
    --r-luci:#ffb347; --r-luci-bg:#3a2a10;
    --r-video:#ff86dc; --r-video-bg:#3d1c37;
    --r-aiutante:#4fd9a0; --r-aiutante-bg:#123528;
    --st-richiesta:#8c95a5; --st-sopralluogo:#7ea6ff; --st-preventivo:#ffb347;
    --st-confermato:#4fd9a0; --st-concluso:#a6acb7; --st-annullato:#ff8a80;
  }
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%;scroll-padding-top:70px}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 var(--sans);-webkit-font-smoothing:antialiased;min-height:100vh;overflow-wrap:anywhere}
body.noscroll{overflow:hidden}
button,input,select,textarea{font:inherit;color:inherit}
h1,h2,h3,h4,p,ul,ol,dl,dd,figure{margin:0}
ul,ol{padding:0;list-style:none}
a{color:inherit}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.wrap{--gut:16px;max-width:760px;margin:0 auto;padding:0 var(--gut)}
.narrow{max-width:560px}
.cond{font-family:var(--cond)}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.muted{color:var(--ink2)}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.grow{flex:1}

/* barra in alto */
.mast{background:var(--mast);color:#fff}
.mastin{display:flex;align-items:center;justify-content:space-between;min-height:56px;gap:8px}
.brand{font:700 24px/1 var(--cond);letter-spacing:.01em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brand small{display:block;margin-top:3px;font:500 13px/1.1 var(--sans);opacity:.72}
.mastact{display:flex;gap:2px;flex:none}
.ib{width:44px;height:44px;display:inline-grid;place-items:center;background:transparent;border:0;border-radius:6px;color:inherit;cursor:pointer;flex:none}
.ib:hover{background:rgba(127,127,127,.22)}
.ico{width:22px;height:22px;flex:none}
.stick{position:sticky;top:0;z-index:30}
.tabs{background:var(--mast)}
.tabsin{display:flex;gap:4px;padding-top:2px;padding-bottom:0}
.tab{flex:1 1 auto;min-width:0;min-height:50px;background:transparent;border:0;border-radius:6px 6px 0 0;font:700 clamp(16px,4.9vw,20px)/1 var(--cond);color:#c9ced6;cursor:pointer;padding:0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tab[aria-selected=true]{background:var(--tape);color:#12151a}
.hazard{height:7px;background:repeating-linear-gradient(-45deg,var(--tape) 0 9px,#12151a 9px 18px)}
.main{padding-top:6px;padding-bottom:96px}

/* azioni e controlli */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:46px;padding:0 18px;border:2px solid var(--btn-line);border-radius:6px;background:transparent;color:var(--ink);font-weight:600;font-size:16px;line-height:1.1;cursor:pointer;text-decoration:none;text-align:center}
.btn:hover{background:rgba(127,127,127,.14)}
.btn.pri{background:var(--tape);border-color:var(--pri-line);color:var(--on-tape)}
.btn.pri:hover{background:#ffdc33}
.btn.go{background:var(--go);border-color:var(--go);color:var(--go-ink)}
.btn.no{background:transparent;border-color:var(--bad);color:var(--bad)}
.btn.sm{min-height:38px;padding:0 12px;font-size:15px}
.btn.danger{color:var(--bad);border-color:var(--bad)}
.btn.armed{background:var(--bad-solid);border-color:var(--bad-solid);color:#fff}
.btn.big{min-height:60px;font:700 24px/1 var(--cond);flex:1}
.btn[disabled],.btn[aria-disabled=true]{opacity:.45;cursor:not-allowed;pointer-events:none}
.btn .ico{width:18px;height:18px}
body.busy{cursor:progress}
.fld{display:block;margin-top:14px}
.fld>span,.fld>legend{display:block;font-size:14px;font-weight:600;color:var(--ink2);margin-bottom:5px;padding:0}
fieldset.fld{border:0;padding:0;margin-left:0;margin-right:0;min-width:0}
input[type=text],input[type=tel],input[type=email],input[type=url],input[type=password],input[type=search],input[type=date],input[type=time],input[type=number],select,textarea{width:100%;min-height:46px;padding:9px 11px;border:2px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)}
input[type=date],input[type=time]{min-width:0}
textarea{min-height:88px;resize:vertical}
.chk{display:inline-flex;align-items:center;gap:10px;min-height:44px;cursor:pointer;font-weight:500}
.chk input{width:22px;height:22px;accent-color:var(--ink);margin:0}
.hint{font-size:14px;color:var(--ink2);margin-top:6px}
.ferr{color:var(--bad);font-weight:600;margin-top:12px;min-height:1.2em}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:360px){.grid2.qtys{grid-template-columns:1fr}}
.steps{display:grid;grid-template-columns:1fr;gap:10px}
@media(min-width:560px){.steps{grid-template-columns:1fr 1fr}}
.step{display:flex;align-items:center;justify-content:space-between;gap:6px;border:2px solid var(--line);border-left:7px solid var(--rc,var(--line));border-radius:6px;background:var(--card);padding:4px 6px 4px 10px;min-width:0}
.step .lbl{flex:1;white-space:nowrap;font:700 19px/1 var(--cond)}
.step .ctl{display:flex;align-items:center;gap:2px}
.step button{width:40px;height:40px;border-radius:6px;border:2px solid var(--btn-line);background:transparent;font:600 22px/1 var(--sans);cursor:pointer}
.step output{min-width:26px;text-align:center;font:700 24px/1 var(--cond)}
.rolepick{display:flex;flex-wrap:wrap;gap:8px}
.rolepick label{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 14px;border:2px solid var(--rc);border-radius:3px;background:var(--card);font-weight:600;cursor:pointer}
.rolepick input{width:20px;height:20px;margin:0;accent-color:var(--rc)}
.rolepick label:has(input:checked){background:var(--rb)}

/* ruoli, caselle, etichette di stato */
.r-fonico{--rc:var(--r-fonico);--rb:var(--r-fonico-bg)}
.r-luci{--rc:var(--r-luci);--rb:var(--r-luci-bg)}
.r-video{--rc:var(--r-video);--rb:var(--r-video-bg)}
.r-aiutante{--rc:var(--r-aiutante);--rb:var(--r-aiutante-bg)}
.slots{display:flex;flex-wrap:wrap;gap:6px}
.slot{--rc:var(--ink2);--rb:transparent;display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:3px 9px;border:2px solid var(--rc);border-radius:3px;background:var(--rb);font-size:14px;line-height:1.1;font-weight:600;color:var(--ink);max-width:100%}
.slot .sr{font-family:var(--cond);font-size:16px;font-weight:700}
.slot .sn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.slot .ico{width:14px;height:14px;flex:none}
.slot.open{background:transparent;border-style:dashed;color:var(--ink2)}
.slot.pend{background:repeating-linear-gradient(135deg,var(--rb) 0 6px,transparent 6px 12px)}
.slot.extra{border-style:dotted}
.chip{display:inline-flex;align-items:center;gap:5px;min-height:26px;padding:1px 8px;border:2px solid var(--rc);border-radius:3px;background:var(--rb);font:700 15px/1 var(--cond);color:var(--ink)}
.chip.off{opacity:.7;text-decoration:line-through}
button.chip{cursor:pointer;min-height:34px}
.pill{display:inline-block;font:700 15px/1 var(--cond);padding:4px 8px;border-radius:3px;white-space:nowrap}
.pill.ok{background:var(--okbg);color:var(--ok)}
.pill.warn{background:var(--warnbg);color:var(--warn)}
.pill.bad{background:var(--badbg);color:var(--bad)}
.pill.muted{background:var(--line2);color:var(--ink2)}
.pill.blue{background:var(--r-fonico-bg);color:var(--r-fonico)}

/* elenco eventi */
.toolbar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;padding:14px 0 2px}
.day{margin-top:2px}
.dayh{display:flex;align-items:baseline;gap:12px;padding:20px 0 8px;border-bottom:3px solid var(--rule)}
.dnum{font:700 46px/.85 var(--cond)}
.dtxt{font:600 18px/1.05 var(--cond);color:var(--ink2)}
.dtxt b{display:block;color:var(--ink);font-weight:700;font-size:22px}
.dtag{margin-left:auto;font:700 15px/1 var(--cond);padding:5px 9px;border-radius:3px;background:var(--tape);color:#12151a}
.dtag.soft{background:transparent;color:var(--ink2);border:1px solid var(--line)}
.ev{--st:var(--st-richiesta);background:var(--card);border-left:7px solid var(--st);border-bottom:1px solid var(--line2)}
.st-richiesta{--st:var(--st-richiesta)}
.st-sopralluogo{--st:var(--st-sopralluogo)}
.st-preventivo{--st:var(--st-preventivo)}
.st-confermato{--st:var(--st-confermato)}
.st-concluso{--st:var(--st-concluso)}
.st-annullato{--st:var(--st-annullato)}
.evh{display:block;width:100%;text-align:left;background:none;border:0;padding:13px 14px 13px 12px;cursor:pointer}
.evh:hover{background:rgba(127,127,127,.07)}
.evtop{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.evt{font:700 25px/1.02 var(--cond);overflow-wrap:anywhere}
.st-annullato .evt{text-decoration:line-through;color:var(--ink2)}
.evsub{display:flex;flex-wrap:wrap;gap:3px 16px;margin-top:6px;color:var(--ink2);font-size:15px}
.evsub b{color:var(--ink);font-weight:600}
.evsub .alert{color:var(--bad);font-weight:700}
.evh .slots{margin-top:10px}
.panel{padding:2px 14px 18px 12px;border-top:1px dashed var(--line)}
.panel h4{font:700 20px/1.1 var(--cond);margin:18px 0 8px}
.panel h5{font:600 15px/1.2 var(--sans);margin:14px 0 6px;color:var(--ink2)}
.times{display:flex;flex-wrap:wrap;gap:8px 22px;margin:12px 0 4px}
.times dt{font-size:13px;color:var(--ink2);font-weight:500}
.times dd{font:700 26px/1 var(--cond)}
.facts{margin-top:8px;display:grid;gap:4px;font-size:15px}
.facts .k{color:var(--ink2)}
.asgs>li{padding:12px 0;border-top:1px solid var(--line2)}
.asgs>li:first-child{border-top:0}
.asgtop{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}
.asgtop b{font:700 21px/1.05 var(--cond)}
.asg.rifiutato b{text-decoration:line-through;color:var(--ink2)}
.note{font-size:14.5px;margin-top:5px}
.note.bad{color:var(--bad);font-weight:600}
.note.warn{color:var(--warn);font-weight:600}
.note.muted{color:var(--ink2)}
.asgact{display:flex;flex-wrap:wrap;gap:8px;margin-top:9px;align-items:center}
.asgact select{width:auto;min-height:38px;padding:4px 8px;font-size:15px;border-radius:6px}
.sent{display:inline-flex;align-items:center;gap:5px;font-size:14px;color:var(--ok);font-weight:600}
.sent .ico{width:16px;height:16px}
.chip .ico{width:12px;height:12px}
.box{margin-top:14px;padding:12px 14px;background:var(--card);border:2px solid var(--rule);border-radius:4px}
.box.prop{border-color:var(--tape);border-width:3px}
.box h4{margin-top:0}
.pickrow{padding:9px 0;border-top:1px solid var(--line2)}
.pickrow:first-of-type{border-top:0}
.cands>li{padding:11px 0;border-top:1px solid var(--line2)}
.cands>li:first-child{border-top:0}
.cname{font:700 20px/1.05 var(--cond)}
.empty{padding:26px 4px;color:var(--ink2);font-size:16px}
.pageerr{margin:22px 0;padding:16px;border:2px solid var(--bad);border-radius:4px;background:var(--card)}
.pageerr h2{font:700 24px/1.1 var(--cond);color:var(--bad);margin-bottom:6px}
.banner{margin-top:12px;padding:10px 12px;border-left:6px solid var(--warn);background:var(--warnbg);color:var(--ink);font-size:15px}

/* tecnici */
.tec{background:var(--card);border-left:7px solid var(--rule);margin-top:10px;padding:13px 14px}
.tec.inactive{opacity:.7;border-left-color:var(--line)}
.tname{font:700 25px/1.05 var(--cond)}
.tinfo{display:grid;gap:3px;margin-top:8px;font-size:15px;color:var(--ink2)}
.tinfo a{color:var(--ink);font-weight:600}
.tact{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}

/* matrice disponibilità */
.mxw{overflow-x:auto;margin:10px calc(-1*var(--gut,16px)) 0;padding:0 var(--gut,16px) 10px;-webkit-overflow-scrolling:touch}
table.mx{border-collapse:separate;border-spacing:0}
.mx th,.mx td{padding:0;text-align:center;font-weight:400}
.mx .nm{position:sticky;left:0;z-index:2;background:var(--bg);text-align:left;min-width:108px;max-width:120px;padding:5px 10px 5px 0;font:700 18px/1.05 var(--cond);border-right:2px solid var(--rule);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mx .dh{min-width:46px;padding:8px 2px 6px;font:700 21px/1 var(--cond)}
.mx .dh small{display:block;margin-bottom:2px;font:600 12.5px/1.1 var(--sans);color:var(--ink2)}
.mx .dh.we{color:var(--bad)}
.mx .dh.mo{border-left:3px solid var(--rule)}
.mx .evc{font:600 13px/1 var(--sans);color:var(--ink2);padding:2px 0 6px}
.mx tfoot td,.mx tfoot th{padding-top:6px;font:700 17px/1 var(--cond);color:var(--ink2)}
.cell{display:block;width:42px;height:40px;margin:2px;border-radius:4px;border:2px solid transparent;background:var(--line2);color:var(--ink2);font:700 15px/1 var(--cond);cursor:pointer;padding:0;position:relative}
.cell.yes{background:var(--okbg);color:var(--ok);border-color:var(--ok)}
.cell.from{background:var(--warnbg);color:var(--warn);border-color:var(--warn)}
.cell.no{background:var(--badbg);color:var(--bad);border-color:var(--bad)}
.cell.busy::after{content:"";position:absolute;left:3px;right:3px;bottom:3px;height:5px;background:var(--ink)}
.legend{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:12px;font-size:14px;color:var(--ink2)}
.legend span{display:inline-flex;align-items:center;gap:7px}
.legend i{display:inline-block;width:22px;height:18px;border-radius:3px;border:2px solid transparent;background:var(--line2)}
.legend i.yes{background:var(--okbg);border-color:var(--ok)}
.legend i.from{background:var(--warnbg);border-color:var(--warn)}
.legend i.no{background:var(--badbg);border-color:var(--bad)}
.legend i.busy{position:relative}
.legend i.busy::after{content:"";position:absolute;left:2px;right:2px;bottom:2px;height:4px;background:var(--ink)}

/* materiale e magazzino (coordinatore) */
.fld>span.qty{display:inline-flex;margin:0;font-size:inherit;font-weight:inherit;color:inherit}
.qty{display:inline-flex;align-items:stretch;border:2px solid var(--line);border-radius:6px;background:var(--card);max-width:100%}
.qty button{width:44px;min-height:44px;border:0;background:transparent;font:600 26px/1 var(--sans);cursor:pointer;color:var(--ink);flex:none;padding:0}
.qty button:hover{background:rgba(127,127,127,.16)}
.qty input[type=number]{width:56px;min-height:44px;padding:0 2px;border:0;border-left:2px solid var(--line);border-right:2px solid var(--line);border-radius:0;text-align:center;font:700 23px/1 var(--cond);-moz-appearance:textfield;appearance:textfield}
.qty input[type=number]::-webkit-outer-spin-button,.qty input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.matsum{margin-top:2px;display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;color:var(--ink2);font-size:15px}
.mats>li{border-top:1px solid var(--line2)}
.mats>li:first-child{border-top:0}
.mrow.open{background:rgba(127,127,127,.06)}
.mline{display:flex;align-items:center;gap:10px;width:100%;min-height:54px;padding:8px 4px;background:none;border:0;text-align:left;cursor:pointer;color:inherit}
.mline:hover{background:rgba(127,127,127,.07)}
.mq{flex:none;min-width:34px;text-align:right;font:700 27px/1 var(--cond)}
.mrow.short .mq{color:var(--bad)}
.mn{flex:1;min-width:0;font-weight:600;line-height:1.2}
.mn small{display:block;margin-top:1px;font-size:14px;font-weight:400;color:var(--ink2)}
.mp{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none;max-width:44%}
.medit{padding:2px 4px 16px}
.medit .asgact{margin-top:12px}
.warnt{color:var(--warn);font-weight:700}
.srch{margin-top:12px}
.cats{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.cat{min-height:42px;padding:0 12px;border:2px solid var(--line);border-radius:4px;background:var(--card);color:var(--ink);font:700 19px/1 var(--cond);cursor:pointer}
.cat[aria-pressed=true]{background:var(--tape);border-color:var(--pri-line);color:var(--on-tape)}
.pick{margin-top:8px}
.pk{display:flex;align-items:center;gap:10px;padding:10px 4px 10px 12px;border-top:1px solid var(--line2)}
.pk:first-child{border-top:0}
.pk.sel{background:rgba(255,208,0,.16);box-shadow:inset 5px 0 0 var(--tape)}
.pkm{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.pkm b{font:700 21px/1.05 var(--cond)}
.pkm small{font-size:14px;color:var(--ink2)}
.pkav{font-size:14px;font-weight:700}
.pkav.ok{color:var(--ok)}
.pkav.warn{color:var(--warn)}
.pkav.bad{color:var(--bad)}
.pkin{font-size:13.5px;color:var(--ink2)}
.pk .qty button{width:40px}
.pk .qty input[type=number]{width:50px}
.sheetfoot.sticky{position:sticky;bottom:0;margin:10px -16px -24px;padding:12px 16px 14px;background:var(--bg);border-top:1px solid var(--line);z-index:3}
details.free{margin-top:16px;border-top:1px dashed var(--line);padding-top:2px}
details.free>summary{display:flex;align-items:center;min-height:46px;cursor:pointer;font-weight:600;color:var(--ink2)}
.cpl{display:grid;gap:8px;margin-top:10px}
.cpb{flex-direction:column;align-items:flex-start;gap:2px;width:100%;text-align:left;min-height:62px;padding:9px 14px}
.cpn{font:700 22px/1.05 var(--cond)}
.cpd{font-size:14px;font-weight:500;color:var(--ink2)}
.datebar{display:flex;flex-wrap:wrap;gap:0 20px;align-items:flex-end;margin-top:4px}
.datebar .fld{flex:0 1 230px;margin-top:8px}
.datebar .chk{margin-top:6px}
.catsep{font:700 22px/1 var(--cond);color:var(--ink2);padding:20px 0 6px;border-bottom:3px solid var(--rule)}
.stk{background:var(--card);border-left:7px solid var(--line);border-bottom:1px solid var(--line2)}
.stk.open{border-left-color:var(--rule)}
.stk.off{opacity:.7}
.stkh{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-height:58px;padding:9px 12px 9px 10px;background:none;border:0;text-align:left;cursor:pointer;color:inherit}
.stkh:hover{background:rgba(127,127,127,.07)}
.stkn{min-width:0;font:700 22px/1.05 var(--cond)}
.stkn small{display:block;margin-top:2px;font:400 14px/1.2 var(--sans);color:var(--ink2)}
.stkc{display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex:none;max-width:48%;text-align:right}
.stkc small{font-size:13px;color:var(--ink2)}
.stkd{display:grid;gap:6px;padding:4px 12px 14px 10px;border-top:1px dashed var(--line);font-size:15px}
.stkd .row{margin-top:4px}

/* cambio di stato e avvisi */
.stline{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;margin-top:14px;font-size:15px}
.stn{font-weight:600}
.radios{display:grid;gap:8px}
.radio{display:flex;align-items:flex-start;gap:12px;min-height:58px;padding:10px 12px;border:2px solid var(--line);border-left:7px solid var(--st);border-radius:6px;background:var(--card);cursor:pointer}
.radio input{width:22px;height:22px;margin:2px 0 0;accent-color:var(--ink);flex:none}
.radio:has(input:checked){border-color:var(--ink);border-left-color:var(--st);box-shadow:inset 0 0 0 1px var(--ink)}
.radio span{display:flex;flex-direction:column;gap:1px}
.radio b{font:700 21px/1.05 var(--cond)}
.radio small{font-size:14px;color:var(--ink2)}
.avl>li{padding:11px 0;border-top:1px solid var(--line2)}
.avl>li:first-child{border-top:0}

/* finestra a scorrimento (moduli) */
.sheetwrap{position:fixed;inset:0;z-index:60;background:rgba(8,10,14,.62);display:flex;align-items:flex-end;justify-content:center}
.sheet{width:100%;max-width:640px;max-height:94vh;max-height:94dvh;overflow:auto;overscroll-behavior:contain;background:var(--bg);border-radius:14px 14px 0 0;padding:0 16px 24px;border-top:7px solid var(--tape)}
.sheet:focus{outline:none}
.sheethead{display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--bg);padding:12px 0 6px;z-index:2}
.sheethead h2{font:700 29px/1 var(--cond)}
.sheetfoot{display:flex;gap:10px;margin-top:20px}
.sheetfoot .btn{flex:1 1 auto}
.sheetfoot .btn.pri{flex:2 1 auto}
.sheetfoot .btn:not(.pri):not(:only-child){flex:0 0 auto;white-space:nowrap}
@media(min-width:700px){.sheetwrap{align-items:center}.sheet{border-radius:8px}}
.copybox{width:100%;margin-top:10px}

/* notifiche */
#toast{position:fixed;left:50%;bottom:18px;transform:translate(-50%,16px);width:max-content;max-width:min(92vw,540px);background:var(--ink);color:var(--bg);padding:12px 16px;border-radius:6px;font-weight:600;line-height:1.3;opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;z-index:120}
#toast.on{opacity:1;transform:translate(-50%,0)}
#toast.err{background:var(--bad-solid);color:#fff}
#toast.ok{background:var(--go);color:var(--go-ink)}
#bar{position:fixed;top:0;left:0;height:4px;width:0;background:var(--tape);z-index:200;opacity:0;pointer-events:none;transition:opacity .25s}
#bar.on{opacity:1;width:82%;transition:width 9s cubic-bezier(.1,.7,.2,1),opacity .1s}

/* accesso */
.login{max-width:420px;margin:0 auto;padding:36px 16px}
.login h1{font:700 40px/1 var(--cond);margin-bottom:6px}
.login p{color:var(--ink2)}

/* pagina del tecnico */
.hello{font:700 44px/1 var(--cond);margin-top:22px}
.sec{margin-top:30px}
.sec>h2{font:700 28px/1 var(--cond);padding-bottom:8px;border-bottom:3px solid var(--rule)}
.card{--st:var(--rule);background:var(--card);border-left:7px solid var(--st);padding:14px;margin-top:12px}
.card.pendente{--st:var(--tape)}
.card.confermato{--st:var(--st-confermato)}
.card.rifiutato{--st:var(--st-annullato)}
.card .when{font:700 18px/1 var(--cond);color:var(--ink2)}
.card h3{font:700 28px/1.02 var(--cond);margin-top:4px;overflow-wrap:anywhere}
.card .btns{display:flex;gap:10px;margin-top:14px}
.drow{display:grid;grid-template-columns:62px 1fr;gap:6px 12px;align-items:center;padding:11px 0;border-bottom:1px solid var(--line2)}
.drow.we{background:linear-gradient(90deg,rgba(127,127,127,.09),transparent)}
.drow .dc{text-align:center;line-height:1}
.drow .dc b{display:block;font:700 36px/.9 var(--cond)}
.drow .dc span{font-size:13px;color:var(--ink2);font-weight:600}
.tgs{display:flex;gap:8px}
.tg{flex:1;min-height:54px;display:inline-flex;align-items:center;justify-content:center;gap:8px;border:2px solid var(--btn-line);border-radius:6px;background:var(--card);font:700 23px/1 var(--cond);cursor:pointer;color:var(--ink)}
.tg .ico{width:20px;height:20px}
.tg.yes.on{background:var(--go);border-color:var(--go);color:var(--go-ink)}
.tg.no.on{background:var(--bad-solid);border-color:var(--bad-solid);color:#fff}
.drow .more{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;padding-left:74px;font-size:15px}
.drow .more label{display:flex;align-items:center;gap:8px}
.drow .more input[type=time]{width:128px;min-height:42px}
.drow .conv{color:var(--ink);font-weight:600}
.drow.saving{opacity:.6}
.monthsep{padding:18px 0 4px;font:700 22px/1 var(--cond);color:var(--ink2)}
.foot{margin-top:34px;color:var(--ink2);font-size:14px}

/* fase dell'evento e materiale, nella pagina del tecnico */
.card.annullato{--st:var(--st-annullato)}
.card.annullato h3{text-decoration:line-through;color:var(--ink2)}
.stage{display:grid;gap:3px;margin-top:12px;padding:9px 12px;border-left:6px solid var(--st,var(--rule));background:var(--line2)}
@supports (background:color-mix(in srgb,red 10%,white)){.stage{background:color-mix(in srgb,var(--st,var(--rule)) 11%,var(--card))}}
.stl{font:700 23px/1.05 var(--cond)}
.stt{font-size:15px}
.stnote{font-size:15px;font-weight:600}
.stage small{font-size:13px;color:var(--ink2)}
details.mat{margin-top:14px;border:2px solid var(--line);border-radius:6px;background:var(--card)}
details.mat>summary{display:flex;align-items:center;gap:10px;min-height:54px;padding:6px 12px;cursor:pointer;list-style:none}
details.mat>summary::-webkit-details-marker{display:none}
details.mat>summary::after{content:"";width:9px;height:9px;margin:0 3px 3px 4px;border-right:3px solid var(--ink2);border-bottom:3px solid var(--ink2);transform:rotate(45deg);flex:none;transition:transform .15s}
details.mat[open]>summary::after{transform:rotate(-135deg);margin-bottom:-3px}
.mt{font:700 23px/1 var(--cond)}
.mc{margin-left:auto;font-size:14px;color:var(--ink2);text-align:right}
.mbody{padding:0 12px 12px;border-top:1px dashed var(--line)}
.mcat{display:flex;align-items:baseline;gap:8px;margin:14px 0 2px;font:700 20px/1 var(--cond)}
.mcat small{font:600 13px/1 var(--sans);color:var(--ink2)}
.mcat.mine{color:var(--ink)}
.ml>li{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line2)}
.ml>li:first-child{border-top:0}
.lq{flex:none;min-width:34px;text-align:right;font:700 25px/1 var(--cond)}
.ln{flex:1;min-width:0;font-weight:500;line-height:1.25}
.ln small{display:block;font-size:14px;font-weight:400;color:var(--ink2)}
.nomat{margin-top:12px;font-size:15px;color:var(--ink2)}

/* ---------- liste di carico e di scarico (coordinatore e tecnico) ---------- */
.lev{margin-top:4px;font:500 17px/1.3 var(--sans);color:var(--ink2)}
.lev b{color:var(--ink);font-weight:600}
.lprog{display:flex;align-items:center;gap:14px;margin-top:12px}
.lcount{flex:none;font-size:15px;color:var(--ink2)}
.lcount b{font:700 28px/1 var(--cond);color:var(--ink)}
.prog{display:block;flex:1;height:12px;border:2px solid var(--ink);border-radius:3px;background:var(--card);overflow:hidden}
.prog i{display:block;height:100%;background:var(--tape);transition:width .2s}
.prog.full i{background:var(--go)}
.banner.ok{border-left-color:var(--ok);background:var(--okbg)}
.lbulk{margin-top:14px}
.lgrp{display:flex;align-items:center;gap:8px;margin:20px 0 6px;font:700 24px/1.05 var(--cond)}
.lgrp .ico{width:24px;height:24px}
.lgrp small{font:500 14px/1 var(--sans);color:var(--ink2);margin-left:6px}
.lgrp em{margin-left:auto;flex:none;white-space:nowrap;font:700 19px/1 var(--cond);font-style:normal;color:var(--ink2)}
.lgrp.warn{color:var(--warn)}
.lcat{margin:16px 0 4px;font:700 19px/1 var(--cond);color:var(--ink2)}
.llist{background:var(--card);border-left:7px solid var(--line)}
.lrow{display:flex;flex-wrap:wrap;align-items:center;border-top:1px solid var(--line2)}
.llist>.lrow:first-child{border-top:0}
.lchk{flex:1 1 170px;min-width:0;display:flex;align-items:center;gap:11px;min-height:62px;padding:8px 8px 8px 10px;background:none;border:0;text-align:left;cursor:pointer;color:inherit}
.lchk:hover{background:rgba(127,127,127,.07)}
.lchk[disabled]{cursor:default;opacity:1;color:var(--ink2)}
.lchk[disabled]:hover{background:none}
.lbox{flex:none;display:inline-grid;place-items:center;width:34px;height:34px;border:3px solid var(--ink2);border-radius:5px;background:var(--card);color:var(--ink)}
.lbox .ico{width:22px;height:22px;stroke-width:3}
.lbox.off{border-style:dashed;border-color:var(--line)}
.lrow.done .lbox{background:var(--go);border-color:var(--go);color:var(--go-ink)}
.lrow.part .lbox{background:var(--tape);border-color:var(--ink);color:var(--on-tape)}
.lrow.prob .lbox{background:var(--warnbg);border-color:var(--warn);color:var(--warn)}
.lrow.done .ln,.lrow.done .lq{color:var(--ink2)}
.lrow.na{padding:8px 10px;gap:11px;opacity:.65}
.lrow.na .lq,.lrow.na .ln{color:var(--ink2)}
.lchk .lq{min-width:30px}
.lpills{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.lcnt{flex:none;margin:0 12px 0 auto;font:700 20px/1 var(--cond);color:var(--ink2)}
.lstep{display:inline-flex;align-items:stretch;flex:none;margin:0 8px 0 auto;border:2px solid var(--line);border-radius:6px;background:var(--bg);max-width:100%}
.lstep button{width:44px;min-height:44px;border:0;background:transparent;font:600 26px/1 var(--sans);color:var(--ink);cursor:pointer;padding:0;flex:none}
.lstep button:hover{background:rgba(127,127,127,.16)}
.lstep button[disabled]{opacity:.3;cursor:not-allowed}
.lstep output{display:inline-flex;align-items:baseline;justify-content:center;min-width:50px;padding:0 4px;align-self:center;font:700 25px/1 var(--cond)}
.lstep output small{font:600 15px/1 var(--cond);color:var(--ink2)}
.lprobbtn{flex:none;min-height:44px;min-width:84px;margin:0 8px 0 auto;padding:0 12px;border:2px solid var(--line);border-radius:6px;background:transparent;color:var(--ink2);font:600 15px/1.1 var(--sans);cursor:pointer}
.lprobbtn:hover{background:rgba(127,127,127,.14)}
.lrow.prob .lprobbtn,.lrow.open .lprobbtn{border-color:var(--warn);color:var(--warn)}
.lprob{flex:1 0 100%;padding:6px 12px 12px;background:var(--line2)}
@supports (background:color-mix(in srgb,red 10%,white)){.lprob{background:color-mix(in srgb,var(--warn) 9%,var(--card))}}
.lprow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 0;font-weight:600}
.lrow>.lstep,.lrow>.lprobbtn{margin-top:6px;margin-bottom:6px}
.lprob .lstep{margin:0}
.lprob .hint{margin-top:4px}
.lrev{font:700 26px/1.05 var(--cond);margin:16px 0 8px}
.lfx>li{padding:11px 0;border-top:1px solid var(--line2)}
.lfx>li:first-child{border-top:0}
.lfx>li>b{display:block;font:700 21px/1.05 var(--cond)}
.lfx>li>span{display:block;margin-top:3px;font-size:15px}
.lfx>li>span b{font-weight:700}
.lbtns{display:grid;grid-template-columns:1fr;gap:10px;margin-top:14px}
@media(min-width:620px){.lbtns{grid-template-columns:1fr 1fr}}
.lbtn{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;min-height:68px;padding:10px 12px;border:2px solid var(--btn-line);border-radius:6px;background:var(--card);color:var(--ink);text-align:left;cursor:pointer}
.lbtn:hover{background:rgba(127,127,127,.1)}
.lbtn.closed{border-color:var(--ok);background:var(--okbg)}
.lbtn .prog{flex:1 0 100%;height:10px;margin-top:4px}
.lt{display:flex;align-items:center;gap:8px;flex:1 1 auto;font:700 22px/1.05 var(--cond)}
.lt .ico{width:20px;height:20px}
.ls{display:flex;align-items:center;gap:5px;flex:0 1 auto;font-size:14px;color:var(--ink2)}
.ls .ico{width:15px;height:15px}
.ls.ok{color:var(--ok);font-weight:600}

/* furgoni di un evento */
.vans>li{margin-top:10px;padding:10px 12px 12px;border:2px solid var(--line);border-left:7px solid var(--tape);border-radius:4px;background:var(--card)}
.vtop{display:flex;align-items:center;justify-content:space-between;gap:10px}
.vname{display:flex;align-items:center;gap:8px;min-width:0;font:700 23px/1.05 var(--cond)}
.vname small{font:500 14px/1 var(--sans);color:var(--ink2)}
.vdrv{margin-top:8px}
.vanadd{margin-top:10px}
.vlist{background:var(--card);margin-top:4px}
.vlist>li{border-top:1px solid var(--line2)}
.vlist>li:first-child{border-top:0}
.vlrow{display:flex;align-items:center;gap:11px;min-height:56px;padding:6px 10px;cursor:pointer}
.vlrow input{width:24px;height:24px;margin:0;flex:none;accent-color:var(--ink)}
.vlrow .lq{min-width:30px}
#sheet h5{font:700 19px/1 var(--cond);color:var(--ink2);margin:16px 0 4px}

/* più eventi nello stesso giorno */
.daybar{display:flex;align-items:center;gap:10px;width:100%;min-height:50px;margin-top:8px;padding:8px 12px;border:2px solid var(--line);border-left:7px solid var(--rule);border-radius:4px;background:var(--card);color:var(--ink);text-align:left;font-weight:600;cursor:pointer}
.daybar:hover{background:rgba(127,127,127,.08)}
.daybar .ico{flex:none}
.daybar.warn{border-color:var(--warn);background:var(--warnbg)}
.daybar em{margin-left:auto;flex:none;font:700 16px/1 var(--cond);font-style:normal;color:var(--warn)}
.dsec{margin:22px 0 4px;padding-bottom:6px;border-bottom:3px solid var(--rule);font:700 23px/1 var(--cond)}
.dayl>li{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:4px 12px;padding:11px 0;border-top:1px solid var(--line2)}
.dayl>li:first-child{border-top:0}
.dayl>li.col{display:block}
.dayl .ico{width:19px;height:19px;vertical-align:-3px;margin-right:6px}
.dtm{font:700 19px/1.05 var(--cond);min-width:84px}
.dev{display:flex;flex-direction:column;min-width:0}
.dev b{font:700 21px/1.05 var(--cond)}
.dev small{font-size:14px;color:var(--ink2)}
.dayl b{font:700 21px/1.05 var(--cond)}
.dsub{display:block;margin-top:2px;font-size:15px;color:var(--ink2)}
.note.ok{color:var(--ok);font-weight:600}
.dreuse{margin-top:16px}
.okt{color:var(--ok);font-weight:600}

/* "da sistemare" */
.box.todo{border-left:7px solid var(--tape)}
.box.todo h3{font:700 23px/1.05 var(--cond);margin-bottom:4px}
.todo li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px dashed var(--line)}
.todo li:first-child{border-top:0}
.todo li>span{min-width:0}
.todo li .btn{flex:none;white-space:nowrap}

/* spese */
.exps{margin-top:2px}
.exr{display:flex;align-items:center;gap:10px;width:100%;min-height:58px;padding:8px 4px;background:none;border:0;border-top:1px solid var(--line2);text-align:left;cursor:pointer;color:inherit}
.exps>li:first-child .exr{border-top:0}
.exr:hover{background:rgba(127,127,127,.07)}
.exm{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;font-weight:600;line-height:1.2}
.exd{font-weight:400}
.exm small{font-size:14px;font-weight:400;color:var(--ink2)}
.exp{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px}
.exa{flex:none;font:700 24px/1 var(--cond)}
.extot{display:flex;flex-wrap:wrap;gap:4px 18px;margin-top:8px;padding-top:8px;border-top:2px solid var(--rule);font-size:15px;color:var(--ink2)}
.extot b{font:700 21px/1 var(--cond);color:var(--ink)}
.texp{margin-top:16px}
.texp .mcat{margin-top:0}
.rimb>li{border-top:1px solid var(--line2)}
.rimb>li:first-child{border-top:0}
.rbrow{display:flex;align-items:center;gap:11px;min-height:58px;padding:6px 4px;cursor:pointer;flex-wrap:wrap}
.rimb.done .rbrow{cursor:default}
.rbrow input{width:24px;height:24px;margin:0;flex:none;accent-color:var(--ink)}
.rbm{flex:1 1 150px;min-width:0;display:flex;flex-direction:column;gap:1px;font-weight:600;line-height:1.2}
.rbm small{font-size:14px;font-weight:400;color:var(--ink2)}
.rba{flex:none;font:700 23px/1 var(--cond)}

/* magazzino: sezioni, movimenti, riparazioni, inventario */
.subtabs{margin-top:12px;display:grid;grid-template-columns:1fr 1fr}
.subtabs .cat{width:100%}
@media(min-width:520px){.subtabs{grid-template-columns:repeat(4,1fr)}}
.cat.low[aria-pressed=false]{border-color:var(--warn);color:var(--warn)}
.lnk{display:inline;min-height:36px;padding:6px 0;background:none;border:0;color:var(--ink);font-weight:600;text-decoration:underline;text-underline-offset:3px;cursor:pointer;text-align:left}
.stkmv{display:grid;gap:2px;font-size:14px}
.stkmv .k{color:var(--ink2);font-weight:600}
.movs{background:var(--card);border-left:7px solid var(--line);margin-top:10px;padding:0 10px}
.mv{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line2)}
.movs>li:first-child{border-top:0}
.mvq{flex:none;min-width:54px;text-align:right;font:700 28px/1 var(--cond)}
.mvq.in{color:var(--ok)}
.mvq.out{color:var(--bad)}
.mvq.adj{color:var(--r-fonico)}
.mvm{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;line-height:1.2}
.mvm b{font-weight:600}
.mvm small{font-size:14px;color:var(--ink2)}
.mvg{flex:none;text-align:center;font-size:12.5px;line-height:1.15;color:var(--ink2)}
.mvg b{font:700 22px/1 var(--cond);color:var(--ink)}
.vcard .tname{display:inline-flex;align-items:center;gap:8px}
.vcard .tname .ico{width:24px;height:24px}
.invl{background:var(--card);margin-top:10px}
.inv{display:grid;grid-template-columns:minmax(0,1fr) 92px 44px;align-items:center;gap:8px;padding:8px 8px 8px 10px;border-top:1px solid var(--line2)}
.invl>li:first-child{border-top:0}
.invm{display:flex;flex-direction:column;gap:1px;line-height:1.2}
.invm b{font-weight:600}
.invm small{font-size:14px;color:var(--ink2)}
.inv input[type=number]{width:100%;min-height:50px;padding:0 4px;text-align:center;font:700 25px/1 var(--cond)}
.inv.same input[type=number]{border-color:var(--ok)}
.inv.diff input[type=number]{border-color:var(--warn);background:var(--warnbg)}
.invd{text-align:center;font:700 19px/1 var(--cond);color:var(--ink2)}
.inv.same .invd{color:var(--ok)}
.inv.diff .invd{color:var(--warn)}

/* pagina del tecnico: furgoni */
.tvans{display:grid;gap:8px;margin-top:12px}
.tvan{display:flex;align-items:center;gap:11px;padding:9px 12px;border:2px solid var(--line);border-radius:6px;background:var(--card)}
.tvan>span{display:flex;flex-direction:column;min-width:0;line-height:1.2}
.tvan b{font:700 22px/1.05 var(--cond)}
.tvan small{font-size:14px;color:var(--ink2)}
.tvan .who{font-weight:600;color:var(--ink)}
.tvan.mine{border-color:var(--ink);border-left:7px solid var(--tape)}
.card.recente{--st:var(--line)}

@media(max-width:380px){
  .wrap{--gut:12px}
  .evt{font-size:23px}
}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
</style>
</head>
<body data-mode="<?= mode ?>" data-token="<?= token ?>">
<div id="bar"></div>
<div id="app"></div>
<div id="sheet"></div>
<div id="toast" role="status" aria-live="polite"></div>
<script>
'use strict';
/* =====================================================================
   GESTIONALE SERVICE - interfaccia (un solo file, nessuna libreria)
   Tre modalità scelte dal server: coord (coordinatore), tech (pagina del
   tecnico), confirm (conferma rapida di una convocazione).
   ===================================================================== */

const ROLES = ['fonico', 'luci', 'video', 'aiutante'];
const STAGES = ['richiesta', 'sopralluogo', 'preventivo', 'confermato', 'concluso', 'annullato'];
const STAGE_LABEL = { richiesta: 'Richiesta', sopralluogo: 'Sopralluogo', preventivo: 'Preventivo',
  confermato: 'Confermato', concluso: 'Concluso', annullato: 'Annullato' };
const STAGE_PILL = { richiesta: 'muted', sopralluogo: 'blue', preventivo: 'warn', confermato: 'ok',
  concluso: 'muted', annullato: 'bad' };
const STAGES_PROVVISORIE = ['richiesta', 'sopralluogo', 'preventivo'];   // il cliente non ha ancora accettato
const ASG_STATES = ['in attesa', 'confermato', 'rifiutato'];
const ASG_PILL = { 'in attesa': 'warn', confermato: 'ok', rifiutato: 'bad' };

/* Categorie del magazzino e quali toccano a chi: un fonico cerca l'audio, chi fa luci cerca le luci. Il materiale
   "generale" (pedane, stativi, corrente...) interessa tutti, l'aiutante monta un po' di tutto. */
const CAT_ORDER = ['audio', 'luci', 'video', 'generale'];
const CAT_LABEL = { audio: 'Audio', luci: 'Luci', video: 'Video', generale: 'Generale', altro: 'Altro' };
const ROLE_CATS = { fonico: ['audio'], luci: ['luci'], video: ['video'], aiutante: ['audio', 'luci', 'video', 'generale'] };
function catKey(c) { return String(c == null ? '' : c).trim().toLowerCase(); }
function catLabel(c) {
  const k = catKey(c) || 'altro';
  return CAT_LABEL[k] || (k.charAt(0).toUpperCase() + k.slice(1));
}
function cmpCat(a, b) {
  const ra = CAT_ORDER.indexOf(catKey(a)), rb = CAT_ORDER.indexOf(catKey(b));
  return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || catLabel(a).localeCompare(catLabel(b), 'it');
}
const TIME_FIELDS = [['orarioArrivo', 'Arrivo'], ['orarioMontaggio', 'Montaggio'], ['orarioPausa', 'Pausa'],
  ['orarioInizioEvento', 'Inizio'], ['orarioFineEvento', 'Fine'], ['orarioSmontaggio', 'Smontaggio']];

/* Dentro Apps Script modo e token li scrive il server nel <body>. Nella pagina pubblicata fuori da Google
   (web/index.html) il <body> e' vuoto e si leggono dall'indirizzo: ?t=TOKEN, ?c=TOKEN o niente. */
const QS = new URLSearchParams(window.location.search);
const S = {
  mode: document.body.getAttribute('data-mode') || (QS.get('c') ? 'confirm' : QS.get('t') ? 'tech' : 'coord'),
  token: document.body.getAttribute('data-token') || QS.get('c') || QS.get('t') || '',
  sheet: null,
  locked: false,
};
const ACT = {};   // azioni dei pulsanti (data-act)
const CHG = {};   // cambi di valore (data-chg)
const INP = {};   // scrittura in un campo, a ogni carattere (data-inp)
const SUB = {};   // invio dei moduli (data-submit)

/* ---------- testo e dati ---------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function isTrue(v) { return v === true || String(v).toLowerCase() === 'true'; }
function isActive(t) { return String(t.attivo).toLowerCase() !== 'false'; }   // vuoto = attivo, come nel server
function rolesOf(s) { return String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean); }
function uniq(a) { return a.filter((x, i) => a.indexOf(x) === i); }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function firstName(n) { return String(n || '').trim().split(/\\s+/)[0] || ''; }
function byName(a, b) { return String(a.nome).localeCompare(String(b.nome), 'it'); }
/* Telefono come si legge meglio: 3201112233 -> 320 1112233, +393495550101 -> +39 349 5550101 (gli altri restano com'è) */
function fmtPhone(s) {
  const raw = String(s == null ? '' : s).trim();
  const d = raw.replace(/[\\s.\\-\\/()]/g, '');
  const m = /^(\\+39|0039)?(3\\d{2})(\\d{6,7})$/.exec(d);
  return m ? (m[1] ? '+39 ' : '') + m[2] + ' ' + m[3] : raw;
}
function safeUrl(u) { u = String(u || '').trim(); return /^https?:\\/\\//i.test(u) ? u : ''; }
function upsert(list, obj, key) {
  key = key || 'id';
  const i = list.findIndex(x => String(x[key]) === String(obj[key]));
  if (i >= 0) list[i] = obj; else list.push(obj);
}

/* ---------- date e orari (le date sono AAAA-MM-GG, gli orari HH:MM) ---------- */
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre',
  'ottobre', 'novembre', 'dicembre'];
const MESI_B = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const GIORNI_B = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
function parseYMD(s) {
  const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(String(s || ''));
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}
function dayNum(s) { const p = parseYMD(s); return p ? Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86400000) : NaN; }
function addDays(s, n) {
  const p = parseYMD(s);
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}
function wday(s) { const p = parseYMD(s); return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); }
function fmtLong(s) { const p = parseYMD(s); return p ? GIORNI[wday(s)] + ' ' + p.d + ' ' + MESI[p.m - 1] : String(s || ''); }
function fmtShort(s) { const p = parseYMD(s); return p ? GIORNI_B[wday(s)] + ' ' + p.d + ' ' + MESI_B[p.m - 1] : String(s || ''); }
function toMin(t) {
  const m = /^(\\d{1,2}):(\\d{2})$/.exec(String(t == null ? '' : t).trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return (h > 23 || mi > 59) ? null : h * 60 + mi;
}
function hhmm(n) { n = ((Math.round(n) % 1440) + 1440) % 1440; return pad(Math.floor(n / 60)) + ':' + pad(n % 60); }
function fmtT(t) { const n = toMin(t); return n === null ? String(t == null ? '' : t).trim() : hhmm(n); }
function inputT(t) { const n = toMin(t); return n === null ? '' : hhmm(n); }

/* ---------- orari e sovrapposizioni ---------- */
/* Finestra di un evento: dall'arrivo (o montaggio, o inizio) alla fine. Se la fine è "prima" dell'inizio
   si intende dopo mezzanotte. Senza fine si usa la durata standard di Config. */
function evWin(e) {
  const dn = dayNum(e.data);
  if (isNaN(dn)) return null;
  let s = null;
  [e.orarioArrivo, e.orarioMontaggio, e.ora, e.orarioInizioEvento].some(t => {
    const m = toMin(t);
    if (m !== null) { s = m; return true; }
    return false;
  });
  if (s === null) return { dn: dn, s: null, e: null, a0: null, a1: null, known: false };
  let end = toMin(e.orarioFineEvento);
  if (end !== null && end <= s) end = (end + 1440 - s <= 18 * 60) ? end + 1440 : null;
  const known = end !== null;
  if (end === null) end = s + (Number((S.cfg || {}).durata_evento_ore) || 4) * 60;
  return { dn: dn, s: s, e: end, a0: dn * 1440 + s, a1: dn * 1440 + end, known: known };
}
function rangeTxt(w) {
  if (!w || w.s === null) return 'orari da definire';
  return w.known ? hhmm(w.s) + '–' + hhmm(w.e) : 'dalle ' + hhmm(w.s);
}

/* Elenco degli orari compilati di un evento: [[Etichetta, 'HH:MM'], ...] */
function timesList(e) {
  const out = [];
  TIME_FIELDS.forEach(([k, label]) => {
    let v = e[k];
    if (k === 'orarioInizioEvento' && !v) v = e.ora;   // l'orario principale vale come inizio
    if (v) out.push([label, fmtT(v)]);
  });
  return out;
}
function timesHtml(e) {
  const l = timesList(e);
  if (!l.length) return '';
  return '<dl class="times">' + l.map(([k, v]) => '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('') + '</dl>';
}

/* ---------- fase dell'evento, in parole semplici (la leggono anche i tecnici) ---------- */
/* Un evento annullato può essere un preventivo rifiutato o un evento già confermato e poi cancellato:
   lo si capisce da dov'era arrivato prima (statoPrecedente) */
function cancelKind(e) {
  const p = String(e.statoPrecedente || '');
  if (p === 'confermato' || p === 'concluso') return 'cancellato';
  if (p === 'preventivo') return 'preventivo';
  if (p === 'richiesta' || p === 'sopralluogo') return 'richiesta';
  return 'generico';
}
function stageInfo(e) {
  const s = String(e.stato || '');
  const from = String(e.statoPrecedente || '');
  switch (s) {
    case 'richiesta': return { label: 'Richiesta', text: 'Il cliente ha fatto richiesta: non è ancora deciso niente.' };
    case 'sopralluogo': return { label: 'Sopralluogo', text: 'Si sta valutando il posto: il programma può ancora cambiare.' };
    case 'preventivo': return { label: 'Preventivo', text: 'Preventivo inviato: il cliente non ha ancora confermato.' };
    case 'confermato': return { label: 'Confermato', text: from === 'preventivo' ? 'Preventivo accettato: il cliente ha confermato, si fa.' : 'Il cliente ha confermato: si fa.' };
    case 'concluso': return { label: 'Concluso', text: 'Evento concluso.' };
    case 'annullato': {
      const k = cancelKind(e);
      if (k === 'cancellato') return { label: 'Evento cancellato', text: 'Era confermato ma non si fa più. Non devi fare niente.' };
      if (k === 'preventivo') return { label: 'Preventivo non accettato', text: 'Il cliente non ha accettato: l\\'evento non si fa. Non devi fare niente.' };
      if (k === 'richiesta') return { label: 'Richiesta annullata', text: 'La richiesta è stata annullata: l\\'evento non si fa. Non devi fare niente.' };
      return { label: 'Annullato', text: 'L\\'evento non si fa più. Non devi fare niente.' };
    }
  }
  return { label: STAGE_LABEL[s] || s, text: '' };
}
/* "2026-10-27 09:40" -> "27 ottobre alle 09:40" */
function fmtStamp(s) {
  const m = /^(\\d{4}-\\d{2}-\\d{2}) (\\d{2}:\\d{2})$/.exec(String(s || '').trim());
  const p = m ? parseYMD(m[1]) : null;
  return p ? p.d + ' ' + MESI[p.m - 1] + ' alle ' + m[2] : '';
}

/* ---------- soldi e misure ---------- */
/* 1234.5 -> "1.234,50 €" (sempre due decimali, punto per le migliaia, virgola per i centesimi) */
function fmtEur(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const parts = Math.abs(v).toFixed(2).split('.');
  return (v < 0 ? '−' : '') + parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, '.') + ',' + parts[1] + ' €';
}
/* 412.5 -> "412,5" (una cifra decimale solo se serve) */
function fmtNum(n, dec) {
  const v = Number(n) || 0;
  let s = v.toFixed(dec == null ? 1 : dec);
  if (s.indexOf('.') >= 0) s = s.replace(/\\.?0+$/, '');   // gli zeri si tolgono solo dopo la virgola: 1100 resta 1100
  return s.replace('.', ',');
}

/* ---------- salvataggio locale (non essenziale: se non c'è, si riscrive) ---------- */
const memStore = {};
const store = {
  get(k) { try { const v = window.localStorage.getItem(k); if (v !== null) return v; } catch (e) { /* bloccato */ } return memStore[k] || ''; },
  set(k, v) { memStore[k] = v; try { window.localStorage.setItem(k, v); } catch (e) { /* bloccato */ } },
  del(k) { delete memStore[k]; try { window.localStorage.removeItem(k); } catch (e) { /* bloccato */ } },
};

/* ---------- barra di avanzamento, avvisi, chiamate al server ---------- */
let barN = 0;
function bar(d) {
  barN = Math.max(0, barN + d);
  const b = $('#bar');
  if (b) b.className = barN ? 'on' : '';
}
let toastT = 0;
function toast(msg, kind) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'on' + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.className = ''; }, kind === 'err' ? 7000 : 4200);
}
function cleanErr(e) {
  let m = (e && e.message) ? e.message : String(e || '');
  m = m.replace(/^\\s*(Error|Exception|Errore|Eccezione):\\s*/i, '').trim();
  return m || 'Qualcosa non ha funzionato. Riprova.';
}
/* Indirizzo /exec dello script: lo scrive build.sh nella pagina pubblicata fuori da Google (web/index.html).
   Dentro Apps Script resta vuoto e si usa google.script.run. */
const GS_EXEC_URL = '';
const REMOTE_TIMEOUT_MS = 90000;   // un avvio a freddo di Apps Script puo' durare diversi secondi

/* Chiamata via fetch, senza cookie: per Google e' una richiesta anonima, quindi non scatta la scelta dell'account.
   Content-Type text/plain: cosi' il browser non fa la richiesta preliminare (OPTIONS), che Apps Script non gestisce. */
async function callRemote(fn, args) {
  if (/^INCOLLA/.test(GS_EXEC_URL)) throw new Error("Pagina non configurata: manca l'indirizzo /exec in GS_EXEC_URL (vedi LEGGI-PAGINA-ESTERNA.txt).");
  const ctl = (typeof AbortController === 'function') ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), REMOTE_TIMEOUT_MS) : 0;
  let txt;
  try {
    const r = await fetch(GS_EXEC_URL, {
      method: 'POST', redirect: 'follow', credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: fn, args: args }),
      signal: ctl ? ctl.signal : undefined,
    });
    txt = await r.text();
  } catch (e) {
    throw new Error(e && e.name === 'AbortError'
      ? 'Il server non risponde. Riprova tra qualche secondo.'
      : 'Nessuna connessione. Controlla internet e riprova.');
  } finally { clearTimeout(timer); }
  let j = null;
  try { j = JSON.parse(txt); } catch (e) { j = null; }
  if (!j || typeof j !== 'object') throw new Error("Risposta inattesa dal server. Se continua, avvisa il coordinatore: l'app potrebbe non essere pubblicata per \\"Chiunque\\".");
  if (!j.ok) throw new Error(cleanErr(j.e));
  return j.v === undefined ? null : j.v;
}
function call(fn) {
  const args = Array.prototype.slice.call(arguments, 1);
  if (GS_EXEC_URL && !(window.google && google.script && google.script.run)) {
    bar(1);
    return callRemote(fn, args).finally(() => bar(-1));
  }
  return new Promise((resolve, reject) => {
    if (!window.google || !google.script || !google.script.run) {
      reject(new Error("Questa pagina funziona solo aperta dal link dell'app."));
      return;
    }
    bar(1);
    let r = google.script.run
      .withSuccessHandler(v => { bar(-1); resolve(v); })
      .withFailureHandler(e => { bar(-1); reject(new Error(cleanErr(e))); });
    try { r[fn].apply(r, args); } catch (e) { bar(-1); reject(new Error(cleanErr(e))); }
  });
}
/* Esegue un'azione che scrive sul foglio, una per volta. Restituisce {ok, err}. */
async function mutate(fn, quiet) {
  if (S.locked) { toast('Un attimo, sto ancora salvando…'); return { ok: false, err: '' }; }
  S.locked = true;
  document.body.classList.add('busy');
  try { await fn(); return { ok: true, err: '' }; }
  catch (e) { if (!quiet) toast(e.message, 'err'); return { ok: false, err: e.message }; }
  finally { S.locked = false; document.body.classList.remove('busy'); }
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch (e) { /* proseguo con il metodo vecchio */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

/* ---------- WhatsApp: link con messaggio già scritto (gratuito, si preme invio a mano) ---------- */
function waNumber(raw, prefix) {
  const s = String(raw == null ? '' : raw).trim();
  const digits = s.replace(/\\D/g, '');
  if (!digits) return '';
  if (s.charAt(0) === '+') return digits;
  if (digits.slice(0, 2) === '00') return digits.slice(2);
  prefix = String(prefix || '39').replace(/\\D/g, '');
  if (digits.indexOf(prefix) === 0 && digits.length >= prefix.length + 9) return digits;
  return prefix + digits;
}
function waLink(raw, text, prefix) {
  const n = waNumber(raw, prefix);
  return n ? 'https://wa.me/' + n + '?text=' + encodeURIComponent(text) : '';
}

/* ---------- icone ---------- */
const ICO = {
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  out: '<path d="M10 4H5v16h5"/><path d="M15 8l4 4-4 4"/><path d="M19 12H9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  cal: '<rect x="4" y="5" width="16" height="15" rx="1"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  edit: '<path d="M4 20l1-5L16 4l4 4L9 19z"/>',
  box: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>',
  bell: '<path d="M6 17v-6a6 6 0 0 1 12 0v6l1.5 2h-15z"/><path d="M10 21.5h4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1"/><path d="M16 8V4H4v12h4"/>',
  truck: '<path d="M3 6h11v10H3z"/><path d="M14 9.5h4l3 3.5v3h-7"/><circle cx="7.5" cy="17.5" r="1.9"/><circle cx="17.5" cy="17.5" r="1.9"/>',
  list: '<rect x="5" y="5" width="14" height="16" rx="1"/><path d="M9 5V3h6v2M9 11h6M9 15h6"/>',
  wrench: '<path d="M15 5a4 4 0 0 0-4.6 5.4L4 16.8 7.2 20l6.4-6.4A4 4 0 0 0 19 9l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  euro: '<path d="M17.5 6.5a6.5 6.5 0 1 0 0 11"/><path d="M4.5 10h9M4.5 14h9"/>',
  down: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
  up: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.3v.4"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-4 3-6 7-6s7 2 7 6"/>',
  minus: '<path d="M6 12h12"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
};
function ico(n) {
  return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICO[n] || '') + '</svg>';
}

/* ---------- disegno della pagina ---------- */
function paint(html) {
  const y = window.scrollY;
  clearArm();
  if (html !== undefined) $('#app').innerHTML = html;
  else if (typeof S.view === 'function') $('#app').innerHTML = S.view();
  if (y) window.scrollTo(0, y);
}

/* Pulsanti "a due tocchi": il primo cambia il testo, il secondo conferma */
let armedEl = null, armedHtml = '', armedT = 0;
function clearArm() {
  clearTimeout(armedT);
  if (armedEl && document.contains(armedEl)) { armedEl.classList.remove('armed'); armedEl.innerHTML = armedHtml; }
  armedEl = null;
}
function arm(el) {
  if (armedEl === el) { clearArm(); return true; }
  clearArm();
  armedEl = el; armedHtml = el.innerHTML;
  el.classList.add('armed');
  el.textContent = el.getAttribute('data-confirm');
  armedT = setTimeout(clearArm, 4000);
  return false;
}

/* ---------- finestra a scorrimento ---------- */
/* opts.noFocus: non mettere il cursore nel primo campo (su telefono aprirebbe la tastiera e coprirebbe l'elenco) */
function openSheet(title, bodyHtml, opts) {
  const opener = (S.sheet && S.sheet.opener) || document.activeElement;   // aprendo una finestra sopra l'altra si ricorda il pulsante originale
  S.sheet = { opener: opener };
  S.onClose = null;
  $('#sheet').innerHTML = '<div class="sheetwrap"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-t" tabindex="-1">' +
    '<div class="sheethead"><h2 id="sh-t">' + esc(title) + '</h2>' +
    '<button type="button" class="ib" data-act="closeSheet" aria-label="Chiudi">' + ico('x') + '</button></div>' +
    bodyHtml + '</div></div>';
  document.body.classList.add('noscroll');
  const noFocus = !!(opts && opts.noFocus);
  setTimeout(() => {
    if (!S.sheet) return;   // già chiusa nel frattempo
    const first = noFocus ? null : $('#sheet input:not([type=hidden]):not([type=checkbox]):not([type=radio]), #sheet textarea, #sheet select');
    const el = first || $('#sheet .sheet');
    if (el) el.focus();
  }, 30);
}
function closeSheet() {
  const op = S.sheet && S.sheet.opener;
  const hook = S.onClose;
  S.sheet = null; S.onClose = null;
  $('#sheet').innerHTML = '';
  document.body.classList.remove('noscroll');
  if (typeof hook === 'function') hook();
  if (op && document.contains(op) && typeof op.focus === 'function') { try { op.focus({ preventScroll: true }); } catch (e) { /* ok */ } }
}
ACT.closeSheet = () => closeSheet();
function showCopyBox(title, text) {
  openSheet(title, '<p class="hint">Il telefono non permette di copiare da solo. Tieni premuto sul testo, scegli «Seleziona tutto» e poi «Copia».</p>' +
    '<input class="copybox" type="text" readonly value="' + esc(text) + '" aria-label="Testo da copiare">' +
    '<div class="sheetfoot"><button type="button" class="btn pri" data-act="closeSheet">Fatto</button></div>');
  setTimeout(() => { const i = $('#sheet .copybox'); if (i) { i.focus(); i.select(); } }, 60);
}

/* ---------- ascolto degli eventi (uno solo per tutta la pagina) ---------- */
document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-act]');
  if (!el || !document.contains(el)) return;
  const f = ACT[el.getAttribute('data-act')];
  if (!f) return;
  if (el.hasAttribute('data-confirm') && !arm(el)) return;
  f(el, ev);
});
document.addEventListener('change', ev => {
  const el = ev.target.closest('[data-chg]');
  if (el && CHG[el.getAttribute('data-chg')]) CHG[el.getAttribute('data-chg')](el, ev);
});
document.addEventListener('input', ev => {
  const el = ev.target.closest('[data-inp]');
  if (el && INP[el.getAttribute('data-inp')]) INP[el.getAttribute('data-inp')](el, ev);
});
document.addEventListener('submit', ev => {
  const f = ev.target.closest('[data-submit]');
  if (f && SUB[f.getAttribute('data-submit')]) { ev.preventDefault(); SUB[f.getAttribute('data-submit')](f, ev); }
});
document.addEventListener('keydown', ev => {
  if (!S.sheet) return;
  if (ev.key === 'Escape') { closeSheet(); return; }
  if (ev.key !== 'Tab') return;
  const box = $('#sheet .sheet');
  if (!box) return;
  const f = $$('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select,textarea,[tabindex="0"]', box)
    .filter(x => x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (ev.shiftKey && (document.activeElement === first || document.activeElement === box)) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
});

/* =====================================================================
   LOGISTICA - parti comuni a coordinatore e tecnico:
   elenchi di carico e scarico dei furgoni, spese
   ===================================================================== */
const EXP_LABEL = { carburante: 'Carburante', pedaggi: 'Pedaggi', parcheggio: 'Parcheggio', pasti: 'Pasti', alloggio: 'Alloggio',
  chilometri: 'Chilometri', noleggio: 'Noleggio', materiale: 'Materiale', altro: 'Altro' };
const EXP_CATS = Object.keys(EXP_LABEL);
function expLabel(c) { return EXP_LABEL[c] || (String(c || '').charAt(0).toUpperCase() + String(c || '').slice(1)); }
function toN(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function toI(v) { return Math.max(0, Math.floor(toN(v))); }
/* Intero con il segno (le differenze del registro dei movimenti possono essere negative) */
function toSI(v) { return Math.trunc(toN(v)); }
function todayStr() { return (S.mode === 'tech' ? T.oggi : S.oggi) || ''; }

/* ---------------------------------------------------------------------
   Come sono messi carico e rientro: gli stessi conti che fa il server
   --------------------------------------------------------------------- */
/* Se nell'evento si è usata la lista di carico, al rientro ci si aspettano i pezzi caricati; altrimenti tutti quelli previsti */
function loadUsedL(lines) { return lines.some(l => toI(l.caricato) > 0); }
function retBaseL(l, used) { const q = toI(l.quantita); return used ? Math.min(q, toI(l.caricato)) : q; }
function retDoneL(l) { return toI(l.scaricato) + toI(l.danneggiato) + toI(l.mancante); }

function lprogress(lines, kind) {
  const ls = lines.filter(l => toI(l.quantita) >= 1);
  if (kind === 'carico') {
    const pcs = ls.reduce((s, l) => s + toI(l.quantita), 0);
    const got = ls.reduce((s, l) => s + Math.min(toI(l.quantita), toI(l.caricato)), 0);
    return { total: ls.length, done: ls.filter(l => toI(l.caricato) >= toI(l.quantita)).length, pcs: pcs, got: got,
      pct: pcs ? Math.floor(got * 100 / pcs) : 0 };
  }
  const used = loadUsedL(ls);
  const items = ls.filter(l => retBaseL(l, used) >= 1);
  const pcs = items.reduce((s, l) => s + retBaseL(l, used), 0);
  const got = items.reduce((s, l) => s + Math.min(retBaseL(l, used), retDoneL(l)), 0);
  return { total: items.length, done: items.filter(l => retDoneL(l) >= retBaseL(l, used)).length, pcs: pcs, got: got,
    pct: pcs ? Math.floor(got * 100 / pcs) : 0 };
}
function progBar(pct, label) {
  return '<span class="prog' + (pct >= 100 ? ' full' : '') + '" role="progressbar" aria-label="' + esc(label) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct +
    '"><i style="width:' + pct + '%"></i></span>';
}

/* ---------------------------------------------------------------------
   Dove sono i dati: nella pagina del coordinatore (S.car, S.evById...) o in quella del tecnico (T.mie, T.recenti)
   --------------------------------------------------------------------- */
const L = { evId: '', kind: 'carico', view: 'list', probOpen: '', plan: null, planErr: '' };
const LQ = { items: [], running: false, gen: 0 };   // gen cresce a ogni tocco: una lettura partita prima non deve cancellare i tocchi fatti dopo

function techItem(evId) {
  return (T.mie || []).concat(T.recenti || []).filter(x => x.evento.id === evId)[0] || null;
}
/* L'evento della lista aperta: {ev, lists, lines, vans}. Le righe hanno sempre la stessa forma. */
function listSrc(evId) {
  evId = evId || L.evId;
  if (S.mode === 'tech') {
    const it = techItem(evId);
    return it ? { ev: it.evento, lists: it.liste || {}, lines: it.materiale || [], vans: it.furgoni || [] } : null;
  }
  const e = S.evById[evId];
  return e ? { ev: e, lists: e, lines: (S.carByEv[evId] || []).filter(c => toI(c.quantita) >= 1).map(lineView), vans: vansOfEvent(evId) } : null;
}
function rawLine(evId, lineId) {
  if (S.mode === 'tech') { const it = techItem(evId); return it ? (it.materiale || []).filter(l => l.id === lineId)[0] || null : null; }
  return S.car.filter(c => c.id === lineId)[0] || null;
}
function mergeLine(evId, riga) {
  const raw = riga && rawLine(evId, riga.id);
  if (raw) Object.assign(raw, riga);
}
function setAllLines(evId, res) {
  if (S.mode === 'tech') { const it = techItem(evId); if (it) it.materiale = res.materiale || []; }
  else setLines(evId, res.righe || []);
}
function setLists(evId, liste) {
  if (S.mode === 'tech') { const it = techItem(evId); if (it) it.liste = liste; }
  else { const e = S.evById[evId]; if (e) Object.assign(e, liste); }
}
function listLocked(src, kind) {
  kind = kind || L.kind;
  if (kind === 'carico') return !!src.lists.caricoQuando || src.ev.stato === 'annullato';
  return !!src.lists.scaricoQuando;
}

/* Come cambia una riga con il tocco (stessa regola del server: così la spunta si vede subito) */
function localPatch(l, lines, kind, vals) {
  const q = toI(l.quantita);
  if (kind === 'carico') return { caricato: Math.max(0, Math.min(q, toI(vals.caricato))) };
  const base = retBaseL(l, loadUsedL(lines));
  if (vals.reset) return { scaricato: 0, danneggiato: 0, mancante: 0 };
  if (vals.tutto) return { scaricato: base, danneggiato: 0, mancante: 0 };
  const d = toI(vals.danneggiato), m = toI(vals.mancante);
  return { scaricato: Math.max(0, base - d - m), danneggiato: d, mancante: m };
}

/* ---------------------------------------------------------------------
   Coda di salvataggio: i tocchi si vedono subito e vanno al server uno per volta, nell'ordine
   --------------------------------------------------------------------- */
function qList(evId, kind, lineId, vals) {
  LQ.gen++;
  const key = evId + '|' + kind + '|' + lineId;
  const ex = LQ.items.filter(x => x.key === key && !x.started)[0];
  if (ex) ex.vals = vals;
  else LQ.items.push({ key: key, evId: evId, kind: kind, lineId: lineId, vals: vals, started: false });
  runLQ();
}
function qBulk(evId, kind, mode) {
  LQ.gen++;
  LQ.items.push({ key: evId + '|' + kind + '|*', evId: evId, kind: kind, bulk: mode, started: false });
  runLQ();
}
function drainLQ() {
  return new Promise(resolve => {
    const t = () => ((LQ.running || LQ.items.length) ? setTimeout(t, 50) : resolve());
    t();
  });
}
async function runLQ() {
  if (LQ.running) return;
  LQ.running = true;
  while (LQ.items.length) {
    const it = LQ.items[0];
    it.started = true;
    try {
      if (it.bulk) {
        const res = S.mode === 'tech' ? await call('api_techListAll', S.token, it.evId, it.kind, it.bulk)
          : await call('api_listAll', S.pin, it.evId, it.kind, it.bulk);
        LQ.items.shift();
        if (!LQ.items.some(x => x.evId === it.evId)) setAllLines(it.evId, res);
      } else {
        const res = S.mode === 'tech' ? await call('api_techListSet', S.token, it.evId, it.kind, it.lineId, it.vals)
          : await call('api_listSet', S.pin, it.evId, it.kind, it.lineId, it.vals);
        LQ.items.shift();
        if (!LQ.items.some(x => x.evId === it.evId && x.kind === it.kind && (x.bulk || x.lineId === it.lineId))) mergeLine(it.evId, res.riga);
      }
    } catch (e) {
      LQ.items.length = 0;
      toast(e.message, 'err');
      try { if (S.mode === 'tech') await techLoad(); else await coordLoad(); } catch (e2) { /* resta quello che c'è */ }
    }
    lrender();
  }
  LQ.running = false;
}

/* ---------------------------------------------------------------------
   Finestra con la lista
   --------------------------------------------------------------------- */
/* Due persone possono caricare lo stesso furgone nello stesso momento: ogni tanto si rilegge la lista dal foglio,
   così ognuna vede cosa ha spuntato l'altra. Una lettura partita prima di un tocco viene scartata. */
const POLL_MS = 15000;
let pollT = 0;
function stopPoll() { clearInterval(pollT); pollT = 0; }
async function pollList() {
  const evId = L.evId;
  if (!evId || !S.sheet || L.view !== 'list' || LQ.running || LQ.items.length || S.locked) return;
  const gen = LQ.gen;
  let res;
  try { res = S.mode === 'tech' ? await call('api_techEventLists', S.token, evId) : await call('api_eventLists', S.pin, evId); } catch (e) { return; }
  if (gen !== LQ.gen || LQ.running || LQ.items.length || L.evId !== evId || !S.sheet) return;
  const before = JSON.stringify(listSrc(evId));
  if (S.mode === 'tech') { const it = techItem(evId); if (it) { it.materiale = res.materiale || []; it.liste = res.liste || it.liste; } }
  else setLines(evId, res.righe || [], res.liste);
  if (JSON.stringify(listSrc(evId)) !== before) lrender();
}
function openList(evId, kind) {
  L.evId = evId; L.kind = kind; L.view = 'list'; L.probOpen = ''; L.plan = null; L.planErr = '';
  if (!listSrc(evId)) return;
  openSheet(kind === 'carico' ? 'Lista di carico' : 'Lista di scarico', '<div id="lbody"></div>', { noFocus: true });
  S.onClose = () => { stopPoll(); L.evId = ''; paint(); };
  stopPoll();
  pollT = setInterval(pollList, POLL_MS);
  lrender();
}
function lrender() {
  const box = $('#lbody');
  if (!box || !L.evId) return;
  const src = listSrc();
  if (!src) { box.innerHTML = '<p class="empty">Questo evento non c\\'è più. Chiudi e aggiorna la pagina.</p>'; return; }
  const foc = document.activeElement;
  const key = (foc && box.contains(foc)) ? [foc.getAttribute('data-act'), foc.getAttribute('data-id'), foc.getAttribute('data-f'), foc.getAttribute('data-d')] : null;
  box.innerHTML = L.view === 'close' ? unloadReviewHtml(src) : listBodyHtml(src);
  if (key && key[0]) {
    const sel = '#lbody [data-act="' + key[0] + '"]' + (key[1] ? '[data-id="' + key[1] + '"]' : '') + (key[2] ? '[data-f="' + key[2] + '"]' : '') + (key[3] ? '[data-d="' + key[3] + '"]' : '');
    const n = $(sel);
    if (n && !n.disabled) n.focus({ preventScroll: true });
  }
}

/* Le righe di una lista raggruppate per furgone (se ce n'è più di uno) e, dentro, per reparto */
function vanGroups(lines, vans) {
  if (vans.length < 2) return [{ title: '', van: null, lines: lines }];
  const out = vans.map(v => ({ title: v.nome, van: v, lines: lines.filter(l => l.van_id === v.id) }));
  const rest = lines.filter(l => !vans.some(v => v.id === l.van_id));
  if (rest.length) out.push({ title: 'Da assegnare a un furgone', van: null, lines: rest, warn: true });
  return out.filter(g => g.lines.length);
}
function sortLines(lines) {
  return lines.slice().sort((a, b) => cmpCat(a.categoria, b.categoria) || String(a.nome).localeCompare(String(b.nome), 'it', { sensitivity: 'base' }));
}
function lineSmall(l) {
  const sub = Math.min(toI(l.quantita), toI(l.subnoleggio));
  const bits = [];
  if (l.note) bits.push(esc(l.note));
  if (sub) bits.push(sub >= toI(l.quantita) ? 'tutto a noleggio' : sub + ' a noleggio');
  return bits.length ? '<small>' + bits.join(' · ') + '</small>' : '';
}
function lstepHtml(l, field, val, max, label, noMax) {
  const id = esc(l.id);
  return '<span class="lstep" role="group" aria-label="' + esc(label) + '">' +
    '<button type="button" data-act="lstep" data-id="' + id + '" data-f="' + field + '" data-d="-1" aria-label="Uno in meno: ' + esc(label) + '"' + (val <= 0 ? ' disabled' : '') + '>−</button>' +
    '<output>' + val + (noMax ? '' : '<small>/' + max + '</small>') + '</output>' +
    '<button type="button" data-act="lstep" data-id="' + id + '" data-f="' + field + '" data-d="1" aria-label="Uno in più: ' + esc(label) + '"' + (val >= max ? ' disabled' : '') + '>+</button></span>';
}

function rowCarico(l, locked) {
  const q = toI(l.quantita), c = Math.min(q, toI(l.caricato));
  const st = c >= q ? 'done' : c > 0 ? 'part' : 'none';
  const nm = esc(l.nome), id = esc(l.id);
  let h = '<li class="lrow ' + st + '" data-line="' + id + '">' +
    '<button type="button" class="lchk" data-act="lchk" data-id="' + id + '" aria-pressed="' + (st === 'done' ? 'true' : st === 'part' ? 'mixed' : 'false') + '"' + (locked ? ' disabled' : '') +
    ' aria-label="' + (st === 'done' ? 'Caricato' : 'Da caricare') + ': ' + nm + ', ' + q + (q === 1 ? ' pezzo' : ' pezzi') + (st === 'part' ? ', ' + c + ' caricati' : '') + '">' +
    '<span class="lbox">' + (st === 'done' ? ico('check') : st === 'part' ? ico('minus') : '') + '</span>' +
    '<span class="lq">' + q + '</span><span class="ln">' + nm + lineSmall(l) + '</span></button>';
  if (q > 1) {
    h += locked ? (st === 'done' ? '' : '<span class="lcnt">' + c + '/' + q + '</span>')
      : lstepHtml(l, 'caricato', c, q, 'Pezzi caricati di ' + l.nome);
  }
  return h + '</li>';
}

function rowScarico(l, used, locked) {
  const q = toI(l.quantita), base = retBaseL(l, used), nm = esc(l.nome), id = esc(l.id);
  if (base < 1) {
    return '<li class="lrow na" data-line="' + id + '"><span class="lbox off"></span><span class="lq">' + q + '</span>' +
      '<span class="ln">' + nm + '<small>Non è stato caricato: niente da far rientrare</small></span></li>';
  }
  const d = toI(l.danneggiato), m = toI(l.mancante), s = toI(l.scaricato), done = s + d + m, cons = !!l.consumabile;
  const st = done === 0 ? 'none' : done >= base ? ((d || m) ? 'prob' : 'done') : 'part';
  const pills = (d ? '<span class="pill warn">' + d + (d === 1 ? ' danneggiato' : ' danneggiati') + '</span>' : '') +
    (m ? '<span class="pill bad">' + m + (cons ? (m === 1 ? ' consumato' : ' consumati') : (m === 1 ? ' mancante' : ' mancanti')) + '</span>' : '') +
    (st === 'part' ? '<span class="pill muted">contati ' + done + ' di ' + base + '</span>' : '');
  const open = L.probOpen === l.id && !locked;
  let h = '<li class="lrow ' + st + (open ? ' open' : '') + '" data-line="' + id + '">' +
    '<button type="button" class="lchk" data-act="lchk" data-id="' + id + '" aria-pressed="' + (st === 'done' || st === 'prob' ? 'true' : st === 'part' ? 'mixed' : 'false') + '"' + (locked ? ' disabled' : '') +
    ' aria-label="' + (done >= base ? 'Rientrato' : 'Da controllare') + ': ' + nm + ', ' + base + (base === 1 ? ' pezzo' : ' pezzi') + '">' +
    '<span class="lbox">' + (st === 'done' ? ico('check') : st === 'prob' ? ico('warn') : st === 'part' ? ico('minus') : '') + '</span>' +
    '<span class="lq">' + base + '</span><span class="ln">' + nm + (pills ? '<span class="lpills">' + pills + '</span>' : '') + lineSmall(l) + '</span></button>';
  if (!locked) {
    h += '<button type="button" class="lprobbtn" data-act="lprob" data-id="' + id + '" aria-expanded="' + open + '">' + ((d || m) ? 'Cambia' : 'Problema') + '</button>';
  }
  if (open) {
    h += '<div class="lprob">' +
      (cons ? '' : '<div class="lprow"><span>Danneggiati</span>' + lstepHtml(l, 'danneggiato', d, base - m, 'Pezzi danneggiati di ' + l.nome, true) + '</div>') +
      '<div class="lprow"><span>' + (cons ? 'Consumati o finiti' : 'Mancanti') + '</span>' + lstepHtml(l, 'mancante', m, base - (cons ? 0 : d), (cons ? 'Pezzi consumati di ' : 'Pezzi mancanti di ') + l.nome, true) + '</div>' +
      '<p class="hint">' + (cons ? 'Escono dal magazzino.' : 'Danneggiati: vanno in riparazione. Mancanti: escono dal magazzino.') + ' Gli altri ' + Math.max(0, base - d - m) + ' sono rientrati regolarmente.</p></div>';
  }
  return h + '</li>';
}

function listBodyHtml(src) {
  const kind = L.kind, ev = src.ev, lists = src.lists;
  const lines = src.lines.filter(l => toI(l.quantita) >= 1);
  const closed = kind === 'carico' ? !!lists.caricoQuando : !!lists.scaricoQuando;
  const who = kind === 'carico' ? lists.caricoChi : lists.scaricoChi, when = kind === 'carico' ? lists.caricoQuando : lists.scaricoQuando;
  const locked = listLocked(src);
  const pr = lprogress(lines, kind);
  const used = loadUsedL(lines);
  let h = '<p class="lev"><b>' + esc(ev.cliente) + '</b> · ' + esc(fmtShort(ev.data)) + '</p>';
  h += '<div class="lprog"><span class="lcount"><b>' + pr.done + '</b> di ' + pr.total + (pr.total === 1 ? ' voce' : ' voci') +
    '</span>' + progBar(pr.pct, 'Avanzamento') + '</div>';
  if (closed) {
    h += '<p class="banner ok">' + (kind === 'carico' ? 'Carico chiuso' : 'Scarico chiuso') + (who ? ' da ' + esc(who) : '') +
      (fmtStamp(when) ? ' il ' + esc(fmtStamp(when)) : '') + '.</p>';
  } else if (kind === 'carico' && ev.stato === 'annullato') {
    h += '<p class="banner">L\\'evento è annullato: il carico non si può più cambiare.</p>';
  } else if (kind === 'carico' && STAGES_PROVVISORIE.indexOf(ev.stato) >= 0) {
    h += '<p class="banner">L\\'evento non è ancora confermato: l\\'elenco può ancora cambiare.</p>';
  } else if (kind === 'scarico' && !lists.caricoQuando && !used) {
    h += '<p class="hint">Il carico non è stato segnato: al rientro si controlla tutto quello che era previsto.</p>';
  }
  if (kind === 'scarico' && !closed && S.mode === 'tech') {
    h += '<p class="hint">Tu spunti cosa rientra e cosa è rotto o manca. Lo scarico lo chiude poi il coordinatore, che sistema magazzino e riparazioni.</p>';
  }
  if (!pr.total) {
    return h + '<p class="empty">' + (kind === 'carico' ? 'Non c\\'è materiale in elenco.' : 'Non c\\'è niente da far rientrare: il materiale non è stato caricato.') + '</p>' + listFootHtml(src, pr, closed);
  }
  if (!locked) {
    const none = !lines.some(l => (kind === 'carico' ? toI(l.caricato) : retDoneL(l)) > 0);
    h += '<div class="row lbulk">' + (kind === 'carico'
      ? '<button type="button" class="btn sm" data-act="lbulk" data-mode="all">' + ico('check') + ' Tutto caricato</button>'
      : '<button type="button" class="btn sm" data-act="lbulk" data-mode="rest">' + ico('check') + (none ? ' Tutto rientrato' : ' Il resto è rientrato') + '</button>') +
      (none ? '' : '<button type="button" class="btn sm danger" data-act="lbulk" data-mode="none" data-confirm="Azzero tutto? Tocca di nuovo">Azzera</button>') + '</div>';
  }
  h += '<div id="lrows">';
  vanGroups(lines, src.vans).forEach(g => {
    if (g.title) {
      const gp = lprogress(g.lines, kind);
      h += '<h4 class="lgrp' + (g.warn ? ' warn' : '') + '">' + (g.van ? ico('truck') : ico('warn')) + '<span>' + esc(g.title) + (g.van && g.van.targa ? ' <small>' + esc(g.van.targa) + '</small>' : '') + '</span><em>' + gp.done + '/' + gp.total + '</em></h4>';
    }
    let lastCat = null;
    const items = sortLines(g.lines);
    h += '<ul class="llist">';
    items.forEach(l => {
      const c = catKey(l.categoria) || 'altro';
      if (c !== lastCat && (items.length > 6 || !g.title)) { h += '</ul><h5 class="lcat">' + esc(catLabel(c)) + '</h5><ul class="llist">'; }
      lastCat = c;
      h += kind === 'carico' ? rowCarico(l, locked) : rowScarico(l, used, locked);
    });
    h += '</ul>';
  });
  h += '</div>';
  return h + listFootHtml(src, pr, closed);
}
function listFootHtml(src, pr, closed) {
  const kind = L.kind;
  let h = '<div class="sheetfoot sticky"><button type="button" class="btn" data-act="closeSheet">Fatto</button>';
  if (kind === 'carico') {
    if (closed) h += '<button type="button" class="btn" data-act="lloadReopen" data-confirm="Riapro il carico? Tocca di nuovo">Riapri il carico</button>';
    else if (src.ev.stato !== 'annullato' && pr.total) {
      h += '<button type="button" class="btn pri" data-act="lloadClose"' + (pr.done < pr.total ? ' data-confirm="Mancano ' + (pr.total - pr.done) + '. Chiudo? Tocca di nuovo"' : '') + '>Carico finito</button>';
    }
  } else if (!closed && S.mode !== 'tech' && pr.total) {
    h += '<button type="button" class="btn pri" data-act="lunloadReview">Chiudi lo scarico…</button>';
  }
  return h + '</div>';
}

/* ---- tocchi sulla lista ---- */
function openSrcLine(el) {
  const src = listSrc();
  if (!src || listLocked(src)) return null;
  const lines = src.lines.filter(l => toI(l.quantita) >= 1);
  const l = lines.filter(x => x.id === el.dataset.id)[0];
  return l ? { src: src, lines: lines, l: l } : null;
}
function lapply(ctx, vals) {
  const raw = rawLine(L.evId, ctx.l.id);
  if (!raw) return;
  Object.assign(raw, localPatch(ctx.l, ctx.lines, L.kind, vals));
  lrender();
  qList(L.evId, L.kind, ctx.l.id, vals);
}
ACT.listOpen = el => openList(el.dataset.ev, el.dataset.kind);
ACT.lchk = el => {
  const c = openSrcLine(el);
  if (!c) return;
  const l = c.l;
  if (L.kind === 'carico') {
    lapply(c, { caricato: toI(l.caricato) >= toI(l.quantita) ? 0 : toI(l.quantita) });
    return;
  }
  const base = retBaseL(l, loadUsedL(c.lines));
  if (base < 1) return;
  const done = retDoneL(l);
  if (done >= base) lapply(c, { reset: true });
  else lapply(c, { danneggiato: toI(l.danneggiato), mancante: toI(l.mancante) });   // il resto è rientrato
};
ACT.lstep = el => {
  const c = openSrcLine(el);
  if (!c) return;
  const l = c.l, f = el.dataset.f, d = +el.dataset.d;
  if (f === 'caricato') { lapply(c, { caricato: Math.max(0, Math.min(toI(l.quantita), toI(l.caricato) + d)) }); return; }
  const base = retBaseL(l, loadUsedL(c.lines));
  let dd = toI(l.danneggiato), mm = toI(l.mancante);
  if (f === 'danneggiato') dd = Math.max(0, dd + d); else mm = Math.max(0, mm + d);
  if (dd + mm > base) return;
  lapply(c, { danneggiato: dd, mancante: mm });
};
ACT.lprob = el => { L.probOpen = L.probOpen === el.dataset.id ? '' : el.dataset.id; lrender(); };
ACT.lbulk = el => {
  const src = listSrc();
  if (!src || listLocked(src)) return;
  const mode = el.dataset.mode, lines = src.lines.filter(l => toI(l.quantita) >= 1), used = loadUsedL(lines);
  lines.forEach(l => {
    const raw = rawLine(L.evId, l.id);
    if (!raw) return;
    if (L.kind === 'carico') { raw.caricato = mode === 'all' ? toI(l.quantita) : 0; return; }
    const base = retBaseL(l, used);
    if (base < 1) return;
    if (mode === 'none') Object.assign(raw, { scaricato: 0, danneggiato: 0, mancante: 0 });
    else if (retDoneL(l) !== base) raw.scaricato = Math.max(0, base - toI(l.danneggiato) - toI(l.mancante));
  });
  lrender();
  qBulk(L.evId, L.kind, mode);
};
async function loadClose(close) {
  await drainLQ();
  await mutate(async () => {
    const res = S.mode === 'tech' ? await call('api_techLoadClose', S.token, L.evId, close) : await call('api_loadClose', S.pin, L.evId, close);
    setLists(L.evId, res.liste);
    toast(close ? 'Carico chiuso.' : 'Carico riaperto.', 'ok');
  });
  lrender();
}
ACT.lloadClose = () => loadClose(true);
ACT.lloadReopen = () => loadClose(false);

/* ---- chiusura dello scarico (solo coordinatore): prima si vede cosa cambia nel magazzino ---- */
function effectHtml(it) {
  const parts = [];
  if (it.libera) parts.push('È scritto a mano, non è in magazzino: nessun effetto sulle giacenze.');
  else {
    if (it.ownD) parts.push(plural(it.ownD, 'pezzo danneggiato', 'pezzi danneggiati') + ': ' +
      (it.ownD === 1 ? 'va in riparazione e non è più disponibile.' : 'vanno in riparazione e non sono più disponibili.'));
    if (it.ownM) parts.push(plural(it.ownM, it.consumabile ? 'pezzo consumato' : 'pezzo mancante', it.consumabile ? 'pezzi consumati' : 'pezzi mancanti') + ': ' +
      (it.ownM === 1 ? 'esce' : 'escono') + ' dal magazzino' + (it.consumabile ? '.' : ' (persi).'));
    if (it.noleggio) parts.push(plural(it.noleggio, 'pezzo a noleggio', 'pezzi a noleggio') + ' con problemi: non toccano il tuo magazzino, ne parli col noleggiatore.');
  }
  return '<li><b>' + esc(it.nome) + '</b>' + parts.map(p => '<span>' + esc(p) + '</span>').join('') + '</li>';
}
function unloadReviewHtml(src) {
  let h = '<p class="lev"><b>' + esc(src.ev.cliente) + '</b> · ' + esc(fmtShort(src.ev.data)) + '</p><h3 class="lrev">Chiudere lo scarico?</h3>';
  const back = '<button type="button" class="btn" data-act="lunloadBack">Torna alla lista</button>';
  if (L.planErr) return h + '<p class="ferr" role="alert">' + esc(L.planErr) + '</p><div class="sheetfoot">' + back + '</div>';
  if (!L.plan) return h + '<p class="empty">Controllo…</p>';
  const p = L.plan;
  if (p.chiuso) return h + '<p>Lo scarico è già chiuso.</p><div class="sheetfoot">' + back + '</div>';
  if (p.unresolved) {
    return h + '<p class="note warn">Ci sono ancora ' + plural(p.unresolved, 'voce', 'voci') + ' da controllare. ' +
      'Se il resto è tornato regolarmente, segnalo; altrimenti torna alla lista e controllale una per una.</p>' +
      '<div class="sheetfoot sticky">' + back + '<button type="button" class="btn pri" data-act="lunloadRest">Il resto è rientrato</button></div>';
  }
  h += p.items.length
    ? '<p class="hint" style="margin-top:0">Quando chiudi, nel magazzino succede questo:</p><ul class="lfx">' + p.items.map(effectHtml).join('') + '</ul>'
    : '<p>È rientrato tutto regolarmente: il magazzino non cambia.</p>';
  return h + '<div class="sheetfoot sticky">' + back + '<button type="button" class="btn pri" data-act="lunloadGo">Chiudi lo scarico</button></div>';
}
async function loadPlan() {
  L.plan = null; L.planErr = '';
  try { L.plan = await call('api_unloadPreview', S.pin, L.evId); } catch (e) { L.planErr = e.message; }
  lrender();
}
ACT.lunloadReview = async () => {
  await drainLQ();
  L.view = 'close'; lrender();
  const sh = $('#sheet .sheet'); if (sh) sh.scrollTop = 0;
  await loadPlan();
};
ACT.lunloadBack = () => { L.view = 'list'; lrender(); };
ACT.lunloadRest = async () => {
  const evId = L.evId;
  const r = await mutate(async () => {
    const res = await call('api_listAll', S.pin, evId, 'scarico', 'rest');
    setLines(evId, res.righe);
  });
  if (r.ok) await loadPlan(); else lrender();
};
ACT.lunloadGo = async () => {
  const evId = L.evId;
  await mutate(async () => {
    const res = await call('api_unloadClose', S.pin, evId);
    const e = S.evById[evId];
    if (e) Object.assign(e, res.evento, { nMateriali: e.nMateriali });
    setLines(evId, res.righe);
    (res.materiali || []).forEach(m => upsert(S.mat, m));
    (res.riparazioni || []).forEach(r => upsert(S.rip, r));
    (res.movimenti || []).forEach(m => upsert(S.mov, m));
    derive();
    L.view = 'list';
    const nr = (res.riparazioni || []).length, nm = (res.movimenti || []).length;
    toast('Scarico chiuso.' + (nr ? ' ' + plural(nr, 'riparazione aperta', 'riparazioni aperte') + '.' : '') + (nm ? ' ' + plural(nm, 'uscita', 'uscite') + ' dal magazzino.' : ''), 'ok');
  });
  lrender();
};

/* Pulsante riassuntivo (nella scheda dell'evento e nella pagina del tecnico) che apre la lista */
function listBtnHtml(ev, lists, lines, kind) {
  const pr = lprogress(lines, kind);
  const closed = kind === 'carico' ? lists.caricoQuando : lists.scaricoQuando;
  const lab = kind === 'carico' ? 'Lista di carico' : 'Lista di scarico';
  let st;
  if (closed) st = '<span class="ls ok">' + ico('check') + ' Chiuso' + (fmtStamp(closed) ? ' · ' + esc(fmtStamp(closed)) : '') + '</span>';
  else if (!pr.total) st = '<span class="ls">' + (kind === 'carico' ? 'Niente da caricare' : 'Niente da far rientrare') + '</span>';
  else st = '<span class="ls">' + (pr.done ? pr.done + ' di ' : 'Da fare: ') + pr.total + (pr.total === 1 ? ' voce' : ' voci') + (pr.done ? '' : '') + '</span>';
  return '<button type="button" class="lbtn' + (closed ? ' closed' : '') + '" data-act="listOpen" data-ev="' + esc(ev.id) + '" data-kind="' + kind + '">' +
    '<span class="lt">' + ico(kind === 'carico' ? 'up' : 'down') + ' ' + lab + '</span>' + st + progBar(closed ? 100 : pr.pct, lab) + '</button>';
}

/* ---------------------------------------------------------------------
   Spese
   --------------------------------------------------------------------- */
function expPill(x) {
  if (x.pagatoDa === 'azienda') return '<span class="pill blue">pagata dall\\'azienda</span>';
  if (x.rimborsatoIl) return '<span class="pill ok">rimborsata il ' + esc(fmtShort(x.rimborsatoIl)) + '</span>';
  return '<span class="pill warn">da rimborsare</span>';
}
function expDesc(x) {
  return expLabel(x.categoria) + (x.descrizione ? ' · ' + x.descrizione : '') + (toN(x.km) ? ' · ' + fmtNum(x.km, 1) + ' km' : '');
}
/* Dove stanno le spese di un evento, nei due casi */
function expList(evId) {
  if (S.mode === 'tech') { const it = techItem(evId); return it ? (it.spese || []) : []; }
  return S.spe.filter(x => x.event_id === evId);
}
function expUpsert(evId, x) {
  if (S.mode === 'tech') { const it = techItem(evId); if (it) { it.spese = it.spese || []; upsert(it.spese, x); } }
  else { upsert(S.spe, x); derive(); }
}
function expRemove(evId, id) {
  if (S.mode === 'tech') { const it = techItem(evId); if (it) it.spese = (it.spese || []).filter(x => x.id !== id); }
  else { S.spe = S.spe.filter(x => x.id !== id); derive(); }
}
function kmRateNow() { return toN(S.mode === 'tech' ? T.tariffa : (S.cfg || {}).tariffa_km); }

/* Data proposta per una spesa nuova: il giorno dell'evento (il tecnico non può scrivere date future) */
function expDefaultDate(evId) {
  const ev = S.mode === 'tech' ? (techItem(evId) || {}).evento : S.evById[evId];
  const d = ev && ev.data ? ev.data : todayStr();
  return S.mode === 'tech' && d > todayStr() ? todayStr() : d;
}
/* Il modulo per aggiungere o correggere una spesa. Il coordinatore sceglie chi ha pagato; il tecnico scrive le sue.
   Una spesa già rimborsata non si cambia: il tecnico la vede soltanto, il coordinatore può correggere solo descrizione, nota e addebito. */
function expFormHtml(evId, x) {
  const coord = S.mode !== 'tech';
  const v = x || {};
  const locked = !!(x && x.rimborsatoIl);
  if (locked && !coord) {
    return '<div class="facts"><div><span class="k">Spesa: </span>' + esc(expDesc(v)) + '</div>' +
      '<div><span class="k">Importo: </span><b>' + esc(fmtEur(v.importo)) + '</b></div>' +
      '<div><span class="k">Data: </span>' + esc(fmtShort(v.data)) + '</div>' + (v.nota ? '<div><span class="k">Nota: </span>' + esc(v.nota) + '</div>' : '') + '</div>' +
      '<p style="margin-top:10px">' + expPill(v) + '</p><p class="hint">È già stata rimborsata: non si può più cambiare.</p>' +
      '<div class="sheetfoot"><button type="button" class="btn pri" data-act="closeSheet">Chiudi</button></div>';
  }
  const dis = locked ? ' disabled' : '';
  const rate = kmRateNow();
  const cat = v.categoria || 'carburante';
  let payer = '';
  if (coord) {
    const team = (S.asgByEv[evId] || []).filter(a => a.stato !== 'rifiutato');
    const ids = {};
    let opts = '';
    const sel = t => (v.technician_id === t && v.pagatoDa !== 'azienda' ? ' selected' : '');
    team.forEach(a => { ids[a.technician_id] = true; opts += '<option value="' + esc(a.technician_id) + '"' + sel(a.technician_id) + '>' + esc(a.tecnico) + ' (ha anticipato lui)</option>'; });
    const others = S.tec.filter(t => !ids[t.id] && (isActive(t) || v.technician_id === t.id)).sort(byName);
    if (others.length) {
      opts += '<optgroup label="Altri tecnici">' + others.map(t => '<option value="' + esc(t.id) + '"' + sel(t.id) + '>' + esc(t.nome) + ' (ha anticipato lui)</option>').join('') + '</optgroup>';
    }
    opts += '<option value="azienda"' + (v.pagatoDa === 'azienda' ? ' selected' : '') + '>L\\'azienda (carta o contanti aziendali)</option>';
    payer = '<label class="fld"><span>Chi ha pagato</span><select name="payer"' + dis + '>' + (v.id ? '' : '<option value="">Scegli…</option>') + opts + '</select></label>';
  } else {
    payer = '<fieldset class="fld"><legend>Chi ha pagato</legend><div class="radios">' +
      '<label class="radio"><input type="radio" name="pagatoDa" value="tecnico"' + (v.pagatoDa !== 'azienda' ? ' checked' : '') + '><span><b>Io</b><small>Va rimborsata</small></span></label>' +
      '<label class="radio"><input type="radio" name="pagatoDa" value="azienda"' + (v.pagatoDa === 'azienda' ? ' checked' : '') + '><span><b>L\\'azienda</b><small>Solo da annotare</small></span></label></div></fieldset>';
  }
  return '<form data-submit="expForm" data-ev="' + esc(evId) + '" novalidate><input type="hidden" name="id" value="' + esc(v.id || '') + '">' +
    '<label class="fld"><span>Che spesa è</span><select name="categoria" data-chg="expCat"' + dis + '>' +
    EXP_CATS.map(c => '<option value="' + c + '"' + (c === cat ? ' selected' : '') + '>' + expLabel(c) + '</option>').join('') + '</select></label>' +
    '<label class="fld" id="expkmf"' + (cat === 'chilometri' ? '' : ' hidden') + '><span>Chilometri fatti</span>' +
    '<input type="text" inputmode="decimal" name="km" value="' + esc(toN(v.km) ? fmtNum(v.km, 1) : '') + '" data-inp="expKm" autocomplete="off"></label>' +
    '<label class="fld"><span>Importo (€)</span><input type="text" inputmode="decimal" name="importo" value="' + esc(v.importo != null && v.importo !== '' ? fmtAmt(v.importo) : '') + '" placeholder="es. 12,50" autocomplete="off"' + dis + '></label>' +
    '<p class="hint" id="expcalc">' + (cat === 'chilometri' ? kmHint(v.km, v.importo, rate) : '') + '</p>' +
    '<label class="fld"><span>Descrizione (facoltativa)</span><input type="text" name="descrizione" value="' + esc(v.descrizione || '') + '" maxlength="120" autocomplete="off" placeholder="es. Pieno furgone"></label>' +
    '<label class="fld"><span>Data</span><input type="date" name="data" value="' + esc(v.data || expDefaultDate(evId)) + '"' + (coord ? '' : ' max="' + esc(todayStr()) + '"') + dis + '></label>' +
    payer +
    (coord ? '<label class="chk" style="margin-top:6px"><input type="checkbox" name="addebitoCliente"' + (isTrue(v.addebitoCliente) ? ' checked' : '') + '> Da addebitare al cliente</label>' : '') +
    '<label class="fld"><span>Nota (facoltativa)</span><textarea name="nota" rows="2" maxlength="200">' + esc(v.nota || '') + '</textarea></label>' +
    (locked ? '<p class="hint">È già stata rimborsata: importo, data e chi ha pagato non si cambiano. Per cambiarli togli prima il rimborso dalla scheda Tecnici.</p>' : '') +
    '<p class="ferr" role="alert"></p><div class="sheetfoot"><button type="button" class="btn" data-act="closeSheet">Annulla</button>' +
    (v.id && !locked ? '<button type="button" class="btn danger" data-act="expDel" data-id="' + esc(v.id) + '" data-ev="' + esc(evId) + '" data-confirm="Sicuro? Tocca di nuovo">Elimina</button>' : '') +
    '<button type="submit" class="btn pri">Salva spesa</button></div></form>';
}
function kmHint(km, importo, rate) {
  const k = toN(String(km == null ? '' : km).replace(',', '.'));
  if (rate > 0) return k > 0 ? fmtNum(k, 1) + ' km × ' + fmtEur(rate) + ' = ' + fmtEur(k * rate) + '. Lascia vuoto l\\'importo per usare questo conto.' : 'Tariffa: ' + fmtEur(rate) + ' al km. Scrivi i chilometri e l\\'importo si calcola da solo.';
  return 'Scrivi anche l\\'importo da rimborsare.';
}
CHG.expCat = el => {
  const form = el.closest('form'), isKm = el.value === 'chilometri';
  const f = $('#expkmf', form); if (f) f.hidden = !isKm;
  const c = $('#expcalc', form); if (c) c.textContent = isKm ? kmHint($('[name=km]', form).value, '', kmRateNow()) : '';
};
INP.expKm = el => { const c = $('#expcalc', el.closest('form')); if (c) c.textContent = kmHint(el.value, '', kmRateNow()); };

function openExpForm(evId, id) {
  const x = id ? expList(evId).filter(y => y.id === id)[0] : null;
  openSheet(x ? 'Correggi la spesa' : 'Nuova spesa', expFormHtml(evId, x || null), { noFocus: true });
  S.onClose = () => paint();
}
ACT.expAdd = el => openExpForm(el.dataset.ev, '');
ACT.expEdit = el => openExpForm(el.dataset.ev, el.dataset.id);
SUB.expForm = async form => {
  const f = new FormData(form), g = k => String(f.get(k) == null ? '' : f.get(k)).trim();
  const evId = form.dataset.ev, coord = S.mode !== 'tech';
  const e = { id: g('id') || undefined, categoria: g('categoria'), km: g('km'), importo: g('importo'), descrizione: g('descrizione'),
    data: g('data'), nota: g('nota') };
  const err = $('.ferr', form);
  if (coord) {
    // i campi bloccati (spesa già rimborsata) non partono nel modulo: li riprendo da quella che c'è
    const cur = e.id ? expList(evId).filter(y => y.id === e.id)[0] : null;
    if (cur && cur.rimborsatoIl) {
      Object.assign(e, { categoria: cur.categoria, importo: cur.importo, data: cur.data, pagatoDa: cur.pagatoDa, technician_id: cur.technician_id });
    } else {
      const p = g('payer');
      if (!p) { err.textContent = 'Scegli chi ha pagato.'; return; }
      if (p === 'azienda') e.pagatoDa = 'azienda'; else { e.pagatoDa = 'tecnico'; e.technician_id = p; }
    }
    e.addebitoCliente = f.has('addebitoCliente');
    e.event_id = evId;
  } else {
    e.pagatoDa = g('pagatoDa') || 'tecnico';
  }
  if (e.categoria !== 'chilometri') e.km = '';
  if (!e.importo && !(e.categoria === 'chilometri' && e.km && kmRateNow() > 0)) { err.textContent = 'Scrivi l\\'importo in euro.'; $('[name=importo]', form).focus(); return; }
  err.textContent = '';
  const r = await mutate(async () => {
    const res = coord ? await call('api_expSave', S.pin, e) : await call('api_techExpSave', S.token, evId, e);
    expUpsert(evId, res.spesa);
    closeSheet();
    toast(e.id ? 'Spesa corretta.' : 'Spesa aggiunta: ' + fmtEur(res.spesa.importo) + '.', 'ok');
  }, true);
  if (!r.ok) err.textContent = r.err;
};
ACT.expDel = el => {
  const evId = el.dataset.ev, id = el.dataset.id;
  mutate(async () => {
    if (S.mode === 'tech') await call('api_techExpDel', S.token, id); else await call('api_expDel', S.pin, id);
    expRemove(evId, id);
    closeSheet();
    toast('Spesa tolta.');
  });
};

/* =====================================================================
   COORDINATORE
   ===================================================================== */
Object.assign(S, {
  pin: store.get('pin'), ready: false, tab: 'eventi', openEv: null, showPast: false,
  prop: null, allowDouble: true, addRoleFor: null,
  url: '', oggi: '', cfg: { prefisso_telefono: '39', durata_evento_ore: 4, nome_azienda: '' },
  tec: [], ev: [], disp: [], asg: [], mat: [], car: [], mancano: [],
  fur: [], fe: [], rip: [], mov: [], spe: [], movAll: false,   // furgoni, furgoni per evento, riparazioni, movimenti, spese
  tecById: {}, evById: {}, asgByEv: {}, asgByTec: {}, dmap: {}, matById: {}, carByEv: {}, useByEq: {},
  furById: {}, feByEv: {}, feByVan: {}, speByEv: {}, ripByEq: {},
  countTent: store.get('countTent') !== '0',   // i preventivi non ancora confermati occupano il materiale? (si ricorda la scelta)
  reuseSame: store.get('reuseSame') === '1',   // due eventi lo stesso giorno, uno dopo l'altro: possono usare gli stessi pezzi? (di solito no)
  openLine: null,                  // riga di materiale aperta per la modifica
  stockDate: '', stockQ: '', stockCat: '', openStk: null,   // scheda Magazzino
  magTab: 'articoli', movKind: '', movQ: '', ripOpen: null, rimbTec: null,
  pick: {}, addEv: null,           // finestra "Aggiungi materiale"
  view: null,
});

function derive() {
  // Valori scritti a mano nel foglio possono essere fuori standard: li riporto a quelli noti
  S.ev.forEach(e => { e.stato = String(e.stato || '').trim().toLowerCase(); if (STAGES.indexOf(e.stato) < 0) e.stato = 'richiesta'; });
  S.asg.forEach(a => { const s = String(a.stato || '').trim().toLowerCase(); a.stato = ASG_STATES.indexOf(s) >= 0 ? s : 'in attesa'; });
  S.tecById = {}; S.tec.forEach(t => { S.tecById[t.id] = t; });
  S.evById = {}; S.ev.forEach(e => { S.evById[e.id] = e; });
  S.asgByEv = {}; S.asgByTec = {};
  S.asg.forEach(a => {
    (S.asgByEv[a.event_id] = S.asgByEv[a.event_id] || []).push(a);
    (S.asgByTec[a.technician_id] = S.asgByTec[a.technician_id] || []).push(a);
  });
  S.dmap = {};
  S.disp.forEach(d => {
    (S.dmap[d.technician_id] = S.dmap[d.technician_id] || {})[d.data] = { on: isTrue(d.disponibile), from: String(d.oraDa || '') };
  });
  S.matById = {}; S.mat.forEach(m => { S.matById[m.id] = m; });
  S.carByEv = {}; S.useByEq = {};
  S.car.forEach(c => {
    const e = S.evById[c.event_id];
    if (!e) return;
    (S.carByEv[c.event_id] = S.carByEv[c.event_id] || []).push(c);
    if (c.equipment_id) (S.useByEq[c.equipment_id] = S.useByEq[c.equipment_id] || []).push({ e: e, c: c });
  });
  S.furById = {}; S.fur.forEach(v => { S.furById[v.id] = v; });
  S.feByEv = {}; S.feByVan = {};
  S.fe.forEach(f => {
    (S.feByEv[f.event_id] = S.feByEv[f.event_id] || []).push(f);
    (S.feByVan[f.van_id] = S.feByVan[f.van_id] || []).push(f);
  });
  S.speByEv = {};
  S.spe.forEach(x => { (S.speByEv[x.event_id] = S.speByEv[x.event_id] || []).push(x); });
  S.ripByEq = {};
  S.rip.forEach(r => { (S.ripByEq[r.equipment_id] = S.ripByEq[r.equipment_id] || []).push(r); });
}

function personalUrl(t) { return (S.url && t && t.token) ? S.url + '?t=' + t.token : ''; }

/* ---------- orari e sovrapposizioni (evWin e rangeTxt sono in core.js) ---------- */
/* Come sta un tecnico rispetto a un evento:
   cls   ok | warn | bad          (bad = non può, warn = da controllare)
   avail yes | no | none          (cosa ha scritto per quel giorno)
   clash true se si sovrappone a un altro evento in cui è già convocato */
function techStatus(t, e) {
  const w = evWin(e);
  const notes = [];
  let cls = 'ok', clash = false;
  const bump = c => { if (c === 'bad' || (c === 'warn' && cls === 'ok')) cls = c; };
  const d = (S.dmap[t.id] || {})[e.data];
  const avail = d ? (d.on ? 'yes' : 'no') : 'none';
  if (avail === 'no') { bump('bad'); notes.push('ha segnato che non è disponibile quel giorno'); }
  if (avail === 'yes' && d.from && w && w.s !== null) {
    const f = toMin(d.from);
    if (f !== null && f > w.s) {
      bump('warn');
      notes.push('è libero solo dalle ' + hhmm(f) + ' ma l\\'evento parte alle ' + hhmm(w.s));
    }
  }
  (S.asgByTec[t.id] || []).forEach(a => {
    if (a.event_id === e.id || a.stato === 'rifiutato') return;
    const o = S.evById[a.event_id];
    if (!o || o.stato === 'annullato') return;
    const w2 = evWin(o);
    if (w && w2 && w.a0 !== null && w2.a0 !== null && w.a0 < w2.a1 && w2.a0 < w.a1) {
      bump('bad'); clash = true;
      notes.push('è già convocato per ' + o.cliente + ' (' + rangeTxt(w2) + ')');
      return;
    }
    if (o.data === e.data) {
      bump('warn');
      notes.push('lo stesso giorno ha anche ' + o.cliente + ' (' + rangeTxt(w2) + ')');
    }
  });
  return { cls: cls, avail: avail, notes: notes, clash: clash, from: d ? d.from : '' };
}

/* Ruoli di un evento: chi li copre e cosa manca. I tecnici che hanno rifiutato non contano. */
function coverage(e) {
  const per = {};
  ROLES.forEach(r => { per[r] = []; });
  (S.asgByEv[e.id] || []).forEach(a => {
    if (a.stato === 'rifiutato') return;
    uniq(rolesOf(a.ruoli)).forEach(r => { if (per[r]) per[r].push(a); });
  });
  const slots = [], open = [];
  let need = 0;
  ROLES.forEach(r => {
    const n = Number(e[r]) || 0;
    need += n;
    const have = per[r];
    for (let i = 0; i < Math.max(n, have.length); i++) {
      if (i < have.length) slots.push({ role: r, a: have[i], extra: i >= n });
      else { slots.push({ role: r, a: null, extra: false }); open.push(r); }
    }
  });
  return { slots: slots, open: open, need: need, complete: need > 0 && open.length === 0 };
}

/* "Proponi squadra": abbina i ruoli ancora liberi ai tecnici disponibili.
   - prima chi ha scritto di essere libero, poi chi non ha risposto
   - chi ha una sola mansione viene usato per primo, così i tecnici polivalenti restano per i ruoli rimasti
   - se un ruolo resta scoperto, un tecnico che sa fare più mansioni può coprirne due (se permesso) */
function computeProposal(e) {
  const cov = coverage(e);
  const slots = cov.open.slice();
  const assigned = new Set((S.asgByEv[e.id] || []).map(a => a.technician_id));
  const rank = c => (c.st.avail === 'yes' ? 0 : 1);
  const cands = S.tec
    .filter(t => isActive(t) && !assigned.has(t.id))
    .map(t => ({ t: t, st: techStatus(t, e), roles: uniq(rolesOf(t.ruoli)) }))
    .filter(c => c.st.cls !== 'bad')
    .sort((a, b) => rank(a) - rank(b) || a.roles.length - b.roles.length || byName(a.t, b.t));
  const slotOf = slots.map(() => -1), candOf = cands.map(() => -1);
  function aug(s, seen, maxRank) {
    for (let c = 0; c < cands.length; c++) {
      if (seen[c] || rank(cands[c]) > maxRank || cands[c].roles.indexOf(slots[s]) < 0) continue;
      seen[c] = true;
      if (candOf[c] < 0 || aug(candOf[c], seen, maxRank)) { candOf[c] = s; slotOf[s] = c; return true; }
    }
    return false;
  }
  [0, 1].forEach(mr => { slots.forEach((_, s) => { if (slotOf[s] < 0) aug(s, {}, mr); }); });
  const roleMap = {};
  cands.forEach((c, i) => { if (candOf[i] >= 0) roleMap[i] = [slots[candOf[i]]]; });
  const missing = [];
  slots.forEach((r, s) => {
    if (slotOf[s] >= 0) return;
    let best = -1;
    if (S.allowDouble) {
      cands.forEach((c, i) => {
        const cur = roleMap[i];
        if (!cur || cur.length >= 2 || cur.indexOf(r) >= 0 || c.roles.indexOf(r) < 0) return;
        if (best < 0 || rank(c) < rank(cands[best])) best = i;
      });
    }
    if (best >= 0) roleMap[best].push(r); else missing.push(r);
  });
  const picks = Object.keys(roleMap).map(Number).map(i => ({
    t: cands[i].t, st: cands[i].st, roles: roleMap[i], dbl: roleMap[i].length > 1,
  })).sort((a, b) => ROLES.indexOf(a.roles[0]) - ROLES.indexOf(b.roles[0]) || byName(a.t, b.t));
  /* Ruoli ancora scoperti: chi è già in squadra e sa fare anche quel ruolo può prenderlo (al massimo due ruoli a testa) */
  const adds = [], still = [];
  const members = (S.asgByEv[e.id] || []).filter(a => a.stato !== 'rifiutato').map(a => ({
    a: a, t: S.tecById[a.technician_id], now: uniq(rolesOf(a.ruoli)), more: [],
  })).filter(m => m.t && isActive(m.t));
  missing.forEach(r => {
    const m = S.allowDouble ? members.filter(x => x.now.length + x.more.length < 2 && x.now.indexOf(r) < 0 &&
      uniq(rolesOf(x.t.ruoli)).indexOf(r) >= 0)[0] : null;
    if (m) m.more.push(r); else still.push(r);
  });
  members.filter(m => m.more.length).forEach(m => adds.push({
    t: m.t, a: m.a, had: m.now, added: m.more, roles: m.now.concat(m.more),
  }));
  return { evId: e.id, picks: picks, adds: adds, missing: still };
}

/* ---------- materiale e magazzino: conti ---------- */
/* Giorni in cui il materiale di un evento è fuori dal magazzino: dal giorno di uscita a quello di rientro.
   Di norma è solo il giorno dell'evento. Restituisce [primo, ultimo] come numeri di giorno. */
function occRange(e) {
  const dn = dayNum(e.data);
  if (isNaN(dn)) return null;
  return [dn - (Number(e.materialePrima) || 0), dn + (Number(e.materialeDopo) || 0)];
}
/* Un evento tiene occupato il materiale se non è annullato (e, se si sceglie così, solo se è confermato).
   Se lo scarico è chiuso i pezzi sono già rientrati in magazzino: non li occupa più. */
function holdsStock(f) {
  if (f.stato === 'annullato' || f.scaricoQuando) return false;
  return S.countTent || f.stato === 'confermato' || f.stato === 'concluso';
}
/* Due eventi dello stesso giorno, uno dopo l'altro, possono usare gli stessi pezzi? Solo se lo si è scelto, se hanno
   tutti e due inizio e fine scritti e se tra la fine del primo e l'inizio del secondo c'è almeno un'ora (per scaricare e ricaricare). */
const REUSE_MARGIN_MIN = 60;
function sameDayReuse(a, b) {
  if (!S.reuseSame) return false;
  const ra = occRange(a), rb = occRange(b);
  if (!ra || !rb || ra[0] !== ra[1] || rb[0] !== rb[1] || ra[0] !== rb[0]) return false;   // solo eventi di un giorno, lo stesso giorno
  const wa = evWin(a), wb = evWin(b);
  if (!wa || !wb || !wa.known || !wb.known) return false;
  return wa.a1 + REUSE_MARGIN_MIN <= wb.a0 || wb.a1 + REUSE_MARGIN_MIN <= wa.a0;
}
/* Pezzi che si possono usare: quelli che ci sono meno quelli fuori uso (un articolo dismesso non ne ha) */
function stockOf(m) {
  if (String(m.stato) === 'dismesso') return 0;
  return Math.max(0, (Number(m.quantita) || 0) - (Number(m.fuoriServizio) || 0));
}
/* Pezzi di una riga che escono dal nostro magazzino (gli altri sono a noleggio da fuori) */
function fromStock(c) {
  const q = Number(c.quantita) || 0;
  return Math.max(0, q - Math.min(q, Number(c.subnoleggio) || 0));
}
/* Chi usa un articolo tra due giorni (numeri di giorno), escluso un evento: [{e, q}].
   Se si passa forEv, gli eventi che possono riusare gli stessi pezzi (vedi sameDayReuse) non contano. */
function usersOfRange(equipId, r0, r1, exceptId, forEv) {
  const out = [];
  (S.useByEq[equipId] || []).forEach(u => {
    if (u.e.id === exceptId || !holdsStock(u.e)) return;
    const r = occRange(u.e);
    if (!r || r[0] > r1 || r[1] < r0) return;
    if (forEv && sameDayReuse(forEv, u.e)) return;
    const q = fromStock(u.c);
    if (q > 0) out.push({ e: u.e, q: q });
  });
  return out;
}
/* Quanti pezzi servono davvero nello stesso momento, tra gli eventi di un elenco: se alcuni si possono succedere
   (sameDayReuse) non si sommano. Senza riuso è la semplice somma. */
function neededTogether(users) {
  if (!S.reuseSame) return users.reduce((s, x) => s + x.q, 0);
  let best = 0;
  users.forEach(u => {
    const s = users.reduce((n, v) => n + ((v === u || !sameDayReuse(u.e, v.e)) ? v.q : 0), 0);
    if (s > best) best = s;
  });
  return best;
}
/* Quanti pezzi di un articolo restano all'evento e, dopo quelli degli altri eventi negli stessi giorni */
function availFor(m, e) {
  const r = occRange(e);
  const used = r ? usersOfRange(m.id, r[0], r[1], e.id, e) : [];
  const usedQ = neededTogether(used);
  return { stock: stockOf(m), used: used, usedQ: usedQ, free: stockOf(m) - usedQ };
}
/* Situazione di una riga: pezzi che servono dal magazzino, a noleggio, e quanti ne mancano */
function lineInfo(e, c) {
  const m = c.equipment_id ? S.matById[c.equipment_id] : null;
  const q = Number(c.quantita) || 0, sub = Math.min(q, Number(c.subnoleggio) || 0), need = q - sub;
  if (!m) return { m: null, a: null, need: need, sub: sub, short: 0 };
  const a = availFor(m, e);
  return { m: m, a: a, need: need, sub: sub, short: Math.max(0, need - Math.max(0, a.free)) };
}
function matSummary(e) {
  const lines = S.carByEv[e.id] || [];
  const s = { lines: lines.length, pieces: 0, short: 0, shortLines: 0, rent: 0 };
  lines.forEach(c => {
    s.pieces += Number(c.quantita) || 0;
    const i = lineInfo(e, c);
    s.rent += i.sub;
    if (i.short > 0) { s.short += i.short; s.shortLines++; }
  });
  return s;
}
function lineCat(c) {
  const m = c.equipment_id ? S.matById[c.equipment_id] : null;
  return m ? (catKey(m.categoria) || 'generale') : 'altro';
}
function lineName(c) { const m = c.equipment_id ? S.matById[c.equipment_id] : null; return m ? m.nome : c.materiale; }
function cmpName(a, b) { return String(a).localeCompare(String(b), 'it', { sensitivity: 'base' }); }
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

/* ---------- messaggi WhatsApp ---------- */
function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
function convMsg(e, a, t) {
  const nome = firstName(a.tecnico || (t && t.nome));
  const az = S.cfg.nome_azienda ? S.cfg.nome_azienda + ': ' : '';
  const lines = ['Ciao ' + nome + ', ' + az + 'ti convoco per *' + e.cliente + '*, ' + fmtLong(e.data) + '.'];
  if (STAGES_PROVVISORIE.indexOf(e.stato) >= 0) {
    lines.push('Attenzione: è ancora provvisorio (' + STAGE_LABEL[e.stato].toLowerCase() + '), il cliente non ha ancora confermato.');
  }
  lines.push('Ruolo: ' + uniq(rolesOf(a.ruoli)).join(' + '));
  const tm = timesList(e).map(x => x[0].toLowerCase() + ' ' + x[1]).join(', ');
  if (tm) lines.push(cap(tm));
  if (e.luogo) lines.push('Luogo: ' + e.luogo);
  if (e.noteTecnici) lines.push('Note: ' + e.noteTecnici);
  if (S.url && a.token) { lines.push(''); lines.push('Materiale da montare e risposta con un tocco: ' + S.url + '?c=' + a.token); }
  return lines.join('\\n');
}
function linkMsg(t) {
  const url = personalUrl(t);
  return 'Ciao ' + firstName(t.nome) + ', questo è il tuo link personale' +
    (S.cfg.nome_azienda ? ' per ' + S.cfg.nome_azienda : '') + ': ' + url +
    '\\nCon questo link segni quando sei libero e vedi le tue convocazioni. Salvalo tra i preferiti.';
}
function waSentMap() { try { return JSON.parse(store.get('wasent') || '{}') || {}; } catch (e) { return {}; } }
function markSent(id) { const m = waSentMap(); m[id] = Date.now(); store.set('wasent', JSON.stringify(m)); }

/* ---------- avvisi ai tecnici quando qualcosa cambia ---------- */
const STAGE_EMOJI = { richiesta: '📝', sopralluogo: '👀', preventivo: '📝', confermato: '✅', concluso: '🏁', annullato: '❌' };
/* La frase sullo stato dell'evento, per il messaggio. Per un annullato dipende da dov'era arrivato (statoPrecedente). */
function stageSentence(e) {
  const em = (STAGE_EMOJI[e.stato] || '') + ' ';
  switch (e.stato) {
    case 'confermato':
      return em + (e.statoPrecedente === 'preventivo' ? 'PREVENTIVO ACCETTATO: l\\'evento è CONFERMATO, si fa.' : 'CONFERMATO: il cliente ha confermato, si fa.');
    case 'preventivo': return em + 'Torna in fase di PREVENTIVO: non è ancora confermato.';
    case 'sopralluogo': return em + 'In fase di SOPRALLUOGO: il programma può ancora cambiare.';
    case 'richiesta': return em + 'Torna allo stato di RICHIESTA: non è ancora deciso niente.';
    case 'concluso': return em + 'Evento concluso. Grazie a tutti!';
    case 'annullato': {
      const k = cancelKind(e);
      return em + (k === 'cancellato' ? 'EVENTO CANCELLATO: non si fa più. Non devi fare niente.' :
        k === 'preventivo' ? 'PREVENTIVO NON ACCETTATO: l\\'evento non si fa. Non devi fare niente.' :
        k === 'richiesta' ? 'RICHIESTA ANNULLATA: l\\'evento non si fa. Non devi fare niente.' :
        'ANNULLATO: l\\'evento non si fa più. Non devi fare niente.');
    }
  }
  return STAGE_LABEL[e.stato] || e.stato;
}
/* Cosa è cambiato tra due versioni di un evento, a parole: ["Arrivo: 14:00 → 15:30", ...] */
function diffEvent(a, b) {
  const out = [];
  if (a.data !== b.data) out.push('Data: ' + fmtShort(a.data) + ' → ' + fmtShort(b.data));
  TIME_FIELDS.forEach(([k, label]) => {
    const x = k === 'orarioInizioEvento' ? (a[k] || a.ora) : a[k], y = k === 'orarioInizioEvento' ? (b[k] || b.ora) : b[k];
    const fx = toMin(x) === null ? '' : fmtT(x), fy = toMin(y) === null ? '' : fmtT(y);
    if (fx === fy) return;
    out.push(label + ': ' + (fx && fy ? fx + ' → ' + fy : fy ? fy + ' (nuovo)' : 'tolto (era ' + fx + ')'));
  });
  if (String(a.luogo || '') !== String(b.luogo || '')) out.push('Luogo: ' + (b.luogo || 'da definire'));
  if (String(a.noteTecnici || '') !== String(b.noteTecnici || '')) out.push('Note: ' + (b.noteTecnici || 'nessuna nota'));
  return out;
}
function avRecipients(e) { return (S.asgByEv[e.id] || []).filter(a => a.stato !== 'rifiutato'); }
/* Il corpo del messaggio (uguale per tutti): a ognuno si aggiungono il saluto e il suo link personale */
function avBase(e, kind, ctx) {
  const az = S.cfg.nome_azienda ? S.cfg.nome_azienda + ': ' : '';
  const lines = [az + 'aggiornamento su *' + e.cliente + '* (' + fmtLong(e.data) + '):'];
  if (kind === 'stato') {
    lines.push(stageSentence(e));
    if (e.statoNota) lines.push('Nota: ' + e.statoNota);
  } else if (kind === 'dati') {
    ((ctx && ctx.changes) || []).forEach(x => lines.push('• ' + x));
  } else if (kind === 'materiale') {
    const n = (S.carByEv[e.id] || []).length;
    lines.push('Il materiale da montare è stato aggiornato' + (n ? ' (' + plural(n, 'voce', 'voci') + ')' : '') + '.');
  } else {   // orari e luogo, come stanno adesso
    const tm = timesList(e).map(x => x[0] + ' ' + x[1]).join(', ');
    if (tm) lines.push('Orari: ' + tm);
    if (e.luogo) lines.push('Luogo: ' + e.luogo);
    if (e.noteTecnici) lines.push('Note: ' + e.noteTecnici);
    if (lines.length === 1) lines.push('Non ci sono ancora orari o luogo.');
  }
  return lines.join('\\n');
}
function avFull(base, a, t) {
  let m = 'Ciao ' + firstName(a.tecnico || (t && t.nome)) + ',\\n' + base;
  if (S.url && a.token) m += '\\n\\nOrari, luogo e materiale da montare: ' + S.url + '?c=' + a.token;
  return m;
}
function avGroup(base) { return base + '\\n\\nI dettagli (orari, luogo, materiale) sono nella tua pagina personale.'; }

/* ---------- schermate ---------- */
function loadingView() { return '<div class="wrap"><p class="empty">Carico i dati…</p></div>'; }
function errorView(msg, retryAct) {
  return '<div class="wrap"><div class="pageerr" role="alert"><h2>Non riesco a caricare</h2><p>' + esc(msg) + '</p>' +
    '<div class="row" style="margin-top:12px"><button class="btn pri" data-act="' + retryAct + '">Riprova</button></div></div></div>';
}
function loginView(msg) {
  return '<main class="login"><h1>Gestionale service</h1>' +
    '<p>Area del coordinatore. Scrivi il codice che hai messo nella scheda Config del foglio.</p>' +
    '<form data-submit="login" novalidate><label class="fld"><span>Codice coordinatore</span>' +
    '<input type="password" name="pin" autocomplete="current-password" autocapitalize="off"></label>' +
    '<p class="ferr" role="alert">' + esc(msg || '') + '</p>' +
    '<button class="btn pri" type="submit" style="width:100%">Entra</button></form>' +
    '<p class="hint" style="margin-top:24px">Sei un tecnico? Apri il link personale che ti ha mandato il coordinatore: qui non serve il codice.</p></main>';
}

function coordView() {
  const tabs = [['eventi', 'Eventi'], ['disp', 'Disponibilità'], ['tecnici', 'Tecnici'], ['mag', 'Magazzino']];
  const gaps = S.mancano.length
    ? '<p class="banner" role="alert"><b>Il foglio non è aggiornato.</b> Hai messo il codice nuovo ma manca un passaggio: apri Estensioni > Apps Script, ' +
      'scegli la funzione <b>setup</b> nel menu in alto e premi Esegui. Poi aggiorna questa pagina. <small>(Mancano: ' + esc(S.mancano.join(', ')) + ')</small></p>'
    : '';
  return '<header class="mast"><div class="wrap mastin"><div class="brand">' + esc(S.cfg.nome_azienda || 'Gestionale service') +
    '<small>Coordinatore</small></div><div class="mastact">' +
    '<button class="ib" data-act="refresh" aria-label="Aggiorna i dati">' + ico('refresh') + '</button>' +
    '<button class="ib" data-act="logout" aria-label="Esci">' + ico('out') + '</button></div></div></header>' +
    '<div class="stick"><nav class="tabs" role="tablist" aria-label="Sezioni"><div class="wrap tabsin">' +
    tabs.map(t => '<button role="tab" class="tab" aria-selected="' + (S.tab === t[0]) + '" data-act="tab" data-tab="' + t[0] + '">' +
      t[1] + '</button>').join('') +
    '</div></nav><div class="hazard"></div></div>' +
    '<main class="wrap main" role="tabpanel">' + gaps +
    (S.tab === 'eventi' ? viewEventi() : S.tab === 'disp' ? viewDisp() : S.tab === 'mag' ? viewMag() : viewTecnici()) + '</main>';
}

/* ---------- scheda Eventi ---------- */
function isUpcoming(e) { return String(e.data || '') >= S.oggi && e.stato !== 'annullato'; }
function startMin(e) { const w = evWin(e); return (w && w.s !== null) ? w.s : 9999; }
function cmpEv(a, b) {
  return String(a.data || '').localeCompare(String(b.data || '')) || (startMin(a) - startMin(b)) ||
    String(a.cliente).localeCompare(String(b.cliente), 'it');
}
function dayHead(date) {
  const p = parseYMD(date);
  if (!p) return '<header class="dayh"><span class="dtxt"><b>Senza data</b></span></header>';
  const diff = dayNum(date) - dayNum(S.oggi);
  const tag = diff === 0 ? '<span class="dtag">oggi</span>' : diff === 1 ? '<span class="dtag soft">domani</span>' :
    diff === 2 ? '<span class="dtag soft">dopodomani</span>' : '';
  const yr = parseYMD(S.oggi).y;
  return '<header class="dayh"><span class="dnum">' + p.d + '</span><span class="dtxt"><b>' + GIORNI[wday(date)] + '</b>' +
    MESI[p.m - 1] + (p.y !== yr ? ' ' + p.y : '') + '</span>' + tag + '</header>';
}
function groupByDay(list) {
  const groups = [];
  list.forEach(e => {
    const last = groups[groups.length - 1];
    if (last && last.date === e.data) last.items.push(e); else groups.push({ date: e.data, items: [e] });
  });
  return groups.map(g => {
    const n = g.items.filter(e => e.stato !== 'annullato').length;
    return '<section class="day">' + dayHead(g.date) + (n >= 2 ? dayBarHtml(g.date, n) : '') + g.items.map(evRow).join('') + '</section>';
  }).join('');
}
function viewEventi() {
  const up = S.ev.filter(isUpcoming).sort(cmpEv);
  const past = S.ev.filter(e => !isUpcoming(e)).sort((a, b) => cmpEv(b, a));
  const hasCal = S.asg.some(a => a.calendarEventId);
  let h = '<div class="toolbar"><button class="btn pri" data-act="newEv">' + ico('plus') + ' Nuovo evento</button>' +
    (hasCal ? '<button class="btn sm" data-act="syncCal">' + ico('cal') + ' Leggi le risposte da Calendar</button>' : '') +
    '<label class="chk"><input type="checkbox" data-chg="showPast"' + (S.showPast ? ' checked' : '') +
    '> Mostra passati e annullati</label></div>';
  h += todoBoxHtml();
  if (!up.length && !(S.showPast && past.length)) {
    h += '<p class="empty">Nessun evento in programma. Tocca «Nuovo evento» per aggiungere il primo.</p>';
  }
  h += groupByDay(up);
  if (S.showPast && past.length) h += '<h2 class="monthsep" style="margin-top:28px">Passati e annullati</h2>' + groupByDay(past);
  return h;
}
function slotHtml(s) {
  const r = s.role;
  if (!s.a) return '<span class="slot open r-' + r + '"><span class="sr">' + r + '</span><span class="sn">libero</span></span>';
  const ok = s.a.stato === 'confermato';
  const n = uniq(rolesOf(s.a.ruoli)).length;
  const title = esc(s.a.tecnico + ' - ' + (ok ? 'ha confermato' : 'in attesa di risposta') + (n > 1 ? ' - fa ' + n + ' ruoli' : ''));
  return '<span class="slot ' + (ok ? 'ok' : 'pend') + (s.extra ? ' extra' : '') + ' r-' + r + '" title="' + title + '">' +
    '<span class="sr">' + r + '</span><span class="sn">' + esc(firstName(s.a.tecnico)) + '</span>' +
    (ok ? ico('check') : '') + '<span class="vh">' + (ok ? 'confermato' : 'in attesa') + '</span></span>';
}
function evRow(e) {
  const open = S.openEv === e.id;
  const cov = coverage(e);
  const sub = [];
  if (e.luogo) sub.push('<span>' + esc(e.luogo) + '</span>');
  const sf = [['orarioArrivo', 'arrivo'], ['orarioMontaggio', 'montaggio'], ['ora', 'inizio'], ['orarioInizioEvento', 'inizio']]
    .filter(x => toMin(e[x[0]]) !== null)[0];
  if (sf) sub.push('<span>' + sf[1] + ' <b>' + fmtT(e[sf[0]]) + '</b></span>');
  if (toMin(e.orarioFineEvento) !== null) sub.push('<span>fine <b>' + fmtT(e.orarioFineEvento) + '</b></span>');
  const clash = (S.asgByEv[e.id] || []).some(a => {
    const t = S.tecById[a.technician_id];
    return a.stato !== 'rifiutato' && t && techStatus(t, e).clash;
  });
  if (clash) sub.push('<span class="alert">Un tecnico è già su un altro evento</span>');
  if (isUpcoming(e)) {
    const ms = matSummary(e);
    if (ms.shortLines) sub.push('<span class="alert">Manca materiale (' + plural(ms.shortLines, 'articolo', 'articoli') + ')</span>');
    else if (!ms.lines && e.stato === 'confermato') sub.push('<span class="warnt">Elenco del materiale da fare</span>');
  }
  logiBadges(e).forEach(x => sub.push(x));
  let slots = cov.slots.map(slotHtml).join('');
  if (!cov.slots.length && e.stato !== 'annullato') slots = '<span class="muted" style="font-size:14px">Nessun ruolo richiesto</span>';
  return '<article class="ev st-' + esc(e.stato) + (open ? ' open' : '') + '" id="ev-' + esc(e.id) + '">' +
    '<button type="button" class="evh" data-act="toggleEv" data-id="' + esc(e.id) + '" aria-expanded="' + open + '">' +
    '<span class="evtop"><span class="evt">' + esc(e.cliente || 'Senza nome') + '</span>' +
    '<span class="pill ' + (STAGE_PILL[e.stato] || 'muted') + '">' + esc(STAGE_LABEL[e.stato] || e.stato) + '</span></span>' +
    (sub.length ? '<span class="evsub">' + sub.join('') + '</span>' : '') +
    (slots ? '<span class="slots">' + slots + '</span>' : '') + '</button>' +
    (open ? evPanel(e, cov) : '') + '</article>';
}

function evPanel(e, cov) {
  const cancelled = e.stato === 'annullato';
  let h = '<div class="panel">' + timesHtml(e);
  const facts = [];
  if (e.luogo) facts.push('<div><span class="k">Luogo: </span>' + esc(e.luogo) + '</div>');
  if (e.noteTecnici) facts.push('<div><span class="k">Note per i tecnici: </span>' + esc(e.noteTecnici) + '</div>');
  if (e.telefonoCliente) facts.push('<div><span class="k">Telefono cliente: </span><a href="tel:' + esc(String(e.telefonoCliente).replace(/[^\\d+]/g, '')) + '">' + esc(fmtPhone(e.telefonoCliente)) + '</a></div>');
  if (e.noteSopralluogo) facts.push('<div><span class="k">Sopralluogo: </span>' + esc(e.noteSopralluogo) + '</div>');
  if (facts.length) h += '<div class="facts">' + facts.join('') + '</div>';
  const when = fmtStamp(e.statoAggiornato);
  h += '<div class="stline"><span class="pill ' + (STAGE_PILL[e.stato] || 'muted') + '">' + esc(STAGE_LABEL[e.stato] || e.stato) + '</span>' +
    (when ? '<span class="muted">dal ' + esc(when) + '</span>' : '') +
    (e.statoNota ? '<span class="stn">«' + esc(e.statoNota) + '»</span>' : '') + '</div>';
  h += '<div class="row" style="margin-top:12px"><button type="button" class="btn sm" data-act="stageOpen" data-id="' + esc(e.id) + '">' +
    ico('bell') + ' Cambia stato</button><button type="button" class="btn sm" data-act="editEv" data-id="' + esc(e.id) + '">' +
    ico('edit') + ' Modifica evento</button></div>';
  h += '<h4>Squadra</h4>' + squadraHtml(e, cancelled);
  if (!cancelled) h += openRolesHtml(e, cov);
  else h += '<p class="note muted" style="margin-top:12px">Evento annullato: non si possono fare nuove convocazioni.</p>';
  h += matSectionHtml(e);
  h += vanSectionHtml(e);
  h += expSectionHtml(e);
  return h + '</div>';
}

function techEmail(a) { const t = S.tecById[a.technician_id]; return t ? String(t.email || '').trim() : ''; }

function squadraHtml(e, cancelled) {
  const list = S.asgByEv[e.id] || [];
  if (!list.length) return '<p class="muted">Non c\\'è ancora nessuno. Scegli qui sotto, oppure tocca «Proponi squadra».</p>';
  let h = '<ul class="asgs">' + list.map(a => asgRow(e, a, cancelled)).join('') + '</ul>';
  const todo = list.filter(a => a.stato !== 'rifiutato' && !a.calendarEventId && techEmail(a));
  if (todo.length > 1 && !cancelled) {
    h += '<div class="row" style="margin-top:6px"><button type="button" class="btn sm" data-act="calAll" data-id="' + esc(e.id) + '">' +
      ico('cal') + ' Invia l\\'invito Calendar a tutti (' + todo.length + ')</button></div>';
  }
  const rec = avRecipients(e);
  if (rec.length) {
    h += '<div class="row" style="margin-top:6px"><button type="button" class="btn sm" data-act="avOpen" data-id="' + esc(e.id) + '">' +
      ico('bell') + ' Avvisa la squadra (' + rec.length + ')</button></div>';
  }
  return h;
}
function asgRow(e, a, cancelled) {
  const t = S.tecById[a.technician_id];
  const roles = uniq(rolesOf(a.ruoli));
  const refused = a.stato === 'rifiutato';
  const st = t ? techStatus(t, e) : { notes: [], cls: 'ok' };
  const chips = roles.map(r => (roles.length > 1 && !refused)
    ? '<button type="button" class="chip r-' + r + '" data-act="dropRole" data-id="' + esc(a.id) + '" data-role="' + r + '" data-confirm="Togli ' + r + '?" aria-label="Togli il ruolo ' + r + '">' + r + ' ' + ico('x') + '</button>'
    : '<span class="chip r-' + r + (refused ? ' off' : '') + '">' + r + '</span>').join('');
  const link = (t && !cancelled && !refused) ? waLink(t.telefono, convMsg(e, a, t), S.cfg.prefisso_telefono) : '';
  const sent = !!waSentMap()[a.id];
  let acts = '';
  if (!cancelled && !refused) {
    acts += link
      ? '<a class="btn sm" href="' + esc(link) + '" target="_blank" rel="noopener" data-act="wa" data-id="' + esc(a.id) + '">' + ico('chat') + (sent ? ' Manda di nuovo su WhatsApp' : ' Convoca su WhatsApp') + '</a>'
      : '<span class="note muted">Manca il telefono: aggiungilo nella scheda Tecnici</span>';
    if (a.calendarEventId) acts += '<span class="sent">' + ico('check') + ' Invito Calendar inviato</span>';
    else if (techEmail(a)) acts += '<button type="button" class="btn sm" data-act="cal" data-id="' + esc(a.id) + '">' + ico('cal') + ' Invito Calendar</button>';
  }
  acts += '<select aria-label="Risposta di ' + esc(a.tecnico) + '" data-chg="asgState" data-id="' + esc(a.id) + '">' +
    ASG_STATES.map(s => '<option value="' + s + '"' + (s === a.stato ? ' selected' : '') + '>' + s + '</option>').join('') + '</select>';
  const extra = t ? uniq(rolesOf(t.ruoli)).filter(r => roles.indexOf(r) < 0) : [];
  if (extra.length && !refused && !cancelled) {
    acts += '<button type="button" class="btn sm" data-act="addRole" data-id="' + esc(a.id) + '" aria-expanded="' + (S.addRoleFor === a.id) + '">' + ico('plus') + ' Ruolo</button>';
  }
  acts += '<button type="button" class="btn sm danger" data-act="unassign" data-id="' + esc(a.id) + '" data-confirm="Sicuro?">Rimuovi</button>';
  let more = '';
  if (S.addRoleFor === a.id && extra.length) {
    more = '<div class="asgact">' + extra.map(r => '<button type="button" class="btn sm" data-act="addRoleDo" data-id="' + esc(a.id) + '" data-role="' + r + '">Aggiungi ' + r + '</button>').join('') + '</div>';
  }
  const notes = (!refused && !cancelled) ? st.notes.map(n => '<p class="note ' + (st.cls === 'bad' ? 'bad' : 'warn') + '">' + esc(cap(n)) + '</p>').join('') : '';
  return '<li class="asg ' + esc(a.stato.replace(/\\s/g, '-')) + '"><div class="asgtop"><b>' + esc(a.tecnico) + '</b>' + chips +
    '<span class="pill ' + (ASG_PILL[a.stato] || 'muted') + '">' + esc(a.stato) + '</span></div>' + notes +
    '<div class="asgact">' + acts + '</div>' + more + '</li>';
}

function openRolesHtml(e, cov) {
  if (!cov.need) {
    return '<h4>Ruoli</h4><p class="muted">Nessun ruolo richiesto. Con «Modifica evento» indichi quanti tecnici servono.</p>';
  }
  if (!cov.open.length) return '<p style="margin-top:14px"><span class="pill ok">Squadra completa</span></p>';
  let h = '<h4>Ancora da coprire</h4><div class="slots">' + cov.open.map(r =>
    '<span class="slot open r-' + r + '"><span class="sr">' + r + '</span><span class="sn">libero</span></span>').join('') + '</div>';
  h += '<div class="row" style="margin-top:12px"><button type="button" class="btn pri" data-act="propose" data-id="' + esc(e.id) + '">Proponi squadra</button>' +
    '<label class="chk"><input type="checkbox" data-chg="allowDouble"' + (S.allowDouble ? ' checked' : '') + '> Un tecnico può fare 2 ruoli</label></div>';
  if (S.prop && S.prop.evId === e.id) h += propHtml();
  return h + candidatesHtml(e, cov);
}
function propHtml() {
  const p = S.prop;
  const any = p.picks.length + p.adds.length > 0;
  let h = '<div class="box prop" id="prop"><h4>Squadra proposta</h4>';
  p.picks.forEach(x => {
    const notes = [];
    if (x.dbl) notes.push(['warn', 'Copre due ruoli nello stesso evento: va bene solo se è fattibile senza affaticarlo troppo.']);
    if (x.st.avail !== 'yes') notes.push(['muted', 'Non ha ancora indicato se è libero quel giorno.']);
    x.st.notes.forEach(n => notes.push(['warn', cap(n) + '.']));
    h += '<div class="pickrow"><div class="asgtop"><b class="cname">' + esc(x.t.nome) + '</b>' +
      x.roles.map(r => '<span class="chip r-' + r + '">' + r + '</span>').join('') + '</div>' +
      notes.map(n => '<p class="note ' + n[0] + '">' + esc(n[1]) + '</p>').join('') + '</div>';
  });
  p.adds.forEach(x => {
    const notes = [['warn', 'Fa già ' + x.had.join(' + ') + ': con questo ruolo ne farebbe due.']];
    if (x.a.stato === 'confermato') notes.push(['warn', 'Aveva già confermato: dovrai rimandargli la convocazione per il ruolo in più.']);
    h += '<div class="pickrow"><div class="asgtop"><b class="cname">' + esc(x.t.nome) + '</b>' +
      x.added.map(r => '<span class="chip r-' + r + '">' + r + '</span>').join('') +
      '<span class="pill muted">già in squadra</span></div>' +
      notes.map(n => '<p class="note ' + n[0] + '">' + esc(n[1]) + '</p>').join('') + '</div>';
  });
  if (p.missing.length) {
    h += '<p class="note bad">Non trovo nessuno per: ' + esc(p.missing.join(', ')) + '. Guarda l\\'elenco qui sotto o cambia le mansioni dei tecnici.</p>';
  }
  h += '<div class="row" style="margin-top:12px">' +
    (any ? '<button type="button" class="btn pri" data-act="applyProp">Assegna questa squadra</button>' : '') +
    '<button type="button" class="btn" data-act="closeProp">Chiudi</button></div></div>';
  return h;
}
function candidatesHtml(e, cov) {
  const assigned = new Set((S.asgByEv[e.id] || []).map(a => a.technician_id));
  const rows = S.tec.filter(t => isActive(t) && !assigned.has(t.id)).map(t => ({
    t: t, can: uniq(rolesOf(t.ruoli)).filter(r => cov.open.indexOf(r) >= 0), st: techStatus(t, e),
  })).filter(c => c.can.length).sort((a, b) => byName(a.t, b.t));
  if (!rows.length) {
    return '<p class="note muted" style="margin-top:12px">' + ((S.asgByEv[e.id] || []).length ? 'Nessun altro tecnico attivo' : 'Nessun tecnico attivo') +
      ' ha le mansioni che mancano. Controlla le mansioni nella scheda Tecnici.</p>';
  }
  const groups = [
    ['Liberi', rows.filter(c => c.st.cls !== 'bad' && c.st.avail === 'yes')],
    ['Non hanno ancora risposto', rows.filter(c => c.st.cls !== 'bad' && c.st.avail !== 'yes')],
    ['Non disponibili o già impegnati', rows.filter(c => c.st.cls === 'bad')],
  ];
  return groups.filter(g => g[1].length).map(g => '<h5>' + g[0] + '</h5><ul class="cands">' + g[1].map(c => candRow(e, c)).join('') + '</ul>').join('');
}
function candRow(e, c) {
  const bad = c.st.cls === 'bad';
  const cls = bad ? ' danger' : '';
  const conf = bad ? ' data-confirm="Assegno lo stesso?"' : '';
  const btns = c.can.map(r => '<button type="button" class="btn sm' + cls + '"' + conf + ' data-act="assign" data-ev="' + esc(e.id) + '" data-tech="' + esc(c.t.id) + '" data-roles="' + r + '">Come ' + r + '</button>');
  if (c.can.length > 1) {
    btns.push('<button type="button" class="btn sm' + cls + '"' + conf + ' data-act="assign" data-ev="' + esc(e.id) + '" data-tech="' + esc(c.t.id) + '" data-roles="' + c.can.join(',') + '">Tutti e ' + c.can.length + ': ' + c.can.join(' + ') + '</button>');
  }
  const when = c.st.avail === 'yes' ? '<span class="pill ok">libero' + (c.st.from ? ' dalle ' + esc(fmtT(c.st.from)) : '') + '</span>' :
    c.st.avail === 'no' ? '<span class="pill bad">non disponibile</span>' : '<span class="pill muted">nessuna risposta</span>';
  const all = uniq(rolesOf(c.t.ruoli));
  return '<li><div class="asgtop"><span class="cname">' + esc(c.t.nome) + '</span>' + when +
    all.map(r => '<span class="chip r-' + r + (c.can.indexOf(r) < 0 ? ' off' : '') + '">' + r + '</span>').join('') + '</div>' +
    c.st.notes.map(n => '<p class="note ' + (bad ? 'bad' : 'warn') + '">' + esc(cap(n)) + '</p>').join('') +
    '<div class="asgact">' + btns.join('') + '</div></li>';
}

/* ---------- materiale dell'evento ---------- */
function qtyField(name, val, min, max, label, extra) {
  return '<span class="qty"><button type="button" data-act="qstep" data-d="-1" aria-label="Uno in meno: ' + esc(label) + '">−</button>' +
    '<input type="number" inputmode="numeric" name="' + name + '" value="' + val + '" min="' + min + '" max="' + max + '" aria-label="' + esc(label) + '"' + (extra || '') + '>' +
    '<button type="button" data-act="qstep" data-d="1" aria-label="Uno in più: ' + esc(label) + '">+</button></span>';
}
function groupLines(lines) {
  const g = {};
  lines.forEach(c => { const k = lineCat(c); (g[k] = g[k] || []).push(c); });
  return Object.keys(g).sort(cmpCat).map(k => ({ cat: k, items: g[k].sort((a, b) => cmpName(lineName(a), lineName(b))) }));
}
function tentToggle() {
  return '<label class="chk"><input type="checkbox" data-chg="countTent"' + (S.countTent ? ' checked' : '') +
    '> Conta anche gli eventi non ancora confermati</label>';
}
function matSectionHtml(e) {
  const lines = S.carByEv[e.id] || [];
  const cancelled = e.stato === 'annullato';
  const ms = matSummary(e);
  let h = '<h4>Materiale</h4>';
  if (!lines.length) {
    h += '<p class="muted">Non c\\'è ancora l\\'elenco di cosa si monta.' + (cancelled ? '' : ' Aggiungilo qui: i tecnici lo vedono nella loro pagina.') + '</p>';
  } else {
    h += '<p class="matsum">' + plural(ms.lines, 'voce', 'voci') + ', ' + plural(ms.pieces, 'pezzo', 'pezzi') +
      (ms.rent ? ' <span class="pill blue">' + ms.rent + ' a noleggio</span>' : '') +
      (ms.shortLines ? ' <span class="pill bad">manca materiale</span>' : (cancelled ? '' : ' <span class="pill ok">tutto disponibile</span>')) + '</p>';
    h += groupLines(lines).map(g => '<h5>' + esc(catLabel(g.cat)) + '</h5><ul class="mats">' + g.items.map(c => lineRow(e, c)).join('') + '</ul>').join('');
  }
  if (cancelled) return h;
  h += '<div class="row" style="margin-top:12px"><button type="button" class="btn sm pri" data-act="matAdd" data-id="' + esc(e.id) + '">' + ico('plus') + ' Aggiungi materiale</button>' +
    '<button type="button" class="btn sm" data-act="matCopy" data-id="' + esc(e.id) + '">' + ico('copy') + ' Copia da un altro evento</button></div>';
  if (lines.length) {
    h += '<div class="row" style="margin-top:8px">' +
      (avRecipients(e).length ? '<button type="button" class="btn sm" data-act="avOpen" data-kind="materiale" data-id="' + esc(e.id) + '">' + ico('bell') + ' Avvisa che il materiale è cambiato</button>' : '') +
      '<button type="button" class="btn sm danger" data-act="matClear" data-id="' + esc(e.id) + '" data-confirm="Svuoto tutto? Tocca di nuovo">Svuota l\\'elenco</button></div>';
  }
  return h + '<div style="margin-top:6px">' + tentToggle() + '</div>';
}
function lineRow(e, c) {
  const i = lineInfo(e, c);
  const open = S.openLine === c.id;
  const q = Number(c.quantita) || 0;
  let pills = '';
  if (i.short > 0) pills += '<span class="pill bad">mancano ' + i.short + '</span>';
  if (i.sub > 0) pills += '<span class="pill blue">' + (i.sub >= q ? 'tutto a noleggio' : i.sub + ' a noleggio') + '</span>';
  return '<li class="mrow' + (i.short > 0 ? ' short' : '') + (open ? ' open' : '') + '">' +
    '<button type="button" class="mline" data-act="lineToggle" data-id="' + esc(c.id) + '" aria-expanded="' + open + '">' +
    '<span class="mq">' + q + '</span><span class="mn">' + esc(lineName(c)) + (c.note ? '<small>' + esc(c.note) + '</small>' : '') + '</span>' +
    (pills ? '<span class="mp">' + pills + '</span>' : '') + '</button>' + (open ? lineEditor(e, c, i) : '') + '</li>';
}
function availHtml(i, lineId) {
  if (!i.m) return '<p class="note muted">Questo articolo non è nel magazzino (noleggio da fuori o scritto a mano): non controllo la disponibilità.</p>';
  const a = i.a, m = i.m;
  let t = 'In magazzino ' + (Number(m.quantita) || 0) + (m.fuoriServizio ? ' (' + m.fuoriServizio + ' fuori uso)' : '') + '.';
  if (String(m.stato) === 'dismesso') t = 'Questo articolo è stato dismesso: non è più in magazzino.';
  else if (a.used.length) {
    t += ' Negli stessi giorni servono anche a: ' + a.used.map(u => u.e.cliente + ' ' + u.q +
      (u.e.stato === 'confermato' || u.e.stato === 'concluso' ? '' : ' (' + STAGE_LABEL[u.e.stato].toLowerCase() + ')')).join(', ') + '.';
  } else t += ' Negli stessi giorni nessun altro evento li usa.';
  let h = '<p class="note ' + (i.short ? 'bad' : 'muted') + '">' + esc(t + (i.short ? ' Per questo evento ne mancano ' + i.short + '.' : '')) + '</p>';
  if (i.short) {
    h += '<div class="row" style="margin-top:6px"><button type="button" class="btn sm" data-act="lineRent" data-id="' + esc(lineId) + '" data-n="' + i.short + '">Segna ' +
      (i.short === 1 ? 'il pezzo mancante' : 'i ' + i.short + ' mancanti') + ' come noleggio</button></div>';
  }
  return h;
}
function lineEditor(e, c, i) {
  const q = Number(c.quantita) || 0;
  return '<form class="medit" data-submit="lineForm" data-id="' + esc(c.id) + '" novalidate>' +
    '<div class="grid2 qtys"><div class="fld"><span>Quanti pezzi</span>' + qtyField('quantita', q, 1, 9999, 'Quanti pezzi') + '</div>' +
    '<div class="fld"><span>Di cui a noleggio</span>' + qtyField('subnoleggio', i.sub, 0, 9999, 'Pezzi a noleggio da fuori') + '</div></div>' +
    '<label class="fld"><span>Nota (la leggono anche i tecnici)</span><input type="text" name="note" value="' + esc(c.note || '') + '" maxlength="200" autocomplete="off"></label>' +
    availHtml(i, c.id) +
    '<p class="ferr" role="alert"></p><div class="row"><button type="submit" class="btn pri sm">Salva</button>' +
    '<button type="button" class="btn sm danger" data-act="lineDel" data-id="' + esc(c.id) + '" data-confirm="Sicuro?">Togli dall\\'evento</button></div></form>';
}

/* finestra "Aggiungi materiale": cerca nel magazzino, scegli le quantità, aggiungi tutto in una volta */
function pickRow(e, m) {
  const a = availFor(m, e);
  const mine = (S.carByEv[e.id] || []).filter(c => c.equipment_id === m.id).reduce((s, c) => s + fromStock(c), 0);
  const free = a.free - mine, cat = catKey(m.categoria) || 'generale';
  const av = stockOf(m) === 0 ? ['bad', 'nessuno utilizzabile'] : free <= 0 ? ['bad', 'tutti impegnati'] :
    [free < stockOf(m) ? 'warn' : 'ok', 'liberi ' + free + ' su ' + stockOf(m)];
  const text = (m.nome + ' ' + (m.marca || '') + ' ' + catLabel(cat)).toLowerCase();
  const q = S.pick[m.id] || 0;
  return '<li class="pk' + (q ? ' sel' : '') + '" data-id="' + esc(m.id) + '" data-cat="' + esc(cat) + '" data-q="' + esc(text) + '">' +
    '<div class="pkm"><b>' + esc(m.nome) + '</b><small>' + esc([m.marca, catLabel(cat)].filter(Boolean).join(' · ')) + '</small>' +
    '<span class="pkav ' + av[0] + '">' + esc(av[1]) + '</span>' + (mine ? '<span class="pkin">già nell\\'evento: ' + mine + '</span>' : '') + '</div>' +
    qtyField('q-' + m.id, q, 0, 9999, 'Quanti ' + m.nome, ' data-inp="pickQty" data-id="' + esc(m.id) + '"') + '</li>';
}
function addMatHtml(e) {
  const items = S.mat.filter(m => String(m.stato) !== 'dismesso').sort((a, b) => cmpCat(a.categoria, b.categoria) || cmpName(a.nome, b.nome));
  const cats = uniq(items.map(m => catKey(m.categoria) || 'generale')).sort(cmpCat);
  const r = occRange(e);
  const when = r ? (r[0] === r[1] ? fmtShort(e.data) : 'dal ' + fmtShort(addDays(e.data, r[0] - dayNum(e.data))) + ' al ' + fmtShort(addDays(e.data, r[1] - dayNum(e.data)))) : '';
  let h = '<p class="hint">Disponibilità calcolata per ' + esc(when) + (S.countTent ? ', contando anche gli eventi non ancora confermati' : ', solo con gli eventi confermati') + '.</p>';
  if (!items.length) {
    return h + '<p class="empty">Il magazzino è vuoto. Aggiungi gli articoli dalla scheda Magazzino, oppure scrivi qui sotto quello che serve.</p>' + freeMatHtml(e, true);
  }
  h += '<input type="search" id="pickq" class="srch" data-inp="pickSearch" placeholder="Cerca: nexo, cavo, pedana…" aria-label="Cerca nel magazzino" autocomplete="off" autocapitalize="off">';
  h += '<div class="cats" role="group" aria-label="Categoria"><button type="button" class="cat" data-act="pickCat" data-cat="" aria-pressed="true">Tutti</button>' +
    cats.map(c => '<button type="button" class="cat" data-act="pickCat" data-cat="' + esc(c) + '" aria-pressed="false">' + esc(catLabel(c)) + '</button>').join('') + '</div>';
  h += '<ul class="pick" id="pick">' + items.map(m => pickRow(e, m)).join('') + '</ul>';
  h += '<p class="empty" id="pick-empty" hidden>Nessun articolo trovato. Prova un\\'altra parola.</p>';
  h += freeMatHtml(e, false);
  h += '<div class="sheetfoot sticky"><button type="button" class="btn" data-act="closeSheet">Annulla</button>' +
    '<button type="button" class="btn pri" id="pickgo" data-act="pickGo" disabled>Scegli le quantità</button></div>';
  return h;
}
function freeMatHtml(e, open) {
  return '<details class="free"' + (open ? ' open' : '') + '><summary>Non è in magazzino? Scrivilo a mano</summary>' +
    '<form data-submit="freeForm" data-ev="' + esc(e.id) + '" novalidate><label class="fld"><span>Che cosa</span><input type="text" name="nome" maxlength="120" autocomplete="off" placeholder="es. Macchina del fumo"></label>' +
    '<div class="fld"><span>Quanti pezzi</span>' + qtyField('quantita', 1, 1, 9999, 'Quanti pezzi') + '</div>' +
    '<label class="chk"><input type="checkbox" name="noleggio" checked> È un noleggio da fuori</label>' +
    '<p class="ferr" role="alert"></p><div class="sheetfoot"><button type="submit" class="btn">Aggiungi all\\'evento</button></div></form></details>';
}
function pickTally() {
  const ids = Object.keys(S.pick);
  const pieces = ids.reduce((s, k) => s + S.pick[k], 0);
  const b = $('#pickgo');
  if (!b) return;
  b.disabled = !ids.length;
  b.textContent = ids.length ? 'Aggiungi ' + plural(ids.length, 'articolo', 'articoli') + ' (' + plural(pieces, 'pezzo', 'pezzi') + ')' : 'Scegli le quantità';
}
function pickFilter() {
  const inp = $('#pickq');
  const words = (inp ? inp.value : '').trim().toLowerCase().split(/\\s+/).filter(Boolean);
  const cat = ($('#sheet .cat[aria-pressed=true]') || { dataset: { cat: '' } }).dataset.cat || '';
  let shown = 0;
  $$('#pick .pk').forEach(li => {
    const ok = (!cat || li.dataset.cat === cat) && words.every(w => li.dataset.q.indexOf(w) >= 0);
    li.hidden = !ok;
    if (ok) shown++;
  });
  const em = $('#pick-empty');
  if (em) em.hidden = shown > 0;
}

/* ---------- scheda Disponibilità (chi è libero nei prossimi giorni, anche senza eventi) ---------- */
function viewDisp() {
  const techs = S.tec.filter(isActive).sort(byName);
  if (!techs.length) return '<p class="empty">Nessun tecnico attivo. Aggiungili dalla scheda Tecnici.</p>';
  const N = 21;
  const days = [];
  for (let i = 0; i < N; i++) days.push(addDays(S.oggi, i));
  const evPerDay = {};
  S.ev.forEach(e => { if (e.stato !== 'annullato') evPerDay[e.data] = (evPerDay[e.data] || 0) + 1; });
  const busy = {};
  S.asg.forEach(a => {
    const e = S.evById[a.event_id];
    if (a.stato === 'rifiutato' || !e || e.stato === 'annullato') return;
    const m = busy[a.technician_id] = busy[a.technician_id] || {};
    (m[e.data] = m[e.data] || []).push(e.cliente + ' (' + uniq(rolesOf(a.ruoli)).join(' + ') + ')');
  });
  const yes = {};
  let h = '<p class="hint" style="margin-top:14px">Quello che i tecnici hanno scritto per i prossimi ' + N + ' giorni, anche dove non c\\'è ancora un evento. Tocca una casella per i dettagli.</p>';
  h += '<div class="mxw"><table class="mx"><thead><tr><th class="nm" scope="col"><span class="vh">Tecnico</span></th>' + days.map((d, i) => {
    const p = parseYMD(d), w = wday(d);
    const mo = (i === 0 || p.d === 1);
    return '<th scope="col" class="dh' + (w === 0 || w === 6 ? ' we' : '') + (mo && i > 0 ? ' mo' : '') + '"><small>' + GIORNI_B[w] + '</small>' + p.d + (mo ? '<small>' + MESI_B[p.m - 1] + '</small>' : '') + '</th>';
  }).join('') + '</tr><tr><th class="nm" scope="row" style="font-size:15px;font-weight:600;color:var(--ink2)">Eventi</th>' +
    days.map(d => '<td class="evc">' + (evPerDay[d] || '') + '</td>').join('') + '</tr></thead><tbody>';
  techs.forEach(t => {
    h += '<tr><th class="nm" scope="row" title="' + esc(t.nome) + '">' + esc(t.nome) + '</th>';
    days.forEach(d => {
      const x = (S.dmap[t.id] || {})[d];
      const b = (busy[t.id] || {})[d];
      let cls = '', txt = '·', lab = 'nessuna risposta';
      if (x && x.on && x.from) { cls = 'from'; txt = fmtT(x.from); lab = 'libero dalle ' + fmtT(x.from); }
      else if (x && x.on) { cls = 'yes'; txt = 'Sì'; lab = 'libero'; }
      else if (x) { cls = 'no'; txt = 'No'; lab = 'non disponibile'; }
      if (x && x.on) yes[d] = (yes[d] || 0) + 1;
      const full = t.nome + ', ' + fmtShort(d) + ': ' + lab + (b ? '. Convocato per ' + b.join('; ') : '');
      h += '<td><button type="button" class="cell ' + cls + (b ? ' busy' : '') + '" data-act="cell" data-msg="' + esc(full) + '" aria-label="' + esc(full) + '">' + txt + '</button></td>';
    });
    h += '</tr>';
  });
  h += '</tbody><tfoot><tr><th class="nm" scope="row" style="font-size:15px;font-weight:600;color:var(--ink2)">Liberi</th>' +
    days.map(d => '<td>' + (yes[d] || '') + '</td>').join('') + '</tr></tfoot></table></div>';
  h += '<div class="legend"><span><i class="yes"></i>Libero</span><span><i class="from"></i>Libero da quell\\'ora</span>' +
    '<span><i class="no"></i>Non disponibile</span><span><i></i>Nessuna risposta</span><span><i class="busy"></i>Già convocato</span></div>';
  return h;
}

/* ---------- scheda Tecnici ---------- */
function viewTecnici() {
  const list = S.tec.slice().sort((a, b) => (isActive(b) - isActive(a)) || byName(a, b));
  let h = '';
  if (!S.url || /\\/dev$/.test(S.url)) {
    h += '<p class="banner">I link personali dei tecnici funzionano solo se apri l\\'app dal link che finisce con <b>/exec</b> (Esegui il deployment > Gestisci i deployment). Ora stai usando una versione di prova.</p>';
  }
  h += '<div class="toolbar"><button class="btn pri" data-act="techNew">' + ico('plus') + ' Nuovo tecnico</button>' +
    '<span class="muted">' + S.tec.filter(isActive).length + ' in squadra</span></div>';
  h += rimbBoxHtml();
  if (!list.length) return h + '<p class="empty">Nessun tecnico. Aggiungi il primo: bastano il nome e una mansione.</p>';
  const end = addDays(S.oggi, 13);
  return h + list.map(t => {
    const roles = uniq(rolesOf(t.ruoli));
    const answered = Object.keys(S.dmap[t.id] || {}).filter(d => d >= S.oggi && d <= end).length;
    const link = personalUrl(t);
    const wa = link ? waLink(t.telefono, linkMsg(t), S.cfg.prefisso_telefono) : '';
    const cv = safeUrl(t.cvLink);
    const info = [];
    if (t.telefono) info.push('<div><a href="tel:' + esc(String(t.telefono).replace(/[^\\d+]/g, '')) + '">' + esc(fmtPhone(t.telefono)) + '</a></div>');
    if (t.email) info.push('<div>' + esc(t.email) + '</div>');
    if (cv) info.push('<div><a href="' + esc(cv) + '" target="_blank" rel="noopener">Curriculum</a></div>');
    else if (t.cvLink) info.push('<div>' + esc(t.cvLink) + '</div>');
    if (t.note) info.push('<div>' + esc(t.note) + '</div>');
    info.push('<div>' + (isActive(t) ? 'Ha risposto per ' + answered + ' dei prossimi 14 giorni' : 'Non in squadra') + '</div>');
    const due = tecDueHtml(t);
    if (due) info.push(due);
    return '<article class="tec' + (isActive(t) ? '' : ' inactive') + '" id="tec-' + esc(t.id) + '">' +
      '<div class="asgtop"><span class="tname">' + esc(t.nome) + '</span>' +
      roles.map(r => '<span class="chip r-' + r + '">' + r + '</span>').join('') +
      (isActive(t) ? '' : '<span class="pill muted">non in squadra</span>') + '</div>' +
      '<div class="tinfo">' + info.join('') + '</div><div class="tact">' +
      (wa ? '<a class="btn sm" href="' + esc(wa) + '" target="_blank" rel="noopener">' + ico('chat') + ' Manda il link su WhatsApp</a>'
        : (link ? '<span class="note muted">Manca il telefono per WhatsApp</span>' : '')) +
      (link ? '<button type="button" class="btn sm" data-act="copyLink" data-id="' + esc(t.id) + '">' + ico('link') + ' Copia il link</button>' : '') +
      '<button type="button" class="btn sm" data-act="techEdit" data-id="' + esc(t.id) + '">' + ico('edit') + ' Modifica</button></div></article>';
  }).join('');
}

/* ---------- scheda Magazzino ---------- */
/* Come sta un articolo in un certo giorno (numero di giorno): quanti pezzi sono usati dagli eventi di quel giorno */
function stockOnDay(m, dn) {
  const used = [];
  (S.useByEq[m.id] || []).forEach(u => {
    if (!holdsStock(u.e)) return;
    const r = occRange(u.e);
    if (!r || dn < r[0] || dn > r[1]) return;
    const q = fromStock(u.c);
    if (q > 0) used.push({ e: u.e, q: q });
  });
  const usedQ = neededTogether(used);
  return { stock: stockOf(m), used: used, usedQ: usedQ, free: stockOf(m) - usedQ };
}
function stkText(m) { return (m.nome + ' ' + (m.marca || '') + ' ' + catLabel(m.categoria) + ' ' + (m.note || '')).toLowerCase(); }
function stkHidden(m) {
  const cat = catKey(m.categoria) || 'generale';
  if (S.stockCat === '~scorta' ? !isLow(m) : (S.stockCat && cat !== S.stockCat)) return true;
  const t = stkText(m);
  return !S.stockQ.trim().toLowerCase().split(/\\s+/).filter(Boolean).every(w => t.indexOf(w) >= 0);
}
function stkRow(m, dn) {
  const u = stockOnDay(m, dn);
  const open = S.openStk === m.id;
  const out = Number(m.fuoriServizio) || 0, tot = Number(m.quantita) || 0;
  const dismissed = String(m.stato) === 'dismesso';
  const cat = catKey(m.categoria) || 'generale';
  let pill;
  if (dismissed) pill = '<span class="pill muted">dismesso</span>';
  else if (u.free < 0) pill = '<span class="pill bad">sovraprenotato di ' + (-u.free) + '</span>';
  else if (u.stock === 0) pill = '<span class="pill muted">nessuno utilizzabile</span>';
  else if (u.free === 0) pill = '<span class="pill warn">tutti impegnati</span>';
  else pill = '<span class="pill ok">' + (u.free === 1 ? '1 libero' : u.free + ' liberi') + '</span>';
  if (isLow(m)) pill += '<span class="pill warn">sotto scorta</span>';
  const bits = [tot + ' in tutto'];
  if (out) bits.push(out + ' fuori uso');
  if (u.usedQ) bits.push(u.usedQ + ' impegnati');
  let det = '';
  if (open) {
    det = '<div class="stkd">';
    if (u.used.length) {
      det += '<p>Quel giorno servono a: ' + u.used.map(x => '<b>' + esc(x.e.cliente) + '</b> ' + x.q +
        (x.e.stato === 'confermato' || x.e.stato === 'concluso' ? '' : ' <span class="muted">(' + esc(STAGE_LABEL[x.e.stato].toLowerCase()) + ')</span>')).join(', ') + '.</p>';
    } else if (!dismissed) det += '<p class="muted">Quel giorno nessun evento li usa.</p>';
    const spec = [];
    if (m.peso_kg !== '' && m.peso_kg != null) spec.push(m.peso_kg + ' kg');
    const dims = [m.larghezza_mm, m.altezza_mm, m.profondita_mm].filter(x => x !== '' && x != null);
    if (dims.length === 3) spec.push(dims.join(' × ') + ' mm');
    if (spec.length) det += '<p class="muted">' + esc(spec.join(' · ')) + '</p>';
    if (m.note) det += '<p>' + esc(m.note) + '</p>';
    det += stkExtraHtml(m);
    det += '<div class="row"><button type="button" class="btn sm" data-act="movOpen" data-id="' + esc(m.id) + '" data-tipo="entrata"' + (dismissed ? ' disabled' : '') + '>' + ico('down') + ' Entrata</button>' +
      '<button type="button" class="btn sm" data-act="movOpen" data-id="' + esc(m.id) + '" data-tipo="uscita"' + (dismissed ? ' disabled' : '') + '>' + ico('up') + ' Uscita</button>' +
      '<button type="button" class="btn sm" data-act="brkOpen" data-id="' + esc(m.id) + '"' + (dismissed ? ' disabled' : '') + '>' + ico('wrench') + ' Guasto</button>' +
      '<button type="button" class="btn sm" data-act="matEdit" data-id="' + esc(m.id) + '">' + ico('edit') + ' Modifica</button></div></div>';
  }
  return '<article class="stk' + (open ? ' open' : '') + (dismissed ? ' off' : '') + '" data-cat="' + esc(cat) + '" data-low="' + (isLow(m) ? '1' : '') + '" data-q="' + esc(stkText(m)) + '"' + (stkHidden(m) ? ' hidden' : '') + '>' +
    '<button type="button" class="stkh" data-act="stkToggle" data-id="' + esc(m.id) + '" aria-expanded="' + open + '">' +
    '<span class="stkn">' + esc(m.nome) + (m.marca ? '<small>' + esc(m.marca) + '</small>' : '') + '</span>' +
    '<span class="stkc">' + pill + '<small>' + esc(bits.join(' · ')) + '</small></span></button>' + det + '</article>';
}
function viewArticoli() {
  const date = parseYMD(S.stockDate) ? S.stockDate : S.oggi;
  const dn = dayNum(date);
  const all = S.mat.slice().sort((a, b) => cmpCat(a.categoria, b.categoria) || cmpName(a.nome, b.nome));
  const active = all.filter(m => String(m.stato) !== 'dismesso');
  const cats = uniq(active.map(m => catKey(m.categoria) || 'generale')).sort(cmpCat);
  const pieces = active.reduce((s, m) => s + (Number(m.quantita) || 0), 0);
  const lowCount = active.filter(isLow).length;
  let h = '<div class="toolbar"><div class="row"><button class="btn pri" data-act="matNew">' + ico('plus') + ' Nuovo articolo</button>' +
    '<button class="btn" data-act="invOpen">' + ico('list') + ' Inventario</button></div>' +
    '<span class="muted">' + plural(active.length, 'articolo', 'articoli') + ', ' + plural(pieces, 'pezzo', 'pezzi') + '</span></div>';
  if (!all.length) {
    return h + '<p class="empty">Il magazzino è vuoto. Tocca «Nuovo articolo» per aggiungere il primo, oppure compila la scheda Materiali del foglio.</p>';
  }
  h += '<div class="datebar"><label class="fld"><span>Disponibilità del giorno</span>' +
    '<input type="date" value="' + esc(date) + '" min="' + esc(S.oggi) + '" data-chg="stockDate"></label>' + tentToggle() + '</div>';
  h += '<input type="search" id="stockq" class="srch" data-inp="stockQ" value="' + esc(S.stockQ) + '" placeholder="Cerca: nexo, cavo, pedana…" aria-label="Cerca nel magazzino" autocomplete="off" autocapitalize="off">';
  h += '<div class="cats" role="group" aria-label="Categoria"><button type="button" class="cat" data-act="stockCat" data-cat="" aria-pressed="' + (S.stockCat === '') + '">Tutti</button>' +
    cats.map(c => '<button type="button" class="cat" data-act="stockCat" data-cat="' + esc(c) + '" aria-pressed="' + (S.stockCat === c) + '">' + esc(catLabel(c)) + '</button>').join('') +
    (lowCount || S.stockCat === '~scorta' ? '<button type="button" class="cat low" data-act="stockCat" data-cat="~scorta" aria-pressed="' + (S.stockCat === '~scorta') + '">Sotto scorta (' + lowCount + ')</button>' : '') + '</div>';
  const groups = [];
  all.forEach(m => {
    const k = String(m.stato) === 'dismesso' ? '~dismessi' : (catKey(m.categoria) || 'generale');
    let g = groups.filter(x => x.k === k)[0];
    if (!g) groups.push(g = { k: k, items: [] });
    g.items.push(m);
  });
  groups.sort((a, b) => a.k === '~dismessi' ? 1 : b.k === '~dismessi' ? -1 : cmpCat(a.k, b.k));
  let shown = 0;
  h += '<div id="stocklist">' + groups.map(g => {
    const n = g.items.filter(m => !stkHidden(m)).length;
    shown += n;
    return '<section class="stkcat" data-cat="' + esc(g.k) + '"' + (n ? '' : ' hidden') + '><h3 class="catsep">' +
      esc(g.k === '~dismessi' ? 'Dismessi' : catLabel(g.k)) + '</h3>' + g.items.map(m => stkRow(m, dn)).join('') + '</section>';
  }).join('') + '</div>';
  h += '<p class="empty" id="stock-empty"' + (shown ? ' hidden' : '') + '>Nessun articolo trovato. Prova un\\'altra parola.</p>';
  return h;
}
/* Filtra la lista mentre si scrive, senza ridisegnare la pagina (altrimenti la tastiera si chiude a ogni lettera) */
function stockFilter() {
  const words = S.stockQ.trim().toLowerCase().split(/\\s+/).filter(Boolean);
  let shown = 0;
  $$('#stocklist .stkcat').forEach(sec => {
    let any = 0;
    $$('.stk', sec).forEach(a => {
      const catOk = S.stockCat === '~scorta' ? a.dataset.low === '1' : (!S.stockCat || a.dataset.cat === S.stockCat);
      const ok = catOk && words.every(w => a.dataset.q.indexOf(w) >= 0);
      a.hidden = !ok;
      if (ok) any++;
    });
    sec.hidden = !any;
    shown += any;
  });
  const em = $('#stock-empty');
  if (em) em.hidden = shown > 0;
}
function matFormHtml(m) {
  const v = m || {};
  const cats = uniq(CAT_ORDER.concat(S.mat.map(x => catKey(x.categoria)).filter(Boolean)));
  const num = k => (v[k] === '' || v[k] == null) ? '' : v[k];
  return '<form data-submit="matForm" novalidate><input type="hidden" name="id" value="' + esc(v.id || '') + '">' +
    '<label class="fld"><span>Nome dell\\'articolo</span><input type="text" name="nome" value="' + esc(v.nome || '') + '" autocomplete="off" placeholder="es. Cassa QSC K12.2"></label>' +
    '<div class="grid2"><label class="fld"><span>Categoria</span><input type="text" name="categoria" list="catlist" value="' + esc(catKey(v.categoria) || '') + '" placeholder="audio, luci…" autocomplete="off" autocapitalize="off"></label>' +
    '<label class="fld"><span>Marca</span><input type="text" name="marca" value="' + esc(v.marca || '') + '" autocomplete="off"></label></div>' +
    '<datalist id="catlist">' + cats.map(c => '<option value="' + esc(c) + '">').join('') + '</datalist>' +
    '<div class="grid2 qtys"><div class="fld"><span>Quanti ne hai</span>' + qtyField('quantita', Number(v.quantita) || 0, 0, 9999, 'Quanti ne hai') + '</div>' +
    '<div class="fld"><span>Di cui fuori uso</span>' + qtyField('fuoriServizio', Number(v.fuoriServizio) || 0, 0, 9999, 'Pezzi fuori uso') + '</div></div>' +
    '<p class="hint">Fuori uso = rotti, in riparazione o da sostituire: non si contano tra quelli disponibili.</p>' +
    '<div class="fld"><span>Scorta minima (facoltativa)</span>' + qtyField('scortaMinima', Number(v.scortaMinima) || 0, 0, 9999, 'Scorta minima') + '</div>' +
    '<p class="hint">Se i pezzi utilizzabili scendono sotto questo numero, l\\'articolo compare tra quelli «sotto scorta». Utile per gaffa, batterie, gel. Zero = non controllare.</p>' +
    '<label class="chk"><input type="checkbox" name="consumabile"' + (isTrue(v.consumabile) ? ' checked' : '') + '> Materiale di consumo (nastro, batterie, gel…)</label>' +
    '<details class="free"' + ((num('peso_kg') !== '' || num('larghezza_mm') !== '') ? ' open' : '') + '><summary>Peso e misure (facoltativi)</summary>' +
    '<div class="grid2"><label class="fld"><span>Peso (kg)</span><input type="text" inputmode="decimal" name="peso_kg" value="' + esc(num('peso_kg')) + '"></label>' +
    '<label class="fld"><span>Altezza di installazione (mm)</span><input type="text" inputmode="decimal" name="altezzaInstallazioneMm" value="' + esc(num('altezzaInstallazioneMm')) + '"></label>' +
    '<label class="fld"><span>Larghezza (mm)</span><input type="text" inputmode="decimal" name="larghezza_mm" value="' + esc(num('larghezza_mm')) + '"></label>' +
    '<label class="fld"><span>Altezza (mm)</span><input type="text" inputmode="decimal" name="altezza_mm" value="' + esc(num('altezza_mm')) + '"></label>' +
    '<label class="fld"><span>Profondità (mm)</span><input type="text" inputmode="decimal" name="profondita_mm" value="' + esc(num('profondita_mm')) + '"></label></div>' +
    '<p class="hint">Serviranno per calcolare il carico dei furgoni e, più avanti, per disegnare l\\'impianto.</p></details>' +
    '<label class="fld"><span>Note</span><textarea name="note">' + esc(v.note || '') + '</textarea></label>' +
    (m ? '<label class="chk" style="margin-top:6px"><input type="checkbox" name="dismesso"' + (String(v.stato) === 'dismesso' ? ' checked' : '') + '> Non è più in magazzino (venduto o dismesso)</label>' : '') +
    '<p class="ferr" role="alert"></p><div class="sheetfoot"><button type="button" class="btn" data-act="closeSheet">Annulla</button>' +
    '<button type="submit" class="btn pri">Salva articolo</button></div></form>';
}

/* ---------- finestre: cambio di stato e avvisi ---------- */
const STAGE_HELP = {
  richiesta: 'Il cliente ha chiesto, non è ancora deciso niente.',
  sopralluogo: 'Si va a vedere il posto.',
  preventivo: 'Preventivo mandato, si aspetta la risposta.',
  confermato: 'Il cliente ha accettato: si fa.',
  concluso: 'L\\'evento è finito.',
  annullato: 'Non si fa più (preventivo non accettato o evento cancellato).',
};
function stageFormHtml(e) {
  const when = fmtStamp(e.statoAggiornato);
  return '<form data-submit="stageForm"><input type="hidden" name="id" value="' + esc(e.id) + '">' +
    '<p class="muted" style="margin-top:4px"><b>' + esc(e.cliente) + '</b> · ora è <span class="pill ' + (STAGE_PILL[e.stato] || 'muted') + '">' + esc(STAGE_LABEL[e.stato]) + '</span>' +
    (when ? ' dal ' + esc(when) : '') + '</p>' +
    '<fieldset class="fld"><legend>Nuovo stato</legend><div class="radios">' + STAGES.map(s =>
      '<label class="radio st-' + s + '"><input type="radio" name="stato" value="' + s + '" data-chg="stagePick"' + (s === e.stato ? ' checked' : '') + '>' +
      '<span><b>' + esc(STAGE_LABEL[s]) + (s === e.stato ? ' (attuale)' : '') + '</b><small>' + esc(STAGE_HELP[s]) + '</small></span></label>').join('') + '</div></fieldset>' +
    '<label class="fld"><span>Nota per i tecnici (facoltativa)</span><textarea name="notaStato" maxlength="300" rows="2" placeholder="es. Il cliente ha firmato oggi"></textarea></label>' +
    '<p class="hint" id="stage-prev"></p>' +
    '<p class="ferr" role="alert"></p><div class="sheetfoot sticky"><button type="button" class="btn" data-act="closeSheet">Annulla</button>' +
    '<button type="submit" class="btn pri">Salva stato</button></div></form>';
}
/* Anteprima di quello che leggeranno i tecnici con il nuovo stato */
function stagePreview(e, to) {
  if (to === e.stato) return 'Scegli il nuovo stato.';
  const info = stageInfo({ stato: to, statoPrecedente: e.stato });
  return 'I tecnici leggeranno: «' + info.label + ' — ' + info.text + '»';
}
function avvisiHtml(e) {
  const av = S.av;
  const rec = avRecipients(e);
  const kinds = [['stato', 'Stato'], ['materiale', 'Materiale'], ['orari', 'Orari e luogo']];
  if (av.ctx.changes && av.ctx.changes.length) kinds.unshift(['dati', 'Cosa è cambiato']);
  return '<p class="hint" style="margin-top:0">Il messaggio è già scritto e lo puoi cambiare. Tocca «WhatsApp» accanto a chi vuoi avvisare: si apre il messaggio pronto, devi solo premere invio.</p>' +
    '<div class="cats" role="group" aria-label="Di cosa parla il messaggio">' + kinds.map(k =>
      '<button type="button" class="cat" data-act="avKind" data-kind="' + k[0] + '" aria-pressed="' + (av.kind === k[0]) + '">' + k[1] + '</button>').join('') + '</div>' +
    '<label class="fld"><span>Messaggio</span><textarea id="avmsg" data-inp="avMsg" rows="6">' + esc(av.base) + '</textarea></label>' +
    '<h5 style="margin:16px 0 6px">Chi avvisare (' + rec.length + ')</h5><ul class="avl">' + rec.map(a => {
      const t = S.tecById[a.technician_id];
      const link = t ? waLink(t.telefono, avFull(av.base, a, t), S.cfg.prefisso_telefono) : '';
      return '<li data-asg="' + esc(a.id) + '"><div class="asgtop"><b class="cname">' + esc(a.tecnico) + '</b>' +
        uniq(rolesOf(a.ruoli)).map(r => '<span class="chip r-' + r + '">' + r + '</span>').join('') +
        '<span class="pill ' + (ASG_PILL[a.stato] || 'muted') + '">' + esc(a.stato) + '</span></div><div class="asgact">' + (link
          ? '<a class="btn sm" href="' + esc(link) + '" target="_blank" rel="noopener" data-act="avGo">' + ico('chat') + ' WhatsApp</a>'
          : '<span class="note muted">Manca il telefono: aggiungilo nella scheda Tecnici</span>') + '</div></li>';
    }).join('') + '</ul>' +
    '<div class="row" style="margin-top:12px"><button type="button" class="btn sm" data-act="avCopy">' + ico('copy') + ' Copia il messaggio per il gruppo</button></div>' +
    '<div class="sheetfoot"><button type="button" class="btn pri" data-act="closeSheet">Fatto</button></div>';
}
function openAvvisi(evId, kind, ctx) {
  const e = S.evById[evId];
  if (!e) return;
  S.av = { evId: evId, kind: kind, ctx: ctx || {}, base: avBase(e, kind, ctx) };
  openSheet('Avvisa la squadra', avvisiHtml(e), { noFocus: true });
}
/* Dopo un cambiamento importante: se c'è qualcuno da avvisare, propone il messaggio */
function offerNotify(evId, kind, ctx) {
  const e = S.evById[evId];
  if (!e || !avRecipients(e).length) return;
  if (kind === 'stato' && e.stato === 'concluso') return;
  openAvvisi(evId, kind, ctx);
}

/* ---------- moduli ---------- */
function stepper(r, val) {
  const n = Math.min(9, Math.max(0, Number(val) || 0));
  return '<div class="step r-' + r + '"><span class="lbl">' + r + '</span><span class="ctl">' +
    '<button type="button" data-act="step" data-d="-1" aria-label="Un ' + r + ' in meno">−</button>' +
    '<output aria-live="polite">' + n + '</output><input type="hidden" name="' + r + '" value="' + n + '">' +
    '<button type="button" data-act="step" data-d="1" aria-label="Un ' + r + ' in più">+</button></span></div>';
}
function timeField(k, label, val) {
  return '<label class="fld"><span>' + label + '</span><input type="time" name="' + k + '" value="' + esc(inputT(val)) + '"></label>';
}
function evFormHtml(e) {
  const v = e || {};
  return '<form data-submit="evForm" novalidate><input type="hidden" name="id" value="' + esc(v.id || '') + '">' +
    '<label class="fld"><span>Cliente o nome dell\\'evento</span><input type="text" name="cliente" value="' + esc(v.cliente || '') + '" autocomplete="off"></label>' +
    '<div class="grid2"><label class="fld"><span>Data</span><input type="date" name="data" value="' + esc(v.data || S.oggi) + '"></label>' +
    '<label class="fld"><span>Inizio evento</span><input type="time" name="orarioInizioEvento" value="' + esc(inputT(v.orarioInizioEvento) || inputT(v.ora)) + '"></label></div>' +
    '<label class="fld"><span>Luogo</span><input type="text" name="luogo" value="' + esc(v.luogo || '') + '" autocomplete="off"></label>' +
    (v.id
      ? '<input type="hidden" name="stato" value="' + esc(v.stato) + '"><p class="hint">Stato: <b>' + esc(STAGE_LABEL[v.stato]) + '</b>. Per cambiarlo usa «Cambia stato» nella scheda dell\\'evento: così puoi anche avvisare i tecnici.</p>'
      : '<label class="fld"><span>Stato</span><select name="stato">' + STAGES.map(s => '<option value="' + s + '"' + (s === (v.stato || 'richiesta') ? ' selected' : '') + '>' + STAGE_LABEL[s] + '</option>').join('') + '</select></label>') +
    '<fieldset class="fld"><legend>Quanti tecnici servono</legend><div class="steps">' + ROLES.map(r => stepper(r, v[r])).join('') + '</div>' +
    '<p class="hint">Se uno solo può fare due mansioni, segna comunque tutte e due: l\\'app lo propone per entrambe.</p></fieldset>' +
    '<fieldset class="fld"><legend>Orari della giornata (facoltativi)</legend><div class="grid2">' +
    timeField('orarioArrivo', 'Arrivo', v.orarioArrivo) + timeField('orarioMontaggio', 'Montaggio', v.orarioMontaggio) +
    timeField('orarioPausa', 'Pausa', v.orarioPausa) + timeField('orarioFineEvento', 'Fine evento', v.orarioFineEvento) +
    timeField('orarioSmontaggio', 'Smontaggio', v.orarioSmontaggio) + '</div>' +
    '<p class="hint">Arrivo e fine servono a capire se un tecnico è già impegnato in un altro evento lo stesso giorno. Se la fine è dopo mezzanotte scrivi l\\'ora normale (es. 01:00).</p></fieldset>' +
    '<fieldset class="fld"><legend>Quando il materiale è fuori dal magazzino</legend><div class="grid2">' +
    '<label class="fld"><span>Esce</span><select name="materialePrima">' + [[0, 'il giorno dell\\'evento'], [1, '1 giorno prima'], [2, '2 giorni prima'], [3, '3 giorni prima']].map(x =>
      '<option value="' + x[0] + '"' + (x[0] === (Number(v.materialePrima) || 0) ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></label>' +
    '<label class="fld"><span>Rientra</span><select name="materialeDopo">' + [[0, 'il giorno dell\\'evento'], [1, '1 giorno dopo'], [2, '2 giorni dopo'], [3, '3 giorni dopo']].map(x =>
      '<option value="' + x[0] + '"' + (x[0] === (Number(v.materialeDopo) || 0) ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></label></div>' +
    '<p class="hint">Serve a capire se lo stesso materiale è già impegnato per un altro evento in quei giorni.</p></fieldset>' +
    '<label class="fld"><span>Note per i tecnici (le leggono nella convocazione)</span><textarea name="noteTecnici">' + esc(v.noteTecnici || '') + '</textarea></label>' +
    '<p class="ferr" role="alert"></p><div class="sheetfoot"><button type="button" class="btn" data-act="closeSheet">Annulla</button>' +
    '<button type="submit" class="btn pri">Salva evento</button></div></form>';
}
function techFormHtml(t) {
  const v = t || {};
  const mine = new Set(rolesOf(v.ruoli));
  return '<form data-submit="techForm" novalidate><input type="hidden" name="id" value="' + esc(v.id || '') + '">' +
    '<label class="fld"><span>Nome e cognome</span><input type="text" name="nome" value="' + esc(v.nome || '') + '" autocomplete="off"></label>' +
    '<fieldset class="fld"><legend>Mansioni (anche più di una)</legend><div class="rolepick">' +
    ROLES.map(r => '<label class="r-' + r + '"><input type="checkbox" name="ruoli" value="' + r + '"' + (mine.has(r) ? ' checked' : '') + '> ' + r + '</label>').join('') + '</div></fieldset>' +
    '<label class="fld"><span>Telefono (quello di WhatsApp)</span><input type="tel" name="telefono" inputmode="tel" value="' + esc(v.telefono || '') + '" placeholder="333 1234567"></label>' +
    '<label class="fld"><span>Email Gmail (serve per gli inviti Calendar)</span><input type="email" name="email" value="' + esc(v.email || '') + '" autocomplete="off"></label>' +
    '<label class="fld"><span>Curriculum (link)</span><input type="url" name="cvLink" value="' + esc(v.cvLink || '') + '" placeholder="https://drive.google.com/..."></label>' +
    '<p class="hint">Carica il PDF su Google Drive, condividilo con te e incolla qui il link.</p>' +
    '<label class="fld"><span>Note</span><textarea name="note">' + esc(v.note || '') + '</textarea></label>' +
    '<label class="chk" style="margin-top:10px"><input type="checkbox" name="attivo"' + (!t || isActive(t) ? ' checked' : '') + '> In squadra (se lo togli non compare più tra i candidati)</label>' +
    '<p class="ferr" role="alert"></p><div class="sheetfoot"><button type="button" class="btn" data-act="closeSheet">Annulla</button>' +
    '<button type="submit" class="btn pri">Salva tecnico</button></div></form>';
}

/* ---------- azioni ---------- */
ACT.tab = el => { S.tab = el.dataset.tab; S.prop = null; S.addRoleFor = null; paint(); window.scrollTo(0, 0); };
ACT.refresh = async () => {
  try { await coordLoad(); toast('Dati aggiornati.', 'ok'); } catch (e) { toast(e.message, 'err'); }
};
ACT.coordRetry = () => coordBoot();
ACT.logout = () => { store.del('pin'); S.pin = ''; S.ready = false; paint(loginView()); };
ACT.toggleEv = el => {
  const id = el.dataset.id;
  S.openEv = S.openEv === id ? null : id;
  S.prop = null; S.addRoleFor = null; S.openLine = null;
  paint();
  const n = document.getElementById('ev-' + id);
  if (S.openEv && n) n.scrollIntoView({ block: 'nearest' });
};
CHG.showPast = el => { S.showPast = el.checked; paint(); };
CHG.allowDouble = el => {
  S.allowDouble = el.checked;
  if (S.prop && S.evById[S.prop.evId]) S.prop = computeProposal(S.evById[S.prop.evId]);
  paint();
};
ACT.cell = el => toast(el.dataset.msg);
ACT.step = el => {
  const box = el.closest('.step');
  const inp = $('input', box), out = $('output', box);
  const n = Math.min(9, Math.max(0, (parseInt(inp.value, 10) || 0) + (+el.dataset.d)));
  inp.value = n; out.textContent = n;
};
ACT.wa = el => { markSent(el.dataset.id); setTimeout(() => paint(), 700); };
ACT.propose = el => {
  const e = S.evById[el.dataset.id];
  if (!e) return;
  S.prop = computeProposal(e);
  paint();
  const p = document.getElementById('prop');
  if (p) p.scrollIntoView({ block: 'nearest' });
};
ACT.closeProp = () => { S.prop = null; paint(); };
ACT.addRole = el => { S.addRoleFor = S.addRoleFor === el.dataset.id ? null : el.dataset.id; paint(); };

async function doAssign(evId, items, msg) {
  const r = await mutate(async () => {
    const res = await call('api_assignMany', S.pin, evId, items);
    (res.assegnazioni || []).forEach(a => upsert(S.asg, a));
    derive(); S.prop = null; S.addRoleFor = null; paint();
    const av = res.avvisi || [];
    toast([msg].concat(av).join(' '), av.length ? '' : 'ok');
  });
  return r.ok;
}
ACT.assign = el => {
  const t = S.tecById[el.dataset.tech];
  const roles = el.dataset.roles.split(',');
  doAssign(el.dataset.ev, [{ techId: el.dataset.tech, ruoli: roles }],
    (t ? firstName(t.nome) : 'Il tecnico') + ' è assegnato come ' + roles.join(' + ') + '. Ora mandagli la convocazione.');
};
ACT.applyProp = () => {
  const p = S.prop;
  if (!p || !(p.picks.length + p.adds.length)) return;
  doAssign(p.evId, p.picks.concat(p.adds).map(x => ({ techId: x.t.id, ruoli: x.roles })), 'Squadra assegnata. Ora manda le convocazioni.');
};
ACT.addRoleDo = el => {
  const a = S.asg.find(x => x.id === el.dataset.id);
  if (!a) return;
  doAssign(a.event_id, [{ techId: a.technician_id, ruoli: uniq(rolesOf(a.ruoli).concat([el.dataset.role])) }], 'Ruolo aggiunto.');
};
ACT.dropRole = el => {
  const a = S.asg.find(x => x.id === el.dataset.id);
  if (!a) return;
  const roles = rolesOf(a.ruoli).filter(r => r !== el.dataset.role);
  if (!roles.length) return;
  doAssign(a.event_id, [{ techId: a.technician_id, ruoli: roles }], 'Ruolo tolto.');
};
ACT.unassign = el => {
  const id = el.dataset.id;
  mutate(async () => {
    await call('api_unassign', S.pin, id);
    S.asg = S.asg.filter(a => a.id !== id);
    derive(); paint();
    toast('Tolto dalla squadra.');
  });
};
CHG.asgState = el => {
  const id = el.dataset.id, val = el.value;
  mutate(async () => {
    const a = await call('api_setStato', S.pin, id, val);
    upsert(S.asg, a); derive(); paint();
    toast('Risposta aggiornata.', 'ok');
  }).then(r => { if (!r.ok) paint(); });
};
ACT.cal = el => {
  const id = el.dataset.id;
  mutate(async () => {
    const a = await call('api_calendarInvite', S.pin, id);
    upsert(S.asg, a); derive(); paint();
    toast('Invito Calendar inviato.', 'ok');
  });
};
ACT.calAll = async el => {
  const todo = (S.asgByEv[el.dataset.id] || []).filter(a => a.stato !== 'rifiutato' && !a.calendarEventId && techEmail(a));
  let n = 0;
  const r = await mutate(async () => {
    for (const a of todo) {
      toast('Invio gli inviti… ' + (n + 1) + ' di ' + todo.length);
      upsert(S.asg, await call('api_calendarInvite', S.pin, a.id));
      n++;
    }
  });
  derive(); paint();
  toast(r.ok ? n + ' inviti Calendar inviati.' : 'Inviti mandati: ' + n + '. ' + r.err, r.ok ? 'ok' : 'err');
};
ACT.syncCal = () => {
  mutate(async () => {
    const n = await call('api_syncCalendar', S.pin);
    await coordLoad();
    toast(n ? n + (n === 1 ? ' risposta aggiornata' : ' risposte aggiornate') + ' da Calendar.' : 'Nessuna novità su Calendar.', 'ok');
  });
};

/* eventi: modulo e salvataggio */
ACT.newEv = () => openSheet('Nuovo evento', evFormHtml(null));
ACT.editEv = el => { const e = S.evById[el.dataset.id]; if (e) openSheet('Modifica evento', evFormHtml(e)); };
function applyEventResult(res) {
  const prev = S.evById[res.evento.id];
  res.evento.nMateriali = prev ? prev.nMateriali : 0;
  upsert(S.ev, res.evento);
  S.asg = S.asg.filter(a => a.event_id !== res.evento.id).concat(res.assegnazioni || []);
  derive();
}
SUB.evForm = async form => {
  const f = new FormData(form);
  const g = k => String(f.get(k) || '').trim();
  const ev = { id: g('id') || undefined, cliente: g('cliente'), data: g('data'), stato: g('stato') || 'richiesta',
    luogo: g('luogo'), noteTecnici: g('noteTecnici'),
    materialePrima: parseInt(f.get('materialePrima'), 10) || 0, materialeDopo: parseInt(f.get('materialeDopo'), 10) || 0 };
  TIME_FIELDS.forEach(x => { ev[x[0]] = g(x[0]); });
  ev.ora = ev.orarioInizioEvento;
  ROLES.forEach(r => { ev[r] = parseInt(f.get(r), 10) || 0; });
  const err = $('.ferr', form);
  if (!ev.cliente) { err.textContent = 'Scrivi il nome del cliente o dell\\'evento.'; $('[name=cliente]', form).focus(); return; }
  if (!parseYMD(ev.data)) { err.textContent = 'Scegli la data.'; $('[name=data]', form).focus(); return; }
  err.textContent = '';
  const before = ev.id ? S.evById[ev.id] : null;
  const r = await mutate(async () => {
    const res = await call('api_saveEvent', S.pin, ev);
    applyEventResult(res);
    closeSheet();
    S.openEv = res.evento.id; S.prop = null;
    paint();
    const n = document.getElementById('ev-' + res.evento.id);
    if (n) n.scrollIntoView({ block: 'nearest' });
    const av = res.avvisi || [];
    toast(['Evento salvato.'].concat(av).join(' '), av.length ? '' : 'ok');
    // Se è cambiato qualcosa che riguarda i tecnici già convocati (giorno, orari, luogo, note) propongo di avvisarli
    const changes = before ? diffEvent(before, res.evento) : [];
    if (changes.length && res.evento.stato !== 'annullato') offerNotify(res.evento.id, 'dati', { changes: changes });
  }, true);
  if (!r.ok) err.textContent = r.err;
};
/* materiale dell'evento: righe */
/* Sostituisce le righe di materiale di un evento con quelle appena date dal server. Se il server dice che il carico
   si è riaperto (perché il materiale è cambiato) lo segno anche qui. */
function setLines(evId, righe, liste) {
  S.car = S.car.filter(c => c.event_id !== evId).concat(righe);
  const e = S.evById[evId];
  if (e) { e.nMateriali = righe.length; if (liste) Object.assign(e, liste); }
  derive();
}
ACT.qstep = el => {
  const inp = $('input', el.parentNode);
  const min = +inp.min, max = +inp.max;
  let n = parseInt(inp.value, 10);
  if (isNaN(n)) n = min;
  inp.value = Math.min(max, Math.max(min, n + (+el.dataset.d)));
  inp.dispatchEvent(new Event('input', { bubbles: true }));
};
CHG.countTent = el => { S.countTent = el.checked; store.set('countTent', el.checked ? '1' : '0'); paint(); };
ACT.lineToggle = el => { S.openLine = S.openLine === el.dataset.id ? null : el.dataset.id; paint(); };
SUB.lineForm = async form => {
  const id = form.dataset.id, c = S.car.find(x => x.id === id);
  const f = new FormData(form);
  const q = parseInt(f.get('quantita'), 10), sub = Math.max(0, parseInt(f.get('subnoleggio'), 10) || 0);
  const err = $('.ferr', form);
  if (!c) return;
  if (!(q >= 1)) { err.textContent = 'I pezzi devono essere almeno 1.'; return; }
  err.textContent = '';
  const r = await mutate(async () => {
    const res = await call('api_cset', S.pin, id, { quantita: q, subnoleggio: sub, note: String(f.get('note') || '').trim() });
    setLines(c.event_id, res.righe, res.liste);
    S.openLine = null; paint();
    toast('Salvato.', 'ok');
  }, true);
  if (!r.ok) err.textContent = r.err;
};
ACT.lineDel = el => {
  const c = S.car.find(x => x.id === el.dataset.id);
  if (!c) return;
  mutate(async () => {
    const res = await call('api_cdel', S.pin, c.id);
    setLines(c.event_id, res.righe, res.liste);
    S.openLine = null; paint();
    toast('Tolto dall\\'elenco.');
  });
};
ACT.lineRent = el => {
  const c = S.car.find(x => x.id === el.dataset.id);
  if (!c) return;
  const sub = Math.min(Number(c.quantita) || 0, (Number(c.subnoleggio) || 0) + (+el.dataset.n || 0));
  mutate(async () => {
    const res = await call('api_cset', S.pin, c.id, { subnoleggio: sub });
    setLines(c.event_id, res.righe, res.liste);
    paint();
    toast('Segnato come noleggio da fuori.', 'ok');
  });
};
ACT.matClear = el => {
  const id = el.dataset.id;
  mutate(async () => {
    const res = await call('api_cclear', S.pin, id);
    setLines(id, res.righe, res.liste);
    S.openLine = null; paint();
    toast('Elenco svuotato.');
  });
};

/* finestra "Aggiungi materiale" */
ACT.matAdd = el => {
  const e = S.evById[el.dataset.id];
  if (!e) return;
  S.pick = {}; S.addEv = e.id;
  openSheet('Aggiungi materiale', addMatHtml(e), { noFocus: true });
};
INP.pickSearch = () => pickFilter();
ACT.pickCat = el => {
  $$('#sheet .cat').forEach(b => b.setAttribute('aria-pressed', String(b === el)));
  pickFilter();
};
INP.pickQty = el => {
  const n = Math.max(0, Math.min(9999, parseInt(el.value, 10) || 0));
  if (n) S.pick[el.dataset.id] = n; else delete S.pick[el.dataset.id];
  const li = el.closest('.pk');
  if (li) li.classList.toggle('sel', n > 0);
  pickTally();
};
ACT.pickGo = () => {
  const evId = S.addEv, ids = Object.keys(S.pick);
  if (!evId || !ids.length) return;
  const items = ids.map(id => ({ equipment_id: id, quantita: S.pick[id] }));
  mutate(async () => {
    const res = await call('api_cadd', S.pin, evId, items);
    setLines(evId, res.righe, res.liste);
    closeSheet(); paint();
    toast((ids.length === 1 ? '1 articolo aggiunto' : ids.length + ' articoli aggiunti') + '.', 'ok');
  });
};
SUB.freeForm = async form => {
  const f = new FormData(form);
  const nome = String(f.get('nome') || '').trim(), q = parseInt(f.get('quantita'), 10), evId = form.dataset.ev;
  const err = $('.ferr', form);
  if (!nome) { err.textContent = 'Scrivi che cosa serve.'; return; }
  if (!(q >= 1)) { err.textContent = 'I pezzi devono essere almeno 1.'; return; }
  err.textContent = '';
  const r = await mutate(async () => {
    const res = await call('api_cadd', S.pin, evId, [{ nome: nome, quantita: q, subnoleggio: f.has('noleggio') ? q : 0 }]);
    setLines(evId, res.righe, res.liste);
    closeSheet(); paint();
    toast('Aggiunto: ' + nome + '.', 'ok');
  }, true);
  if (!r.ok) err.textContent = r.err;
};

/* copia il materiale da un altro evento */
function copyHtml(e, list) {
  const have = (S.carByEv[e.id] || []).length;
  if (!list.length) return '<p class="empty">Nessun altro evento ha ancora un elenco di materiale.</p>';
  return '<p class="hint" style="margin-top:0">Scegli l\\'evento da cui copiare. ' +
    (have ? '<b>Qui ci sono già ' + plural(have, 'voce', 'voci') + ': i pezzi si sommano.</b> ' : '') +
    'Il noleggio da fuori non si copia: va rivalutato per questo evento.</p><ul class="cpl">' + list.map(f =>
      '<li><button type="button" class="btn cpb" data-act="copyFrom" data-to="' + esc(e.id) + '" data-from="' + esc(f.id) + '"' +
      (have ? ' data-confirm="Tocca di nuovo: li sommo"' : '') + '><span class="cpn">' + esc(f.cliente) + '</span><span class="cpd">' +
      esc(fmtShort(f.data)) + ' · ' + plural(f.nMateriali, 'voce', 'voci') + ' · ' + esc(STAGE_LABEL[f.stato]) + '</span></button></li>').join('') + '</ul>';
}
ACT.matCopy = el => {
  const e = S.evById[el.dataset.id];
  if (!e) return;
  const list = S.ev.filter(f => f.id !== e.id && f.nMateriali > 0).sort((a, b) => String(b.data).localeCompare(String(a.data)));
  openSheet('Copia da un altro evento', copyHtml(e, list), { noFocus: true });
};
ACT.copyFrom = el => {
  const to = el.dataset.to, from = el.dataset.from;
  mutate(async () => {
    const res = await call('api_ccopy', S.pin, from, to);
    setLines(to, res.righe, res.liste);
    closeSheet(); paint();
    toast('Copiate ' + plural(res.copiate, 'voce', 'voci') + '. Controlla le quantità e il noleggio.', 'ok');
  });
};

/* cambio di stato e avvisi */
ACT.stageOpen = el => {
  const e = S.evById[el.dataset.id];
  if (e) openSheet('Cambia stato', stageFormHtml(e), { noFocus: true });
};
CHG.stagePick = el => {
  const form = el.closest('form'), e = S.evById[$('[name=id]', form).value], p = $('#stage-prev', form);
  if (e && p) p.textContent = stagePreview(e, el.value);
};
SUB.stageForm = async form => {
  const f = new FormData(form), e = S.evById[f.get('id')];
  if (!e) return;
  const to = String(f.get('stato') || ''), nota = String(f.get('notaStato') || '').trim();
  const err = $('.ferr', form);
  if (to === e.stato) { err.textContent = 'Scegli uno stato diverso da quello di adesso.'; return; }
  err.textContent = '';
  const r = await mutate(async () => {
    const res = await call('api_saveEvent', S.pin, Object.assign({}, e, { stato: to, notaStato: nota }));
    applyEventResult(res);
    closeSheet(); paint();
    const av = res.avvisi || [];
    toast(['Stato cambiato: ' + STAGE_LABEL[to] + '.'].concat(av).join(' '), av.length ? '' : 'ok');
    offerNotify(res.evento.id, 'stato');
  }, true);
  if (!r.ok) err.textContent = r.err;
};
ACT.avOpen = el => { if (S.evById[el.dataset.id]) openAvvisi(el.dataset.id, el.dataset.kind || 'stato'); };
function avRelink() {
  const e = S.av && S.evById[S.av.evId];
  if (!e) return;
  avRecipients(e).forEach(a => {
    const li = $('#sheet li[data-asg="' + a.id + '"]'), t = S.tecById[a.technician_id];
    const link = li && $('a[data-act=avGo]', li);
    if (link && t) link.href = waLink(t.telefono, avFull(S.av.base, a, t), S.cfg.prefisso_telefono);
  });
}
ACT.avKind = el => {
  const e = S.av && S.evById[S.av.evId];
  if (!e) return;
  S.av.kind = el.dataset.kind;
  S.av.base = avBase(e, S.av.kind, S.av.ctx);
  $$('#sheet .cat').forEach(b => b.setAttribute('aria-pressed', String(b === el)));
  $('#avmsg').value = S.av.base;
  avRelink();
};
INP.avMsg = el => { if (S.av) { S.av.base = el.value; avRelink(); } };
ACT.avGo = el => {
  const li = el.closest('li'), row = li && $('.asgact', li);
  if (row && !$('.sent', row)) row.insertAdjacentHTML('beforeend', '<span class="sent">' + ico('check') + ' aperto</span>');
};
ACT.avCopy = async () => {
  if (!S.av) return;
  const text = avGroup(S.av.base);
  if (await copyText(text)) toast('Messaggio copiato. Incollalo nel gruppo.', 'ok');
  else showCopyBox('Messaggio per il gruppo', text);
};

/* magazzino */
CHG.stockDate = el => { S.stockDate = parseYMD(el.value) ? el.value : ''; S.openStk = null; paint(); };
INP.stockQ = el => { S.stockQ = el.value; stockFilter(); };
ACT.stockCat = el => { S.stockCat = el.dataset.cat; paint(); };
ACT.stkToggle = el => { S.openStk = S.openStk === el.dataset.id ? null : el.dataset.id; paint(); };
ACT.matNew = () => openSheet('Nuovo articolo', matFormHtml(null));
ACT.matEdit = el => { const m = S.matById[el.dataset.id]; if (m) openSheet('Modifica articolo', matFormHtml(m)); };
SUB.matForm = async form => {
  const f = new FormData(form), g = k => String(f.get(k) == null ? '' : f.get(k)).trim();
  const m = { id: g('id') || undefined, nome: g('nome'), categoria: g('categoria'), marca: g('marca'), quantita: g('quantita'),
    fuoriServizio: g('fuoriServizio'), consumabile: f.has('consumabile'), dismesso: f.has('dismesso'), note: g('note'),
    peso_kg: g('peso_kg'), larghezza_mm: g('larghezza_mm'), altezza_mm: g('altezza_mm'), profondita_mm: g('profondita_mm'),
    altezzaInstallazioneMm: g('altezzaInstallazioneMm'), scortaMinima: g('scortaMinima') };
  const err = $('.ferr', form);
  if (!m.nome) { err.textContent = 'Scrivi il nome dell\\'articolo.'; $('[name=nome]', form).focus(); return; }
  err.textContent = '';
  const isNew = !m.id;
  const r = await mutate(async () => {
    const saved = await call('api_saveMateriale', S.pin, m);
    upsert(S.mat, saved);
    S.car.forEach(c => { if (c.equipment_id === saved.id) c.materiale = saved.nome; });
    derive();
    closeSheet();
    S.tab = 'mag'; S.openStk = saved.id; paint();
    toast(isNew ? 'Articolo aggiunto.' : 'Articolo salvato.', 'ok');
  }, true);
  if (!r.ok) err.textContent = r.err;
};

/* tecnici: modulo e salvataggio */
ACT.techNew = () => openSheet('Nuovo tecnico', techFormHtml(null));
ACT.techEdit = el => { const t = S.tecById[el.dataset.id]; if (t) openSheet('Modifica tecnico', techFormHtml(t)); };
ACT.copyLink = async el => {
  const t = S.tecById[el.dataset.id];
  const url = personalUrl(t);
  if (!url) { toast('Il link non è disponibile: apri l\\'app dal link /exec.', 'err'); return; }
  if (await copyText(url)) toast('Link copiato. Incollalo in un messaggio a ' + firstName(t.nome) + '.', 'ok');
  else showCopyBox('Link personale di ' + t.nome, url);
};
SUB.techForm = async form => {
  const f = new FormData(form);
  const g = k => String(f.get(k) || '').trim();
  const t = { id: g('id') || undefined, nome: g('nome'), ruoli: f.getAll('ruoli'), telefono: g('telefono'),
    email: g('email'), cvLink: g('cvLink'), note: g('note'), attivo: f.has('attivo') };
  const err = $('.ferr', form);
  if (!t.nome) { err.textContent = 'Scrivi il nome del tecnico.'; $('[name=nome]', form).focus(); return; }
  if (!t.ruoli.length) { err.textContent = 'Scegli almeno una mansione.'; return; }
  err.textContent = '';
  const isNew = !t.id;
  const r = await mutate(async () => {
    const saved = await call('api_saveTech', S.pin, t);
    upsert(S.tec, saved); derive();
    closeSheet();
    S.tab = 'tecnici'; paint();
    const n = document.getElementById('tec-' + saved.id);
    if (n) n.scrollIntoView({ block: 'nearest' });
    toast(isNew ? 'Tecnico aggiunto. Ora mandagli il suo link personale.' : 'Tecnico salvato.', 'ok');
  }, true);
  if (!r.ok) err.textContent = r.err;
};

/* accesso e caricamento */
SUB.login = async form => {
  const pin = String(new FormData(form).get('pin') || '').trim();
  if (!pin) return;
  S.pin = pin;
  const btn = $('[type=submit]', form);
  btn.disabled = true;
  try { await coordLoad(); store.set('pin', pin); }
  catch (e) { S.pin = ''; paint(loginView(e.message)); }
};
async function coordLoad() {
  const d = await call('api_coordInit', S.pin);
  S.url = d.url || ''; S.oggi = d.oggi; S.cfg = d.config;
  S.tec = d.tecnici; S.ev = d.eventi; S.disp = d.disponibilita; S.asg = d.assegnazioni;
  S.mat = d.materiali || []; S.car = d.carico || []; S.mancano = d.mancano || [];
  S.fur = d.furgoni || []; S.fe = d.furgoniEvento || []; S.rip = d.riparazioni || []; S.spe = d.spese || [];
  S.mov = d.movimenti || []; S.movAll = false;
  S.ready = true; S.view = coordView;
  derive(); paint();
}
async function coordBoot() {
  S.view = coordView;
  if (!S.pin) { paint(loginView()); return; }
  paint(loadingView());
  try { await coordLoad(); }
  catch (e) {
    if (/codice|tentativi/i.test(e.message)) { S.pin = ''; store.del('pin'); paint(loginView(e.message)); }
    else paint(errorView(e.message, 'coordRetry'));
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.mode === 'coord' && S.ready && !S.sheet && !S.locked && !LQ.running && !LQ.items.length) {
    coordLoad().catch(() => { /* aggiornamento silenzioso: se fallisce resta la vista di prima */ });
  }
});

/* =====================================================================
   COORDINATORE - furgoni dell'evento, avvisi di carico e scarico, giornata con più eventi, spese dell'evento
   ===================================================================== */

/* ---------- dati di logistica ---------- */
function activeVans() { return S.fur.filter(v => v.attivo !== false); }
function eventLines(evId) { return (S.carByEv[evId] || []).filter(c => toI(c.quantita) >= 1); }
/* Una riga del materiale come la vede la lista: stessa forma che il server dà ai tecnici */
function lineView(c) {
  const m = c.equipment_id ? S.matById[c.equipment_id] : null;
  return {
    id: c.id, nome: lineName(c), categoria: m ? catKey(m.categoria) : '', consumabile: m ? isTrue(m.consumabile) : false,
    quantita: toI(c.quantita), subnoleggio: toI(c.subnoleggio), caricato: toI(c.caricato), scaricato: toI(c.scaricato),
    danneggiato: toI(c.danneggiato), mancante: toI(c.mancante), van_id: c.van_id || '', note: c.note || '',
  };
}
/* I furgoni di un evento, nella stessa forma che vedono i tecnici (+ la riga di FurgoniEvento in fe) */
function vansOfEvent(evId) {
  return (S.feByEv[evId] || []).map(f => {
    const v = S.furById[f.van_id];
    return { id: f.van_id, nome: v ? v.nome : f.furgone, targa: v ? (v.targa || '') : '', autista: f.autista || '', fe: f };
  });
}
/* Il carico c'è stato (chiuso o almeno iniziato) */
function loadedEv(e) { return !!e.caricoQuando || eventLines(e.id).some(c => toI(c.caricato) > 0); }
/* Il materiale doveva essere rientrato (ultimo giorno di uscita passato) ma lo scarico non è stato chiuso */
function dueUnload(e) {
  if (e.stato === 'annullato' || e.scaricoQuando || !loadedEv(e)) return false;
  const r = occRange(e);
  return !!r && r[1] < dayNum(S.oggi);
}

/* ---------- orari: due eventi si pestano i piedi? ---------- */
/* null = vanno bene; altrimenti {level: 'bad' (si sovrappongono) | 'warn' (poco margine o orari mancanti), why} */
function gapLevel(a, b) {
  const wa = evWin(a), wb = evWin(b);
  if (!wa || !wb || wa.s === null || wb.s === null) return { level: 'warn', why: 'gli orari non sono ancora indicati' };
  if (wa.a0 < wb.a1 && wb.a0 < wa.a1) return { level: 'bad', why: 'gli orari si sovrappongono' };
  const gap = wa.a1 <= wb.a0 ? wb.a0 - wa.a1 : wa.a0 - wb.a1;
  if (gap < REUSE_MARGIN_MIN) return { level: 'warn', why: 'tra uno e l\\'altro c\\'è meno di un\\'ora' };
  return null;
}
/* Il furgone è già impegnato in un altro evento nei giorni di questo? [{level, e, why}] */
function vanClashes(vanId, e) {
  const out = [], r1 = occRange(e);
  (S.feByVan[vanId] || []).forEach(f => {
    if (f.event_id === e.id) return;
    const o = S.evById[f.event_id];
    if (!o || o.stato === 'annullato' || o.scaricoQuando) return;
    const r2 = occRange(o);
    if (!r1 || !r2 || r1[0] > r2[1] || r2[0] > r1[1]) return;
    if (r1[0] === r1[1] && r2[0] === r2[1]) {
      const g = gapLevel(e, o);
      if (g) out.push({ level: g.level, e: o, why: g.why });
    } else {
      out.push({ level: 'bad', e: o, why: 'il furgone resta fuori anche per quell\\'altro evento' });
    }
  });
  return out;
}
function clashText(v, c) {
  return v.nome + ' è già su «' + c.e.cliente + '» (' + rangeTxt(evWin(c.e)) + '): ' + c.why + '.';
}

/* ---------- peso e ingombro di quello che va su un furgone ---------- */
function loadStats(lines) {
  let kg = 0, m3 = 0, noKg = 0, noDim = 0;
  lines.forEach(c => {
    const q = fromStock(c);
    if (!q) return;
    const m = c.equipment_id ? S.matById[c.equipment_id] : null;
    if (!m) { noKg++; noDim++; return; }
    if (m.peso_kg !== '' && m.peso_kg != null && isFinite(Number(m.peso_kg))) kg += Number(m.peso_kg) * q; else noKg++;
    const d = [m.larghezza_mm, m.altezza_mm, m.profondita_mm];
    if (d.every(x => x !== '' && x != null && Number(x) > 0)) m3 += d.reduce((p, x) => p * Number(x), 1) * q / 1e9; else noDim++;
  });
  return { kg: kg, m3: m3, noKg: noKg, noDim: noDim };
}
function vanCapacityHtml(van, mine) {
  if (!mine.length) return '<p class="note muted">Su questo furgone non c\\'è ancora niente.</p>';
  const s = loadStats(mine), cap = toN(van && van.portata_kg), vol = toN(van && van.volume_m3);
  const bits = [];
  let level = 'muted';
  if (s.kg > 0) {
    bits.push('Peso circa ' + fmtNum(s.kg, 0) + ' kg' + (cap > 0 ? ' su ' + fmtNum(cap, 0) + ' di portata' : ''));
    if (cap > 0 && s.kg > cap) level = 'bad'; else if (cap > 0 && s.kg > cap * 0.9) level = 'warn';
  }
  if (s.m3 > 0) {
    bits.push('ingombro circa ' + fmtNum(s.m3, 1) + ' m³' + (vol > 0 ? ' su ' + fmtNum(vol, 1) : '') + ' (stima)');
    if (vol > 0 && s.m3 > vol) level = 'bad';
  }
  if (!bits.length) {
    return '<p class="note muted">Per calcolare peso e ingombro scrivi peso e misure nelle schede degli articoli.</p>';
  }
  let t = bits.join(', ') + '.';
  if (s.kg > 0 && s.noKg) t += ' ' + plural(s.noKg, 'voce senza peso non contata', 'voci senza peso non contate') + '.';
  if (s.kg > 0 && !cap) t += ' Scrivi la portata del furgone (Magazzino, Furgoni) per il controllo.';
  return '<p class="note ' + level + '">' + esc(t) + '</p>';
}

/* ---------- avvisi nella riga dell'evento ---------- */
function logiBadges(e) {
  const out = [];
  if (e.stato === 'annullato') return out;
  const lines = eventLines(e.id);
  if (!lines.length) return out;
  if (!e.scaricoQuando && vansOfEvent(e.id).some(v => vanClashes(v.id, e).some(c => c.level === 'bad'))) {
    out.push('<span class="alert">Un furgone è già su un altro evento</span>');
  }
  if (e.scaricoQuando) return out;
  if (dueUnload(e)) { out.push('<span class="alert">Scarico da chiudere</span>'); return out; }
  const pc = lprogress(lines, 'carico'), pu = lprogress(lines, 'scarico');
  if (e.caricoQuando) out.push('<span class="okt">Carico chiuso</span>');
  else if (pc.got > 0) out.push('<span>Carico <b>' + pc.done + '/' + pc.total + '</b></span>');
  if (pu.got > 0) out.push('<span>Scarico <b>' + pu.done + '/' + pu.total + '</b></span>');
  return out;
}

/* ---------- sezione "Furgoni e carico" nella scheda dell'evento ---------- */
function vanRowHtml(e, v, vans, lines, locked) {
  const mine = vans.length > 1 ? lines.filter(c => c.van_id === v.id) : lines;
  const fe = v.fe, van = S.furById[v.id];
  const squad = (S.asgByEv[e.id] || []).filter(a => a.stato !== 'rifiutato');
  const driving = {};
  vans.forEach(x => { if (x.id !== v.id && x.fe.autista_id) driving[x.fe.autista_id] = x.nome; });
  let opts = '<option value="">Nessuno</option>';
  squad.forEach(a => {
    const other = driving[a.technician_id];
    opts += '<option value="' + esc(a.technician_id) + '"' + (fe.autista_id === a.technician_id ? ' selected' : '') + (other ? ' disabled' : '') + '>' +
      esc(a.tecnico) + (other ? ' (guida ' + esc(other) + ')' : '') + '</option>';
  });
  const clashes = vanClashes(v.id, e);
  return '<li class="van" data-van="' + esc(v.id) + '"><div class="vtop"><span class="vname">' + ico('truck') + '<b>' + esc(v.nome) + '</b>' +
    (v.targa ? '<small>' + esc(v.targa) + '</small>' : '') + '</span>' +
    (locked ? '' : '<button type="button" class="btn sm danger" data-act="vanDel" data-id="' + esc(fe.id) + '" data-confirm="Sicuro? Tocca di nuovo">Togli</button>') + '</div>' +
    (squad.length
      ? '<label class="fld vdrv"><span>Chi guida</span><select data-chg="vanDriver" data-ev="' + esc(e.id) + '" data-van="' + esc(v.id) + '"' + (locked ? ' disabled' : '') + '>' + opts + '</select></label>'
      : '<p class="note muted">Chi guida lo scegli quando c\\'è qualcuno in squadra.</p>') +
    clashes.map(c => '<p class="note ' + (c.level === 'bad' ? 'bad' : 'warn') + '">' + esc(clashText(v, c)) + '</p>').join('') +
    vanCapacityHtml(van, mine) +
    (vans.length > 1 && !locked
      ? '<div class="row" style="margin-top:8px"><button type="button" class="btn sm" data-act="vanLines" data-ev="' + esc(e.id) + '" data-van="' + esc(v.id) + '">' +
        ico('list') + ' Cosa va su questo furgone (' + mine.length + ')</button></div>' : '') + '</li>';
}
function vanSectionHtml(e) {
  if (e.stato === 'annullato') return '';
  const lines = eventLines(e.id);
  const vans = vansOfEvent(e.id);
  const locked = !!e.scaricoQuando;
  let h = '<h4>Furgoni e carico</h4>';
  if (!S.fur.length && !vans.length) {
    h += '<p class="muted">Non hai ancora inserito i furgoni. Aggiungili dalla scheda Magazzino, voce «Furgoni»: poi li assegni qui agli eventi.</p>' +
      '<div class="row" style="margin-top:8px"><button type="button" class="btn sm" data-act="goTab" data-tab="mag" data-sub="furgoni">' + ico('truck') + ' Aggiungi i furgoni</button></div>';
  } else {
    if (!vans.length) h += '<p class="muted">Nessun furgone assegnato. Scegli quali portare: sai così chi guida e cosa va su ciascuno.</p>';
    else h += '<ul class="vans">' + vans.map(v => vanRowHtml(e, v, vans, lines, locked)).join('') + '</ul>';
    if (vans.length > 1) {
      const loose = lines.filter(c => !vans.some(v => v.id === c.van_id)).length;
      if (loose) h += '<p class="note warn">' + plural(loose, 'voce non è ancora assegnata a un furgone', 'voci non sono ancora assegnate a un furgone') + '.</p>';
    }
    const free = activeVans().filter(v => !vans.some(x => x.id === v.id));
    if (free.length && !locked) {
      h += '<div class="row vanadd">' + free.map(v => '<button type="button" class="btn sm" data-act="vanAdd" data-ev="' + esc(e.id) + '" data-van="' + esc(v.id) + '">' +
        ico('plus') + ' ' + esc(v.nome) + '</button>').join('') + '</div>';
    }
  }
  if (lines.length) {
    h += '<div class="lbtns">' + listBtnHtml(e, e, lines, 'carico') + listBtnHtml(e, e, lines, 'scarico') + '</div>';
  } else {
    h += '<p class="muted" style="margin-top:10px">Appena aggiungi il materiale, qui trovi le liste di carico e di scarico.</p>';
  }
  return h;
}

/* ---------- azioni sui furgoni ---------- */
function applyVanState(evId, res) {
  S.fe = S.fe.filter(f => f.event_id !== evId).concat(res.fe || []);
  setLines(evId, res.righe || [], res.liste);
}
ACT.vanAdd = el => {
  const evId = el.dataset.ev, van = S.furById[el.dataset.van];
  mutate(async () => {
    const res = await call('api_vanAssign', S.pin, evId, el.dataset.van, '');
    applyVanState(evId, res); paint();
    toast((van ? van.nome : 'Furgone') + ' aggiunto.' + (res.fe.length > 1 ? ' Con più furgoni scegli cosa va su ciascuno.' : ''), 'ok');
  });
};
ACT.vanDel = el => {
  const fe = S.fe.filter(f => f.id === el.dataset.id)[0];
  if (!fe) return;
  mutate(async () => {
    const res = await call('api_vanUnassign', S.pin, fe.id);
    applyVanState(fe.event_id, res); paint();
    toast('Furgone tolto dall\\'evento.');
  });
};
CHG.vanDriver = el => {
  const evId = el.dataset.ev, vanId = el.dataset.van, who = el.value;
  mutate(async () => {
    const res = await call('api_vanAssign', S.pin, evId, vanId, who);
    applyVanState(evId, res); paint();
    toast(who ? 'Autista scelto.' : 'Autista tolto.', 'ok');
  }).then(r => { if (!r.ok) paint(); });
};

/* "Cosa va su questo furgone": si spuntano le righe dell'evento */
function vanLinesHtml() {
  const e = S.evById[S.vl.evId], vans = vansOfEvent(S.vl.evId), lines = eventLines(S.vl.evId);
  const mine = vans.filter(v => v.id === S.vl.vanId)[0];
  const where = c => {
    const v = vans.filter(x => x.id === c.van_id)[0];
    return v && v.id !== S.vl.vanId ? 'ora su ' + v.nome : (!v ? 'da assegnare' : '');
  };
  let h = '<p class="hint" style="margin-top:0">Spunta quello che carichi su <b>' + esc(mine ? mine.nome : 'questo furgone') + '</b>. ' +
    'Quello che sta su un altro furgone, se lo spunti, si sposta qui.</p>' +
    '<div class="row" style="margin-top:10px"><button type="button" class="btn sm" data-act="vlAll">Tutto qui</button>' +
    '<button type="button" class="btn sm" data-act="vlNone">Niente</button></div>';
  h += groupLines(lines).map(g => '<h5>' + esc(catLabel(g.cat)) + '</h5><ul class="vlist">' + g.items.map(c => {
    const w = where(c);
    return '<li><label class="vlrow"><input type="checkbox" data-chg="vlTick" data-id="' + esc(c.id) + '"' + (S.vl.sel[c.id] ? ' checked' : '') + '>' +
      '<span class="lq">' + toI(c.quantita) + '</span><span class="ln">' + esc(lineName(c)) + (w ? '<small>' + esc(w) + '</small>' : '') + '</span></label></li>';
  }).join('') + '</ul>').join('');
  h += '<p class="ferr" role="alert"></p><div class="sheetfoot sticky"><button type="button" class="btn" data-act="closeSheet">Annulla</button>' +
    '<button type="button" class="btn pri" data-act="vlSave" id="vlsave"></button></div>';
  return h;
}
function vlTally() {
  const n = Object.keys(S.vl.sel).filter(k => S.vl.sel[k]).length;
  const b = $('#vlsave');
  if (b) b.textContent = 'Salva (' + plural(n, 'voce', 'voci') + ')';
}
ACT.vanLines = el => {
  const evId = el.dataset.ev, vanId = el.dataset.van;
  const sel = {};
  eventLines(evId).forEach(c => { if (c.van_id === vanId) sel[c.id] = true; });
  S.vl = { evId: evId, vanId: vanId, sel: sel };
  const v = S.furById[vanId];
  openSheet('Cosa va su ' + (v ? v.nome : 'questo furgone'), vanLinesHtml(), { noFocus: true });
  S.onClose = () => { S.vl = null; paint(); };
  vlTally();
};
CHG.vlTick = el => { S.vl.sel[el.dataset.id] = el.checked; vlTally(); };
function vlSetAll(on) {
  eventLines(S.vl.evId).forEach(c => { S.vl.sel[c.id] = on; });
  $$('#sheet input[data-chg=vlTick]').forEach(i => { i.checked = on; });
  vlTally();
}
ACT.vlAll = () => vlSetAll(true);
ACT.vlNone = () => vlSetAll(false);
ACT.vlSave = async () => {
  const vl = S.vl;
  if (!vl) return;
  const ids = Object.keys(vl.sel).filter(k => vl.sel[k]);
  const err = $('#sheet .ferr');
  const r = await mutate(async () => {
    const res = await call('api_linesVan', S.pin, vl.evId, vl.vanId, ids);
    applyVanState(vl.evId, res);
    closeSheet();
    toast('Salvato.', 'ok');
  }, true);
  if (!r.ok && err) err.textContent = r.err;
};

/* ---------- "Da sistemare" in cima agli eventi ---------- */
function reimbList() { return S.spe.filter(x => x.pagatoDa === 'tecnico' && !x.rimborsatoIl); }
function reimbSummary() {
  const l = reimbList(), techs = {};
  l.forEach(x => { techs[x.technician_id] = true; });
  return { n: l.length, tot: l.reduce((s, x) => s + toN(x.importo), 0), techs: Object.keys(techs).length };
}
function todoItems() {
  const out = [];
  S.ev.filter(dueUnload).sort(cmpEv).forEach(e => out.push({
    text: 'Scarico da chiudere: ' + e.cliente + ' (' + fmtShort(e.data) + ')', act: 'listOpen', ev: e.id, kind: 'scarico' }));
  const rb = reimbSummary();
  if (rb.n) out.push({ text: 'Rimborsi da fare: ' + plural(rb.n, 'spesa', 'spese') + ', ' + fmtEur(rb.tot) + ' (' + plural(rb.techs, 'tecnico', 'tecnici') + ')', act: 'goTab', tab: 'tecnici' });
  const toRepair = S.rip.filter(r => r.stato === 'da riparare').reduce((s, r) => s + toI(r.quantita), 0);
  if (toRepair) out.push({ text: plural(toRepair, 'pezzo', 'pezzi') + ' da portare in riparazione', act: 'goTab', tab: 'mag', sub: 'rip' });
  const orph = orphanList().reduce((s, o) => s + o.pieces, 0);
  if (orph) out.push({ text: plural(orph, 'pezzo fuori uso senza scheda di riparazione', 'pezzi fuori uso senza scheda di riparazione'), act: 'goTab', tab: 'mag', sub: 'rip' });
  const low = S.mat.filter(isLow).length;
  if (low) out.push({ text: plural(low, 'articolo sotto scorta', 'articoli sotto scorta'), act: 'goTab', tab: 'mag', sub: 'articoli', cat: '~scorta' });
  return out;
}
function todoBoxHtml() {
  const items = todoItems();
  if (!items.length) return '';
  return '<section class="box todo" aria-label="Da sistemare"><h3>Da sistemare</h3><ul>' + items.map(i =>
    '<li><span>' + esc(i.text) + '</span><button type="button" class="btn sm" data-act="' + i.act + '"' +
    (i.ev ? ' data-ev="' + esc(i.ev) + '" data-kind="' + i.kind + '"' : '') + (i.tab ? ' data-tab="' + i.tab + '"' : '') +
    (i.sub ? ' data-sub="' + i.sub + '"' : '') + (i.cat !== undefined ? ' data-cat="' + esc(i.cat) + '"' : '') + '>Apri</button></li>').join('') + '</ul></section>';
}
ACT.goTab = el => {
  S.tab = el.dataset.tab; S.prop = null; S.addRoleFor = null;
  if (el.dataset.sub) S.magTab = el.dataset.sub;
  if (el.dataset.cat !== undefined) S.stockCat = el.dataset.cat;
  closeSheet();
  paint(); window.scrollTo(0, 0);
};

/* ---------- giornata con più eventi ---------- */
function dayEvents(date) { return S.ev.filter(x => x.data === date && x.stato !== 'annullato').sort(cmpEv); }
/* Cosa c'è da controllare quel giorno: tecnici in due posti, furgoni doppi, materiale che non basta per tutti */
function dayShared(date) {
  const byEq = {};
  dayEvents(date).filter(holdsStock).forEach(e => eventLines(e.id).forEach(c => {
    if (!c.equipment_id) return;
    const q = fromStock(c);
    if (q > 0) (byEq[c.equipment_id] = byEq[c.equipment_id] || []).push({ e: e, q: q });
  }));
  return Object.keys(byEq).map(id => {
    const m = S.matById[id], users = byEq[id];
    if (!m || users.length < 2) return null;
    const need = neededTogether(users), stock = stockOf(m);
    return { m: m, users: users, need: need, stock: stock, short: Math.max(0, need - stock), sum: users.reduce((s, x) => s + x.q, 0) };
  }).filter(Boolean).sort((a, b) => (b.short - a.short) || cmpName(a.m.nome, b.m.nome));
}
function dayTechs(date) {
  const by = {};
  dayEvents(date).forEach(e => (S.asgByEv[e.id] || []).forEach(a => {
    if (a.stato === 'rifiutato') return;
    (by[a.technician_id] = by[a.technician_id] || { name: a.tecnico, list: [] }).list.push(e);
  }));
  return Object.keys(by).map(id => {
    const x = by[id], issues = [];
    for (let i = 0; i < x.list.length; i++) for (let j = i + 1; j < x.list.length; j++) {
      const g = gapLevel(x.list[i], x.list[j]);
      if (g) issues.push({ level: g.level, text: x.list[i].cliente + ' e ' + x.list[j].cliente + ': ' + g.why + '.' });
    }
    return { id: id, name: x.name, list: x.list, issues: issues };
  }).filter(x => x.list.length >= 2).sort((a, b) => cmpName(a.name, b.name));
}
function dayVans(date) {
  const evs = dayEvents(date);
  return activeVans().map(v => {
    const on = evs.filter(e => (S.feByEv[e.id] || []).some(f => f.van_id === v.id));
    const issues = [];
    for (let i = 0; i < on.length; i++) {
      vanClashes(v.id, on[i]).forEach(c => {
        if (on.indexOf(c.e) > i) issues.push({ level: c.level, text: on[i].cliente + ' e ' + c.e.cliente + ': ' + c.why + '.' });
      });
    }
    return { v: v, on: on, issues: issues };
  });
}
function dayIssueCount(date) {
  if (dayEvents(date).length < 2) return 0;
  return dayTechs(date).reduce((n, x) => n + x.issues.length, 0) + dayVans(date).reduce((n, x) => n + x.issues.length, 0) +
    dayShared(date).filter(x => x.short > 0).length;
}
function dayBarHtml(date, n) {
  const k = dayIssueCount(date);
  return '<button type="button" class="daybar' + (k ? ' warn' : '') + '" data-act="dayOpen" data-d="' + esc(date) + '">' + ico('cal') + '<span>' +
    n + ' eventi lo stesso giorno: controlla la giornata</span>' + (k ? '<em>' + plural(k, 'avviso', 'avvisi') + '</em>' : '') + '</button>';
}
function dayBodyHtml(date) {
  const evs = dayEvents(date);
  let h = '<p class="lev"><b>' + esc(fmtLong(date)) + '</b> · ' + plural(evs.length, 'evento', 'eventi') + '</p>';
  if (evs.length < 2) return h + '<p class="empty">Questo giorno ha un solo evento: non c\\'è niente da confrontare.</p>';
  h += '<h3 class="dsec">Eventi</h3><ul class="dayl">' + evs.map(e => '<li><span class="dtm">' + esc(rangeTxt(evWin(e))) + '</span><span class="dev"><b>' + esc(e.cliente) + '</b>' +
    (e.luogo ? '<small>' + esc(e.luogo) + '</small>' : '') + '</span><span class="pill ' + (STAGE_PILL[e.stato] || 'muted') + '">' + esc(STAGE_LABEL[e.stato] || e.stato) + '</span></li>').join('') + '</ul>';
  const tecs = dayTechs(date);
  h += '<h3 class="dsec">Tecnici in più eventi</h3>';
  if (!tecs.length) h += '<p class="note muted">Nessun tecnico è su due eventi nello stesso giorno.</p>';
  else h += '<ul class="dayl">' + tecs.map(x => '<li class="col"><b>' + esc(x.name) + '</b><span class="dsub">' + x.list.map(e => esc(e.cliente) + ' (' + esc(rangeTxt(evWin(e))) + ')').join(' → ') + '</span>' +
    (x.issues.length ? x.issues.map(i => '<p class="note ' + (i.level === 'bad' ? 'bad' : 'warn') + '">' + esc(i.text) + '</p>').join('') : '<p class="note ok">Ha il tempo per spostarsi.</p>') + '</li>').join('') + '</ul>';
  const vans = dayVans(date);
  h += '<h3 class="dsec">Furgoni</h3>';
  if (!vans.length) h += '<p class="note muted">Non hai inserito i furgoni (scheda Magazzino, Furgoni).</p>';
  else h += '<ul class="dayl">' + vans.map(x => '<li class="col"><b>' + ico('truck') + esc(x.v.nome) + '</b>' +
    '<span class="dsub">' + (x.on.length ? x.on.map(e => esc(e.cliente) + ' (' + esc(rangeTxt(evWin(e))) + ')').join(' → ') : 'libero') + '</span>' +
    x.issues.map(i => '<p class="note ' + (i.level === 'bad' ? 'bad' : 'warn') + '">' + esc(i.text) + '</p>').join('') + '</li>').join('') + '</ul>';
  const sh = dayShared(date);
  h += '<h3 class="dsec">Materiale richiesto da più eventi</h3>';
  if (!sh.length) h += '<p class="note muted">Nessun articolo del magazzino è richiesto da due eventi.</p>';
  else h += '<ul class="dayl">' + sh.map(x => '<li class="col"><b>' + esc(x.m.nome) + '</b><span class="dsub">' +
    x.users.map(u => esc(u.e.cliente) + ' ' + u.q).join(' + ') + ' = ' + x.sum + ' · ne hai ' + x.stock + ' utilizzabili</span>' +
    (x.short > 0 ? '<p class="note bad">Mancano ' + x.short + (S.reuseSame && x.need < x.sum ? ' (contando che alcuni eventi usano gli stessi pezzi uno dopo l\\'altro)' : '') + '.</p>'
      : (x.need < x.sum ? '<p class="note ok">Bastano: gli eventi si susseguono e usano gli stessi pezzi.</p>' : '<p class="note ok">Bastano.</p>')) + '</li>').join('') + '</ul>';
  h += '<label class="chk dreuse"><input type="checkbox" data-chg="reuseSame"' + (S.reuseSame ? ' checked' : '') + '> Due eventi uno dopo l\\'altro possono usare gli stessi pezzi</label>' +
    '<p class="hint">Vale solo se tutti e due hanno inizio e fine indicati e tra la fine del primo e l\\'inizio del secondo c\\'è almeno un\\'ora. Di base è spento: lo stesso pezzo non si conta due volte nello stesso giorno.</p>';
  return h + '<div class="sheetfoot"><button type="button" class="btn pri" data-act="closeSheet">Fatto</button></div>';
}
ACT.dayOpen = el => {
  S.dayFor = el.dataset.d;
  openSheet('Giornata', '<div id="daybody">' + dayBodyHtml(S.dayFor) + '</div>', { noFocus: true });
  S.onClose = () => { S.dayFor = ''; paint(); };
};
CHG.reuseSame = el => {
  S.reuseSame = el.checked;
  store.set('reuseSame', el.checked ? '1' : '0');
  const b = $('#daybody');
  if (b) b.innerHTML = dayBodyHtml(S.dayFor);
  const f = $('#daybody input[data-chg=reuseSame]'); if (f) f.focus({ preventScroll: true });
};

/* ---------- sezione "Spese" nella scheda dell'evento ---------- */
function expRowHtml(e, x) {
  const who = x.pagatoDa === 'azienda' ? 'Pagata dall\\'azienda' : (x.tecnico || 'Un tecnico');
  return '<li><button type="button" class="exr" data-act="expEdit" data-ev="' + esc(e.id) + '" data-id="' + esc(x.id) + '">' +
    '<span class="exm"><b>' + esc(expLabel(x.categoria)) + (x.descrizione ? '<span class="exd"> · ' + esc(x.descrizione) + '</span>' : '') + '</b>' +
    '<small>' + esc(fmtShort(x.data)) + ' · ' + esc(who) + (toN(x.km) ? ' · ' + esc(fmtNum(x.km, 1)) + ' km' : '') + '</small>' +
    '<span class="exp">' + expPill(x) + (isTrue(x.addebitoCliente) ? '<span class="pill blue">al cliente</span>' : '') + '</span></span>' +
    '<span class="exa">' + esc(fmtEur(x.importo)) + '</span></button></li>';
}
function expSectionHtml(e) {
  const list = (S.speByEv[e.id] || []).slice().sort((a, b) => String(a.data).localeCompare(String(b.data)));
  if (e.stato === 'annullato' && !list.length) return '';
  let h = '<h4>Spese</h4>';
  if (!list.length) {
    h += '<p class="muted">Nessuna spesa. Qui annoti carburante, pedaggi, pasti… anticipati dai tecnici o pagati dall\\'azienda, così sai cosa rimborsare e cosa addebitare al cliente.</p>';
  } else {
    h += '<ul class="exps">' + list.map(x => expRowHtml(e, x)).join('') + '</ul>';
    const tot = list.reduce((s, x) => s + toN(x.importo), 0);
    const due = list.filter(x => x.pagatoDa === 'tecnico' && !x.rimborsatoIl).reduce((s, x) => s + toN(x.importo), 0);
    const cli = list.filter(x => isTrue(x.addebitoCliente)).reduce((s, x) => s + toN(x.importo), 0);
    h += '<p class="extot"><span>Totale <b>' + esc(fmtEur(tot)) + '</b></span>' + (due ? '<span>da rimborsare <b>' + esc(fmtEur(due)) + '</b></span>' : '') +
      (cli ? '<span>da addebitare al cliente <b>' + esc(fmtEur(cli)) + '</b></span>' : '') + '</p>';
  }
  if (e.stato !== 'annullato') {
    h += '<div class="row" style="margin-top:10px"><button type="button" class="btn sm" data-act="expAdd" data-ev="' + esc(e.id) + '">' + ico('plus') + ' Aggiungi spesa</button></div>';
  }
  return h;
}

/* =====================================================================
   COORDINATORE - magazzino: entrate e uscite, guasti e riparazioni, registro dei movimenti, inventario, furgoni;
   rimborsi ai tecnici
   ===================================================================== */
const REP_OPEN = ['da riparare', 'in riparazione'];
const REP_CLOSED = ['riparato', 'non riparabile'];
const MOV_IN = [['acquisto', 'Acquisto'], ['reso', 'Reso o rientro da prestito'], ['altro', 'Altro']];
const MOV_OUT = [['venduto', 'Venduto'], ['perso', 'Perso o rubato'], ['consumato', 'Consumato'], ['dismesso', 'Dismesso'],
  ['prestato', 'Prestato'], ['altro', 'Altro']];
const CAUSE_LABEL = { acquisto: 'Acquisto', reso: 'Reso', altro: 'Altro', venduto: 'Venduto', perso: 'Perso', consumato: 'Consumato',
  dismesso: 'Dismesso', prestato: 'Prestato', inventario: 'Inventario', 'modifica scheda': 'Modifica della scheda', 'nuovo articolo': 'Nuovo articolo' };
function causeLabel(c) { return CAUSE_LABEL[c] || cap(c); }
/* "2026-10-27 16:49" -> "27 ott 16:49" */
function fmtWhen(s) {
  const m = /^(\\d{4}-\\d{2}-\\d{2})(?: (\\d{2}:\\d{2}))?$/.exec(String(s || '').trim());
  const p = m ? parseYMD(m[1]) : null;
  return p ? p.d + ' ' + MESI_B[p.m - 1] + (m[2] ? ' ' + m[2] : '') : String(s || '');
}

/* ---------- conti di magazzino ---------- */
/* Sotto scorta: i pezzi utilizzabili sono meno della scorta minima scritta nella scheda dell'articolo */
function isLow(m) {
  const min = toI(m.scortaMinima);
  return min > 0 && String(m.stato) !== 'dismesso' && stockOf(m) < min;
}
function openPieces(equipId) {
  return (S.ripByEq[equipId] || []).filter(r => REP_OPEN.indexOf(r.stato) >= 0).reduce((s, r) => s + toI(r.quantita), 0);
}
/* Pezzi fuori uso nella scheda dell'articolo che non hanno una riparazione aperta */
function orphanList() {
  return S.mat.filter(m => String(m.stato) !== 'dismesso').map(m => ({
    m: m, pieces: Math.max(0, Math.min(toI(m.quantita), toI(m.fuoriServizio)) - openPieces(m.id)),
  })).filter(o => o.pieces > 0);
}
function movShort(x) {
  const d = toSI(x.delta);
  return fmtWhen(x.quando) + ': ' + (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d) + ' · ' + causeLabel(x.causale) + (x.evento ? ' · ' + x.evento : '');
}
/* Dentro la scheda di un articolo aperto: riparazioni in corso e ultimi movimenti */
function stkExtraHtml(m) {
  let h = '';
  const open = (S.ripByEq[m.id] || []).filter(r => REP_OPEN.indexOf(r.stato) >= 0);
  if (open.length) {
    h += '<p>In riparazione o da riparare: <b>' + open.reduce((s, r) => s + toI(r.quantita), 0) + '</b> ' +
      '<button type="button" class="lnk" data-act="goTab" data-tab="mag" data-sub="rip">vedi le riparazioni</button></p>';
  }
  const mv = S.mov.filter(x => x.equipment_id === m.id).slice(-3).reverse();
  if (mv.length) h += '<div class="stkmv"><span class="k">Ultimi movimenti</span>' + mv.map(x => '<span>' + esc(movShort(x)) + '</span>').join('') + '</div>';
  return h;
}

/* ---------- le sezioni del magazzino ---------- */
function viewMag() {
  const nRip = S.rip.filter(r => REP_OPEN.indexOf(r.stato) >= 0).length;
  const tabs = [['articoli', 'Articoli'], ['rip', 'Riparazioni' + (nRip ? ' (' + nRip + ')' : '')], ['mov', 'Movimenti'], ['furgoni', 'Furgoni']];
  return '<div class="cats subtabs" role="group" aria-label="Sezioni del magazzino">' + tabs.map(t =>
    '<button type="button" class="cat" data-act="magTab" data-tab="' + t[0] + '" aria-pressed="' + (S.magTab === t[0]) + '">' + t[1] + '</button>').join('') + '</div>' +
    (S.magTab === 'rip' ? viewRip() : S.magTab === 'mov' ? viewMov() : S.magTab === 'furgoni' ? viewFurgoni() : viewArticoli());
}
ACT.magTab = el => { S.magTab = el.dataset.tab; paint(); };

/* ---------- entrata e uscita ---------- */
function eventOptions(selected) {
  const from = addDays(S.oggi, -60);
  const list = S.ev.filter(e => e.data >= from && e.stato !== 'annullato').sort((a, b) => String(b.data).localeCompare(String(a.data)));
  return '<option value="">Nessuno</option>' + list.map(e => '<option value="' + esc(e.id) + '"' + (e.id === selected ? ' selected' : '') + '>' +
    esc(fmtShort(e.data) + ' · ' + e.cliente) + '</option>').join('');
}
function moveFormHtml(m, tipo) {
  const causes = tipo === 'entrata' ? MOV_IN : MOV_OUT;
  const usable = stockOf(m), max = tipo === 'uscita' ? Math.max(1, usable) : 9999;
  return '<form data-submit="moveForm" data-id="' + esc(m.id) + '" data-tipo="' + tipo + '" novalidate>' +
    '<p class="lev"><b>' + esc(m.nome) + '</b> · ' + toI(m.quantita) + ' in magazzino' + (toI(m.fuoriServizio) ? ', di cui ' + toI(m.fuoriServizio) + ' fuori uso' : '') + '</p>' +
    '<div class="fld"><span>' + (tipo === 'entrata' ? 'Quanti pezzi entrano' : 'Quanti pezzi escono') + '</span>' + qtyField('quantita', 1, 1, max, 'Quanti pezzi') + '</div>' +
    (tipo === 'uscita' ? '<p class="hint">Possono uscire al massimo i pezzi utilizzabili (' + usable + '). I pezzi rotti si tolgono chiudendo la loro riparazione come «non riparabile».</p>' : '') +
    '<label class="fld"><span>Motivo</span><select name="causale">' + causes.map(c => '<option value="' + c[0] + '">' + c[1] + '</option>').join('') + '</select></label>' +
    '<label class="fld"><span>Evento collegato (facoltativo)</span><select name="event_id">' + eventOptions('') + '</select></label>' +
    '<label class="fld"><span>Nota (facoltativa)</span><input type="text" name="nota" maxlength="200" autocomplete="off"></label>' +
    '<p class="ferr" role="alert"></p><div class="sheetfoot"><button type="button" class="btn" data-act="closeSheet">Annulla</button>' +
    '<button type="submit" class="btn pri">' + (tipo === 'entrata' ? 'Registra l\\'entrata' : 'Registra l\\'uscita') + '</button></div></form>';
}
ACT.movOpen = el => {
  const m = S.matById[el.dataset.id];
  if (m) openSheet(el.dataset.tipo === 'entrata' ? 'Entrata in magazzino' : 'Uscita dal magazzino', moveFormHtml(m, el.dataset.tipo), { noFocus: true });
};
SUB.moveForm = async form => {
  const f = new FormData(form), tipo = form.dataset.tipo, id = form.dataset.id, err = $('.ferr', form);
  const q = parseInt(f.get('quantita'), 10);
  if (!(q >= 1)) { err.textContent = 'Scrivi quanti pezzi: almeno 1.'; return; }
  err.textContent = '';
  const r = await mutate(async () => {
    const res = await call('api_stockMove', S.pin, { equipment_id: id, tipo: tipo, causale: String(f.get('causale')), quantita: q,
      event_id: String(f.get('event_id') || ''), nota: String(f.get('nota') || '').trim() });
    upsert(S.mat, res.materiale); S.mov.push(res.movimento); derive();
    closeSheet(); S.openStk = id; paint();
    toast((tipo === 'entrata' ? 'Entrata' : 'Uscita') + ' registrata. Di ' + res.materiale.nome + ' ora ne hai ' + res.materiale.quantita + '.', 'ok');
  }, true);
  if (!r.ok) err.textContent = r.err;
};

/* ---------- guasto ---------- */
function brkFormHtml(m, orphan) {
  const usable = stockOf(m), max = orphan || Math.max(1, usable);
  return '<form data-submit="brkForm" data-id="' + esc(m.id) + '" data-orphan="' + (orphan || 0) + '" novalidate>' +
    '<p class="lev"><b>' + esc(m.nome) + '</b> · utilizzabili ' + usable + ' su ' + toI(m.quantita) + '</p>' +
    (orphan ? '<p class="hint" style="margin-top:6px">Questi pezzi risultano già fuori uso ma non hanno una scheda di riparazione: la crei adesso.</p>'
      : '<p class="hint" style="margin-top:6px">Da quando lo segnali, quei pezzi non sono più disponibili per gli eventi.</p>') +
    '<div class="fld"><span>Quanti pezzi sono guasti</span>' + qtyField('quantita', orphan || 1, 1, max, 'Quanti pezzi guasti') + '</div>' +
    '<label class="fld"><span>Cosa non va</span><input type="text" name="difetto" list="difetti" maxlength="200" autocomplete="off" placeholder="es. Non si accende"></label>' +
    '<datalist id="difetti"><option value="Non si accende"><option value="Non esce audio"><option value="Rumore o fruscio"><option value="Cavo rotto o contatto interrotto">' +
    '<option value="Danno meccanico"><option value="Connettore rotto"></datalist>' +
    '<p class="ferr" role="alert"></p><div class="sheetfoot"><button type="button" class="btn" data-act="closeSheet">Annulla</button>' +
    '<button type="submit" class="btn pri">Segna come guasto</button></div></form>';
}
ACT.brkOpen = el => { const m = S.matById[el.dataset.id]; if (m) openSheet('Segnala un guasto', brkFormHtml(m, 0), { noFocus: true }); };
ACT.brkOrphan = el => {
  const m = S.matById[el.dataset.id], o = orphanList().filter(x => x.m.id === el.dataset.id)[0];
  if (m && o) openSheet('Scheda di riparazione', brkFormHtml(m, o.pieces), { noFocus: true });
};
SUB.brkForm = async form => {
  const f = new FormData(form), id = form.dataset.id, orphan = parseInt(form.dataset.orphan, 10) || 0, err = $('.ferr', form);
  const q = parseInt(f.get('quantita'), 10);
  if (!(q >= 1)) { err.textContent = 'Scrivi quanti pezzi sono guasti: almeno 1.'; return; }
  err.textContent = '';
  const r = await mutate(async () => {
    const res = await call('api_repOpen', S.pin, { equipment_id: id, quantita: q, difetto: String(f.get('difetto') || '').trim(), giaFuoriUso: orphan > 0 });
    S.rip.push(res.riparazione); upsert(S.mat, res.materiale); derive();
    closeSheet(); S.tab = 'mag'; S.magTab = 'rip'; S.ripOpen = res.riparazione.id; paint();
    toast('Guasto segnalato: ' + res.riparazione.materiale + '.', 'ok');
  }, true);
  if (!r.ok) err.textContent = r.err;
};

/* ---------- riparazioni ---------- */
function ripOrigin(r) {
  if (r.apertoDa === 'Rientro' && r.evento) return 'Rientrato danneggiato da «' + r.evento + '»';
  if (r.evento) return 'Evento «' + r.evento + '»';
  return 'Segnalato da te';
}
function ripCardHtml(r) {
  const open = REP_OPEN.indexOf(r.stato) >= 0, isOpen = S.ripOpen === r.id;
  const pill = r.stato === 'da riparare' ? '<span class="pill warn">da riparare</span>' : r.stato === 'in riparazione' ? '<span class="pill blue">in riparazione</span>' :
    r.stato === 'riparato' ? '<span class="pill ok">riparato</span>' : '<span class="pill bad">non riparabile</span>';
  let det = '';
  if (isOpen) {
    const lines = [ripOrigin(r)];
    if (r.fornitore) lines.push('Da: ' + r.fornitore);
    if (r.previsto) lines.push('Rientro previsto: ' + fmtShort(r.previsto));
    if (r.costo !== '' && r.costo != null) lines.push('Costo: ' + fmtEur(r.costo));
    if (r.nota) lines.push(r.nota);
    det = '<div class="stkd">' + lines.map(x => '<p>' + esc(x) + '</p>').join('') + '<div class="row">';
    if (r.stato === 'da riparare') det += '<button type="button" class="btn sm pri" data-act="ripForm" data-id="' + esc(r.id) + '" data-mode="send">' + ico('truck') + ' Mandato in riparazione</button>';
    if (open) {
      det += '<button type="button" class="btn sm" data-act="ripForm" data-id="' + esc(r.id) + '" data-mode="riparato">' + ico('check') + ' Riparato</button>' +
        '<button type="button" class="btn sm danger" data-act="ripForm" data-id="' + esc(r.id) + '" data-mode="non riparabile">Non riparabile</button>';
      if (r.stato === 'in riparazione') det += '<button type="button" class="btn sm" data-act="ripBack" data-id="' + esc(r.id) + '">Rimetti «da riparare»</button>';
    }
    det += '<button type="button" class="btn sm" data-act="ripForm" data-id="' + esc(r.id) + '" data-mode="edit">' + ico('edit') + ' Modifica</button></div></div>';
  }
  const sub = open ? ('Aperto il ' + fmtShort(r.aperto) + (r.fornitore ? ' · ' + r.fornitore : '')) : ('Chiuso il ' + fmtShort(r.chiuso) + (r.costo !== '' && r.costo != null ? ' · ' + fmtEur(r.costo) : ''));
  return '<article class="stk rp' + (isOpen ? ' open' : '') + (open ? '' : ' off') + '"><button type="button" class="stkh" data-act="ripToggle" data-id="' + esc(r.id) + '" aria-expanded="' + isOpen + '">' +
    '<span class="stkn">' + toI(r.quantita) + ' × ' + esc(r.materiale) + '<small>' + esc(r.difetto || 'Non specificato') + '</small></span>' +
    '<span class="stkc">' + pill + '<small>' + esc(sub) + '</small></span></button>' + det + '</article>';
}
function viewRip() {
  const open = S.rip.filter(r => REP_OPEN.indexOf(r.stato) >= 0);
  const closed = S.rip.filter(r => REP_CLOSED.indexOf(r.stato) >= 0).sort((a, b) => String(b.chiuso).localeCompare(String(a.chiuso)));
  const toDo = open.filter(r => r.stato === 'da riparare'), inShop = open.filter(r => r.stato === 'in riparazione');
  const byAge = (a, b) => String(a.aperto).localeCompare(String(b.aperto));
  let h = '<div class="toolbar"><span class="muted">' + (open.length ? plural(open.reduce((s, r) => s + toI(r.quantita), 0), 'pezzo guasto', 'pezzi guasti') : 'Nessun pezzo guasto') + '</span></div>';
  const orph = orphanList();
  if (orph.length) {
    h += '<section class="box todo"><h3>Fuori uso senza scheda</h3><ul>' + orph.map(o => '<li><span><b>' + esc(o.m.nome) + '</b>: ' +
      plural(o.pieces, 'pezzo', 'pezzi') + '</span><button type="button" class="btn sm" data-act="brkOrphan" data-id="' + esc(o.m.id) + '">Crea la scheda</button></li>').join('') + '</ul>' +
      '<p class="hint">Nella scheda dell\\'articolo risultano fuori uso, ma non si sa cosa gli è successo né dove sono.</p></section>';
  }
  if (!open.length && !closed.length && !orph.length) {
    return h + '<p class="empty">Nessuna riparazione. I pezzi danneggiati al rientro dagli eventi finiscono qui da soli; per un guasto trovato in magazzino apri l\\'articolo e tocca «Guasto».</p>';
  }
  h += '<h3 class="catsep">Da riparare (' + toDo.length + ')</h3>' + (toDo.length ? toDo.sort(byAge).map(ripCardHtml).join('') : '<p class="empty" style="padding:12px 4px">Niente da portare in riparazione.</p>');
  h += '<h3 class="catsep">In riparazione (' + inShop.length + ')</h3>' + (inShop.length ? inShop.sort(byAge).map(ripCardHtml).join('') : '<p class="empty" style="padding:12px 4px">Niente dal riparatore.</p>');
  if (closed.length) {
    const spent = closed.reduce((s, r) => s + toN(r.costo), 0);
    h += '<h3 class="catsep">Chiuse di recente</h3>' + (spent ? '<p class="hint" style="margin-top:6px">Spesa registrata: ' + esc(fmtEur(spent)) + '</p>' : '') + closed.slice(0, 40).map(ripCardHtml).join('');
  }
  return h;
}
ACT.ripToggle = el => { S.ripOpen = S.ripOpen === el.dataset.id ? null : el.dataset.id; paint(); };
function ripById(id) { return S.rip.filter(r => r.id === id)[0]; }
function suppliers() { return uniq(S.rip.map(r => String(r.fornitore || '').trim()).filter(Boolean)).sort(cmpName); }
function ripFormHtml(r, mode) {
  const q = toI(r.quantita);
  const sup = '<datalist id="fornitori">' + suppliers().map(x => '<option value="' + esc(x) + '">').join('') + '</datalist>';
  const head = '<p class="lev"><b>' + q + ' × ' + esc(r.materiale) + '</b> · ' + esc(r.difetto || 'Non specificato') + '</p>';
  let body = '';
  if (mode === 'send') {
    body = '<label class="fld"><span>A chi lo porti (facoltativo)</span><input type="text" name="fornitore" list="fornitori" maxlength="100" value="' + esc(r.fornitore || '') + '" autocomplete="off"></label>' + sup +
      '<label class="fld"><span>Quando dovrebbe rientrare (facoltativo)</span><input type="date" name="previsto" value="' + esc(r.previsto || '') + '" min="' + esc(S.oggi) + '"></label>';
  } else if (mode === 'riparato' || mode === 'non riparabile') {
    body = (q > 1 ? '<div class="fld"><span>Quanti pezzi</span>' + qtyField('quantita', q, 1, q, 'Quanti pezzi') + '</div><p class="hint">Se solo una parte è pronta, scrivi quanti: gli altri restano aperti.</p>' : '') +
      '<label class="fld"><span>Costo in euro (facoltativo)</span><input type="text" inputmode="decimal" name="costo" value="' + esc(r.costo !== '' && r.costo != null ? fmtAmt(r.costo) : '') + '" placeholder="es. 45,00" autocomplete="off"></label>' +
      '<label class="fld"><span>Nota (facoltativa)</span><input type="text" name="nota" maxlength="300" value="' + esc(r.nota || '') + '" autocomplete="off"></label>' +
      '<p class="hint">' + (mode === 'riparato' ? 'I pezzi tornano disponibili per gli eventi.' : 'I pezzi escono dal magazzino (dismessi) e restano nel registro dei movimenti.') + '</p>';
  } else {
    const open = REP_OPEN.indexOf(r.stato) >= 0;
    body = (open ? '<label class="fld"><span>Cosa non va</span><input type="text" name="difetto" maxlength="200" value="' + esc(r.difetto || '') + '" autocomplete="off"></label>' +
      '<label class="fld"><span>A chi lo porti</span><input type="text" name="fornitore" list="fornitori" maxlength="100" value="' + esc(r.fornitore || '') + '" autocomplete="off"></label>' + sup +
      '<label class="fld"><span>Rientro previsto</span><input type="date" name="previsto" value="' + esc(r.previsto || '') + '"></label>' : '') +
      '<label class="fld"><span>Costo in euro</span><input type="text" inputmode="decimal" name="costo" value="' + esc(r.costo !== '' && r.costo != null ? fmtAmt(r.costo) : '') + '" autocomplete="off"></label>' +
      '<label class="fld"><span>Nota</span><input type="text" name="nota" maxlength="300" value="' + esc(r.nota || '') + '" autocomplete="off"></label>';
  }
  const go = mode === 'send' ? 'Segna come mandato' : mode === 'riparato' ? 'Segna come riparato' : mode === 'non riparabile' ? 'Segna come non riparabile' : 'Salva';
  return '<form data-submit="ripForm" data-id="' + esc(r.id) + '" data-mode="' + esc(mode) + '" novalidate>' + head + body +
    '<p class="ferr" role="alert"></p><div class="sheetfoot"><button type="button" class="btn" data-act="closeSheet">Annulla</button>' +
    '<button type="submit" class="btn ' + (mode === 'non riparabile' ? 'danger' : 'pri') + '">' + go + '</button></div></form>';
}
ACT.ripForm = el => {
  const r = ripById(el.dataset.id), mode = el.dataset.mode;
  if (!r) return;
  openSheet(mode === 'send' ? 'Mandato in riparazione' : mode === 'riparato' ? 'Riparato' : mode === 'non riparabile' ? 'Non riparabile' : 'Modifica la riparazione', ripFormHtml(r, mode), { noFocus: true });
};
SUB.ripForm = async form => {
  const f = new FormData(form), g = k => String(f.get(k) == null ? '' : f.get(k)).trim();
  const r0 = ripById(form.dataset.id), mode = form.dataset.mode, err = $('.ferr', form);
  if (!r0) return;
  err.textContent = '';
  const res = await mutate(async () => {
    if (mode === 'riparato' || mode === 'non riparabile') {
      const out = await call('api_repClose', S.pin, r0.id, { esito: mode, quantita: f.has('quantita') ? parseInt(f.get('quantita'), 10) : '', costo: g('costo'), nota: g('nota') });
      (out.riparazioni || []).forEach(x => upsert(S.rip, x));
      if (out.materiale) upsert(S.mat, out.materiale);
      if (out.movimento) S.mov.push(out.movimento);
      toast(mode === 'riparato' ? 'Segnato come riparato: i pezzi sono di nuovo disponibili.' : 'Segnato come non riparabile: i pezzi sono usciti dal magazzino.', 'ok');
    } else {
      const patch = mode === 'send' ? { stato: 'in riparazione', fornitore: g('fornitore'), previsto: g('previsto') }
        : (REP_OPEN.indexOf(r0.stato) >= 0 ? { difetto: g('difetto'), fornitore: g('fornitore'), previsto: g('previsto'), costo: g('costo'), nota: g('nota') } : { costo: g('costo'), nota: g('nota') });
      const out = await call('api_repUpdate', S.pin, r0.id, patch);
      upsert(S.rip, out.riparazione);
      toast(mode === 'send' ? 'Segnato come mandato in riparazione.' : 'Salvato.', 'ok');
    }
    derive(); closeSheet(); paint();
  }, true);
  if (!res.ok) err.textContent = res.err;
};
ACT.ripBack = el => {
  const r = ripById(el.dataset.id);
  if (!r) return;
  mutate(async () => {
    const out = await call('api_repUpdate', S.pin, r.id, { stato: 'da riparare' });
    upsert(S.rip, out.riparazione); derive(); paint();
    toast('Rimesso tra i pezzi da riparare.');
  });
};
/* Un importo da rimettere in un campo: 45 -> "45", 45.5 -> "45,50" */
function fmtAmt(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return v === Math.floor(v) ? String(v) : v.toFixed(2).replace('.', ',');
}

/* ---------- registro dei movimenti ---------- */
function movListHtml() {
  const words = S.movQ.trim().toLowerCase().split(/\\s+/).filter(Boolean);
  const list = S.mov.slice().reverse().filter(x => (!S.movKind || x.tipo === S.movKind) &&
    words.every(w => (x.materiale + ' ' + (x.evento || '') + ' ' + (x.nota || '') + ' ' + causeLabel(x.causale)).toLowerCase().indexOf(w) >= 0));
  if (!list.length) return '<p class="empty">' + (S.mov.length ? 'Nessun movimento corrisponde.' : 'Ancora nessun movimento. Ogni entrata, uscita, inventario o pezzo perso lascia una riga qui.') + '</p>';
  return '<ul class="movs">' + list.slice(0, 200).map(x => {
    const d = toSI(x.delta), kind = x.tipo === 'entrata' ? 'in' : x.tipo === 'uscita' ? 'out' : 'adj';
    return '<li class="mv"><span class="mvq ' + kind + '">' + (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d) + '</span><span class="mvm"><b>' + esc(x.materiale) + '</b>' +
      '<small>' + esc(fmtWhen(x.quando)) + ' · ' + esc(causeLabel(x.causale)) + (x.evento ? ' · ' + esc(x.evento) : '') + (x.chi ? ' · ' + esc(x.chi) : '') + '</small>' +
      (x.nota ? '<small>' + esc(x.nota) + '</small>' : '') + '</span><span class="mvg">ne hai<br><b>' + toI(x.giacenzaDopo) + '</b></span></li>';
  }).join('') + '</ul>' + (list.length > 200 ? '<p class="hint">Vedo i 200 più recenti: restringi la ricerca per trovare gli altri.</p>' : '');
}
function viewMov() {
  const kinds = [['', 'Tutti'], ['entrata', 'Entrate'], ['uscita', 'Uscite'], ['rettifica', 'Correzioni']];
  let h = '<input type="search" id="movq" class="srch" data-inp="movQ" value="' + esc(S.movQ) + '" placeholder="Cerca articolo, evento, nota…" aria-label="Cerca nei movimenti" autocomplete="off" autocapitalize="off">';
  h += '<div class="cats" role="group" aria-label="Tipo di movimento">' + kinds.map(k =>
    '<button type="button" class="cat" data-act="movKind" data-kind="' + k[0] + '" aria-pressed="' + (S.movKind === k[0]) + '">' + k[1] + '</button>').join('') + '</div>';
  h += '<div id="movlist">' + movListHtml() + '</div>';
  if (!S.movAll && S.mov.length >= 300) h += '<div class="row" style="margin-top:14px"><button type="button" class="btn" data-act="movMore">Carica anche i movimenti più vecchi</button></div>';
  return h;
}
INP.movQ = el => { S.movQ = el.value; const b = $('#movlist'); if (b) b.innerHTML = movListHtml(); };
ACT.movKind = el => { S.movKind = el.dataset.kind; paint(); };
ACT.movMore = () => {
  mutate(async () => {
    S.mov = await call('api_movList', S.pin, 3000);
    S.movAll = true; paint();
    toast('Movimenti caricati: ' + S.mov.length + '.', 'ok');
  });
};

/* ---------- furgoni ---------- */
function vanJobs(v) {
  const evs = (S.feByVan[v.id] || []).map(f => S.evById[f.event_id]).filter(e => e && e.stato !== 'annullato' && !e.scaricoQuando && e.data >= S.oggi).sort(cmpEv);
  return evs;
}
function viewFurgoni() {
  let h = '<div class="toolbar"><button class="btn pri" data-act="vanNew">' + ico('plus') + ' Nuovo furgone</button>' +
    '<span class="muted">' + plural(activeVans().length, 'furgone in uso', 'furgoni in uso') + '</span></div>';
  if (!S.fur.length) {
    return h + '<p class="empty" style="padding-bottom:8px">Non hai ancora inserito i furgoni. Tocca il nome per aggiungerlo subito (targa e portata le scrivi dopo), oppure «Nuovo furgone».</p>' +
      '<div class="row">' + ['Ford', 'Mercedes', 'Daily'].map(n => '<button type="button" class="btn" data-act="vanQuick" data-nome="' + n + '">' + ico('plus') + ' ' + n + '</button>').join('') + '</div>';
  }
  h += S.fur.slice().sort((a, b) => (b.attivo !== false) - (a.attivo !== false) || cmpName(a.nome, b.nome)).map(v => {
    const jobs = vanJobs(v), off = v.attivo === false;
    const spec = [];
    if (toN(v.portata_kg) > 0) spec.push('portata ' + fmtNum(v.portata_kg, 0) + ' kg');
    if (toN(v.volume_m3) > 0) spec.push(fmtNum(v.volume_m3, 1) + ' m³');
    return '<article class="tec vcard' + (off ? ' inactive' : '') + '"><div class="asgtop"><span class="tname">' + ico('truck') + ' ' + esc(v.nome) + '</span>' +
      (v.targa ? '<span class="chip">' + esc(v.targa) + '</span>' : '') + (off ? '<span class="pill muted">non in uso</span>' : '') + '</div>' +
      '<div class="tinfo"><div>' + (spec.length ? esc(spec.join(' · ')) : 'Portata e volume non indicati: servono per il controllo del carico.') + '</div>' +
      (v.note ? '<div>' + esc(v.note) + '</div>' : '') +
      '<div>' + (jobs.length ? 'Prossimi impegni: ' + jobs.slice(0, 4).map(e => esc(fmtShort(e.data) + ' ' + e.cliente)).join(', ') + (jobs.length > 4 ? ' e altri ' + (jobs.length - 4) : '') : (off ? '' : 'Libero nei prossimi giorni.')) + '</div></div>' +
      '<div class="tact"><button type="button" class="btn sm" data-act="vanEdit" data-id="' + esc(v.id) + '">' + ico('edit') + ' Modifica</button></div></article>';
  }).join('');
  return h;
}
function vanFormHtml(v) {
  const x = v || {};
  return '<form data-submit="vanForm" novalidate><input type="hidden" name="id" value="' + esc(x.id || '') + '">' +
    '<label class="fld"><span>Nome del furgone</span><input type="text" name="nome" value="' + esc(x.nome || '') + '" maxlength="60" autocomplete="off" placeholder="es. Ford"></label>' +
    '<label class="fld"><span>Targa (facoltativa)</span><input type="text" name="targa" value="' + esc(x.targa || '') + '" maxlength="12" autocomplete="off" autocapitalize="characters"></label>' +
    '<div class="grid2"><label class="fld"><span>Portata (kg)</span><input type="text" inputmode="decimal" name="portata_kg" value="' + esc(x.portata_kg == null ? '' : x.portata_kg) + '" autocomplete="off"></label>' +
    '<label class="fld"><span>Volume del vano (m³)</span><input type="text" inputmode="decimal" name="volume_m3" value="' + esc(x.volume_m3 == null ? '' : x.volume_m3) + '" autocomplete="off"></label></div>' +
    '<p class="hint">Portata e volume servono per avvisarti se il carico è troppo. Li trovi sul libretto del furgone; si possono scrivere anche dopo.</p>' +
    '<label class="fld"><span>Note (facoltative)</span><input type="text" name="note" value="' + esc(x.note || '') + '" maxlength="200" autocomplete="off"></label>' +
    (v ? '<label class="chk" style="margin-top:6px"><input type="checkbox" name="attivo"' + (x.attivo !== false ? ' checked' : '') + '> È in uso (se lo togli non compare più tra i furgoni da assegnare)</label>' : '') +
    '<p class="ferr" role="alert"></p><div class="sheetfoot"><button type="button" class="btn" data-act="closeSheet">Annulla</button><button type="submit" class="btn pri">Salva furgone</button></div></form>';
}
ACT.vanNew = () => openSheet('Nuovo furgone', vanFormHtml(null));
ACT.vanEdit = el => { const v = S.furById[el.dataset.id]; if (v) openSheet('Modifica il furgone', vanFormHtml(v)); };
ACT.vanQuick = el => {
  mutate(async () => {
    const saved = await call('api_saveVan', S.pin, { nome: el.dataset.nome });
    upsert(S.fur, saved); derive(); paint();
    toast(saved.nome + ' aggiunto. Quando puoi, scrivi targa e portata con «Modifica».', 'ok');
  });
};
SUB.vanForm = async form => {
  const f = new FormData(form), g = k => String(f.get(k) == null ? '' : f.get(k)).trim();
  const v = { id: g('id') || undefined, nome: g('nome'), targa: g('targa'), portata_kg: g('portata_kg'), volume_m3: g('volume_m3'), note: g('note'),
    attivo: f.has('id') && g('id') ? f.has('attivo') : true };
  const err = $('.ferr', form);
  if (!v.nome) { err.textContent = 'Scrivi il nome del furgone.'; $('[name=nome]', form).focus(); return; }
  err.textContent = '';
  const isNew = !v.id;
  const r = await mutate(async () => {
    const saved = await call('api_saveVan', S.pin, v);
    upsert(S.fur, saved);
    S.fe.forEach(x => { if (x.van_id === saved.id) x.furgone = saved.nome; });
    derive(); closeSheet(); S.tab = 'mag'; S.magTab = 'furgoni'; paint();
    toast(isNew ? 'Furgone aggiunto.' : 'Furgone salvato.', 'ok');
  }, true);
  if (!r.ok) err.textContent = r.err;
};

/* ---------- inventario: si conta e si scrive quanti pezzi ci sono davvero ---------- */
function invItems() {
  return S.mat.filter(m => String(m.stato) !== 'dismesso').sort((a, b) => cmpCat(a.categoria, b.categoria) || cmpName(a.nome, b.nome));
}
function invDiffs() {
  const out = [];
  invItems().forEach(m => {
    const v = S.inv.vals[m.id];
    if (v === undefined || v === '') return;
    const n = parseInt(v, 10);
    if (isNaN(n) || n === toI(m.quantita)) return;
    out.push({ m: m, n: n, have: toI(m.quantita) });
  });
  return out;
}
function invCounted() { return Object.keys(S.inv.vals).filter(k => S.inv.vals[k] !== '' && S.inv.vals[k] !== undefined).length; }
function invCountHtml() {
  const items = invItems();
  const cats = uniq(items.map(m => catKey(m.categoria) || 'generale')).sort(cmpCat);
  let h = '<p class="hint" style="margin-top:0">Conta i pezzi che hai davvero e scrivi il numero accanto all\\'articolo. Gli articoli che non conti oggi lasciali vuoti: non cambiano. Alla fine vedi le differenze e confermi.</p>';
  h += '<input type="search" id="invq" class="srch" data-inp="invSearch" placeholder="Cerca: nexo, cavo, pedana…" aria-label="Cerca nel magazzino" autocomplete="off" autocapitalize="off">';
  h += '<div class="cats" role="group" aria-label="Categoria"><button type="button" class="cat" data-act="invCat" data-cat="" aria-pressed="true">Tutti</button>' +
    cats.map(c => '<button type="button" class="cat" data-act="invCat" data-cat="' + esc(c) + '" aria-pressed="false">' + esc(catLabel(c)) + '</button>').join('') + '</div>';
  h += '<ul class="invl" id="invl">' + items.map(m => {
    const v = S.inv.vals[m.id];
    return '<li class="inv" data-id="' + esc(m.id) + '" data-cat="' + esc(catKey(m.categoria) || 'generale') + '" data-q="' + esc(stkText(m)) + '"><div class="invm"><b>' + esc(m.nome) + '</b>' +
      '<small>in sistema: ' + toI(m.quantita) + (toI(m.fuoriServizio) ? ' (di cui ' + toI(m.fuoriServizio) + ' fuori uso)' : '') + '</small></div>' +
      '<input type="number" inputmode="numeric" min="0" max="9999" data-inp="invQty" data-id="' + esc(m.id) + '" value="' + esc(v === undefined ? '' : v) + '" placeholder="—" aria-label="Pezzi contati: ' + esc(m.nome) + '">' +
      '<span class="invd" aria-live="polite"></span></li>';
  }).join('') + '</ul>';
  h += '<p class="empty" id="inv-empty" hidden>Nessun articolo trovato. Prova un\\'altra parola.</p>';
  h += '<div class="sheetfoot sticky"><button type="button" class="btn" data-act="closeSheet">Annulla</button><button type="button" class="btn pri" id="invgo" data-act="invReview" disabled>Conta qualcosa</button></div>';
  return h;
}
function invTally() {
  const d = invDiffs(), c = invCounted(), b = $('#invgo');
  if (!b) return;
  b.disabled = !c;
  b.textContent = !c ? 'Conta qualcosa' : d.length ? 'Rivedi ' + plural(d.length, 'differenza', 'differenze') : 'Contati ' + c + ': nessuna differenza';
  b.disabled = !c;
}
function invMark(li) {
  const m = S.matById[li.dataset.id], v = S.inv.vals[li.dataset.id], out = $('.invd', li);
  const n = parseInt(v, 10);
  li.classList.remove('same', 'diff');
  if (v === undefined || v === '' || isNaN(n)) { out.textContent = ''; return; }
  const dd = n - toI(m.quantita);
  if (dd === 0) { li.classList.add('same'); out.textContent = 'ok'; } else { li.classList.add('diff'); out.textContent = (dd > 0 ? '+' : '−') + Math.abs(dd); }
}
ACT.invOpen = () => {
  S.inv = { vals: {}, step: 'count' };
  openSheet('Inventario', '<div id="invbody">' + invCountHtml() + '</div>', { noFocus: true });
  S.onClose = () => { S.inv = null; paint(); };
};
INP.invQty = el => {
  const v = el.value.trim();
  if (v === '') delete S.inv.vals[el.dataset.id]; else S.inv.vals[el.dataset.id] = String(Math.max(0, Math.min(9999, parseInt(v, 10) || 0)));
  invMark(el.closest('li'));
  invTally();
};
function invFilter() {
  const words = ($('#invq') ? $('#invq').value : '').trim().toLowerCase().split(/\\s+/).filter(Boolean);
  const cat = ($('#invbody .cat[aria-pressed=true]') || { dataset: { cat: '' } }).dataset.cat || '';
  let shown = 0;
  $$('#invl .inv').forEach(li => {
    const ok = (!cat || li.dataset.cat === cat) && words.every(w => li.dataset.q.indexOf(w) >= 0);
    li.hidden = !ok;
    if (ok) shown++;
  });
  const em = $('#inv-empty'); if (em) em.hidden = shown > 0;
}
INP.invSearch = () => invFilter();
ACT.invCat = el => { $$('#invbody .cat').forEach(b => b.setAttribute('aria-pressed', String(b === el))); invFilter(); };
function invReviewHtml() {
  const d = invDiffs();
  let h = '<h3 class="lrev">Controlla prima di salvare</h3>';
  if (!d.length) {
    h += '<p>Gli articoli contati (' + invCounted() + ') corrispondono tutti a quello che c\\'è in sistema: non cambia niente.</p>' +
      '<div class="sheetfoot"><button type="button" class="btn pri" data-act="invBack">Torna all\\'elenco</button></div>';
    return h;
  }
  h += '<p class="hint" style="margin-top:0">Questi articoli cambiano. Le differenze restano nel registro dei movimenti come «Inventario».</p><ul class="lfx">' +
    d.map(x => '<li><b>' + esc(x.m.nome) + '</b><span>' + x.have + ' → <b>' + x.n + '</b> (' + (x.n > x.have ? '+' : '−') + Math.abs(x.n - x.have) + ')</span></li>').join('') + '</ul>' +
    '<label class="fld"><span>Nota (facoltativa)</span><input type="text" id="invnote" maxlength="200" value="Inventario del ' + esc(fmtShort(S.oggi)) + '" autocomplete="off"></label>' +
    '<p class="ferr" role="alert"></p><div class="sheetfoot sticky"><button type="button" class="btn" data-act="invBack">Indietro</button>' +
    '<button type="button" class="btn pri" data-act="invSave">Salva ' + plural(d.length, 'correzione', 'correzioni') + '</button></div>';
  return h;
}
ACT.invReview = () => { S.inv.step = 'review'; $('#invbody').innerHTML = invReviewHtml(); const sh = $('#sheet .sheet'); if (sh) sh.scrollTop = 0; };
ACT.invBack = () => {
  S.inv.step = 'count';
  $('#invbody').innerHTML = invCountHtml();
  $$('#invl .inv').forEach(invMark);
  invTally();
};
ACT.invSave = async () => {
  const d = invDiffs(), err = $('#sheet .ferr'), note = ($('#invnote') || { value: '' }).value.trim();
  if (!d.length) return;
  const r = await mutate(async () => {
    const res = await call('api_inventory', S.pin, d.map(x => ({ equipment_id: x.m.id, quantita: x.n })), note);
    (res.materiali || []).forEach(m => upsert(S.mat, m));
    (res.movimenti || []).forEach(m => S.mov.push(m));
    derive(); S.inv = null; closeSheet(); paint();
    toast('Inventario salvato: ' + plural((res.materiali || []).length, 'articolo corretto', 'articoli corretti') + '.', 'ok');
  }, true);
  if (!r.ok && err) err.textContent = r.err;
};

/* ---------- rimborsi ai tecnici (scheda Tecnici) ---------- */
function reimbByTec() {
  const by = {};
  reimbList().forEach(x => { (by[x.technician_id] = by[x.technician_id] || []).push(x); });
  return by;
}
function rimbBoxHtml() {
  const by = reimbByTec(), ids = Object.keys(by);
  if (!ids.length) return '';
  const sum = reimbSummary();
  return '<section class="box todo"><h3>Rimborsi da fare · ' + esc(fmtEur(sum.tot)) + '</h3><ul>' + ids.map(id => {
    const t = S.tecById[id], l = by[id], tot = l.reduce((s, x) => s + toN(x.importo), 0);
    return '<li><span><b>' + esc(t ? t.nome : (l[0].tecnico || 'Tecnico')) + '</b>: ' + plural(l.length, 'spesa', 'spese') + ', ' + esc(fmtEur(tot)) + '</span>' +
      '<button type="button" class="btn sm" data-act="rimbOpen" data-id="' + esc(id) + '">Apri</button></li>';
  }).join('') + '</ul></section>';
}
function tecDueHtml(t) {
  const l = reimbList().filter(x => x.technician_id === t.id);
  if (!l.length) return '';
  return '<div><button type="button" class="lnk" data-act="rimbOpen" data-id="' + esc(t.id) + '">Da rimborsare: <b>' + esc(fmtEur(l.reduce((s, x) => s + toN(x.importo), 0))) + '</b> (' + plural(l.length, 'spesa', 'spese') + ')</button></div>';
}
function rimbData() {
  const id = S.rb.techId;
  const open = S.spe.filter(x => x.technician_id === id && x.pagatoDa === 'tecnico' && !x.rimborsatoIl).sort((a, b) => String(a.data).localeCompare(String(b.data)));
  const done = S.spe.filter(x => x.technician_id === id && x.pagatoDa === 'tecnico' && x.rimborsatoIl).sort((a, b) => String(b.rimborsatoIl).localeCompare(String(a.rimborsatoIl)) || String(b.data).localeCompare(String(a.data))).slice(0, 8);
  return { open: open, done: done };
}
function rimbMsg(t, sel) {
  const lines = ['Ciao ' + firstName(t.nome) + ', ecco il riepilogo delle spese che ti rimborso' + (S.cfg.nome_azienda ? ' (' + S.cfg.nome_azienda + ')' : '') + ':'];
  sel.forEach(x => lines.push('• ' + fmtShort(x.data) + ' ' + expLabel(x.categoria) + (x.descrizione ? ' (' + x.descrizione + ')' : '') + ', ' + (x.evento || '') + ': ' + fmtEur(x.importo)));
  lines.push('Totale: ' + fmtEur(sel.reduce((s, x) => s + toN(x.importo), 0)));
  lines.push('Se qualcosa non torna scrivimi.');
  return lines.join('\\n');
}
function rimbHtml() {
  const t = S.tecById[S.rb.techId], d = rimbData();
  const sel = d.open.filter(x => S.rb.sel[x.id]);
  const tot = sel.reduce((s, x) => s + toN(x.importo), 0);
  let h = '<p class="lev"><b>' + esc(t ? t.nome : 'Tecnico') + '</b></p>';
  if (!d.open.length) h += '<p class="empty" style="padding:12px 4px">Non c\\'è niente da rimborsargli.</p>';
  else {
    h += '<ul class="rimb">' + d.open.map(x => '<li><label class="rbrow"><input type="checkbox" data-chg="rbTick" data-id="' + esc(x.id) + '"' + (S.rb.sel[x.id] ? ' checked' : '') + '>' +
      '<span class="rbm"><b>' + esc(expLabel(x.categoria)) + (x.descrizione ? ' · ' + esc(x.descrizione) : '') + '</b><small>' + esc(fmtShort(x.data)) + ' · ' + esc(x.evento || '') + (toN(x.km) ? ' · ' + esc(fmtNum(x.km, 1)) + ' km' : '') + '</small></span>' +
      '<span class="rba">' + esc(fmtEur(x.importo)) + '</span></label></li>').join('') + '</ul>';
    h += '<p class="extot"><span>Selezionate <b>' + sel.length + '</b></span><span>Totale <b>' + esc(fmtEur(tot)) + '</b></span></p>';
    h += '<label class="fld"><span>Rimborsate il</span><input type="date" id="rbdate" value="' + esc(S.rb.date) + '" max="' + esc(S.oggi) + '"></label>';
    const link = t && sel.length ? waLink(t.telefono, rimbMsg(t, sel), S.cfg.prefisso_telefono) : '';
    h += '<p class="ferr" role="alert"></p><div class="sheetfoot"><button type="button" class="btn pri" data-act="rbPay"' + (sel.length ? '' : ' disabled') + '>' + ico('check') + ' Segna come rimborsate</button></div>';
    h += '<div class="row" style="margin-top:10px">' + (link ? '<a class="btn sm" href="' + esc(link) + '" target="_blank" rel="noopener">' + ico('chat') + ' Mandagli il riepilogo su WhatsApp</a>'
      : '<span class="note muted">' + (sel.length ? 'Manca il telefono: aggiungilo nella scheda del tecnico.' : 'Spunta le spese per preparare il messaggio.') + '</span>') + '</div>';
  }
  if (d.done.length) {
    h += '<h3 class="dsec">Già rimborsate</h3><ul class="rimb done">' + d.done.map(x => '<li><div class="rbrow"><span class="rbm"><b>' + esc(expLabel(x.categoria)) + (x.descrizione ? ' · ' + esc(x.descrizione) : '') + '</b>' +
      '<small>' + esc(fmtShort(x.data)) + ' · ' + esc(x.evento || '') + ' · rimborsata il ' + esc(fmtShort(x.rimborsatoIl)) + '</small></span><span class="rba">' + esc(fmtEur(x.importo)) + '</span>' +
      '<button type="button" class="btn sm" data-act="rbUndo" data-id="' + esc(x.id) + '" data-confirm="Annullo il rimborso? Tocca di nuovo">Annulla</button></div></li>').join('') + '</ul>';
  }
  return h + '<div class="sheetfoot"><button type="button" class="btn" data-act="closeSheet">Chiudi</button></div>';
}
function rbRender() { const b = $('#rbbody'); if (b) b.innerHTML = rimbHtml(); }
ACT.rimbOpen = el => {
  const id = el.dataset.id;
  S.rb = { techId: id, sel: {}, date: S.oggi };
  S.spe.forEach(x => { if (x.technician_id === id && x.pagatoDa === 'tecnico' && !x.rimborsatoIl) S.rb.sel[x.id] = true; });
  openSheet('Rimborsi', '<div id="rbbody"></div>', { noFocus: true });
  S.onClose = () => { S.rb = null; paint(); };
  rbRender();
};
CHG.rbTick = el => { S.rb.sel[el.dataset.id] = el.checked; const d = $('#rbdate'); if (d) S.rb.date = d.value || S.rb.date; rbRender(); };
ACT.rbPay = async () => {
  const ids = rimbData().open.filter(x => S.rb.sel[x.id]).map(x => x.id);
  const d = $('#rbdate'), day = d && d.value ? d.value : S.oggi;
  if (!ids.length) return;
  const err = $('#sheet .ferr');
  const r = await mutate(async () => {
    const res = await call('api_expReimburse', S.pin, ids, true, day);
    (res.spese || []).forEach(x => upsert(S.spe, x));
    derive();
    toast(plural(ids.length, 'spesa segnata', 'spese segnate') + ' come rimborsate.', 'ok');
  }, true);
  if (r.ok) rbRender(); else if (err) err.textContent = r.err;
};
ACT.rbUndo = el => {
  mutate(async () => {
    const res = await call('api_expReimburse', S.pin, [el.dataset.id], false, '');
    (res.spese || []).forEach(x => upsert(S.spe, x));
    S.rb.sel[el.dataset.id] = true;
    derive();
    toast('Rimborso annullato: la spesa è di nuovo da rimborsare.');
  }).then(() => rbRender());
};

/* =====================================================================
   TECNICO (?t=...) e CONFERMA RAPIDA (?c=...)
   ===================================================================== */
const T = { nome: '', ruoli: [], oggi: '', mie: [], recenti: [], annullati: [], disp: {}, conf: {}, days: 30, saving: {}, q: {}, open: {}, tariffa: 0 };
/* Come si chiama la risposta del tecnico nella sua pagina (diversa dalla fase dell'evento, che è del cliente) */
const ASG_TECH = { 'in attesa': 'Da rispondere', confermato: 'Ci sei', rifiutato: 'Non puoi' };
const C = { data: null };

function linkErrorView(msg) {
  return '<div class="wrap narrow"><div class="pageerr" role="alert"><h2>Link non valido</h2><p>' + esc(msg) + '</p>' +
    '<p class="hint">Chiedi al coordinatore di rimandarti il tuo link.</p></div></div>';
}
function mastSimple(title, sub, withRefresh) {
  return '<header class="mast"><div class="wrap narrow mastin"><div class="brand">' + esc(title) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>' +
    (withRefresh ? '<div class="mastact"><button class="ib" data-act="techRefresh" aria-label="Aggiorna">' + ico('refresh') + '</button></div>' : '') +
    '</div></header><div class="hazard"></div>';
}

/* Fase dell'evento, in parole semplici: preventivo, confermato, annullato... con l'ultimo aggiornamento e la nota del coordinatore */
function stageBanner(e) {
  const i = stageInfo(e), when = fmtStamp(e.statoAggiornato);
  return '<div class="stage st-' + esc(e.stato) + '" role="note"><b class="stl">' + esc(i.label) + '</b>' +
    (i.text ? '<span class="stt">' + esc(i.text) + '</span>' : '') +
    (e.statoNota ? '<span class="stnote">Dal coordinatore: «' + esc(e.statoNota) + '»</span>' : '') +
    (when ? '<small>Aggiornato il ' + esc(when) + '</small>' : '') + '</div>';
}

/* Cosa si monta: il materiale dell'evento, con in cima il reparto del tecnico (un fonico cerca l'audio, chi fa luci le luci) */
function matBlock(e, lines, roles, defOpen) {
  if (!lines.length) return '<p class="nomat">Il materiale non è ancora stato inserito: quando c\\'è lo trovi qui.</p>';
  const mine = ['generale'];
  roles.forEach(r => (ROLE_CATS[r] || []).forEach(c => { if (mine.indexOf(c) < 0) mine.push(c); }));
  const g = {};
  lines.forEach(l => { const k = catKey(l.categoria) || 'altro'; (g[k] = g[k] || []).push(l); });
  const keys = Object.keys(g).sort((a, b) => {
    const ma = mine.indexOf(a) >= 0 ? 0 : 1, mb = mine.indexOf(b) >= 0 ? 0 : 1;
    return ma - mb || cmpCat(a, b);
  });
  const some = keys.some(k => mine.indexOf(k) >= 0), others = keys.some(k => mine.indexOf(k) < 0);
  const pieces = lines.reduce((n, l) => n + (Number(l.quantita) || 0), 0);
  const open = e.id in T.open ? T.open[e.id] : !!defOpen;
  let h = '<details class="mat" data-mat="' + esc(e.id) + '"' + (open ? ' open' : '') + '><summary><span class="mt">Cosa si monta</span>' +
    '<span class="mc">' + lines.length + (lines.length === 1 ? ' voce' : ' voci') + ', ' + pieces + (pieces === 1 ? ' pezzo' : ' pezzi') + '</span></summary><div class="mbody">';
  if (STAGES_PROVVISORIE.indexOf(e.stato) >= 0) h += '<p class="hint" style="margin-top:0">Elenco provvisorio: può cambiare finché il cliente non conferma.</p>';
  keys.forEach(k => {
    const isMine = mine.indexOf(k) >= 0;
    h += '<h4 class="mcat' + (isMine && others && some ? ' mine' : '') + '">' + esc(catLabel(k)) +
      (isMine && others && some && k !== 'generale' ? '<small>il tuo reparto</small>' : '') + '</h4><ul class="ml">' +
      g[k].slice().sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'it', { sensitivity: 'base' })).map(l => {
        const q = Number(l.quantita) || 0, sub = Math.min(q, Number(l.subnoleggio) || 0);
        return '<li><span class="lq">' + q + '</span><span class="ln">' + esc(l.nome) +
          (l.note ? '<small>' + esc(l.note) + '</small>' : '') + '</span>' +
          (sub ? '<span class="pill blue">' + (sub >= q ? 'tutto a noleggio' : sub + ' a noleggio') + '</span>' : '') + '</li>';
      }).join('') + '</ul>';
  });
  return h + '</div></details>';
}
document.addEventListener('toggle', ev => {   // "toggle" non risale: lo ascolto in fase di cattura
  const d = ev.target;
  if (d && d.matches && d.matches('details[data-mat]')) T.open[d.getAttribute('data-mat')] = d.open;
}, true);

/* Furgoni dell'evento: quale, quale targa, chi guida (e se guidi tu) */
function vansBlock(vans) {
  if (!vans || !vans.length) return '';
  return '<div class="tvans" aria-label="Furgoni">' + vans.map(v => '<div class="tvan' + (v.tuo ? ' mine' : '') + '">' + ico('truck') +
    '<span><b>' + esc(v.nome) + '</b>' + (v.targa ? ' <small>' + esc(v.targa) + '</small>' : '') +
    '<small class="who">' + (v.tuo ? 'Guidi tu' : v.autista ? 'Guida ' + esc(v.autista) : 'Autista da decidere') + '</small></span></div>').join('') + '</div>';
}
/* Gli altri eventi dello stesso giorno in cui è convocato: se si pestano i piedi lo dice */
function sameDayHtml(m) {
  const e = m.evento;
  const others = T.mie.filter(o => o !== m && o.evento.data === e.data && o.assegnazione.stato !== 'rifiutato');
  return others.map(o => {
    const g = gapLevel(e, o.evento);
    return '<p class="note ' + (g ? (g.level === 'bad' ? 'bad' : 'warn') : 'muted') + '">Lo stesso giorno hai anche «' + esc(o.evento.cliente) + '» (' +
      esc(rangeTxt(evWin(o.evento))) + ')' + (g ? ': ' + esc(g.why) : '') + '.</p>';
  }).join('');
}
function techExpBlock(m) {
  const list = (m.spese || []).slice().sort((a, b) => String(a.data).localeCompare(String(b.data)));
  let h = '<div class="texp"><h4 class="mcat">Le mie spese</h4>';
  if (!list.length) {
    h += '<p class="nomat" style="margin-top:4px">Hai anticipato carburante, pedaggi o pasti? Segnali qui: te li rimborsano.</p>';
  } else {
    h += '<ul class="exps">' + list.map(x => '<li><button type="button" class="exr" data-act="expEdit" data-ev="' + esc(m.evento.id) + '" data-id="' + esc(x.id) + '">' +
      '<span class="exm"><b>' + esc(expLabel(x.categoria)) + (x.descrizione ? '<span class="exd"> · ' + esc(x.descrizione) + '</span>' : '') + '</b>' +
      '<small>' + esc(fmtShort(x.data)) + (toN(x.km) ? ' · ' + esc(fmtNum(x.km, 1)) + ' km' : '') + '</small><span class="exp">' + expPill(x) + '</span></span>' +
      '<span class="exa">' + esc(fmtEur(x.importo)) + '</span></button></li>').join('') + '</ul>';
    const due = list.filter(x => x.pagatoDa === 'tecnico' && !x.rimborsatoIl).reduce((s, x) => s + toN(x.importo), 0);
    if (due) h += '<p class="extot"><span>Da rimborsare <b>' + esc(fmtEur(due)) + '</b></span></p>';
  }
  return h + '<div class="row" style="margin-top:8px"><button type="button" class="btn" data-act="expAdd" data-ev="' + esc(m.evento.id) + '">' + ico('plus') + ' Aggiungi spesa</button></div></div>';
}
/* Liste e spese compaiono quando servono: nei giorni intorno all'evento, o se c'è già qualcosa */
function techNeeds(m) {
  const diff = dayNum(m.evento.data) - dayNum(T.oggi), lines = m.materiale || [];
  const started = !!(m.liste && (m.liste.caricoQuando || m.liste.scaricoQuando)) || lines.some(l => toI(l.caricato) > 0);
  return {
    lists: lines.length > 0 && (diff <= 3 || started),
    exp: diff <= 1 || (m.spese || []).length > 0,
  };
}
function techListsBlock(m) {
  const lines = m.materiale || [];
  return '<div class="lbtns">' + listBtnHtml(m.evento, m.liste || {}, lines, 'carico') + listBtnHtml(m.evento, m.liste || {}, lines, 'scarico') + '</div>';
}

/* scheda di una convocazione, uguale nella pagina personale e nella conferma rapida.
   m (facoltativo): la convocazione completa, per furgoni, liste e spese (solo nella pagina personale) */
function convBody(e, a, lines, defOpen, m) {
  const roles = uniq(rolesOf(a.ruoli));
  const cancelled = e.stato === 'annullato';
  let h = '<div class="row"><span class="when">' + esc(fmtLong(e.data)) + '</span>' +
    (cancelled ? '' : '<span class="pill ' + (ASG_PILL[a.stato] || 'muted') + '" style="margin-left:auto">' + esc(ASG_TECH[a.stato] || a.stato) + '</span>') + '</div>' +
    '<h3>' + esc(e.cliente) + '</h3>' + stageBanner(e) +
    '<div class="row" style="margin-top:10px"><span class="muted">' + (cancelled ? 'Eri convocato come' : 'Ruolo') + '</span>' +
    roles.map(r => '<span class="chip r-' + r + '">' + r + '</span>').join('') + '</div>';
  if (cancelled) return h;
  h += timesHtml(e);
  const facts = [];
  if (e.luogo) facts.push('<div><span class="k">Luogo: </span>' + esc(e.luogo) + '</div>');
  if (e.noteTecnici) facts.push('<div><span class="k">Note: </span>' + esc(e.noteTecnici) + '</div>');
  if (facts.length) h += '<div class="facts">' + facts.join('') + '</div>';
  h += matBlock(e, lines || [], roles, defOpen);
  if (m) {
    h += sameDayHtml(m) + vansBlock(m.furgoni);
    if (a.stato !== 'rifiutato') {
      const need = techNeeds(m);
      if (need.lists) h += techListsBlock(m);
      if (need.exp) h += techExpBlock(m);
    }
  }
  return h;
}
function respondButtons(a, act, tokenAttr) {
  const t = tokenAttr;
  if (a.stato === 'confermato') {
    return '<p style="margin-top:12px"><b>Hai confermato.</b> Se non puoi più venire, dillo qui sotto.</p>' +
      '<div class="btns"><button type="button" class="btn no" data-act="' + act + '" data-token="' + esc(t) + '" data-v="rifiutato" data-confirm="Sicuro? Tocca di nuovo">Non posso più</button></div>';
  }
  if (a.stato === 'rifiutato') {
    return '<p style="margin-top:12px"><b>Hai detto che non puoi.</b> Se hai cambiato idea, puoi ancora accettare.</p>' +
      '<div class="btns"><button type="button" class="btn go" data-act="' + act + '" data-token="' + esc(t) + '" data-v="confermato">Ora posso</button></div>';
  }
  return '<div class="btns"><button type="button" class="btn go big" data-act="' + act + '" data-token="' + esc(t) + '" data-v="confermato">Confermo</button>' +
    '<button type="button" class="btn no big" data-act="' + act + '" data-token="' + esc(t) + '" data-v="rifiutato">Non posso</button></div>';
}
function cardCls(st) { return st === 'confermato' ? 'confermato' : st === 'rifiutato' ? 'rifiutato' : 'pendente'; }

/* ---------- pagina personale ---------- */
function techView() {
  let h = mastSimple('Pagina personale', '', true) + '<main class="wrap narrow main">';
  h += '<h1 class="hello">Ciao ' + esc(firstName(T.nome)) + '</h1>';
  h += '<div class="row" style="margin-top:10px">' + T.ruoli.map(r => '<span class="chip r-' + r + '">' + r + '</span>').join('') + '</div>';
  if (T.annullati.length) {
    h += '<section class="sec"><h2>Annullati</h2>';
    T.annullati.forEach(x => {
      h += '<article class="card annullato" id="ann-' + esc(x.evento.id) + '">' + convBody(x.evento, { ruoli: x.ruoli, stato: '' }) + '</article>';
    });
    h += '</section>';
  }
  h += '<section class="sec"><h2>Convocazioni</h2>';
  if (!T.mie.length) h += '<p class="empty">Nessuna convocazione per ora. Quando ti chiamano per un evento lo trovi qui.</p>';
  T.mie.forEach(m => {
    h += '<article class="card ' + cardCls(m.assegnazione.stato) + '" id="conv-' + esc(m.assegnazione.id) + '">' +
      convBody(m.evento, m.assegnazione, m.materiale, false, m) + respondButtons(m.assegnazione, 'respond', m.assegnazione.token) + '</article>';
  });
  if (T.recenti.length) {
    h += '</section><section class="sec"><h2>Eventi appena passati</h2>';
    T.recenti.forEach(m => { h += recentCard(m); });
  }
  h += '</section><section class="sec"><h2>Quando sei libero</h2>' +
    '<p class="hint" style="margin:10px 0 4px">Tocca <b>Sì</b> o <b>No</b> per ogni giorno, anche se non c\\'è ancora nessun evento: il coordinatore vede subito chi c\\'è. ' +
    'Se sei libero solo da una certa ora, scrivila. Per cancellare una risposta tocca di nuovo lo stesso pulsante.</p>' + availRows();
  if (T.days < 180) h += '<div style="margin-top:16px"><button type="button" class="btn" data-act="moreDays">Mostra altri 30 giorni</button></div>';
  h += '</section><p class="foot">Suggerimento: dal menu del browser scegli «Aggiungi a schermata Home», così la apri con un tocco.</p></main>';
  return h;
}
/* Un evento già passato dove c'è ancora da fare qualcosa: scarico del furgone, spese da segnalare */
function recentCard(m) {
  const e = m.evento, lines = m.materiale || [];
  return '<article class="card recente" id="rec-' + esc(m.assegnazione.id) + '"><div class="row"><span class="when">' + esc(fmtLong(e.data)) + '</span>' +
    (m.liste && m.liste.scaricoQuando ? '<span class="pill ok" style="margin-left:auto">Scarico chiuso</span>' : '') + '</div>' +
    '<h3>' + esc(e.cliente) + '</h3>' + vansBlock(m.furgoni) +
    (lines.length ? techListsBlock(m) : '') + techExpBlock(m) + '</article>';
}
function availRows() {
  const byDate = {};
  T.mie.forEach(m => { (byDate[m.evento.data] = byDate[m.evento.data] || []).push(m); });
  let h = '', lastMonth = -1;
  for (let i = 0; i < T.days; i++) {
    const d = addDays(T.oggi, i), p = parseYMD(d), w = wday(d);
    if (p.m !== lastMonth) { h += '<div class="monthsep">' + MESI[p.m - 1] + '</div>'; lastMonth = p.m; }
    const x = T.disp[d];
    const yes = !!(x && x.on), no = !!(x && !x.on);
    const conv = (byDate[d] || []).filter(m => m.assegnazione.stato !== 'rifiutato');
    h += '<div class="drow' + (w === 0 || w === 6 ? ' we' : '') + (T.saving[d] ? ' saving' : '') + '" id="d-' + d + '">' +
      '<div class="dc"><b>' + p.d + '</b><span>' + GIORNI_B[w] + '</span></div>' +
      '<div class="tgs"><button type="button" class="tg yes' + (yes ? ' on' : '') + '" data-act="av" data-d="' + d + '" data-v="1" aria-pressed="' + yes + '" aria-label="Libero, ' + esc(fmtShort(d)) + '">' + (yes ? ico('check') : '') + 'Sì</button>' +
      '<button type="button" class="tg no' + (no ? ' on' : '') + '" data-act="av" data-d="' + d + '" data-v="0" aria-pressed="' + no + '" aria-label="Non disponibile, ' + esc(fmtShort(d)) + '">' + (no ? ico('x') : '') + 'No</button></div>';
    if (yes || conv.length) {
      h += '<div class="more">';
      if (yes) h += '<label>Libero dalle <input type="time" data-chg="avFrom" data-d="' + d + '" value="' + esc(inputT(x.from)) + '" aria-label="Libero dalle ore, ' + esc(fmtShort(d)) + '"></label>';
      conv.forEach(m => { h += '<span class="conv">Convocato: ' + esc(m.evento.cliente) + '</span>'; });
      h += '</div>';
    }
    h += '</div>';
  }
  return h;
}

/* Salva la risposta di un giorno. Le chiamate dello stesso giorno vanno in fila, così l'ordine è quello dei tocchi. */
function saveDay(d, value, from) {
  T.saving[d] = (T.saving[d] || 0) + 1;
  const prev = T.q[d] || Promise.resolve();
  T.q[d] = prev.then(() => call('api_techSetAvailability', S.token, d, value, from || ''))
    .then(() => {
      if (value === null) delete T.conf[d]; else T.conf[d] = { on: value, from: from || '' };
    })
    .catch(e => {
      if (T.conf[d]) T.disp[d] = { on: T.conf[d].on, from: T.conf[d].from }; else delete T.disp[d];
      toast(e.message, 'err');
    })
    .then(() => { T.saving[d] -= 1; if (!T.saving[d]) delete T.saving[d]; paint(); });
}
ACT.av = el => {
  const d = el.dataset.d, want = el.dataset.v === '1';
  const prev = T.disp[d];
  const next = (prev && prev.on === want) ? null : want;
  if (next === null) delete T.disp[d]; else T.disp[d] = { on: next, from: '' };
  saveDay(d, next, '');
  paint();
};
CHG.avFrom = el => {
  const d = el.dataset.d, x = T.disp[d];
  if (!x || !x.on) return;
  x.from = inputT(el.value);
  saveDay(d, true, x.from);
  paint();
};
ACT.moreDays = () => { T.days = Math.min(180, T.days + 30); paint(); };
ACT.respond = el => {
  const tok = el.dataset.token, v = el.dataset.v;
  mutate(async () => {
    await call('api_respond', tok, v);
    const m = T.mie.find(x => x.assegnazione.token === tok);
    if (m) m.assegnazione.stato = v;
    paint();
    toast(v === 'confermato' ? 'Confermato, grazie!' : 'Ricevuto: ho segnato che non puoi.', 'ok');
  });
};
ACT.techRefresh = async () => {
  try { await techLoad(); toast('Aggiornato.', 'ok'); } catch (e) { toast(e.message, 'err'); }
};
async function techLoad() {
  const d = await call('api_techInit', S.token);
  T.nome = d.tecnico.nome; T.ruoli = uniq(rolesOf(d.tecnico.ruoli)); T.oggi = d.oggi; T.mie = d.mie; T.annullati = d.annullati || [];
  T.recenti = d.recenti || []; T.tariffa = toN(d.tariffa_km);
  S.cfg = { durata_evento_ore: d.durata_evento_ore || 4 };
  T.disp = {}; T.conf = {};
  d.disponibilita.forEach(x => {
    T.disp[x.data] = { on: isTrue(x.disponibile), from: String(x.oraDa || '') };
    T.conf[x.data] = { on: T.disp[x.data].on, from: T.disp[x.data].from };
  });
  paint();
}
async function techBoot() {
  S.view = techView;
  paint(loadingView());
  try { await techLoad(); } catch (e) { paint(linkErrorView(e.message)); }
}

/* ---------- conferma rapida ---------- */
function confirmView() {
  const d = C.data, e = d.evento, cancelled = e.stato === 'annullato';
  return mastSimple('Convocazione', '', false) + '<main class="wrap narrow main"><h1 class="hello">Ciao ' + esc(firstName(d.nome)) + '</h1>' +
    '<article class="card ' + (cancelled ? 'annullato' : cardCls(d.stato)) + '">' + convBody(e, { ruoli: d.ruoli, stato: d.stato }, d.materiale || [], true) +
    (cancelled ? '' : vansBlock(d.furgoni) + respondButtons({ stato: d.stato }, 'cRespond', S.token)) + '</article></main>';
}
ACT.cRespond = el => {
  const v = el.dataset.v;
  mutate(async () => {
    await call('api_respond', S.token, v);
    C.data.stato = v;
    paint();
    toast(v === 'confermato' ? 'Confermato, grazie!' : 'Ricevuto: ho segnato che non puoi.', 'ok');
  });
};
async function confirmBoot() {
  S.view = confirmView;
  paint(loadingView());
  try { C.data = await call('api_confirmInit', S.token); paint(); } catch (e) { paint(linkErrorView(e.message)); }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.mode === 'tech' && T.oggi && !Object.keys(T.saving).length && !S.sheet && !S.locked && !LQ.running && !LQ.items.length) {
    techLoad().catch(() => { /* resta la vista di prima */ });
  }
});

if (S.mode === 'tech') techBoot();
else if (S.mode === 'confirm') confirmBoot();
else coordBoot();
</script>
</body>
</html>
`;
