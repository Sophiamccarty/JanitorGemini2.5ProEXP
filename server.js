const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;

// Increase payload size limits - setting to 50MB which should be more than enough
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.text({ limit: '50mb' }));

// Enable CORS with more permissive settings
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
}));

// The message in English with formatted links and code blocks
const message = `**ATTENTION!**
We have moved. To offer more features, including lorebooks with permanent servers, we have shut down the old separate servers for OpenRouter & AiStudio and now only the new one is running!
**Want to learn more?**
Visit my Lore-Bary (website) for more info and to use lorebooks: <a href="https://sophiasunblocker.onrender.com/lorebook">https://sophiasunblocker.onrender.com/lorebook</a>
**Are you using Google AiStudio?**
Then you can continue directly with this URL:
\`\`\`
https://sophiasunblocker.onrender.com/aistudio
\`\`\`
**Are you using OpenRouter?**
Then you can continue directly here:
\`\`\`
https://sophiasunblocker.onrender.com/openrouter
\`\`\`
**Important for OpenRouter:**
Your model is now selected directly in the Janitor field or via OpenRouter itself.`;

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

// Raw body handling for streams and large payloads
app.use((req, res, next) => {
  if (req.headers['content-type'] === 'application/json') {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        if (data) {
          req.rawBody = data;
          req.body = JSON.parse(data);
        }
        next();
      } catch (e) {
        console.error('Error parsing JSON body:', e);
        next();
      }
    });
  } else {
    next();
  }
});

// Enhanced logging middleware with headers
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  console.log('Headers:', JSON.stringify(req.headers));
  if (req.body && Object.keys(req.body).length > 0) {
    console.log('Body size:', req.rawBody ? req.rawBody.length : JSON.stringify(req.body).length);
  }
  next();
});

// Set up each route
routes.forEach(route => {
  app.post(route, (req, res) => {
    console.log(`Received request to ${route}`);
    
    // Pass through any authorization headers that might be present
    if (req.headers.authorization) {
      res.setHeader('Authorization', req.headers.authorization);
    }
    
    // Add standard OpenAI API response fields that Janitor might expect
    const responseObj = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "message-relay",
    };
    
    // Handle stream parameter, defaulting to false if not present
    const isStreamingRequest = req.body && req.body.stream === true;
    
    // Handle non-streaming requests
    if (!isStreamingRequest) {
      console.log('Sending non-streaming response');
      return res.json({
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
    } 
    // Handle streaming requests
    else {
      console.log('Sending streaming response');
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      
      const data = {
        ...responseObj,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            content: message
          },
          finish_reason: null
        }]
      };
      
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      
      // Send a completion event
      const completionData = {
        ...responseObj,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: "stop"
        }]
      };
      
      res.write(`data: ${JSON.stringify(completionData)}\n\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
    }
  });
});

// Add root route for Janitor health check
app.get('/', (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Keep the original health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('Server is running');
});

// Special route for handling OPTIONS requests (preflight)
app.options('*', cors());

// Add a catch-all route for debugging
app.use('*', (req, res) => {
  console.log(`Received request to unknown route: ${req.originalUrl}`);
  res.status(404).send('Not found');
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: {
      message: 'An internal server error occurred',
      status: 500
    }
  });
});

// Start the server
app.listen(port, () => {
  console.log(`Goodbye Server running on port ${port}`);
});
