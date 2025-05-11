const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;

// Increase payload size limits
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Enable CORS with very permissive settings
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
  allowedHeaders: '*',
  exposedHeaders: ['Content-Type', 'Authorization']
}));

// The message in English with formatted links and code blocks
const message = `**ATTENTION!**
We have moved. To offer more features, including lorebooks with permanent servers, we have shut down the old separate servers for OpenRouter & AiStudio and now only the new one is running!

**Want to learn more?**
Visit my Lore-Bary (website) for more info and to use lorebooks or commands: 
\`\`\`
🔅 *https://sophiasunblocker.onrender.com/lorebook* 🔅
\`\`\`
----------------------------------------------
**Are you using Google AiStudio?**
Then you can continue directly with this Proxy-URL:
\`\`\`
➡️ *https://sophiasunblocker.onrender.com/aistudio*
\`\`\`

**Are you using OpenRouter?**
Then you can continue directly with this Proxy-URL:
\`\`\`
➡️ *https://sophiasunblocker.onrender.com/openrouter*
\`\`\`

**Important for OpenRouter:**
Your model is now selected directly in the Janitor model-field or via OpenRouter itself.
Quick Models: *google/gemini-2.5-pro-preview* or *google/gemini-2.5-pro-exp-03-25*

PS: DONT WORRY! YOUR COMMANDS & SETTINGS STAYS THE SAME.

XoXo Sophia 😘`;

// List of routes to handle
const routes = [
  '/jbfree',
  '/free',
  '/jbcash',
  '/cash',
  '/jbnofilter',
  '/nofilter',
  '/flash25',
  '/jailbreak',
  '/nonjailbreak'
];

// Enhanced logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  console.log('Headers:', JSON.stringify(req.headers));
  next();
});

// CRITICAL: Add an OpenAI-compatible route that Janitor might be using
app.post('/v1/chat/completions', (req, res) => {
  console.log('Received request to OpenAI-compatible endpoint');
  handleChatRequest(req, res);
});

// Add a common handler function for all routes
function handleChatRequest(req, res) {
  // Pass through authorization headers
  if (req.headers.authorization) {
    res.setHeader('Authorization', req.headers.authorization);
  }
  
  // Standard OpenAI response format
  const responseObj = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "message-relay",
  };
  
  // Handle stream parameter
  const isStreamingRequest = req.body && req.body.stream === true;
  
  if (!isStreamingRequest) {
    // Non-streaming response
    console.log('Sending non-streaming response');
    return res.status(200).json({
      ...responseObj,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: message
        },
        finish_reason: "stop"
      }]
    });
  } else {
    // Streaming response
    console.log('Sending streaming response');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    
    // Send the role first
    res.write(`data: ${JSON.stringify({
      ...responseObj,
      choices: [{
        index: 0,
        delta: {
          role: "assistant"
        }
      }]
    })}\n\n`);
    
    // Send the content
    res.write(`data: ${JSON.stringify({
      ...responseObj,
      choices: [{
        index: 0,
        delta: {
          content: message
        }
      }]
    })}\n\n`);
    
    // Send completion
    res.write(`data: ${JSON.stringify({
      ...responseObj,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: "stop"
      }]
    })}\n\n`);
    
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

// Set up each custom route to use the common handler
routes.forEach(route => {
  app.post(route, (req, res) => {
    console.log(`Received request to ${route}`);
    handleChatRequest(req, res);
  });
});

// Root route for health checks
app.get('/', (req, res) => {
  // Return a standard OpenAI-like response for the health check
  res.status(200).json({ 
    status: "ok",
    message: "API is running and ready to accept requests"
  });
});

// Special route for CORS preflight requests
app.options('*', cors());

// Catch all route
app.use('*', (req, res) => {
  console.log(`Request to unknown route: ${req.originalUrl} (Method: ${req.method})`);
  // For POST requests to unknown routes, try to handle them as chat completions
  if (req.method === 'POST') {
    handleChatRequest(req, res);
  } else {
    res.status(404).json({ 
      error: { 
        message: "Not found",
        status: 404
      }
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: {
      message: 'Internal server error',
      status: 500
    }
  });
});

// Start the server
app.listen(port, () => {
  console.log(`Goodbye Server running on port ${port}`);
});
