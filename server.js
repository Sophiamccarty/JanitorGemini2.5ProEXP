const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;

// Enable CORS for all requests
app.use(cors({
  origin: '*',
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
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

app.use(express.json());

// Add logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Set up each route
routes.forEach(route => {
  app.post(route, (req, res) => {
    console.log(`Received request to ${route}`, { body: req.body });
    
    // Handle non-streaming requests
    if (req.body.stream === false || !req.body.stream) {
      console.log('Sending non-streaming response');
      return res.json({
        choices: [{
          message: {
            content: message
          }
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
        choices: [{
          delta: {
            content: message
          }
        }]
      };
      
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
    }
  });
});

// Add a simple health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('Server is running');
});

// Add a catch-all route for debugging
app.use('*', (req, res) => {
  console.log(`Received request to unknown route: ${req.originalUrl}`);
  res.status(404).send('Not found');
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).send('Server error');
});

// Start the server
app.listen(port, () => {
  console.log(`Goodbye Server running on port ${port}`);
});
