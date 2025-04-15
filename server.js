/*************************************************
 * server.js - Node/Express + Axios + CORS Proxy für JanitorAI
 *************************************************/
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const http = require('http');
const https = require('https');

// Erzeuge eine Express-App
const app = express();

// 1) CORS erlauben (wichtig für Browser-Anfragen)
app.use(cors());

// 2) JSON mit erhöhtem Limit parsen, z. B. 100MB
app.use(express.json({ limit: '100mb' }));

// 3) Server-Timeout konfigurieren
app.use((req, res, next) => {
  // 2 Minuten Timeout für Server-Antworten
  res.setTimeout(120000);
  next();
});

// 4) Axios-Instance mit Connection Pooling und Timeout
const apiClient = axios.create({
  // Connection Pooling aktivieren (verhindert zu viele TCP-Verbindungen)
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 100 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 100 }),
  // Timeout für Anfragen (45 Sekunden)
  timeout: 45000,
  // Base URL
  baseURL: 'https://openrouter.ai/api/v1'
});

// Hilfsfunktion für Retry-Logik
async function makeRequestWithRetry(url, data, headers, maxRetries = 2) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(`API-Anfrage an OpenRouter (Versuch ${attempt + 1}/${maxRetries + 1})`);
      
      const response = await apiClient.post(url, data, { headers });
      
      // Prüfen auf leere Antwort (typisch für Content-Filter)
      if (response.data?.choices?.[0]?.message?.content === "" && 
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

// Erweiterte Proxy-Logik mit optionalem Model-Override
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

    // Safety settings hinzufügen und ggf. das vorgegebene Modell
    const newBody = {
      ...clientBody,
      safety_settings: [
        {
          category: 'HARM_CATEGORY_HARASSMENT',
          threshold: 'BLOCK_NONE',
        },
        {
          category: 'HARM_CATEGORY_HATE_SPEECH',
          threshold: 'BLOCK_NONE',
        },
        {
          category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
          threshold: 'BLOCK_NONE',
        },
        {
          category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
          threshold: 'BLOCK_NONE',
        },
      ],
    };

    // Wenn ein Modell erzwungen werden soll, überschreibe das vom Client gesendete
    if (forceModel) {
      console.log(`Überschreibe Modell mit: ${forceModel}`);
      newBody.model = forceModel;
    }

    // Leite es an Openrouter weiter (mit Retry-Logik):
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'User-Agent': 'JanitorAI-Proxy/1.0',
      'HTTP-Referer': 'https://janitorai.com',  // Hinzugefügt: Identifiziert die Quelle als Janitor.ai
      'X-Title': 'Janitor.ai'                 // Hinzugefügt: Weitere Identifikation für OpenRouter
    };
    
    // Füge Referrer auch im Body hinzu für vollständige Attribution
    if (!newBody.metadata) {
      newBody.metadata = {};
    }
    newBody.metadata.referer = 'https://janitor.ai/';
    
    // Mit Retry-Logik anfragen - immer an den korrekten OpenRouter-Endpunkt
    const response = await makeRequestWithRetry(
      '/chat/completions',  // Wichtig: Der richtige OpenRouter-Endpunkt
      newBody,              // Body
      headers               // Headers
    );

    // Antwort von Openrouter an den Client zurückgeben
    console.log(`== Openrouter-Antwort erhalten (${new Date().toISOString()}) ==`);

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

// Einfache Statusroute aktualisieren mit neuen Endpunkten
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    version: '1.3.1',
    info: 'JanitorAI ↔️ OpenRouter Proxy mit verbesserten Verbindungseinstellungen',
    usage: 'Diesen Proxy mit JanitorAI verwenden - API-Key bei JanitorAI eingeben',
    endpoints: {
      standard: '/nofilter',          // Standard-Route ohne Modellzwang
      legacy: '/v1/chat/completions', // Legacy-Route ohne Modellzwang
      free: '/free',                  // Route mit kostenlosem Gemini-Modell
      paid: '/cash'                   // Route mit kostenpflichtigem Gemini-Modell
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

// Starte den Express-Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy läuft auf Port ${PORT}`);
  console.log(`${new Date().toISOString()} - Server gestartet`);
});
