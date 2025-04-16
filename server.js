const express = require('express');
const axios = require('axios');
const cors = require('cors');
const http = require('http');
const https = require('https');

// Erzeuge eine Express-App
const app = express();

// 1) CORS mit erweiterten Optionen erlauben
app.use(cors({
  origin: '*', // Erlaubt alle Origins
  methods: ['GET', 'POST', 'OPTIONS'], // Explizit erlaubte Methoden
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Title'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// 2) JSON mit erhöhtem Limit parsen, z. B. 100MB
app.use(express.json({ limit: '100mb' }));

// 3) Server-Timeout konfigurieren
app.use((req, res, next) => {
  // 2 Minuten Timeout für Server-Antworten
  res.setTimeout(120000);
  next();
});

// 4) Verbesserte Request-Logging-Middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.url;
  const ip = req.headers['x-forwarded-for'] || req.ip;
  
  console.log(`[${timestamp}] ${method} ${url} - IP: ${ip}`);
  
  // Bei OPTIONS-Anfragen sofort antworten
  if (method === 'OPTIONS') {
    return res.status(204).end();
  }
  
  // Methoden-Überprüfung für alle API-Endpunkte
  if ((url.startsWith('/free') || 
       url.startsWith('/cash') || 
       url.startsWith('/nofilter') || 
       url.startsWith('/v1/chat/completions')) && 
      method !== 'POST') {
    console.log(`Methodenfehler: ${method} nicht erlaubt für ${url}`);
    return res.status(405).json({
      error: 'Method Not Allowed',
      message: `${url} erfordert die POST-Methode, erhielt aber ${method}`,
      status: 405
    });
  }
  
  next();
});

// 5) Axios-Instance mit Connection Pooling und Timeout
const apiClient = axios.create({
  // Connection Pooling aktivieren (verhindert zu viele TCP-Verbindungen)
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 100 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 100 }),
  // Timeout für Anfragen (45 Sekunden)
  timeout: 45000,
  // Base URL
  baseURL: 'https://openrouter.ai/api/v1'
});

// Dynamische Safety Settings basierend auf dem Modell
function getSafetySettings(modelName) {
  // Basis-Safety-Settings (für die meisten Modelle)
  const defaultSafetySettings = [
    {
      category: 'HARM_CATEGORY_HARASSMENT',
      threshold: 'OFF',
    },
    {
      category: 'HARM_CATEGORY_HATE_SPEECH',
      threshold: 'OFF',
    },
    {
      category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      threshold: 'OFF',
    },
    {
      category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
      threshold: 'OFF',
    },
    {
      category: 'HARM_CATEGORY_CIVIC_INTEGRITY',
      threshold: 'BLOCK_NONE',
    },
  ];

  // Mache eine Kopie, um die globalen Settings nicht zu ändern
  const safetySettings = JSON.parse(JSON.stringify(defaultSafetySettings));

  // Modelle, die nur BLOCK_NONE unterstützen (kein OFF)
  const modelBlockNoneList = [
    // Ältere Gemini-Modelle
    'gemini-1.5-pro-001', 'gemini-1.5-flash-001',
    'gemini-1.5-flash-8b-exp-0827', 'gemini-1.5-flash-8b-exp-0924',
    'gemini-pro', 'gemini-1.0-pro', 'gemini-1.0-pro-001',
    'gemma-3-27b-it'
    // Free-Version wurde entfernt, da wir nun OFF versuchen
  ];

  // Gemini 2.0 flash unterstützt "OFF" für alle Kategorien
  // Füge auch die Preview-Version hinzu, die definitiv OFF unterstützt
  const modelOffList = [
    'gemini-2.0-flash', 'gemini-2.0-flash-001',
    'gemini-2.0-flash-exp', 'gemini-2.0-flash-exp-image-generation',
    'gemini-2.5-pro-preview-03-25',
    'gemini-2.5-pro-exp-03-25:free'  // Füge die Free-Version auch für OFF-Versuch hinzu
  ];

  // Exakte Modellprüfung für unsere speziellen Modelle
  if (modelName === 'google/gemini-2.5-pro-preview-03-25') {
    // Für die Preview-Version können wir alles auf OFF setzen
    safetySettings.forEach(setting => {
      setting.threshold = 'OFF';
    });
    console.log('Gemini 2.5 Pro Preview erkannt: Verwende OFF für alle Safety-Einstellungen');
  } 
  else if (modelName === 'google/gemini-2.5-pro-exp-03-25:free') {
    // Für die Free-Version versuchen wir zuerst OFF
    safetySettings.forEach(setting => {
      setting.threshold = 'OFF';
    });
    console.log('Gemini 2.5 Pro Free erkannt: Verwende OFF für alle Safety-Einstellungen (experimentell)');
  }
  // Fallback auf Modell-Listen-Prüfung für andere Modelle
  else if (modelBlockNoneList.some(model => modelName.includes(model))) {
    // Ändere alle Thresholds auf BLOCK_NONE
    safetySettings.forEach(setting => {
      setting.threshold = 'BLOCK_NONE';
    });
  } 
  else if (modelOffList.some(model => modelName.includes(model))) {
    // Setze alles auf OFF (auch CIVIC_INTEGRITY)
    safetySettings.forEach(setting => {
      setting.threshold = 'OFF';
    });
  }

  return safetySettings;
}

