/*************************************************
 * server.js - Beispiel mit Node/Express + Axios + CORS
 *************************************************/
const express = require('express');
const axios = require('axios');
const cors = require('cors');

// Erzeuge eine Express-App
const app = express();

// 1) CORS erlauben (wichtig für Browser-Anfragen)
app.use(cors());

// 2) JSON mit erhöhtem Limit parsen, z. B. 100MB
//    So verhinderst du den 413 "Payload Too Large" Fehler.
app.use(express.json({ limit: '100mb' }));

// Deine Proxy-Route. Hier simulieren wir z. B. OpenAI-Style /v1/chat/completions
app.post('/v1/chat/completions', async (req, res) => {
  try {
    // Log: sieh nach, was vom Client (z. B. Janitor) geschickt wird
    console.log("== Neue Anfrage von Janitor? ==");
    console.log("Request Body:", JSON.stringify(req.body));

    // API-Key aus dem Header oder als Query-Parameter extrahieren
    // Wir prüfen zuerst den Authorization-Header
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

    // Body übernehmen, den Janitor schickt
    const clientBody = req.body;

    // Du fügst hier die safety_settings hinzu
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

    // Leite es an Openrouter weiter:
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions', // Ziel
      newBody,                                        // Body
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`, // Benutze den vom Client übermittelten API-Key
        },
      }
    );

    // Antwort von Openrouter an den Client zurückgeben
    console.log("== Openrouter-Antwort ==", response.data);
    
    // Prüfe, ob es eine Fehlerantwort von Openrouter ist
    if (response.data.error) {
      console.log("Fehler erkannt in Openrouter-Antwort");
      
      // Prüfe auf den Quota-Fehler in der Antwort
      if (response.data.error.code === 429 || 
          (response.data.error.metadata?.raw && 
           response.data.error.metadata.raw.includes("You exceeded your current quota"))) {
        
        // Gib eine formatierte Antwort zurück, die Janitor versteht
        return res.status(429).json({
          choices: [{
            message: {
              content: "ERROR: You exceeded your current quota. Please migrate to Gemini 2.5 Pro Preview for higher quota limits."
            }
          }]
        });
      }
      
      // Andere Fehler
      return res.status(response.data.error.code || 500).json({
        choices: [{
          message: {
            content: `ERROR: ${response.data.error.message || "Unknown error from provider"}`
          }
        }]
      });
    }
    
    // Wenn keine Fehler, normale Antwort zurückgeben
    return res.json(response.data);

  }   catch (error) {
    // Log Details des Fehlers
    console.error("Error in Proxy:", error.response?.data || error.message);
    
    // Versuche, einen für Janitor verständlichen Fehler zu erstellen
    // JanitorAI erwartet ein Antwortformat wie bei erfolgreicher Anfrage
    // mit choices[0].message.content für die Anzeige des Inhalts
    
    // Prüfe auf Quota-Fehler 429
    if (error.response?.status === 429 || 
        error.response?.data?.error?.code === 429 ||
        (error.response?.data?.error?.metadata?.raw && 
         error.response?.data?.error?.metadata?.raw.includes("You exceeded your current quota"))) {
        
      console.log("Quota-Fehler erkannt!");
      
      // Sende Fehler im Format, das Janitor anzeigen kann
      return res.status(200).json({
        choices: [{
          message: {
            role: "assistant",
            content: "ERROR: You exceeded your current quota. Please migrate to Gemini 2.5 Pro Preview for higher quota limits."
          }
        }]
      });
    }
    
    // Für andere Fehler
    let errorMessage = "Unknown error";
    
    // Versuche, die Fehlermeldung aus verschiedenen möglichen Stellen zu extrahieren
    if (error.response?.data?.error?.message) {
      errorMessage = error.response.data.error.message;
    } else if (error.response?.data?.error?.metadata?.raw) {
      try {
        const rawData = JSON.parse(error.response.data.error.metadata.raw);
        if (rawData.error?.message) {
          errorMessage = rawData.error.message;
        }
      } catch (e) {
        // Wenn Parsen fehlschlägt, nutze den raw-String direkt
        errorMessage = error.response.data.error.metadata.raw.substring(0, 500);
      }
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    // Sende Fehler im Format, das Janitor anzeigen kann
    return res.status(200).json({
      choices: [{
        message: {
          role: "assistant",
          content: `ERROR: ${errorMessage}`
        }
      }]
    });
  }
});

// Einfache Statusroute hinzufügen
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    usage: 'Diesen Proxy mit JanitorAI verwenden - API-Key bei JanitorAI eingeben'
  });
});

// Starte den Express-Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy läuft auf Port ${PORT}`);
});
