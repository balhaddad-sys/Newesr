/**
 * MEDWARD PRO - MULTI-USER AUTH & DATA SYSTEM v6.0.0
 * Features: Login, Registration, Auto-Folder Creation, Trash Management, Clinical AI
 */

var DEBUG = false;
var SYSTEM_FOLDER_NAME = "MedWard_System_v1";

var UNIFIED_CONFIG = {
  VERSION: '6.0.0',
  MEDWARD_VERSION: '3.2',
  ONCALL_VERSION: '1.4',
  CLAUDE: { MODEL: 'claude-haiku-4-5-20251001', MAX_TOKENS: 4000, TEMPERATURE: 0.3 },
  CACHE_TTL: 21600
};

var SYSTEM_PROMPTS = {
  MEDWARD_CLINICAL: 'You are an expert internal medicine consultant providing evidence-based clinical decision support.\n\nYour responses should be:\n- Concise and actionable\n- Based on current clinical guidelines\n- Include safety considerations and red flags\n\nIMPORTANT: Always include a brief disclaimer that this is for educational purposes.',
  ONCALL_CLINICAL: 'You are an expert Internal Medicine consultant for physicians on-call in Kuwait.\n\nUse KUWAIT SI UNITS:\n- Electrolytes: mmol/L (K+ 3.5-5.0, Na+ 136-145)\n- Hemoglobin: g/L (M: 130-175, F: 120-160)\n- Creatinine: umol/L (M: 62-106, F: 44-80)\n\nBe CONCISE and ACTIONABLE. Flag RED FLAGS prominently.',
  DIFFERENTIAL: 'Generate a differential diagnosis.\n\nFORMAT:\n1. Most Likely: Top 2-3 diagnoses\n2. Must Not Miss: Life-threatening conditions\n3. Recommended Workup: Key tests',
  TREATMENT: 'Create a treatment plan.\n\nFORMAT:\n1. Immediate Actions (first 1-2 hours)\n2. Ongoing Management\n3. Monitoring\n4. Consultations Needed',
  DRUG_INTERACTION: 'Check drug interactions. For each:\n1. Severity: Major/Moderate/Minor\n2. Mechanism\n3. Recommendation\n\nFlag QT prolongation risks.',
  ELECTROLYTE: 'Verify electrolyte replacement.\nKuwait SI ranges: K+ 3.5-5.0, Na+ 136-145, Mg 0.7-1.0, Ca 2.1-2.6 mmol/L',
  VENTILATOR: 'Verify ventilator settings.\nARDSNet goals: TV 6-8 mL/kg PBW, Pplat <=30 cmH2O, SpO2 88-95%',
  LAB_ANALYSIS: 'Analyze this lab report image and extract all values.\n\nOUTPUT JSON ONLY:\n{"confidence": 0.9, "labData": {"dates": [], "parameters": [{"name": "", "unit": "", "values": [{"date": "", "value": 0, "status": "normal"}]}]}}',
  MEDICATION_IDENTIFY: 'Identify medications from this image.\n\nReturn JSON:\n{"imageType": "single_drug|medication_list|prescription", "medications": [{"drugName": "", "strength": "", "frequency": ""}], "confidence": 0.9}',
  DOCUMENT_ANALYZE: 'Analyze this clinical document.\n\nReturn JSON:\n{"documentType": "", "patientInfo": {}, "medications": [], "findings": {}, "confidence": 0.9}'
};

var REFERENCE_RANGES = {
  potassium: { min: 3.5, max: 5.0, unit: 'mmol/L', critical_low: 2.5, critical_high: 6.0 },
  sodium: { min: 136, max: 145, unit: 'mmol/L', critical_low: 120, critical_high: 160 },
  magnesium: { min: 0.7, max: 1.0, unit: 'mmol/L' },
  calcium: { min: 2.1, max: 2.6, unit: 'mmol/L' },
  glucose: { min: 3.9, max: 5.6, unit: 'mmol/L', critical_low: 2.8, critical_high: 33.3 },
  hemoglobin_male: { min: 130, max: 175, unit: 'g/L' },
  hemoglobin_female: { min: 120, max: 160, unit: 'g/L' }
};