// Hilfsfunktion für Retry-Logik
async function makeRequestWithRetry(url, data, headers, maxRetries = 2, isStream = false) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(`API-Anfrage an OpenRouter (Versuch ${attempt + 1}/${maxRetries + 1})`);
      
      // Stream-Modus oder regulärer Modus
      const response = isStream
        ? await apiClient.post(url, data, { 
            headers,
            responseType: 'stream'
          })
        : await apiClient.post(url, data, { headers });
      
      // Prüfen auf leere Antwort (typisch für Content-Filter)
      if (!isStream && 
          response.data?.choices?.[0]?.message?.content === "" && 
          response.data.usage?.completion_tokens === 0) {
        console.log("Gemini Content-Filter erkannt (leere Antwort)");
        return {
          status: 200,
          data: {
            content_filtered: true
          }
        };
      }
      
      return response; // Erfolg! Beende Schleife und gib Response zurück
      
    } catch (error) {
      lastError = error;
      
      // Prüfe, ob es ein Fehler ist, der ein Retry rechtfertigt
      const status = error.response?.status;
      
      // 429 (Rate Limit) oder 5xx (Server-Fehler) rechtfertigen Retry
      const shouldRetry = (status === 429 || (status >= 500 && status < 600));
      
      if (shouldRetry && attempt < maxRetries) {
        // Exponential Backoff: 1s, 2s, 4s, ...
        const delay = 1000 * Math.pow(2, attempt);
        console.log(`Wiederhole in ${delay}ms (Status ${status})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // Kein Retry möglich oder maximale Anzahl erreicht
      throw error;
    }
  }
  
  throw lastError; // Sollte nie erreicht werden, aber zur Sicherheit
}

// Stream-Handler-Funktion
async function handleStreamResponse(openRouterStream, res) {
  try {
    // SSE (Server-Sent Events) Header setzen
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // OpenRouter Stream an Client weiterleiten
    openRouterStream.on('data', (chunk) => {
      res.write(chunk);
    });

    openRouterStream.on('end', () => {
      res.end();
    });

    openRouterStream.on('error', (error) => {
      console.error('Stream Error:', error);
      // Versuche, einen Fehler im Stream-Format zu senden
      res.write(`data: {"error": {"message": "${error.message}"}}\n\n`);
      res.end();
    });
  } catch (error) {
    console.error('Stream Handling Error:', error);
    res.status(500).json({ error: 'Stream processing error' });
  }
}

// Erweiterte Proxy-Logik mit optionalem Model-Override und Streaming-Support
async function handleProxyRequestWithModel(req, res, forceModel = null) {
  try {
    // API-Key aus dem Header oder als Query-Parameter extrahieren
    let apiKey = null;
    
    // Option 1: Authorization Header - Bearer Format (Standard-Methode)
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      apiKey = req.headers.authorization.split(' ')[1].trim();
    } 
    // Option 2: Eigener x-api-key Header
    else if (req.headers['x-api-key']) {
      apiKey = req.headers['x-api-key'].trim();
    }
    // Option 3: API-Key im Request Body (falls Janitor das so implementiert)
    else if (req.body.api_key) {
      apiKey = req.body.api_key;
      // Key aus dem Body entfernen, damit er nicht an OpenRouter weitergeleitet wird
      delete req.body.api_key;
    }
    // Option 4: Als Query-Parameter
    else if (req.query.api_key) {
      apiKey = req.query.api_key;
    }

    // Kein API-Key gefunden
    if (!apiKey) {
      return res.status(401).json({
        error: 'Openrouter API-Key fehlt. Bitte gib deinen API-Key bei JanitorAI ein.'
      });
    }

    // Request-Größe protokollieren
    const bodySize = JSON.stringify(req.body).length;
    console.log(`Anfragegröße: ~${Math.round(bodySize / 1024)} KB`);

    // Body übernehmen, den Janitor schickt
    const clientBody = req.body;

    // Prüfe, ob Streaming angefordert wurde
    const isStreamingRequested = clientBody.stream === true;
    
    // Modell bestimmen (entweder erzwungen oder aus dem Request)
    const modelName = forceModel || clientBody.model;
    
    // Dynamische Safety Settings abhängig vom Modell
    const dynamicSafetySettings = getSafetySettings(modelName);

    // Safety settings hinzufügen und ggf. das vorgegebene Modell
    const newBody = {
      ...clientBody,
      safety_settings: dynamicSafetySettings,
    };

    // Wenn ein Modell erzwungen werden soll, überschreibe das vom Client gesendete
    if (forceModel) {
      console.log(`Überschreibe Modell mit: ${forceModel}`);
      newBody.model = forceModel;
    }

    // Leite es an Openrouter weiter (mit Retry-Logik)
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'User-Agent': 'JanitorAI-Proxy/1.0',
      'HTTP-Referer': 'https://janitorai.com',  // Hinzugefügt: Identifiziert die Quelle als Janitor.ai
      'X-Title': 'Janitor.ai'                   // Hinzugefügt: Weitere Identifikation für OpenRouter
    };
    
    // Füge Referrer auch im Body hinzu für vollständige Attribution
    if (!newBody.metadata) {
      newBody.metadata = {};
    }
    newBody.metadata.referer = 'https://janitor.ai/';
    
    // Mit Retry-Logik anfragen - immer an den korrekten OpenRouter-Endpunkt
    // Für Streaming einen anderen Endpunkt verwenden
    const endpoint = isStreamingRequested ? '/chat/completions' : '/chat/completions';
    
    const response = await makeRequestWithRetry(
      endpoint,                // OpenRouter-Endpunkt
      newBody,                 // Body
      headers,                 // Headers
      2,                       // Anzahl Retries
      isStreamingRequested     // Stream-Modus
    );

    console.log(`== Openrouter-Antwort erhalten (${new Date().toISOString()}) ==`);

    // Stream-Anfrage behandeln
    if (isStreamingRequested && response.data) {
      return handleStreamResponse(response.data, res);
    }

    // Normale Antwort verarbeiten
    // Prüfen auf Content-Filter (durch leere Antwort)
    if (response.data?.content_filtered) {
      console.log("Sende Gemini Content-Filter-Meldung");
      return res.status(200).json({
        choices: [{
          message: {
            content: "Unfortunately, Gemini is being difficult and finds your content too 'extreme'. The paid version 'Gemini 2.5 Pro Preview' works without problems for NSFW/Violence content."
          }
        }]
      });
    }
    
    // Prüfe, ob es eine Fehlerantwort von Openrouter ist
    if (response.data.error) {
      console.log("Fehler erkannt in Openrouter-Antwort");
      
      // Prüfe auf den Quota-Fehler in der Antwort
      if (response.data.error.code === 429 || 
          (response.data.error.metadata?.raw && 
           response.data.error.metadata.raw.includes("You exceeded your current quota"))) {
        
        // Gib eine formatierte Antwort zurück, die Janitor versteht
        return res.status(200).json({
          choices: [{
            message: {
              content: "Sorry my love, Gemini is unfortunately a bit stingy and you're either too fast, (Wait a few seconds, because the free version only allows a few requests per minute.) or you've used up your free messages for the day in the free version. In that case, you either need to switch to the paid version or wait until tomorrow. I'm sorry! Sending you a big hug! <3"
            }
          }]
        });
      }
      
      // Prüfe auf Content-Filter Fehler
      if (response.data.error.code === 403 || 
          response.data.error.message?.includes('PROHIBITED_CONTENT')) {
        
        return res.status(200).json({
          choices: [{
            message: {
              content: "Unfortunately, Gemini is being difficult and finds your content too 'extreme'. The paid version 'Gemini 2.5 Pro Preview' works without problems for NSFW/Violence content."
            }
          }]
        });
      }
      
      // Andere Fehler
      return res.status(200).json({
        choices: [{
          message: {
            content: `ERROR: ${response.data.error.message || "Unknown error from provider"}`
          }
        }]
      });
    }
    
    // Wenn keine Fehler, normale Antwort zurückgeben
    return res.json(response.data);

  } catch (error) {
    // Log Details des Fehlers (knapp)
    console.error("Error in Proxy:", error.message);
    if (error.response) {
      console.error("Status:", error.response.status);
    }
    
    // Extrahiere Fehlermeldung
    let errorMessage = "Unknown error";
    
    // Prüfe auf verschiedene Fehlertypen
    if (error.code === 'ECONNABORTED') {
      errorMessage = "Request timeout: The API took too long to respond";
    } else if (error.code === 'ECONNRESET') {
      errorMessage = "Connection reset: The connection was interrupted";
    } else if (error.message.includes('timeout')) {
      errorMessage = "Connection timeout: The API didn't respond in time";
    } else if (error.response?.status === 429) {
      // Rate Limit Fehler
      return res.status(200).json({
        choices: [
          {
            message: {
              content: "Sorry my love, Gemini is unfortunately a bit stingy and you're either too fast, (Wait a few seconds, because the free version only allows a few requests per minute.) or you've used up your free messages for the day in the free version. In that case, you either need to switch to the paid version or wait until tomorrow. I'm sorry! Sending you a big hug! <3"
            }
          }
        ]
      });
    } else if (error.response?.status === 403 || 
               error.message?.includes('PROHIBITED_CONTENT') ||
               error.message?.includes('pgshag2') || 
               error.message?.includes('No response from bot')) {
      // Content-Filter Fehler
      return res.status(200).json({
        choices: [
          {
            message: {
              content: "Unfortunately, Gemini is being difficult and finds your content too 'extreme'. The paid version 'Gemini 2.5 Pro Preview' works without problems for NSFW/Violence content."
            }
          }
        ]
      });
    } else if (error.response?.data?.error?.message) {
      errorMessage = error.response.data.error.message;
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    // Konsistentes Fehlerformat für Janitor
    return res.status(200).json({
      choices: [
        {
          message: {
            content: `ERROR: ${errorMessage}`
          }
        }
      ]
    });
  }
}

// Die gemeinsame Proxy-Logik als Funktion für beide bestehenden Routen
async function handleProxyRequest(req, res) {
  // Ruft die erweiterte Funktion ohne Model-Override auf
  return handleProxyRequestWithModel(req, res);
}

// Route "/free" - Erzwingt das kostenlose Gemini-Modell
app.post('/free', async (req, res) => {
  const requestTimestamp = new Date().toISOString();
  console.log(`== Neue Anfrage über /free (${requestTimestamp}) ==`);
  await handleProxyRequestWithModel(req, res, "google/gemini-2.5-pro-exp-03-25:free");
});

// Route "/cash" - Erzwingt das kostenpflichtige Gemini-Modell
app.post('/cash', async (req, res) => {
  const requestTimestamp = new Date().toISOString();
  console.log(`== Neue Anfrage über /cash (${requestTimestamp}) ==`);
  await handleProxyRequestWithModel(req, res, "google/gemini-2.5-pro-preview-03-25");
});

// Bestehende Proxy-Route "/nofilter" - Modell frei wählbar
app.post('/nofilter', async (req, res) => {
  const requestTimestamp = new Date().toISOString();
  console.log(`== Neue Anfrage über /nofilter (${requestTimestamp}) ==`);
  await handleProxyRequest(req, res);
});

// Für Abwärtskompatibilität alte Route beibehalten - Modell frei wählbar
app.post('/v1/chat/completions', async (req, res) => {
  const requestTimestamp = new Date().toISOString();
  console.log(`== Neue Anfrage über alte Route /v1/chat/completions (${requestTimestamp}) ==`);
  await handleProxyRequest(req, res);
});

// Explizit alle Methoden für die API-Endpunkte erlauben und korrekte Fehler zurückgeben
// Dies ist wichtig für CORS-Preflight und methodenübergreifende Anfragen
const apiEndpoints = ['/free', '/cash', '/nofilter', '/v1/chat/completions'];

apiEndpoints.forEach(endpoint => {
  // OPTIONS für CORS pre-flight
  app.options(endpoint, (req, res) => {
    res.status(204).end();
  });
  
  // Alle anderen Methoden außer POST mit 405 Method Not Allowed beantworten
  ['get', 'put', 'delete', 'patch', 'head'].forEach(method => {
    app[method](endpoint, (req, res) => {
      res.status(405).json({
        error: 'Method Not Allowed',
        message: `${endpoint} erfordert die POST-Methode, erhielt aber ${method.toUpperCase()}`,
        status: 405
      });
    });
  });
});

// Einfache Statusroute aktualisieren mit neuen Endpunkten
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    version: '1.4.1',
    info: 'JanitorAI ↔️ OpenRouter Proxy mit dynamischen Safety-Settings, Streaming-Support und verbessertem CORS/Error-Handling',
    usage: 'Diesen Proxy mit JanitorAI verwenden - API-Key bei JanitorAI eingeben',
    endpoints: {
      standard: '/nofilter',          // Standard-Route ohne Modellzwang
      legacy: '/v1/chat/completions', // Legacy-Route ohne Modellzwang
      free: '/free',                  // Route mit kostenlosem Gemini-Modell
      paid: '/cash'                   // Route mit kostenpflichtigem Gemini-Modell
    },
    features: {
      streaming: 'Aktiviert',
      dynamicSafety: 'Optimiert für google/gemini-2.5-pro-preview-03-25 und google/gemini-2.5-pro-exp-03-25:free (beide mit OFF-Setting)',
      cors: 'Vollständig unterstützt mit OPTIONS-Preflight',
      errorHandling: 'Verbessert mit 405-Erkennung'
    }
  });
});

// Health-Check Endpoint für Monitoring
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// Globaler Error-Handler für unbehandelte Fehler
app.use((err, req, res, next) => {
  console.error('Unbehandelter Fehler:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 
      'Ein interner Serverfehler ist aufgetreten' : err.message
  });
});

// Catch-All Route für Anfragen an nicht existierende Pfade
app.use((req, res) => {
  console.log(`404 Nicht gefunden: ${req.method} ${req.url}`);
  res.status(404).json({
    error: 'Not Found',
    message: `Der Endpunkt ${req.url} existiert nicht auf diesem Server`,
    availableEndpoints: ['/free', '/cash', '/nofilter', '/v1/chat/completions', '/', '/health']
  });
});

// Starte den Express-Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy läuft auf Port ${PORT}`);
  console.log(`${new Date().toISOString()} - Server gestartet`);
});