var CLINICAL_PROTOCOLS = {
  hypokalemia: {
    mild: { range: '3.0-3.5 mmol/L', treatment: '40 mEq KCl PO', recheck: 'AM labs' },
    moderate: { range: '2.5-3.0 mmol/L', treatment: '40 mEq KCl PO/IV q2-4h', recheck: '4 hours' },
    severe: { range: '<2.5 mmol/L', treatment: '40 mEq/hr IV central, cardiac monitor', recheck: '2 hours' }
  },
  hyperkalemia: {
    mild: { range: '5.0-5.5 mmol/L', treatment: 'Hold K+, review meds', recheck: '4-6 hours' },
    moderate: { range: '5.5-6.0 mmol/L', treatment: 'Kayexalate, loop diuretic', recheck: '2-4 hours' },
    severe: { range: '>6.0 mmol/L', treatment: 'Ca gluconate, insulin+D50, dialysis PRN', recheck: '1-2 hours' }
  }
};

var cachedApiKey_ = null;
function getApiKey_() {
  if (cachedApiKey_ === null) cachedApiKey_ = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  return cachedApiKey_;
}
function log_(msg) { if (DEBUG) Logger.log(msg); }

// FILE SYSTEM HELPERS
function getSystemFolder() {
  var folders = DriveApp.getFoldersByName(SYSTEM_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(SYSTEM_FOLDER_NAME);
}

function getRegistry() {
  var folder = getSystemFolder();
  var files = folder.getFilesByName("registry.json");
  if (files.hasNext()) return JSON.parse(files.next().getBlob().getDataAsString());
  return {};
}

function saveRegistry(data) {
  var folder = getSystemFolder();
  var files = folder.getFilesByName("registry.json");
  if (files.hasNext()) files.next().setContent(JSON.stringify(data));
  else folder.createFile("registry.json", JSON.stringify(data));
}

// AUTHENTICATION
function registerUser(u, p) {
  if (!u || !p) return { success: false, error: "Username and password required" };
  if (u.length < 3) return { success: false, error: "Username must be at least 3 characters" };
  if (p.length < 4) return { success: false, error: "Password must be at least 4 characters" };
  
  var reg = getRegistry();
  if (reg[u]) return { success: false, error: "Username already exists" };

  var sysFolder = getSystemFolder();
  var userFolder = sysFolder.createFolder("User_" + u);
  
  var initialData = {
    patients: [],
    units: [{ id: 'unit_1', name: 'Ward 14', code: '1414', icon: '🏥' }, { id: 'unit_2', name: 'ICU', code: '9999', icon: '🚨' }],
    settings: { adminPassword: 'admin123' },
    unitRequests: []
  };
  
  userFolder.createFile("active_data.json", JSON.stringify(initialData));
  userFolder.createFile("trash_data.json", JSON.stringify([]));

  reg[u] = { pass: p, folderId: userFolder.getId(), createdAt: new Date().toISOString() };
  saveRegistry(reg);
  return { success: true, msg: "Account Created Successfully" };
}

function loginUser(u, p) {
  if (!u || !p) return { success: false, error: "Username and password required" };
  var reg = getRegistry();
  if (!reg[u] || reg[u].pass !== p) return { success: false, error: "Invalid username or password" };
  
  try {
    var folder = DriveApp.getFolderById(reg[u].folderId);
    var activeFile = folder.getFilesByName("active_data.json").next();
    var data = JSON.parse(activeFile.getBlob().getDataAsString());
    return { success: true, data: data, username: u };
  } catch (e) {
    return { success: false, error: "Failed to load user data" };
  }
}

function verifyAuth(u, p) {
  var reg = getRegistry();
  return reg[u] && reg[u].pass === p;
}

function getUserFolder(u, p) {
  if (!verifyAuth(u, p)) return null;
  var reg = getRegistry();
  return DriveApp.getFolderById(reg[u].folderId);
}

// DATA MANAGEMENT
function saveUserData(u, p, data) {
  if (!verifyAuth(u, p)) return { success: false, error: "Authentication failed" };
  try {
    var folder = getUserFolder(u, p);
    var files = folder.getFilesByName("active_data.json");
    if (files.hasNext()) files.next().setContent(JSON.stringify(data));
    else folder.createFile("active_data.json", JSON.stringify(data));
    return { success: true, timestamp: new Date().toISOString() };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function loadUserData(u, p) {
  if (!verifyAuth(u, p)) return { success: false, error: "Authentication failed" };
  try {
    var folder = getUserFolder(u, p);
    var files = folder.getFilesByName("active_data.json");
    if (files.hasNext()) return { success: true, data: JSON.parse(files.next().getBlob().getDataAsString()) };
    return { success: false, error: "No data found" };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// TRASH MANAGEMENT
function moveToTrash(u, p, idsToDelete) {
  if (!verifyAuth(u, p)) return { success: false, error: "Authentication failed" };
  if (!idsToDelete || !idsToDelete.length) return { success: false, error: "No items to delete" };
  
  try {
    var folder = getUserFolder(u, p);
    var activeFile = folder.getFilesByName("active_data.json").next();
    var trashFile = folder.getFilesByName("trash_data.json").next();
    var activeData = JSON.parse(activeFile.getBlob().getDataAsString());
    var trashData = JSON.parse(trashFile.getBlob().getDataAsString());
    
    var itemsToTrash = activeData.patients.filter(function(pt) { return idsToDelete.indexOf(pt.id) !== -1; });
    var remainingItems = activeData.patients.filter(function(pt) { return idsToDelete.indexOf(pt.id) === -1; });
    
    itemsToTrash.forEach(function(item) {
      item.deletedAt = new Date().toISOString();
      item.deletedBy = u;
      trashData.push(item);
    });
    
    activeData.patients = remainingItems;
    activeFile.setContent(JSON.stringify(activeData));
    trashFile.setContent(JSON.stringify(trashData));
    return { success: true, movedCount: itemsToTrash.length };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function getTrash(u, p) {
  if (!verifyAuth(u, p)) return { success: false, error: "Authentication failed" };
  try {
    var folder = getUserFolder(u, p);
    var trashFile = folder.getFilesByName("trash_data.json").next();
    return { success: true, trash: JSON.parse(trashFile.getBlob().getDataAsString()) };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function restoreFromTrash(u, p, idsToRestore) {
  if (!verifyAuth(u, p)) return { success: false, error: "Authentication failed" };
  if (!idsToRestore || !idsToRestore.length) return { success: false, error: "No items to restore" };
  
  try {
    var folder = getUserFolder(u, p);
    var activeFile = folder.getFilesByName("active_data.json").next();
    var trashFile = folder.getFilesByName("trash_data.json").next();
    var activeData = JSON.parse(activeFile.getBlob().getDataAsString());
    var trashData = JSON.parse(trashFile.getBlob().getDataAsString());
    
    var itemsToRestore = trashData.filter(function(pt) { return idsToRestore.indexOf(pt.id) !== -1; });
    var remainingTrash = trashData.filter(function(pt) { return idsToRestore.indexOf(pt.id) === -1; });
    
    itemsToRestore.forEach(function(item) {
      delete item.deletedAt;
      delete item.deletedBy;
      activeData.patients.push(item);
    });
    
    activeFile.setContent(JSON.stringify(activeData));
    trashFile.setContent(JSON.stringify(remainingTrash));
    return { success: true, restoredCount: itemsToRestore.length };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function emptyTrash(u, p) {
  if (!verifyAuth(u, p)) return { success: false, error: "Authentication failed" };
  try {
    var folder = getUserFolder(u, p);
    var trashFile = folder.getFilesByName("trash_data.json").next();
    var trashData = JSON.parse(trashFile.getBlob().getDataAsString());
    var deletedCount = trashData.length;
    trashFile.setContent(JSON.stringify([]));
    return { success: true, deletedCount: deletedCount };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// MAIN REQUEST HANDLERS
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    service: 'MedWard Pro - Multi-User Backend API',
    version: UNIFIED_CONFIG.VERSION,
    status: 'active',
    timestamp: new Date().toISOString(),
    features: ['authentication', 'data-isolation', 'trash-management', 'clinical-ai']
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(10000);
  
  try {
    var request = JSON.parse(e.postData.contents);
    var action = request.action;
    var result;
    
    switch (action) {
      case 'register': result = registerUser(request.username, request.password); break;
      case 'login': result = loginUser(request.username, request.password); break;
      case 'ping': result = { success: true, service: 'MedWard Pro', version: UNIFIED_CONFIG.VERSION, timestamp: new Date().toISOString() }; break;
      case 'saveData': result = saveUserData(request.username, request.password, request.payload); break;
      case 'loadData': result = loadUserData(request.username, request.password); break;
      case 'moveToTrash': result = moveToTrash(request.username, request.password, request.itemIds); break;
      case 'getTrash': result = getTrash(request.username, request.password); break;
      case 'restoreTrash': result = restoreFromTrash(request.username, request.password, request.itemIds); break;
      case 'emptyTrash': result = emptyTrash(request.username, request.password); break;
      case 'analyzeLabsEnhanced':
      case 'analyzeLabs': result = medward_analyzeLabsWithClaude(request); break;
      case 'getDrugInfo': result = medward_getDrugInfo(request); break;
      case 'identifyMedication': result = medward_identifyMedication(request); break;
      case 'analyzeDocument':
      case 'analyzeClinicalDocument': result = medward_analyzeDocument(request); break;
      case 'askClinical': result = medward_askClinical(request); break;
      case 'oncallAskClinical': result = oncall_askClinical(request); break;
      case 'oncallDifferential': result = oncall_generateDifferential(request); break;
      case 'oncallTreatment': result = oncall_getTreatmentPlan(request); break;
      case 'oncallDrugInteraction': result = oncall_checkDrugInteractions(request); break;
      case 'oncallVerifyElectrolyte': result = oncall_verifyElectrolyteCorrection(request); break;
      case 'oncallVerifyVent': result = oncall_verifyVentilatorSettings(request); break;
      case 'oncallGetProtocol': result = oncall_getProtocol(request); break;
      case 'oncallGetReferenceRanges': result = oncall_getReferenceRanges(request); break;
      default: result = { success: false, error: 'Unknown action: ' + action };
    }
    
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: error.toString() })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// CLAUDE API HELPERS
function extractMediaType_(base64Image) {
  var mediaType = 'image/jpeg';
  var rawBase64 = base64Image;
  if (base64Image.indexOf('data:') === 0) {
    var mediaMatch = base64Image.match(/^data:([^;]+);base64,/);
    if (mediaMatch) { mediaType = mediaMatch[1]; rawBase64 = base64Image.split(',')[1]; }
  }
  return { mediaType: mediaType, data: rawBase64 };
}

function callClaude_(systemPrompt, userMessage, model) {
  var apiKey = getApiKey_();
  if (!apiKey) throw new Error('API key not configured');
  if (!userMessage || !userMessage.trim()) throw new Error('User message required');
  
  var payload = {
    model: model || UNIFIED_CONFIG.CLAUDE.MODEL,
    max_tokens: UNIFIED_CONFIG.CLAUDE.MAX_TOKENS,
    messages: [{ role: 'user', content: userMessage.trim() }]
  };
  if (systemPrompt && systemPrompt.trim()) payload.system = systemPrompt.trim();
  
  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey.trim(), 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  
  if (response.getResponseCode() !== 200) throw new Error('Claude API error');
  var result = JSON.parse(response.getContentText());
  return result.content[0].text;
}

function callClaudeWithImage_(base64Image, prompt) {
  var apiKey = getApiKey_();
  if (!apiKey) throw new Error('API key not configured');
  var media = extractMediaType_(base64Image);
  
  var payload = {
    model: UNIFIED_CONFIG.CLAUDE.MODEL,
    max_tokens: UNIFIED_CONFIG.CLAUDE.MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: media.mediaType, data: media.data } },
        { type: 'text', text: prompt }
      ]
    }]
  };
  
  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey.trim(), 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  
  if (response.getResponseCode() !== 200) throw new Error('Claude API error');
  return JSON.parse(response.getContentText()).content[0].text;
}

// MEDWARD FUNCTIONS
function medward_askClinical(request) {
  if (!request.question) return { success: false, error: 'No question provided' };
  try {
    var context = request.patientData ? '\n\nPatient Context: ' + request.patientData : '';
    return { success: true, answer: callClaude_(SYSTEM_PROMPTS.MEDWARD_CLINICAL, request.question + context), timestamp: new Date().toISOString() };
  } catch (e) { return { success: false, error: e.toString() }; }
}

function medward_getDrugInfo(request) {
  if (!request.drugName) return { success: false, error: 'No drug name provided' };
  var cache = CacheService.getScriptCache();
  var cacheKey = 'drug_' + request.drugName.toLowerCase().replace(/\s+/g, '_');
  var cached = cache.get(cacheKey);
  if (cached) { var r = JSON.parse(cached); r.cached = true; return r; }
  
  try {
    var prompt = 'Provide clinical info for: ' + request.drugName + '\n\nFormat as JSON: {"genericName":"","brandNames":[],"class":"","indications":[],"dosing":{"adult":"","renal":""},"contraindications":[],"sideEffects":{"common":[],"serious":[]},"interactions":[],"clinicalPearls":[]}';
    var response = callClaude_('You are a clinical pharmacist. Return JSON only.', prompt);
    var jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON');
    var result = { success: true, drugInfo: JSON.parse(jsonMatch[0]), timestamp: new Date().toISOString() };
    cache.put(cacheKey, JSON.stringify(result), UNIFIED_CONFIG.CACHE_TTL);
    return result;
  } catch (e) { return { success: false, error: e.toString() }; }
}

function medward_analyzeLabsWithClaude(request) {
  if (!request.image) return { success: false, error: 'No image provided' };
  try {
    var response = callClaudeWithImage_(request.image, SYSTEM_PROMPTS.LAB_ANALYSIS);
    var jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON');
    return { success: true, labData: JSON.parse(jsonMatch[0]), timestamp: new Date().toISOString() };
  } catch (e) { return { success: false, error: e.toString() }; }
}

function medward_identifyMedication(request) {
  if (!request.image) return { success: false, error: 'No image provided' };
  try {
    var response = callClaudeWithImage_(request.image, SYSTEM_PROMPTS.MEDICATION_IDENTIFY);
    var jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON');
    var data = JSON.parse(jsonMatch[0]);
    return { success: true, medications: data.medications || [], imageType: data.imageType || 'unknown', confidence: data.confidence || 0, timestamp: new Date().toISOString() };
  } catch (e) { return { success: false, error: e.toString() }; }
}

function medward_analyzeDocument(request) {
  if (!request.image) return { success: false, error: 'No image provided' };
  try {
    var response = callClaudeWithImage_(request.image, SYSTEM_PROMPTS.DOCUMENT_ANALYZE);
    var jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON');
    return { success: true, document: JSON.parse(jsonMatch[0]), timestamp: new Date().toISOString() };
  } catch (e) { return { success: false, error: e.toString() }; }
}

// ONCALL FUNCTIONS
function oncall_askClinical(request) {
  if (!request.question) return { success: false, error: 'No question provided' };
  try { return { success: true, answer: callClaude_(SYSTEM_PROMPTS.ONCALL_CLINICAL, request.question), timestamp: new Date().toISOString() }; }
  catch (e) { return { success: false, error: e.toString() }; }
}

function oncall_generateDifferential(request) {
  if (!request.presentation) return { success: false, error: 'No presentation provided' };
  try {
    var prompt = 'Presentation: ' + request.presentation;
    if (request.vitals) prompt += '\nVitals: ' + request.vitals;
    if (request.labs) prompt += '\nLabs: ' + request.labs;
    return { success: true, differential: callClaude_(SYSTEM_PROMPTS.DIFFERENTIAL, prompt), timestamp: new Date().toISOString() };
  } catch (e) { return { success: false, error: e.toString() }; }
}

function oncall_getTreatmentPlan(request) {
  if (!request.diagnosis) return { success: false, error: 'No diagnosis provided' };
  try {
    var prompt = 'Diagnosis: ' + request.diagnosis;
    if (request.severity) prompt += '\nSeverity: ' + request.severity;
    return { success: true, treatmentPlan: callClaude_(SYSTEM_PROMPTS.TREATMENT, prompt), timestamp: new Date().toISOString() };
  } catch (e) { return { success: false, error: e.toString() }; }
}

function oncall_checkDrugInteractions(request) {
  if (!request.medications || request.medications.length < 2) return { success: false, error: 'At least 2 medications required' };
  try { return { success: true, interactions: callClaude_(SYSTEM_PROMPTS.DRUG_INTERACTION, 'Medications:\n' + request.medications.join('\n')), timestamp: new Date().toISOString() }; }
  catch (e) { return { success: false, error: e.toString() }; }
}

function oncall_verifyElectrolyteCorrection(request) {
  if (!request.electrolyte || !request.currentValue) return { success: false, error: 'Electrolyte and value required' };
  try {
    var prompt = 'Electrolyte: ' + request.electrolyte + '\nValue: ' + request.currentValue + ' ' + (request.unit || 'mmol/L') + '\nProposed: ' + (request.proposedTreatment || 'Not specified');
    return { success: true, verification: callClaude_(SYSTEM_PROMPTS.ELECTROLYTE, prompt), timestamp: new Date().toISOString() };
  } catch (e) { return { success: false, error: e.toString() }; }
}

function oncall_verifyVentilatorSettings(request) {
  if (!request.height || !request.gender) return { success: false, error: 'Height and gender required' };
  try {
    var heightCm = parseFloat(request.height);
    var pbw = (request.gender.toLowerCase() === 'male') ? 50 + 0.91 * (heightCm - 152.4) : 45.5 + 0.91 * (heightCm - 152.4);
    pbw = Math.round(pbw * 10) / 10;
    var tvLow = Math.round(pbw * 6), tvHigh = Math.round(pbw * 8);
    var prompt = 'Patient: ' + request.gender + ', ' + heightCm + ' cm\nPBW: ' + pbw + ' kg\nRecommended TV: ' + tvLow + '-' + tvHigh + ' mL';
    return { success: true, verification: callClaude_(SYSTEM_PROMPTS.VENTILATOR, prompt), calculations: { pbw: pbw, tvRange: tvLow + '-' + tvHigh + ' mL' }, timestamp: new Date().toISOString() };
  } catch (e) { return { success: false, error: e.toString() }; }
}

function oncall_getProtocol(request) {
  if (!request.protocol) return { success: true, availableProtocols: Object.keys(CLINICAL_PROTOCOLS) };
  var key = request.protocol.toLowerCase();
  if (CLINICAL_PROTOCOLS[key]) return { success: true, protocol: CLINICAL_PROTOCOLS[key], name: request.protocol };
  return { success: false, error: 'Protocol not found' };
}

function oncall_getReferenceRanges(request) {
  if (request && request.parameter) {
    var key = request.parameter.toLowerCase().replace('+', '').replace(' ', '_');
    if (REFERENCE_RANGES[key]) return { success: true, parameter: request.parameter, range: REFERENCE_RANGES[key] };
    return { success: false, error: 'Parameter not found' };
  }
  return { success: true, ranges: REFERENCE_RANGES };
}

// TEST FUNCTIONS
function test_Setup() {
  var apiKey = getApiKey_();
  Logger.log('MULTI-USER BACKEND TEST - v' + UNIFIED_CONFIG.VERSION);
  Logger.log('API Key: ' + (apiKey ? 'Set' : 'NOT SET'));
}

function test_Registration() {
  Logger.log('Testing Registration...');
  Logger.log(JSON.stringify(registerUser('testuser', 'test1234')));
}

function test_Login() {
  Logger.log('Testing Login...');
  Logger.log(JSON.stringify(loginUser('testuser', 'test1234')));
}
